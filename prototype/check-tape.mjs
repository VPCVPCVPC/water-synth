// check-tape.mjs — checks for the audio looper ("a tape beside the pond"):
// recording the water's sound, playing it back fixed, overdub, mute, stop and
// clear, the loop seam, the shared quantize grid with the gesture looper, and
// that nothing depends on the block size or the sample rate.
//   node check-tape.mjs

import {
  TapeDeck, TAPE_TRACKS, TAPE_FIELDS, TAPE_PARAMS, MAX_TAPE_SECONDS,
  EMPTY, RECORDING, PLAYING, OVERDUB, STOPPED,
  TAPE_RECORD, TAPE_PLAY_STOP, TAPE_MUTE, TAPE_CLEAR, TAPE_CLEAR_ALL,
} from './tape.js';
import { GestureLooper } from './looper.js';
import { Instrument, PARAMS, PARAM_KEYS } from './instrument.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { EV_DROP, EV_TAPE, EV_LOOP, EV_PARAM } from './ring.js';
import { LOOP_RECORD, LOOP_CLEAR_ALL } from './looper.js';
import { FRAME_TAPES } from './visuals.js';
import { SIM_RATE } from './surface.js';
import { performance } from 'node:perf_hooks';
import { cents, spectrum } from './check-lib.mjs';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const db = (x) => 20 * Math.log10(x);
const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
// Largest sample-to-sample step in [from, to).
const maxStep = (x, from, to) => {
  let m = 0;
  for (let i = Math.max(1, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
const peak = (x, from = 0, to = x.length) => {
  let m = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};

// A source of live sound: two tones and a slow tremolo, quiet enough that the
// tape mix never reaches the deck's soft knee (so checks can add signals up).
const TONE = (t) => 0.22 * (Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 331 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.7 * t));

// A stream position for the deck: render output, feeding `live(t)` (t in
// seconds) as the instrument's own sound, and applying each action at its exact
// stream sample — so nothing here depends on the block size.
function rig({ rate = 48000, grid = null, block = 128 } = {}) {
  const d = new TapeDeck({ sampleRate: rate, grid });
  let pos = 0;
  const L = new Float32Array(block), R = new Float32Array(block);
  const self = {
    d, rate,
    get pos() { return pos; },
    run(seconds, live = () => 0, actions = []) {
      const start = pos, end = pos + Math.round(seconds * rate);
      const out = new Float64Array(end - start);
      let q = 0;
      while (pos < end) {
        while (q < actions.length && actions[q].sample <= pos) { d.action(actions[q].track, actions[q].act); q++; }
        let m = Math.min(block, end - pos);
        if (q < actions.length && actions[q].sample < pos + m) m = actions[q].sample - pos; // stop exactly on the action
        for (let i = 0; i < m; i++) { const v = live((pos + i) / rate); L[i] = v; R[i] = v; }
        d.now = pos;
        d.process(L, R, m);
        for (let i = 0; i < m; i++) out[pos - start + i] = L[i];
        pos += m;
      }
      return out;
    },
  };
  return self;
}

// ---- 1. A take records the live sound and plays it back, unchanged ---------------------
console.log('\n1. Record the water\'s sound, play it back fixed');
{
  const rate = 48000, LEN = 2; // a 2 s take
  const r = rig();
  r.run(LEN, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: LEN * rate, track: 0, act: TAPE_RECORD }]); // finish
  const d = r.d, len = d.length[0], origin = d.origin[0];
  report(d.state[0] === PLAYING && len === LEN * rate, 'a finished take plays at its own length',
    `state ${d.state[0]}, length ${(len / rate).toFixed(3)} s`);

  const skip = Math.round(0.03 * rate); // the loop's fade-in
  const x0 = r.pos;
  const p1 = r.run(0.3, () => 0); // stream 2.0 → 2.3 s = loop 0.0 → 0.3 s (from where it starts)
  let follows = 0;
  for (let i = skip; i < p1.length; i++) {
    const lp = (x0 + i - origin) % len;
    follows = Math.max(follows, Math.abs(p1[i] - TONE(lp / rate)));
  }
  r.run(LEN - 0.3, () => 0); // stream 2.3 → 4.0 s
  const again = r.run(0.3, () => 0); // stream 4.0 → 4.3 s = the same loop offsets
  let passDiff = 0;
  for (let i = skip; i < p1.length; i++) passDiff = Math.max(passDiff, Math.abs(p1[i] - again[i]));
  report(passDiff < 1e-6 && follows < 1e-6,
    'a tape plays fixed audio: the same samples every pass, and they are what it recorded',
    `pass-to-pass ${passDiff.toExponential(1)}; re the recorded signal ${follows.toExponential(1)}`);

  // The water is loud now, and the tape does not care: the output is the live
  // sound plus the same pass again.
  const loud = (t) => 0.15 * Math.sin(2 * Math.PI * 110 * t);
  const mx0 = r.pos;
  const mixed = r.run(0.3, loud); // stream 4.3 → 4.6 s = loop 0.3 → 0.6 s
  let worst = 0;
  for (let i = 0; i < mixed.length; i++) {
    const at = mx0 + i, lp = (at - origin) % len;
    worst = Math.max(worst, Math.abs(mixed[i] - (loud(at / rate) + TONE(lp / rate))));
  }
  report(worst < 1e-6, 'with the water playing, a tape still plays its own (fixed) sound on top',
    `worst deviation from live + tape ${worst.toExponential(1)}`);
}

