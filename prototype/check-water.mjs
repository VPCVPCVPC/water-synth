// check-water.mjs — checks for the generative medium (surface + stones +
// engine), without sound. Agents can't hear; these are what we can prove.
//   node check-water.mjs

import { Surface, SURFACE_PARAMS, SIM_RATE, REFERENCE_SPEED, MAX_HANDS } from './surface.js';
import { Stones, StrikeBuffer, STONE_PARAMS } from './stones.js';
import { Engine, ENGINE_PARAMS, MAX_STIRS } from './engine.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { performance } from 'node:perf_hooks';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });

// The physics checks are calibrated at the reference tempo with splash off;
// they pin those rather than inherit whatever the player-facing defaults are.
// Checks about a knob set it themselves.
const BASELINE = { waveSpeed: REFERENCE_SPEED, decay: 8, splash: 0 };
function testEngine(opts) {
  const e = new Engine(opts);
  for (const [k, v] of Object.entries(BASELINE)) e.setParam(k, v);
  return e;
}
function testSurface() {
  const s = new Surface();
  s.setParam('waveSpeed', BASELINE.waveSpeed);
  s.setParam('decay', BASELINE.decay);
  return s;
}

function makeEngine({ fs = 48000, seed = 1, pitches = PENTA, params = {} } = {}) {
  const e = testEngine({ sampleRate: fs, seed });
  const { xs, ys } = stonePositions(pitches.length);
  e.setStones(xs, ys, pitches.map((p) => p.hz), pitches.length);
  for (const [k, v] of Object.entries(params)) e.setParam(k, v);
  return e;
}

// Run an engine for `seconds`, calling before(engine) first (schedule gestures
// with atSeconds there) and during(engine, seconds) after each block.
// Returns strikes as { stone, t, sample, velocity, height }.
function run(e, seconds, { block = 128, before, during } = {}) {
  if (before) before(e);
  const out = [];
  const total = Math.round(seconds * e.fs);
  for (let done = 0; done < total; done += block) {
    const n = Math.min(block, total - done);
    e.process(n);
    for (let i = 0; i < e.strikes.count; i++) {
      out.push({
        stone: e.strikes.stone[i], t: e.strikeSeconds(i), sample: done + e.strikeSample(i),
        velocity: e.strikes.velocity[i], height: e.strikes.height[i],
      });
    }
    if (during) during(e, (done + n) / e.fs);
  }
  return out;
}

const seq = (strikes, n = 12) => strikes.slice(0, n).map((s) => s.stone).join(',');

// Peak height and its time at a grid point, for one drop on a bare surface.
function probe(params, dropX, dropY, points, seconds) {
  const s = testSurface();
  for (const [k, v] of Object.entries(params)) s.setParam(k, v);
  s.drop(dropX, dropY, 1, 1.5);
  const peaks = points.map(() => ({ h: -Infinity, t: 0 }));
  for (let k = 1; k <= seconds * SIM_RATE; k++) {
    s.step();
    points.forEach(([gx, gy], i) => { const h = s.heightAt(gx, gy); if (h > peaks[i].h) peaks[i] = { h, t: k / SIM_RATE }; });
  }
  return peaks;
}

// ---- 1. Surface: stable, energy never rises, no water added -------------------
console.log('\n1. Surface stability and energy');
{
  const P = SURFACE_PARAMS;
  const sets = {
    defaults: {},
    'fast+long+bright': { waveSpeed: P.waveSpeed.max, decay: P.decay.max, hfDecay: P.hfDecay.max },
    'fast+long+dark': { waveSpeed: P.waveSpeed.max, decay: P.decay.max, hfDecay: P.hfDecay.min },
    'slow+short': { waveSpeed: P.waveSpeed.min, decay: P.decay.min, hfDecay: P.hfDecay.min },
  };
  for (const [name, p] of Object.entries(sets)) {
    const s = testSurface();
    for (const [k, v] of Object.entries(p)) s.setParam(k, v);
    for (const [x, y] of [[0.5, 0.5], [0.02, 0.98], [0.99, 0.01], [0.3, 0.6]]) s.drop(x, y, 4, 2);
    for (let k = 0; k < 10; k++) s.step(); // drops finish injecting
    let prev = s.energy(), rises = 0, worst = 0, maxVol = 0, finite = true;
    for (let k = 0; k < 3 * SIM_RATE; k++) {
      s.step();
      const e = s.energy();
      if (!Number.isFinite(e)) { finite = false; break; }
      if (e > prev && prev > 0) { rises++; worst = Math.max(worst, (e - prev) / prev); }
      prev = e;
      maxVol = Math.max(maxVol, Math.abs(s.netVolume()));
    }
    report(finite && worst < 1e-9 && maxVol < 1e-9 && s.resets === 0, name,
      `${rises} energy rises (worst ${worst.toExponential(1)}), max net water ${maxVol.toExponential(1)}`);
  }
}

// ---- 2. Wave speed is what the knob says ---------------------------------------
console.log('\n2. Wave speed = knob (crest travel time between two points)');
for (const c of [4, 32, 64, 200]) {
  const s = testSurface();
  const y = s.toGridY(0.5), x0 = s.toGridX(0.2);
  // Window ends before the first reflection can reach the nearer point.
  const [a, b] = probe({ waveSpeed: c }, 0.2, 0.5, [[x0 + 16, y], [x0 + 48, y]], (1.1 * 48) / c + 0.06);
  const measured = 32 / (b.t - a.t);
  report(Math.abs(measured / c - 1) < 0.05, `${c} cells/s`, `measured ${measured.toFixed(1)} cells/s`);
}

