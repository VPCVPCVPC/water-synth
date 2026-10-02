// check-record.mjs — "record piece": the 16-bit conversion and the WAV file.
//   node check-record.mjs

import { toInt16, wavBlob, pieceName, PieceRecorder } from './record.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

console.log('\n1. Float → 16-bit');
{
  const n = 48000, src = new Float32Array(n), dst = new Int16Array(n);
  for (let i = 0; i < n; i++) src[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  toInt16(dst, 0, src, 0, n, { seed: 7 });
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(dst[i] - src[i] * 32767));
  report(worst <= 1.5, 'a 440 Hz sine at half scale comes out within the dither (±1 LSB)', `worst ${worst.toFixed(2)} LSB`);
  const silence = new Int16Array(n);
  toInt16(silence, 0, new Float32Array(n), 0, n, { seed: 3 });
  const levels = new Set(silence);
  report([...levels].every((v) => Math.abs(v) <= 1), 'silence becomes dither only (−1, 0, 1)', `values ${[...levels].sort().join(', ')}`);
  const odd = Float32Array.from([2, -2, NaN, Infinity, -Infinity, 1, -1]), out = new Int16Array(odd.length);
  toInt16(out, 0, odd, 0, odd.length, { seed: 9 });
  report(out[0] === 32767 && out[1] === -32768 && Math.abs(out[2]) <= 1 && Math.abs(out[3]) <= 1 && Math.abs(out[4]) <= 1,
    'over full scale clips; NaN and ±Infinity become silence', Array.from(out).join(', '));
  const a = new Int16Array(100), b = new Int16Array(100), r1 = { seed: 11 }, r2 = { seed: 11 };
  toInt16(a, 0, src, 0, 100, r1); toInt16(b, 0, src, 0, 100, r2);
  report(a.every((v, i) => v === b[i]) && r1.seed === r2.seed, 'the dither is repeatable from its seed (and the seed advances)');
}

console.log('\n2. The WAV file');
{
  const frames = 1000, chunk = new Int16Array(frames * 2);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 37) % 2000 - 1000;
  const half = [chunk.subarray(0, 800), chunk.subarray(800)];
  const blob = wavBlob(half, frames, 48000);
  const buf = new DataView(await blob.arrayBuffer());
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf.buffer, o, n));
  const ok = str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE' && str(12, 4) === 'fmt ' && str(36, 4) === 'data' &&
    buf.getUint32(4, true) === 36 + frames * 4 && buf.getUint16(20, true) === 1 && buf.getUint16(22, true) === 2 &&
    buf.getUint32(24, true) === 48000 && buf.getUint32(28, true) === 192000 && buf.getUint16(32, true) === 4 &&
    buf.getUint16(34, true) === 16 && buf.getUint32(40, true) === frames * 4 && blob.size === 44 + frames * 4;
  report(ok, 'a 16-bit stereo 48 kHz PCM WAV with correct sizes', `${blob.size} bytes, type ${blob.type}`);
  let same = true;
  for (let i = 0; i < chunk.length; i++) if (buf.getInt16(44 + i * 2, true) !== chunk[i]) { same = false; break; }
  report(same, 'its samples are exactly the chunks, in order');
}

console.log('\n2b. Draining the ring, and gaps kept as silence');
{
  // The page side without a browser: a recorder with its ring, and a stand-in
  // for the audio thread writing frames (or counting them as dropped).
  const fs = 1000, cap = 200;
  const rec = Object.create(PieceRecorder.prototype);
  Object.assign(rec, { fs, cap, maxSeconds: 10, chunks: [], frames: 0, gapFrames: 0, seenDropped: 0, timer: 0, dither: { seed: 5 }, onlimit: null });
  rec.buffer = new SharedArrayBuffer(16 + cap * 2 * 4);
  rec.idx = new Int32Array(rec.buffer, 0, 4); rec.ring = new Float32Array(rec.buffer, 16);
  Atomics.store(rec.idx, 2, 1);
  let t = 0;
  const audio = (n) => { // the tap's process(): write n frames of a ramp, or drop them if full
    let w = Atomics.load(rec.idx, 1); const r = Atomics.load(rec.idx, 0);
    if ((r - w - 1 + cap) % cap < n) { Atomics.add(rec.idx, 3, n); t += n; return; }
    for (let i = 0; i < n; i++, t++) { rec.ring[2 * w] = rec.ring[2 * w + 1] = ((t % 100) - 50) / 100; w = (w + 1) % cap; }
    Atomics.store(rec.idx, 1, w);
  };
  for (let k = 0; k < 10; k++) { audio(30); rec.drain(); } // keeping up: 300 frames
  for (let k = 0; k < 12; k++) audio(30); // the page falls behind: 360 frames, the ring holds 199
  rec.drain();
  for (let k = 0; k < 5; k++) { audio(30); rec.drain(); }
  const total = rec.frames, gaps = rec.gapFrames;
  report(total === t && gaps === Atomics.load(rec.idx, 3) && gaps > 0,
    'frames the page fell behind on come back as silence: the timeline keeps its length', `${total} frames for ${t} played; ${gaps} kept as silence`);
  const all = new Int16Array(total * 2); let o = 0;
  for (const c of rec.chunks) { all.set(c, o); o += c.length; }
  // The first 300 frames are the ramp as played.
  let ok = true;
  for (let i = 0; i < 300; i++) if (Math.abs(all[2 * i] - (((i % 100) - 50) / 100) * 32767) > 1.5) { ok = false; break; }
  report(ok, 'frames that fit are exactly what was played');
  rec.maxSeconds = 0.6; // a cap of 600 frames, already passed
  let limited = false; rec.onlimit = () => { limited = true; };
  audio(30); rec.drain();
  report(limited && !rec.recording && rec.frames === total, 'at the cap, recording stops and nothing more is added');
}

console.log('\n3. The file name');
report(pieceName(new Date(2026, 9, 2, 9, 5)) === 'water-synth-2026-10-02-0905.wav', 'water-synth-<date>-<time>.wav', pieceName(new Date(2026, 9, 2, 9, 5)));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll record checks passed.');
process.exit(failures ? 1 : 0);
