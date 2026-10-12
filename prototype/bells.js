// bells.js — one voice per stone: the water-struck bell, plus an optional
// synth layer (voice.js holds what each stone's voice is set to).
//
// The bell: each stone is a single ringing object, a handful of exponentially
// decaying partials (modal synthesis, one rotating phasor per partial). The
// lowest partial is the stone's pitch exactly; the others sit at bar-like
// ratios (morphing toward clangy free-bar ratios) and die faster. When the
// water strikes a stone that is still ringing, the new energy adds to what it
// is already doing — it rings on brighter, or partly cancels, depending on
// phase — rather than starting a second copy. So nothing is ever stolen or
// cut off.
//
// The synth layer (silent by default): two band-limited oscillators (sine →
// triangle → saw → square) into a resonant low-pass whose cutoff follows the
// stone's pitch and opens with each strike, shaped by an attack–decay
// envelope. A re-strike adds to it too: the envelope rises again from where
// it is. Neither layer has a note-off.
//
// Neither layer piles up without limit: the bell has a capacity (BELL_PEAK)
// that it settles back to, and the synth envelope a peak (SYNTH_PEAK). A hit
// is still a hit, though — it drives the ring past the capacity by its own
// energy (bounded by BELL_HARD_PEAK), and that excess bleeds away over ~0.1 s,
// so water that holds a note while it is struck again and again stays
// expressive instead of becoming a drone that ignores how hard you hit it.
// The tick is never capped at all: the performer's touch is always audible.
//
// Water-held sustain (the voice's `hold`): while the water around a stone
// keeps moving, its decay slows; as the water calms it resumes. The water
// holds the note, never the player. updateHold() applies it on the water
// clock, so the output never depends on block size.
//
// The voice's targets (the filter's cutoff and resonance, the synth level and
// oscillator mix) are read every COEF_EVERY samples, and the running values
// follow them per sample, so a knob moved while a stone rings — or the
// filter's own sweep after a strike, at its fastest — glides rather than
// stepping.
//
// A strike also makes a short noise "tick": the water touching the stone.
// Harder strikes are louder and brighter. Each stone is panned by its position.
// A retune doesn't touch a ringing stone: it rings on at its old pitch until
// it is next struck; then its old ring crossfades out over 100 ms (a stone has
// one pitch) while the new pitch starts.
//
// All memory is allocated up front; strike(), renderRange(), updateHold() and
// endBlock() allocate nothing. Partials and oscillators at or above
// 0.45 × sample rate are dropped. A bell that has fallen below hearing, and a
// synth layer whose oscillators are silent and whose filter has drained, stop
// being computed; filter state below FLUSH is rounded to zero (subnormals cost
// badly on Intel). A NaN releases the slot at its next release check rather
// than spreading: until then that block's mix is zeroed by endBlock's
// finiteness guard, so the worst case is the rest of that block in silence.

import { MAX_STONES } from './stones.js';
import { VoiceBank, VOICE_PARAMS, VOICE_SIZE, V, SHARED } from './voice.js';

// Knobs that belong to the whole instrument, not to a voice.
export const BELL_PARAMS = {
  volume: { min: 0, max: 1.2, def: 0.7 }, // above ~1.2 the knob only drives the output limiter harder (pumping), not louder
};

