// surface.js — the water: a damped 2D wave surface running at human speed.
//
// The reviewed Phase 1a scheme (two loss terms, cached Laplacian, discrete
// energy that never rises once disturbances stop), with four changes:
//   - An isotropic 9-point Laplacian, (4·edges + corners − 20·centre) / 6, so
//     ripples travel and keep their height the same in every direction (the
//     5-point stencil made diagonal crests ~40% higher than axial ones, which
//     biased which stones rang). Stable when lambda² + 2·kappa ≤ 3/4.
//   - It steps on a fixed simulation clock (SIM_RATE steps per second), not
//     per audio sample, so the water behaves identically at any sample rate.
//     Wave speed is in cells per second and acts as tempo.
//   - Edges are free (mirrored), so a reflected crest stays a crest, as at a
//     real water wall.
//   - Drops are small craters (a raised centre with a dip around it) that add
//     no net water, so free edges never let the level drift. A crater is
//     placed in still water all at once; a shape released from rest spreads
//     the same way at any wave speed (only faster or slower), so tempo changes
//     when stones ring, never how many or how hard.
//
// All memory is allocated in the constructor; step() and everything on the
// audio path allocate nothing. Pure JS: runs in the AudioWorklet and in Node.

export const SIM_RATE = 1000; // steps per second of water time
export const SURFACE_W = 128, SURFACE_H = 97; // cells (not square, so reflections don't line up neatly)

const MAX_DROP_RADIUS = 4; // cells
const DROP_HALF = Math.ceil(3 * 2 * MAX_DROP_RADIUS); // dip ring is 2r wide
const DROP_SPAN = 2 * DROP_HALF + 2;
const LN1000 = Math.log(1000);
const STABILITY_LIMIT = 0.74; // lambda² + 2·kappa, with margin under 3/4 (largest eigenvalue of −L is 16/3)
const SIXTH = 1 / 6;
const SILENCE_ENERGY = 5e-9; // ≈ −127 dB re one strength-1 drop at the default tempo (~2.3e4); far below any stone threshold
const RUNAWAY_ENERGY = 1e12;
const SILENCE_CHECK_STEPS = 50;
// Crater centre height per unit of drop strength: a strength-1 drop's crest
// is ~0.13 a dozen cells away (what the stone threshold is calibrated to).
const CRATER_GAIN = 1.66;
// Tempo is time-lapse: decay times are given at this wave speed and scale
// with it, so the same gesture plays the same phrase at any tempo, faster or
// slower. (Damping per second at a fixed decay would otherwise thin out slow
// tempos and crowd fast ones.)
export const REFERENCE_SPEED = 64; // cells per second
// Still: a hand resting on the water damps its motion under the hand (a soft
// round patch), so ripples die there and passing ones are absorbed. Damping
// per step at full pressure in the hand's centre, at the reference speed; it
// scales with flow like everything else (a time-lapse).
export const MAX_HANDS = 10;
export const HAND_RADIUS = 7; // cells (the patch's Gaussian radius)
const HAND_DAMP = 0.06;
// …plus a weak pull toward rest (∝ damping², so its spring keeps pace with
// flow and stays overdamped): bumps under the hand flatten instead of
// freezing, without the stiffness that would make the hand reflect ripples.
export const HAND_PULL = 0.25;
const HAND_REACH = 2.5; // the patch is cut off at this many radii
const HAND_EASE = 0.02; // per step: a hand settles on (or lifts off) over ~50 ms

export const SURFACE_PARAMS = {
  // Defaults from Dash's Phase 1b listening session: slow (≈3.3 s to cross 128
  // cells) and long-lived (≈27 s at this tempo).
  waveSpeed: { min: 4, max: 450, def: 39 }, // cells per second (4 ≈ 32 s to cross: very slow drift)
  decay: { min: 1, max: 30, def: 16.4 }, // s at the reference tempo: T60 of broad swells
  hfDecay: { min: 0.1, max: 30, def: 1.5 }, // s at the reference tempo: T60 of the finest ripples
};

