// check-looper.mjs — checks for the gesture looper (looper.js) inside the
// whole instrument, driven exactly as the page drives it (queue events).
//   node check-looper.mjs

import { Instrument } from './instrument.js';
import { SIM_RATE } from './surface.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { EV_DROP, EV_STROKE, EV_LOOP, EV_PARAM } from './ring.js';
import { PARAM_KEYS } from './instrument.js';
import { LOOP_RECORD, LOOP_PLAY_STOP, LOOP_MUTE, LOOP_CLEAR, LOOP_CLEAR_ALL, LOOP_EVENTS, MAX_LOOP_SECONDS, EMPTY, PLAYING, STOPPED } from './looper.js';
import { performance } from 'node:perf_hooks';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });

// An instrument at the calibration baseline, plus a log of every gesture the
// looper plays back (the step it lands on) and every strike.
function rig({ fs = 48000, seed = 1, block = 128 } = {}) {
  const inst = new Instrument({ sampleRate: fs, seed });
  const { xs, ys } = stonePositions(PENTA.length);
  inst.setStones(xs, ys, PENTA.map((p) => p.hz), PENTA.length);
  inst.setParam('waveSpeed', 64); inst.setParam('decay', 8); inst.setParam('splash', 0);
  const replays = [];
  const e = inst.engine, drop = e.drop.bind(e), trail = e.trail.bind(e);
  e.drop = (x, y, s, at) => { if (at !== undefined) replays.push({ step: Math.round(at * SIM_RATE), x, y, kind: 'drop' }); drop(x, y, s, at); };
  e.trail = (x0, y0, x1, y1, v, at) => { if (at !== undefined) replays.push({ step: Math.round(at * SIM_RATE), x: x0, y: y0, kind: 'trail' }); trail(x0, y0, x1, y1, v, at); };
  const strikes = [];
  const d = new Float32Array(8);
  const send = (...v) => { d.fill(0); v.forEach((x, i) => { d[i] = x; }); inst.handleEvent(d, 0); };
  const L = new Float32Array(block), R = new Float32Array(block);
  let sample = 0;
  // Run until `seconds` of stream time, applying timed actions on the way.
  // Blocks are split exactly at each action, so the same script gives the
  // same input at any sample rate or block size.
  const runTo = (seconds, actions = []) => {
    const queue = [...actions].sort((a, b) => a[0] - b[0]);
    let q = 0;
    const end = Math.round(seconds * fs);
    while (sample < end) {
      while (q < queue.length && Math.round(queue[q][0] * fs) <= sample) queue[q++][1]();
      const nextAction = q < queue.length ? Math.round(queue[q][0] * fs) : end;
      const n = Math.min(block, end - sample, nextAction - sample);
      inst.process(L, R, n);
      const st = inst.strikes;
      for (let i = 0; i < st.count; i++) strikes.push({ stone: st.stone[i], t: st.step[i] / SIM_RATE });
      sample += n;
    }
  };
  return {
    inst, replays, strikes, runTo, step: () => e.simStep,
    drop: (x, y, s = 1) => send(EV_DROP, x, y, s),
    stroke: (x0, y0, x1, y1, v) => send(EV_STROKE, x0, y0, x1, y1, v),
    loop: (layer, act) => send(EV_LOOP, layer, act),
    param: (k, v) => send(EV_PARAM, PARAM_KEYS.indexOf(k), v),
  };
}