console.log('\n2b. Tempo changes timing, not crest height');
{
  const heights = [4, 25, 64, 450].map((c) => {
    const s = testSurface();
    const x0 = s.toGridX(0.3), y = s.toGridY(0.5);
    const [p] = probe({ waveSpeed: c }, 0.3, 0.5, [[x0 + 12, y]], (1.1 * 30) / c + 0.1);
    return p.h;
  });
  const spread = Math.max(...heights) / Math.min(...heights);
  report(spread < 1.1, 'crest 12 cells from a strength-1 drop at 4 / 25 / 64 / 450 cells/s',
    heights.map((h) => h.toFixed(3)).join(' / '));
}

console.log('\n2c. Ripples are the same in every direction');
{
  const s = testSurface(), cx = s.toGridX(0.5), cy = s.toGridY(0.5), d = 45 / Math.SQRT2;
  s.drop(0.5, 0.5, 1, 1.5);
  let ax = { h: -Infinity, t: 0 }, dg = { h: -Infinity, t: 0 };
  for (let k = 1; k <= SIM_RATE; k++) {
    s.step();
    const a = s.heightAt(cx + 45, cy), b = s.heightAt(cx + d, cy + d);
    if (a > ax.h) ax = { h: a, t: k };
    if (b > dg.h) dg = { h: b, t: k };
  }
  const ratio = dg.h / ax.h, dt = Math.abs(dg.t - ax.t);
  report(Math.abs(ratio - 1) < 0.05 && dt <= 5, 'crest 45 cells away: along an axis vs on the diagonal',
    `height ratio ${ratio.toFixed(3)}, arrival ${dt} ms apart`);
}

// ---- 3. Stones ring in order of distance, on time ------------------------------
console.log('\n3. One drop: stones ring in order of distance, at the predicted times');
{
  const e = testEngine({ seed: 1 });
  const s = e.surface;
  const dists = [10, 20, 30, 40, 50];
  const x0 = 0.15, y0 = 0.5, gx0 = s.toGridX(x0);
  const xs = dists.map((d) => (gx0 + d - 1) / (s.w - 1)), ys = dists.map(() => y0);
  e.setStones(xs, ys, dists.map((_, i) => 200 + i), dists.length);
  const strikes = run(e, 2, { before: (en) => en.surface.drop(x0, y0, 1, 1.5) });
  const first = dists.map((_, i) => strikes.find((st) => st.stone === i));
  const inOrder = first.every((f, i) => f && (i === 0 || f.t > first[i - 1].t));
  const gaps = first.slice(1).map((f, i) => f && first[i] ? f.t - first[i].t : NaN);
  const expected = 10 / s.waveSpeed;
  const onTime = gaps.every((g) => Math.abs(g / expected - 1) < 0.1);
  report(inOrder && onTime, 'stones at 10, 20, 30, 40, 50 cells',
    `gaps ${gaps.map((g) => (g * 1000).toFixed(0)).join('/')} ms vs ${(expected * 1000).toFixed(0)} ms predicted`);
}

// ---- 4. Where you drop changes the phrase ----------------------------------------
console.log('\n4. Position matters: drops in different places give different phrases');
{
  const spots = [[0.5, 0.5], [0.15, 0.8], [0.85, 0.2], [0.3, 0.25]];
  const phrases = spots.map(([x, y]) => seq(run(makeEngine(), 3, { before: (e) => e.drop(x, y, 1, 0.05) }), 8));
  const distinct = new Set(phrases).size;
  report(distinct === spots.length, `${spots.length} drop positions`, phrases.map((p) => `[${p}]`).join(' '));
}

// ---- 5. Waves interact: two ripples ring a stone neither rings alone ------------
console.log('\n5. Interference');
{
  const s0 = testSurface();
  const sx = s0.toGridX(0.5), sy = s0.toGridY(0.5);
  const d = 30 / (s0.w - 1);
  const [alone] = probe({}, 0.5 - d, 0.5, [[sx, sy]], 1.5);
  const threshold = 1.4 * alone.h;
  const ring = (drops) => {
    const s = testSurface(), st = new Stones(), out = new StrikeBuffer();
    st.setThreshold(threshold);
    st.setStones(s, [0.5], [0.5], [440], 1);
    for (const x of drops) s.drop(x, 0.5, 1, 1.5);
    for (let k = 1; k <= 1.5 * SIM_RATE; k++) { s.step(); st.detect(s, k, out); }
    return out.count;
  };
  const left = ring([0.5 - d]), right = ring([0.5 + d]), both = ring([0.5 - d, 0.5 + d]);
  report(left === 0 && right === 0 && both > 0, 'two drops 30 cells either side of a stone',
    `alone: ${left}, ${right} strikes; together: ${both} (crest ${alone.h.toFixed(4)} each, threshold ${threshold.toFixed(4)})`);
}