export class Surface {
  constructor({ width = SURFACE_W, height = SURFACE_H } = {}) {
    if (!(width >= 8 && width <= 256 && height >= 8 && height <= 256)) {
      throw new RangeError('surface must be 8..256 cells on each side');
    }
    this.w = width | 0;
    this.h = height | 0;
    this.W = this.w + 2; // one mirrored ghost cell on each side
    const cells = this.W * (this.h + 2);
    this.u = new Float64Array(cells);
    this.up = new Float64Array(cells);
    this.un = new Float64Array(cells);
    this.lapPrev = new Float64Array(cells);
    this.lapCur = new Float64Array(cells);

    // Scratch for one crater: separable 1D Gaussian tables per axis.
    this.g1x = new Float64Array(DROP_SPAN);
    this.g2x = new Float64Array(DROP_SPAN);
    this.g1y = new Float64Array(DROP_SPAN);
    this.g2y = new Float64Array(DROP_SPAN);

    this.waveSpeed = SURFACE_PARAMS.waveSpeed.def;
    this.decay = SURFACE_PARAMS.decay.def;
    this.hfDecay = SURFACE_PARAMS.hfDecay.def;
    this.updateCoefficients();

    // Hands (Still): position in interior cells, pressure wanted and as eased.
    this.handX = new Float64Array(MAX_HANDS);
    this.handY = new Float64Array(MAX_HANDS);
    this.handWant = new Float64Array(MAX_HANDS);
    this.handOn = new Float64Array(MAX_HANDS);
    this.handsActive = 0;
    // One row of a hand's patch weights (separable Gaussian), reused.
    this.handRow = new Float64Array(2 * Math.ceil(HAND_REACH * HAND_RADIUS) + 2);
    this.handCol = new Float64Array(2 * Math.ceil(HAND_REACH * HAND_RADIUS) + 2);

    this.asleep = true;
    this.silenceCounter = 0;
    this.resets = 0;
  }