// Bar-like partials: the octave and twelfth keep the bell tuneful; one
// slightly inharmonic partial gives it a little bell colour. `bellPartials`
// morphs them (geometrically) toward a free bar's clangy ratios.
const PARTIAL_RATIOS = [1, 2.0, 3.0, 4.07, 5.4];
const CLANG_RATIOS = [1, 2.756, 5.404, 8.933, 13.344];
const PARTIAL_LEVELS = [1, 0.15, 0.22, 0.1, 0.06]; // at full brightness
const PARTIALS = PARTIAL_RATIOS.length;
const LN1000 = Math.log(1000);
const MIN_VELOCITY = 0.02; // quieter strikes are skipped
const VOICE_FLOOR = 1e-4; // a stone this quiet has stopped ringing
const RELEASE_CHECK = 64; // checked every 64 samples of the ring's own life
const TICK_SECONDS = 0.004;
const TICK_ATTACK_SECONDS = 0.0003;
const TICK_CUTOFF_HZ = 3500; // low-passed noise reads as water, not a click
const TICK_LEVEL = 0.12;
// Rings of retuned stones, fading out: enough for every stone to be retuned
// twice within one fade, so a scale change mid-phrase never runs out.
const FADE_SLOTS = 2 * MAX_STONES;
const FADE_SECONDS = 0.1;
const PAN_MIN = 0.2, PAN_MAX = 0.8; // moderate stereo spread
const OUTPUT_GAIN = 0.25; // headroom for many stones at once (at ≤ 16 stones)
const GAIN_GLIDE_SECONDS = 0.02;
const GAIN_REFERENCE_STONES = 16; // more stones than this → gain scales by √(16 / count)
const MIN_HZ = 8;
// Synth layer.
const SYNTH_GAIN = 1.6; // a synth layer at level 1 sits near the bell's loudness
const SYNTH_PEAK = 2; // re-strikes add, up to this envelope level
const BELL_PEAK = 2.5; // the level a held bell settles at (sum of the partials' magnitudes)
const BELL_HARD_PEAK = 2 * BELL_PEAK; // …but a hit may drive it this far, for a moment
const BELL_RETURN_SECONDS = 0.1; // and the excess is bled off over about this (T60)
export const COEF_EVERY = 16; // the voice's targets are refreshed every 16 samples…
const GLIDE_SECONDS = 0.001; // …and followed per sample, over roughly this long
const GLIDE_EPS = 1e-9; // close enough to the target to snap to it (never subnormal)
const MIN_G = 1e-6; // filter tuning coefficient floor (a NaN or a stalled glide)
const FLUSH = 1e-15; // filter state below this is subnormal: rounded to zero
const FENV_FLOOR = 1e-9; // the filter envelope is spent below this: snap to zero
const MIN_CUTOFF_HZ = 20;
// Water-held sustain: at hold 1 in fully moving water, decay runs at 5% speed.
const HOLD_MAX = 0.95;

export class Bells {
  constructor({ sampleRate = 48000 } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    this.fs = sampleRate;
    this.voices = new VoiceBank();
    // Slots 0..MAX_STONES−1 are the stones; the rest hold fading rings.
    const slots = MAX_STONES + FADE_SLOTS;
    this.slots = slots;
    const n = slots * PARTIALS;
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.cr = new Float64Array(n);
    this.ci = new Float64Array(n);
    this.cw = new Float64Array(n); // rotation of each partial (cos, sin)
    this.sw = new Float64Array(n);
    this.lnd = new Float64Array(n); // log of each partial's per-sample decay, unheld
    this.active = new Uint8Array(slots);
    this.bellDone = new Uint8Array(slots); // the bell has faded: stop computing it
    this.hz = new Float64Array(slots);
    this.vbase = new Int32Array(slots); // which voice the slot plays (index into voices.p's slots)
    this.holdF = new Float64Array(slots).fill(1); // decay speed: 1 normal, less while the water holds it
    this.holdFAt = new Float64Array(slots); // the hold factor cr/ci were last built at
    this.start = new Int32Array(slots); // first sample to render in the current block
    this.age = new Int32Array(slots);
    this.coefLeft = new Int32Array(slots); // samples until the voice's targets are read again
    this.gainL = new Float64Array(slots);
    this.gainR = new Float64Array(slots);
    this.fadeLeft = new Int32Array(slots); // fade slots: samples until silent
    // Synth layer, per slot.
    this.sOn = new Uint8Array(slots);
    this.ph1 = new Float64Array(slots); this.ph2 = new Float64Array(slots); // phase in [0, 1)
    this.inc1 = new Float64Array(slots); this.inc2 = new Float64Array(slots); // cycles per sample (0 = muted)
    this.env = new Float64Array(slots);
    this.envStep = new Float64Array(slots); // attack: added per sample
    this.envLeft = new Int32Array(slots); // attack samples left
    this.envDec = new Float64Array(slots); // decay: multiplied per sample
    this.fenv = new Float64Array(slots); // how far the strike has the filter open (0–1)
    this.fenvDec = new Float64Array(slots); // its decay, per sample
    this.ic1 = new Float64Array(slots); this.ic2 = new Float64Array(slots); // filter state
    // The filter, level and mix as they are (Cur) and as the voice wants them
    // (T): the running values glide per sample toward the targets.
    this.gCur = new Float64Array(slots); this.kCur = new Float64Array(slots);
    this.gT = new Float64Array(slots); this.kT = new Float64Array(slots);
    this.sLvlCur = new Float64Array(slots); this.sLvlT = new Float64Array(slots);
    this.mixCur = new Float64Array(slots); this.mixT = new Float64Array(slots);
    this.snapGlide = new Uint8Array(slots); // a fresh synth layer starts at its targets, not gliding in
    this.sh1 = new Float64Array(slots); this.sh2 = new Float64Array(slots); // oscillator shapes
    this.glide = 1 - Math.exp(-1 / (GLIDE_SECONDS * sampleRate));
    // How much of the energy a hit puts above the bell's capacity is left
    // after one RELEASE_CHECK: the excess falls 60 dB in BELL_RETURN_SECONDS.
    this.bleed = Math.pow(10, (-3 * RELEASE_CHECK) / (BELL_RETURN_SECONDS * sampleRate));
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
    this.volume = BELL_PARAMS.volume.def;
    this.rng = new Uint32Array(1);
    this.rng[0] = 0x9e3779b9;
    this.stoneGain = 1;
    this.gain = this.volume * OUTPUT_GAIN; // the smoothed output gain
    this.gainGlide = 1 - Math.exp(-1 / (GAIN_GLIDE_SECONDS * sampleRate));
    this.skipped = 0; // diagnostics
    this.restruck = 0;
    this.fadeReuses = 0; // fade slots reused while still fading (should stay 0)
  }

