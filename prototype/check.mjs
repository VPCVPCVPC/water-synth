// check.mjs — objective checks on the medium, no browser needed.
//   node check.mjs          run all checks, write output/drops.wav
//
// These can't tell whether it sounds good. They tell us it's stable, it
// settles, it keeps its promised decay times and pitch, it varies, and what
// it costs.

import { Medium, PARAMS } from './medium.js';
import { createRingBuffer, RingWriter, RingReader, EV_DROP } from './ring.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const BLOCK = 128;
const RATES = [44100, 48000, 88200, 96000, 192000];
let failures = 0;

function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function makeMedium(fs, params = {}, size = 32, seed = 1) {
  const m = new Medium({ size, sampleRate: fs, seed });
  for (const [k, v] of Object.entries(params)) m.setParam(k, v);
  m.snapParams();
  return m;
}

// Deterministic random numbers for the harness itself.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

// Render `seconds` of audio in blocks of `block` samples. `events` is a list of
// [timeSeconds, fn(medium)]. onBlock(medium, blockStartSeconds) runs after each block.
function render(m, seconds, events = [], onBlock, block = BLOCK) {
  const total = Math.ceil((seconds * m.fs) / block) * block;
  const L = new Float32Array(total), R = new Float32Array(total);
  const bl = new Float32Array(block), br = new Float32Array(block);
  const queue = [...events].sort((a, b) => a[0] - b[0]);
  let q = 0;
  for (let pos = 0; pos < total; pos += block) {
    const t = pos / m.fs;
    while (q < queue.length && queue[q][0] <= t) queue[q++][1](m);
    m.process(bl, br, block);
    L.set(bl, pos);
    R.set(br, pos);
    if (onBlock) onBlock(m, t);
  }
  return { L, R };
}

const peak = (a, from = 0, to = a.length) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
};
const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const allFinite = (a) => a.every(Number.isFinite);

// A gesture sequence: drops across the surface, then a drag.
const GESTURES = [
  [0.00, (m) => m.drop(0.5, 0.5, 1)],
  [0.15, (m) => m.drop(0.2, 0.7, 0.8)],
  [0.30, (m) => m.drop(0.8, 0.3, 1.2)],
  [0.32, (m) => m.drop(0.02, 0.98, 1)], // near a corner
  ...Array.from({ length: 20 }, (_, i) => [
    0.5 + i * 0.015,
    (m) => m.stroke(0.1 + i * 0.04, 0.5, 0.14 + i * 0.04, 0.52, 0.6, 0.02),
  ]),
];
const GESTURES_END = 0.5 + 20 * 0.015 + 0.02;

const P = PARAMS;
const EXTREMES = {
  'fast+long+bright (kappa=0)': { waveSpeed: P.waveSpeed.max, decay: P.decay.max, hfDecay: P.hfDecay.max, inputGain: P.inputGain.max },
  'fast+short+dark': { waveSpeed: P.waveSpeed.max, decay: P.decay.min, hfDecay: P.hfDecay.min },
  'fast+long+dark (max kappa)': { waveSpeed: P.waveSpeed.max, decay: P.decay.max, hfDecay: P.hfDecay.min },
  'slow+long+dark': { waveSpeed: P.waveSpeed.min, decay: P.decay.max, hfDecay: P.hfDecay.min },
};