// ---- 2. Tapes record the water, never other tapes --------------------------------------
console.log('\n2. A tape records the water\'s sound, not other tapes');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  r.run(0.4, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.4, track: 0, act: TAPE_RECORD }]);
  // Let the water be silent for longer than the seam before the second take,
  // so the pre-take sound the seam borrows is silence too.
  r.run(0.05, () => 0);
  // Track 1 records while track 0 is playing back into the output.
  const at = r.pos;
  r.run(0.4, () => 0, [{ sample: at, track: 1, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: r.pos, track: 1, act: TAPE_RECORD }]);
  const loud = r.run(0.4, () => 0); // track 0 (and track 1's silence)
  d.action(0, TAPE_MUTE);
  const silent = r.run(0.6, () => 0); // the mute fades, then only track 1 is left
  const leak = peak(silent, Math.round(0.35 * rate));
  report(rms(loud) > 0.01 && leak < 1e-7,
    'a take captures the water only, never another tape\'s playback',
    `the first tape is audible (rms ${rms(loud).toFixed(4)}); with it muted the second is silent (worst ${leak.toExponential(1)})`);
}

// ---- 3. Overdub: heard live once, replayed from the next pass --------------------------
console.log('\n3. Overdub layers on top');
{
  const rate = 48000;
  const A = (t) => 0.2 * Math.sin(2 * Math.PI * 200 * t);
  const B = (t) => 0.2 * Math.sin(2 * Math.PI * 300 * t);
  const r = rig(), d = r.d;
  r.run(0.5, A, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.5, track: 0, act: TAPE_RECORD }]);
  const solo = rms(r.run(0.5, () => 0), Math.round(0.05 * rate));
  const at = r.pos;
  r.run(0.5, B, [{ sample: at, track: 0, act: TAPE_RECORD }]); // overdub
  const overdubbing = d.state[0] === OVERDUB;
  const nextPass = rms(r.run(0.5, () => 0), Math.round(0.05 * rate));
  report(overdubbing && nextPass > solo * 1.2, 'record on a playing tape overdubs; the next pass plays both layers',
    `state ${d.state[0]}, rms ${solo.toFixed(4)} → ${nextPass.toFixed(4)}`);
}

