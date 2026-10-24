import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

/* sw.js: same worker, only the SHELL_ASSETS list is rewritten for the bundle. */
let sw = await readFile(path.join(root, 'sw.js'), 'utf8');
const BEGIN = '/* SHELL_ASSETS:BEGIN */';
const END = '/* SHELL_ASSETS:END */';
const a = sw.indexOf(BEGIN);
const b = sw.indexOf(END);
if (a < 0 || b < a) throw new Error('build: SHELL_ASSETS markers not found in sw.js');
const shell = ['./', './index.html', './app.js', './styles.css', './pw.js', './favicon.svg', './manifest.webmanifest'];
const list = 'const SHELL_ASSETS = [\n' + shell.map((f) => "  '" + f + "',").join('\n') + '\n];\n';
sw = sw.slice(0, a + BEGIN.length) + '\n' + list + sw.slice(b);
/* No version.txt in dist: the built sw.js is the sentinel. Its build stamp changes every build (git untouched), so its validator changes on each deploy. */
sw = swap(sw, "const SENTINEL_URL = './version.txt';", "const SENTINEL_URL = './sw.js';");
sw = '/* build ' + new Date().toISOString() + ' */\n' + sw;
await writeFile(path.join(dist, 'sw.js'), sw);

for (const f of ['pw.js', 'manifest.webmanifest', 'favicon.svg']) {
  await cp(path.join(root, f), path.join(dist, f));
}

console.log('built dist/ (index.html, app.js, styles.css, pw.js, sw.js)');
