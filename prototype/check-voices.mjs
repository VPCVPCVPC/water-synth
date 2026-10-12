// check-voices.mjs — checks for the voice editor's sound engine: the synth
// layer, how a strike shapes the sound, per-stone overrides, water-held
// sustain, and edits reaching stones that are already ringing.
//   node check-voices.mjs

import { Bells, COEF_EVERY } from './bells.js';
import { Instrument } from './instrument.js';
import { VOICE_PARAMS, VOICE_KEYS, VOICE_SIZE, SHARED } from './voice.js';
import { MAX_STONES } from './stones.js';
import { buildPitches, SCALES, REFERENCES } from './tuning.js';
import { stonePositions } from './layout.js';
import { EV_VOICE, EV_VOICE_OVERRIDE } from './ring.js';
import { cents, spectrum, measurePitch, fftSize } from './check-lib.mjs';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const db = (x) => 20 * Math.log10(x);
const vi = (k) => VOICE_KEYS.indexOf(k);

// The synth layer alone, filter wide open and still: what the oscillators make.
const SYNTH_ONLY = { bellLevel: 0, tick: 0, synthLevel: 1, cutoff: 7, filterEnv: 0, resonance: 0, synthDecay: 12 };

// Ring one stone with the shared voice set to `voice`; mono output.
// `wet(t)` (seconds → 0..1) drives water-held sustain every 4 ms, as the
// instrument does; `then` strikes again at sample then.at.
function ring(fs, hz, voice = {}, { velocity = 1, seconds = 1, then, wet, edit } = {}) {
  const b = new Bells({ sampleRate: fs });
  for (const [k, v] of Object.entries(voice)) b.setParam(k, v);
  const n = Math.round(seconds * fs), block = Math.round(0.004 * fs);
  const L = new Float32Array(block), R = new Float32Array(block), out = new Float64Array(n);
  const stones = { wet: () => (wet ? wet(pos / fs) : 0) };
  let pos = 0;
  b.strike(0, hz, velocity, 0.5, 0);
  for (; pos < n; pos += block) {
    const m = Math.min(block, n - pos);
    L.fill(0); R.fill(0);
    if (edit && pos <= edit.at && edit.at < pos + m) edit.fn(b);
    b.applyPending();
    if (then && pos <= then.at && then.at < pos + m) {
      b.renderRange(L, R, 0, then.at - pos);
      then.fn(b, then.at - pos);
      b.renderRange(L, R, then.at - pos, m);
    } else {
      b.renderRange(L, R, 0, m);
    }
    b.endBlock(L, R, m);
    b.updateHold(stones);
    for (let i = 0; i < m; i++) out[pos + i] = L[i] + R[i];
  }
  return { out, bells: b };
}

const rmsAt = (x, fs, t, win = 0.05) => {
  const a = Math.round(t * fs), n = Math.round(win * fs);
  let s = 0;
  for (let i = a; i < a + n && i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
};
// Energy-weighted mean frequency: a brightness measure.
function centroid(x, fs, from = 0, seconds = 0.3) {
  const a = Math.round(from * fs), seg = x.slice(a, a + Math.round(seconds * fs));
  const size = 1 << 15, mag = spectrum(seg, size), bin = fs / size;
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) { const e = mag[i] * mag[i]; num += e * i * bin; den += e; }
  return num / den;
}
// Brightness just after the strike (first 0.1 s, tick and all): energy above
// `above` × the fundamental relative to the fundamental's, in dB.
function upper(x, fs, hz, above) {
  const size = 1 << 15, mag = spectrum(x.slice(0, Math.round(0.1 * fs)), size), bin = fs / size;
  let hi = 0, fund = 0;
  for (let i = 1; i < mag.length; i++) {
    const f = i * bin, e = mag[i] * mag[i];
    if (f > above * hz) hi += e; else if (Math.abs(cents(f, hz)) < 100) fund += e;
  }
  return 10 * Math.log10(hi / fund);
}
// Energy within ±50 cents of `hz`.
function bandEnergy(x, fs, hz, size = 1 << 16) {
  const mag = spectrum(x, size), bin = fs / size;
  let e = 0;
  for (let i = 1; i < mag.length; i++) if (Math.abs(cents(i * bin, hz)) < 50) e += mag[i] * mag[i];
  return e;
}
const maxStep = (x, from, to) => {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const maxD2 = (x, from, to) => {
  let m = 0;
  for (let i = Math.max(2, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]));
  return m;
};

// ---- 1. The synth layer is in tune ---------------------------------------------------
console.log('\n1. Synth layer pitch (FFT, within 2 cents)');
const one = (opts) => buildPitches({ scale: SCALES.chromatic, root: 60, ...opts })[0];
const TARGETS = [
  ['C2', one({ low: 36, high: 36 }).hz],
  ['A4', one({ low: 69, high: 69 }).hz],
  ['A4 at A=432', one({ low: 69, high: 69, reference: REFERENCES.a432 }).hz],
  ['Rast E−50¢', buildPitches({ scale: SCALES.rast, root: 60, low: 63, high: 64 })[0].hz],
  ['C6', one({ low: 84, high: 84 }).hz],
];
for (const fs of [44100, 48000, 192000]) {
  const results = [];
  for (const [shape, sname] of [[0, 'sine'], [2, 'saw'], [3, 'square']]) {
    for (const [name, hz] of TARGETS) {
      const m = measurePitch(ring(fs, hz, { ...SYNTH_ONLY, osc1Shape: shape, oscMix: 0 }, { seconds: 1.5 }).out, fs, hz, fftSize(fs));
      results.push(m.error ? { bad: true, text: `${sname} ${name}: ${m.error}` } : { err: cents(m.hz, hz), text: `${sname} ${name}` });
    }
  }
  const worst = Math.max(...results.filter((r) => !r.bad).map((r) => Math.abs(r.err)));
  report(results.every((r) => !r.bad && Math.abs(r.err) < 2), `${fs / 1000} kHz: sine, saw, square on 5 pitches`,
    results.some((r) => r.bad) ? results.filter((r) => r.bad).map((r) => r.text).join('; ') : `worst ${worst.toFixed(3)}¢`);
}
{
  const fs = 48000, hz = 220, target = hz * Math.pow(2, 7.25 / 12);
  const m = measurePitch(ring(fs, hz, { ...SYNTH_ONLY, oscMix: 1, osc2Pitch: 7, osc2Detune: 25, osc2Shape: 0 }, { seconds: 1.5 }).out, fs, target, fftSize(fs));
  report(!m.error && Math.abs(cents(m.hz, target)) < 2, 'osc 2 at +7 semitones +25 cents', m.error || `${cents(m.hz, target).toFixed(3)}¢`);
}