// ---- 4. Mute, stop and clear fade; clear all -------------------------------------------
console.log('\n4. Mute, stop and clear fade, never cut');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  r.run(0.5, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.5, track: 0, act: TAPE_RECORD }]);
  r.run(0.3, () => 0); // the fade-in is long done
  const before = r.run(0.1, () => 0);
  d.action(0, TAPE_MUTE);
  const during = r.run(0.5, () => 0);
  const after = rms(r.run(0.2, () => 0));
  const step = maxStep(during, 0, during.length), own = maxStep(before, 1, before.length);
  report(d.muted[0] === 1 && after === 0 && step <= own * 1.5,
    'mute fades the tape out (never cuts) and keeps its place',
    `worst step ${step.toFixed(4)} vs the signal's own ${own.toFixed(4)}; after the fade ${after.toExponential(1)}`);
  d.action(0, TAPE_MUTE);
  const back = rms(r.run(0.3, () => 0), Math.round(0.05 * rate));
  report(d.muted[0] === 0 && back > 0.01, 'unmute fades it back in at the same place', `rms ${back.toFixed(4)}`);

  d.action(0, TAPE_PLAY_STOP);
  r.run(0.6, () => 0);
  report(d.state[0] === STOPPED, 'stop fades out and holds the tape', `state ${d.state[0]}`);
  d.action(0, TAPE_PLAY_STOP);
  const restarted = r.run(0.4, () => 0);
  report(d.state[0] === PLAYING && rms(restarted) > 0.01, 'play restarts it from the top', `rms ${rms(restarted).toFixed(4)}`);
  d.action(0, TAPE_CLEAR);
  r.run(0.6, () => 0);
  const erased = d.state[0] === EMPTY && d.length[0] === 0;
  // Two more takes, then clear all.
  r.run(0.3, TONE, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  r.run(0.3, TONE, [{ sample: r.pos, track: 2, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: r.pos, track: 2, act: TAPE_RECORD }]);
  r.run(0.3, () => 0, [{ sample: r.pos, track: 0, act: TAPE_CLEAR_ALL }]);
  r.run(0.5, () => 0);
  const all = [0, 1, 2, 3].every((t) => d.state[t] === EMPTY && d.length[t] === 0);
  report(erased && all, 'clear erases one tape; clear all erases every tape', `cleared track 0, then all: ${all}`);
}

// ---- 5. The loop seam is crossfaded ----------------------------------------------------
console.log('\n5. The loop wraps without a click');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  r.run(0.5, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.5, track: 0, act: TAPE_RECORD }]);
  r.run(0.25, () => 0);
  const start = r.pos, x = r.run(1.5, () => 0);
  const len = d.length[0], origin = d.origin[0];
  // The first loop boundary at or after the window's start.
  const wrapAt = origin + len * Math.ceil((start - origin) / len + 1e-9) - start;
  const around = maxStep(x, wrapAt - 200, wrapAt + 200);
  const elsewhere = maxStep(x, wrapAt + Math.round(0.3 * rate), wrapAt + Math.round(0.45 * rate));
  report(around <= elsewhere * 1.5, 'the seam is crossfaded, not cut',
    `step across the wrap ${around.toFixed(4)} vs ${elsewhere.toFixed(4)} mid-loop`);
}

// ---- 6. Quantize: takes sit on the beats of the gesture looper's grid -----------------
console.log('\n6. Quantize: tapes follow the beat, in whole beats of their own lengths');
{
  const rate = 48000, grid = new GestureLooper();
  grid.setParam('quantize', 1); grid.setParam('bpm', 120); // a beat is 0.5 s
  grid.transportOrigin = 1000; // 1 s of stream time
  const r = rig({ grid }), d = r.d;
  const beat = (60 * rate) / grid.bpm, origin = (grid.transportOrigin * rate) / SIM_RATE;
  // Asked for at 1.3 s: the take starts on the beat at 1 s; finish asked for at
  // 2.7 s waits for the beat at 3 s — 4 beats, the first 0.3 s silence.
  const at = Math.round(1.3 * rate);
  r.run(1.4, TONE, [{ sample: at, track: 0, act: TAPE_RECORD }]);
  r.run(1.61, TONE, [{ sample: at + Math.round(1.4 * rate), track: 0, act: TAPE_RECORD }]);
  const len = d.length[0], gap = at - origin;
  report(d.onGrid[0] === 1 && d.origin[0] === origin && Math.abs(len - 4 * beat) < 1,
    'a take starts on a beat and finishes on the next beat after finish',
    `origin ${d.origin[0]} (a beat), length ${(len / rate).toFixed(3)} s = ${(len / beat).toFixed(2)} beats`);
  report(d.state[0] === PLAYING && d.usesGrid(), 'the tape keeps the shared grid');
  const play = r.run(0.6, () => 0);
  const inGap = rms(play, 0, Math.round(gap * 0.8));
  const after = rms(play, Math.round(gap + 0.03 * rate), Math.round(gap + 0.3 * rate));
  report(inGap < 1e-7 && after > 0.02, 'the silence before the take is part of the loop',
    `gap rms ${inGap.toExponential(1)}, then ${after.toFixed(4)}`);
  // A second tape, 3 beats long: a different length, still on the beat.
  const t1 = Math.round(origin + 6.4 * beat);
  r.run((t1 - r.pos) / rate + 0.01, TONE, [{ sample: t1, track: 1, act: TAPE_RECORD }]);
  r.run(1.6, TONE, [{ sample: Math.round(origin + 8.6 * beat), track: 1, act: TAPE_RECORD }]);
  const len1 = d.length[1];
  report(Math.abs(len1 - 3 * beat) < 1 && Math.abs((d.origin[1] - origin) / beat - 6) < 1e-6,
    'tapes can be different whole numbers of beats (4 and 3), so they line up differently each time',
    `track 2: ${(len1 / beat).toFixed(2)} beats from beat ${((d.origin[1] - origin) / beat).toFixed(0)}`);
}

