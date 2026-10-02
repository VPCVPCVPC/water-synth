// serve.mjs — tiny static server for the prototype.
//   node serve.mjs            → http://localhost:8123 (this computer only)
//   node serve.mjs --https    → https://<this computer's address>:8443, for an
//                               iPad or iPhone on the same network
//
// Sends the cross-origin isolation headers that SharedArrayBuffer needs (the
// page ↔ audio-thread queues). Browsers only allow that on a secure page:
// localhost counts, a LAN address only over HTTPS — hence --https. It uses a
// certificate you make once with mkcert (see README: "Playing on iPad or
// iPhone"), kept outside the project in ~/.water-synth/certs (or the folder
// in WATER_SYNTH_CERTS), so nothing secret is ever inside the served folder.
// Serves only page files (known types) inside prototype/, never hidden files.

import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const HTTPS = process.argv.includes('--https');
const PORT = Number(process.env.PORT) || (HTTPS ? 8443 : 8123);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function handle(req, res) {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
  // Allowlist: inside prototype/, a known page-file type, no hidden or
  // dependency/certificate folders (compared ignoring case — macOS paths are
  // case-insensitive).
  const segments = file.slice(ROOT.length).toLowerCase().split(sep);
  if (!file.startsWith(ROOT) || !TYPES[extname(file).toLowerCase()] ||
      segments.some((s) => s.startsWith('.') || s === 'node_modules' || s === 'certs')) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()],
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

if (HTTPS) {
  const dir = process.env.WATER_SYNTH_CERTS || join(homedir(), '.water-synth', 'certs');
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  if (!existsSync(cert) || !existsSync(key)) {
    console.error(`No certificate found. Make one first (see README, "Playing on iPad or iPhone"):
  ${cert}
  ${key}`);
    process.exit(1);
  }
  // Reachable from the local network, so a phone or tablet can connect.
  createHttps({ cert: readFileSync(cert), key: readFileSync(key) }, handle).listen(PORT, '0.0.0.0', () => {
    const addresses = Object.values(networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    console.log('water-synth prototype over HTTPS — reachable by anyone on this network; stop it (Ctrl-C) when done.');
    console.log('On the iPad/iPhone (same Wi-Fi), open one of these — the .local name or your Wi-Fi address:');
    // The same .local name the README puts in the certificate.
    let local = '';
    try { local = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim(); } catch { /* not macOS */ }
    if (local) console.log(`  https://${local}.local:${PORT}`);
    for (const a of addresses) console.log(`  https://${a}:${PORT}`);
  });
} else {
  createHttp(handle).listen(PORT, '127.0.0.1', () => {
    console.log(`water-synth prototype: http://localhost:${PORT}`);
  });
}