// ---- 6. Reflections ring stones (free edges reflect crests upright) -------------
console.log('\n6. Reflections off the walls ring stones on time');
{
  const e = testEngine({ seed: 1 });
  const s = e.surface;
  e.setStones([0.95], [0.5], [440], 1);
  e.setParam('threshold', 0.01);
  const strikes = run(e, 2, { before: (en) => en.surface.drop(0.5, 0.5, 1, 1.5) });
  const gStone = s.toGridX(0.95), gDrop = s.toGridX(0.5), wall = s.w + 0.5;
  const predicted = ((wall - gDrop) + (wall - gStone) - (gStone - gDrop)) / s.waveSpeed;
  const gap = strikes.length >= 2 ? strikes[1].t - strikes[0].t : NaN;
  report(Math.abs(gap / predicted - 1) < 0.15, 'stone near a wall rings again as the reflection passes',
    `${strikes.length} strikes; echo ${(gap * 1000).toFixed(0)} ms after the direct wave, ${(predicted * 1000).toFixed(0)} ms predicted`);
}

// ---- 6b. A stone dragged through moving water rings ----------------------------
console.log('\n6b. Moving a stone through ripples rings it');
{
  // One drop in the middle; a stone starts in still water at the far left and
  // is swept toward the middle as the ring spreads, crossing its crest.
  const e = testEngine({ seed: 1 });
  e.setStones([0.05], [0.5], [440], 1);
  e.setParam('threshold', 0.01);
  const strikes = run(e, 1.2, {
    before: (en) => en.surface.drop(0.5, 0.5, 1, 1.5),
    during: (en, t) => en.stones.moveStone(en.surface, 0, Math.min(0.5, 0.05 + t * 0.6), 0.5),
  });
  const still = testEngine({ seed: 1 });
  still.setStones([0.05], [0.5], [440], 1);
  still.setParam('threshold', 0.01);
  const unmoved = run(still, 0.15, { before: (en) => en.surface.drop(0.5, 0.5, 1, 1.5) });
  report(strikes.length > 0 && unmoved.length === 0, 'a stone swept into the spreading ring rings as it meets the crest',
    `${strikes.length} strikes while moving (none before the ring could reach it unmoved)`);
}

// ---- 7. Only scale notes, only in range ---------------------------------------
console.log('\n7. Every note is in the scale and the range');
{
  const pitches = buildPitches({ scale: SCALES.rast, root: 57, low: 50, high: 81 });
  const e = makeEngine({ pitches, params: { threshold: 0.008, splash: 0.5 } });
  const strikes = run(e, 6, { before: (en) => { en.drop(0.4, 0.4, 2, 0.05); en.drop(0.7, 0.6, 1, 0.8); } });
  const allowed = new Set(pitches.map((p) => p.hz));
  const ok = strikes.length > 0 && strikes.every((st) => allowed.has(e.stones.hz[st.stone]))
    && strikes.every((st) => pitches[st.stone].note >= 50 && pitches[st.stone].note <= 81);
  report(ok, 'maqam Rast on A, D3–A5', `${strikes.length} strikes over ${pitches.length} stones`);
}

// ---- 8. Retuning never touches the water ----------------------------------------
console.log('\n8. Retuning changes the stones, never the water');
{
  const gestures = (e) => { e.drop(0.3, 0.4, 1.5, 0.05); e.drop(0.7, 0.7, 1, 0.6); };
  const a = makeEngine({ seed: 9 }), b = makeEngine({ seed: 9 });
  run(a, 2, { before: gestures });
  const major = buildPitches({ scale: SCALES.major, root: 62, low: 45, high: 86 });
  let retuned = false;
  run(b, 2, {
    before: gestures,
    during: (e, t) => {
      if (!retuned && t >= 0.5) {
        const { xs, ys } = stonePositions(major.length);
        e.setStones(xs, ys, major.map((p) => p.hz), major.length);
        retuned = true;
      }
    },
  });
  const same = a.surface.u.every((v, i) => v === b.surface.u[i]) && a.surface.up.every((v, i) => v === b.surface.up[i]);
  report(same, 'retune mid-ripple (pentatonic → D major, more stones): water bit-identical');
  const small = stonePositions(10), large = stonePositions(25);
  const stable = Array.from({ length: 10 }, (_, i) => small.xs[i] === large.xs[i] && small.ys[i] === large.ys[i]).every(Boolean);
  report(stable, 'changing the stone count keeps existing stones where they are');
}

// ---- 9. Splash chains always die out ---------------------------------------------
console.log('\n9. Splash never runs away');
{
  const P = ENGINE_PARAMS;
  const e = makeEngine({ params: { splash: P.splash.max, threshold: P.threshold.min, decay: P.decay.max, hfDecay: P.hfDecay.max } });
  // 100 s: at the 30 s decay the water needs ~85 s to fall all the way to stillness.
  const strikes = run(e, 100, {
    before: (en) => { for (let i = 0; i < 20; i++) en.drop((i * 0.37) % 1, (i * 0.61) % 1, 4, i * 0.05); },
  });
  const perSec = new Array(100).fill(0);
  for (const st of strikes) perSec[Math.min(99, Math.floor(st.t))]++;
  const late = perSec.slice(40).reduce((a, b) => a + b, 0);
  report(late === 0 && e.surface.asleep && e.surface.resets === 0,
    'max splash, most sensitive, longest decay, 20 hard drops',
    `${strikes.length} strikes, busiest second ${Math.max(...perSec)}, after 40 s: ${late}, silent: ${e.surface.asleep}`);
}