// ---- 7. Block size and sample rate ------------------------------------------------------
console.log('\n7. No dependence on how the stream is split, or on the sample rate');
{
  const rate = 48000;
  const script = (block) => {
    const r = rig({ block });
    const out = [];
    out.push(...r.run(0.4, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]));
    const at = r.pos;
    out.push(...r.run(0.4, TONE, [{ sample: at, track: 0, act: TAPE_RECORD }]));
    out.push(...r.run(0.3, () => 0, [{ sample: at + Math.round(0.4 * rate), track: 0, act: TAPE_CLEAR_ALL }]));
    out.push(...r.run(0.5, () => 0));
    return Float64Array.from(out);
  };
  const ref = script(128);
  const bad = [1, 7, 37, 128, 1000, 8192].filter((block) => {
    const x = script(block);
    if (x.length !== ref.length) return true;
    for (let i = 0; i < ref.length; i++) if (x[i] !== ref[i]) return true;
    return false;
  });
  report(bad.length === 0, 'record, overdub, clear all and play back: bit-identical at block sizes 1, 7, 37, 128, 1000, 8192',
    bad.length ? `differs at ${bad.join(', ')}` : `${ref.length} samples identical`);

  // The same seconds at another rate: the same loudness over time (50 ms windows).
  const env = (r) => {
    const g = rig({ rate: r });
    const out = g.run(1.2, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
    return Array.from({ length: 23 }, (_, k) => rms(out, Math.round(k * 0.05 * r), Math.round((k + 1) * 0.05 * r)));
  };
  const e48 = env(48000), e441 = env(44100), e96 = env(96000);
  const floor = Math.max(...e48) / 1000;
  let worst = 0;
  for (let k = 0; k < e48.length; k++) if (e48[k] > floor) worst = Math.max(worst, Math.abs(db(e441[k] / e48[k])), Math.abs(db(e96[k] / e48[k])));
  report(worst < 1, 'the same take at 44.1 / 48 / 96 kHz is the same loudness over time', `worst 50 ms window ${worst.toFixed(2)} dB apart`);
}

