// medium.js — the medium: a damped 2D wave simulation, read as audio.
//
// Pure JavaScript with no Web Audio dependency, so the same file runs in the
// AudioWorklet and in Node (check.mjs). All memory is allocated in the
// constructor; process() and everything it calls allocates nothing. This is
// deliberately shaped like the future C++ port in source/dsp.
//
// Physics: finite-difference wave equation on an N×N grid with fixed (zero)
// edges, two loss terms:
//   sigma  — frequency-independent loss: the whole surface settles.
//   kappa  — frequency-dependent loss (acts on the Laplacian): sharp ripples
//            die faster than broad motion.
// Update, per cell:
//   (1+sigma) u' = 2u - (1-sigma) u_prev + lambda² L(u) + kappa (L(u) - L(u_prev))
// Stable when lambda² + 2·kappa ≤ 1/2 (von Neumann, worst mode of the 5-point
// Laplacian); coefficients are clamped to that.
//
// Wave speed is in cells per second, so low and mid resonances keep their pitch
// at any sample rate. Near the stability limit the finest ripples still shift
// with sample rate (FDTD dispersion); the C++ port may want a fixed internal rate.
//
// Provisional prototype choices, not decisions (see CLAUDE.md open questions):
// a square 32×32 grid with fixed edges, and two fixed listening points.
//
// Port notes: the grid is Float64 here only to keep JS clear of float32
// subnormals; the C++ port uses float with ScopedNoDenormals in processBlock.

const MAX_EXCITATIONS = 16;
const MAX_RADIUS = 3; // cells
const KERNEL = 2 * Math.ceil(3 * MAX_RADIUS) + 2; // fractional centre spans 2h+2 cells
const MAX_STRENGTH = 16;
const MIN_EXCITATION_SECONDS = 0.002; // for strokes
const MAX_EXCITATION_SECONDS = 2;
const SUBBLOCK = 32; // samples of stream time between control-rate updates
const LN1000 = Math.log(1000); // amplitude ratio for a 60 dB decay
const STABILITY_LIMIT = 0.49; // lambda² + 2·kappa, with margin under 0.5
const SILENCE_ENERGY = 4e-17; // ≈ −150 dB re one default drop: snap to exact stillness
const RUNAWAY_ENERGY = 1e9; // ~10³× the hardest abusive playing measured; guard only
const SILENCE_CHECK_INTERVAL = 1024; // samples
const OUTPUT_CAL = 12; // loudest of 16 default drops peaks near 0.3
const DROP_RADIUS = 1.5; // cells
const STROKE_RADIUS = 2.0; // cells
const SMOOTHING_SECONDS = 0.02;

export const PARAMS = {
  decay: { min: 0.2, max: 12, def: 2.5 }, // s, T60 of broad motion
  hfDecay: { min: 0.02, max: 12, def: 0.4 }, // s, T60 of the finest ripples
  waveSpeed: { min: 1000, max: 30000, def: 8000 }, // cells per second
  inputGain: { min: 0, max: 4, def: 1 },
  outputGain: { min: 0, max: 4, def: 1 },
};

const PARAM_KEYS = Object.keys(PARAMS);
const P_DECAY = 0, P_HF_DECAY = 1, P_WAVE_SPEED = 2, P_INPUT_GAIN = 3, P_OUTPUT_GAIN = 4;

