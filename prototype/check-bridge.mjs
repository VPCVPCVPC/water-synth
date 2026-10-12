// check-bridge.mjs — checks for the links without shared memory (bridge.js):
// events reach the audio side in order and whole, frames come back with
// their buffers reused, and a page that falls behind skips frames rather
// than piling them up.
//   node check-bridge.mjs

import { PortRingWriter, PortEventInbox, PortFramePublisher, PortFrameReader } from './bridge.js';
import { EVENT_FLOATS, EV_DROP, EV_PARAM } from './ring.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// A MessageChannel's two ends stand in for the page and the worklet.
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log('1. Events: page → audio');
{
  const ch = new MessageChannel();
  const writer = new PortRingWriter(ch.port1, 1024), inbox = new PortEventInbox(1024);
  ch.port2.onmessage = (e) => inbox.receive(e.data);
  for (let i = 0; i < 300; i++) writer.push(EV_DROP, i / 300, 0.5, 1);
  writer.push(EV_PARAM, 7, 0.25);
  await tick(); await tick();
  const got = [];
  inbox.drain((d, o) => got.push(Array.from(d.subarray(o, o + EVENT_FLOATS))));
  const inOrder = got.length === 301 && got.slice(0, 300).every((e, i) => e[0] === EV_DROP && Math.abs(e[1] - i / 300) < 1e-6);
  report(inOrder && got[300][0] === EV_PARAM && got[300][1] === 7 && Math.abs(got[300][2] - 0.25) < 1e-7,
    'a burst of 301 events arrives whole and in order, in one batch', `${got.length} events`);
  // Far more than the ring holds (the audio suspended while the page kept
  // sending): nothing lost, all in order, a ring's worth per block.
  const big = new PortEventInbox(64);
  for (let b = 0; b < 10; b++) big.receive(Float32Array.from({ length: 50 * EVENT_FLOATS }, (_, i) => (i % EVENT_FLOATS === 0 ? EV_DROP : i % EVENT_FLOATS === 1 ? b * 50 + Math.floor(i / EVENT_FLOATS) : 0)));
  const seen = [];
  let blocks = 0;
  while (blocks < 50) { const n = big.drain((d, o) => seen.push(d[o + 1])); blocks++; if (n === 0 && !big.backlog.length) break; }
  report(seen.length === 500 && seen.every((v, i) => v === i), 'a backlog far past the ring\'s size arrives whole and in order over a few blocks', `${seen.length} events in ${blocks} blocks`);
  // More than a ring holds in one task: the writer says so (like RingWriter).
  const small = new PortRingWriter(ch.port1, 4);
  const ok = [1, 2, 3, 4, 5].map((i) => small.push(EV_DROP, i, 0, 1));
  report(ok.slice(0, 4).every(Boolean) && ok[4] === false, 'a full batch refuses the next push (the caller retries next frame)');
  ch.port1.close(); ch.port2.close();
}

console.log('\n2. Frames: audio → page, buffers reused');
{
  const ch = new MessageChannel(), LEN = 64;
  const pub = new PortFramePublisher(ch.port2, LEN), reader = new PortFrameReader(ch.port1, LEN);
  ch.port1.onmessage = (e) => reader.receive(e.data);
  ch.port2.onmessage = (e) => pub.receive(e.data);
  let sent = 0;
  for (let k = 0; k < 20; k++) {
    const f = pub.begin();
    if (f) { f.fill(k); pub.end(); sent++; }
    await tick(); await tick();
    const got = reader.read();
    if (got && got[0] !== k) { report(false, 'frame contents', `frame ${k} read as ${got[0]}`); break; }
  }
  report(sent === 20 && pub.skipped === 0, 'with the page keeping up, every frame goes and its buffer comes back', `${sent} sent, ${pub.skipped} skipped`);
  // The page stops reading and returning: after the pool is used up, frames are skipped, not queued.
  ch.port1.onmessage = null;
  let skipped = 0;
  for (let k = 0; k < 10; k++) { const f = pub.begin(); if (f) pub.end(); else skipped++; }
  report(skipped >= 7, 'a page that falls behind gets frames skipped, never a growing queue', `${skipped} of 10 skipped`);
  // A frame handed out stays as it was until the next read.
  const r2 = new PortFrameReader({ postMessage() {} }, 4);
  r2.receive(Float32Array.of(1, 1, 1, 1));
  const a = r2.read();
  r2.receive(Float32Array.of(2, 2, 2, 2));
  report(a[0] === 1 && r2.read()[0] === 2, 'a frame handed out isn\'t overwritten by the next one arriving');
  ch.port1.close(); ch.port2.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
