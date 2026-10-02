// stones.js — tuned points in the water that ring when a crest reaches them.
//
// Phase 1b hypothesis for CLAUDE.md's open question "what makes a stone
// ring": a crest whose peak rises past a threshold. The stone strikes at the
// peak (timing interpolated between simulation steps), harder for higher
// crests, then must settle back below a lower level before it can ring again.
// Two ripples too small to ring a stone alone can ring it where they meet.
// The whole rule lives in detect(); trying "energy arriving" instead later
// means replacing that one method.
//
// Fixed capacity, allocated up front; detect() allocates nothing.

import { SIM_RATE } from './surface.js';

export const MAX_STONES = 128;
// Every stone can ring at most once per simulation step, so this is how many
// strikes one audio block's list must hold for the usual block sizes (the
// instrument's per-tick list is HOLD_STEPS × MAX_STONES). A larger block than
// this drops the excess, counted in StrikeBuffer.dropped.
export const STRIKE_LIST = 4 * MAX_STONES;
export const STONE_PARAMS = {
  // Crest height a stone needs to ring, in the units of Surface.drop strength.
  // At the default, one strength-1 drop rings ~25 stones over ~2 s (direct
  // waves and reflections); lower rings more, for longer.
  threshold: { min: 0.005, max: 0.3, def: 0.015 },
};
const REARM_FRACTION = 0.3; // must fall below threshold × this to ring again
// How much the water around a stone is moving (for water-held sustain): a
// peak follower of |height| that lets go over ~0.3 s of stream time.
const MOTION_RELEASE = Math.exp(-1 / (0.3 * SIM_RATE)); // per simulation step
const MIN_HZ = 8, MAX_HZ = 20000; // usable stone pitches; voices also drop partials above Nyquist

const ARMED = 0, RISING = 1, SPENT = 2;

export class Stones {
  constructor() {
    this.count = 0;
    this.gx = new Float64Array(MAX_STONES); // surface interior coordinates
    this.gy = new Float64Array(MAX_STONES);
    this.x = new Float64Array(MAX_STONES); // [0, 1] positions, for splashes and drawing
    this.y = new Float64Array(MAX_STONES);
    this.hz = new Float64Array(MAX_STONES);
    this.enabled = new Uint8Array(MAX_STONES);
    this.state = new Uint8Array(MAX_STONES);
    this.prevH = new Float64Array(MAX_STONES);
    this.peakH = new Float64Array(MAX_STONES);
    this.beforePeakH = new Float64Array(MAX_STONES);
    this.peakStep = new Float64Array(MAX_STONES);
    this.motion = new Float64Array(MAX_STONES);
    this.threshold = STONE_PARAMS.threshold.def;
  }

  // How much the water around stone i is moving: 0 calm → 1 when it's as
  // high as a crest that rings it (smoothed, so it eases in and out).
  wet(i) {
    if (!(i < this.count) || !this.enabled[i]) return 0;
    const m = this.motion[i] / this.threshold;
    const x = m >= 1 ? 1 : m > 0 ? m : 0; // NaN → 0
    return x * x * (3 - 2 * x);
  }

  // Each step while the water is asleep (flat): the stones' motion lets go.
  calm() {
    for (let i = 0; i < this.count; i++) this.motion[i] *= MOTION_RELEASE;
  }

  setThreshold(value) {
    const p = STONE_PARAMS.threshold;
    if (Number.isFinite(value)) this.threshold = value < p.min ? p.min : value > p.max ? p.max : value;
  }