  // `volume`, or any voice parameter by name (sets the shared voice).
  setParam(name, value) {
    if (name === 'volume') {
      const p = BELL_PARAMS.volume;
      if (Number.isFinite(value)) this.volume = value < p.min ? p.min : value > p.max ? p.max : value;
    } else if (Object.prototype.hasOwnProperty.call(VOICE_PARAMS, name)) {
      this.voices.set(SHARED, V[name], value);
    }
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
    const s = stone, P = this.voices.p, vb = this.voices.slot(s), vp = vb * VOICE_SIZE;
    const v = velocity > 1 ? 1 : velocity;
    const gain = Math.pow(10, (-P[vp + V.dynamics] / 20) * (1 - v));
    const bright = 1 - P[vp + V.strikeBright] * 0.7 * (1 - v); // 0.3 + 0.7v by default

    if (this.active[s] && this.hz[s] !== hz) this.fadeOut(s, offset); // retuned while ringing
    const ringing = this.active[s] === 1;
    if (!ringing) {
      // A fresh ring: set up rotation and decay for this pitch.
      for (let p = 0; p < PARTIALS; p++) {
        this.re[s * PARTIALS + p] = this.im[s * PARTIALS + p] = 0;
        this.bellDone[s] = 0;
      }
      this.hz[s] = hz;
      this.vbase[s] = vb;
      this.holdF[s] = 1;
      this.setCoefficients(s);
      const pp = PAN_MIN + (PAN_MAX - PAN_MIN) * (pan < 0 ? 0 : pan > 1 ? 1 : pan);
      this.gainL[s] = Math.cos(pp * Math.PI * 0.5);
      this.gainR[s] = Math.sin(pp * Math.PI * 0.5);
      this.start[s] = offset > 0 ? offset | 0 : 0;
      this.active[s] = 1;
      this.sOn[s] = 0;
    } else {
      this.restruck++;
      if (this.vbase[s] !== vb) { this.vbase[s] = vb; this.setCoefficients(s); } // voice changed while ringing
    }
    // Add the strike's energy: each partial gets a new sine-phase-0 component
    // on top of whatever it is already doing (no click; linear superposition).
    // A hit always lands — it drives the ring past its capacity by its own
    // energy — and the excess then bleeds away (see the release check), so the
    // held note answers a strike instead of ignoring it, and hardness still
    // sets how loud and how bright that answer is. Only a burst that would
    // take the ring past BELL_HARD_PEAK is scaled back (level() sums the
    // partials' magnitudes, which bounds the actual peak, so it cannot clip).
    const bell = gain * P[vp + V.bellLevel], tone = P[vp + V.bellTone];
    if (bell > 0) {
      let add = 0;
      for (let p = 0; p < PARTIALS; p++) {
        const k = s * PARTIALS + p;
        if (this.cr[k] === 0 && this.ci[k] === 0) continue;
        add += bell * (p === 0 ? 1 : PARTIAL_LEVELS[p] * tone * (p >= 3 ? bright * bright : bright));
      }
      const room = BELL_HARD_PEAK - this.level(s);
      const scale = !(add <= room) ? (room > 0 ? room / add : 0) : 1; // NaN → 0: silence, never spread
      if (scale > 0) {
        for (let p = 0; p < PARTIALS; p++) {
          const k = s * PARTIALS + p;
          if (this.cr[k] === 0 && this.ci[k] === 0) continue;
          this.re[k] += scale * bell * (p === 0 ? 1 : PARTIAL_LEVELS[p] * tone * (p >= 3 ? bright * bright : bright));
        }
        this.bellDone[s] = 0; // the partials are alive again
      }
    }
    // The synth layer: its envelope rises again from wherever it is.
    if (P[vp + V.synthLevel] > 0) {
      if (!this.sOn[s]) {
        this.sOn[s] = 1;
        this.env[s] = 0; this.fenv[s] = 0;
        this.ph1[s] = 0; this.ph2[s] = 0;
        this.ic1[s] = 0; this.ic2[s] = 0;
        this.snapGlide[s] = 1; // a fresh layer starts at the voice's targets
      }
      const atk = Math.max(1, Math.round(P[vp + V.attack] * fs));
      let peak = this.env[s] + gain;
      if (peak > SYNTH_PEAK) peak = SYNTH_PEAK;
      this.envLeft[s] = atk;
      this.envStep[s] = (peak - this.env[s]) / atk;
      if (bright > this.fenv[s]) this.fenv[s] = bright;
    }
    this.age[s] = 0; // coefficients refresh on the first sample
    this.coefLeft[s] = 0;
    this.tickLeft[s] = this.tickTotal;
    this.tickAge[s] = 0;
    this.tickLevel[s] = TICK_LEVEL * gain * bright * this.tickNorm * P[vp + V.tick];
    this.tickState[s] = 0;
    this.tickRng[s] = this.nextSeed();
    return true;
  }