// ---- 8. Limits and bad input -------------------------------------------------------------
console.log('\n8. Limits, bad input and extremes');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  r.run(0.02, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.02, track: 0, act: TAPE_RECORD }]);
  report(d.state[0] === EMPTY, 'a take shorter than the minimum is dropped');

  for (const t of [-1, TAPE_TRACKS, 1.5, NaN]) for (const a of [0, 99, NaN]) d.action(t, a);
  const after = r.run(0.1, () => 0);
  report(after.every(Number.isFinite), 'bad tracks and actions are ignored');
  d.setParam('tapeLevel', 99); const hi = d.tapeLevel;
  d.setParam('tapeLevel', -5); const lo = d.tapeLevel;
  d.setParam('tapeLevel', NaN); const nan = d.tapeLevel;
  report(hi === TAPE_PARAMS.tapeLevel.max && lo === TAPE_PARAMS.tapeLevel.min && nan === lo,
    'out-of-range values clamp, NaN is ignored', `${hi} / ${lo} / ${nan}`);

  // A take runs to the deck's capacity and finishes itself.
  const r2 = rig();
  r2.run(1, TONE, [{ sample: 0, track: 1, act: TAPE_RECORD }]);
  r2.run(MAX_TAPE_SECONDS + 2, () => 0);
  const len = r2.d.length[1];
  report(r2.d.state[1] === PLAYING && len > 0 && len <= r2.d.capacity,
    'a take longer than the deck holds finishes by itself',
    `${(len / rate).toFixed(1)} s of a ${MAX_TAPE_SECONDS} s deck`);
  const fresh = new TapeDeck({ sampleRate: rate });
  report(fresh.state.every((s) => s === EMPTY) && fresh.now === 0, 'a fresh deck is empty');
}

// ---- 9. The status frame the page reads --------------------------------------------------
console.log('\n9. The status frame the page reads');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  r.run(0.4, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(0.001, () => 0, [{ sample: rate * 0.4, track: 0, act: TAPE_RECORD }]);
  d.action(1, TAPE_RECORD);
  r.run(0.1, () => 0);
  const frame = new Float32Array(TAPE_TRACKS * TAPE_FIELDS);
  d.writeStatus(frame, 0);
  const s0 = frame.subarray(0, TAPE_FIELDS), s1 = frame.subarray(TAPE_FIELDS, 2 * TAPE_FIELDS);
  const finite = Array.from(frame).every(Number.isFinite);
  report(s0[0] === PLAYING && s0[2] > 0 && s0[3] >= 0 && s0[3] <= 1 && s1[0] === RECORDING && s1[2] > 0 && finite,
    'per track: state, mute, length, position, waiting, fade',
    `track 0 state ${s0[0]} ${s0[2].toFixed(2)} s at ${(s0[3] * 100).toFixed(0)}%, track 1 state ${s1[0]} ${s1[2].toFixed(2)} s`);
}

// ---- 10. CPU ----------------------------------------------------------------------------
console.log('\n10. CPU per 128-sample block at 48 kHz (budget 2667 µs)');
{
  const rate = 48000;
  const r = rig(), d = r.d;
  for (let t = 0; t < TAPE_TRACKS; t++) {
    const at = r.pos;
    r.run(2, TONE, [{ sample: at, track: t, act: TAPE_RECORD }]);
    r.run(0.001, () => 0, [{ sample: r.pos, track: t, act: TAPE_RECORD }]);
  }
  const held = [0, 1, 2, 3].every((t) => d.state[t] === PLAYING);
  r.run(0.5, () => 0); // let the fades finish
  const n = 4000, L = new Float32Array(128), R = new Float32Array(128);
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { L.fill(0); R.fill(0); d.process(L, R, 128); }
    const us = ((performance.now() - t0) * 1000) / n;
    if (us < best) best = us;
  }
  report(held && best / 2667 < 0.3, `${TAPE_TRACKS} tapes looping: ${best.toFixed(0)} µs/block, ${((best / 2667) * 100).toFixed(1)}%`, 'limit 30%');
}

