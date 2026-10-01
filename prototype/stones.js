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

export const MAX_STONES = 128;
export const STONE_PARAMS = {
  // Crest height a stone needs to ring, in the units of Surface.drop strength.
  // At the default, one strength-1 drop rings ~25 stones over ~2 s (direct
  // waves and reflections); lower rings more, for longer.
  threshold: { min: 0.005, max: 0.3, def: 0.015 },
};
const REARM_FRACTION = 0.3; // must fall below threshold × this to ring again
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
    this.threshold = STONE_PARAMS.threshold.def;
  }

  setThreshold(value) {
    const p = STONE_PARAMS.threshold;
    if (Number.isFinite(value)) this.threshold = value < p.min ? p.min : value > p.max ? p.max : value;
  }

  // Place and tune the stones. xs, ys in [0, 1]; hzs the pitches. Retuning only
  // changes the stones — the water is never touched. A stone placed where the
  // water is already high waits for it to settle before it can ring.
  // A stone with a non-finite position or an unusable pitch is kept in its
  // slot (so the others keep their places) but disabled.
  setStones(surface, xs, ys, hzs, count) {
    if (!Number.isFinite(count)) return;
    const n = Math.max(0, Math.min(MAX_STONES, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const ok = Number.isFinite(xs[i]) && Number.isFinite(ys[i]) &&
        Number.isFinite(hzs[i]) && hzs[i] >= MIN_HZ && hzs[i] <= MAX_HZ;
      this.enabled[i] = ok ? 1 : 0;
      const x = ok ? xs[i] : 0.5, y = ok ? ys[i] : 0.5;
      const gx = surface.toGridX(x), gy = surface.toGridY(y);
      const moved = i >= this.count || gx !== this.gx[i] || gy !== this.gy[i];
      this.x[i] = x; this.y[i] = y;
      this.gx[i] = gx; this.gy[i] = gy;
      this.hz[i] = ok ? hzs[i] : 0;
      if (moved) {
        const h = surface.heightAt(gx, gy);
        this.prevH[i] = h;
        this.state[i] = h < this.threshold * REARM_FRACTION ? ARMED : SPENT;
      }
    }
    this.count = n;
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
        continue;
      }
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
