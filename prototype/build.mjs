// build.mjs — the page, ready to host (Netlify or Cloudflare Pages).
//   node prototype/build.mjs        → prototype/dist/
//
// Copies only what the page loads — index.html, the runtime modules (*.js;
// the checks are *.mjs and stay behind) and the bundled fonts — and writes a
// `_headers` file. Both hosts read it. The two cross-origin isolation headers
// are not optional: the page and its audio thread share memory
// (SharedArrayBuffer), which browsers only allow on an isolated page.

import { readdirSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(SRC, 'dist');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'fonts'), { recursive: true });

const pages = ['index.html', ...readdirSync(SRC).filter((f) => f.endsWith('.js'))];
for (const f of pages) copyFileSync(join(SRC, f), join(OUT, f));
const fonts = readdirSync(join(SRC, 'fonts')).filter((f) => f.endsWith('.woff2') || f === 'LICENSE.txt');
for (const f of fonts) copyFileSync(join(SRC, 'fonts', f), join(OUT, 'fonts', f));

writeFileSync(join(OUT, '_headers'), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`);

// Every module the page imports must have made it (a missing one is a blank page).
const missing = [];
for (const f of pages.filter((p) => p.endsWith('.js'))) {
  const src = readFileSync(join(SRC, f), 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|addModule\(\s*)['"](?:\.\/)?([^'"/][^'"]*\.js)['"]/g)) {
    if (!pages.includes(m[1])) missing.push(`${f} → ${m[1]}`);
  }
}
if (missing.length) { console.error(`missing from the build:\n  ${missing.join('\n  ')}`); process.exit(1); }
console.log(`built prototype/dist: ${pages.length} page files, ${fonts.length} font files, _headers`);
