// check-bells.mjs — checks for the bells (one per stone) and the whole
// instrument, including the page → audio-thread event path.
//   node check-bells.mjs

import { Bells } from './bells.js';
import { Instrument, PARAM_KEYS } from './instrument.js';
import { MAX_STONES } from './stones.js';
import { buildPitches, SCALES, REFERENCES } from './tuning.js';
import { stonePositions } from './layout.js';
import { createRingBuffer, RingWriter, RingReader, EV_DROP, EV_STONE, EV_STONES_COMMIT } from './ring.js';
import { frameLength, FRAME_FLASH, FRAME_HEIGHTS } from './visuals.js';
import { performance } from 'node:perf_hooks';
import { cents, spectrum, measurePitch, fftSize } from './check-lib.mjs';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Ring one stone and return the output summed to mono. `then` strikes again
// at sample `then.at` via then.fn(bells, offsetInBlock).
function ring(fs, hz, { velocity = 1, seconds = 1, offset = 0, decay, then } = {}) {
  const b = new Bells({ sampleRate: fs });
  if (decay) b.setParam('bellDecay', decay);
  const n = Math.round(seconds * fs), block = 128;
  const L = new Float32Array(block), R = new Float32Array(block), out = new Float64Array(n);
  b.strike(0, hz, velocity, 0.5, offset);
  for (let pos = 0; pos < n; pos += block) {
    const m = Math.min(block, n - pos);
    L.fill(0); R.fill(0);
    if (then && pos <= then.at && then.at < pos + m) {
      b.renderRange(L, R, 0, then.at - pos);
      then.fn(b, then.at - pos);
      b.renderRange(L, R, then.at - pos, m);
      b.endBlock(L, R, m);
    } else {
      b.render(L, R, m);
    }
    for (let i = 0; i < m; i++) out[pos + i] = L[i] + R[i];
  }
  return { out, bells: b };
}


// ---- 1. Pitch: each bell's lowest partial is the stone's pitch ---------------------
console.log('\n1. Bell pitch matches the stone (FFT, within 2 cents, lowest partial)');
const one = (opts) => buildPitches({ scale: SCALES.chromatic, root: 60, ...opts })[0];
const TARGETS = [
  ['C2', one({ low: 36, high: 36 }).hz],
  ['A4', one({ low: 69, high: 69 }).hz],
  ['A4 at A=432', one({ low: 69, high: 69, reference: REFERENCES.a432 }).hz],
  ['Rast E−50¢', buildPitches({ scale: SCALES.rast, root: 60, low: 63, high: 64 })[0].hz],
  ['C7', one({ low: 96, high: 96 }).hz],
];
for (const fs of [44100, 48000, 192000]) {
  const results = TARGETS.map(([name, hz]) => {
    const m = measurePitch(ring(fs, hz, { seconds: 1.5 }).out, fs, hz, fftSize(fs));
    if (m.error) return { bad: true, text: `${name}: ${m.error}` };
    const err = cents(m.hz, hz);
    return { err, text: `${name} ${err >= 0 ? '+' : ''}${err.toFixed(2)}¢` };
  });
  report(results.every((r) => !r.bad && Math.abs(r.err) < 2), `${fs / 1000} kHz`, results.map((r) => r.text).join(', '));
}
{
  // The measurement itself must catch an octave-low bell and a semitone error.
  const fs = 48000, hz = 440;
  const octaveLow = measurePitch(ring(fs, hz / 2, { seconds: 1.5 }).out, fs, hz, fftSize(fs));
  const semitone = measurePitch(ring(fs, hz * Math.pow(2, 1 / 12), { seconds: 1.5 }).out, fs, hz, fftSize(fs));
  report(Boolean(octaveLow.error) && Boolean(semitone.error), 'the pitch check rejects an octave-low bell and a semitone-off bell',
    `octave low: ${octaveLow.error}; semitone: ${semitone.error}`);
}

// ---- 2. Nothing aliases --------------------------------------------------------
console.log('\n2. No aliasing: partials near Nyquist are dropped');
{
  const fs = 44100, hz = 12000;
  const { out } = ring(fs, hz, { seconds: 0.5 });
  const mag = spectrum(out, 1 << 16), bin = fs / (1 << 16);
  let inBand = 0, outBand = 0;
  for (let i = 1; i < mag.length; i++) {
    const f = i * bin, e = mag[i] * mag[i];
    if (Math.abs(cents(f, hz)) < 100) inBand += e; else if (f > 200) outBand += e;
  }
  const db = 10 * Math.log10(outBand / inBand);
  report(db < -40, '12 kHz bell at 44.1 kHz: energy away from 12 kHz', `${db.toFixed(1)} dB re the fundamental (tick included)`);
}