// ---- 1. Stability across sample rates and parameter extremes ---------------
console.log('\n1. Stability: finite, no guard trips, energy lower at the end than when gestures stopped');
{
  const sets = [{ name: 'defaults', p: {} }];
  for (const [k, r] of Object.entries(P)) {
    sets.push({ name: `${k}=min`, p: { [k]: r.min } });
    sets.push({ name: `${k}=max`, p: { [k]: r.max } });
  }
  for (const [name, p] of Object.entries(EXTREMES)) sets.push({ name, p });
  let worst = null;
  const bad = [];
  for (const fs of RATES) {
    for (const set of sets) {
      const m = makeMedium(fs, set.p);
      let eGesturesEnd = NaN;
      const { L, R } = render(m, 1.2, GESTURES, (mm, t) => {
        if (Number.isNaN(eGesturesEnd) && t >= GESTURES_END) eGesturesEnd = mm.energy();
      });
      const eEnd = m.energy();
      const ok = allFinite(L) && allFinite(R) && m.resets === 0 && Number.isFinite(eEnd) && eEnd <= eGesturesEnd;
      if (!ok) bad.push(`${fs}/${set.name}`);
      const p = Math.max(peak(L), peak(R));
      if (!worst || p > worst.p) worst = { p, where: `${fs} Hz, ${set.name}` };
    }
  }
  report(bad.length === 0, `${RATES.length} rates × ${sets.length} parameter sets`,
    bad.length ? `failed: ${bad.join(', ')}` : `loudest peak ${worst.p.toFixed(3)} (${worst.where})`);
}
{
  // Parameters jumping at random mid-performance (the smoothing path), with gestures.
  const bad = [];
  for (const fs of [44100, 192000]) {
    const m = makeMedium(fs);
    const r = rng(7);
    const keys = Object.keys(P);
    const { L, R } = render(m, 10, [], (mm) => {
      if (r() < 0.2) {
        const k = keys[Math.floor(r() * keys.length)];
        mm.setParam(k, P[k].min + r() * (P[k].max - P[k].min));
      }
      if (r() < 0.05) mm.drop(r(), r(), r() * 4);
      if (r() < 0.3) mm.stroke(r(), r(), r(), r(), r() * 4, 0.02);
    });
    if (!(allFinite(L) && allFinite(R) && m.resets === 0)) bad.push(fs);
  }
  report(bad.length === 0, 'random parameter automation + gestures, 10 s', bad.length ? `failed at ${bad.join(', ')} Hz` : '');
}
{
  // Bad input from the UI must be ignored or clamped, never wipe the medium.
  const m = makeMedium(48000);
  const bad = [NaN, Infinity, -Infinity];
  const { L, R } = render(m, 0.5, [
    [0, (mm) => { for (const v of bad) { mm.drop(v, 0.5, 1); mm.drop(0.5, 0.5, v); mm.stroke(0.1, 0.1, 0.2, 0.2, 1, v); mm.stroke(v, 0.1, 0.2, 0.2, 1, 0.02); mm.setParam('decay', v); } }],
    [0.01, (mm) => { mm.drop(0.5, 0.5, 1e40); mm.stroke(0.1, 0.1, 0.9, 0.9, 1, 1e6); mm.drop(-5, 7, 1); }],
  ]);
  const ok = allFinite(L) && allFinite(R) && m.resets === 0 && m.exLen.every((n) => n <= 2 * 48000);
  report(ok, 'NaN / Inf / huge gesture values are rejected or clamped', `peak ${Math.max(peak(L), peak(R)).toFixed(3)}, resets ${m.resets}`);
}

// ---- 2. Energy never grows once gestures stop (checked every step) ---------
// The 1e-9 tolerance relies on the Float64 grid; a float32 C++ port should sum
// energy in double and allow ~1e-6.
console.log('\n2. Energy is non-increasing after the last gesture, every simulation step');
for (const fs of [44100, 48000, 192000]) {
  for (const [name, p] of [['defaults', {}], ...Object.entries(EXTREMES)]) {
    const m = makeMedium(fs, p);
    render(m, GESTURES_END + 0.01, GESTURES);
    const steps = Math.round(0.5 * fs);
    const one = new Float32Array(1);
    let prev = m.energy(), rises = 0, worst = 0;
    const e0 = prev;
    for (let s = 0; s < steps; s++) {
      m.process(one, one, 1);
      const e = m.energy();
      if (e > prev) { rises++; worst = Math.max(worst, (e - prev) / prev); }
      prev = e;
    }
    report(worst < 1e-9, `${fs} Hz, ${name}`,
      `${steps} steps, ${prev === 0 ? "snapped to silence" : `fell ${(10 * Math.log10(e0 / prev)).toFixed(1)} dB`}, ${rises} rises (worst ${worst.toExponential(1)})`);
  }
}

