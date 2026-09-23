/* TokenBook service worker — offline app shell 

   Static site, no build step.

   Invalidation model: AGENTS.md is the deploy sentinel and must be touched
   on every commit that changes a cached asset (see AGENTS.md). On each page
   reload we HEAD ./AGENTS.md; if its validator (ETag/Last-Modified) differs
   from the stored one, each shell asset is HEAD-checked and only the changed
   ones are re-fetched. If the sentinel is unchanged, everything is served
   from cache. AGENTS.md is trusted fully — a missed touch means a stale file
   until the next AGENTS.md change. */

const SHELL_CACHE = 'tokenbook-shell';
const RUNTIME_CACHE = 'tokenbook-runtime';
const META_CACHE = 'tokenbook-meta';

const SENTINEL_URL = './AGENTS.md';
const SENTINEL_KEY = 'https://tokenbook.local/__sentinel__';
const ASSET_VAL_PREFIX = 'https://tokenbook.local/__val__/';
const LAST_CHECK_KEY = 'https://tokenbook.local/__lastcheck__';
const CHECK_GUARD_MS = 30000;

/* Local app-shell assets (relative to the SW scope, which is the repo root). */
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './favicon.svg',
  './manifest.webmanifest',
  './src/ui/app.js',
  './src/ui/router.js',
  './src/ui/dom.js',
  './src/ui/toast.js',
  './src/ui/history.js',
  './src/ui/refund.js',
  './src/ui/pages/index.js',
  './src/ui/pages/register.js',
  './src/ui/pages/tokens.js',
  './src/ui/pages/patients.js',
  './src/ui/pages/printLayout.js',
  './src/core/db.js',
  './src/core/day.js',
  './src/print/ps.js',
  './src/print/defaultLayout.js',
  './src/backup/backup.js',
  './src/backup/csv.js',
  './src/backup/meta.js',
];

/* Cross-origin assets cached best-effort. ONLY hosts without their own
   service worker belong here — Dexie (unpkg) and Google Fonts. paperstamp
   (downloaddoctor.github.io) is deliberately excluded: it ships its own SW.
   Cache-first so the app still boots offline. */
const RUNTIME_HOSTS = new Set([
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

/* ---------- Validator helpers ---------- */

function validatorOf(res) {
  if (!res || !res.ok) return null;
  return res.headers.get('ETag') || res.headers.get('Last-Modified') || null;
}

/* HEAD a URL and return its validator string (no body downloaded). */
async function headValidator(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return validatorOf(res);
  } catch (err) {
    return null;
  }
}

function fetchSentinelValidator() {
  return headValidator(SENTINEL_URL);
}

async function readStored(key) {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(key);
    return res ? await res.text() : null;
  } catch (err) {
    return null;
  }
}

async function writeStored(key, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    key,
    new Response(value || '', { headers: { 'Content-Type': 'text/plain' } })
  );
}

function readStoredValidator() {
  return readStored(SENTINEL_KEY);
}

function writeStoredValidator(value) {
  return writeStored(SENTINEL_KEY, value);
}

function readLastCheck() {
  return readStored(LAST_CHECK_KEY);
}

function writeLastCheck(value) {
  return writeStored(LAST_CHECK_KEY, value);
}

function assetValKey(url) {
  return ASSET_VAL_PREFIX + url;
}

/* HEAD every shell asset and fetch only the ones whose validator changed.
   Runs once per deploy (i.e. when the sentinel changed), never on plain
   reloads. When a validator is unavailable it falls back to fetching. */
/* Run `fn` over `items` with at most `limit` in flight at once. */
async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function refreshChangedAssets() {
  const cache = await caches.open(SHELL_CACHE);
  // Cap parallel HEAD/fetch at 6 (browser per-host limit) so the deploy
  // refresh doesn't queue dozens of requests at once.
  await mapLimit(SHELL_ASSETS, 6, async (url) => {
    const remote = await headValidator(url);
    const key = assetValKey(url);
    const stored = await readStored(key);
    /* No stored value (fresh) or a different value => refetch. */
    if (remote && stored && remote === stored) return;
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res && res.ok) {
        await cache.put(url, res.clone());
        await writeStored(key, remote || validatorOf(res) || '');
      }
    } catch (err) {
      /* Keep the cached copy on failure. */
    }
  });
}

/* Record per-asset validators after a bulk precache (install time). */
async function recordAssetValidators() {
  await Promise.all(
    SHELL_ASSETS.map(async (url) => {
      const v = await headValidator(url);
      if (v) await writeStored(assetValKey(url), v);
    })
  );
}

/* ---------- Lifecycle ---------- */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(async () => {
        const v = await fetchSentinelValidator();
        if (v) await writeStoredValidator(v);
        await recordAssetValidators();
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE, META_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('tokenbook-') && !keep.includes(k))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ---------- Fetch handlers ---------- */

/* On navigation: serve the cached document immediately (non-blocking first
   paint), refreshing that cache entry from the network in the background.
   Update detection is separate — see checkForUpdates(). */
async function handleNavigation(request) {
  // Navigations are cached under a query- and hash-stripped key so ?dev=1
  // and plain loads share one shell entry.
  const url = new URL(request.url);
  const key = url.origin + url.pathname;
  const cached = await caches.match(key);
  if (cached) {
    fetch(request)
      .then((fresh) => {
        if (fresh && fresh.ok) {
          caches.open(SHELL_CACHE).then((cache) => cache.put(key, fresh));
        }
      })
      .catch(() => {});
    return cached;
  }

  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL_CACHE);
    cache.put(key, fresh.clone());
    return fresh;
  } catch (err) {
    const fallback =
      (await caches.match('./index.html')) || (await caches.match('./'));
    if (fallback) return fallback;
    throw err;
  }
}

/* Background update check, run via event.waitUntil so it never delays the
   navigation response. Skips entirely if the last check was under
   CHECK_GUARD_MS ago (no AGENTS.md fetch on rapid repeat opens). Otherwise
   HEADs the AGENTS.md sentinel; if changed, HEAD-diffs shell assets,
   refetches the changed ones, then tells the requesting client to reload
   so it picks up the fresh version. */
async function checkForUpdates(clientId) {
  const lastCheck = Number(await readLastCheck()) || 0;
  if (Date.now() - lastCheck < CHECK_GUARD_MS) return;
  await writeLastCheck(String(Date.now()));

  let remote;
  try {
    remote = await fetchSentinelValidator();
  } catch (err) {
    return;
  }
  if (!remote) return;

  const stored = await readStoredValidator();
  if (stored === remote) return;

  await refreshChangedAssets();
  await writeStoredValidator(remote);

  if (!clientId) return;
  const client = await self.clients.get(clientId);
  if (client) client.postMessage({ type: 'tokenbook-update-ready' });
}

/* Static local assets: cache-first. */
function isRuntimeRequest(url) {
  return RUNTIME_HOSTS.has(url.hostname);
}

/* Cross-origin runtime assets (Dexie): cache-first, best-effort. Opaque or
   CORS responses are both cached so the module is available offline. */
async function handleRuntime(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached2 = await caches.match(request);
    if (cached2) return cached2;
    throw err;
  }
}

async function handleLocal(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, fresh.clone());
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    event.waitUntil(checkForUpdates(event.clientId));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(handleLocal(request));
  }
});