  // Add n samples into outL / outR (which the caller zeroes), then apply
  // volume.
  render(outL, outR, n) {
    this.applyPending();
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
      let age = this.age[s], coefLeft = this.coefLeft[s], finished = false, bellDone = this.bellDone[s] === 1;
      let tickLeft = isStone ? this.tickLeft[s] : 0;
      let tickState = isStone ? this.tickState[s] : 0, tickAge = isStone ? this.tickAge[s] : 0;
      let fadeLeft = this.fadeLeft[s];
      // The synth layer's state lives in locals while the slot renders.
      let synth = this.sOn[s] === 1;
      let env = this.env[s], envLeft = this.envLeft[s], envStep = this.envStep[s], envDec = this.envDec[s];
      let fenv = this.fenv[s], fenvDec = this.fenvDec[s];
      let p1 = this.ph1[s], p2 = this.ph2[s], ic1 = this.ic1[s], ic2 = this.ic2[s];
      // The filter, level and mix glide per sample toward the voice's targets.
      let g = this.gCur[s], k = this.kCur[s], sLvl = this.sLvlCur[s], mix = this.mixCur[s];
      let gT = this.gT[s], kT = this.kT[s], sLvlT = this.sLvlT[s], mixT = this.mixT[s];
      let i1 = 0, i2 = 0, a1 = 0, a2 = 0, a3 = 0;
      let w1 = 0, f1 = 0, w2 = 0, f2 = 0, g1 = 0, g2 = 0;
      let loaded = false; // the voice's targets are copied into locals on the first synth sample
      let settled = false; // the glides have reached their targets: nothing to follow
      for (let i = from > this.start[s] ? from : this.start[s]; i < to; i++) {
        // Every RELEASE_CHECK samples: bleed back any energy a hit put above
        // the bell's capacity (the hit itself is heard — see strike()), then
        // release the slot if there is nothing left. NaN counts as finished.
        if (age > 0 && age % RELEASE_CHECK === 0) {
          let lv = this.level(s);
          if (!(lv < 1e6)) lv = 0; // NaN or infinity: treat as silent
          if (lv > BELL_PEAK) { // the excess is a hit, and it fades back to the capacity
            const f = (BELL_PEAK + (lv - BELL_PEAK) * this.bleed) / lv;
            for (let p = 0; p < PARTIALS; p++) { const q = base + p; re[q] *= f; im[q] *= f; }
            lv = BELL_PEAK + (lv - BELL_PEAK) * this.bleed;
          }
          if (tickLeft === 0 && (bellDone || !(lv >= VOICE_FLOOR))) {
            if (!bellDone) { // the partials are inaudible: keep the ring, stop the math
              bellDone = true;
              for (let p = 0; p < PARTIALS; p++) { const q = base + p; re[q] = 0; im[q] = 0; }
            }
            if (!synth) { finished = true; break; }
            if (envLeft === 0 && !(env >= VOICE_FLOOR)) { finished = true; break; }
          }
        }
        let out = 0;
        if (synth) {
          // The voice's targets are read every COEF_EVERY samples; a countdown
          // keeps that on the same stream samples without a modulo per sample.
          const refresh = coefLeft === 0;
          coefLeft = refresh ? COEF_EVERY - 1 : coefLeft - 1;
          if (refresh) this.synthCoefficients(s, fenv);
          if (refresh || !loaded) {
            i1 = this.inc1[s]; i2 = this.inc2[s];
            envDec = this.envDec[s]; fenvDec = this.fenvDec[s];
            const sh1 = this.sh1[s], sh2 = this.sh2[s];
            w1 = sh1 >= 2 ? 2 : sh1 >= 1 ? 1 : 0; f1 = sh1 - w1;
            w2 = sh2 >= 2 ? 2 : sh2 >= 1 ? 1 : 0; f2 = sh2 - w2;
            gT = this.gT[s]; kT = this.kT[s]; sLvlT = this.sLvlT[s]; mixT = this.mixT[s];
            if (!loaded) {
              if (this.snapGlide[s]) { this.snapGlide[s] = 0; g = gT; k = kT; sLvl = sLvlT; mix = mixT; }
              else { g = this.gCur[s]; k = this.kCur[s]; sLvl = this.sLvlCur[s]; mix = this.mixCur[s]; }
              a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * g * a1;
            }
            loaded = true;
          }
          // The running values follow their targets per sample, so a knob
          // moving or the filter sweeping is a glide, never a step. Once
          // everything has caught up there is nothing to do until the next
          // refresh, which is the common case.
          if (refresh || !settled) {
            if (g !== gT || k !== kT) {
              if (g !== gT) { g += this.glide * (gT - g); if (!(Math.abs(gT - g) > GLIDE_EPS)) g = gT; }
              if (k !== kT) { k += this.glide * (kT - k); if (!(Math.abs(kT - k) > GLIDE_EPS)) k = kT; }
              a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * g * a1;
            }
            if (sLvl !== sLvlT) { sLvl += this.glide * (sLvlT - sLvl); if (!(Math.abs(sLvlT - sLvl) > GLIDE_EPS)) sLvl = sLvlT; }
            if (mix !== mixT) { mix += this.glide * (mixT - mix); if (!(Math.abs(mixT - mix) > GLIDE_EPS)) mix = mixT; }
            g1 = i1 > 0 && sLvl !== 0 ? (1 - mix) * sLvl : 0;
            g2 = i2 > 0 && sLvl !== 0 ? mix * sLvl : 0;
            settled = g === gT && k === kT && sLvl === sLvlT && mix === mixT;
          }
          // Died away (the bell rings on), gone quiet (no oscillator makes a
          // sound and the filter has drained), or broken: stop the layer.
          if (refresh && ((envLeft === 0 && !(env >= VOICE_FLOOR) && age > 0) ||
              (g1 === 0 && g2 === 0 && !(Math.abs(ic1) + Math.abs(ic2) >= FLUSH)) ||
              !(Math.abs(ic1) + Math.abs(ic2) < 1e6))) {
            synth = false;
            ic1 = ic2 = env = 0;
          } else {
            // Envelope: a linear attack to its peak, then exponential decay.
            if (envLeft > 0) { env += envStep; envLeft--; } else env *= envDec;
            let x = 0;
            if (g1 !== 0) {
              const a = wave(w1, p1, i1);
              x += g1 * (f1 > 0 ? a + f1 * (wave(w1 + 1, p1, i1) - a) : a);
              p1 += i1; if (p1 >= 1) p1 -= 1;
            }
            if (g2 !== 0) {
              const a = wave(w2, p2, i2);
              x += g2 * (f2 > 0 ? a + f2 * (wave(w2 + 1, p2, i2) - a) : a);
              p2 += i2; if (p2 >= 1) p2 -= 1;
            }
            // Topology-preserving state-variable low-pass.
            const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
            ic1 = 2 * v1 - ic1;
            ic2 = 2 * v2 - ic2;
            // Subnormal filter state is slow on Intel: round it to zero. This
            // also swallows a NaN instead of letting it spread.
            if (!(ic1 < -FLUSH || ic1 > FLUSH)) ic1 = 0;
            if (!(ic2 < -FLUSH || ic2 > FLUSH)) ic2 = 0;
            out += v2 * env;
          }
          if (fenv !== 0) {
            fenv *= fenvDec;
            if (!(fenv >= FENV_FLOOR)) fenv = 0;
          }
        }
        age++;
        if (!bellDone) {
          for (let p = 0; p < PARTIALS; p++) {
            const q = base + p, r = re[q], m = im[q], c = cr[q], s2 = ci[q];
            const next = r * s2 + m * c; // the rotated imaginary part is the output
            re[q] = r * c - m * s2;
            im[q] = next;
            out += next;
          }
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
      this.coefLeft[s] = coefLeft;
      this.fadeLeft[s] = fadeLeft;
      this.sOn[s] = synth ? 1 : 0;
      this.bellDone[s] = bellDone ? 1 : 0;
      this.env[s] = env; this.envLeft[s] = envLeft;
      this.fenv[s] = fenv; this.fenvDec[s] = fenvDec;
      this.ph1[s] = p1; this.ph2[s] = p2; this.ic1[s] = ic1; this.ic2[s] = ic2;
      this.gCur[s] = g; this.kCur[s] = k; this.sLvlCur[s] = sLvl; this.mixCur[s] = mix;
      if (isStone) {
        this.tickLeft[s] = tickLeft;
        this.tickState[s] = tickState;
        this.tickAge[s] = tickAge;
      }
      if (finished) { this.active[s] = 0; this.sOn[s] = 0; this.bellDone[s] = 0; }
    }
  }

  // Finish a block: volume over [0, n). No saturation here: a tanh on
  // every sample put grit on loud, busy playing (Dash, Oct 2026: "a bit of
  // distortion when it's very loud and many are going at once"); the output
  // limiter at the end of the chain (limiter.js) keeps the whole mix under
  // full scale by turning it down instead.
  // The gain glides per sample toward its target (~20 ms), in stream time, so
  // volume moves and stone-count changes never click and the output stays
  // identical however the stream is split into blocks.
  endBlock(outL, outR, n) {
    for (let s = 0; s < this.slots; s++) this.start[s] = 0;
    const target = this.volume * OUTPUT_GAIN * this.stoneGain, a = this.gainGlide;
    let g = this.gain;
    for (let i = 0; i < n; i++) {
      g += a * (target - g);
      if (g - target < 1e-9 && target - g < 1e-9) g = target; // exact, never subnormal
      const l = outL[i] * g, r = outR[i] * g;
      outL[i] = l === l && l - l === 0 ? l : 0; // NaN or ±∞ → silence
      outR[i] = r === r && r - r === 0 ? r : 0;
    }
    this.gain = g;
  }

  // Water-held sustain. `wet(i)` is how much the water around stone i is
  // moving (0 calm → 1 at a ringing crest's height). Call on the water clock
  // (the instrument does, every few simulation steps), between renders.
  updateHold(stones) {
    const P = this.voices.p;
    for (let s = 0; s < MAX_STONES; s++) {
      if (!this.active[s]) continue;
      const hold = P[this.vbase[s] * VOICE_SIZE + V.hold];
      const f = hold > 0 ? 1 - HOLD_MAX * hold * stones.wet(s) : 1;
      const d = f - this.holdF[s];
      if (d > 1e-4 || d < -1e-4 || (f === 1 && d !== 0)) {
        this.holdF[s] = f;
        this.applyDecay(s); // the synth envelope picks it up at its next refresh
      }
    }
  }

  // Ringing stones (not counting fading rings).
  activeVoices() {
    let c = 0;
    for (let s = 0; s < MAX_STONES; s++) c += this.active[s];
    return c;
  }

  // ---- internals ----------------------------------------------------------------

  // Rotation and unheld decay for each partial of slot s at its pitch and
  // voice, then the decay as held now.
  setCoefficients(s) {
    const fs = this.fs, hz = this.hz[s], nyquistGuard = 0.45 * fs, P = this.voices.p, vb = this.vbase[s];
    const vp = vb * VOICE_SIZE;
    const t60 = P[vp + V.bellDecay] * Math.pow(220 / hz, 0.3), clang = P[vp + V.bellPartials];
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p;
      const ratio = clang > 0 ? PARTIAL_RATIOS[p] * Math.pow(CLANG_RATIOS[p] / PARTIAL_RATIOS[p], clang) : PARTIAL_RATIOS[p];
      const f = hz * ratio;
      if (f >= nyquistGuard) { this.re[k] = this.im[k] = this.cw[k] = this.sw[k] = this.lnd[k] = 0; continue; }
      const w = (2 * Math.PI * f) / fs;
      this.lnd[k] = -LN1000 / ((t60 / Math.pow(ratio, 0.8)) * fs);
      this.cw[k] = Math.cos(w);
      this.sw[k] = Math.sin(w);
    }
    this.buildDecay(s);
  }