// ---- 3. Decay times and pitch match what the controls promise --------------
console.log('\n3. Pure modes: T60 matches decay/hfDecay; pitch matches theory at every rate');
function seedMode(m, mx, my) {
  const N = m.N, phi = new Float64Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    phi[y * N + x] = Math.sin((mx * Math.PI * (x + 1)) / (N + 1)) * Math.sin((my * Math.PI * (y + 1)) / (N + 1));
  }
  // At rest, displaced into the mode shape at a playing-level amplitude.
  const shape = phi.map((v) => v * 1e-4);
  m.loadState(shape, shape);
  return phi;
}
function measureMode(fs, mx, my, params, seconds) {
  const m = makeMedium(fs, params);
  const phi = seedMode(m, mx, my);
  let phi2 = 0;
  for (const v of phi) phi2 += v * v;
  const snap = new Float32Array(m.N * m.N), one = new Float32Array(1);
  const steps = Math.round(seconds * fs);
  const t1 = Math.round(0.02 * fs), t2 = steps - 1;
  let e1 = 0, e2 = 0, prevA = 0, firstCross = -1, lastCross = -1, crossings = 0;
  for (let s = 0; s < steps; s++) {
    m.process(one, one, 1);
    m.snapshot(snap);
    let a = 0;
    for (let i = 0; i < snap.length; i++) a += snap[i] * phi[i];
    a /= phi2;
    if (s > 0 && prevA < 0 && a >= 0) {
      const t = s - 1 + prevA / (prevA - a); // interpolated upward zero crossing
      if (firstCross < 0) firstCross = t;
      lastCross = t;
      crossings++;
    }
    prevA = a;
    if (s === t1) e1 = m.energy();
    if (s === t2) e2 = m.energy();
  }
  const freq = ((crossings - 1) * fs) / (lastCross - firstCross);
  const t60 = ((t2 - t1) / fs) * Math.log(1e6) / Math.log(e1 / e2); // energy falls 120 dB per T60
  return { freq, t60, resets: m.resets };
}
const cents = (a, b) => 1200 * Math.log2(a / b);
{
  const c = P.waveSpeed.def, N = 32;
  const theory11 = (c / (2 * (N + 1))) * Math.SQRT2;
  const results = {};
  for (const fs of [44100, 192000]) {
    const low = measureMode(fs, 1, 1, {}, 1.0);
    const high = measureMode(fs, N, N, {}, 0.3);
    results[fs] = low.freq;
    report(low.resets === 0 && Math.abs(low.t60 / P.decay.def - 1) < 0.05, `${fs} Hz, mode (1,1) T60`, `${low.t60.toFixed(3)} s vs decay ${P.decay.def} s`);
    report(high.resets === 0 && Math.abs(high.t60 / P.hfDecay.def - 1) < 0.05, `${fs} Hz, mode (${N},${N}) T60`, `${high.t60.toFixed(3)} s vs hfDecay ${P.hfDecay.def} s`);
    report(Math.abs(cents(low.freq, theory11)) < 5, `${fs} Hz, mode (1,1) pitch`, `${low.freq.toFixed(2)} Hz vs ${theory11.toFixed(2)} Hz theory (${cents(low.freq, theory11).toFixed(2)} cents)`);
  }
  const drift = cents(results[192000], results[44100]);
  report(Math.abs(drift) < 2, 'mode (1,1) pitch, 44.1k vs 192k', `${drift.toFixed(3)} cents`);
}

// ---- 4. Settles to silence -------------------------------------------------
console.log('\n4. Settles to silence');
for (const decay of [P.decay.def, P.decay.max]) {
  const m = makeMedium(48000, { decay });
  const seconds = GESTURES_END + decay * 1.2 + 0.5;
  const { L, R } = render(m, seconds, GESTURES);
  const pk = Math.max(peak(L), peak(R));
  const tail = Math.round(0.25 * m.fs);
  const endLevel = Math.max(rms(L, L.length - tail), rms(R, R.length - tail));
  const db = 20 * Math.log10(endLevel / pk + 1e-30);
  report(db < -60, `decay=${decay}s, after ${seconds.toFixed(1)}s`, `tail at ${db.toFixed(1)} dB re peak`);
}
for (const fs of [48000, 192000]) {
  const m = makeMedium(fs, { decay: P.decay.min });
  render(m, 4, GESTURES);
  const still = m.asleep && m.u.every((v) => v === 0) && m.up.every((v) => v === 0);
  report(still, `${fs} Hz: surface returns to exact stillness and sleeps`, still ? '' : `energy ${m.energy().toExponential(2)}`);
}

// ---- 5. Block-size independence ---------------------------------------------
console.log('\n5. Output is identical however the stream is split into blocks');
{
  const events = [
    [0, (m) => { m.drop(0.4, 0.6, 1); m.stroke(0.2, 0.2, 0.6, 0.3, 1, 0.1); m.setParam('outputGain', 3); m.setParam('waveSpeed', 15000); }],
  ];
  const ref = render(makeMedium(48000), 0.5, events, null, 128).L;
  const bad = [];
  for (const b of [1, 7, 32, 1000, 4096]) {
    const out = render(makeMedium(48000), 0.5, events, null, b).L;
    const n = Math.round(0.5 * 48000);
    for (let i = 0; i < n; i++) if (out[i] !== ref[i]) { bad.push(`${b} (differs at sample ${i})`); break; }
  }
  report(bad.length === 0, 'block sizes 1, 7, 32, 128, 1000, 4096', bad.length ? bad.join(', ') : 'bit-identical');
}