// ---- 1. Record a loop; it replays every gesture at the same place every pass ----
console.log('\n1. Free loop: replays every gesture at the same loop position each pass');
{
  const r = rig();
  let recStart = 0;
  r.runTo(4.5, [
    [0.1, () => { r.loop(0, LOOP_RECORD); recStart = r.step() + 1; }],
    [0.2, () => r.drop(0.3, 0.4)],
    [0.5, () => r.stroke(0.6, 0.6, 0.65, 0.62, 1)],
    [0.9, () => r.drop(0.7, 0.3)],
    [1.1, () => r.loop(0, LOOP_RECORD)],
  ]);
  const len = r.inst.looper.length[0];
  const positions = r.replays.map((x) => (x.step - recStart) % len);
  const cycles = r.replays.map((x) => Math.floor((x.step - recStart) / len));
  const firstPass = positions.filter((_, i) => cycles[i] === 1);
  const allPasses = [1, 2, 3].map((c) => positions.filter((_, i) => cycles[i] === c).join(','));
  report(Math.abs(len - 1000) <= 1 && firstPass.length === 3 && allPasses.every((p) => p === allPasses[0]),
    '1 s take with a drop, a drag and a drop', `loop ${len} steps; positions each pass [${allPasses[0]}] ms; ${r.replays.length} replays`);

  // Each pass lands in water still moving from the last: phrases differ.
  const phrase = (c) => r.strikes.filter((s) => s.t >= (recStart + c * len) / SIM_RATE && s.t < (recStart + (c + 1) * len) / SIM_RATE).map((s) => s.stone).join(',');
  const p1 = phrase(1), p2 = phrase(2), p3 = phrase(3);
  report(p1 !== p2 && p2 !== p3 && p1.length > 0, 'each pass plays a different phrase (the water is already moving)',
    `pass 1 [${p1.slice(0, 30)}…], pass 2 [${p2.slice(0, 30)}…]`);
}

