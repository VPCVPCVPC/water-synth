// check-limiter.mjs — checks for the output limiter (limiter.js): the mix
// never passes the ceiling, quiet sound goes through untouched, the gain
// moves smoothly and comes back, nothing depends on the block size, and
// layered tapes through the whole instrument come out under full scale.
//   node check-limiter.mjs

import { Limiter, LIMITER_CEILING } from './limiter.js';
import { Instrument } from './instrument.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { EV_DROP, EV_TAPE } from './ring.js';
import { TAPE_RECORD } from './tape.js';
import { performance } from 'node:perf_hooks';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Run `x` (L and R arrays) through a fresh limiter in blocks of `block`;
// returns { L, R, gains } (the gain after each block's last sample, and per
// sample when block is 1).
function run(xL, xR, { rate = 48000, block = 128 } = {}) {
  const lim = new Limiter({ sampleRate: rate });
  const L = Float32Array.from(xL), R = Float32Array.from(xR), gains = [];
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    const bl = L.subarray(i, i + n), br = R.subarray(i, i + n);
    lim.process(bl, br, n);
    gains.push(lim.gain);
  }
  return { L, R, gains, D: lim.D };
}
let seed = 11;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };

// ---- 1. The ceiling --------------------------------------------------------------------
console.log('1. Nothing passes the ceiling');
for (const rate of [44100, 48000, 96000, 192000]) {
  const n = rate * 3, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // Bursts of loud tones, single-sample spikes, a square wave, silence.
    const burst = Math.floor(t * 4) % 3 === 0 ? 5 * Math.sin(2 * Math.PI * 440 * t) : 0.3 * Math.sin(2 * Math.PI * 220 * t);
    L[i] = burst + (rnd() < 0.0005 ? (rnd() - 0.5) * 20 : 0);
    R[i] = t > 2 && t < 2.5 ? (Math.sin(2 * Math.PI * 97 * t) > 0 ? 3 : -3) : burst * 0.5;
  }
  const out = run(L, R, { rate });
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i]));
  report(peak <= LIMITER_CEILING + 1e-6, `${rate} Hz: loud bursts, spikes and a square stay under ${LIMITER_CEILING}`, `peak ${peak.toFixed(4)}`);
}

// ---- 2. Quiet sound is untouched -----------------------------------------------------------
console.log('\n2. Quiet sound goes through untouched (only delayed)');
{
  const rate = 48000, n = rate, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 0.8 * Math.sin(2 * Math.PI * 330 * i / rate); R[i] = 0.5 * Math.sin(2 * Math.PI * 517 * i / rate); }
  const out = run(L, R), d = out.D - 1;
  let err = 0;
  for (let i = d; i < n; i++) err = Math.max(err, Math.abs(out.L[i] - L[i - d]), Math.abs(out.R[i] - R[i - d]));
  report(err === 0, `a tone at 0.8 comes out sample for sample, ${d} samples (${(1000 * d / rate).toFixed(2)} ms) late`, `max difference ${err}`);
}

// ---- 3. Smooth, and back up ----------------------------------------------------------------
console.log('\n3. The gain moves smoothly and comes back');
{
  const rate = 48000, n = rate * 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate, loud = t > 0.5 && t < 0.6 ? 4 : 0.2;
    L[i] = R[i] = loud * Math.sin(2 * Math.PI * 200 * t);
  }
  const out = run(L, R, { block: 1 });
  let step = 0, low = 1;
  for (let i = 1; i < n; i++) { step = Math.max(step, Math.abs(out.gains[i] - out.gains[i - 1])); low = Math.min(low, out.gains[i]); }
  report(step <= 1 / out.D + 1e-9, 'the gain ramps, never steps (at most 1/window per sample)', `largest step ${step.toFixed(4)}, lowest gain ${low.toFixed(3)}`);
  const back = out.gains[Math.round(1.6 * rate)];
  report(low < 0.3 && back > 0.98, 'a loud tenth of a second turns it down, and a second later it is back up', `gain ${back.toFixed(4)} at 1 s after`);
}