// ---- 6. The same gesture never sounds exactly the same twice ---------------
console.log('\n6. Variation: identical drops on a still surface differ');
{
  const m = makeMedium(48000);
  const a = render(m, 0.3, [[0, (mm) => mm.drop(0.5, 0.5, 1)]]).L;
  m.reset();
  const b = render(m, 0.3, [[0, (mm) => mm.drop(0.5, 0.5, 1)]]).L;
  let diff = 0, ref = 0;
  for (let i = 0; i < a.length; i++) { diff += (a[i] - b[i]) ** 2; ref += a[i] ** 2; }
  const rel = Math.sqrt(diff / ref);
  report(rel > 0.05 && rel < 1.5, 'two drops at the same spot', `relative difference ${(rel * 100).toFixed(1)}%`);
}

// ---- 7. Reference render ---------------------------------------------------
console.log('\n7. Reference render');
{
  const m = makeMedium(48000);
  const { L, R } = render(m, 6, GESTURES);
  mkdirSync(new URL('./output/', import.meta.url), { recursive: true });
  writeWav(new URL('./output/drops.wav', import.meta.url), [L, R], m.fs);
  console.log(`      wrote output/drops.wav — peak ${Math.max(peak(L), peak(R)).toFixed(3)}, ` +
    `first-drop peak ${Math.max(peak(L, 0, 7200), peak(R, 0, 7200)).toFixed(3)}`);
}

// ---- 8. CPU cost -----------------------------------------------------------
console.log('\n8. CPU per 128-sample block at 48 kHz (budget 2667 µs)');
function bench(size, drive) {
  const m = makeMedium(48000, {}, size);
  const r = rng(11);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  for (let i = 0; i < 300; i++) { drive(m, i, r); m.process(bl, br, BLOCK); } // warm up the JIT
  const blocks = 3000;
  const t0 = performance.now();
  for (let i = 0; i < blocks; i++) { drive(m, i, r); m.process(bl, br, BLOCK); }
  const us = ((performance.now() - t0) * 1000) / blocks;
  return { us, pct: (us / ((BLOCK / 48000) * 1e6)) * 100 };
}
const playing = (m, i, r) => {
  if (i % 20 === 0) m.drop(r(), r(), 0.5);
  if (i % 3 === 0) m.stroke(0.3, 0.3, 0.35, 0.32, 0.3, 0.02);
};
const worstCase = (m, i, r) => { // every excitation slot busy with long, wide strokes
  for (let k = 0; k < 16; k++) m.stroke(r(), r(), r(), r(), 1, 2);
};
{
  const limits = { 32: 30 }; // % of real time; fails above this
  for (const size of [32, 48, 64]) {
    const { us, pct } = bench(size, playing);
    const lim = limits[size];
    const line = `${size}×${size} playing: ${us.toFixed(0)} µs/block, ${pct.toFixed(1)}% of real time`;
    if (lim) report(pct < lim, line, `limit ${lim}%`);
    else console.log(`      ${line}`);
  }
  const w = bench(32, worstCase);
  report(w.pct < 50, `32×32 worst case (all 16 excitations at once): ${w.us.toFixed(0)} µs/block, ${w.pct.toFixed(1)}%`, 'limit 50%');
  const idle = bench(32, () => {});
  report(idle.pct < 1, `32×32 asleep: ${idle.us.toFixed(1)} µs/block, ${idle.pct.toFixed(2)}%`, 'limit 1%');
}

// ---- 9. Event queue (page → audio thread) ----------------------------------
console.log('\n9. Event queue');
{
  const sab = createRingBuffer(8);
  const w = new RingWriter(sab), r = new RingReader(sab);
  const seen = [];
  const handler = (d, o) => seen.push(d[o + 1]);
  let pushed = 0;
  while (w.push(EV_DROP, pushed)) pushed++;
  const full = pushed === 7; // one slot stays empty to tell full from empty
  r.drain(handler);
  for (let i = 0; i < 20; i++) { w.push(EV_DROP, 100 + i); if (i % 3 === 2) r.drain(handler); } // wrap around
  r.drain(handler);
  const expected = [...Array(7).keys(), ...Array.from({ length: 20 }, (_, i) => 100 + i)];
  const inOrder = seen.length === expected.length && seen.every((v, i) => v === expected[i]);
  report(full && inOrder, 'FIFO order, full detection, wrap-around', `${seen.length} events`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);

function writeWav(path, channels, fs) {
  const n = channels[0].length, ch = channels.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(fs, 24); buf.writeUInt32LE(fs * ch * 2, 28);
  buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  writeFileSync(path, buf);
}