// ---- 10. Same seed repeats exactly; different sessions differ --------------------
console.log('\n10. Determinism and variation');
{
  const gestures = (e) => { e.drop(0.5, 0.5, 1, 0.05); e.drop(0.52, 0.5, 1, 0.9); };
  const a = run(makeEngine({ seed: 4 }), 3, { before: gestures });
  const b = run(makeEngine({ seed: 4 }), 3, { before: gestures });
  const c = run(makeEngine({ seed: 5 }), 3, { before: gestures });
  const key = (s) => s.map((x) => `${x.stone}@${x.t.toFixed(6)}`).join(' ');
  report(key(a) === key(b), 'same seed and gestures → identical notes', `${a.length} strikes`);
  report(key(a) !== key(c), 'different seed → different notes (drops vary)');
}

// ---- 10b. Moving water changes what a drop plays ---------------------------------
console.log('\n10b. The same drop into still vs moving water plays a different phrase');
{
  // Same seed for the drop's jitter in both runs: the only difference is
  // whether earlier ripples are still moving when it lands.
  const phraseAfter = (earlier) => {
    const e = makeEngine({ seed: 6 });
    const strikes = run(e, 3.5, {
      before: (en) => {
        if (earlier) en.surface.drop(0.8, 0.3, 1, 1.5); // not jittered: no rng draw
        en.drop(0.3, 0.6, 1, 1.0);
      },
    });
    return seq(strikes.filter((s) => s.t >= 1.0 && s.t < 3.0), 10);
  };
  const still = phraseAfter(false), moving = phraseAfter(true);
  report(still !== moving, 'drop at (0.3, 0.6) at t = 1 s', `still [${still}] vs moving [${moving}]`);
}

// ---- 11. Same water at any sample rate and block size -----------------------------
console.log('\n11. Sample-rate and block-size independence');
{
  const gestures = (e) => { e.drop(0.3, 0.6, 1, 0.05); e.trail(0.6, 0.2, 0.7, 0.3, 2, 0.5); e.drop(0.8, 0.8, 1.5, 1.1); };
  const key = (s) => s.map((x) => `${x.stone}@${x.t.toFixed(9)}`).join(' ');
  const ref = run(makeEngine({ fs: 48000, seed: 2 }), 3, { before: gestures });
  const rates = [44100, 96000, 192000].filter((fs) => key(run(makeEngine({ fs, seed: 2 }), 3, { before: gestures })) !== key(ref));
  report(rates.length === 0, 'identical notes and timing at 44.1k, 48k, 96k, 192k', rates.length ? `differs at ${rates.join(', ')}` : `${ref.length} strikes`);
  const fullKey = (s) => s.map((x) => `${x.stone}@${x.sample}`).join(' ');
  const refB = fullKey(ref);
  const blocks = [1, 37, 64, 1000].filter((block) => fullKey(run(makeEngine({ seed: 2 }), 3, { before: gestures, block })) !== refB);
  report(blocks.length === 0, 'identical notes, to the sample, at block sizes 1, 37, 64, 128, 1000', blocks.length ? `differs at ${blocks.join(', ')}` : '');

  // Huge blocks overflow the per-block strike list (voices lose notes), but the
  // water — and so its splashes — must not depend on that.
  const busy = { params: { threshold: 0.005, splash: 0.8 } };
  const many = (e) => { for (let i = 0; i < 12; i++) e.drop((i * 0.31) % 1, (i * 0.57) % 1, 3, 0.02 * i); };
  const small = makeEngine({ seed: 8, ...busy }), big = makeEngine({ seed: 8, ...busy });
  big.strikes = new StrikeBuffer(8); // a deliberately tiny per-block list
  run(small, 3, { before: many, block: 128 });
  run(big, 3, { before: many, block: 48000 });
  const same = small.surface.u.every((v, i) => v === big.surface.u[i]);
  report(same && big.strikes.dropped > 0, 'water identical even when the per-block strike list overflows',
    `${big.strikes.dropped} strikes didn't fit the per-block list; water ${same ? 'identical' : 'DIFFERS'}`);
}