// ---- 2. Overdub, mute, stop/play, clear ---------------------------------------------
console.log('\n2. Overdub, mute, stop/play and clear');
{
  const r = rig();
  let recStart = 0;
  r.runTo(1.2, [
    [0.1, () => { r.loop(0, LOOP_RECORD); recStart = r.step() + 1; }],
    [0.3, () => r.drop(0.3, 0.4)],
    [1.1, () => r.loop(0, LOOP_RECORD)],
  ]);
  const len = r.inst.looper.length[0];
  // Overdub a second drop during pass 1 (heard live once, replayed from pass 2).
  const overdubAt = (recStart + len + 600) / SIM_RATE;
  r.runTo((recStart + 3 * len) / SIM_RATE + 0.05, [
    [(recStart + len + 100) / SIM_RATE, () => r.loop(0, LOOP_RECORD)],
    [overdubAt, () => r.drop(0.8, 0.8)],
    [(recStart + len + 900) / SIM_RATE, () => r.loop(0, LOOP_RECORD)],
  ]);
  const inPass = (c) => r.replays.filter((x) => Math.floor((x.step - recStart) / len) === c).length;
  report(inPass(1) === 1 && inPass(2) === 2 && r.inst.looper.count[0] === 2,
    'overdub: heard live, not replayed in the same pass, replays from the next', `replays per pass: 1:${inPass(1)}, 2:${inPass(2)}`);

  const before = r.replays.length;
  r.loop(0, LOOP_MUTE);
  r.runTo((recStart + 5 * len) / SIM_RATE + 0.05);
  const whileMuted = r.replays.length - before;
  r.loop(0, LOOP_MUTE);
  r.runTo((recStart + 6 * len) / SIM_RATE + 0.05);
  const afterUnmute = r.replays.slice(before + whileMuted);
  const inPhase = afterUnmute.every((x) => [r.inst.looper.time[0], r.inst.looper.time[1]].includes((x.step - recStart) % len));
  report(whileMuted === 0 && afterUnmute.length === 2 && inPhase, 'mute silences the loop and unmute resumes in phase',
    `replays while muted ${whileMuted}, after ${afterUnmute.length}`);

  r.loop(0, LOOP_PLAY_STOP);
  const stoppedAt = r.replays.length;
  r.runTo((recStart + 7 * len + 333) / SIM_RATE);
  const stopped = r.inst.looper.state[0] === STOPPED && r.replays.length === stoppedAt;
  const playAt = r.step() + 1;
  r.loop(0, LOOP_PLAY_STOP);
  r.runTo((playAt + len) / SIM_RATE - 0.001);
  const resumed = r.replays.slice(stoppedAt);
  const fromTop = resumed.length === 2 && resumed.every((x) => [r.inst.looper.time[0], r.inst.looper.time[1]].includes(x.step - playAt));
  report(stopped && fromTop, 'stop silences; play restarts the loop from its top', `after play: replays at +${resumed.map((x) => x.step - playAt).join(', +')} ms`);

  r.loop(0, LOOP_CLEAR);
  const cleared = r.replays.length;
  r.runTo((recStart + 11 * len) / SIM_RATE);
  report(r.inst.looper.state[0] === EMPTY && r.replays.length === cleared, 'clear erases the layer completely');
}
{
  // Clear all: every layer and the shared grid; the next take starts from scratch.
  const r = rig();
  r.param('quantize', 1); r.param('bpm', 120);
  r.runTo(5, [[0.1, () => r.loop(0, LOOP_RECORD)], [0.3, () => r.drop(0.3, 0.3)], [2.1, () => r.loop(0, LOOP_RECORD)],
    [2.2, () => r.loop(1, LOOP_RECORD)], [2.5, () => r.drop(0.6, 0.6)], [4.1, () => r.loop(1, LOOP_RECORD)]]);
  r.loop(0, LOOP_CLEAR_ALL);
  const lp = r.inst.looper;
  const allEmpty = [0, 1, 2, 3].every((l) => lp.state[l] === EMPTY && lp.count[l] === 0) && lp.transportOrigin === -1;
  let fresh = -1;
  r.runTo(7, [[5.5, () => { r.loop(2, LOOP_RECORD); fresh = r.step() + 1; }], [5.8, () => r.drop(0.5, 0.5)], [7.0, () => r.loop(2, LOOP_RECORD)]]);
  report(allEmpty && lp.origin[2] === fresh, 'clear all erases every layer and the bar grid; the next take starts afresh');
}
{
  // A quantized loop restarted mid-bar waits for the next bar.
  const r = rig();
  r.param('quantize', 1); r.param('bpm', 120); r.param('quantizeStrength', 1);
  r.runTo(2.3, [[0.1, () => r.loop(0, LOOP_RECORD)], [0.1, () => r.drop(0.4, 0.4)], [2.1, () => r.loop(0, LOOP_RECORD)], [2.2, () => r.loop(0, LOOP_PLAY_STOP)]]);
  const lp = r.inst.looper, origin = lp.transportOrigin, before = r.replays.length;
  r.runTo(9, [[5.3, () => r.loop(0, LOOP_PLAY_STOP)]]);
  const first = r.replays[before];
  report(first && (first.step - origin) % 2000 === 0 && first.step >= 5300, 'a quantized loop restarted mid-bar comes in on the next bar',
    first ? `first replay ${first.step - origin} ms after the grid origin` : 'no replay');
}

