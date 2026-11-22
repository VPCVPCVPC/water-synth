#!/usr/bin/env node
// bridge.mjs — mocopi → the browser.
//
// A web page can't listen for UDP, so this runs on the computer during a
// show: it receives the mocopi app's packets (UDP, port 12351 by default)
// and streams them to any page that connects (Server-Sent Events, port
// 12352), stamped with when they arrived. It also serves the viewer page
// (http://localhost:12352/) for checking the sensors and the features.
//
//   node bridge/bridge.mjs                    listen for the mocopi app
//   node bridge/bridge.mjs --demo             a made-up dancer instead (no sensors)
//   node bridge/bridge.mjs --record take.mcp  also save what arrives
//   node bridge/bridge.mjs --replay take.mcp [--loop]   play a saved take back
//   options: --udp 12351  --http 12352
//            --share   let other computers on the network open the stream and
//                      the viewer (by default only this laptop can)
//
// No dependencies. Motion data stays on the local network (the mocopi app
// sends it unencrypted; keep the show on its own Wi-Fi).

import dgram from 'node:dgram';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoSkeletonPacket, demoFramePacket } from '../src/demo.js';
import { parse } from '../src/smf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const UDP_PORT = Number(opt('udp', 12351)), HTTP_PORT = Number(opt('http', 12352));
const RECORD = opt('record', null), REPLAY = opt('replay', null);
const MAGIC = Buffer.from('MOCOPI-TAKE-1\n');

const clients = new Set();
let lastSkeleton = null, packets = 0, lastReport = 0;
const started = performance.now();
const recorder = RECORD ? fs.createWriteStream(RECORD) : null;
if (recorder) recorder.write(MAGIC);

// A page that has stopped reading (asleep, a dead connection) is let go
// rather than letting its unsent data pile up for the rest of the show.
const MAX_BACKLOG = 1 << 20;
function send(res, msg) {
  if (res.writableLength > MAX_BACKLOG) { clients.delete(res); res.destroy(); return; }
  res.write(msg);
}

// Every packet, from whichever source, goes through here.
function packet(buf) {
  if (!buf || buf.length < 16) return;
  const t = performance.now() / 1000;
  const p = parse(buf);
  if (!p) return; // not a mocopi packet
  if (p.kind === 'skeleton') lastSkeleton = Buffer.from(buf); // a page that joins later gets it first
  const msg = `event: packet\ndata: ${JSON.stringify({ t, b: buf.toString('base64') })}\n\n`;
  for (const res of clients) send(res, msg);
  if (recorder) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(Math.round(performance.now() - started), 0);
    head.writeUInt32LE(buf.length, 4);
    recorder.write(head); recorder.write(buf);
  }
  packets++;
  if (t - lastReport > 5) { lastReport = t; process.stdout.write(`\r${packets} packets, ${clients.size} page(s) listening   `); }
}

// ---- sources ----

if (flag('demo')) {
  let f = 0;
  const t0 = performance.now();
  packet(Buffer.from(demoSkeletonPacket()));
  setInterval(() => packet(Buffer.from(demoSkeletonPacket())), 3000);
  setInterval(() => packet(Buffer.from(demoFramePacket((performance.now() - t0) / 1000, f++))), 20); // 50 a second
  console.log('demo dancer: a made-up body, as mocopi packets');
} else if (REPLAY) {
  const data = fs.readFileSync(REPLAY);
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) { console.error(`${REPLAY} isn't a take saved by --record`); process.exit(1); }
  const take = [];
  for (let o = MAGIC.length; o + 8 <= data.length;) {
    const at = data.readUInt32LE(o), len = data.readUInt32LE(o + 4);
    if (o + 8 + len > data.length) break;
    take.push({ at, buf: data.subarray(o + 8, o + 8 + len) });
    o += 8 + len;
  }
  if (!take.length) { console.error('the take is empty'); process.exit(1); }
  const first = take[0].at; // no dead time before the first packet
  const play = () => {
    const t0 = performance.now() - first;
    let i = 0;
    const step = () => {
      const now = performance.now() - t0;
      while (i < take.length && take[i].at <= now) packet(take[i++].buf);
      if (i < take.length) setTimeout(step, Math.max(1, take[i].at - now));
      else if (flag('loop')) setTimeout(play, 1000); // a clear gap: the jump back isn't read as a fast move
      else console.log('\nthe take has ended');
    };
    step();
  };
  console.log(`replaying ${REPLAY}: ${take.length} packets, ${((take.at(-1).at - first) / 1000).toFixed(1)} s${flag('loop') ? ', looping' : ''}`);
  play();
} else {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf) => packet(buf));
  sock.on('error', (err) => { console.error(`UDP ${UDP_PORT}: ${err.message}`); process.exit(1); });
  sock.bind(UDP_PORT, () => {
    const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
    console.log(`listening for the mocopi app on UDP ${UDP_PORT}`);
    console.log(`in the app: PC connection → format "mocopi (UDP)", IP ${addrs.join(' or ') || '(this computer\'s Wi-Fi address)'}, port ${UDP_PORT}`);
  });
}

// ---- the page side ----

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer((req, res) => {
  // Any page may listen (the instrument may be served elsewhere); Chrome
  // asks before a public page reaches a local one (Private Network Access).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' }); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end('bad request'); return; }
  if (pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.on('error', () => clients.delete(res));
    res.write('retry: 1000\n: mocopi bridge\n\n'); // a page that loses the bridge tries again each second
    if (lastSkeleton) res.write(`event: packet\ndata: ${JSON.stringify({ t: performance.now() / 1000, b: lastSkeleton.toString('base64') })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  // The viewer and its modules only.
  const rel = pathname === '/' ? 'web/index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  let isFile = false;
  try { isFile = fs.statSync(file).isFile(); } catch { /* not there */ }
  if (!(file.startsWith(path.join(ROOT, 'web') + path.sep) || file.startsWith(path.join(ROOT, 'src') + path.sep)) || !isFile) {
    res.writeHead(404); res.end('not found'); return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    stream.pipe(res);
  });
}).listen(HTTP_PORT, flag('share') ? undefined : '127.0.0.1', () => console.log(`pages connect to http://localhost:${HTTP_PORT}/events — the viewer is at http://localhost:${HTTP_PORT}/${flag('share') ? ' (shared on the network)' : ''}`));

// Keep the page connections alive through proxies and sleep.
setInterval(() => { for (const res of clients) send(res, ': ping\n\n'); }, 15000);
// Stop cleanly: the recording's last writes land before the process ends.
const stop = () => {
  console.log('\nbridge stopped');
  if (recorder) recorder.end(() => process.exit(0)); else process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
