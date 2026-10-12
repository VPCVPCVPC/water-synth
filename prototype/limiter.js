// limiter.js — the last thing the sound passes through: a look-ahead peak
// limiter that keeps the whole mix (the water and every tape) under the
// ceiling by turning it down, smoothly, instead of clipping it. Layered tapes
// add up — four takes and the live water can reach several times full
// scale — and a clipper flattens that into distortion; this rides the level
// down a little before the loud part arrives and lets it back up over
// RELEASE_SECONDS, so the mix gets quieter, not dirtier.
//
// How: each sample's required gain (ceiling ÷ its peak, at most 1), held low
// by an instant-down / slow-up release, then the lowest over the look-ahead
// window, then averaged over that same window. The average of values that
// are each at most the peak's requirement is at most it too, so a sample
// leaves exactly at or under the ceiling — while the gain moves as a smooth
// ramp, never a step. The sound is delayed by the window, less a sample (2.5 ms).
//
// Per sample and block-split independent; everything is allocated in the
// constructor. NaN and infinite input leave as silence.

const LOOKAHEAD_SECONDS = 0.0025;
const RELEASE_SECONDS = 0.25; // back up to full level over about this (time constant ÷ 3)
export const LIMITER_CEILING = 0.89; // −1 dBFS: a little room for the converter
const MAX_IN = 1e4; // nothing real comes near this (+80 dB)

export class Limiter {
  constructor({ sampleRate = 48000 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    const D = Math.max(1, Math.round(LOOKAHEAD_SECONDS * sampleRate));
    this.D = D;
    this.delayL = new Float32Array(D); this.delayR = new Float32Array(D); // the sound, D samples late
    // Running minimum over the last D release-held gains: a monotonic queue
    // in a ring (values rise from head to tail; indices are sample counts).
    this.qVal = new Float64Array(D); this.qAt = new Float64Array(D);
    this.qHead = 0; this.qLen = 0;
    // Running mean of the last D minima.
    this.mins = new Float64Array(D).fill(1);
    this.sum = D;
    this.at = 0; // samples seen
    this.slot = 0; // this.at mod D
    this.held = 1; // the release-held gain
    this.rise = 1 - Math.exp(-1 / ((RELEASE_SECONDS / 3) * sampleRate));
    this.gain = 1; // the gain last applied (for the page's meter, and checks)
    this.minGain = 1; // lowest gain since last read (diagnostics)
  }

  // In place over [0, n).
  process(L, R, n) {
    const D = this.D, ceiling = LIMITER_CEILING;
    const qVal = this.qVal, qAt = this.qAt, mins = this.mins, dL = this.delayL, dR = this.delayR;
    let held = this.held, sum = this.sum, at = this.at, slot = this.slot, head = this.qHead, len = this.qLen;
    let low = this.minGain, g = this.gain;
    for (let i = 0; i < n; i++) {
      let l = L[i], r = R[i];
      if (!(l === l && l - l === 0)) l = 0; // NaN or ±∞ → silence
      if (!(r === r && r - r === 0)) r = 0;
      // Absurd levels are clipped first, so the ceiling holds in floating
      // point for any input (the running mean loses precision past ~1e6).
      if (l > MAX_IN) l = MAX_IN; else if (l < -MAX_IN) l = -MAX_IN;
      if (r > MAX_IN) r = MAX_IN; else if (r < -MAX_IN) r = -MAX_IN;
      const a = l < 0 ? -l : l, b = r < 0 ? -r : r, p = a > b ? a : b;
      const need = p > ceiling ? ceiling / p : 1;
      held += this.rise * (1 - held);
      if (held > 1 - 1e-12) held = 1; // exact, never subnormal
      if (need < held) held = need;
      // The window's minimum: drop the head once it's older than the
      // window, drop larger values from the tail, push this one.
      if (len > 0 && qAt[head] <= at - D) { head = head + 1 === D ? 0 : head + 1; len--; }
      while (len > 0 && qVal[(head + len - 1) % D] >= held) len--;
      qVal[(head + len) % D] = held; qAt[(head + len) % D] = at; len++;
      const m = qVal[head];
      // The mean of the last D minima.
      sum += m - mins[slot];
      mins[slot] = m;
      g = sum / D;
      if (g > 1) g = 1;
      if (g < low) low = g;
      // In goes this sample; out goes the one from D − 1 ago (so the mean
      // that scales it covers the D minima from its own sample onward, each
      // of which has seen it).
      dL[slot] = l; dR[slot] = r;
      const o = slot + 1 === D ? 0 : slot + 1, ol = dL[o], or = dR[o];
      L[i] = ol * g; R[i] = or * g;
      at++;
      if (++slot === D) {
        slot = 0;
        // Re-add the mean from scratch once per window (no rounding drift).
        let s = 0;
        for (let k = 0; k < D; k++) s += mins[k];
        sum = s;
      }
    }
    this.held = held; this.sum = sum; this.at = at; this.slot = slot; this.qHead = head; this.qLen = len;
    this.gain = g; this.minGain = low;
  }

  // The lowest gain since the last call (1: untouched), for a meter.
  takeMinGain() { const g = this.minGain; this.minGain = this.gain; return g; }
}