// ---- 12. Bad input never breaks the water ---------------------------------------
console.log('\n12. Bad input');
{
  const e = makeEngine();
  let threw = false;
  try {
    for (const v of [NaN, Infinity, -Infinity]) {
      e.drop(v, 0.5, 1); e.drop(0.5, 0.5, v); e.trail(0.1, 0.1, v, 0.2, 1); e.trail(0.1, 0.1, 0.2, 0.2, v);
      for (const k of Object.keys(ENGINE_PARAMS)) e.setParam(k, v);
    }
    e.drop(-3, 9, 1e30); e.trail(0, 0, 1, 1, 1e9); e.setStones([0.5], [0.5], [440], 1e9);
  } catch { threw = true; }
  const strikes = run(e, 2);
  const finite = e.surface.u.every(Number.isFinite) && strikes.every((s) => Number.isFinite(s.velocity));
  report(!threw && finite && e.surface.resets === 0, 'NaN / Inf / huge values are ignored or clamped', `${strikes.length} strikes`);
}
{
  // Bad stones are disabled in place; good ones keep working.
  const e = testEngine({ seed: 1 });
  e.setStones([0.5, NaN, 0.6, 0.4], [0.5, 0.5, Infinity, 0.5], [440, 330, 220, NaN], 4);
  e.setStones([0.5], [0.5], [440], NaN); // ignored
  e.process(NaN); e.process(-5); e.process(1.5); // ignored: clock untouched
  const strikes = run(e, 1, { before: (en) => en.drop(0.45, 0.5, 1, 0.01) });
  const onlyGood = strikes.length > 0 && strikes.every((s) => s.stone === 0);
  report(onlyGood && e.sample === 48000, 'stones with NaN position or pitch are disabled; bad block lengths ignored',
    `${strikes.length} strikes, all from the valid stone: ${onlyGood}`);
}
{
  // Far-future gestures can't hold the queue forever.
  const e = makeEngine();
  for (let i = 0; i < 100; i++) e.drop(0.5, 0.5, 1, 1e12);
  const strikes = run(e, 1, { before: (en) => en.drop(0.5, 0.5, 1, 0.01) });
  report(strikes.length > 0 && e.gesturesDropped >= 100, 'drops scheduled 1e12 s ahead are rejected; later gestures still play',
    `${e.gesturesDropped} rejected, ${strikes.length} strikes after`);
}
{
  // If bad water ever appears, the guard wipes it and splash starts afresh.
  const e = makeEngine({ params: { splash: 0.8 } });
  run(e, 0.5, { before: (en) => en.drop(0.5, 0.5, 1, 0.01) });
  e.surface.u[e.surface.W * 40 + 60] = NaN;
  run(e, 0.5);
  const strikes = run(e, 2, { before: (en) => en.drop(0.3, 0.3, 1) });
  const healthy = Number.isFinite(e.reservoir) && strikes.length > 0 && strikes.every((s) => Number.isFinite(s.velocity) && Number.isFinite(s.height));
  report(healthy && e.surface.resets === 1, 'a NaN in the water is caught; splash and strikes recover',
    `resets ${e.surface.resets}, reservoir ${e.reservoir.toFixed(3)}, ${strikes.length} strikes after`);
}

