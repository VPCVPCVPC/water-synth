// check-tape.mjs — checks for the audio looper ("a tape beside the pond"):
// recording the water's sound, playing it back fixed, overdub, mute, stop and
// clear, the loop seam, the shared quantize grid with the gesture looper, and
// that nothing depends on the block size or the sample rate.
//   node check-tape.mjs

import {
  TapeDeck, TAPE_TRACKS, TAPE_FIELDS, TAPE_PARAMS, MAX_TAPE_SECONDS, TAPE_MIX_GAIN,
  EMPTY, RECORDING, PLAYING, OVERDUB, STOPPED,
  TAPE_RECORD, TAPE_PLAY_STOP, TAPE_MUTE, TAPE_CLEAR, TAPE_CLEAR_ALL,
} from './tape.js';
import { GestureLooper } from './looper.js';
import { Instrument, PARAMS, PARAM_KEYS } from './instrument.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { EV_DROP, EV_TAPE, EV_LOOP, EV_PARAM, EV_TAPE_FADER, EV_STROKE, EV_STILL, EV_STIR } from './ring.js';
import { LOOP_RECORD, LOOP_CLEAR_ALL } from './looper.js';
import { FRAME_TAPES } from './visuals.js';
import { SIM_RATE } from './surface.js';
import { performance } from 'node:perf_hooks';
import { cents, spectrum, measurePitch, fftSize } from './check-lib.mjs';

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
// tape mix stays well under full scale (so checks can add signals up).
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
        // Record primes a track until the water next rings a stone; these
        // checks ring one (rang()) at the same moment (unless an action says
        // touch: false — §16 checks priming itself).
        while (q < actions.length && actions[q].sample <= pos) {
          const a = actions[q++];
          d.now = pos;
          d.action(a.track, a.act);
          if (a.act === TAPE_RECORD && a.touch !== false) d.rang();
        }
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
    follows = Math.max(follows, Math.abs(p1[i] - TAPE_MIX_GAIN * TONE(lp / rate))); // played back a fixed −3 dB under the water
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
    worst = Math.max(worst, Math.abs(mixed[i] - (loud(at / rate) + TAPE_MIX_GAIN * TONE(lp / rate))));
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

