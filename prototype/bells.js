// bells.js — one water-struck bell per stone.
//
// Each stone is a single ringing object: a handful of exponentially decaying
// partials (modal synthesis, one rotating phasor per partial). The lowest
// partial is the stone's pitch exactly; the others sit at bar-like ratios and
// die faster. When the water strikes a stone that is still ringing, the new
// energy adds to what it is already doing — it rings on brighter, or partly
// cancels, depending on phase — rather than starting a second copy. So
// nothing is ever stolen or cut off.
//
// A strike also makes a short noise "tick": the water touching the stone.
// Harder strikes are louder and brighter. Each stone is panned by its position.
// A retune doesn't touch a ringing stone: it rings on at its old pitch until
// it is next struck; then its old ring crossfades out over 100 ms (a stone has
// one pitch) while the new pitch starts.
//
// All memory is allocated up front; strike(), renderRange() and endBlock()
// allocate nothing. Partials at or above 0.45 × sample rate are dropped.

import { MAX_STONES } from './stones.js';

export const BELL_PARAMS = {
  bellDecay: { min: 0.2, max: 8, def: 2.5 }, // s, T60 of the fundamental at ~220 Hz
  volume: { min: 0, max: 2, def: 0.7 },
};

// Bar-like partials: the octave and twelfth keep the bell tuneful; one
// slightly inharmonic partial gives it a little bell colour.
const PARTIAL_RATIOS = [1, 2.0, 3.0, 4.07, 5.4];
const PARTIAL_LEVELS = [1, 0.15, 0.22, 0.1, 0.06]; // at full brightness
const PARTIALS = PARTIAL_RATIOS.length;
const LN1000 = Math.log(1000);
const MIN_VELOCITY = 0.02; // quieter strikes are skipped
const VELOCITY_RANGE_DB = 30; // velocity 0 → −30 dB, 1 → 0 dB
const VOICE_FLOOR = 1e-4; // a stone this quiet has stopped ringing
const RELEASE_CHECK = 64; // checked every 64 samples of the ring's own life
const TICK_SECONDS = 0.004;
const TICK_ATTACK_SECONDS = 0.0003;
const TICK_CUTOFF_HZ = 3500; // low-passed noise reads as water, not a click
const TICK_LEVEL = 0.12;
const FADE_SLOTS = 16; // rings of retuned stones, fading out
const FADE_SECONDS = 0.1;
const PAN_MIN = 0.2, PAN_MAX = 0.8; // moderate stereo spread
const OUTPUT_GAIN = 0.25; // headroom for many stones at once (at ≤ 16 stones)
const GAIN_REFERENCE_STONES = 16; // more stones than this → gain scales by √(16 / count)
const MIN_HZ = 8;