// ---- 3. Quantize ------------------------------------------------------------------
console.log('\n3. Quantize: lean or snap toward the grid; loops are whole bars');
{
  const run = (strength, swing = 0, quantize = 1) => {
    const r = rig();
    r.param('quantize', quantize); r.param('bpm', 120); r.param('grid', 4); r.param('quantizeStrength', strength); r.param('swing', swing);
    let origin = 0;
    r.runTo(2.2, [
      [0.05, () => { r.loop(0, LOOP_RECORD); origin = r.step() + 1; }],
      [0.3, () => r.drop(0.3, 0.4)], // ~250 ms after origin (on a 125 ms grid)
      [0.69, () => r.drop(0.5, 0.5)], // ~640: between grid points 625 and 750
      [1.99, () => r.loop(0, LOOP_RECORD)], // ~1.94 s take → 1 bar (2 s at 120 bpm)
    ]);
    const lp = r.inst.looper;
    return { len: lp.length[0], times: Array.from(lp.time.subarray(0, lp.count[0])), origin };
  };
  const raw = run(0), snap = run(1), lean = run(0.5), swung = run(1, 0.5), off = run(0, 0, 0);
  const g = 125;
  const onGrid = snap.times.every((t) => t % g === 0);
  const halfway = lean.times.every((t, i) => Math.abs(t - (raw.times[i] + snap.times[i]) / 2) <= 1);
  const swingOk = swung.times.some((t) => Math.round(t / (g / 2)) % 2 === 1 && Math.abs((t % g) - g / 2) <= 1);
  report(snap.len === 2000 && off.len === 1940, 'a 1.94 s take at 120 bpm becomes exactly one bar (2000 ms)', `quantized ${snap.len} ms; quantize off ${off.len} ms`);
  report(onGrid, 'strength 1 snaps recorded touches to the 1/16 grid', `[${raw.times}] → [${snap.times}]`);
  report(halfway, 'strength 0.5 moves them halfway (the default "lean")', `[${lean.times}]`);
  report(swingOk, 'swing pushes every second grid point late', `[${swung.times}]`);
}
{
  // Two quantized layers share one bar grid, even when the second starts later.
  const r = rig();
  r.param('quantize', 1); r.param('bpm', 120); r.param('grid', 2); r.param('quantizeStrength', 1);
  r.runTo(9, [
    [0.05, () => r.loop(0, LOOP_RECORD)], [0.4, () => r.drop(0.3, 0.4)], [2.05, () => r.loop(0, LOOP_RECORD)],
    [3.3, () => r.loop(1, LOOP_RECORD)], [3.8, () => r.drop(0.7, 0.6)], [7.3, () => r.loop(1, LOOP_RECORD)],
  ]);
  const lp = r.inst.looper, beat = 500, origin = lp.origin[0];
  const aligned = r.replays.every((x) => (x.step - origin) % (beat / 2) === 0);
  report(lp.origin[1] === origin && lp.length[0] === 2000 && lp.length[1] === 4000 && aligned,
    'a second layer joins the same grid: 1 and 2 bars, every replay on an eighth', `${r.replays.length} replays`);
}
{
  // Quantize off by default; live touches are never delayed.
  const r = rig();
  report(r.inst.looper.quantize === 0, 'quantize is off by default');
  r.param('quantize', 1); r.param('quantizeStrength', 1);
  let landed = -1, sent = -1;
  const e = r.inst.engine, orig = e.surface.drop.bind(e.surface);
  // Drops land inside the step that's starting (before simStep advances).
  e.surface.drop = (...a) => { if (landed < 0) landed = e.simStep + 1; return orig(...a); };
  r.runTo(0.5, [[0.123, () => { sent = r.step(); r.drop(0.5, 0.5); }]]);
  report(landed === sent + 1, 'a live touch lands on the very next step even with quantize on', `sent at step ${sent}, landed at ${landed}`);
}

// ---- 4. Same loop at any sample rate and block size --------------------------------
console.log('\n4. Sample-rate and block-size independence');
{
  const script = (r) => [
    [0.1, () => r.loop(0, LOOP_RECORD)], [0.25, () => r.drop(0.3, 0.4)], [0.6, () => r.stroke(0.5, 0.5, 0.55, 0.52, 2)],
    [1.3, () => r.loop(0, LOOP_RECORD)], [1.5, () => r.loop(1, LOOP_RECORD)], [1.7, () => r.drop(0.8, 0.2)], [2.2, () => r.loop(1, LOOP_RECORD)],
  ];
  const key = (fs, block) => {
    const r = rig({ fs, block, seed: 5 });
    r.runTo(6, script(r));
    return r.strikes.map((s) => `${s.stone}@${s.t.toFixed(6)}`).join(' ');
  };
  const ref = key(48000, 128);
  const bad = [[44100, 128], [96000, 128], [48000, 1], [48000, 1000]].filter(([fs, b]) => key(fs, b) !== ref);
  report(bad.length === 0, 'two loops: identical notes at 44.1/48/96 kHz and block sizes 1/128/1000',
    bad.length ? `differs at ${bad.map((b) => b.join('/')).join(', ')}` : `${ref.split(' ').length} strikes`);
}