// ---- 3. Bells ring out and finish ------------------------------------------------
console.log('\n3. Decay and release');
{
  const fs = 48000;
  for (const [hz, decay] of [[220, 2.5], [880, 1], [110, 4]]) {
    const { out, bells } = ring(fs, hz, { seconds: decay * 2.2, decay });
    const win = Math.round(0.05 * fs);
    const rms = (from) => { let s = 0; for (let i = from; i < from + win; i++) s += out[i] * out[i]; return Math.sqrt(s / win); };
    const start = rms(Math.round(0.1 * fs));
    let t60 = NaN;
    for (let t = 0.1; t < decay * 2.2 - 0.06; t += 0.01) if (rms(Math.round(t * fs)) < start / 1000) { t60 = t - 0.1; break; }
    const expected = decay * Math.pow(220 / hz, 0.3);
    report(Math.abs(t60 / expected - 1) < 0.12 && bells.activeVoices() === 0,
      `${hz} Hz, bell decay ${decay} s`, `T60 ${t60.toFixed(2)} s vs ${expected.toFixed(2)} s; still ringing: ${bells.activeVoices()}`);
  }
}

// ---- 4. Onset, re-strikes, retunes: never a cut or a click --------------------------
console.log('\n4. Onsets, re-strikes and retunes');
{
  const { out } = ring(48000, 440, { seconds: 0.01, offset: 50 });
  const before = out.slice(0, 50).every((v) => v === 0);
  report(before && out[51] !== 0 && Math.abs(out[50]) < 0.05, 'strike at sample 50: silent before, gentle first sample',
    `first sample ${Math.abs(out[50]).toFixed(4)}`);
}
// Largest sample-to-sample step in [from, to).
const maxStep = (x, from, to) => { let m = 0; for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
const peakIn = (x, from, len) => { let m = 0; for (let i = from; i < from + len; i++) m = Math.max(m, Math.abs(x[i])); return m; };
// A strike legitimately starts with the slope of its own first cycle. "No
// jump" means the step across a re-strike or retune is no bigger than the
// steady ring's step plus a fresh strike's own first steps.
// (15% headroom for the random tick; a cut-off ring would be several times larger.)
const freshStep = (fs, hz) => maxStep(ring(fs, hz, { seconds: 0.002 }).out, 0, Math.round(0.002 * fs));
{
  const fs = 48000, at = Math.round(0.3 * fs);
  const { out, bells } = ring(fs, 440, { seconds: 0.6, then: { at, fn: (b, off) => b.strike(0, 440, 1, 0.5, off) } });
  const allowed = maxStep(out, at - 2000, at - 10) + freshStep(fs, 440), across = maxStep(out, at - 10, at + 10);
  report(bells.activeVoices() === 1 && bells.restruck === 1 && across <= allowed * 1.15 && peakIn(out, at + 50, 480) > peakIn(out, at - 600, 480),
    're-striking a ringing stone adds to its ring (one bell, no jump)',
    `step across the re-strike ${(across / allowed).toFixed(2)}× the allowance; level ${peakIn(out, at - 600, 480).toFixed(3)} → ${peakIn(out, at + 50, 480).toFixed(3)}`);
}
{
  const fs = 48000, at = Math.round(0.3 * fs);
  const { out, bells } = ring(fs, 440, { seconds: 0.8, then: { at, fn: (b, off) => b.strike(0, 660, 1, 0.5, off) } });
  const allowed = maxStep(out, at - 2000, at - 10) + freshStep(fs, 660), across = maxStep(out, at - 10, at + 300);
  const old = measurePitch(out.slice(at + Math.round(0.12 * fs)), fs, 440, 1 << 17); // after the 100 ms fade
  report(bells.activeVoices() === 1 && across <= allowed * 1.15 && Boolean(old.error),
    'retuning a ringing stone: old ring crossfades out (100 ms), new pitch takes over',
    `step during the change ${(across / allowed).toFixed(2)}× the allowance; 440 Hz after the fade: ${old.error ? 'gone' : 'still there'}`);
}

// ---- 5. The tick sounds the same at any sample rate --------------------------------
console.log('\n5. Tick tone is sample-rate independent');
{
  // A low bell keeps its partials under 400 Hz, so energy from 1 to 16 kHz is
  // the tick; compare it to the fundamental across rates.
  const tickRatio = (fs) => {
    // Centre the analysis window on the strike (the tick is its first 4 ms).
    const len = Math.round(0.05 * fs), { out } = ring(fs, 55, { seconds: 0.05 });
    const centred = new Float64Array(2 * len);
    centred.set(out, len);
    const size = 1 << 15, mag = spectrum(centred, size), bin = fs / size;
    let tick = 0, fund = 0;
    for (let i = 1; i < size / 2; i++) {
      const f = i * bin, e = mag[i] * mag[i];
      if (f > 1000 && f < 16000) tick += e;
      if (Math.abs(cents(f, 55)) < 100) fund += e;
    }
    return 10 * Math.log10(tick / fund);
  };
  const r441 = tickRatio(44100), r48 = tickRatio(48000), r192 = tickRatio(192000);
  const spread = Math.max(r48, r441, r192) - Math.min(r48, r441, r192);
  report(spread < 2, 'tick level (1–16 kHz) relative to the bell at 44.1 / 48 / 192 kHz',
    `${r441.toFixed(1)} / ${r48.toFixed(1)} / ${r192.toFixed(1)} dB`);
}

// ---- 6. Quiet strikes, bad input, bursts ------------------------------------------
console.log('\n6. Quiet strikes, bad input and bursts');
{
  const b = new Bells({ sampleRate: 48000 });
  b.strike(0, 440, 0.01, 0.5, 0); b.strike(1, 440, 0, 0.5, 0); b.strike(2, NaN, 1, 0.5, 0);
  b.strike(3, 440, 1, NaN, 0); b.strike(-1, 440, 1, 0.5, 0); b.strike(MAX_STONES, 440, 1, 0.5, 0);
  b.strike(4, 1e-9, 1, 0.5, 0); b.strike(5, 30000, 1, 0.5, 0);
  report(b.activeVoices() === 0 && b.skipped === 8, 'too quiet, NaN, out-of-range stone or pitch: ignored', `skipped ${b.skipped}`);

  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < 400; i++) b.strike(i % MAX_STONES, 100 + (i % MAX_STONES) * 13, 1, (i % 10) / 9, i % 128);
  b.render(L, R, 128);
  const finite = L.every(Number.isFinite) && R.every(Number.isFinite);
  const peak = Math.max(...L.map(Math.abs), ...R.map(Math.abs));
  report(finite && b.activeVoices() === MAX_STONES, `400 strikes on all ${MAX_STONES} stones in one block`,
    `${b.activeVoices()} ringing, ${b.restruck} re-strikes, peak ${peak.toFixed(3)}`);

  const c = new Bells({ sampleRate: 48000 });
  c.strike(0, 440, 1, 0.5, 0);
  c.re[2] = NaN; // a broken partial must not silence everything
  for (let k = 0; k < 4; k++) { L.fill(0); R.fill(0); c.render(L, R, 128); }
  c.strike(1, 330, 1, 0.5, 0);
  L.fill(0); R.fill(0); c.render(L, R, 128);
  report(!c.active[0] && L.some((v) => v !== 0), 'a NaN in one ring releases it; other stones still sound');
}