// ---- 2. Band-limited oscillators ------------------------------------------------------
console.log('\n2. Oscillators are band-limited (energy between the harmonics)');
// The pitch matters, and 1760 Hz flattered polyBLEP: at 44.1 kHz / 1760 = 25.0
// the folded-back partials land almost exactly on real harmonics, so they were
// counted as harmonics. fs/hz = 25.5 (1729.4 Hz) puts them a quarter tone off,
// where they can only be counted as aliasing; fs/hz = 12.5 (3528 Hz) is the
// worst of the two for this metric and has ~4 dB of margin against the gate —
// that residual is genuine polyBLEP at C7-ish pitches, not the measurement.
// What the metric is matters: it counts anything ≥30 cents from a harmonic as
// aliasing, so at low pitches the analysis window's own leakage lands in the
// bucket (with this 0.8 s window a saw at 110 Hz reads −27.3 dB, while the
// same note over 4 s reads −58.3 dB). The gate below is therefore meaningful
// above ≈200 Hz, where the stones normally live. A reference ideal saw,
// band-limited by construction to 0.45 × fs, scores −88 dB (fs/25.5) and
// −103 dB (fs/12.5) through the identical measurement, which is printed with
// each case: the floor here is far below the gate, so the oscillator's own
// score is the oscillator's.
const idealSaw = (hz, rate, seconds) => {
  const n = Math.round(seconds * rate), x = new Float64Array(n);
  for (let h = 1; h * hz < 0.45 * rate; h++) {
    const a = 1 / h, w = (2 * Math.PI * h * hz) / rate;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin(w * i);
  }
  return x;
};
const aliasScore = (x, hz, rate, from) => {
  const size = 1 << 16, mag = spectrum(x.slice(from), size), bin = rate / size;
  let harm = 0, alias = 0;
  for (let i = 1; i < mag.length; i++) {
    const f = i * bin, e = mag[i] * mag[i], h = Math.round(f / hz);
    if (h >= 1 && Math.abs(cents(f, h * hz)) < 30) harm += e; else if (f > 100) alias += e;
  }
  return 10 * Math.log10(alias / harm);
};
for (const [shape, name] of [[2, 'saw'], [3, 'square']]) {
  const fs = 44100;
  for (const div of [25.5, 12.5]) {
    const hz = fs / div;
    const { out } = ring(fs, hz, { ...SYNTH_ONLY, osc1Shape: shape, oscMix: 0 }, { seconds: 0.8 });
    const r = aliasScore(out, hz, fs, Math.round(0.05 * fs));
    const floor = aliasScore(idealSaw(hz, fs, 0.8), hz, fs, Math.round(0.05 * fs));
    report(r < -25 && floor < -60, `${name} at ${hz.toFixed(1)} Hz (fs/hz = ${div}), 44.1 kHz: aliasing`,
      `${r.toFixed(1)} dB re the harmonics, limit −25 (an ideal saw through the same measurement: ${floor.toFixed(1)} dB)`);
  }
}
{
  const fs = 44100, b = new Bells({ sampleRate: fs });
  for (const [k, v] of Object.entries({ ...SYNTH_ONLY, osc2Pitch: 24, oscMix: 1 })) b.setParam(k, v);
  b.strike(0, 6000, 1, 0.5, 0); // osc 2 two octaves up would be 24 kHz: above 0.45 × fs, so it's dropped
  const L = new Float32Array(4410), R = new Float32Array(4410);
  b.render(L, R, 4410);
  report(L.every((v) => v === 0) && b.inc2[0] === 0, 'an oscillator above 0.45 × sample rate is dropped, not aliased');
}