  // The per-sample rotation of every partial, built from the pitch's rotation
  // and the decay at the hold factor as it is now.
  buildDecay(s) {
    const f = this.holdF[s];
    this.holdFAt[s] = f;
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p, d = Math.exp(this.lnd[k] * f);
      this.cr[k] = d * this.cw[k];
      this.ci[k] = d * this.sw[k];
    }
  }

  // The water's hold has moved: scale the decay from where it was. The water
  // clock moves `f` in small steps, so exp(lnd·Δf) is its own two-term series
  // to far past the audio's precision — and it costs no exp() per partial,
  // however many stones are ringing at once.
  applyDecay(s) {
    const f = this.holdF[s], df = f - this.holdFAt[s];
    if (df === 0) return;
    this.holdFAt[s] = f;
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p, y = this.lnd[k] * df;
      const m = 1 + y + 0.5 * y * y;
      this.cr[k] *= m;
      this.ci[k] *= m;
    }
  }

  // The synth layer follows its voice: oscillator pitches and shapes, and the
  // targets the filter, level and mix glide toward per sample (the filter
  // opening with the strike, closing over filterDecay) and the envelope's
  // decay (slowed while the water holds the note). `fenv` is the caller's
  // live value, which decays every sample rather than every refresh.
  synthCoefficients(s, fenv) {
    const fs = this.fs, P = this.voices.p, vb = this.vbase[s], vp = vb * VOICE_SIZE;
    const hz = this.hz[s], guard = 0.45 * fs;
    this.inc1[s] = hz < guard ? hz / fs : 0;
    const f2 = hz * Math.pow(2, (P[vp + V.osc2Pitch] + P[vp + V.osc2Detune] / 100) / 12);
    this.inc2[s] = f2 < guard ? f2 / fs : 0;
    this.sh1[s] = P[vp + V.osc1Shape];
    this.sh2[s] = P[vp + V.osc2Shape];
    this.mixT[s] = P[vp + V.oscMix];
    this.sLvlT[s] = P[vp + V.synthLevel] * SYNTH_GAIN;
    let fc = hz * Math.pow(2, P[vp + V.cutoff] + P[vp + V.filterEnv] * fenv);
    fc = fc < MIN_CUTOFF_HZ ? MIN_CUTOFF_HZ : fc > guard ? guard : fc;
    // Topology-preserving state-variable filter (stable under modulation).
    const g = Math.tan((Math.PI * fc) / fs), k = 2 - 2 * P[vp + V.resonance];
    this.gT[s] = g > MIN_G ? g : MIN_G;
    this.kT[s] = k;
    this.fenvDec[s] = Math.exp(-LN1000 / (P[vp + V.filterDecay] * fs));
    this.envDec[s] = Math.exp((-LN1000 * this.holdF[s]) / (P[vp + V.synthDecay] * fs));
  }

  // Current amplitude of a slot's bell (sum of its partials' magnitudes).
  level(s) {
    let a = 0;
    for (let p = 0; p < PARTIALS; p++) {
      const k = s * PARTIALS + p;
      a += Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
    }
    return a;
  }

  // Call at the start of each block: voice edits reach stones already
  // ringing (the bell's decay and partials; the synth layer follows on its
  // own), and a stone whose override was switched moves to its new voice.
  // However many edits arrive, it's one recompute per ringing stone.
  applyPending() {
    const vo = this.voices;
    if (!vo.anyDirty) return;
    for (let s = 0; s < this.slots; s++) {
      if (!this.active[s]) continue;
      const vb = s < MAX_STONES ? vo.slot(s) : this.vbase[s];
      if (vb !== this.vbase[s] || vo.dirty[vb]) {
        this.vbase[s] = vb;
        this.setCoefficients(s);
      }
    }
    vo.clearDirty();
  }

  // Move stone s's ring into a fade slot (it fades over FADE_SECONDS from
  // `offset`), freeing the stone for its new pitch. If every fade slot is
  // busy, the quietest (level × fade remaining) is reused.
  fadeOut(s, offset) {
    let slot = -1;
    for (let f = MAX_STONES; f < this.slots; f++) if (!this.active[f]) { slot = f; break; }
    if (slot < 0) { // all busy (shouldn't happen): reuse the least audible
      let least = Infinity;
      for (let f = MAX_STONES; f < this.slots; f++) {
        const audible = (this.level(f) + this.env[f]) * this.fadeLeft[f];
        if (audible < least) { least = audible; slot = f; }
      }
      this.fadeReuses++;
    }
    for (let p = 0; p < PARTIALS; p++) {
      const from = s * PARTIALS + p, to = slot * PARTIALS + p;
      this.re[to] = this.re[from]; this.im[to] = this.im[from];
      this.cr[to] = this.cr[from]; this.ci[to] = this.ci[from];
      this.cw[to] = this.cw[from]; this.sw[to] = this.sw[from]; this.lnd[to] = this.lnd[from];
    }
    this.gainL[slot] = this.gainL[s]; this.gainR[slot] = this.gainR[s];
    this.hz[slot] = this.hz[s];
    this.vbase[slot] = this.vbase[s];
    this.holdFAt[slot] = this.holdFAt[s];
    this.holdF[slot] = 1; // no longer held: it's fading anyway
    this.applyDecay(slot);
    this.bellDone[slot] = this.bellDone[s];
    this.sOn[slot] = this.sOn[s];
    this.ph1[slot] = this.ph1[s]; this.ph2[slot] = this.ph2[s];
    this.env[slot] = this.env[s]; this.envStep[slot] = this.envStep[s]; this.envLeft[slot] = this.envLeft[s];
    this.fenv[slot] = this.fenv[s]; this.fenvDec[slot] = this.fenvDec[s];
    this.ic1[slot] = this.ic1[s]; this.ic2[slot] = this.ic2[s];
    // Its own clock restarts at 1, so its synth targets refresh on the next
    // multiple of COEF_EVERY; carry the current ones until then.
    this.inc1[slot] = this.inc1[s]; this.inc2[slot] = this.inc2[s];
    this.sh1[slot] = this.sh1[s]; this.sh2[slot] = this.sh2[s];
    this.envDec[slot] = this.envDec[s];
    this.gCur[slot] = this.gCur[s]; this.kCur[slot] = this.kCur[s];
    this.gT[slot] = this.gT[s]; this.kT[slot] = this.kT[s];
    this.sLvlCur[slot] = this.sLvlCur[s]; this.sLvlT[slot] = this.sLvlT[s];
    this.mixCur[slot] = this.mixCur[s]; this.mixT[slot] = this.mixT[s];
    this.snapGlide[slot] = this.snapGlide[s];
    this.age[slot] = 1; // its own clock restarts here: the next target read is 15 samples on
    this.coefLeft[slot] = COEF_EVERY - 1;
    this.fadeLeft[slot] = this.fadeTotal;
    this.start[slot] = offset > 0 ? offset | 0 : 0;
    this.active[slot] = 1;
    this.active[s] = 0;
    this.sOn[s] = 0;
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

// One oscillator sample at phase t (cycles per sample dt): 0 sine,
// 1 triangle, 2 saw, 3 square (the voice crossfades between neighbours).
// Saw and square are band-limited with polyBLEP; all start at a zero
// crossing on the way up (sine phase), so a fresh strike starts without a jump.
function wave(i, t, dt) {
  switch (i) {
    case 0: return Math.sin(2 * Math.PI * t);
    case 1: { // triangle, sine phase
      const u = t + 0.25;
      return 1 - 4 * Math.abs((u >= 1 ? u - 1 : u) - 0.5);
    }
    case 2: { // saw, rising through zero at t = 0 (jumps at t = ½)
      const u = t + 0.5 >= 1 ? t - 0.5 : t + 0.5;
      return 2 * u - 1 - blep(u, dt);
    }
    default: { // square, high for the first half
      const u = t + 0.5 >= 1 ? t - 0.5 : t + 0.5;
      return (t < 0.5 ? 1 : -1) + blep(t, dt) - blep(u, dt);
    }
  }
}

// polyBLEP residual for a unit step at phase 0.
function blep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

export { VOICE_PARAMS };
