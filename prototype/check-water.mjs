// check-water.mjs — checks for the generative medium (surface + stones +
// engine), without sound. Agents can't hear; these are what we can prove.
//   node check-water.mjs

import { Surface, SURFACE_PARAMS, SIM_RATE } from './surface.js';
import { Stones, StrikeBuffer } from './stones.js';
import { Engine, ENGINE_PARAMS } from './engine.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { performance } from 'node:perf_hooks';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const PENTA = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });

function makeEngine({ fs = 48000, seed = 1, pitches = PENTA, layout = 'scattered', params = {} } = {}) {
  const e = new Engine({ sampleRate: fs, seed });
  const { xs, ys } = stonePositions(pitches.length, layout);
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
  const s = new Surface();
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
    const s = new Surface();
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
for (const c of [32, 64, 200]) {
  const s = new Surface();
  const y = s.toGridY(0.5), x0 = s.toGridX(0.2);
  // Window ends before the first reflection can reach the nearer point.
  const [a, b] = probe({ waveSpeed: c }, 0.2, 0.5, [[x0 + 16, y], [x0 + 48, y]], (1.1 * 48) / c + 0.06);
  const measured = 32 / (b.t - a.t);
  report(Math.abs(measured / c - 1) < 0.05, `${c} cells/s`, `measured ${measured.toFixed(1)} cells/s`);
}

console.log('\n2b. Tempo changes timing, not crest height');
{
  const heights = [25, 64, 450].map((c) => {
    const s = new Surface();
    const x0 = s.toGridX(0.3), y = s.toGridY(0.5);
    const [p] = probe({ waveSpeed: c }, 0.3, 0.5, [[x0 + 12, y]], (1.1 * 30) / c + 0.1);
    return p.h;
  });
  const spread = Math.max(...heights) / Math.min(...heights);
  report(spread < 1.1, 'crest 12 cells from a strength-1 drop at 25 / 64 / 450 cells/s',
    heights.map((h) => h.toFixed(3)).join(' / '));
}

console.log('\n2c. Ripples are the same in every direction');
{
  const s = new Surface(), cx = s.toGridX(0.5), cy = s.toGridY(0.5), d = 45 / Math.SQRT2;
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
  const e = new Engine({ seed: 1 });
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
  const s0 = new Surface();
  const sx = s0.toGridX(0.5), sy = s0.toGridY(0.5);
  const d = 30 / (s0.w - 1);
  const [alone] = probe({}, 0.5 - d, 0.5, [[sx, sy]], 1.5);
  const threshold = 1.4 * alone.h;
  const ring = (drops) => {
    const s = new Surface(), st = new Stones(), out = new StrikeBuffer();
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
  const e = new Engine({ seed: 1 });
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
  const e = new Engine({ seed: 1 });
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

  // Worst burst: a full gesture queue landing on one step (64 hard drops).
  const b = makeEngine({ params: { splash: 0.8 } });
  for (let k = 0; k < 200; k++) b.process(128); // warm up
  let worst = 0;
  for (let rep = 0; rep < 20; rep++) {
    for (let q = 0; q < 64; q++) b.drop((q * 0.17) % 1, (q * 0.43) % 1, 16);
    const t1 = performance.now();
    b.process(128);
    worst = Math.max(worst, (performance.now() - t1) * 1000);
    for (let k = 0; k < 50; k++) b.process(128);
  }
  report(worst / 2667 < 0.25, `burst of 64 drops on one step: worst block ${worst.toFixed(0)} µs, ${((worst / 2667) * 100).toFixed(1)}%`, 'limit 25%');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll water checks passed.');
process.exit(failures ? 1 : 0);