// ---- 13. CPU ----------------------------------------------------------------------
console.log('\n12b. Still: a hand resting on the water');
{
  const steps = (s, n) => { for (let k = 0; k < n; k++) s.step(); };
  const travel = (cells, speed) => Math.round((cells / speed) * SIM_RATE); // steps for ripples to travel this far
  const at = (speed) => { const s = new Surface(); s.setParam('waveSpeed', speed); return s; };
  for (const speed of [SURFACE_PARAMS.waveSpeed.min, 39, SURFACE_PARAMS.waveSpeed.max]) {
    // A hand where the drop landed calms the water much faster — the same
    // in cells of travel at every flow (a time-lapse) — and energy, checked
    // every step, never rises by more than a hair (the gentle pull to rest
    // isn't in the energy's books).
    const free = at(speed), held = at(speed);
    held.setHand(0, 0.5, 0.5, 1);
    held.step(); // settled on (in still water a hand rests at once; it eases over ~50 ms of real time)
    for (const s of [free, held]) s.drop(0.5, 0.5, 1, 1.5);
    const e0 = held.energy();
    let last = e0, worstRise = 0;
    for (let k = 0; k < travel(40, speed); k++) {
      free.step(); held.step();
      const e = held.energy();
      if (e > last) worstRise = Math.max(worstRise, (e - last) / e0);
      last = e;
    }
    const ratio = held.energy() / free.energy();
    // A ripple reaching the hand is absorbed, not sent back: what returns to
    // a point between the drop and the hand, against the direct crest.
    const echo = (hand) => {
      const s = at(speed);
      if (hand) { s.setHand(0, 0.5, 0.5, 1); s.step(); }
      s.drop(0.2, 0.5, 1, 1.5);
      const tr = [];
      for (let k = 0; k < travel(60, speed); k++) { s.step(); tr.push(s.heightAt(s.toGridX(0.3), s.toGridY(0.5))); }
      return tr;
    };
    const open = echo(false), shaded = echo(true);
    let back = 0, direct = 0;
    for (let k = 0; k < open.length; k++) {
      if (k > travel(25, speed)) back = Math.max(back, Math.abs(shaded[k] - open[k]));
      else direct = Math.max(direct, Math.abs(open[k]));
    }
    report(ratio < 0.05 && worstRise < 1e-3 && back / direct < 0.05,
      `flow ${speed}: a hand calms the water, never feeds it, and absorbs ripples rather than echoing them`,
      `energy left after 40 cells of travel ${(ratio * 100).toFixed(1)}%; worst one-step rise ${(worstRise * 100).toFixed(3)}%; echo ${(back / direct * 100).toFixed(1)}%`);
  }

  // A ripple reaching a hand dies there: a stone under the hand hears little.
  const crest = (hand) => {
    const s = testSurface();
    if (hand) { s.setHand(3, 0.5, 0.5, 1); steps(s, 200); } // settled on
    s.drop(0.2, 0.5, 1, 1.5);
    let top = 0;
    for (let k = 0; k < 2500; k++) { s.step(); top = Math.max(top, s.heightAt(s.toGridX(0.5), s.toGridY(0.5))); }
    return top;
  };
  const open = crest(false), shaded = crest(true);
  report(shaded < open * 0.3, 'a ripple reaching a hand dies there (a stone under it hears little)',
    `crest under the hand ${(shaded / open * 100).toFixed(0)}% of open water`);

  // Lifting the hand: the water carries on as before (no damping left behind).
  const a = testSurface(), b = testSurface();
  b.setHand(1, 0.3, 0.3, 1); steps(b, 10); b.setHand(1, 0.3, 0.3, 0); steps(b, 400);
  for (const s of [a, b]) { s.drop(0.3, 0.3, 1, 1.5); steps(s, 1500); }
  report(Math.abs(b.energy() / a.energy() - 1) < 1e-6 && b.handPressure(1) === 0, 'a lifted hand leaves nothing behind',
    `energy ratio ${(b.energy() / a.energy()).toFixed(6)}`);

  // A big bump held under a hand at the fastest flow: it flattens (doesn't
  // freeze), and the pond's rest level stays put — far below what a stone
  // hears (an offset would leave crests riding on it).
  const big = new Surface();
  big.setParam('waveSpeed', SURFACE_PARAMS.waveSpeed.max);
  big.setHand(0, 0.5, 0.5, 1);
  big.drop(0.5, 0.5, 4, 4);
  steps(big, Math.round((200 / SURFACE_PARAMS.waveSpeed.max) * SIM_RATE));
  const level = Math.abs(big.netVolume()) / (big.w * big.h), threshold = STONE_PARAMS.threshold.def;
  let under = 0;
  for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) under = Math.max(under, Math.abs(big.heightAt(big.toGridX(0.5) + x, big.toGridY(0.5) + y)));
  report(level < 0.3 * threshold && under < 0.1 * threshold, 'a bump under a hand flattens, and the rest level stays put',
    `level ${level.toExponential(1)}, under the hand ${under.toExponential(1)} (a stone hears ${threshold})`);

  // What a hand takes is given back evenly at once, so the far side's level
  // moves before any ripple could get there: it must stay well under what
  // the most sensitive stone hears, for the hardest touch a performer can
  // make (strength 2: a Pencil pressed fully) into a settled hand. The rise
  // is proportional to strength (~0.6e-3 per unit), so a broad, strong
  // gesture (Wave, still to come) must revisit this — e.g. by giving the
  // water back as a broad smooth patch around the hand instead.
  {
    const e = testEngine({ sampleRate: 48000 });
    e.setParam('waveSpeed', SURFACE_PARAMS.waveSpeed.min);
    e.still(0, 0.5, 0.5, 1);
    e.process(480);
    e.drop(0.5, 0.5, 2);
    const fs = e.surface, far = Math.hypot(0.5 * (fs.w - 1), 0.5 * (fs.h - 1)) - 20; // cells before a ripple reaches the corner
    let worst = 0;
    const until = (far / SURFACE_PARAMS.waveSpeed.min) * 48000;
    for (let t = 0; t < until; t += 128) { e.process(128); worst = Math.max(worst, Math.abs(fs.heightAt(1, 1))); }
    const minThreshold = STONE_PARAMS.threshold.min;
    report(worst < 0.3 * minThreshold, 'the far side barely stirs before a ripple could get there',
      `corner level ${worst.toExponential(1)} (the most sensitive stone hears ${minThreshold})`);
  }

  // Still adds no water and nothing to still water; bad hands are ignored.
  const c = testSurface();
  c.setHand(0, 0.5, 0.5, 1); steps(c, 100);
  const asleep = c.asleep && c.energy() === 0;
  c.drop(0.4, 0.6, 2, 1.5); steps(c, 3000);
  // The hand flattens: what it takes is only the deviation under it, so the
  const vol = Math.abs(c.netVolume()) / (c.w * c.h);
  c.setHand(-1, 0.5, 0.5, 1); c.setHand(MAX_HANDS, 0.5, 0.5, 1); c.setHand(0.5, 0.5, 0.5, 1);
  c.setHand(2, NaN, 0.5, 1); c.setHand(2, 0.5, 0.5, Infinity);
  steps(c, 100);
  let finite = true;
  for (let k = 0; k < c.u.length; k++) if (!Number.isFinite(c.u[k])) { finite = false; break; }
  report(asleep && vol < 1e-9 && finite && c.handPressure(2) === 0, 'a hand on still water does nothing; no water gained or lost; bad hands ignored',
    `mean level ${vol.toExponential(1)}`);

  // At every flow the hand still calms, and stays stable at the fastest.
  let ok = true, worst = 0;
  for (const speed of [SURFACE_PARAMS.waveSpeed.min, 39, SURFACE_PARAMS.waveSpeed.max]) {
    const f = new Surface(), h = new Surface();
    for (const s of [f, h]) { s.setParam('waveSpeed', speed); s.drop(0.5, 0.5, 1, 1.5); }
    for (let k = 0; k < MAX_HANDS; k++) h.setHand(k, 0.1 + 0.08 * k, 0.5, 1);
    const n = Math.round(4 * SIM_RATE * (REFERENCE_SPEED / speed) * 0.25);
    steps(f, n); steps(h, n);
    const r = h.energy() / f.energy();
    worst = Math.max(worst, r);
    if (!(r < 0.9) || !Number.isFinite(h.energy())) ok = false;
  }
  report(ok, 'all ten hands down, at the slowest, default and fastest flow: calmer, never unstable', `worst energy left ${(worst * 100).toFixed(0)}%`);
}

