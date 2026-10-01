// engine.js — the generative medium: water + stones on one fixed clock.
//
// The surface steps SIM_RATE times per second of *stream time*, whatever the
// sample rate or block size, so the same gestures always give the same notes.
// Gestures are scheduled onto simulation steps. After every step the stones
// listen; each strike can splash a smaller ripple back into the water (the
// "splash" knob). Splash always dies out: it is weaker than the crest that
// caused it, rationed per second, and paid from a reservoir only gestures fill.
//
// Bell voices come in step 3; process() reports strikes with their sample
// positions so the voices can start exactly on time. No allocation after
// construction on the audio path.

import { Surface, SURFACE_PARAMS, SIM_RATE } from './surface.js';
import { Stones, StrikeBuffer, STONE_PARAMS, MAX_STONES } from './stones.js';

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

export class Engine {
  constructor({ sampleRate = 48000, width = 128, height = 97, seed = 1 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    this.fs = sampleRate;
    this.samplesPerStep = sampleRate / SIM_RATE;
    this.surface = new Surface({ width, height });
    this.stones = new Stones();
    this.strikes = new StrikeBuffer(256); // per audio block, for the voices
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
  drop(x, y, strength = 1, atSeconds) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(strength)) return;
    const jx = (this.rand() - 0.5) * 0.6 / (this.surface.w - 1);
    const jy = (this.rand() - 0.5) * 0.6 / (this.surface.h - 1);
    const s = Math.min(16, Math.max(0, strength)) * (1 + (this.rand() - 0.5) * 0.3);
    const r = DROP_RADIUS * (1 + (this.rand() - 0.5) * 0.4);
    this.schedule(x + jx, y + jy, s, r, atSeconds);
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