// ---- 3. No note-off: the synth layer falls silent on its own ----------------------------
console.log('\n3. Envelopes: attack, decay, and no note-off');
{
  const fs = 48000;
  for (const decay of [0.5, 2]) {
    const { out, bells } = ring(fs, 220, { ...SYNTH_ONLY, synthDecay: decay }, { seconds: decay * 1.6 + 0.3 });
    const start = rmsAt(out, fs, 0.05, 0.02);
    let t60 = NaN;
    for (let t = 0.05; t < decay * 1.6; t += 0.005) if (rmsAt(out, fs, t, 0.02) < start / 1000) { t60 = t - 0.05; break; }
    report(Math.abs(t60 / decay - 1) < 0.1 && bells.activeVoices() === 0, `synth decay ${decay} s`,
      `T60 ${t60.toFixed(2)} s; still ringing: ${bells.activeVoices()}`);
  }
  const { out } = ring(fs, 220, { ...SYNTH_ONLY, attack: 0.2, synthDecay: 4 }, { seconds: 0.6 });
  let peakT = 0, peak = 0;
  for (let t = 0; t < 0.5; t += 0.005) { const r = rmsAt(out, fs, t, 0.01); if (r > peak) { peak = r; peakT = t + 0.005; } }
  report(Math.abs(peakT - 0.2) < 0.03 && Math.abs(out[0]) < 1e-3, 'attack 0.2 s: rises from silence, peaks at 0.2 s', `peak at ${peakT.toFixed(3)} s`);
}
{
  // Re-strike: adds to the ringing layer (louder), without a click.
  const fs = 48000, at = Math.round(0.3 * fs);
  // As for the bell: the biggest sample-to-sample step across the re-strike
  // may be at most the ring's own steps plus a fresh strike's onset.
  const voice = { ...SYNTH_ONLY, oscMix: 0, osc1Shape: 0 };
  const { out, bells } = ring(fs, 220, voice, { seconds: 0.6, then: { at, fn: (b, off) => b.strike(0, 220, 1, 0.5, off) } });
  const fresh = ring(fs, 220, voice, { seconds: 0.02 }).out;
  const before = rmsAt(out, fs, 0.25), after = rmsAt(out, fs, 0.32);
  const allowed = maxStep(out, at - 2000, at - 10) + maxStep(fresh, 1, 400), across = maxStep(out, at - 10, at + 400);
  report(bells.activeVoices() === 1 && bells.restruck === 1 && after > before * 1.3 && across <= allowed * 1.15,
    're-striking adds to the ringing synth layer (one voice, no jump)',
    `level ${before.toFixed(3)} → ${after.toFixed(3)}; step across the re-strike ${(across / allowed).toFixed(2)}× the allowance`);
}
{
  // Retune with the synth layer ringing: the old pitch fades out with the bell.
  const fs = 48000, at = Math.round(0.3 * fs);
  const { out, bells } = ring(fs, 440, { synthLevel: 1, synthDecay: 6 }, { seconds: 0.9, then: { at, fn: (b, off) => b.strike(0, 660, 1, 0.5, off) } });
  const old = bandEnergy(out.slice(at + Math.round(0.12 * fs)), fs, 440), now = bandEnergy(out.slice(at + Math.round(0.12 * fs)), fs, 660);
  report(bells.activeVoices() === 1 && old < now * 1e-4, 'retuning: the old pitch (bell and synth) is gone after the 100 ms fade',
    `440 Hz ${(10 * Math.log10(old / now)).toFixed(1)} dB re 660 Hz`);
}

// ---- 4. How hard the water strikes shapes loudness and brightness ----------------------
console.log('\n4. Strike strength → loudness and brightness');
// The bell's top partials (×4.07, ×5.4) brighten most; the synth's filter
// opens over its upper harmonics.
for (const [voice, name, above] of [[{}, 'bell', 3.5], [{ bellLevel: 0, tick: 0, synthLevel: 1 }, 'synth layer', 8]]) {
  const fs = 48000;
  const hard = ring(fs, 220, voice, { velocity: 1, seconds: 0.5 }).out, soft = ring(fs, 220, voice, { velocity: 0.2, seconds: 0.5 }).out;
  const dl = db(rmsAt(hard, fs, 0.01, 0.2) / rmsAt(soft, fs, 0.01, 0.2)), bright = upper(hard, fs, 220, above) - upper(soft, fs, 220, above);
  report(dl > 18 && dl < 30 && bright > 3, `${name}: a hard strike is louder and brighter`,
    `+${dl.toFixed(1)} dB; upper partials +${bright.toFixed(1)} dB relative to the fundamental`);
  const flat = { ...voice, dynamics: 0, strikeBright: 0 };
  const h2 = ring(fs, 220, flat, { velocity: 1, seconds: 0.5 }).out, s2 = ring(fs, 220, flat, { velocity: 0.2, seconds: 0.5 }).out;
  const dl2 = db(rmsAt(h2, fs, 0.01, 0.2) / rmsAt(s2, fs, 0.01, 0.2)), b2 = upper(h2, fs, 220, above) - upper(s2, fs, 220, above);
  report(Math.abs(dl2) < 0.1 && Math.abs(b2) < 0.1, `${name}: dynamics 0 and strike brightness 0 make every strike the same`,
    `${dl2.toFixed(2)} dB; upper partials ${b2.toFixed(2)} dB`);
}
{
  const fs = 48000;
  const bell = rmsAt(ring(fs, 220, {}, { seconds: 1 }).out, fs, 0, 1);
  const synth = rmsAt(ring(fs, 220, { bellLevel: 0, tick: 0, synthLevel: 1 }, { seconds: 1 }).out, fs, 0, 1);
  report(Math.abs(db(synth / bell)) < 6, 'synth layer at level 1 sits near the bell\'s loudness', `${db(synth / bell).toFixed(1)} dB re the bell (first second)`);
  const { out } = ring(fs, 220, { bellLevel: 0, tick: 0, synthLevel: 1, osc1Shape: 2, oscMix: 0, filterEnv: 0, cutoff: 1 },
    { seconds: 0.8, edit: { at: Math.round(0.4 * fs), fn: (b) => b.setParam('cutoff', 6) } });
  const before = centroid(out, fs, 0.2, 0.15), after = centroid(out, fs, 0.5, 0.15);
  report(after > before * 1.5, 'a voice edit reaches a stone already ringing (cutoff opened mid-note)', `centroid ${before.toFixed(0)} → ${after.toFixed(0)} Hz`);
}