// ---- 7. The whole instrument ------------------------------------------------------
const PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
// Instrument checks run at the calibration baseline (reference tempo, splash
// off), not the player-facing defaults; checks about a knob set it themselves.
function makeInstrument(fs = 48000, seed = 1, pitches = PENTA) {
  const inst = new Instrument({ sampleRate: fs, seed });
  inst.setParam('waveSpeed', 64); inst.setParam('decay', 8); inst.setParam('splash', 0);
  const { xs, ys } = stonePositions(pitches.length);
  inst.engine.setStones(xs, ys, pitches.map((p) => p.hz), pitches.length);
  return inst;
}
function play(inst, seconds, block = 128, gestures = (e) => { e.drop(0.5, 0.5, 1, 0.05); e.drop(0.2, 0.7, 1.5, 0.8); }) {
  gestures(inst.engine);
  const n = Math.round(seconds * inst.fs);
  const L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(block), br = new Float32Array(block);
  for (let pos = 0; pos < n; pos += block) {
    const m = Math.min(block, n - pos);
    inst.process(bl, br, m);
    L.set(bl.subarray(0, m), pos); R.set(br.subarray(0, m), pos);
  }
  return { L, R };
}
console.log('\n7. Whole instrument: water → stones → bells');
{
  const { L, R } = play(makeInstrument(), 4);
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  report(L.every(Number.isFinite) && peak > 0.05 && peak < 0.95, 'two drops make sound, below the limiter', `peak ${peak.toFixed(3)}`);

  const ref = play(makeInstrument(), 2).L;
  const bad = [1, 37, 1000].filter((block) => {
    const out = play(makeInstrument(), 2, block).L;
    for (let i = 0; i < ref.length; i++) if (out[i] !== ref[i]) return true;
    return false;
  });
  report(bad.length === 0, 'audio bit-identical at block sizes 1, 37, 128, 1000', bad.length ? `differs at ${bad.join(', ')}` : '');
  report(play(makeInstrument(), 0.5, 128, () => {}).L.every((v) => v === 0), 'no gestures → exact silence');

  // Many stones ring at once now; the level must stay out of the limiter.
  const chromatic = buildPitches({ scale: SCALES.chromatic, root: 60, low: 36, high: 96 });
  const dense = new Instrument({ seed: 2 });
  const pos = stonePositions(chromatic.length);
  dense.setStones(pos.xs, pos.ys, chromatic.map((p) => p.hz), chromatic.length);
  const { L: dl } = play(dense, 6, 128, (e) => { for (let i = 0; i < 12; i++) e.drop((i * 0.37) % 1, (i * 0.59) % 1, 1.5, i * 0.4); });
  const hot = dl.filter((v) => Math.abs(v) > 0.8).length / dl.length;
  report(hot < 0.01, `61 chromatic stones, a drop every 0.4 s: under 1% of samples in the limiter`, `${(hot * 100).toFixed(3)}%`);

  const decayInst = makeInstrument();
  const { L: before } = play(decayInst, 0.5, 128, (e) => e.drop(0.5, 0.5, 1, 0.01));
  decayInst.setParam('bellDecay', 0.2);
  const { L: after } = play(decayInst, 0.8, 128, () => {});
  report(decayInst.bells.activeVoices() === 0, 'bell decay knob also applies to stones already ringing',
    `still ringing 0.8 s after setting decay to 0.2 s: ${decayInst.bells.activeVoices()}`);

  const inst = makeInstrument();
  for (const v of [NaN, Infinity, -1e9]) for (let i = -1; i <= PARAM_KEYS.length; i++) inst.setParamIndex(i, v);
  inst.setParamIndex(1.5, 1);
  report(play(inst, 1).L.every(Number.isFinite), 'bad parameter indices and values are ignored');
}