// ---- 11. Wired into the instrument: the knob, the event path, the frame ---------------
console.log('\n11. Through the instrument');
{
  const rate = 48000, PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
  const inst = new Instrument({ sampleRate: rate, seed: 2 });
  inst.setParam('waveSpeed', 64); inst.setParam('decay', 8); inst.setParam('splash', 0);
  inst.setParam('threshold', 0.005);
  const { xs, ys } = stonePositions(PENTA.length);
  inst.setStones(xs, ys, PENTA.map((p) => p.hz), PENTA.length);
  const send = (...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  const L = new Float32Array(128), R = new Float32Array(128);

  // The tape level is one of the instrument's knobs, by index.
  const idx = PARAM_KEYS.indexOf('tapeLevel');
  inst.setParamIndex(idx, 0.5);
  report(idx >= 0 && PARAMS.tapeLevel !== undefined && inst.tape.tapeLevel === 0.5,
    'the tape level is an instrument knob, and the index reaches the deck', `index ${idx} of ${PARAM_KEYS.length}`);

  // Record a second of the water's own sound through the event path.
  send(EV_DROP, 0.5, 0.5, 2);
  for (let k = 0; k < 40; k++) inst.process(L, R, 128); // let the drop ring the stones
  send(EV_TAPE, 0, TAPE_RECORD);
  const origin = inst.tape.origin[0], captured = [];
  for (let k = 0; k < Math.round(rate / 128); k++) {
    inst.process(L, R, 128);
    for (let i = 0; i < 128; i++) captured.push(L[i]);
  }
  send(EV_TAPE, 0, TAPE_RECORD); // finish the take
  for (let k = 0; k < 4; k++) inst.process(L, R, 128); // the take ends on the next block
  const len = inst.tape.length[0];
  report(inst.tape.state[0] === PLAYING && len > 0,
    'a take recorded through EV_TAPE and finished plays', `state ${inst.tape.state[0]}, ${(len / rate).toFixed(2)} s`);

  // The tape holds exactly what the instrument output, sample for sample
  // (except the seam, which blends in the sound from before the take).
  let worst = 0;
  for (let k = 0; k < len - 480; k++) worst = Math.max(worst, Math.abs(inst.tape.L[k] - captured[k]));
  report(worst < 1e-7, "a tape records the instrument's own output, sample for sample",
    `worst difference ${worst.toExponential(1)} over ${(len / rate).toFixed(2)} s`);

  // The frame carries the tape status where the page reads it.
  const frame = new Float32Array(inst.frameSize());
  inst.prepareFrame();
  inst.writeFrame(frame);
  const t0 = frame.subarray(FRAME_TAPES, FRAME_TAPES + TAPE_FIELDS);
  report(t0[0] === PLAYING && t0[2] > 0 && t0[3] >= 0 && t0[3] <= 1,
    'the visuals frame carries the tape status',
    `state ${t0[0]}, ${t0[2].toFixed(2)} s at ${(t0[3] * 100).toFixed(0)}%`);

  // And the tape adds its playback to the instrument's output: with the tape
  // muted the same span is quieter.
  const span = (mute) => {
    inst.tape.muted[0] = mute ? 1 : 0;
    let s = 0, n = 0;
    for (let k = 0; k < 200; k++) { inst.process(L, R, 128); for (let i = 0; i < 128; i++) { s += L[i] * L[i]; n++; } }
    return Math.sqrt(s / n);
  };
  const loud = span(false), quiet = span(true);
  report(loud > quiet, "the tape is audible in the instrument's output", `rms ${loud.toFixed(4)} playing vs ${quiet.toFixed(4)} muted`);
}

console.log('\n13. Restarts mid-fade, the level knob, and a reused track\'s gap');
{
  const rate = 48000;
  // Play pressed 50 ms into a stop's 0.3 s fade: the old sound keeps fading
  // where it was while the tape starts again — no jump. Off the grid, and on
  // it (where the restart waits for the next beat).
  for (const onGrid of [false, true]) {
    let grid = null;
    if (onGrid) { grid = new GestureLooper(); grid.setParam('quantize', 1); grid.setParam('bpm', 120); grid.transportOrigin = 0; }
    const r = rig({ grid }), d = r.d;
    r.run(2, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
    r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
    r.run(onGrid ? 2.2 : 0.5, () => 0);
    const own = maxStep(r.run(0.2, () => 0), 1, Math.round(0.2 * rate));
    d.action(0, TAPE_PLAY_STOP);
    const x = r.run(0.6, () => 0, [{ sample: r.pos + Math.round(0.05 * rate), track: 0, act: TAPE_PLAY_STOP }]);
    const step = maxStep(x, 1, x.length);
    report(d.state[0] === PLAYING && step <= own * 1.5 && rms(x, Math.round(0.4 * rate)) > (onGrid ? -1 : 0.01),
      `play during a stop's fade (${onGrid ? 'on the grid' : 'free'}): no jump`,
      `worst step ${step.toFixed(4)} vs the tape's own ${own.toFixed(4)}`);
  }
  {
    // Restart mid-fade and then clear at once; stop/play tapped quickly twice.
    // Neither may cut the fading tail.
    const take = () => {
      const r = rig(), d = r.d;
      r.run(2, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
      r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
      r.run(0.5, () => 0);
      return { r, d, own: maxStep(r.run(0.2, () => 0), 1, Math.round(0.2 * rate)) };
    };
    const at = (r, s) => r.pos + Math.round(s * rate);
    {
      const { r, d, own } = take();
      const x = r.run(1, () => 0, [
        { sample: at(r, 0), track: 0, act: TAPE_PLAY_STOP }, { sample: at(r, 0.05), track: 0, act: TAPE_PLAY_STOP },
        { sample: at(r, 0.058), track: 0, act: TAPE_CLEAR },
      ]);
      const step = maxStep(x, 1, x.length);
      report(d.state[0] === EMPTY && step <= own * 1.5, 'clear just after a restart: the tail still fades out, then it erases',
        `worst step ${step.toFixed(4)} vs ${own.toFixed(4)}; state ${d.state[0]}`);
    }
    {
      const { r, d, own } = take();
      const x = r.run(1, () => 0, [
        { sample: at(r, 0), track: 0, act: TAPE_PLAY_STOP }, { sample: at(r, 0.05), track: 0, act: TAPE_PLAY_STOP },
        { sample: at(r, 0.1), track: 0, act: TAPE_PLAY_STOP }, { sample: at(r, 0.15), track: 0, act: TAPE_PLAY_STOP },
      ]);
      const step = maxStep(x, 1, x.length);
      report(d.state[0] === PLAYING && step <= own * 1.5 && rms(x, Math.round(0.8 * rate)) > 0.01,
        'stop/play/stop/play tapped quickly: no jump, and it plays', `worst step ${step.toFixed(4)} vs ${own.toFixed(4)}`);
    }
  }
  {
    const r = rig(), d = r.d;
    r.run(1, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
    r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
    r.run(0.3, () => 0);
    const own = maxStep(r.run(0.2, () => 0), 1, Math.round(0.2 * rate));
    d.setParam('tapeLevel', 0);
    const x = r.run(0.2, () => 0);
    report(maxStep(x, 1, x.length) <= own * 1.5 && rms(x, Math.round(0.15 * rate)) < 1e-3,
      'the tape level glides to a new setting (no step)', `worst step ${maxStep(x, 1, x.length).toFixed(4)} vs ${own.toFixed(4)}`);
  }
  {
    // A loud free take fills the track's memory; once cleared, a quantized take
    // with a gap on the same track must play silence in the gap, every pass,
    // without the gap ever being zeroed in one go.
    const grid = new GestureLooper();
    const r = rig({ grid }), d = r.d;
    r.run(3, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
    r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
    d.action(0, TAPE_CLEAR);
    r.run(0.5, () => 0);
    grid.setParam('quantize', 1); grid.setParam('bpm', 120);
    grid.transportOrigin = Math.ceil((r.pos * SIM_RATE) / rate); // a beat now
    const origin = (grid.transportOrigin * rate) / SIM_RATE, at = Math.round(origin + 0.5 * rate);
    r.run((at - r.pos) / rate, () => 0);
    r.run(1.6, () => 0, [{ sample: at, track: 0, act: TAPE_RECORD }, { sample: at + Math.round(1.2 * rate), track: 0, act: TAPE_RECORD }]);
    const passes = r.run(4.2, () => 0);
    const len = d.length[0], first = mod0(origin + len - (r.pos - passes.length), len);
    const gapRms = [0, 1].map((p) => rms(passes, first + p * len, first + p * len + Math.round(0.45 * rate)));
    report(d.state[0] === PLAYING && gapRms.every((v) => v === 0), 'a reused track\'s gap is silence, on every pass',
      `gap rms ${gapRms.map((v) => v.toExponential(1)).join(', ')}`);
  }
}
function mod0(a, n) { const m = a % n; return m < 0 ? m + n : m; }

console.log('\n12. Loops and tapes share one grid');
{
  const rate = 48000, inst = new Instrument({ sampleRate: rate, seed: 3 });
  inst.setStones([0.5], [0.5], [220], 1);
  const send = (...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  const L = new Float32Array(128), R = new Float32Array(128);
  const run = (seconds) => { for (let k = 0; k < Math.round((seconds * rate) / 128); k++) inst.process(L, R, 128); };
  send(EV_PARAM, PARAM_KEYS.indexOf('quantize'), 1);
  // A quantized loop starts the grid; a quantized tape joins it.
  send(EV_LOOP, 0, LOOP_RECORD); run(0.3); send(EV_DROP, 0.5, 0.5, 1); run(1.5); send(EV_LOOP, 0, LOOP_RECORD); run(0.1);
  const grid = inst.looper.transportOrigin;
  send(EV_TAPE, 0, TAPE_RECORD); run(1); send(EV_TAPE, 0, TAPE_RECORD); run(3);
  report(grid >= 0 && inst.tape.state[0] === PLAYING && inst.tape.onGrid[0] === 1, 'a quantized tape joins the grid a loop started');
  // Clearing every loop keeps the grid while the tape is on it ...
  send(EV_LOOP, 0, LOOP_CLEAR_ALL); run(0.1);
  report(inst.looper.transportOrigin === grid, 'clearing all loops keeps the grid while a tape is on it',
    `grid origin ${grid} → ${inst.looper.transportOrigin}`);
  // ... and the last tape off it frees it.
  send(EV_TAPE, 0, TAPE_CLEAR_ALL); run(0.5);
  report(inst.tape.state[0] === EMPTY && inst.looper.transportOrigin === grid, 'with quantize still on, the beat keeps running after the last tape goes',
    `tape state ${inst.tape.state[0]}, grid origin ${inst.looper.transportOrigin}`);
  send(EV_PARAM, PARAM_KEYS.indexOf('quantize'), 0); run(0.1);
  report(inst.looper.transportOrigin === -1, 'quantize off, nothing on the grid: the grid is free', `grid origin ${inst.looper.transportOrigin}`);
}

// Energy within ±50 cents of `hz`.
function bandEnergy(x, fs, hz, size = 1 << 17) {
  const mag = spectrum(x, size), bin = fs / size;
  let e = 0;
  for (let i = 1; i < mag.length; i++) if (Math.abs(cents(i * bin, hz)) < 50) e += mag[i] * mag[i];
  return e;
}
console.log('\n14. A tape keeps the tuning it was recorded in');
{
  // One stone at 220 Hz rings onto a tape; then the stone is retuned to
  // 330 Hz. Once the water is still, all you hear is the tape: still 220 Hz,
  // the recording untouched.
  const rate = 48000, inst = new Instrument({ sampleRate: rate, seed: 4 });
  inst.setParam('decay', 1); inst.setParam('splash', 0);
  inst.setStones([0.5], [0.5], [220], 1);
  const send = (...v) => { const d = new Float32Array(8); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  const L = new Float32Array(128), R = new Float32Array(128);
  const run = (seconds, keep) => { const out = []; for (let k = 0; k < Math.round((seconds * rate) / 128); k++) { inst.process(L, R, 128); if (keep) out.push(...L); } return Float64Array.from(out); };
  send(EV_TAPE, 0, TAPE_RECORD);
  send(EV_DROP, 0.45, 0.5, 2);
  run(2);
  send(EV_TAPE, 0, TAPE_RECORD);
  run(0.01);
  const len = inst.tape.length[0], before = inst.tape.L.slice(0, len);
  inst.setStones([0.5], [0.5], [330], 1); // retune
  run(12); // the water and the stone fall silent; the tape plays on
  const heard = run(2, true);
  const same = inst.tape.L.slice(0, len).every((v, i) => v === before[i]);
  const e220 = bandEnergy(heard, rate, 220), e330 = bandEnergy(heard, rate, 330);
  report(same && inst.bells.activeVoices() === 0 && e220 > 1e3 * e330 && rms(heard) > 1e-3,
    'retuning never touches a tape: it plays what it recorded',
    `recording unchanged: ${same}; 330 Hz ${(10 * Math.log10(e330 / e220)).toFixed(0)} dB re 220 Hz`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll tape checks passed.');
process.exit(failures ? 1 : 0);
