// engine.js — the generative medium: water + stones on one fixed clock.
//
// The surface steps SIM_RATE times per second of *stream time*, whatever the
// sample rate or block size, so the same gestures always give the same notes.
// Gestures are scheduled onto simulation steps. After every step the stones
// listen; each strike can splash a smaller ripple back into the water (the
// "splash" knob). Splash always dies out: it is weaker than the crest that
// caused it, rationed per second, and paid from a reservoir only gestures fill.
//
// process() reports strikes with their sample positions so the voices can
// start exactly on time. No allocation after construction on the audio path.

import { Surface, SURFACE_PARAMS, SIM_RATE } from './surface.js';
import { Stones, StrikeBuffer, STONE_PARAMS, MAX_STONES, STRIKE_LIST } from './stones.js';

export const ENGINE_PARAMS = {
  ...SURFACE_PARAMS,
  ...STONE_PARAMS,
  splash: { min: 0, max: 0.8, def: 0.21 }, // splash height ÷ crest height (default from Dash's session)
};
export const ENGINE_PARAM_KEYS = Object.keys(ENGINE_PARAMS);

const MAX_SCHEDULED = 64;
const SCHEDULE_HORIZON_STEPS = 10 * SIM_RATE; // gestures can be scheduled ≤ 10 s ahead
const DROP_RADIUS = 1.5; // cells
const SPLASH_RADIUS = 1.2;
// A drop of strength s peaks at ~s/8 a dozen cells away, so this makes a
// splash re-create about (splash × the crest that caused it) at the nearest
// stones: each generation is weaker by at least the splash factor (< 1).
const SPLASH_REACH = 8;
const SPLASH_RATE = 24; // splashes per second, at most (token bucket)
const SPLASH_BURST = 6;
const MIN_SPLASH = 1e-3;
const RESERVOIR_PER_STRENGTH = 3; // splash strength a gesture makes available
const RESERVOIR_MAX = 32;
const TRAIL_SPACING = 3; // cells between drops along a drag
const TRAIL_GAIN = 0.35; // trail drop strength per (surface-width per second)
const MAX_TRAIL_DROPS = 8;
// Stir (CLAUDE.md: "continuous circular motion that builds turbulence"): a
// finger circling drops small, fine ripples around its circle — mostly just
// behind a point that circles with it, so the stones around it play in turn,
// the way you stir. Its turbulence builds the longer and faster you stir and
// dies away once you stop. Those times are the hand's (real time), and drops
// are spaced by how far the finger travels, like a drag's trail: a stir puts
// in the same energy at any flow, and the water answers at its own pace.
export const MAX_STIRS = 10;
const STIR_BUILD_SECONDS = 1.5; // to reach most of its turbulence while stirring steadily
const STIR_FADE_SECONDS = 0.5; // to die away after you stop
const STIR_GONE = 0.05; // once let go, turbulence below this is over (no long dribble)
const STIR_SPACING = 3; // cells of finger travel per drop (as a trail's)
const STIR_MAX_DROPS_PER_SECOND = 60; // one source, however wide and fast
const STIR_FOLLOW = 0.7; // share of drops near the circling point (the rest scatter in its wake)
const STIR_SPLASH_SHARE = 0.25; // a stir feeds splash less than a touch (it puts in a lot, steadily)
const STIR_MIN_STRENGTH = 0.12, STIR_MAX_STRENGTH = 0.5; // small drops: choppy, never a slap
const STIR_DROP_RADIUS = 0.9; // cells: fine ripples
const STIR_FULL_SPEED = 2; // turns per second that count as stirring flat out
const STIR_STALE_SECONDS = 0.25; // a stir not refreshed this long (stream time) is let go — a lost let-go can't stir forever
const STIR_BUILD = 1 - Math.exp(-1 / (STIR_BUILD_SECONDS * SIM_RATE)); // per step (the hand's time)
const STIR_FADE = 1 - Math.exp(-1 / (STIR_FADE_SECONDS * SIM_RATE));