// ---- 4. Block size and bad input -------------------------------------------------------------
console.log('\n4. Block size and bad input');
{
  const rate = 48000, n = rate, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = 3 * Math.sin(i * 0.05) * Math.sin(i * 0.0003); R[i] = (rnd() - 0.5) * 4; }
  const a = run(L, R, { block: 1 }), b = run(L, R, { block: 128 }), c = run(L, R, { block: 4096 });
  let same = true;
  for (let i = 0; i < n; i++) if (a.L[i] !== b.L[i] || a.L[i] !== c.L[i] || a.R[i] !== b.R[i] || a.R[i] !== c.R[i]) { same = false; break; }
  report(same, 'blocks of 1, 128 and 4096 give the same output, sample for sample');
  const bad = new Float32Array(1024).fill(0.5), badR = new Float32Array(1024).fill(0.5);
  bad[100] = NaN; bad[200] = Infinity; badR[300] = -Infinity;
  const o = run(bad, badR);
  let finite = true, peak = 0;
  for (let i = 0; i < 1024; i++) { if (!Number.isFinite(o.L[i]) || !Number.isFinite(o.R[i])) finite = false; peak = Math.max(peak, Math.abs(o.L[i]), Math.abs(o.R[i])); }
  report(finite && peak <= 0.5, 'NaN and infinities come out as silence, not noise', `peak ${peak}`);
}

// ---- 5. Through the instrument: four tapes and the live water --------------------------------
console.log('\n5. Four layered tapes and live playing');
{
  const rate = 48000, B = 128;
  const inst = new Instrument({ sampleRate: rate, seed: 3 }), lim = new Limiter({ sampleRate: rate });
  const PEN = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
  const { xs, ys } = stonePositions(PEN.length);
  inst.setStones(xs, ys, PEN.map((p) => p.hz), PEN.length);
  const send = (...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  const L = new Float32Array(B), R = new Float32Array(B);
  let t = 0, next = 0, pre = 0, post = 0, low = 1;
  const play = (sec) => {
    const end = t + sec * rate;
    while (t < end) {
      if (t >= next) { send(EV_DROP, rnd(), rnd(), 1); next = t + (rate / 6) * (0.5 + rnd()); }
      inst.process(L, R, B);
      for (let i = 0; i < B; i++) pre = Math.max(pre, Math.abs(L[i]), Math.abs(R[i]));
      lim.process(L, R, B);
      for (let i = 0; i < B; i++) post = Math.max(post, Math.abs(L[i]), Math.abs(R[i]));
      low = Math.min(low, lim.takeMinGain());
      t += B;
    }
  };
  for (let k = 0; k < 4; k++) { send(EV_TAPE, k, TAPE_RECORD); send(EV_DROP, rnd(), rnd(), 1); play(4); send(EV_TAPE, k, TAPE_RECORD); play(0.2); }
  pre = post = 0; low = 1;
  play(10);
  report(pre > 1 && post <= LIMITER_CEILING + 1e-6,
    'the mix reaches past full scale, and leaves under the ceiling', `before ${pre.toFixed(2)}, after ${post.toFixed(3)}, lowest gain ${low.toFixed(2)} (${(20 * Math.log10(low)).toFixed(1)} dB)`);

  // CPU: the limiter alone, per 128-sample block.
  const lim2 = new Limiter({ sampleRate: rate }), bl = new Float32Array(B), br = new Float32Array(B);
  let best = Infinity;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now(), m = 4000;
    for (let k = 0; k < m; k++) { for (let i = 0; i < B; i++) { bl[i] = 2 * Math.sin(k * B + i); br[i] = bl[i]; } lim2.process(bl, br, B); }
    best = Math.min(best, ((performance.now() - t0) * 1000) / m);
  }
  report(best / 2667 < 0.03, `limiter: ${best.toFixed(1)} µs per block, ${((best / 2667) * 100).toFixed(2)}% of real time`, 'limit 3%');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