export class Bells {
  constructor({ sampleRate = 48000 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    this.fs = sampleRate;
    // Slots 0..MAX_STONES−1 are the stones; the rest hold fading rings.
    const slots = MAX_STONES + FADE_SLOTS;
    this.slots = slots;
    const n = slots * PARTIALS;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.cr = new Float64Array(n);
    this.ci = new Float64Array(n);
    this.active = new Uint8Array(slots);
    this.hz = new Float64Array(slots);
    this.start = new Int32Array(slots); // first sample to render in the current block
    this.age = new Int32Array(slots);
    this.gainL = new Float64Array(slots);
    this.gainR = new Float64Array(slots);
    this.fadeLeft = new Int32Array(slots); // fade slots: samples until silent
    this.tickLeft = new Int32Array(MAX_STONES);
    this.tickAge = new Int32Array(MAX_STONES);
    this.tickLevel = new Float64Array(MAX_STONES);
    this.tickState = new Float64Array(MAX_STONES);
    this.tickRng = new Uint32Array(MAX_STONES);
    this.tickAlpha = 1 - Math.exp((-2 * Math.PI * TICK_CUTOFF_HZ) / sampleRate);
    // White noise spreads over 0..fs/2; keep the level below the cutoff the
    // same at any sample rate.
    this.tickNorm = Math.sqrt(sampleRate / 48000);
    this.tickTotal = Math.max(1, Math.round(TICK_SECONDS * sampleRate));
    this.tickAttack = Math.max(1, Math.round(TICK_ATTACK_SECONDS * sampleRate));
    this.fadeTotal = Math.max(1, Math.round(FADE_SECONDS * sampleRate));
    this.bellDecay = BELL_PARAMS.bellDecay.def;
    this.volume = BELL_PARAMS.volume.def;
    this.rng = new Uint32Array(1);
    this.rng[0] = 0x9e3779b9;
    this.stoneGain = 1;
    this.skipped = 0; // diagnostics
    this.restruck = 0;
  }

  setParam(name, value) {
    const p = BELL_PARAMS[name];
    if (!p || !Number.isFinite(value)) return;
    this[name] = value < p.min ? p.min : value > p.max ? p.max : value;
    if (name === 'bellDecay') this.updateRingingDecays();
  }

  // More stones can ring at once, so keep the overall level steady.
  setStoneCount(count) {
    const n = Number.isFinite(count) && count > GAIN_REFERENCE_STONES ? count : GAIN_REFERENCE_STONES;
    this.stoneGain = Math.sqrt(GAIN_REFERENCE_STONES / n);
  }

  // Strike `stone` (pitch `hz`, `velocity` in [0, 1], `pan` in [0, 1]) at
  // sample `offset` of the block being rendered. Call after rendering the
  // block up to `offset` (see renderRange).
  strike(stone, hz, velocity, pan, offset) {
    if (!Number.isInteger(stone) || stone < 0 || stone >= MAX_STONES ||
        !(velocity >= MIN_VELOCITY) || !Number.isFinite(hz) || !Number.isFinite(pan)) {
      this.skipped++;
      return false;
    }
    const fs = this.fs, nyquistGuard = 0.45 * fs;
    if (hz < MIN_HZ || hz >= nyquistGuard) { this.skipped++; return false; }
    const v = velocity > 1 ? 1 : velocity;
    const gain = Math.pow(10, (-VELOCITY_RANGE_DB / 20) * (1 - v));
    const bright = 0.3 + 0.7 * v;
    const s = stone;

    if (this.active[s] && this.hz[s] !== hz) this.fadeOut(s, offset); // retuned while ringing
    const ringing = this.active[s] === 1;
    if (!ringing) {
      // A fresh ring: set up rotation and decay for this pitch.
      for (let p = 0; p < PARTIALS; p++) this.re[s * PARTIALS + p] = this.im[s * PARTIALS + p] = 0;
      this.hz[s] = hz;
      this.setCoefficients(s);
      const pp = PAN_MIN + (PAN_MAX - PAN_MIN) * (pan < 0 ? 0 : pan > 1 ? 1 : pan);
      this.gainL[s] = Math.cos(pp * Math.PI * 0.5);
      this.gainR[s] = Math.sin(pp * Math.PI * 0.5);
      this.start[s] = offset > 0 ? offset | 0 : 0;
      this.active[s] = 1;
    } else {
      this.restruck++;
    }
    // Add the strike's energy: each partial gets a new sine-phase-0 component
    // on top of whatever it is already doing (no click; linear superposition).
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p;
      if (this.cr[k] === 0 && this.ci[k] === 0) continue;
      this.re[k] += gain * (p === 0 ? 1 : PARTIAL_LEVELS[p] * (p >= 3 ? bright * bright : bright));
    }
    this.age[s] = 0;
    this.tickLeft[s] = this.tickTotal;
    this.tickAge[s] = 0;
    this.tickLevel[s] = TICK_LEVEL * gain * bright * this.tickNorm;
    this.tickState[s] = 0;
    this.tickRng[s] = this.nextSeed();
    return true;
  }

  // Add n samples into outL / outR (which the caller zeroes), then apply
  // volume and the soft limiter.
  render(outL, outR, n) {
    this.renderRange(outL, outR, 0, n);
    this.endBlock(outL, outR, n);
  }