// ---- 5. Limits and bad input -----------------------------------------------------------
console.log('\n5. Limits and bad input');
{
  const r = rig();
  r.runTo(MAX_LOOP_SECONDS + 1, [[0.1, () => r.loop(0, LOOP_RECORD)], [0.2, () => r.drop(0.5, 0.5)]]);
  report(r.inst.looper.state[0] === PLAYING && Math.abs(r.inst.looper.length[0] - MAX_LOOP_SECONDS * SIM_RATE) <= 1,
    `a take left running stops itself at ${MAX_LOOP_SECONDS} s`);

  const f = rig();
  f.loop(0, LOOP_RECORD);
  for (let i = 0; i < LOOP_EVENTS + 50; i++) { f.inst.looper.beginBlock(); f.inst.looper.record(1, 0.5, 0.5, 0, 0, 1, 10 + i); }
  f.loop(0, LOOP_RECORD);
  report(f.inst.looper.count[0] === LOOP_EVENTS && f.inst.looper.dropped === 50, 'a full layer drops extra gestures (and counts them)');

  const b = rig();
  let threw = false;
  try {
    for (const v of [NaN, Infinity, -1, 4, 99, 1.5]) { b.loop(v, LOOP_RECORD); b.loop(0, v); }
    for (const k of ['quantize', 'bpm', 'grid', 'quantizeStrength', 'swing']) for (const v of [NaN, Infinity, -1e9, 1e9]) b.param(k, v);
    b.loop(0, LOOP_RECORD); b.drop(NaN, 0.5); b.stroke(0.1, 0.1, Infinity, 0.2, 1); b.loop(0, LOOP_RECORD);
  } catch { threw = true; }
  b.runTo(2);
  const lp = b.inst.looper;
  report(!threw && lp.bpm >= 40 && lp.bpm <= 240 && lp.count[0] === 0 && Number.isFinite(lp.swing),
    'bad layers, actions, values and gestures are ignored or clamped');
}