export class Medium {
  constructor({ size = 32, sampleRate = 48000, seed = 1 } = {}) {
    if (!(size >= 4 && size <= 64)) throw new RangeError('size must be 4..64'); // larger isn't real-time in JS
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    this.N = size | 0;
    this.W = this.N + 2; // one fixed boundary cell on each side
    this.fs = sampleRate;
    const cells = this.W * this.W;
    this.u = new Float64Array(cells);
    this.up = new Float64Array(cells);
    this.un = new Float64Array(cells);
    // Laplacian from the previous step, reused instead of recomputed.
    this.lapPrev = new Float64Array(cells);
    this.lapCur = new Float64Array(cells);

    // Listening points: asymmetric and off-centre so low modes are heard, and
    // placed so neither sits on a nodal line of a low mode of the 32×32 grid.
    this.listenL = this.cellIndex(0.29, 0.41);
    this.listenR = this.cellIndex(0.71, 0.6);

    // Excitations, structure-of-arrays so nothing is allocated per event.
    this.exActive = new Uint8Array(MAX_EXCITATIONS);
    this.exT = new Int32Array(MAX_EXCITATIONS);
    this.exLen = new Int32Array(MAX_EXCITATIONS);
    this.exAmp = new Float64Array(MAX_EXCITATIONS);
    this.exR = new Float64Array(MAX_EXCITATIONS);
    this.exX0 = new Float64Array(MAX_EXCITATIONS);
    this.exY0 = new Float64Array(MAX_EXCITATIONS);
    this.exX1 = new Float64Array(MAX_EXCITATIONS);
    this.exY1 = new Float64Array(MAX_EXCITATIONS);
    this.exIx = new Int32Array(MAX_EXCITATIONS); // first cell of footprint
    this.exIy = new Int32Array(MAX_EXCITATIONS);
    this.exNx = new Int32Array(MAX_EXCITATIONS); // footprint extent
    this.exNy = new Int32Array(MAX_EXCITATIONS);
    this.exWx = new Float64Array(MAX_EXCITATIONS * KERNEL);
    this.exWy = new Float64Array(MAX_EXCITATIONS * KERNEL);

    this.rng = seed >>> 0 || 1;

    this.target = new Float64Array(PARAM_KEYS.length);
    this.current = new Float64Array(PARAM_KEYS.length);
    for (let i = 0; i < PARAM_KEYS.length; i++) {
      this.target[i] = this.current[i] = PARAMS[PARAM_KEYS[i]].def;
    }
    this.smooth = 1 - Math.exp(-SUBBLOCK / (SMOOTHING_SECONDS * sampleRate));

    this.dcCoef = Math.exp((-2 * Math.PI * 10) / sampleRate);
    this.dcXL = this.dcYL = this.dcXR = this.dcYR = 0.0;
    this.subPos = 0; // position within the current sub-block, persists across calls
    this.silenceCounter = 0;
    this.asleep = true; // surface is exactly still; step() can be skipped
    this.resets = 0; // guard trips, for diagnostics

    this.updateCoefficients();
    this.outScale = this.outScaleTarget;
    this.outStep = 0.0;
  }

  // ---- control (called between process() calls) ----------------------------

  setParam(name, value) {
    const i = PARAM_KEYS.indexOf(name);
    if (i < 0 || !Number.isFinite(value)) return;
    const p = PARAMS[name];
    this.target[i] = Math.min(p.max, Math.max(p.min, value));
  }

  // Jump parameters straight to their targets (offline use, tests).
  snapParams() {
    for (let i = 0; i < PARAM_KEYS.length; i++) this.current[i] = this.target[i];
    this.updateCoefficients();
    this.outScale = this.outScaleTarget;
    this.outStep = 0.0;
  }