  // Add samples [from, to) of every ringing stone and fading ring. Rendering
  // up to each strike's sample before striking makes every strike see the
  // stones exactly as they are at that sample, so the output never depends on
  // how the stream is split into blocks.
  renderRange(outL, outR, from, to) {
    const re = this.re, im = this.im, cr = this.cr, ci = this.ci;
    for (let s = 0; s < this.slots; s++) {
      if (!this.active[s]) continue;
      const isStone = s < MAX_STONES;
      const gl = this.gainL[s], gr = this.gainR[s], base = s * PARTIALS;
      let age = this.age[s], finished = false;
      let tickLeft = isStone ? this.tickLeft[s] : 0;
      let tickState = isStone ? this.tickState[s] : 0, tickAge = isStone ? this.tickAge[s] : 0;
      let fadeLeft = this.fadeLeft[s];
      for (let i = from > this.start[s] ? from : this.start[s]; i < to; i++) {
        if (age > 0 && age % RELEASE_CHECK === 0 && tickLeft === 0 && !(this.level(s) >= VOICE_FLOOR)) {
          finished = true; // NaN counts as finished too
          break;
        }
        age++;
        let out = 0;
        for (let p = 0; p < PARTIALS; p++) {
          const k = base + p, r = re[k], m = im[k];
          re[k] = r * cr[k] - m * ci[k];
          im[k] = r * ci[k] + m * cr[k];
          out += im[k];
        }
        if (tickLeft > 0) {
          // Fast fade-in (no digital click), then a quadratic fall.
          const fall = tickLeft / this.tickTotal, rise = tickAge < this.tickAttack ? tickAge / this.tickAttack : 1;
          tickState += this.tickAlpha * (this.noise(s) - tickState);
          out += tickState * this.tickLevel[s] * rise * fall * fall;
          tickLeft--;
          tickAge++;
        }
        if (!isStone) {
          out *= fadeLeft / this.fadeTotal;
          if (--fadeLeft <= 0) { finished = true; break; }
        }
        outL[i] += out * gl;
        outR[i] += out * gr;
      }
      this.age[s] = age;
      this.fadeLeft[s] = fadeLeft;
      if (isStone) {
        this.tickLeft[s] = tickLeft;
        this.tickState[s] = tickState;
        this.tickAge[s] = tickAge;
      }
      if (finished) this.active[s] = 0;
    }
  }

  // Finish a block: volume and soft limiter over [0, n).
  endBlock(outL, outR, n) {
    for (let s = 0; s < this.slots; s++) this.start[s] = 0;
    const g = this.volume * OUTPUT_GAIN * this.stoneGain;
    for (let i = 0; i < n; i++) {
      const l = outL[i] * g, r = outR[i] * g;
      outL[i] = Number.isFinite(l) ? Math.tanh(l) : 0;
      outR[i] = Number.isFinite(r) ? Math.tanh(r) : 0;
    }
  }

  // Ringing stones (not counting fading rings).
  activeVoices() {
    let c = 0;
    for (let s = 0; s < MAX_STONES; s++) c += this.active[s];
    return c;
  }

  // ---- internals ----------------------------------------------------------------

  // Rotation and per-sample decay for each partial of slot s at its pitch.
  setCoefficients(s) {
    const fs = this.fs, hz = this.hz[s], nyquistGuard = 0.45 * fs;
    const t60 = this.bellDecay * Math.pow(220 / hz, 0.3);
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p, f = hz * PARTIAL_RATIOS[p];
      if (f >= nyquistGuard) { this.re[k] = this.im[k] = this.cr[k] = this.ci[k] = 0; continue; }
      const decay = Math.exp(-LN1000 / ((t60 / Math.pow(PARTIAL_RATIOS[p], 0.8)) * fs));
      const w = (2 * Math.PI * f) / fs;
      this.cr[k] = decay * Math.cos(w);
      this.ci[k] = decay * Math.sin(w);
    }
  }

  // The bell-decay knob also applies to stones already ringing.
  updateRingingDecays() {
    for (let s = 0; s < this.slots; s++) if (this.active[s]) this.setCoefficients(s);
  }

  // Current amplitude of a slot (sum of its partials' magnitudes).
  level(s) {
    let a = 0;
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p;
      a += Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
    }
    return a;
  }

  // Move stone s's ring into a fade slot (it fades over FADE_SECONDS from
  // `offset`), freeing the stone for its new pitch. If every fade slot is
  // busy, the quietest (level × fade remaining) is reused.
  fadeOut(s, offset) {
    let slot = -1, least = Infinity;
    for (let f = MAX_STONES; f < this.slots; f++) {
      if (!this.active[f]) { slot = f; break; }
      const audible = this.level(f) * this.fadeLeft[f];
      if (audible < least) { least = audible; slot = f; }
    }
    for (let p = 0; p < PARTIALS; p++) {
      const from = s * PARTIALS + p, to = slot * PARTIALS + p;
      this.re[to] = this.re[from]; this.im[to] = this.im[from];
      this.cr[to] = this.cr[from]; this.ci[to] = this.ci[from];
    }
    this.gainL[slot] = this.gainL[s]; this.gainR[slot] = this.gainR[s];
    this.hz[slot] = this.hz[s];
    this.age[slot] = 1;
    this.fadeLeft[slot] = this.fadeTotal;
    this.start[slot] = offset > 0 ? offset | 0 : 0;
    this.active[slot] = 1;
    this.active[s] = 0;
  }

  noise(s) {
    let x = this.tickRng[s];
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.tickRng[s] = x;
    return x / 2147483648 - 1;
  }

  nextSeed() {
    let x = this.rng[0];
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.rng[0] = x;
    return x || 1;
  }
}