{
  // Visuals frame: heights of the water, and flashes only for audible strikes.
  const inst = makeInstrument();
  const frame = new Float32Array(frameLength(128 * 97));
  play(inst, 0.6, 128, (e) => e.drop(0.5, 0.5, 1, 0.02));
  report(frame.length === inst.frameSize(), 'visuals frame size agrees with the water');
  inst.prepareFrame();
  inst.writeFrame(frame);
  const heights = frame.subarray(FRAME_HEIGHTS);
  const flashes = Array.from(frame.subarray(FRAME_FLASH, FRAME_FLASH + PENTA.length));
  const moving = heights.some((h) => Math.abs(h) > 1e-3) && heights.every(Number.isFinite);
  const lit = flashes.filter((f) => f > 0);
  const energy = frame[0], outPeak = frame[1];
  inst.writeFrame(frame);
  const cleared = Array.from(frame.subarray(FRAME_FLASH, FRAME_FLASH + PENTA.length)).every((f) => f === 0 || f >= 0.02);
  report(moving && lit.length > 0 && lit.every((f) => f >= 0.02) && cleared && outPeak > 0 && energy > 0,
    'visuals frame: water heights, and flashes only for audible strikes (reset each frame)',
    `${lit.length} stones lit, energy ${energy.toExponential(2)}, output peak ${outPeak.toFixed(3)}`);
}