// ---- 4b. Knobs and the filter sweep glide, never step ---------------------------------
console.log('\n4b. Moving a knob, and the filter sweeping, while a note rings');
{
  const fs = 48000;
  // A control-rate step (the voice's targets are read every COEF_EVERY
  // samples) lands on one phase of that grid, so binning the output's second
  // difference by its phase and comparing the worst phase's RMS with the mean
  // of the phases isolates it. (An earlier version compared the worst sample at
  // a refresh with the worst sample elsewhere, which the waveform's own
  // curvature on the same 16-sample rhythm pinned near 1.0 whether or not the
  // glide existed — it passed with the glide switched off. This one does not,
  // on the one voice below where the filter's smoothing does not dilute it.)
  const stepiness = (x, from, to) => {
    const sums = new Float64Array(COEF_EVERY), counts = new Float64Array(COEF_EVERY);
    for (let i = Math.max(2, from); i < to; i++) {
      const d2 = x[i] - 2 * x[i - 1] + x[i - 2], ph = i % COEF_EVERY;
      sums[ph] += d2 * d2; counts[ph]++;
    }
    let worst = 0, mean = 0, n = 0;
    for (let p = 0; p < COEF_EVERY; p++) {
      if (counts[p] === 0) continue;
      const r = Math.sqrt(sums[p] / counts[p]);
      if (r > worst) worst = r;
      mean += r; n++;
    }
    return worst / (mean / n);
  };
  // A sine is smooth, so a spike is the voice's, not the oscillator's. The
  // second oscillator sits a fifth above, where a mix change moves the signal
  // a long way at once.
  const MIX = { ...SYNTH_ONLY, osc1Shape: 0, osc2Shape: 0, osc2Pitch: 7, oscMix: 0 };
  const SINE = { ...SYNTH_ONLY, osc1Shape: 0, osc2Shape: 0, osc2Pitch: 12, oscMix: 0.5 };

  // The one audible-domain case: the pitch is chosen so the filter's cutoff
  // (2^7 above the stone) sits at the Nyquist guard and barely smooths the
  // step. On a 220 Hz voice the filter's own smoothing dilutes the artifact
  // into the waveform's curvature and the ratio sits near 1 either way, and at
  // 55 Hz it reaches only 2.58 when snapped — under the limit, so it is not
  // decisive there. Measured at 169 Hz: 1.43 with the glide, 4.54 with the
  // glide switched off (`bell.glide = 1` reproduces the old control-rate
  // snap), so a limit of 3 is decisive either way.
  {
    const at = Math.round(0.3 * fs);
    const { out } = ring(fs, 169, MIX, { seconds: 0.6, edit: { at, fn: (b) => b.setParam('oscMix', 1) } });
    const r = stepiness(out, at - 240, at + 4800);
    report(r < 3, 'oscillator mix: jumped while a stone rings', `worst phase ${r.toFixed(2)}× the mean of the phases (1.43 gliding, 4.54 snapped)`);
  }
  // The glides themselves, where the effect is unambiguous: the running value
  // must never make a large fraction of its move in one sample. A jump lands
  // the whole move in one sample (100%); the glide spreads it over ~1 ms
  // (≈2%). This covers the knobs the signal metric above cannot see — the
  // filter smooths a level or cutoff step, so the artifact sits under the
  // waveform's own curvature — and it is the property the check is about.
  const FIELD = { synthLevel: 'sLvlCur', oscMix: 'mixCur', cutoff: 'gCur', resonance: 'kCur' };
  for (const [key, from, to] of [
    ['synthLevel', 0.2, 1.2], ['oscMix', 0, 1], ['cutoff', 1, 6], ['resonance', 0, 0.85],
  ]) {
    const b = new Bells({ sampleRate: fs });
    for (const [k, v] of Object.entries({ ...SINE, [key]: from })) b.setParam(k, v);
    b.strike(0, 220, 1, 0.5, 0);
    const L = new Float32Array(1), R = new Float32Array(1);
    const step = () => { L[0] = 0; R[0] = 0; b.render(L, R, 1); };
    for (let i = 0; i < Math.round(0.3 * fs); i++) step();
    const field = FIELD[key], start = b[field][0];
    b.setParam(key, to);
    let worst = 0, prev = start;
    for (let i = 0; i < Math.round(0.05 * fs); i++) {
      step();
      const now = b[field][0], d = Math.abs(now - prev);
      if (d > worst) worst = d;
      prev = now;
    }
    const ratio = Math.abs(prev - start) > 0 ? worst / Math.abs(prev - start) : 0;
    report(Math.abs(prev - start) > 0 && ratio < 0.1, `${key}: its running value moves per sample, never in one step`,
      `moved ${(prev - start).toExponential(2)}, worst one-sample move ${(ratio * 100).toFixed(2)}% of the whole move`);
  }
  // The filter's own sweep after a strike, at its fastest (T60 20 ms), by the
  // same trajectory test: the sweep must be spread out, not taken in steps.
  // The first sample is skipped: a fresh layer starts at its target (the
  // strike really does open the filter at once); it is the *closing* sweep,
  // where the envelope used to be stepped every COEF_EVERY samples, that is
  // under test.
  {
    const b = new Bells({ sampleRate: fs });
    for (const [k, v] of Object.entries({ ...SINE, cutoff: 0, filterEnv: 6, filterDecay: 0.02, synthDecay: 1 })) b.setParam(k, v);
    b.strike(0, 220, 1, 0.5, 0);
    const L = new Float32Array(1), R = new Float32Array(1);
    const step = () => { L[0] = 0; R[0] = 0; b.render(L, R, 1); };
    step();
    let worst = 0, prev = b.gCur[0], peak = prev, low = prev;
    for (let i = 0; i < Math.round(0.05 * fs); i++) {
      step();
      const now = b.gCur[0], d = Math.abs(now - prev);
      if (d > worst) worst = d;
      if (now > peak) peak = now;
      if (now < low) low = now;
      prev = now;
    }
    report(peak - low > 0 && worst / (peak - low) < 0.1, 'the filter\'s fastest strike sweep (T60 20 ms) moves per sample',
      `worst one-sample move ${((worst / (peak - low)) * 100).toFixed(2)}% of the sweep`);
  }
}

