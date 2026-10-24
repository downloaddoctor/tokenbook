import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* GitHub Pages bundle only. Local dev serves the repo root as-is (no build).
   dist/ = index.html + app.js (every local module in one file) + styles.css
   + pw.js + sw.js + manifest + favicon + version.txt.
   CDN files (Dexie on unpkg, fonts, paperstamp sdk) stay on the CDN: https imports are left external. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

function swap(text, from, to) {
  if (!text.includes(from)) throw new Error('build: pattern not found: ' + from);
  return text.replaceAll(from, to);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

/* One bundle: static + dynamic local imports (seed, selftest, history) are inlined; https imports stay as-is. */
const out = await build({
  entryPoints: [path.join(root, 'src', 'ui', 'app.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  write: false,
  plugins: [
    {
      name: 'cdn-external',
      setup(b) {
        b.onResolve({ filter: /^https:/ }, (a) => ({ path: a.path, external: true }));
      }
    }
  ]
});
await writeFile(path.join(dist, 'app.js'), out.outputFiles[0].text);

const css = await readFile(path.join(root, 'styles.css'), 'utf8');
await writeFile(path.join(dist, 'styles.css'), (await transform(css, { loader: 'css', minify: true })).code);

/* index.html: only the module entry changes; CSP is untouched (CDN hosts still needed). */
let page = await readFile(path.join(root, 'index.html'), 'utf8');
page = swap(page, '<script type="module" src="src/ui/app.js"></script>', '<script type="module" src="app.js"></script>');
await writeFile(path.join(dist, 'index.html'), page);

/* sw.js: copied as-is with a build stamp on line 1. */
let sw = await readFile(path.join(root, 'sw.js'), 'utf8');
/* Stamp = content hash of every cached file + the worker itself: it changes only when a deploy really changes something. */
const hasher = createHash('sha256').update(sw);
for (const p of [path.join(dist, 'index.html'), path.join(dist, 'app.js'), path.join(dist, 'styles.css'), path.join(root, 'pw.js'), path.join(root, 'manifest.webmanifest'), path.join(root, 'favicon.svg')]) {
  hasher.update(await readFile(p));
}
const hash = hasher.digest('hex').slice(0, 16);
/* No version.txt in dist: the built sw.js is the sentinel. Its build stamp is a content hash (git untouched), so its validator changes only when a deploy changes a cached file. */
sw = '/* build ' + hash + ' */\n' + sw;
await writeFile(path.join(dist, 'sw.js'), sw);

for (const f of ['pw.js', 'manifest.webmanifest', 'favicon.svg']) {
  await cp(path.join(root, f), path.join(dist, f));
}

console.log('built dist/ (index.html, app.js, styles.css, pw.js, sw.js)');