{
  // Gain changes glide: no click when the volume moves or the stone count changes.
  // Second difference spikes are what a click looks like.
  const clickAt = (change) => {
    const inst = makeInstrument();
    inst.engine.setStones([0.5], [0.5], [220], 1);
    const fs = 48000, L = new Float32Array(128), R = new Float32Array(128), out = [];
    inst.bells.strike(0, 220, 1, 0.5, 0);
    for (let b = 0; b < 40; b++) {
      if (b === 20) change(inst);
      inst.process(L, R, 128);
      out.push(...L);
    }
    let atChange = 0, elsewhere = 0;
    for (let i = 2; i < out.length; i++) {
      const d2 = Math.abs(out[i] - 2 * out[i - 1] + out[i - 2]);
      if (i >= 20 * 128 - 2 && i <= 20 * 128 + 2) atChange = Math.max(atChange, d2); else elsewhere = Math.max(elsewhere, d2);
    }
    return atChange / elsewhere;
  };
  const vol = clickAt((inst) => inst.setParam('volume', 0.1));
  const count = clickAt((inst) => inst.bells.setStoneCount(128));
  // Transposing a busy chromatic range mid-phrase retunes every ringing stone at once.
  const many = buildPitches({ scale: SCALES.chromatic, root: 60, low: 36, high: 96 });
  const busyRetune = new Instrument({ seed: 4 });
  const pos = stonePositions(many.length);
  busyRetune.setStones(pos.xs, pos.ys, many.map((p) => p.hz), many.length);
  busyRetune.setParam('threshold', 0.005);
  play(busyRetune, 2, 128, (e) => { for (let i = 0; i < 12; i++) e.drop((i * 0.37) % 1, (i * 0.59) % 1, 1.5, i * 0.15); });
  busyRetune.setStones(pos.xs, pos.ys, many.map((p) => p.hz * Math.pow(2, 1 / 12)), many.length);
  play(busyRetune, 1, 128, (e) => { for (let i = 0; i < 6; i++) e.drop((i * 0.41) % 1, (i * 0.23) % 1, 1.5); });
  report(busyRetune.bells.fadeReuses === 0, 'transposing 61 ringing stones mid-phrase: no fade cut short',
    `fade slots reused while fading: ${busyRetune.bells.fadeReuses}`);

  report(vol < 1.5 && count < 1.5, 'volume and stone-count gain changes glide (no click)',
    `step at the change vs elsewhere: volume ${vol.toFixed(2)}×, stone count ${count.toFixed(2)}×`);

  // A burst of bell-decay events costs one recompute per block, not one per event.
  const busy = new Bells({ sampleRate: 48000 });
  for (let s = 0; s < MAX_STONES; s++) busy.strike(s, 60 + s * 15, 1, 0.5, 0);
  const t0 = performance.now();
  for (let k = 0; k < 200; k++) busy.setParam('bellDecay', 1 + (k % 5));
  const L = new Float32Array(128), R = new Float32Array(128);
  busy.render(L, R, 128);
  const ms = performance.now() - t0;
  report(ms < 2, '200 bell-decay changes in one block: one recompute', `${ms.toFixed(2)} ms for the block`);
}