export class Engine {
  constructor({ sampleRate = 48000, width = 128, height = 97, seed = 1 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    this.fs = sampleRate;
    this.samplesPerStep = sampleRate / SIM_RATE;
    this.surface = new Surface({ width, height });
    this.stones = new Stones();
    this.strikes = new StrikeBuffer(STRIKE_LIST); // per audio block, for the voices
    this.stepStrikes = new StrikeBuffer(MAX_STONES); // per simulation step
    this.seenResets = 0;
    this.gesturesDropped = 0; // diagnostics: queue full or beyond the horizon
    this.sample = 0; // stream position, in samples
    this.simStep = 0; // simulation steps taken

    this.qActive = new Uint8Array(MAX_SCHEDULED);
    this.qStep = new Float64Array(MAX_SCHEDULED);
    this.qX = new Float64Array(MAX_SCHEDULED);
    this.qY = new Float64Array(MAX_SCHEDULED);
    this.qStrength = new Float64Array(MAX_SCHEDULED);
    this.qRadius = new Float64Array(MAX_SCHEDULED);

    this.splash = ENGINE_PARAMS.splash.def;
    this.splashTokens = SPLASH_BURST;
    this.reservoir = 0;
    this.updateReservoirDrain();
    this.splashes = 0; // diagnostics

    this.rng = new Uint32Array(1);
    this.rng[0] = seed >>> 0 || 1;
    // Anything that plays gestures on the water clock (the gesture looper):
    // its onStep(step, engine) runs once per step, before that step's
    // gestures land.
    this.stepListener = null;
    this.qCount = 0; // scheduled gestures waiting

    // Stir sources: where each circles (pond terms), how fast it's stirred
    // now (0 when let go), and the turbulence it has built (0..1).
    this.stirX = new Float64Array(MAX_STIRS);
    this.stirY = new Float64Array(MAX_STIRS);
    this.stirR = new Float64Array(MAX_STIRS);
    this.stirPace = new Float64Array(MAX_STIRS);
    this.stirEnergy = new Float64Array(MAX_STIRS);
    this.stirDue = new Float64Array(MAX_STIRS); // drops owed (a fraction carries over)
    this.stirSeen = new Float64Array(MAX_STIRS); // the step it was last told about
    this.stirSpin = new Float64Array(MAX_STIRS).fill(1); // +1 / −1: which way it's stirred
    this.stirAngle = new Float64Array(MAX_STIRS); // where on its circle the stir is now (radians)
    this.stirsActive = 0;
    this.stirDrops = 0; // diagnostics
  }

  queueFull() {
    return this.qCount >= MAX_SCHEDULED;
  }

  setParam(name, value) {
    if (!Number.isFinite(value)) return;
    if (Object.prototype.hasOwnProperty.call(SURFACE_PARAMS, name)) {
      this.surface.setParam(name, value);
      this.updateReservoirDrain();
    }
    else if (name === 'threshold') this.stones.setThreshold(value);
    else if (name === 'splash') this.splash = Math.min(ENGINE_PARAMS.splash.max, Math.max(0, value));
  }

  // Same, by index into ENGINE_PARAM_KEYS (what the worklet's event queue sends).
  setParamIndex(i, value) {
    if (Number.isInteger(i) && i >= 0 && i < ENGINE_PARAM_KEYS.length) this.setParam(ENGINE_PARAM_KEYS[i], value);
  }

  setStones(xs, ys, hzs, count) {
    this.stones.setStones(this.surface, xs, ys, hzs, count);
  }

  // ---- gestures ---------------------------------------------------------------

  // A drop at (x, y) in [0, 1]², now (at the next simulation step) or at
  // `atSeconds` of stream time. Each drop varies a little.
  // Returns false if it was ignored or the gesture queue had no room.
  drop(x, y, strength = 1, atSeconds) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(strength)) return false;
    const jx = (this.rand() - 0.5) * 0.6 / (this.surface.w - 1);
    const jy = (this.rand() - 0.5) * 0.6 / (this.surface.h - 1);
    const s = Math.min(16, Math.max(0, strength)) * (1 + (this.rand() - 0.5) * 0.3);
    const r = DROP_RADIUS * (1 + (this.rand() - 0.5) * 0.4);
    return this.schedule(x + jx, y + jy, s, r, atSeconds);
  }

  // A drag from (x0, y0) to (x1, y1) at `speed` surface-widths per second:
  // small drops spaced along the path, stronger the faster you move.
  trail(x0, y0, x1, y1, speed, atSeconds) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) ||
        !Number.isFinite(y1) || !Number.isFinite(speed) || speed <= 0) return;
    const dx = (x1 - x0) * (this.surface.w - 1), dy = (y1 - y0) * (this.surface.h - 1);
    const n = Math.min(MAX_TRAIL_DROPS, Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy) / TRAIL_SPACING)));
    const s = Math.min(16, TRAIL_GAIN * speed);
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const jitter = 1 + (this.rand() - 0.5) * 0.3;
      this.schedule(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, s * jitter, DROP_RADIUS * 0.8, atSeconds);
    }
  }

  // Stir: source `id` circles (x, y) with radius `r` (pond widths) at `turns`
  // per second (0: let go — its turbulence dies away by itself).
  stir(id, x, y, r, turns) {
    if (!Number.isInteger(id) || id < 0 || id >= MAX_STIRS) return;
    if (turns === 0) { this.stirPace[id] = 0; return; } // let go: it dies away where it was
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || !Number.isFinite(turns)) return;
    this.stirSeen[id] = this.simStep;
    this.stirX[id] = x < 0 ? 0 : x > 1 ? 1 : x;
    this.stirY[id] = y < 0 ? 0 : y > 1 ? 1 : y;
    this.stirR[id] = r < 0.005 ? 0.005 : r > 0.4 ? 0.4 : r;
    this.stirPace[id] = Math.min(8, Math.abs(turns));
    this.stirSpin[id] = turns < 0 ? -1 : 1; // which way round
    this.stirsActive = 1; // (recounted on the next step)
  }

  // Still: hand `id` rests at (x, y) with `pressure` 0..1 (0 lifts it).
  // Takes effect from the next step; never delayed by quantize.
  still(id, x, y, pressure) {
    this.surface.setHand(id, x, y, pressure);
  }

  schedule(x, y, strength, radius, atSeconds) {
    const step = atSeconds === undefined || !Number.isFinite(atSeconds)
      ? this.simStep + 1
      : Math.max(this.simStep + 1, Math.ceil(atSeconds * SIM_RATE - 1e-9));
    // Nothing further ahead than the horizon, so far-future gestures can't
    // hold queue slots forever.
    if (step > this.simStep + SCHEDULE_HORIZON_STEPS) { this.gesturesDropped++; return false; }
    if (this.qCount >= MAX_SCHEDULED) { this.gesturesDropped++; return false; } // full: fail fast
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      if (this.qActive[i]) continue;
      this.qActive[i] = 1;
      this.qCount++;
      this.qStep[i] = step; this.qX[i] = x; this.qY[i] = y;
      this.qStrength[i] = strength; this.qRadius[i] = radius;
      return true;
    }
    this.gesturesDropped++; // queue full
    return false;
  }

  // ---- stream (audio thread) ----------------------------------------------------

  // Advance the stream by n samples. Strikes from this span are left in
  // this.strikes (cleared at the start of each call); strikeSample(i) gives
  // each one's sample offset within this block.
  process(n) {
    this.strikes.clear();
    this.blockStart = this.sample;
    if (!Number.isInteger(n) || n <= 0) return;
    const end = this.sample + n;
    // Step k belongs to stream sample floor(k × samplesPerStep): one fixed
    // position, however the stream is split into blocks.
    while (this.stepSample(this.simStep + 1) < end) {
      const next = this.simStep + 1;
      if (this.stepListener) this.stepListener.onStep(next, this);
      if (this.stirsActive) this.stirStep(next);
      this.applyScheduled(next);
      this.surface.step();
      this.simStep = next;
      if (this.surface.resets !== this.seenResets) {
        // The surface's runaway guard wiped the water: start splash afresh too.
        this.seenResets = this.surface.resets;
        this.reservoir = 0;
        this.splashTokens = SPLASH_BURST;
      }
      if (!this.surface.asleep) {
        // Strikes go to a per-step list first, so splashes (and so the water's
        // future) never depend on how many strikes fit in one audio block.
        this.stepStrikes.clear();
        this.stones.detect(this.surface, next, this.stepStrikes);
        this.splashFrom(this.stepStrikes);
        this.strikes.append(this.stepStrikes);
      } else {
        this.stones.calm();
      }
      if (this.splashTokens < SPLASH_BURST) this.splashTokens += SPLASH_RATE / SIM_RATE;
      this.reservoir = this.reservoir > 1e-12 ? this.reservoir * this.reservoirKeep : 0;
    }
    this.sample = end;
  }

  stepSample(k) {
    return Math.floor(k * this.samplesPerStep + 1e-9);
  }

  // Sample offset (within the last process() block) at which strike i was
  // heard: the step on which it was detected, i.e. just after its crest.
  strikeSample(i) {
    return this.stepSample(this.strikes.detected[i]) - this.blockStart;
  }

  // Stream time of strike i's crest, in seconds (rate-independent).
  strikeSeconds(i) {
    return this.strikes.step[i] / SIM_RATE;
  }

  // ---- internals ------------------------------------------------------------

  // One step of every stir: turbulence builds toward how hard it's stirred
  // (and fades once let go); drops owed at its rate land around its circle
  // at this step. At most one drop per source per step.
  stirStep(step) {
    const build = STIR_BUILD, fade = STIR_FADE;
    const w = this.surface.w, aspect = this.surface.h / w;
    let active = 0;
    for (let k = 0; k < MAX_STIRS; k++) {
      let e = this.stirEnergy[k];
      if (this.stirPace[k] > 0 && step - this.stirSeen[k] > STIR_STALE_SECONDS * SIM_RATE) this.stirPace[k] = 0; // gone quiet: let go
      const pace = this.stirPace[k];
      if (pace <= 0 && e === 0) continue;
      const target = pace >= STIR_FULL_SPEED ? 1 : pace / STIR_FULL_SPEED;
      e += (target - e) * (target > e ? build : fade);
      if (pace <= 0 && e < STIR_GONE) e = 0;
      this.stirEnergy[k] = e;
      if (e === 0) { this.stirDue[k] = 0; continue; }
      active++;
      // The circling point goes round with the finger (and slows to a stop when let go).
      const r = this.stirR[k];
      let ang = this.stirAngle[k] + (this.stirSpin[k] * 2 * Math.PI * Math.max(pace, 0.5 * e)) / SIM_RATE;
      if (ang > Math.PI) ang -= 2 * Math.PI; else if (ang < -Math.PI) ang += 2 * Math.PI;
      this.stirAngle[k] = ang;
      // Drops as the finger travels its circle: one per STIR_SPACING cells.
      const perSecond = Math.min(STIR_MAX_DROPS_PER_SECOND, (2 * Math.PI * r * w * Math.max(pace, STIR_FULL_SPEED * e)) / STIR_SPACING);
      let due = this.stirDue[k] + (e * perSecond) / SIM_RATE;
      if (due >= 1) {
        due -= 1;
        if (due > 1) due = 1; // never a backlog
        // Mostly just behind the circling point, near the rim; the rest anywhere in the stirred ring.
        const follow = this.rand() < STIR_FOLLOW;
        const a = follow ? this.stirAngle[k] - this.stirSpin[k] * this.rand() * 0.9 : this.rand() * 2 * Math.PI;
        const d = r * (follow ? 0.75 + 0.25 * this.rand() : 0.4 + 0.6 * Math.sqrt(this.rand()));
        const x = this.stirX[k] + Math.cos(a) * d, y = this.stirY[k] + (Math.sin(a) * d) / aspect;
        const st = (STIR_MIN_STRENGTH + (STIR_MAX_STRENGTH - STIR_MIN_STRENGTH) * e) * (0.7 + 0.6 * this.rand());
        // Straight into the water (not the gesture queue, which touches use).
        if (this.surface.drop(x < 0 ? 0 : x > 1 ? 1 : x, y < 0 ? 0 : y > 1 ? 1 : y, st, STIR_DROP_RADIUS)) {
          this.reservoir = Math.min(RESERVOIR_MAX, this.reservoir + RESERVOIR_PER_STRENGTH * STIR_SPLASH_SHARE * st);
          this.stirDrops++;
        }
      }
      this.stirDue[k] = due;
    }
    this.stirsActive = active;
  }


  applyScheduled(step) {
    for (let i = 0; i < MAX_SCHEDULED; i++) {
      if (this.qActive[i] && this.qStep[i] <= step) {
        if (this.surface.drop(this.qX[i], this.qY[i], this.qStrength[i], this.qRadius[i])) {
          // Only the performer's gestures fill the splash reservoir.
          this.reservoir = Math.min(RESERVOIR_MAX, this.reservoir + RESERVOIR_PER_STRENGTH * this.qStrength[i]);
        }
        this.qActive[i] = 0;
        this.qCount--;
      }
    }
  }

  // Unspent splash drains away with the water itself (the decay knob).
  updateReservoirDrain() {
    this.reservoirKeep = Math.pow(10, -3 / (this.surface.effectiveDecay() * SIM_RATE));
  }

  // The water only gives back what you put in: every splash spends from a
  // reservoir that only gestures fill (and that drains over time), so the
  // total splash ever made is bounded by what was played — chains can't
  // sustain themselves, however sensitive the stones.
  splashFrom(st) {
    if (this.splash <= 0) return;
    const stones = this.stones;
    for (let i = 0; i < st.count; i++) {
      if (this.splashTokens < 1) return;
      const strength = Math.min(SPLASH_REACH * this.splash * st.height[i], this.reservoir);
      if (!(strength >= MIN_SPLASH)) continue; // also skips NaN
      const k = st.stone[i];
      if (!this.surface.drop(stones.x[k], stones.y[k], strength, SPLASH_RADIUS)) continue;
      this.splashTokens -= 1;
      this.reservoir -= strength;
      this.splashes++;
    }
  }

  rand() {
    let x = this.rng[0];
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng[0] = x;
    return x / 4294967296;
  }
}

export { SIM_RATE };