{
  // Ending a full quantized take that started mid-bar (its times wrap) is fast.
  const r = rig();
  r.param('quantize', 1); r.param('bpm', 120); r.param('grid', 4); r.param('quantizeStrength', 0.3);
  r.runTo(3, [[0.1, () => r.loop(0, LOOP_RECORD)], [0.4, () => r.drop(0.5, 0.5)], [2.1, () => r.loop(0, LOOP_RECORD)], [2.2, () => r.loop(0, LOOP_CLEAR)]]);
  // transport origin is now set; layer 1 starts half a bar off the grid
  r.runTo(4.0, [[3.0, () => r.loop(1, LOOP_RECORD)]]);
  const lp = r.inst.looper, start = r.step();
  for (let i = 0; i < LOOP_EVENTS; i++) { lp.beginBlock(); lp.record(1, (i * 0.37) % 1, 0.5, 0, 0, 0.5, start + 1 + Math.floor(i * 1.4)); }
  const t0 = performance.now();
  lp.finishTake(1, start + 1 + Math.floor(LOOP_EVENTS * 1.4) + 1);
  const ms = performance.now() - t0;
  let sorted = true;
  for (let i = 1; i < lp.count[1]; i++) if (lp.time[LOOP_EVENTS + i] < lp.time[LOOP_EVENTS + i - 1]) sorted = false;
  report(ms < 2 && sorted && lp.count[1] === LOOP_EVENTS, `finishing a full mid-bar quantized take: ${ms.toFixed(2)} ms, sorted`, 'limit 2 ms');
}
{
  // A quantized take started long after the transport began records normally.
  const r = rig();
  r.param('quantize', 1); r.param('bpm', 120); r.param('quantizeStrength', 1);
  r.runTo(75, [[0.1, () => r.loop(0, LOOP_RECORD)], [0.5, () => r.drop(0.4, 0.4)], [2.1, () => r.loop(0, LOOP_RECORD)],
    [70, () => r.loop(1, LOOP_RECORD)], [70.5, () => r.drop(0.6, 0.6)], [72.05, () => r.loop(1, LOOP_RECORD)]]);
  report(r.inst.looper.state[1] === PLAYING && r.inst.looper.count[1] === 1, 'a quantized take 70 s after the first loop records normally');
}
{
  // A snapped pile-up of trails on one step can't flood the gesture queue or the block.
  const r = rig();
  const lp = r.inst.looper;
  r.param('quantize', 1); r.param('bpm', 240); r.param('grid', 1); r.param('quantizeStrength', 1);
  for (let l = 0; l < 4; l++) {
    r.loop(l, LOOP_RECORD);
    const s0 = r.step();
    for (let i = 0; i < 1000; i++) { lp.beginBlock(); lp.record(2, 0.2, 0.2, 0.8, 0.8, 4, s0 + 1 + (i % 50)); }
    lp.finishTake(l, s0 + 1000);
  }
  const L = new Float32Array(128), R = new Float32Array(128);
  // Warm up through one full loop pass first: the first time a code path runs,
  // JavaScript compiles it (a one-off spike the C++ port won't have).
  for (let k = 0; k < 400; k++) r.inst.process(L, R, 128);
  // The 95th percentile, not the single worst block: one garbage-collection
  // pause otherwise decides this check (a real regression makes every block
  // slow, so the percentile still catches it).
  const times = new Float64Array(2000);
  for (let k = 0; k < times.length; k++) { const t0 = performance.now(); r.inst.process(L, R, 128); times[k] = performance.now() - t0; }
  times.sort();
  const worst = times[Math.floor(times.length * 0.95)];
  report(worst < 2.67 * 0.6, `4 layers × 1000 trails snapped onto a few steps: 95th-percentile block ${worst.toFixed(2)} ms`,
    `limit 60% of the block (worst single block ${times[times.length - 1].toFixed(2)} ms)`);
}
{
  // A burst of live gestures in one block records at most the per-block budget.
  const r = rig();
  r.loop(0, LOOP_RECORD);
  for (let i = 0; i < 500; i++) r.drop((i * 0.13) % 1, 0.5);
  report(r.inst.looper.count[0] === 32, 'a burst of 500 gestures in one block records at most 32 (the rest are counted, not stalled)',
    `recorded ${r.inst.looper.count[0]}`);
}

// ---- 6. CPU -------------------------------------------------------------------------------
console.log('\n6. CPU per 128-sample block at 48 kHz (budget 2667 µs)');
{
  const r = rig();
  const lp = r.inst.looper;
  for (let l = 0; l < 4; l++) {
    r.loop(l, LOOP_RECORD);
    for (let i = 0; i < 400; i++) { lp.beginBlock(); lp.record(1, (i * 0.37) % 1, (i * 0.53) % 1, 0, 0, 0.6, r.step() + 1 + i * 10); }
    r.runTo(r.step() / SIM_RATE + 0.001);
  }
  for (let l = 0; l < 4; l++) lp.finishTake(l, r.step() + 4000 + l * 777);
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let k = 0; k < 300; k++) r.inst.process(L, R, 128);
  const t0 = performance.now(), blocks = 3000;
  for (let k = 0; k < blocks; k++) r.inst.process(L, R, 128);
  const us = ((performance.now() - t0) * 1000) / blocks;
  report(us / 2667 < 0.3, `4 layers × 400 gestures looping: ${us.toFixed(0)} µs/block, ${((us / 2667) * 100).toFixed(1)}%`, 'limit 30%');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll looper checks passed.');
process.exit(failures ? 1 : 0);