console.log('\n12c. Stir: circling builds turbulence, which dies away once you stop');
{
  // Count stir drops per stretch of stream time, and where they land.
  // (Stir drops go straight into the water; with splash off, every drop the
  // surface takes here is a stir's.)
  const watch = (e) => {
    const landed = [];
    const drop = e.surface.drop.bind(e.surface);
    e.surface.drop = (x, y, st, r) => { landed.push({ x, y, st, step: e.simStep }); return drop(x, y, st, r); };
    return landed;
  };
  const run = (e, seconds) => { for (let t = 0; t < seconds * 48000; t += 128) e.process(128); };
  // Keep stirring (the page re-sends ~30 times a second while a finger circles).
  const stirFor = (e, seconds, ...args) => { for (let t = 0; t < seconds; t += 1 / 30) { e.stir(...args); run(e, 1 / 30); } };
  {
    const e = makeEngine(), landed = watch(e);
    const per = [];
    for (let k = 0; k < 8; k++) { const n0 = landed.length; stirFor(e, 0.5, 0, 0.5, 0.5, 0.1, 2); per.push(landed.length - n0); }
    const builds = per[0] < per[2] && per[2] <= per[7] + 2 && per[7] > 10;
    const inside = landed.every((d) => Math.hypot(d.x - 0.5, (d.y - 0.5) * (97 / 128)) <= 0.1 + 1e-9);
    const small = landed.every((d) => d.st <= 0.5 * 1.3 + 1e-9);
    report(builds && inside && small, 'stirring steadily, the turbulence builds and then holds — small drops, all inside the stirred circle',
      `drops per half second: ${per.join(' ')}`);
    e.stir(0, 0.5, 0.5, 0.1, 0); // let go
    const after = [];
    for (let k = 0; k < 8; k++) { const n0 = landed.length; run(e, 0.5); after.push(landed.length - n0); }
    report(after[0] > 0 && after[5] === 0 && after[7] === 0 && e.stirsActive === 0, 'let go, it dies away by itself within about two seconds', `drops per half second after: ${after.join(' ')}`);
    run(e, 40);
    report(e.surface.asleep, 'and then the water falls silent');
  }
  {
    // A slow stir stirs less than a fast one.
    const count = (turns) => { const e = makeEngine(), l = watch(e); stirFor(e, 3, 1, 0.4, 0.4, 0.08, turns); return l.length; };
    const slow = count(0.5), fast = count(2.5);
    report(slow > 0 && fast > slow * 2, 'a faster stir churns harder (more drops)', `${slow} drops at half a turn a second, ${fast} at two and a half`);
  }
  {
    // The stir is the hand's: the same stir puts the same drops into the
    // water at any flow (the water then answers at its own pace) — so it's
    // never silent at the slowest flow, where it takes time to be heard.
    const counts = [];
    for (const speed of [SURFACE_PARAMS.waveSpeed.min, 39, SURFACE_PARAMS.waveSpeed.max]) {
      const e = makeEngine({ params: { waveSpeed: speed } }), l = watch(e);
      stirFor(e, 3, 2, 0.5, 0.5, 0.06, 2);
      counts.push(l.length);
    }
    const lo = Math.min(...counts), hi = Math.max(...counts);
    report(lo > 30 && hi / lo < 1.1, 'a stir puts in the same at any flow — never near-silent at the slowest', `${counts.join(' / ')} drops in 3 s at flow 4 / 39 / 450`);
    // At the slowest flow it's heard: stones near it ring within a few seconds.
    const slow = makeEngine({ params: { waveSpeed: SURFACE_PARAMS.waveSpeed.min } });
    const sx = slow.stones.x[0], sy = slow.stones.y[0];
    let rang = 0;
    for (let t = 0; t < 5; t += 1 / 30) { slow.stir(0, sx, sy, 0.05, 2); slow.process(1600); rang += slow.strikes.count; }
    report(rang > 0, 'at the slowest flow, stirring over a stone rings it within a few seconds', `${rang} strikes in 5 s`);
  }
  {
    // Which way round: drops follow a point circling the way you stir, so the
    // stones around play in that order.
    const spin = (turns) => {
      const e = makeEngine(), l = watch(e);
      stirFor(e, 2, 0, 0.5, 0.5, 0.1, turns);
      // Small steps between successive drops (the ones following the
      // circling point): which way do most of them go?
      let ahead = 0, back = 0, prev = null;
      for (const d of l) {
        const a = Math.atan2((d.y - 0.5) * (97 / 128), d.x - 0.5);
        if (prev !== null) {
          let da = a - prev; da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
          if (Math.abs(da) < 1.2) { if (da > 0) ahead++; else back++; }
        }
        prev = a;
      }
      return ahead / Math.max(1, ahead + back);
    };
    const cw = spin(1.5), ccw = spin(-1.5);
    report(cw > 0.6 && ccw < 0.4, 'a stir goes round the way you stir it (the other way, the other way round)',
      `${Math.round(cw * 100)}% of steps go one way stirring one way; ${Math.round((1 - ccw) * 100)}% the other way, the other`);
  }
  {
    // A long stir fills splash less than touches would (a quarter as much per drop).
    const e = makeEngine({ params: { splash: 0.8 } });
    stirFor(e, 8, 0, 0.5, 0.5, 0.08, 2);
    report(e.reservoir < 32, 'a long stir doesn\'t pin splash at its limit', `reservoir ${e.reservoir.toFixed(1)} of 32`);
  }
  {
    // A long, hard stir everywhere never runs away.
    const e = makeEngine({ params: { splash: 0.8 } });
    let top = 0, finite = true;
    for (let t = 0; t < 20 * 48000; t += 128) {
      if (t % 1536 === 0) for (let k = 0; k < MAX_STIRS; k++) e.stir(k, 0.1 + 0.08 * k, 0.5, 0.15, 8);
      e.process(128);
      const en = e.surface.energy();
      if (!Number.isFinite(en)) finite = false;
      top = Math.max(top, en);
    }
    run(e, 60);
    // (A strength-1 tap is ~2e4; the runaway guard is 1e12.)
    report(finite && top < 1e7 && e.surface.resets === 0 && e.surface.asleep, 'ten fingers stirring flat out for 20 s: lively, bounded, never reset — and then silence', `peak energy ${top.toExponential(1)}`);
  }
  {
    const e = makeEngine();
    for (const args of [[-1, 0.5, 0.5, 0.1, 1], [MAX_STIRS, 0.5, 0.5, 0.1, 1], [0.5, 0.5, 0.5, 0.1, 1], [0, NaN, 0.5, 0.1, 1], [0, 0.5, 0.5, Infinity, 1], [0, 0.5, 0.5, 0.1, NaN]]) e.stir(...args);
    run(e, 1);
    report(e.stirDrops === 0 && e.surface.asleep, 'bad stirs are ignored');
  }
  {
    // Let go, its turbulence dies away where it was stirred (whatever place
    // the let-go names) — and a stir nobody refreshes (a lost let-go) stops.
    const e = makeEngine(), landed = watch(e);
    stirFor(e, 2, 3, 0.2, 0.25, 0.08, 2);
    const n0 = landed.length;
    e.stir(3, 0.5, 0.5, 0.05, 0);
    run(e, 2);
    const after = landed.slice(n0);
    const where = after.every((d) => Math.hypot(d.x - 0.2, (d.y - 0.25) * (97 / 128)) <= 0.08 + 1e-9);
    const f = makeEngine(), l2 = watch(f);
    f.stir(4, 0.5, 0.5, 0.1, 2); // never refreshed, never let go
    run(f, 3);
    const n1 = l2.length;
    run(f, 2);
    report(after.length > 0 && where && l2.length === n1 && f.stirsActive === 0,
      'a let-go stir dies away where it was stirred; one never refreshed lets go by itself', `${after.length} drops after letting go, all in the stirred circle; unrefreshed: ${n1} drops, then none`);
  }
}