// ---- 5. One shared voice, any stone can have its own -----------------------------------
console.log('\n5. Shared voice and per-stone overrides (through the event path)');
{
  const fs = 48000, hz = 220;
  const send = (inst, ...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  // Stone 0 shared, stone 1 overridden to a synth layer; both at 220 Hz, struck alone.
  const render = (setup, stone) => {
    const inst = new Instrument({ sampleRate: fs });
    inst.setStones([0.3, 0.7], [0.5, 0.5], [hz, hz], 2);
    setup(inst);
    inst.bells.applyPending();
    inst.bells.strike(stone, hz, 1, 0.5, 0);
    const n = fs, L = new Float32Array(128), R = new Float32Array(128), out = new Float64Array(n);
    for (let p = 0; p < n; p += 128) { inst.process(L, R, 128); for (let i = 0; i < 128; i++) out[p + i] = L[i] + R[i]; }
    return { out, inst };
  };
  const sixth = (x) => 10 * Math.log10(bandEnergy(x, fs, 6 * hz) / bandEnergy(x, fs, hz)); // a saw has a 6th harmonic; the bell doesn't
  const synthOn = (inst) => {
    send(inst, EV_VOICE_OVERRIDE, 1, 1);
    send(inst, EV_VOICE, 1, vi('synthLevel'), 1);
    send(inst, EV_VOICE, 1, vi('bellLevel'), 0);
    send(inst, EV_VOICE, 1, vi('cutoff'), 7);
  };
  const shared = sixth(render(synthOn, 0).out), own = render(synthOn, 1);
  report(shared < -40 && sixth(own.out) > -25, 'an overridden stone plays its own voice; the others keep the shared one',
    `6th harmonic: shared stone ${shared.toFixed(1)} dB, overridden stone ${sixth(own.out).toFixed(1)} dB`);
  const vo = own.inst.bells.voices;
  report(vo.get(SHARED, 'synthLevel') === 0 && vo.get(1, 'synthLevel') === 1, 'editing an override leaves the shared voice alone');
  const back = sixth(render((inst) => { synthOn(inst); send(inst, EV_VOICE_OVERRIDE, 1, 0); }, 1).out);
  report(back < -40, 'switching the override off returns the stone to the shared voice', `6th harmonic ${back.toFixed(1)} dB`);

  const inst = new Instrument({ sampleRate: fs });
  send(inst, EV_VOICE, SHARED, vi('bellDecay'), 5);
  send(inst, EV_VOICE_OVERRIDE, 3, 1);
  send(inst, EV_VOICE, SHARED, vi('bellDecay'), 1);
  const copied = inst.bells.voices.get(3, 'bellDecay') === 5 && inst.bells.voices.get(SHARED, 'bellDecay') === 1;
  send(inst, EV_VOICE_OVERRIDE, 3, 0); send(inst, EV_VOICE_OVERRIDE, 3, 1);
  report(copied && inst.bells.voices.get(3, 'bellDecay') === 1, 'a new override starts as a copy of the shared voice as it is then');
  send(inst, EV_VOICE, 4, vi('bellDecay'), 7); // stone 4 has no override
  report(inst.bells.voices.get(4, 'bellDecay') === VOICE_PARAMS.bellDecay.def, 'editing a stone without an override does nothing');

  // A stone's override switched while it rings: it moves to the new voice.
  const r = render((i) => { send(i, EV_VOICE, SHARED, vi('bellDecay'), 8); }, 0);
  send(r.inst, EV_VOICE_OVERRIDE, 0, 1);
  send(r.inst, EV_VOICE, 0, vi('bellDecay'), 0.2);
  r.inst.bells.strike(0, hz, 1, 0.5, 0);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let k = 0; k < Math.round((1.2 * fs) / 128); k++) r.inst.process(L, R, 128);
  report(r.inst.bells.activeVoices() === 0, 'a ringing stone given its own (short) voice follows it', `still ringing: ${r.inst.bells.activeVoices()}`);
}