// ---- 8. Page → audio thread: events, stones, end-to-end pitch ---------------------------
console.log('\n8. Event path and end-to-end pitch');
{
  const sab = createRingBuffer(8);
  const w = new RingWriter(sab), r = new RingReader(sab);
  const seen = [];
  let pushed = 0;
  while (w.push(EV_DROP, pushed)) pushed++;
  r.drain((d, o) => seen.push(d[o + 1]));
  for (let i = 0; i < 20; i++) { w.push(EV_DROP, 100 + i); if (i % 3 === 2) r.drain((d, o) => seen.push(d[o + 1])); }
  r.drain((d, o) => seen.push(d[o + 1]));
  const expected = [...Array(7).keys(), ...Array.from({ length: 20 }, (_, i) => 100 + i)];
  report(pushed === 7 && seen.length === expected.length && seen.every((v, i) => v === expected[i]), 'queue: FIFO order, full detection, wrap-around');
}
{
  // Send stones exactly as the page does, through the queue, into Instrument.handleEvent.
  const send = (inst, pitches, positions, { skip = -1 } = {}) => {
    const wr = new RingWriter(createRingBuffer(1024)), rd = new RingReader(wr.idx.buffer);
    pitches.forEach((hz, i) => { if (i !== skip) wr.push(EV_STONE, i, positions.xs[i], positions.ys[i], hz); });
    wr.push(EV_STONES_COMMIT, pitches.length);
    rd.drain((d, o) => inst.handleEvent(d, o));
  };
  const inst = new Instrument();
  const pitches = buildPitches({ scale: SCALES.chromatic, root: 60, low: 0, high: 127 }).map((p) => p.hz);
  send(inst, pitches, stonePositions(pitches.length));
  const worst = Math.max(...pitches.map((hz, i) => Math.abs(cents(inst.engine.stones.hz[i], hz))));
  report(inst.engine.stones.count === 128 && worst < 0.01, `all 128 stones + commit fit the page's queue; pitch after transport within ${worst.toFixed(5)}¢`);

  const partial = new Instrument();
  send(partial, pitches.slice(0, 10), stonePositions(10), { skip: 4 });
  report(partial.engine.stones.count === 0 && partial.rejectedCommits === 1, 'a commit with a missing stone is rejected (no half-delivered retune)');

  // End to end: one stone, sent through the queue, struck by the water, measured.
  const cases = [
    ['A4 at A=432', buildPitches({ scale: SCALES.chromatic, root: 60, low: 69, high: 69, reference: REFERENCES.a432 })[0].hz],
    ['Rast E−50¢ on D', buildPitches({ scale: SCALES.rast, root: 62, low: 65, high: 66 })[0].hz],
  ];
  for (const fs of [44100, 48000, 96000]) {
    const results = cases.map(([name, hz]) => {
      const e2e = new Instrument({ sampleRate: fs, seed: 3 });
      send(e2e, [hz], { xs: [0.5], ys: [0.5] });
      const { L, R } = play(e2e, 3, 128, (e) => e.drop(0.46, 0.5, 1, 0.02));
      const mono = new Float64Array(L.length);
      for (let i = 0; i < L.length; i++) mono[i] = L[i] + R[i];
      const m = measurePitch(mono, fs, hz, fs > 60000 ? 1 << 20 : 1 << 19);
      if (m.error) return { bad: true, text: `${name}: ${m.error}` };
      return { err: cents(m.hz, hz), text: `${name} ${cents(m.hz, hz).toFixed(2)}¢` };
    });
    report(results.every((r) => !r.bad && Math.abs(r.err) < 2), `${fs / 1000} kHz: stone sent through the queue, struck by a drop, measured`, results.map((r) => r.text).join(', '));
  }
}

// ---- 9. CPU --------------------------------------------------------------------------
console.log('\n9. CPU per 128-sample block at 48 kHz (budget 2667 µs)');
{
  const inst = makeInstrument();
  inst.setParam('threshold', 0.005);
  inst.setParam('splash', 0.6);
  const L = new Float32Array(128), R = new Float32Array(128);
  let i = 0;
  const drive = () => { if (i % 20 === 0) inst.engine.drop((i * 0.13) % 1, (i * 0.29) % 1, 2); i++; };
  for (let k = 0; k < 500; k++) { drive(); inst.process(L, R, 128); }
  const blocks = 3000;
  let ringing = 0;
  const t0 = performance.now();
  for (let k = 0; k < blocks; k++) { drive(); inst.process(L, R, 128); ringing += inst.bells.activeVoices(); }
  const us = ((performance.now() - t0) * 1000) / blocks, pct = (us / 2667) * 100;
  report(pct < 30, `busy playing (avg ${(ringing / blocks).toFixed(1)} stones ringing): ${us.toFixed(0)} µs/block, ${pct.toFixed(1)}%`, 'limit 30%');

  const b = new Bells({ sampleRate: 48000 });
  for (let s = 0; s < MAX_STONES; s++) b.strike(s, 60 + s * 15, 1, 0.5, 0);
  for (let k = 0; k < 50; k++) { L.fill(0); R.fill(0); b.render(L, R, 128); }
  const t1 = performance.now();
  for (let k = 0; k < 2000; k++) { L.fill(0); R.fill(0); b.render(L, R, 128); }
  const us2 = ((performance.now() - t1) * 1000) / 2000;
  report(us2 / 2667 < 0.3, `all ${MAX_STONES} stones ringing: ${us2.toFixed(0)} µs/block, ${((us2 / 2667) * 100).toFixed(1)}%`, 'limit 30%');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll bell checks passed.');
process.exit(failures ? 1 : 0);