console.log('\n13. CPU per 128-sample block at 48 kHz (budget 2667 µs)');
{
  const e = makeEngine({ params: { splash: 0.5 } });
  let i = 0;
  const drive = () => { if (i % 40 === 0) e.drop((i * 0.13) % 1, (i * 0.29) % 1, 1); i++; };
  for (let k = 0; k < 500; k++) { drive(); e.process(128); }
  const blocks = 3000, t0 = performance.now();
  for (let k = 0; k < blocks; k++) { drive(); e.process(128); }
  const us = ((performance.now() - t0) * 1000) / blocks, pct = (us / 2667) * 100;
  report(pct < 15, `128×97 water + ${PENTA.length} stones, playing: ${us.toFixed(0)} µs/block, ${pct.toFixed(1)}% of real time`, 'limit 15%');

  // Ten hands resting on moving water (every finger stilling).
  const hh = makeEngine({ params: { splash: 0.5 } });
  for (let k = 0; k < MAX_HANDS; k++) hh.still(k, 0.05 + 0.09 * k, 0.3 + 0.04 * k, 1);
  let j = 0;
  const driveH = () => { if (j % 40 === 0) hh.drop((j * 0.13) % 1, (j * 0.29) % 1, 1); j++; };
  for (let k = 0; k < 500; k++) { driveH(); hh.process(128); }
  const t2 = performance.now();
  for (let k = 0; k < blocks; k++) { driveH(); hh.process(128); }
  const usH = ((performance.now() - t2) * 1000) / blocks, pctH = (usH / 2667) * 100;
  report(pctH < 25, `the same, with all ${MAX_HANDS} hands resting: ${usH.toFixed(0)} µs/block, ${pctH.toFixed(1)}%`, 'limit 25%');

  // Worst burst: a full gesture queue landing on one step (64 hard drops).
  // Measured as the 95th percentile of the burst blocks, not the single worst:
  // one garbage-collection pause otherwise decides this check (a real
  // regression makes every block slow, so the percentile still catches it).
  const b = makeEngine({ params: { splash: 0.8 } });
  for (let k = 0; k < 200; k++) b.process(128); // warm up
  const burst = [];
  for (let rep = 0; rep < 60; rep++) {
    for (let q = 0; q < 64; q++) b.drop((q * 0.17) % 1, (q * 0.43) % 1, 16);
    const t1 = performance.now();
    b.process(128);
    burst.push((performance.now() - t1) * 1000);
    for (let k = 0; k < 50; k++) b.process(128);
  }
  burst.sort((x, y) => x - y);
  const worst = burst[Math.floor(burst.length * 0.95)], high = burst[burst.length - 1];
  report(worst / 2667 < 0.25, `burst of 64 drops on one step: 95th-percentile block ${worst.toFixed(0)} µs, ${((worst / 2667) * 100).toFixed(1)}%`,
    `limit 25% (worst single block ${high.toFixed(0)} µs)`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll water checks passed.');
process.exit(failures ? 1 : 0);