  // A single point impact. x, y in [0, 1]. Slight random variation each time,
  // so the same gesture never lands exactly the same way twice.
  drop(x, y, strength = 1) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(strength)) return;
    const jx = (this.rand() - 0.5) * 0.6;
    const jy = (this.rand() - 0.5) * 0.6;
    const gx = this.toGrid(x) + jx;
    const gy = this.toGrid(y) + jy;
    const r = DROP_RADIUS * (1 + (this.rand() - 0.5) * 0.5);
    const amp = clamp(strength, 0, MAX_STRENGTH) * (1 + (this.rand() - 0.5) * 0.3);
    // Impact lasts about as long as a wave takes to cross the drop's footprint,
    // so drops excite the surface similarly at any wave speed.
    const seconds = (r / this.current[P_WAVE_SPEED]) * (1 + 1.5 * this.rand());
    this.addExcitation(gx, gy, gx, gy, r, amp, seconds);
  }

  // Energy injected while moving from (x0,y0) to (x1,y1) over `seconds`.
  stroke(x0, y0, x1, y1, strength = 1, seconds = 0.02) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) ||
        !Number.isFinite(y1) || !Number.isFinite(strength) || !Number.isFinite(seconds)) return;
    const r = STROKE_RADIUS * (1 + (this.rand() - 0.5) * 0.3);
    const amp = clamp(strength, 0, MAX_STRENGTH) * (1 + (this.rand() - 0.5) * 0.2);
    this.addExcitation(
      this.toGrid(x0), this.toGrid(y0), this.toGrid(x1), this.toGrid(y1),
      r, amp, clamp(seconds, MIN_EXCITATION_SECONDS, MAX_EXCITATION_SECONDS));
  }

  // Wipes the surface instantly. Internal guard only — not a performance
  // control (calming the medium is the Still gesture, Phase 6).
  reset() {
    this.u.fill(0);
    this.up.fill(0);
    this.un.fill(0);
    this.lapPrev.fill(0);
    this.lapCur.fill(0);
    this.exActive.fill(0);
    this.dcXL = this.dcYL = this.dcXR = this.dcYR = 0.0;
    this.asleep = true;
  }

  // ---- audio ----------------------------------------------------------------

  // Render n samples into outL / outR (Float32Array, length ≥ n). Output is
  // identical however the host splits the stream into blocks.
  process(outL, outR, n) {
    let done = 0;
    while (done < n) {
      if (this.subPos === 0) this.beginSubblock();
      const count = Math.min(SUBBLOCK - this.subPos, n - done);
      if (this.asleep) {
        for (let s = 0; s < count; s++) outL[done + s] = outR[done + s] = 0;
      } else {
        for (let s = 0; s < count; s++) {
          this.injectExcitations();
          this.step();
          this.writeOutput(outL, outR, done + s);
        }
      }
      this.subPos += count;
      if (this.subPos >= SUBBLOCK) this.subPos = 0;
      this.silenceCounter += count;
      if (this.silenceCounter >= SILENCE_CHECK_INTERVAL) {
        this.silenceCounter = 0;
        this.checkSilenceAndRunaway();
      }
      done += count;
    }
  }

  beginSubblock() {
    this.smoothParams();
    // Ramp output gain linearly across the sub-block: no zipper steps.
    this.outStep = (this.outScaleTarget - this.outScale) / SUBBLOCK;
    for (let e = 0; e < MAX_EXCITATIONS; e++) {
      if (this.exActive[e]) this.updateExcitationShape(e);
    }
  }

  checkSilenceAndRunaway() {
    if (this.asleep) return;
    const e = this.energy();
    if (!(e < RUNAWAY_ENERGY)) { // also catches NaN
      this.resets++;
      this.reset();
    } else if (e < SILENCE_ENERGY && !this.anyExcitationActive()) {
      this.reset(); // exact stillness: nothing left to hear
    }
  }

  step() {
    const W = this.W, N = this.N;
    const u = this.u, up = this.up, un = this.un;
    const lp = this.lapPrev, lc = this.lapCur;
    const lk = this.lambda2 + this.kappa, k = this.kappa;
    const a = this.aPrev, inv = this.inv;
    for (let y = 1; y <= N; y++) {
      let i = y * W + 1;
      for (let x = 1; x <= N; x++, i++) {
        const c = u[i];
        const lap = u[i - 1] + u[i + 1] + u[i - W] + u[i + W] - 4 * c;
        lc[i] = lap;
        un[i] = (2 * c - a * up[i] + lk * lap - k * lp[i]) * inv;
      }
    }
    this.up = u;
    this.u = un;
    this.un = up;
    this.lapPrev = lc;
    this.lapCur = lp;
  }

  writeOutput(outL, outR, i) {
    // Surface velocity (per second) at each listening point.
    this.outScale += this.outStep;
    const scale = this.outScale;
    const vl = (this.u[this.listenL] - this.up[this.listenL]) * scale;
    const vr = (this.u[this.listenR] - this.up[this.listenR]) * scale;

    // Gentle DC blocker, then soft limiter.
    const yl = vl - this.dcXL + this.dcCoef * this.dcYL;
    const yr = vr - this.dcXR + this.dcCoef * this.dcYR;
    this.dcXL = vl; this.dcYL = yl;
    this.dcXR = vr; this.dcYR = yr;

    if (!Number.isFinite(yl) || !Number.isFinite(yr)) {
      // Guard, not a fix: should never trip. check.mjs asserts it doesn't.
      this.resets++;
      this.reset();
      outL[i] = 0;
      outR[i] = 0;
      return;
    }
    outL[i] = Math.tanh(yl);
    outR[i] = Math.tanh(yr);
  }

  // ---- visuals / diagnostics ------------------------------------------------

  // Copy the N×N interior heights into dest (Float32Array, length ≥ N*N).
  snapshot(dest) {
    const W = this.W, N = this.N, u = this.u;
    let o = 0;
    for (let y = 1; y <= N; y++) {
      const row = y * W;
      for (let x = 1; x <= N; x++) dest[o++] = u[row + x];
    }
  }

  // Load an N×N interior state (current and previous heights), e.g. a pure
  // mode for tests. Not for the audio path.
  loadState(uInterior, upInterior) {
    const W = this.W, N = this.N;
    this.reset();
    for (let y = 1; y <= N; y++) {
      for (let x = 1; x <= N; x++) {
        const i = y * W + x, o = (y - 1) * N + (x - 1);
        this.u[i] = uInterior[o];
        this.up[i] = upInterior[o];
      }
    }
    const up = this.up, lp = this.lapPrev;
    for (let y = 1; y <= N; y++) {
      for (let x = 1; x <= N; x++) {
        const i = y * W + x;
        lp[i] = up[i - 1] + up[i + 1] + up[i - W] + up[i + W] - 4 * up[i];
      }
    }
    this.asleep = false;
  }

  // Discrete energy of the lossy scheme, scaled by fs² so it means the same at
  // any sample rate. With parameters held fixed and no excitation it never
  // rises: each step it falls by (sigma/2)‖u'−u_p‖² + (kappa/4)‖∇(u'−u_p)‖².
  energy() {
    const W = this.W, u = this.u, up = this.up;
    let kinetic = 0, potential = 0, gradV = 0;
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const v = u[i] - up[i];
        kinetic += v * v;
        if (x + 1 < W) {
          potential += (u[i + 1] - u[i]) * (up[i + 1] - up[i]);
          const dv = (u[i + 1] - up[i + 1]) - v;
          gradV += dv * dv;
        }
        if (y + 1 < W) {
          potential += (u[i + W] - u[i]) * (up[i + W] - up[i]);
          const dv = (u[i + W] - up[i + W]) - v;
          gradV += dv * dv;
        }
      }
    }
    const h = 0.5 * kinetic + 0.5 * this.lambda2 * potential - 0.25 * this.kappa * gradV;
    return h * this.fs * this.fs;
  }

  // ---- internals ------------------------------------------------------------

  updateCoefficients() {
    const c = this.current;
    const fs = this.fs;
    const decay = c[P_DECAY];
    const sigma = LN1000 / (decay * fs);
    const hf = Math.min(c[P_HF_DECAY], decay);
    // Loss rate of the finest mode is fs·(sigma + 4·kappa); solve for kappa.
    let kappa = Math.max(0, (LN1000 / hf - LN1000 / decay) / (4 * fs));
    kappa = Math.min(kappa, STABILITY_LIMIT / 4);
    let lambda = c[P_WAVE_SPEED] / fs;
    const lambdaMax = Math.sqrt(STABILITY_LIMIT - 2 * kappa);
    if (lambda > lambdaMax) lambda = lambdaMax;
    this.lambda2 = lambda * lambda;
    this.kappa = kappa;
    this.aPrev = 1 - sigma;
    this.inv = 1 / (1 + sigma);
    this.outScaleTarget = OUTPUT_CAL * c[P_OUTPUT_GAIN] * fs;
  }

  smoothParams() {
    const t = this.target, c = this.current, a = this.smooth;
    let changed = false;
    for (let i = 0; i < t.length; i++) {
      const d = t[i] - c[i];
      if (d !== 0) {
        c[i] = Math.abs(d) < 1e-6 * (Math.abs(t[i]) + 1e-9) ? t[i] : c[i] + a * d;
        changed = true;
      }
    }
    if (changed) this.updateCoefficients();
  }

  addExcitation(x0, y0, x1, y1, r, amp, seconds) {
    // Reuse a free slot; if all are busy, take the one nearest its end.
    let slot = -1, best = -1;
    for (let i = 0; i < MAX_EXCITATIONS; i++) {
      if (!this.exActive[i]) { slot = i; break; }
      const progress = this.exT[i] / this.exLen[i];
      if (progress > best) { best = progress; slot = i; }
    }
    const len = clamp(Math.round(seconds * this.fs), 2, Math.round(MAX_EXCITATION_SECONDS * this.fs));
    this.exActive[slot] = 1;
    this.exT[slot] = 0;
    this.exLen[slot] = len;
    // Footprints sum to 1, so the whole excitation delivers the same velocity
    // kick (amp) regardless of its size, length or the sample rate. The raised
    // cosine sums to len/2.
    this.exAmp[slot] = (2 * amp) / (len * this.fs);
    this.exR[slot] = clamp(r, 0.5, MAX_RADIUS);
    this.exX0[slot] = x0; this.exY0[slot] = y0;
    this.exX1[slot] = x1; this.exY1[slot] = y1;
    this.updateExcitationShape(slot);
    this.asleep = false;
  }

  anyExcitationActive() {
    for (let i = 0; i < MAX_EXCITATIONS; i++) if (this.exActive[i]) return true;
    return false;
  }

  // Recompute an excitation's separable Gaussian footprint at the position it
  // will have mid-way through the next sub-block.
  updateExcitationShape(e) {
    const f = Math.min(1, (this.exT[e] + SUBBLOCK * 0.5) / this.exLen[e]);
    const cx = this.exX0[e] + (this.exX1[e] - this.exX0[e]) * f;
    const cy = this.exY0[e] + (this.exY1[e] - this.exY0[e]) * f;
    const r = this.exR[e];
    this.fillKernel(e, cx, r, this.exWx, true);
    this.fillKernel(e, cy, r, this.exWy, false);
  }

  fillKernel(e, centre, r, weights, isX) {
    const half = Math.ceil(3 * r);
    const first = Math.max(1, Math.floor(centre - half));
    const last = Math.min(this.N, Math.ceil(centre + half));
    const n = clamp(last - first + 1, 0, KERNEL);
    const base = e * KERNEL;
    const inv2r2 = 1 / (2 * r * r);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = first + i - centre;
      const w = Math.exp(-d * d * inv2r2);
      weights[base + i] = w;
      sum += w;
    }
    const norm = sum > 0 ? 1 / sum : 0;
    for (let i = 0; i < n; i++) weights[base + i] *= norm;
    if (isX) { this.exIx[e] = first; this.exNx[e] = n; }
    else { this.exIy[e] = first; this.exNy[e] = n; }
  }

  injectExcitations() {
    const W = this.W, u = this.u;
    const gain = this.current[P_INPUT_GAIN];
    for (let e = 0; e < MAX_EXCITATIONS; e++) {
      if (!this.exActive[e]) continue;
      const t = this.exT[e], len = this.exLen[e];
      // Raised-cosine envelope: energy fades in and out, no clicks.
      const env = 0.5 - 0.5 * Math.cos((2 * Math.PI * (t + 0.5)) / len);
      const a = this.exAmp[e] * gain * env;
      const base = e * KERNEL;
      const nx = this.exNx[e], ny = this.exNy[e];
      const ix = this.exIx[e], iy = this.exIy[e];
      for (let j = 0; j < ny; j++) {
        const wy = a * this.exWy[base + j];
        let i = (iy + j) * W + ix;
        for (let k = 0; k < nx; k++, i++) u[i] += wy * this.exWx[base + k];
      }
      if (++this.exT[e] >= len) this.exActive[e] = 0;
    }
  }

  cellIndex(x, y) {
    const gx = clamp(Math.round(this.toGrid(x)), 1, this.N);
    const gy = clamp(Math.round(this.toGrid(y)), 1, this.N);
    return gy * this.W + gx;
  }

  toGrid(v) {
    // [0,1] across the interior → grid coordinates 1..N
    return 1 + clamp(v, 0, 1) * (this.N - 1);
  }

  rand() {
    // xorshift32: deterministic per seed, allocation-free.
    let x = this.rng;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 4294967296;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