  // Place and tune the stones. xs, ys in [0, 1]; hzs the pitches. Retuning only
  // changes the stones — the water is never touched. A newly added stone that
  // lands where the water is already high waits for it to settle; a stone that
  // was already there keeps listening as it moves, so dragging it through
  // moving water rings it as crests pass over it.
  // A stone with a non-finite position or an unusable pitch is kept in its
  // slot (so the others keep their places) but disabled.
  setStones(surface, xs, ys, hzs, count) {
    if (!Number.isFinite(count)) return;
    const n = Math.max(0, Math.min(MAX_STONES, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const ok = Number.isFinite(xs[i]) && Number.isFinite(ys[i]) &&
        Number.isFinite(hzs[i]) && hzs[i] >= MIN_HZ && hzs[i] <= MAX_HZ;
      const wasEnabled = this.enabled[i];
      this.enabled[i] = ok ? 1 : 0;
      const x = ok ? xs[i] : 0.5, y = ok ? ys[i] : 0.5;
      const gx = surface.toGridX(x), gy = surface.toGridY(y);
      const added = i >= this.count;
      this.x[i] = x; this.y[i] = y;
      this.gx[i] = gx; this.gy[i] = gy;
      this.hz[i] = ok ? hzs[i] : 0;
      if (added || (ok && !wasEnabled)) {
        // A stone that starts listening now (new, or enabled again after a bad
        // pitch) begins from the water where it is: calm motion, no history.
        const h = surface.heightAt(gx, gy);
        this.prevH[i] = h;
        this.motion[i] = 0;
        this.state[i] = h < this.threshold * REARM_FRACTION ? ARMED : SPENT;
      }
    }
    this.count = n;
  }

  // Give one existing stone a new pitch (it moved into another note's place).
  // Ignored for a stone that doesn't exist or an unusable pitch. A ringing
  // stone's bell picks it up at its next strike.
  setPitch(surface, i, hz) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count || !Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) return;
    this.hz[i] = hz;
    if (!this.enabled[i]) {
      // Switched back on: it starts listening now, as a newly placed stone
      // does — never finishing a crest it was in the middle of when it stopped.
      const h = surface.heightAt(this.gx[i], this.gy[i]);
      this.prevH[i] = h;
      this.motion[i] = 0;
      this.state[i] = h < this.threshold * REARM_FRACTION ? ARMED : SPENT;
      this.enabled[i] = 1;
    }
  }

  // Move one existing stone (e.g. while the performer drags it). It keeps
  // listening, so it rings as it passes through crests.
  moveStone(surface, i, x, y) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x[i] = x < 0 ? 0 : x > 1 ? 1 : x;
    this.y[i] = y < 0 ? 0 : y > 1 ? 1 : y;
    this.gx[i] = surface.toGridX(this.x[i]);
    this.gy[i] = surface.toGridY(this.y[i]);
    // Read the water at the new spot, so a crest's peak is never fitted from
    // samples taken in two different places.
    const h = surface.heightAt(this.gx[i], this.gy[i]);
    this.prevH[i] = h;
    if (this.state[i] === RISING) {
      if (h < this.threshold) this.state[i] = h < this.threshold * REARM_FRACTION ? ARMED : SPENT; // moved off the crest
      else { this.peakH[i] = h; this.beforePeakH[i] = h; }
    }
  }

  // Run once per simulation step, after the surface steps. Writes strikes into
  // `out` (a StrikeBuffer) with fractional step times. Returns strikes added.
  detect(surface, step, out) {
    const th = this.threshold, rearm = th * REARM_FRACTION;
    let added = 0;
    for (let i = 0; i < this.count; i++) {
      if (!this.enabled[i]) continue;
      const h = surface.heightAt(this.gx[i], this.gy[i]);
      if (!Number.isFinite(h)) { // guard: never strike on, or remember, bad water
        this.state[i] = SPENT;
        this.prevH[i] = 0;
        this.motion[i] = 0;
        continue;
      }
      const a = h < 0 ? -h : h, m = this.motion[i] * MOTION_RELEASE;
      this.motion[i] = a > m ? a : m;
      switch (this.state[i]) {
        case ARMED:
          if (h >= th) {
            this.state[i] = RISING;
            this.peakH[i] = h;
            this.beforePeakH[i] = this.prevH[i];
            this.peakStep[i] = step;
          }
          break;
        case RISING:
          if (h >= this.peakH[i]) {
            this.beforePeakH[i] = this.peakH[i];
            this.peakH[i] = h;
            this.peakStep[i] = step;
          } else {
            // Past the crest: fit a parabola through the three samples around
            // the peak for its true time and height.
            const a = this.beforePeakH[i], b = this.peakH[i], c = h;
            const den = a - 2 * b + c;
            const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
            const height = b - 0.25 * (a - c) * off;
            if (out.push(i, this.peakStep[i] + off, step, height, strikeVelocity(height, th))) added++;
            this.state[i] = SPENT;
          }
          break;
        case SPENT:
          if (h < rearm) this.state[i] = ARMED;
          break;
      }
      this.prevH[i] = h;
    }
    return added;
  }
}

// Crest height → strike velocity in [0, 1]: a crest barely over the threshold
// is nearly silent, so as the water calms phrases fade out rather than stop at
// a fixed level; eight times the threshold or more is full.
export function strikeVelocity(height, threshold) {
  const v = Math.log2(height / threshold) / 3;
  return !(v > 0) ? 0 : v > 1 ? 1 : v; // NaN → 0
}

// Fixed-capacity list of strikes, reused every block.
export class StrikeBuffer {
  constructor(capacity = 256) {
    this.capacity = capacity;
    this.count = 0;
    this.dropped = 0;
    this.stone = new Int32Array(capacity);
    this.step = new Float64Array(capacity); // fractional simulation step of the crest
    this.detected = new Float64Array(capacity); // step on which it was heard
    this.height = new Float64Array(capacity);
    this.velocity = new Float64Array(capacity);
  }
  clear() { this.count = 0; }
  // Copy as many of other's strikes as fit; the rest are counted as dropped.
  append(other) {
    for (let i = 0; i < other.count; i++) {
      this.push(other.stone[i], other.step[i], other.detected[i], other.height[i], other.velocity[i]);
    }
  }
  push(stone, step, detected, height, velocity) {
    if (this.count >= this.capacity) { this.dropped++; return false; }
    const i = this.count++;
    this.stone[i] = stone; this.step[i] = step; this.detected[i] = detected;
    this.height[i] = height; this.velocity[i] = velocity;
    return true;
  }
}