  // Still: hand `id` (0..MAX_HANDS−1) rests at (x, y) in [0, 1]² with
  // `pressure` 0..1 (0 lifts it). It eases on and off; it never adds water.
  setHand(id, x, y, pressure) {
    if (!Number.isInteger(id) || id < 0 || id >= MAX_HANDS) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(pressure)) return;
    this.handX[id] = 1 + clamp(x, 0, 1) * (this.w - 1);
    this.handY[id] = 1 + clamp(y, 0, 1) * (this.h - 1);
    this.handWant[id] = clamp(pressure, 0, 1);
    this.handsActive = 1; // (recounted on the next step)
  }

  // How firmly hand `id` is resting now (0..1), for drawing and checks.
  handPressure(id) { return id >= 0 && id < MAX_HANDS ? this.handOn[id] : 0; }

  // ---- control ----------------------------------------------------------------

  setParam(name, value) {
    const p = SURFACE_PARAMS[name];
    if (!p || !Number.isFinite(value)) return;
    this[name] = value < p.min ? p.min : value > p.max ? p.max : value;
    this.updateCoefficients();
  }

  // A drop at (x, y) in [0, 1] (fractions of width and height): a crater
  // whose centre is `strength` high, placed in the water at once (call
  // between steps). Returns false if ignored.
  drop(x, y, strength, radius) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(strength) || !Number.isFinite(radius)) return false;
    if (strength <= 0) return false;
    const r = clamp(radius, 0.75, MAX_DROP_RADIUS);
    const amp = Math.min(strength, 16) * CRATER_GAIN;
    const cx = 1 + clamp(x, 0, 1) * (this.w - 1); // interior cells are 1..w
    const cy = 1 + clamp(y, 0, 1) * (this.h - 1);
    this.addCrater(cx, cy, r, amp);
    this.asleep = false;
    return true;
  }

  reset() {
    // Hands stay where they rest (a reset only stills the water).
    this.u.fill(0); this.up.fill(0); this.un.fill(0);
    this.lapPrev.fill(0); this.lapCur.fill(0);
    this.asleep = true;
  }

  // ---- simulation (audio thread) ----------------------------------------------

  step() {
    if (this.asleep) { // still water: a hand just rests (nothing to damp)
      if (this.handsActive) { for (let k = 0; k < MAX_HANDS; k++) this.handOn[k] = this.handWant[k]; this.handsActive = 0; }
      return;
    }
    this.mirrorEdges(this.u);
    const W = this.W, w = this.w, h = this.h;
    const u = this.u, up = this.up, un = this.un;
    const lp = this.lapPrev, lc = this.lapCur;
    const lk = this.lambda2 + this.kappa, k = this.kappa;
    const a = this.aPrev, inv = this.inv;
    for (let y = 1; y <= h; y++) {
      let i = y * W + 1;
      for (let x = 1; x <= w; x++, i++) {
        const c = u[i];
        const lap = (4 * (u[i - 1] + u[i + 1] + u[i - W] + u[i + W]) +
          u[i - W - 1] + u[i - W + 1] + u[i + W - 1] + u[i + W + 1] - 20 * c) * SIXTH;
        lc[i] = lap;
        un[i] = (2 * c - a * up[i] + lk * lap - k * lp[i]) * inv;
      }
    }
    this.stillHands(u, un);
    this.up = u; this.u = un; this.un = up;
    this.lapPrev = lc; this.lapCur = lp;

    if (++this.silenceCounter >= SILENCE_CHECK_STEPS) {
      this.silenceCounter = 0;
      const e = this.energy();
      if (!(e < RUNAWAY_ENERGY)) { this.resets++; this.reset(); }
      else if (e < SILENCE_ENERGY) this.reset();
    }
  }

  // Water height at (gx, gy) in interior cell coordinates (1..w, 1..h),
  // bilinearly interpolated.
  heightAt(gx, gy) {
    // Clamped to the interior; at the far edge the ghost cell gets weight 0.
    gx = gx < 1 ? 1 : gx > this.w ? this.w : gx;
    gy = gy < 1 ? 1 : gy > this.h ? this.h : gy;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const W = this.W, u = this.u;
    const i = y0 * W + x0;
    const top = u[i] + (u[i + 1] - u[i]) * fx;
    const bot = u[i + W] + (u[i + W + 1] - u[i + W]) * fx;
    return top + (bot - top) * fy;
  }

  // Interior coordinates for a position in [0, 1]².
  toGridX(x) { return 1 + clamp(x, 0, 1) * (this.w - 1); }
  toGridY(y) { return 1 + clamp(y, 0, 1) * (this.h - 1); }

  // Copy the w×h interior heights into dest, starting at `offset`.
  snapshot(dest, offset = 0) {
    const W = this.W, u = this.u;
    let o = offset;
    for (let y = 1; y <= this.h; y++) {
      const row = y * W;
      for (let x = 1; x <= this.w; x++) dest[o++] = u[row + x];
    }
  }

  // Discrete energy of the scheme, in per-second units, as quadratic forms of
  // the same free-edge operator L the step uses (v = u − u_prev):
  //   H = ½‖v‖² − ½λ²⟨u, L u_prev⟩ + ¼κ⟨v, L v⟩
  // With parameters fixed and no drops it never rises.
  energy() {
    const W = this.W, w = this.w, h = this.h, u = this.u, up = this.up;
    this.mirrorEdges(u);
    this.mirrorEdges(up);
    let kinetic = 0, potential = 0, gradV = 0;
    for (let y = 1; y <= h; y++) {
      let i = y * W + 1;
      for (let x = 1; x <= w; x++, i++) {
        const lu = (4 * (u[i - 1] + u[i + 1] + u[i - W] + u[i + W]) +
          u[i - W - 1] + u[i - W + 1] + u[i + W - 1] + u[i + W + 1] - 20 * u[i]) * SIXTH;
        const lp = (4 * (up[i - 1] + up[i + 1] + up[i - W] + up[i + W]) +
          up[i - W - 1] + up[i - W + 1] + up[i + W - 1] + up[i + W + 1] - 20 * up[i]) * SIXTH;
        const v = u[i] - up[i];
        kinetic += v * v;
        potential += u[i] * lp;
        gradV += v * (lu - lp);
      }
    }
    const e = 0.5 * kinetic - 0.5 * this.lambda2 * potential + 0.25 * this.kappa * gradV;
    return e * SIM_RATE * SIM_RATE;
  }

  // Net water added (sum of heights). Craters add none; checks assert it stays ~0.
  netVolume() {
    const W = this.W;
    let s = 0;
    for (let y = 1; y <= this.h; y++) for (let x = 1; x <= this.w; x++) s += this.u[y * W + x];
    return s;
  }

  // ---- internals ----------------------------------------------------------------

  // Still: under each hand the water's motion is damped (the new heights
  // drawn back toward the current ones), so ripples reaching it are absorbed,
  // not reflected; a weak pull toward rest flattens any bump left there. Only
  // the freshly computed heights change, so the cached Laplacian stays right.
  stillHands(u, un) {
    let active = 0, taken = 0;
    const damp = HAND_DAMP * (this.waveSpeed / REFERENCE_SPEED);
    for (let k = 0; k < MAX_HANDS; k++) {
      const want = this.handWant[k];
      let on = this.handOn[k];
      if (on === want) { if (on === 0) continue; }
      else {
        on += (want - on) * HAND_EASE;
        if (Math.abs(want - on) < 1e-4) on = want;
        this.handOn[k] = on;
        if (on === 0) continue;
      }
      active++;
      const r = HAND_RADIUS, reach = Math.ceil(HAND_REACH * r), cx = this.handX[k], cy = this.handY[k];
      const x0 = Math.max(1, Math.floor(cx - reach)), x1 = Math.min(this.w, Math.ceil(cx + reach));
      const y0 = Math.max(1, Math.floor(cy - reach)), y1 = Math.min(this.h, Math.ceil(cy + reach));
      const row = this.handRow, col = this.handCol, inv = 1 / (2 * r * r), g = Math.min(0.9, damp * on);
      for (let x = x0; x <= x1; x++) { const d = x - cx; row[x - x0] = Math.exp(-d * d * inv); }
      for (let y = y0; y <= y1; y++) { const d = y - cy; col[y - y0] = g * Math.exp(-d * d * inv); }
      const W = this.W;
      for (let y = y0; y <= y1; y++) {
        const cy2 = col[y - y0];
        let i = y * W + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const m = cy2 * row[x - x0];
          const was = un[i], v = was - (was - u[i]) * m; // motion damped
          un[i] = v - v * HAND_PULL * m * m; // and drawn gently to rest
          taken += was - un[i];
        }
      }
    }
    this.handsActive = active;
    // What the hands took is given back evenly over the whole pond, so the
    // pond holds exactly the water it would have without them: the rest
    // level never drifts. (An even shift has no slope, so it makes no waves;
    // the cached Laplacian, of the current heights, is untouched.)
    if (active && taken !== 0) {
      const c = taken / (this.w * this.h), W = this.W;
      for (let y = 1; y <= this.h; y++) {
        let i = y * W + 1;
        for (let x = 1; x <= this.w; x++, i++) un[i] += c;
      }
    }
  }

  // Decay times in seconds at the current tempo.
  effectiveDecay() { return this.decay * (REFERENCE_SPEED / this.waveSpeed); }

  updateCoefficients() {
    const tempo = REFERENCE_SPEED / this.waveSpeed;
    const decay = this.decay * tempo, hf = Math.min(this.hfDecay, this.decay) * tempo;
    const sigma = LN1000 / (decay * SIM_RATE);
    // The finest mode (eigenvalue 16/3) loses sigma + (8/3)·kappa per step.
    let kappa = Math.max(0, (LN1000 / hf - LN1000 / decay) / ((8 / 3) * SIM_RATE));
    kappa = Math.min(kappa, STABILITY_LIMIT / 4);
    let lambda = this.waveSpeed / SIM_RATE;
    const lambdaMax = Math.sqrt(STABILITY_LIMIT - 2 * kappa);
    if (lambda > lambdaMax) lambda = lambdaMax;
    this.lambda2 = lambda * lambda;
    this.kappa = kappa;
    this.aPrev = 1 - sigma;
    this.inv = 1 / (1 + sigma);
  }

  // Free edges: each ghost cell (corners included) copies the nearest interior
  // cell — an even reflection — so the surface has no slope across the wall
  // and crests reflect upright.
  mirrorEdges(u) {
    const W = this.W, w = this.w, h = this.h;
    for (let x = 1; x <= w; x++) {
      u[x] = u[W + x];
      u[(h + 1) * W + x] = u[h * W + x];
    }
    for (let y = 1; y <= h; y++) {
      u[y * W] = u[y * W + 1];
      u[y * W + w + 1] = u[y * W + w];
    }
    u[0] = u[W + 1];
    u[w + 1] = u[W + w];
    u[(h + 1) * W] = u[h * W + 1];
    u[(h + 1) * W + w + 1] = u[h * W + w];
  }

  // Crater: a Gaussian bump of radius r minus a Gaussian of radius 2r, each
  // normalised over the cells that fall inside the surface, so it sums to
  // exactly zero (no net water) even at a wall; scaled so the centre is ~amp.
  // Both Gaussians are separable and the clipped window is a rectangle, so
  // only 1D tables are computed (4·(nx+ny) exps, not 4·nx·ny).
  // It is added to both the current and previous heights (water at rest),
  // and the cached Laplacian of the previous heights is updated to match.
  addCrater(cx, cy, r, amp) {
    const half = Math.ceil(6 * r);
    const x0 = Math.max(1, Math.floor(cx - half)), x1 = Math.min(this.w, Math.ceil(cx + half));
    const y0 = Math.max(1, Math.floor(cy - half)), y1 = Math.min(this.h, Math.ceil(cy + half));
    const nx = Math.min(DROP_SPAN, x1 - x0 + 1), ny = Math.min(DROP_SPAN, y1 - y0 + 1);
    const g1x = this.g1x, g2x = this.g2x, g1y = this.g1y, g2y = this.g2y;
    const i1 = 1 / (2 * r * r), i2 = 1 / (8 * r * r);
    let s1x = 0, s2x = 0, s1y = 0, s2y = 0;
    for (let k = 0; k < nx; k++) {
      const d = x0 + k - cx;
      s1x += (g1x[k] = Math.exp(-d * d * i1));
      s2x += (g2x[k] = Math.exp(-d * d * i2));
    }
    for (let j = 0; j < ny; j++) {
      const d = y0 + j - cy;
      s1y += (g1y[j] = Math.exp(-d * d * i1));
      s2y += (g2y[j] = Math.exp(-d * d * i2));
    }
    const sum1 = s1x * s1y, sum2 = s2x * s2y;
    const peak = 1 / sum1 - 1 / sum2;
    if (!(peak > 0)) return;
    const c1 = amp / (peak * sum1), c2 = amp / (peak * sum2);
    const W = this.W, u = this.u, up = this.up;
    for (let j = 0; j < ny; j++) {
      let i = (y0 + j) * W + x0;
      const ay = c1 * g1y[j], by = c2 * g2y[j];
      for (let k = 0; k < nx; k++, i++) {
        const v = ay * g1x[k] - by * g2x[k];
        u[i] += v;
        up[i] += v;
      }
    }
    // Refresh the cached Laplacian of up over the window and its 1-cell rim
    // (free edges: a neighbour beyond a wall is the nearest interior cell).
    const lx0 = Math.max(1, x0 - 1), lx1 = Math.min(this.w, x0 + nx);
    const ly0 = Math.max(1, y0 - 1), ly1 = Math.min(this.h, y0 + ny);
    const lp = this.lapPrev, w = this.w, h = this.h;
    for (let y = ly0; y <= ly1; y++) {
      const ym = (y > 1 ? y - 1 : 1) * W, yc = y * W, yp = (y < h ? y + 1 : h) * W;
      for (let x = lx0; x <= lx1; x++) {
        const xm = x > 1 ? x - 1 : 1, xp = x < w ? x + 1 : w;
        lp[yc + x] = (4 * (up[yc + xm] + up[yc + xp] + up[ym + x] + up[yp + x]) +
          up[ym + xm] + up[ym + xp] + up[yp + xm] + up[yp + xp] - 20 * up[yc + x]) * SIXTH;
      }
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