// ---- 6. Water-held sustain ----------------------------------------------------------
console.log('\n6. Water-held sustain: the water holds the note, never the player');
{
  const fs = 48000;
  const free = ring(fs, 220, { synthLevel: 1 }, { seconds: 2 }).out;
  const held = ring(fs, 220, { synthLevel: 1, hold: 1 }, { seconds: 2, wet: (t) => (t < 1 ? 1 : 0) }).out;
  const loss = (x) => db(rmsAt(x, fs, 0.05) / rmsAt(x, fs, 0.9));
  const lossFree = loss(free), lossHeld = loss(held);
  // After the water calms, the note decays at its normal rate.
  const slope = (x, a, b) => db(rmsAt(x, fs, a) / rmsAt(x, fs, b)) / (b - a);
  const after = slope(held, 1.2, 1.7), normal = slope(free, 0.2, 0.7);
  const d2 = maxD2(held, fs - 400, fs + 400) / maxD2(held, fs - 4000, fs - 400);
  report(lossHeld < lossFree / 5, 'moving water holds the note: decay slows', `lost ${lossFree.toFixed(1)} dB free vs ${lossHeld.toFixed(1)} dB held over 0.85 s`);
  report(Math.abs(after / normal - 1) < 0.15 && d2 < 1.5, 'as the water calms, the note decays at its own rate again (no click)',
    `${after.toFixed(1)} vs ${normal.toFixed(1)} dB/s; curvature at the release ${d2.toFixed(2)}×`);
  const off = ring(fs, 220, { synthLevel: 1, hold: 0 }, { seconds: 2, wet: () => 1 }).out;
  report(free.every((v, i) => v === off[i]), 'hold 0: moving water changes nothing');
}
// The whole instrument: a drop in calibration water, hold on vs off.
const PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
function makeInstrument(fs = 48000, voice = {}) {
  const inst = new Instrument({ sampleRate: fs, seed: 2 });
  inst.setParam('waveSpeed', 64); inst.setParam('decay', 8); inst.setParam('splash', 0);
  for (const [k, v] of Object.entries(voice)) inst.setParam(k, v);
  const { xs, ys } = stonePositions(PENTA.length);
  inst.setStones(xs, ys, PENTA.map((p) => p.hz), PENTA.length);
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
{
  const fs = 48000, HELD = { hold: 1, synthLevel: 1 };
  const a = play(makeInstrument(fs, { synthLevel: 1 }), 6).L, b = play(makeInstrument(fs, HELD), 6).L;
  const tail = (x) => rmsAt(x, fs, 3, 1);
  report(tail(b) > tail(a) * 1.5, 'in the instrument: notes last longer while the water keeps moving',
    `3–4 s level ${db(tail(b) / tail(a)).toFixed(1)} dB above hold off`);
  // Long voices, long water, hold full on: it still settles to exact silence.
  const inst = makeInstrument(fs, { ...HELD, bellDecay: 8, synthDecay: 12 });
  inst.setParam('decay', 30);
  const { L } = play(inst, 90, 128, (e) => { for (let k = 0; k < 6; k++) e.drop((k * 0.37) % 1, (k * 0.59) % 1, 2, 0.05 + k * 0.3); });
  const last = L.subarray(L.length - fs);
  report(last.every((v) => v === 0) && inst.bells.activeVoices() === 0, 'hold at full, longest decays: the water calms and every voice falls silent',
    `voices ringing at 90 s: ${inst.bells.activeVoices()}`);
}
{
  const HELD = { hold: 1, synthLevel: 1, resonance: 0.6, attack: 0.03 };
  const ref = play(makeInstrument(48000, HELD), 3).L;
  const bad = [1, 37, 1000].filter((block) => {
    const out = play(makeInstrument(48000, HELD), 3, block).L;
    for (let i = 0; i < ref.length; i++) if (out[i] !== ref[i]) return true;
    return false;
  });
  report(bad.length === 0, 'hold and synth layer: audio bit-identical at block sizes 1, 37, 128, 1000', bad.length ? `differs at ${bad.join(', ')}` : '');
  // Same envelope at any sample rate (50 ms windows above −60 dB).
  const env = (fs) => { const x = play(makeInstrument(fs, HELD), 3).L; return Array.from({ length: 58 }, (_, k) => rmsAt(x, fs, k * 0.05)); };
  const e48 = env(48000), e441 = env(44100), e96 = env(96000);
  const floor = Math.max(...e48) / 1000;
  let worst = 0;
  for (let k = 0; k < e48.length; k++) if (e48[k] > floor) worst = Math.max(worst, Math.abs(db(e441[k] / e48[k])), Math.abs(db(e96[k] / e48[k])));
  report(worst < 1, 'hold and synth layer: the same loudness over time at 44.1 / 48 / 96 kHz', `worst 50 ms window ${worst.toFixed(2)} dB apart`);
}
{
  // Repeated strikes while the water holds the note must not pile up in the
  // bell (the DSP review measured ≈+12 dB over 30 s of a looped drop). One
  // stone, water that never calms, a strike every 0.5 s for 30 s: the level
  // must settle instead of stacking. The level is sampled just before each
  // strike — the settled value, not a hit's transient — and compared between
  // the 5 s and 29 s windows.
  const fs = 48000, seconds = 30, block = 128, every = Math.round(0.5 * fs);
  const b = new Bells({ sampleRate: fs });
  b.setParam('hold', 1); b.setParam('bellDecay', 8);
  const L = new Float32Array(block), R = new Float32Array(block);
  const wet = { wet: () => 1 }; // the water never calms
  const n = Math.round(seconds * fs);
  let next = every, at5 = 0, at29 = 0, settle = 0;
  b.strike(0, 220, 1, 0.5, 0);
  for (let pos = 0; pos < n; pos += block) {
    const m = Math.min(block, n - pos);
    while (next < pos + m) {
      settle = b.level(0); // just before the next hit: the settled sustain
      b.strike(0, 220, 1, 0.5, 0);
      next += every;
    }
    L.fill(0); R.fill(0);
    b.renderRange(L, R, 0, m);
    b.endBlock(L, R, m);
    b.updateHold(wet);
    const t = (pos + m) / fs;
    if (at5 === 0 && t >= 5) at5 = settle;
    if (t >= 29) at29 = settle;
  }
  const growth = db(at29 / at5);
  report(Math.abs(growth) < 1 && b.activeVoices() === 1,
    'hold on, a strike every 0.5 s for 30 s: the bell settles, no pile-up',
    `settled level ${at5.toFixed(2)} → ${at29.toFixed(2)} (${growth >= 0 ? '+' : ''}${growth.toFixed(2)} dB)`);
}
{
  // …and at that settled level a new strike must still be a hit: louder and
  // brighter for a harder strike, not swallowed by the capacity. (The first
  // cap scaled every strike by the remaining room, so a held note answered a
  // velocity-1.0 strike with +0.47 dB and a 35% strike with the same +0.39 dB
  // — the held note was frozen. Now a hit drives the ring past its capacity
  // and the excess bleeds back over ~0.1 s.)
  const fs = 48000, block = 128, EVERY = Math.round(0.5 * fs);
  const settleThen = (velocity) => {
    const b = new Bells({ sampleRate: fs });
    b.setParam('hold', 1); b.setParam('bellDecay', 8); b.setParam('tick', 0); // the bell's answer alone
    const L = new Float32Array(block), R = new Float32Array(block);
    const wet = { wet: () => 1 };
    b.strike(0, 220, 1, 0.5, 0);
    let pos = 0, next = EVERY;
    for (let k = 0; k < 20; k++) { // 10 s of hits every 0.5 s: the ring settles
      while (pos + block <= next) { L.fill(0); R.fill(0); b.render(L, R, block); b.updateHold(wet); pos += block; }
      b.strike(0, 220, 1, 0.5, 0);
      next += EVERY;
    }
    // Let the last hit's excess bleed back before reading the settled level.
    for (let k = 0; k < Math.round(0.4 * fs) / block; k++) { L.fill(0); R.fill(0); b.render(L, R, block); b.updateHold(wet); }
    const before = b.level(0);
    b.strike(0, 220, velocity, 0.5, 0);
    const after = b.level(0);
    L.fill(0); R.fill(0);
    b.render(L, R, block); // the first 2.7 ms of the answer
    let s = 0, peak = 0;
    for (let i = 0; i < block; i++) {
      s += L[i] * L[i] + R[i] * R[i];
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    return { before, after, jump: after - before, rms: Math.sqrt(s / (2 * block)), peak };
  };
  const hard = settleThen(1), soft = settleThen(0.35);
  report(hard.before > 2 && hard.peak > soft.peak * 1.15 && hard.rms > soft.rms * 1.15 &&
    hard.jump > 0.5 && hard.jump > soft.jump * 3,
    'at its capacity a held bell still answers a strike, and hardness still matters',
    `settled ${hard.before.toFixed(2)}: the answer's peak ${hard.peak.toFixed(3)} vs ${soft.peak.toFixed(3)} (${db(hard.peak / soft.peak).toFixed(1)} dB), its first 2.7 ms rms ${hard.rms.toFixed(4)} vs ${soft.rms.toFixed(4)} (${db(hard.rms / soft.rms).toFixed(1)} dB); the partial-magnitude sum — a bound rather than a loudness, whose move is phase-dependent — moves ${hard.jump.toFixed(2)} vs ${soft.jump.toFixed(2)}`);
}
{
  // The incremental hold decay (its own two-term series, no exp per partial on
  // the water clock) must stay on top of a rebuilt exp() while the water's
  // hold swings hard.
  const fs = 48000, b = new Bells({ sampleRate: fs });
  b.setParam('hold', 1); b.setParam('bellDecay', 8);
  const L = new Float32Array(128), R = new Float32Array(128);
  b.strike(0, 220, 1, 0.5, 0);
  let t = 0;
  for (let k = 0; k < 400; k++) {
    t += 128 / fs;
    b.render(L, R, 128);
    b.updateHold({ wet: () => 0.5 + 0.5 * Math.sin(t * 9) }); // calm ↔ moving twice a second
  }
  let worst = 0;
  for (let p = 0; p < 5; p++) {
    const d = Math.exp(b.lnd[p] * b.holdF[0]) * b.cw[p];
    if (Math.abs(d) > 1e-12) worst = Math.max(worst, Math.abs(b.cr[p] - d) / Math.abs(d));
  }
  report(worst < 1e-6, 'the incremental hold decay tracks a rebuilt exp() to better than 1e-6',
    `worst relative error ${worst.toExponential(1)} over 400 updates`);
}
{
  // The same thing end to end, in water that never calms (a long water decay,
  // a drop every 0.5 s) so `hold` stays engaged: the mix must stop growing.
  // The instrument's output is pre-limiter (the limiter is the worklet's,
  // limiter.js), so a pile-up shows directly. Note that a held pond keeps
  // many stones ringing at once, so it is loud — the check is about the
  // runaway, not about that loudness. The
  // statistics are gathered as the stream runs, so no 30-second buffer is held.
  const fs = 48000, SECONDS = 30, EVERY = 0.5, block = 128;
  const inst = makeInstrument(fs, { hold: 1, synthLevel: 1, bellDecay: 8, synthDecay: 12, cutoff: 2 });
  inst.setParam('decay', 30); // the water never calms
  inst.setParam('threshold', 0.005);
  const n = Math.round(SECONDS * fs);
  const bl = new Float32Array(block), br = new Float32Array(block);
  const preOf = (v) => v;
  const earlyFrom = Math.round(5 * fs), earlyTo = Math.round(10 * fs), lateFrom = Math.round((SECONDS - 5) * fs);
  let next = 0, drops = 0, peak = 0, loud = 0, finite = true;
  let eSum = 0, eN = 0, lSum = 0, lN = 0;
  for (let pos = 0; pos < n; pos += block) {
    const m = Math.min(block, n - pos);
    while (next < pos + m) { inst.engine.drop(0.5, 0.5, 1); next += Math.round(EVERY * fs); drops++; }
    inst.process(bl, br, m);
    for (let i = 0; i < m; i++) {
      const a = bl[i], b2 = br[i], at = pos + i;
      if (!(Number.isFinite(a) && Number.isFinite(b2))) finite = false;
      const aa = a < 0 ? -a : a, bb = b2 < 0 ? -b2 : b2;
      if (aa > peak) peak = aa;
      if (bb > peak) peak = bb;
      if (aa > 0.8 || bb > 0.8) loud++;
      if (at >= lateFrom) { lSum += preOf(a) * preOf(a) + preOf(b2) * preOf(b2); lN += 2; }
      else if (at >= earlyFrom && at < earlyTo) { eSum += preOf(a) * preOf(a) + preOf(b2) * preOf(b2); eN += 2; }
    }
  }
  const early = Math.sqrt(eSum / eN), late = Math.sqrt(lSum / lN), growth = db(late / early);
  report(finite && peak < 1e3 && growth < 2,
    `hold on, ${drops} drops over ${SECONDS} s in water that never calms: the mix stops growing`,
    `pre-limiter level ${early.toFixed(2)} → ${late.toFixed(2)} (${growth >= 0 ? '+' : ''}${growth.toFixed(2)} dB); peak ${peak.toFixed(3)}, ${((loud / n) * 100).toFixed(1)}% of samples above 0.8`);
}

// ---- 7. Bad input and extremes --------------------------------------------------------
console.log('\n7. Bad input and extremes');
{
  const inst = new Instrument({ sampleRate: 48000 });
  const before = Float64Array.from(inst.bells.voices.p);
  const send = (...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  for (const target of [SHARED, 0, 5, -2, MAX_STONES, 1.5, NaN, Infinity]) {
    for (const idx of [-1, 1.5, VOICE_SIZE, NaN]) send(EV_VOICE, target, idx, 1);
    for (const v of [NaN, Infinity, -Infinity]) send(EV_VOICE, target, 0, v);
  }
  for (const s of [-1, MAX_STONES, 2.5, NaN]) send(EV_VOICE_OVERRIDE, s, 1);
  const same = inst.bells.voices.p.every((v, i) => v === before[i]) && inst.bells.voices.overridden.every((o) => o === 0);
  send(EV_VOICE, SHARED, vi('resonance'), 99); send(EV_VOICE, SHARED, vi('attack'), -5);
  const clamped = inst.bells.voices.get(SHARED, 'resonance') === VOICE_PARAMS.resonance.max && inst.bells.voices.get(SHARED, 'attack') === VOICE_PARAMS.attack.min;
  report(same && clamped, 'bad targets, indices and values are ignored; out-of-range values are clamped');
}
for (const fs of [44100, 192000]) {
  // Every knob at an extreme, every stone ringing, up to C8.
  const all = buildPitches({ scale: SCALES.chromatic, root: 24, low: 24, high: 108 }).slice(0, MAX_STONES);
  const results = [];
  for (const end of ['min', 'max']) {
    const inst = new Instrument({ sampleRate: fs, seed: 3 });
    for (const k of VOICE_KEYS) inst.setParam(k, VOICE_PARAMS[k][end]);
    inst.setParam('synthLevel', 1.5); inst.setParam('bellLevel', 1.5); inst.setParam('hold', 1);
    const { xs, ys } = stonePositions(all.length);
    inst.setStones(xs, ys, all.map((p) => p.hz), all.length);
    inst.setParam('threshold', 0.005);
    const { L, R } = play(inst, 2, 128, (e) => { for (let k = 0; k < 8; k++) e.drop((k * 0.37) % 1, (k * 0.59) % 1, 3, k * 0.2); });
    for (let s = 0; s < all.length; s++) inst.bells.strike(s, all[s].hz, 1, 0.5, 0);
    const more = play(inst, 1, 128, () => {});
    results.push(L.every(Number.isFinite) && R.every(Number.isFinite) && more.L.every(Number.isFinite) && more.R.every(Number.isFinite));
  }
  report(results.every(Boolean), `${fs / 1000} kHz: every voice knob at its min, then its max, ${all.length} stones up to C8: finite`);
}

// ---- 8. CPU -----------------------------------------------------------------------------
// The budget lives in its own process (check-voices-cpu.mjs): by the time this
// file has run its earlier sections the same workload costs ~40% more per block
// (508 µs at the start of a run against 730-830 µs after them), and the engine
// is identical either way. Buffers built once at start-up, then a steady stream
// of blocks, is how the plugin runs; that is what the budget is taken against.
console.log('\n8. CPU per 128-sample block at 48 kHz (budget 2667 µs, its own process)');
{
  const cpu = spawnSync(process.execPath, [fileURLToPath(new URL('./check-voices-cpu.mjs', import.meta.url))], { encoding: 'utf8' });
  process.stdout.write(cpu.stdout || '');
  if (cpu.stderr) process.stderr.write(cpu.stderr);
  if (cpu.status !== 0) failures += Math.max(1, (String(cpu.stdout).match(/^FAIL/gm) || []).length);
}

// ---- 8b. Work that has gone quiet stops ------------------------------------------------
console.log('\n8b. A layer that has gone quiet stops being computed');
{
  const fs = 48000, L = new Float32Array(128), R = new Float32Array(128), blocks = Math.round(3 * fs) / 128;
  const render = (b, n) => { for (let i = 0; i < n; i++) { L.fill(0); R.fill(0); b.render(L, R, 128); } };
  // The bell dies (short decay) while the synth layer rings on (long decay):
  // its partials must stop being computed, and the voice must still sound.
  const b = new Bells({ sampleRate: fs });
  b.setParam('bellDecay', 0.2); b.setParam('synthLevel', 1); b.setParam('synthDecay', 12);
  for (let s = 0; s < MAX_STONES; s++) b.strike(s, 60 + s * 15, 1, 0.5, 0);
  render(b, blocks);
  let bells = 0, synths = 0;
  for (let s = 0; s < MAX_STONES; s++) { bells += b.bellDone[s]; synths += b.sOn[s]; }
  report(bells === MAX_STONES && synths === MAX_STONES && b.activeVoices() === MAX_STONES,
    'a bell that has faded while the synth layer rings on stops being computed',
    `${bells}/${MAX_STONES} bells retired, ${synths}/${MAX_STONES} synths still sounding`);

  // The synth's level is turned down to nothing while the bell rings on: once
  // its filter has drained, the layer stops too.
  const c = new Bells({ sampleRate: fs });
  c.setParam('bellDecay', 8); c.setParam('synthLevel', 1); c.setParam('synthDecay', 12); c.setParam('resonance', 0);
  for (let s = 0; s < MAX_STONES; s++) c.strike(s, 60 + s * 15, 1, 0.5, 0);
  render(c, 20);
  c.setParam('synthLevel', 0);
  render(c, Math.round(fs) / 128); // one second: the filter drains
  let off = 0, alive = 0;
  for (let s = 0; s < MAX_STONES; s++) { off += c.sOn[s] === 0 ? 1 : 0; alive += c.active[s]; }
  report(off === MAX_STONES && alive === MAX_STONES,
    'a synth layer left with no oscillator gain and a drained filter stops being computed',
    `${off}/${MAX_STONES} synths retired, ${alive}/${MAX_STONES} bells still ringing`);
}
{
  // The loop that splits a block at each water tick must always advance: with
  // a tick reported behind the stream (a rounding edge) it used to be able to
  // spin forever. Forced here, since that edge cannot be reached honestly.
  // This is a smoke test: it proves the guard fires and the call returns with
  // finite output, not that the splitting itself stayed correct.
  const inst = makeInstrument();
  const e = inst.engine, real = e.stepSample.bind(e);
  let first = true;
  e.stepSample = (k) => (first ? ((first = false), -1e9) : real(k));
  const L = new Float32Array(128), R = new Float32Array(128);
  inst.process(L, R, 128);
  report(inst.segmentGuards === 1 && L.every(Number.isFinite) && R.every(Number.isFinite),
    'a segment that would not advance is guarded, never stalled (smoke test)', `${inst.segmentGuards} guard, output finite`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll voice checks passed.');
process.exit(failures ? 1 : 0);