// ---- 6. Tapes sit on the beats of the gesture looper's grid --------------------------
// Always — quantize is for notes only (Dash, Oct 2026); it stays off here.
console.log('\n6. Tapes follow the beat, in whole beats of their own lengths');
{
  const rate = 48000, grid = new GestureLooper();
  grid.setParam('bpm', 120); // a beat is 0.5 s
  grid.transportOrigin = 1000; // 1 s of stream time
  const r = rig({ grid }), d = r.d;
  const beat = (60 * rate) / grid.bpm, origin = (grid.transportOrigin * rate) / SIM_RATE;
  // Started at 1.3 s: the take starts on the beat at 1 s; finish at 2.7 s —
  // a little late — ends on the nearest beat, the one just gone at 2.5 s:
  // 3 beats, the first 0.3 s silence.
  const at = Math.round(1.3 * rate);
  r.run(1.4, TONE, [{ sample: at, track: 0, act: TAPE_RECORD }]);
  r.run(1.61, TONE, [{ sample: at + Math.round(1.4 * rate), track: 0, act: TAPE_RECORD }]);
  const len = d.length[0], gap = at - origin;
  report(d.onGrid[0] === 1 && d.origin[0] === origin && Math.abs(len - 3 * beat) < 1,
    'a take starts on a beat; finished a little late, it ends on the beat just gone (the reach to the key isn\'t kept)',
    `origin ${d.origin[0]} (a beat), length ${(len / rate).toFixed(3)} s = ${(len / beat).toFixed(2)} beats`);
  report(d.state[0] === PLAYING && d.usesGrid() && grid.quantize === 0, 'the tape keeps the shared grid (with quantize off)');
  // From the loop's next top: the silence, then the take.
  const top = origin + Math.ceil((r.pos - origin) / len) * len;
  r.run((top - r.pos) / rate, () => 0);
  const play = r.run(0.6, () => 0);
  const inGap = rms(play, 0, Math.round(gap * 0.8));
  const after = rms(play, Math.round(gap + 0.03 * rate), Math.round(gap + 0.3 * rate));
  report(inGap < 1e-7 && after > 0.02, 'the silence before the take is part of the loop',
    `gap rms ${inGap.toExponential(1)}, then ${after.toFixed(4)}`);
  // A second tape, 3 beats long: a different length, still on the beat.
  const t1 = Math.round(origin + 9.4 * beat); // finish at 11.6 beats: a little early, it records on to the beat
  r.run((t1 - r.pos) / rate + 0.01, TONE, [{ sample: t1, track: 1, act: TAPE_RECORD }]);
  r.run(1.6, TONE, [{ sample: Math.round(origin + 11.6 * beat), track: 1, act: TAPE_RECORD }]);
  const len1 = d.length[1];
  report(Math.abs(len1 - 3 * beat) < 1 && Math.abs((d.origin[1] - origin) / beat - 9) < 1e-6,
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
  d.action(1, TAPE_RECORD); d.rang();
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

  // A track's fader travels the event path to the deck (and bad ones don't).
  send(EV_TAPE_FADER, 2, 0.25);
  send(EV_TAPE_FADER, 9, 0.5);
  send(EV_TAPE_FADER, 1, NaN);
  report(inst.tape.fader[2] === 0.25 && inst.tape.fader[1] === 1, 'a track\'s fader reaches the deck through the event path (bad ones are ignored)');
  send(EV_TAPE_FADER, 2, 1);

  // Record a second of the water's own sound through the event path.
  send(EV_DROP, 0.5, 0.5, 2);
  for (let k = 0; k < 40; k++) inst.process(L, R, 128); // let the drop ring the stones
  send(EV_TAPE, 0, TAPE_RECORD);
  send(EV_DROP, 0.3, 0.6, 1); // (the water is still ringing stones: the primed take starts on the next one)
  const capturedFrom = inst.tape.now, captured = []; // the stream sample captured[0] is
  for (let k = 0; k < Math.round(rate / 128); k++) {
    inst.process(L, R, 128);
    for (let i = 0; i < 128; i++) captured.push(L[i]);
  }
  send(EV_TAPE, 0, TAPE_RECORD); // finish the take
  // It ends on the nearest beat (≤ half a beat on); what's heard until then is kept too.
  for (let k = 0; k < Math.round((0.5 * rate) / 128); k++) {
    const recording = inst.tape.state[0] === RECORDING;
    inst.process(L, R, 128);
    if (recording) for (let i = 0; i < 128; i++) captured.push(L[i]);
  }
  const len = inst.tape.length[0];
  report(inst.tape.state[0] === PLAYING && len > 0,
    'a take recorded through EV_TAPE and finished plays', `state ${inst.tape.state[0]}, ${(len / rate).toFixed(2)} s`);

  // The tape holds exactly what the instrument output, sample for sample
  // (except the seam, which blends in the sound from before the take).
  let worst = 0;
  // (The take starts on the grid's step at or just before the stone that
  // started it: a little silence leads the tape. Tape sample k is stream
  // sample origin + k.)
  const origin = inst.tape.origin[0], lead = Math.round(inst.tape.takeStart[0] - origin);
  for (let k = lead; k < len - 480; k++) worst = Math.max(worst, Math.abs(inst.tape.L[k] - captured[origin + k - capturedFrom]));
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
  send(EV_TAPE, 0, TAPE_RECORD); send(EV_DROP, 0.5, 0.5, 1); run(1); send(EV_TAPE, 0, TAPE_RECORD); run(3);
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

console.log('\n15. Each track\'s fader');
{
  const rate = 48000;
  const take = (fader) => {
    const r = rig(), d = r.d;
    if (fader !== undefined) d.setFader(0, fader);
    r.run(2, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
    r.run(0.001, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
    r.run(0.3, () => 0);
    return { r, d };
  };
  // Halfway: half as loud, once it has glided there.
  {
    const { r, d } = take();
    const full = rms(r.run(2, () => 0)); // whole passes of the 2 s loop (its loudness varies along it)
    d.setFader(0, 0.5);
    r.run(2, () => 0); // glided there, and back at the same place in the loop
    const half = rms(r.run(2, () => 0));
    report(Math.abs(half / full - 0.5) < 0.02, 'a fader at halfway plays the track at half level', `${(half / full).toFixed(3)} of full`);
  }
  // Pulled straight down: a glide, not a cut; silent within a fraction of a second.
  {
    const { r, d } = take();
    const own = maxStep(r.run(0.2, () => 0), 1, Math.round(0.2 * rate));
    d.setFader(0, 0);
    const x = r.run(0.5, () => 0);
    const step = maxStep(x, 1, x.length);
    report(step <= own * 1.5 && peak(x, Math.round(0.25 * rate)) < 1e-4,
      'a fader pulled down at once glides out (no click) and falls silent', `worst step ${step.toFixed(4)} vs the tape's own ${own.toFixed(4)}`);
    d.setFader(0, 1);
    r.run(0.2, () => 0);
    report(rms(r.run(0.5, () => 0)) > 0.05, 'pushed back up, the track plays again (a fader isn\'t a stop)');
  }
  // Recording with the fader down still records the water at full level.
  {
    const { r, d } = take(0);
    d.setFader(0, 1);
    r.run(1, () => 0); // the fader's glide fully settled
    const len = d.length[0], origin = d.origin[0], x0 = r.pos;
    const x = r.run(0.5, () => 0);
    let worst = 0;
    for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - TAPE_MIX_GAIN * TONE(((x0 + i - origin) % len) / rate)));
    report(worst < 1e-6, 'a take recorded with the fader down still holds the water at full level (the fader is only what you hear)',
      `max difference ${worst.toExponential(1)}`);
  }
  // Tracks are independent; mute and fader are separate.
  {
    const r = rig(), d = r.d;
    for (const t of [0, 1]) {
      r.run(1, TONE, [{ sample: r.pos, track: t, act: TAPE_RECORD }]);
      r.run(0.001, () => 0, [{ sample: r.pos, track: t, act: TAPE_RECORD }]);
    }
    d.setFader(0, 0);
    r.run(0.3, () => 0);
    const one = rms(r.run(1, () => 0));
    d.action(1, TAPE_MUTE);
    r.run(0.5, () => 0);
    const none = peak(r.run(0.5, () => 0));
    d.action(1, TAPE_MUTE);
    r.run(0.3, () => 0);
    const back = rms(r.run(1, () => 0));
    report(one > 0.05 && none < 1e-4 && Math.abs(back / one - 1) < 0.05 && d.fader[0] === 0,
      'each track has its own fader; muting and unmuting leave the fader where it was',
      `track 2 alone ${one.toFixed(3)}, muted ${none.toExponential(1)}, unmuted ${back.toFixed(3)}`);
  }
  // Bad input is ignored; a cleared track keeps its fader.
  {
    const { r, d } = take();
    d.setFader(0, 0.3);
    for (const [t, v] of [[-1, 0.5], [4, 0.5], [0.5, 0.5], [0, NaN], [0, Infinity]]) d.setFader(t, v);
    d.setFader(1, 7);
    d.action(0, TAPE_CLEAR);
    r.run(1, () => 0);
    report(d.fader[0] === 0.3 && d.fader[1] === 1 && d.state[0] === EMPTY, 'bad fader moves are ignored (or clamped); a cleared track keeps its fader');
  }
}

// ---- 16. Primed: record waits for the first stone the water rings -----------------------------------------
console.log('\n16. Record primes; the first stone the water rings starts the take');
{
  const rate = 48000, grid = new GestureLooper();
  grid.setParam('bpm', 120);
  const r = rig({ grid }), d = r.d;
  const status = () => { const f = new Float32Array(TAPE_FIELDS * TAPE_TRACKS); d.writeStatus(f, 0); return f; };
  r.run(0.5, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD, touch: false }]);
  report(d.state[0] === EMPTY && d.primed[0] === 1 && status()[4] === 2,
    'record on an empty track primes it: nothing recorded yet, and the page is told (waiting = 2)');
  d.now = r.pos; d.rang(); const touchAt = r.pos;
  r.run(0.1, TONE);
  report(d.state[0] === RECORDING && d.primed[0] === 0 && d.takeStart[0] === touchAt,
    'the first stone heard starts the take right then', `take starts at ${d.takeStart[0]}, touched at ${touchAt}`);
  report(grid.transportOrigin >= 0 && Math.abs(d.origin[0] - (grid.transportOrigin * rate) / SIM_RATE) < 1e-6 && touchAt - d.origin[0] < rate / SIM_RATE,
    'with no beat yet, the first take starts it: the touch is the downbeat', `origin ${d.origin[0]}, touch ${touchAt}`);
  r.run(1.9, TONE, [{ sample: r.pos + 1, track: 0, act: TAPE_RECORD }]);
  report(d.state[0] === PLAYING, 'and record finishes it as before');

  // Record again while primed lets it go: a later touch starts nothing.
  r.run(0.1, TONE, [{ sample: r.pos, track: 1, act: TAPE_RECORD, touch: false }, { sample: r.pos + 10, track: 1, act: TAPE_RECORD, touch: false }]);
  d.now = r.pos; d.rang(); r.run(0.1, TONE);
  report(d.state[1] === EMPTY && d.primed[1] === 0, 'record again while primed cancels it');
  // Mute leaves it primed; play/stop and clear let it go.
  r.run(0.05, TONE, [{ sample: r.pos, track: 1, act: TAPE_RECORD, touch: false }, { sample: r.pos + 5, track: 1, act: TAPE_MUTE }]);
  const keptByMute = d.primed[1] === 1;
  r.run(0.05, TONE, [{ sample: r.pos, track: 1, act: TAPE_PLAY_STOP }]);
  const goneByStop = d.primed[1] === 0;
  r.run(0.05, TONE, [{ sample: r.pos, track: 1, act: TAPE_RECORD, touch: false }, { sample: r.pos + 5, track: 2, act: TAPE_RECORD, touch: false }]);
  r.run(0.05, TONE, [{ sample: r.pos, track: 0, act: TAPE_CLEAR_ALL }]);
  report(keptByMute && goneByStop && d.primed[1] === 0 && d.primed[2] === 0, 'mute keeps a track primed; stop and clear all let it go');
  r.run(0.5, () => 0);
}
{
  // Overdub primes the same way.
  const rate = 48000, grid = new GestureLooper();
  const r = rig({ grid }), d = r.d;
  r.run(1, TONE, [{ sample: 0, track: 0, act: TAPE_RECORD }]);
  r.run(1, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  r.run(0.5, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD, touch: false }]);
  const waited = d.state[0] === PLAYING && d.primed[0] === 1;
  d.now = r.pos; d.rang(); r.run(0.05, () => 0);
  report(waited && d.state[0] === OVERDUB, 'record on a playing tape primes an overdub; the first stone rung starts it', `state ${d.state[0]}`);
}
{
  // A finish rounded back to the beat just gone starts the loop mid-way: the
  // silence before the take must still be silence — even on a track that
  // held a louder take before (its old sound is still in memory).
  const rate = 48000, grid = new GestureLooper();
  grid.setParam('bpm', 120); grid.transportOrigin = 0; // a beat is 0.5 s, from 0
  const r = rig({ grid }), d = r.d, beat = 0.5 * rate;
  grid.gridUser = d; // as in the instrument: a tape on the grid keeps it
  const LOUD = (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t);
  // Track 2 holds the beat throughout (muted), so the re-recorded take has a gap.
  r.run(1, () => 0, [{ sample: 0, track: 1, act: TAPE_RECORD }]);
  r.run(0.01, () => 0, [{ sample: r.pos, track: 1, act: TAPE_RECORD }, { sample: r.pos, track: 1, act: TAPE_MUTE }]);
  r.run(2, LOUD, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  r.run(0.5, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  r.run(1, () => 0, [{ sample: r.pos, track: 0, act: TAPE_CLEAR }]);
  // Silent take: touched 0.15 beat after a beat, finished 2.3 beats later (→ 2 beats).
  const b0 = Math.ceil(r.pos / beat) * beat;
  r.run((b0 - r.pos) / rate, () => 0);
  r.run(2.3 * 0.5, () => 0, [{ sample: b0 + Math.round(0.15 * beat), track: 0, act: TAPE_RECORD }]);
  r.run(0.01, () => 0, [{ sample: r.pos, track: 0, act: TAPE_RECORD }]);
  const out = r.run(3, () => 0);
  report(d.state[0] === PLAYING && Math.abs(d.length[0] - 2 * beat) < 1 && peak(out) < 1e-6,
    'a late finish rounded back to the beat: the gap before the take stays silent (no old take in it)',
    `length ${(d.length[0] / beat).toFixed(2)} beats, peak ${peak(out).toExponential(1)}`);

  // Begun just before a beat and finished just after the next: rounding back
  // would leave almost nothing — it records on to the following beat instead.
  const r2 = rig({ grid: new GestureLooper() }), d2 = r2.d;
  r2.d.grid.setParam('bpm', 120); r2.d.grid.transportOrigin = 0;
  r2.run(0.5, TONE, [{ sample: Math.round(0.98 * beat), track: 0, act: TAPE_RECORD }]);
  r2.run(0.6, TONE, [{ sample: Math.round(1.2 * beat), track: 0, act: TAPE_RECORD }]);
  report(d2.state[0] === PLAYING && Math.abs(d2.length[0] - 2 * beat) < 1,
    'a take begun just before a beat is never rounded down to nothing', `state ${d2.state[0]}, ${(d2.length[0] / beat).toFixed(2)} beats`);
}
{
  // Through the instrument: a primed take starts when the water first rings a
  // stone (Dash, Oct 2026), at that very sample — not on the touch.
  const rate = 48000, inst = new Instrument({ sampleRate: rate, seed: 6 });
  inst.setParam('splash', 0);
  inst.setStones([0.85], [0.5], [220], 1);
  const send = (...v) => { const e = new Float32Array(8); v.forEach((x, i) => { e[i] = x; }); inst.handleEvent(e, 0); };
  const L = new Float32Array(128), R = new Float32Array(128);
  let firstStrike = -1;
  const strike = inst.bells.strike.bind(inst.bells);
  inst.bells.strike = (k, hz, v, p, at) => { const ok = strike(k, hz, v, p, at); if (ok && firstStrike < 0) firstStrike = inst.blockStart + at; return ok; };
  send(EV_TAPE, 0, TAPE_RECORD);
  send(EV_DROP, 0.15, 0.5, 1); // far from the stone: the ripple takes a while to reach it
  for (let k = 0; k < 4; k++) inst.process(L, R, 128);
  const waitingAfterTouch = inst.tape.state[0] === EMPTY && inst.tape.primed[0] === 1 && firstStrike < 0;
  let blocks = 0;
  while (firstStrike < 0 && blocks++ < 2000) inst.process(L, R, 128);
  report(waitingAfterTouch && firstStrike >= 0 && inst.tape.state[0] === RECORDING && inst.tape.takeStart[0] === firstStrike,
    'a touch alone doesn\'t start a primed take; the first stone the water rings does, at that sample',
    `primed after the touch: ${waitingAfterTouch}; stone rang at ${firstStrike}, take starts ${inst.tape.takeStart[0]}`);
}

{
  // The same, with a stone already ringing when the take is primed (so it
  // starts mid-block, on that stone's sample), as a first take and as an
  // overdub: tape and output must not depend on the block size.
  const render = (block, overdub) => {
    const rate = 48000, inst = new Instrument({ sampleRate: rate, seed: 8 });
    inst.setParam('splash', 0);
    inst.setStones([0.3, 0.75], [0.5, 0.5], [220, 330], 2);
    const send = (...v) => { const e = new Float32Array(8); v.forEach((x, i) => { e[i] = x; }); inst.handleEvent(e, 0); };
    const L = new Float32Array(block), R = new Float32Array(block), out = [];
    const run = (seconds) => { const n = Math.round((seconds * rate) / 6144) * 6144; for (let k = 0; k < n; k += block) { inst.process(L, R, block); out.push(...L); } };
    send(EV_DROP, 0.5, 0.5, 1.5);
    run(0.768);
    if (overdub) { send(EV_TAPE, 0, TAPE_RECORD); run(0.128); send(EV_TAPE, 0, TAPE_RECORD); run(1.536); send(EV_DROP, 0.4, 0.4, 1); run(0.256); }
    send(EV_TAPE, 0, TAPE_RECORD); // primed: the next stone the water rings starts it
    run(1.536);
    send(EV_TAPE, 0, TAPE_RECORD);
    run(1.536);
    return { out, tape: Array.from(inst.tape.L.subarray(0, inst.tape.length[0])), start: inst.tape.takeStart[0] };
  };
  for (const overdub of [false, true]) {
    const runs = [64, 128, 1024, 6144].map((b) => render(b, overdub));
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const ok = runs.every((r) => same(r.out, runs[0].out) && same(r.tape, runs[0].tape) && r.start === runs[0].start);
    report(ok, `${overdub ? 'an overdub' : 'a first take'} started by a stone mid-block: tape and output identical at block sizes 64, 128, 1024 and 6144`,
      `take starts at ${runs.map((r) => r.start).join(' / ')}`);
  }
}

// ---- 17. Tapes follow the tempo, keeping their pitch -------------------------------------
console.log('\n17. Tapes follow the tempo (Dash: "Recorded tapes should follow tempo changes!"), keeping pitch');
{
  // A deck with a real grid that steps as the stream runs (so the tempo can glide).
  const tempoRig = (block = 128, rate = 48000) => {
    const grid = new GestureLooper();
    grid.setParam('bpm', 120);
    const d = new TapeDeck({ sampleRate: rate, grid });
    grid.gridUser = d;
    let pos = 0, step = -1;
    const L = new Float32Array(block), R = new Float32Array(block);
    const run = (seconds, live = () => 0, at = []) => {
      const end = pos + Math.round(seconds * rate), out = new Float64Array(end - pos), start = pos;
      let q = 0;
      while (pos < end) {
        while (q < at.length && at[q].sample <= pos) at[q++].fn();
        let m = Math.min(block, end - pos);
        if (q < at.length && at[q].sample < pos + m) m = at[q].sample - pos;
        const last = Math.floor(((pos + m - 1) * SIM_RATE) / rate);
        while (step < last) grid.onStep(++step, null); // the grid runs ahead of the tape, as in the instrument
        for (let i = 0; i < m; i++) { const v = live((pos + i) / rate); L[i] = v; R[i] = v; }
        d.now = pos;
        d.process(L, R, m);
        for (let i = 0; i < m; i++) out[pos - start + i] = L[i];
        pos += m;
      }
      return out;
    };
    return { d, grid, rate, run, get pos() { return pos; } };
  };
  const sine = (hz, a = 0.3) => (t) => a * Math.sin(2 * Math.PI * hz * t);
  // Record 4 beats of 440 Hz at 120 bpm (2 s), starting the grid with it.
  const take = (block) => {
    const T = tempoRig(block);
    T.run(0.1, () => 0, [{ sample: 0, fn: () => { T.d.action(0, TAPE_RECORD); T.d.rang(); } }]);
    T.run(1.9, sine(440));
    T.run(0.5, sine(440), [{ sample: T.pos, fn: () => T.d.action(0, TAPE_RECORD) }]);
    return T;
  };
  {
    const T = take(128), d = T.d;
    const lenBefore = d.length[0];
    T.grid.setParam('bpm', 90);
    T.run(3); // the glide settles
    const out = T.run(4);
    const p = measurePitch(out, T.rate, 440, fftSize(T.rate));
    report(d.state[0] === PLAYING && d.recBpm[0] === 120 && p.hz && Math.abs(cents(p.hz, 440)) < 3,
      'at 90 bpm, a tape recorded at 120 still sounds at its own pitch', p.hz ? `${p.hz.toFixed(2)} Hz (${cents(p.hz, 440).toFixed(2)}¢), recorded at ${d.recBpm[0]} bpm` : p.error);
    // Stays on the beat: the playhead, in beats, matches the grid's beats since the loop's top.
    const f = new Float32Array(TAPE_FIELDS * TAPE_TRACKS); d.writeStatus(f, 0);
    const loopSec = f[2], beatSec = 60 / T.grid.bpm;
    report(lenBefore === d.length[0] && Math.abs(loopSec / beatSec - 4) < 0.01,
      'the 4-beat loop now lasts 4 beats at 90 bpm (2.67 s), the tape itself unchanged', `${loopSec.toFixed(3)} s = ${(loopSec / beatSec).toFixed(3)} beats`);
    const tapeBeats = (f[3] / beatSec) % 4, gridBeats = ((T.grid.beatPosition() % 4) + 4) % 4;
    const diff = Math.min(Math.abs(tapeBeats - gridBeats), 4 - Math.abs(tapeBeats - gridBeats));
    report(diff < 0.02, 'after the glide, the tape is still on the beat', `tape at beat ${tapeBeats.toFixed(3)} of 4, grid at ${gridBeats.toFixed(3)}`);
  }
  {
    // CPU: four tapes, all following a different tempo (the grain alignment
    // is the cost), per 128-sample block.
    const T = tempoRig(128), d = T.d;
    for (let k = 0; k < 4; k++) {
      T.run(0.05, () => 0, [{ sample: T.pos, fn: () => { d.action(k, TAPE_RECORD); d.rang(); } }]);
      T.run(1.95, sine(220 * (k + 1)));
      T.run(0.6, () => 0, [{ sample: T.pos, fn: () => d.action(k, TAPE_RECORD) }]);
    }
    T.grid.setParam('bpm', 97);
    T.run(3);
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) { const t0 = performance.now(); T.run(2); best = Math.min(best, ((performance.now() - t0) * 1000) / ((2 * 48000) / 128)); }
    report(d.state.every((x) => x === PLAYING) && best / 2667 < 0.15, `4 tapes following the tempo: ${best.toFixed(0)} µs/block, ${((best / 2667) * 100).toFixed(1)}%`, 'limit 15%');
  }
  {
    // Stale audio must never come back: a re-recording whose tempo glides
    // mid-pass writes every sample of the new loop, and a gap the playhead
    // races through (tempo up during the first pass) is still all silence.
    const T = take(128), d = T.d;
    d.L.fill(4, d.spare * d.capacity, (d.spare + 1) * d.capacity); d.R.fill(4, d.spare * d.capacity, (d.spare + 1) * d.capacity); // an old take in the spare
    T.grid.setParam('bpm', 90); T.run(3);
    T.run(0.01, () => 0, [{ sample: T.pos, fn: () => { d.action(0, TAPE_RECORD); d.rang(); } }]);
    T.run(1, sine(660, 0.2));
    T.grid.setParam('bpm', 150); // mid-pass
    T.run(4, sine(660, 0.2));
    T.run(0.01, () => 0, [{ sample: T.pos, fn: () => d.action(0, TAPE_RECORD) }]);
    const out = T.run(4);
    report(peak(out) < 1, 'a re-recording that glides mid-pass leaves nothing of an older take', `peak ${peak(out).toFixed(3)}`);
  }
  {
    const T = tempoRig(128), d = T.d;
    d.L.fill(5, 0, d.capacity); d.R.fill(5, 0, d.capacity); // an old take where the gap will be
    T.grid.setParam('quantize', 1); T.run(0.3); // a beat running, so the take starts late in it (a gap)
    T.run(0.5, () => 0, [{ sample: T.pos + Math.round(0.2 * T.rate), fn: () => { d.action(0, TAPE_RECORD); d.rang(); } }]);
    T.run(1.6, sine(440));
    T.run(0.6, sine(440), [{ sample: T.pos, fn: () => d.action(0, TAPE_RECORD) }]);
    T.grid.setParam('bpm', 240); // through the gap at up to twice the speed
    const out = T.run(4);
    report(d.length[0] > 0 && peak(out) < 1, 'a gap raced through at twice the speed is still silence', `peak ${peak(out).toFixed(3)}`);
  }
  {
    // An overdub held through a glide: it waits while the tempo moves, then
    // re-records at the new tempo — the dub is kept, never dropped.
    const T = take(128), d = T.d;
    T.run(0.01, () => 0, [{ sample: T.pos, fn: () => { d.action(0, TAPE_RECORD); d.rang(); } }]); // dub at its own tempo
    T.run(0.5, sine(880, 0.3));
    T.grid.setParam('bpm', 150);
    T.run(8, sine(880, 0.3)); // through the glide and a pass at 150
    let top = 0;
    for (let i = 0; i < d.length[0]; i++) top = Math.max(top, Math.abs(d.L[d.slot[0] * d.capacity + i]));
    report(d.recBpm[0] === 150 && top > 0.5, 'an overdub held through a glide re-records at the new tempo and keeps the dub', `recorded at ${d.recBpm[0]} bpm, tape peak ${top.toFixed(2)}`);
  }
  {
    // CPU at 192 kHz: the search costs the same as at 48 kHz.
    const T = tempoRig(128, 192000), d = T.d;
    for (let k = 0; k < 4; k++) {
      T.run(0.05, () => 0, [{ sample: T.pos, fn: () => { d.action(k, TAPE_RECORD); d.rang(); } }]);
      T.run(1.95, sine(220 * (k + 1)));
      T.run(0.6, () => 0, [{ sample: T.pos, fn: () => d.action(k, TAPE_RECORD) }]);
    }
    T.grid.setParam('bpm', 97); T.run(2);
    let worst = 0;
    const t0 = performance.now(), blocks = (2 * 192000) / 128;
    for (let b = 0; b < blocks; b++) { const s0 = performance.now(); T.run(128 / 192000); worst = Math.max(worst, performance.now() - s0); }
    const avg = ((performance.now() - t0) * 1000) / blocks, budget = (128 / 192000) * 1e6;
    report(avg / budget < 0.3, `4 tapes following the tempo at 192 kHz: ${avg.toFixed(0)} µs/block on average, ${((avg / budget) * 100).toFixed(1)}% (worst block ${(worst * 1000).toFixed(0)} µs)`, 'limit 30%');
  }
  {
    // The same glide at block sizes 64 and 1024: identical output.
    const a = take(64), b = take(1024);
    a.grid.setParam('bpm', 150); b.grid.setParam('bpm', 150);
    const oa = a.run(3), ob = b.run(3);
    let same = oa.length === ob.length;
    for (let i = 0; same && i < oa.length; i++) if (oa[i] !== ob[i]) same = false;
    report(same, 'gliding to 150 bpm: identical at block sizes 64 and 1024');
  }
  {
    // Overdub at a new tempo: the track is re-recorded at it, and both layers keep their pitch.
    const T = take(128), d = T.d;
    T.grid.setParam('bpm', 90);
    T.run(3);
    T.run(0.01, () => 0, [{ sample: T.pos, fn: () => { d.action(0, TAPE_RECORD); d.rang(); } }]);
    T.run(3, sine(660, 0.2)); // a pass and a bit (4 beats at 90 = 2.67 s)
    T.run(0.01, () => 0, [{ sample: T.pos, fn: () => d.action(0, TAPE_RECORD) }]); // end the dub
    const beat90 = (60 * T.rate) / 90;
    report(d.recBpm[0] === 90 && Math.abs(d.length[0] - 4 * beat90) < 2 && d.bounceT === -1,
      'an overdub at 90 bpm re-records the track at 90 (4 beats long), then carries on as usual', `recorded at ${d.recBpm[0]} bpm, ${(d.length[0] / beat90).toFixed(3)} beats`);
    T.grid.setParam('bpm', 120);
    T.run(3);
    const out = T.run(4);
    // (Each tone's own peak, within ±60¢ — two tones at once, so not measurePitch's lowest-partial guard.)
    const size = fftSize(T.rate), mag = spectrum(out, size), bin = T.rate / size;
    const peakNear = (hz) => {
      const lo = Math.floor((hz * 2 ** (-60 / 1200)) / bin), hi = Math.ceil((hz * 2 ** (60 / 1200)) / bin);
      let k = lo; for (let i = lo; i <= hi; i++) if (mag[i] > mag[k]) k = i;
      if (k <= lo || k >= hi) return { error: 'no peak' };
      const a = Math.log(mag[k - 1]), b = Math.log(mag[k]), c = Math.log(mag[k + 1]);
      return { hz: (k + (0.5 * (a - c)) / (a - 2 * b + c)) * bin };
    };
    const p1 = peakNear(440), p2 = peakNear(660);
    report(p1.hz && p2.hz && Math.abs(cents(p1.hz, 440)) < 3 && Math.abs(cents(p2.hz, 660)) < 3,
      'back at 120 bpm, the old layer and the dub are both at their own pitch',
      `${p1.hz ? p1.hz.toFixed(2) : p1.error} Hz, ${p2.hz ? p2.hz.toFixed(2) : p2.error} Hz`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll tape checks passed.');
process.exit(failures ? 1 : 0);
