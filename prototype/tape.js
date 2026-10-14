// tape.js — the audio looper: "a tape beside the pond". Several tape tracks
// record the water's sound and play it back as fixed audio, like a loop
// pedal. The one part of the instrument that isn't the water: what a tape
// plays never changes, and it never disturbs the water.
//
// Each track records the instrument's live output — the water's sound, not
// other tapes (an overdub never captures any tape's playback, so nothing
// doubles pass after pass). The first take sets a track's length; overdub
// layers more on top, heard live once and replayed from the next pass.
// Tracks have their own lengths and drift against each other. Tapes always
// follow the tempo (Dash, Oct 2026 — quantize is for notes only): a take
// starts on a beat of the shared grid (the gesture looper's; the first take
// starts it) and ends on the beat nearest to where you finish, so every
// tape is a whole number of beats, but their lengths differ (3, 5, 7
// beats…), so the way they line up keeps changing.
//
// Record primes a track (Dash, Oct 2026): the take doesn't start until the
// water first rings a stone ("it should start recording when the first
// stone gets hit with a wave"), so a take never opens on dead air — not
// while your hand travels back to the pond, nor while your first ripple
// travels to a stone. An overdub primes the same way.
//
// A tape always plays back exactly what it recorded: retuning the stones
// never touches it, so a bassline, a melody and harmonies can be laid in
// different tunings.
//
// Tapes follow the tempo, keeping their pitch (Dash, Oct 2026: "Recorded
// tapes should follow tempo changes!" — keep pitch). Each track remembers the
// tempo it was recorded at; while the beat runs at another, its playhead
// moves faster or slower (delta: how far it has drifted from the stream) so
// the loop stays on the beat, and it's read as two overlapping grains of
// GRAIN_SECONDS, each at the recorded speed, crossfaded (Hann, half
// overlapping): the timing follows the tempo, the pitch doesn't. A tape at
// its own tempo is read directly, unchanged. An overdub on a tape at another
// tempo first re-records the track for one pass at the current tempo (what
// it plays, plus you) into a spare buffer, then swaps it in — so the old
// layers and the new one stay in tune with each other.
//
// Stopping, muting and clearing fade (TAPE_FADE_SECONDS), never cut. The loop
// seam is crossfaded with the sound from just before the take began, so a
// tape wraps without a click. Positions are counted in samples of the stream,
// so actions apply at the start of the block they arrive in; output never
// depends on how the stream is split into blocks.
//
// All memory is allocated up front (TAPE_TRACKS × MAX_TAPE_SECONDS of stereo
// at the stream's sample rate, plus one block of mix scratch); process() and
// action() allocate nothing. Blocks longer than MAX_BLOCK are split, so the
// caller's block size never allocates.

import { SIM_RATE } from './surface.js';

export const TAPE_TRACKS = 4;
export const MAX_TAPE_SECONDS = 30;
export const TAPE_FIELDS = 6; // floats per track in a visuals frame (see writeStatus)
export const TAPE_FADE_SECONDS = 0.3; // stop, mute and clear fade out over this
const FADE_IN_SECONDS = 0.02; // play and unmute fade in (no click)
const SEAM_SECONDS = 0.01; // the loop seam's crossfade
const PUNCH_SECONDS = 0.01; // overdub punch in and out
const MIN_TAKE_SECONDS = 0.05; // shorter takes are dropped
export const TAPE_MIX_GAIN = 0.7; // tapes play back −3 dB under the live water: layers sit under what you're playing, and the limiter rides them gently (at full level it pumps)
const MAX_BLOCK = 4096; // samples of mix scratch; a longer block is processed in parts
const GRAIN_SECONDS = 0.0427; // a time-stretch grain (2048 samples at 48 kHz): long enough that ringing bells don't warble
const RATE_EPS = 1e-6; // closer to its own tempo than this, a tape reads directly
const LEVEL_GLIDE_SECONDS = 0.02; // the tape level knob glides, never steps
const FADER_GLIDE_SECONDS = 0.03; // each track's fader glides too (a hand on a fader, never a step)

// Track states (the same meanings as the gesture looper's).
export const EMPTY = 0, RECORDING = 1, PLAYING = 2, OVERDUB = 3, STOPPED = 4;
// Actions the page sends (the same codes as the gesture looper's).
export const TAPE_RECORD = 1, TAPE_PLAY_STOP = 2, TAPE_MUTE = 3, TAPE_CLEAR = 4, TAPE_CLEAR_ALL = 5;

export const TAPE_PARAMS = {
  tapeLevel: { min: 0, max: 1.5, def: 1 },
};

export class TapeDeck {
  // `grid` is the gesture looper: its quantize switch, tempo (bpm) and shared
  // grid (transportOrigin, in simulation steps).
  constructor({ sampleRate = 48000, grid = null } = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 768000)) throw new RangeError('bad sampleRate');
    const fs = sampleRate;
    this.fs = fs;
    this.grid = grid;
    this.capacity = Math.ceil(MAX_TAPE_SECONDS * fs);
    // One buffer per track, plus a spare for re-recording a track at a new
    // tempo (see bounce): slot[t] says which buffer is track t's.
    this.L = new Float32Array((TAPE_TRACKS + 1) * this.capacity);
    this.R = new Float32Array((TAPE_TRACKS + 1) * this.capacity);
    this.slot = Int32Array.from({ length: TAPE_TRACKS }, (_, t) => t);
    this.spare = TAPE_TRACKS;
    // Following the tempo: the tempo each take was recorded at (0: doesn't
    // follow — no grid), how far its playhead has drifted from the stream,
    // and where its two grains started (unwrapped tape positions).
    this.recBpm = new Float64Array(TAPE_TRACKS);
    this.delta = new Float64Array(TAPE_TRACKS);
    this.tailDelta = new Float64Array(TAPE_TRACKS);
    this.grainA = new Float64Array(TAPE_TRACKS);
    this.grainB = new Float64Array(TAPE_TRACKS);
    this.hop = Math.max(32, Math.round((GRAIN_SECONDS * fs) / 2));
    this.alignRef = new Float64Array(this.hop); // scratch for alignGrain
    // The search costs the same at any sample rate: its strides are in 48 kHz samples.
    this.alignDec = Math.max(1, Math.round(fs / 48000));
    this.window = Float32Array.from({ length: 2 * this.hop }, (_, j) => 0.5 - 0.5 * Math.cos((Math.PI * j) / this.hop));
    // Re-recording a track at the current tempo (one at a time): which track,
    // how long its new loop is, how much is written, and the ratio of new
    // samples to old.
    this.bounceT = -1; this.bounceLen = 0; this.bounceCount = 0; this.bounceRatio = 1;
    this.seam = Math.max(1, Math.round(SEAM_SECONDS * fs));
    // The last `seam` samples of input, always kept, so a take can borrow the
    // sound from just before it began for its seam.
    this.preL = new Float32Array(this.seam); this.preR = new Float32Array(this.seam);
    this.preAt = 0;
    this.takePreL = new Float32Array(TAPE_TRACKS * this.seam);
    this.takePreR = new Float32Array(TAPE_TRACKS * this.seam);
    // A take starts mid-block (on a stone's sample): its seam keeps rolling
    // through the samples before that, as a ring starting at takePreAt.
    this.takePreAt = new Int32Array(TAPE_TRACKS);
    this.dubFrom = new Float64Array(TAPE_TRACKS); // an overdub punches in from this stream sample
    this.dubAt = new Int32Array(TAPE_TRACKS).fill(-1); // the tape sample a plain overdub last wrote
    this.state = new Uint8Array(TAPE_TRACKS);
    this.muted = new Uint8Array(TAPE_TRACKS);
    this.clearing = new Uint8Array(TAPE_TRACKS); // fading out, then erased
    this.stopping = new Uint8Array(TAPE_TRACKS); // fading out, then stopped
    this.onGrid = new Uint8Array(TAPE_TRACKS);
    this.primed = new Uint8Array(TAPE_TRACKS); // record pressed: waiting for the first stone the water rings
    this.origin = new Float64Array(TAPE_TRACKS); // stream sample of the loop's position 0
    this.takeStart = new Float64Array(TAPE_TRACKS);
    this.takeEnd = new Float64Array(TAPE_TRACKS); // a finishing take stops recording here (−1: not yet set)
    this.deadline = new Float64Array(TAPE_TRACKS); // a take finishes by itself here
    this.length = new Int32Array(TAPE_TRACKS); // samples (0 while the first take runs)
    this.startAt = new Float64Array(TAPE_TRACKS); // a restarted tape waits until this sample
    this.gain = new Float64Array(TAPE_TRACKS); // the track's fade, 0..1
    this.punch = new Float64Array(TAPE_TRACKS); // overdub input gain, 0..1
    // Each track's fader (Dash, Oct 2026): its playback level, 0..1, set by
    // hand while you play — fade a track in or out. Separate from mute, and
    // only what you hear: a take still records the water at full level.
    this.fader = new Float64Array(TAPE_TRACKS).fill(1);
    this.faderNow = new Float64Array(TAPE_TRACKS).fill(1); // as it glides
    // A tape restarted while it was still fading out keeps fading from where
    // it was (its tail) while the restart begins: never a jump.
    this.tailOrigin = new Float64Array(TAPE_TRACKS);
    this.tailGain = new Float64Array(TAPE_TRACKS);
    // A quantized take begins after its beat; the gap before it is silence.
    // It isn't zeroed all at once (up to a beat of memory in one block): reads
    // below gapEnd count as silence, and the playhead clears it as it passes,
    // starting from the top, during the first pass.
    this.gapEnd = new Int32Array(TAPE_TRACKS);
    // A take that starts playing mid-loop (its finish rounded back to the
    // beat just gone) hasn't swept the gap from the top yet: the gap stays
    // silent, cleared wherever the playhead passes, until it reaches the top.
    this.gapWait = new Uint8Array(TAPE_TRACKS);
    this.fadeOutStep = 1 / Math.max(1, Math.round(TAPE_FADE_SECONDS * fs));
    this.fadeInStep = 1 / Math.max(1, Math.round(FADE_IN_SECONDS * fs));
    this.punchStep = 1 / Math.max(1, Math.round(PUNCH_SECONDS * fs));
    this.minTake = Math.round(MIN_TAKE_SECONDS * fs);
    this.tapeLevel = TAPE_PARAMS.tapeLevel.def;
    this.level = this.tapeLevel * TAPE_MIX_GAIN; // the smoothed tape level (with the trim)
    this.levelGlide = 1 - Math.exp(-1 / (LEVEL_GLIDE_SECONDS * fs));
    this.faderGlide = 1 - Math.exp(-1 / (FADER_GLIDE_SECONDS * fs));
    this.now = 0; // stream sample at the start of the current block
    this.audible = false; // any tape sounding (or fading) in the last block
    // The tapes' sum for one block, kept apart from the live sound so an
    // overdub can never record another tape's playback.
    this.scratchL = new Float64Array(MAX_BLOCK);
    this.scratchR = new Float64Array(MAX_BLOCK);
  }

  setParam(name, value) {
    const p = TAPE_PARAMS[name];
    if (!p || !Number.isFinite(value)) return;
    this[name] = value < p.min ? p.min : value > p.max ? p.max : value;
  }

  // Any track holding a tape on the shared grid (the gesture looper keeps
  // the grid while one does).
  usesGrid() {
    for (let t = 0; t < TAPE_TRACKS; t++) if (this.state[t] !== EMPTY && this.onGrid[t]) return true;
    return false;
  }

  // A track's fader: its playback level, 0..1 (glides there).
  setFader(track, level) {
    if (!Number.isInteger(track) || track < 0 || track >= TAPE_TRACKS || !Number.isFinite(level)) return;
    this.fader[track] = level < 0 ? 0 : level > 1 ? 1 : level;
  }

  // An action from the page, applied at the start of the next block.
  action(track, act) {
    if (act === TAPE_CLEAR_ALL) {
      this.primed.fill(0);
      for (let t = 0; t < TAPE_TRACKS; t++) if (this.state[t] !== EMPTY) this.clear(t);
      return;
    }
    if (!Number.isInteger(track) || track < 0 || track >= TAPE_TRACKS) return;
    if (this.clearing[track]) return; // on its way out
    const s = this.state[track], now = this.now;
    // A primed track: record again unprimes it; play/stop and clear do their
    // own thing and unprime it too (nothing starts later). Mute leaves it.
    if (this.primed[track] && act !== TAPE_MUTE) {
      this.primed[track] = 0;
      if (act === TAPE_RECORD || s === EMPTY) return;
    }
    switch (act) {
      case TAPE_RECORD:
        // Primed: the take (or the overdub) starts when the water next rings a stone (see rang()).
        if (s === EMPTY || s === STOPPED || (s === PLAYING && !this.stopping[track])) this.primed[track] = 1;
        else if (s === RECORDING) this.finishTake(track, now);
        else if (s === OVERDUB) this.state[track] = PLAYING;
        break;
      case TAPE_PLAY_STOP:
        if ((s === PLAYING || s === OVERDUB) && !this.stopping[track]) { this.stopping[track] = 1; this.state[track] = PLAYING; }
        else if (s === STOPPED || this.stopping[track]) this.restart(track, now);
        else if (s === RECORDING) this.finishTake(track, now);
        break;
      case TAPE_MUTE:
        if (s !== EMPTY) this.muted[track] ^= 1;
        break;
      case TAPE_CLEAR:
        if (s !== EMPTY) this.clear(track);
        break;
    }
  }

  // A stone rang, at stream sample `at` (in the block now starting at
  // this.now): primed tracks start there — a first take, or an overdub.
  rang(at = this.now) {
    const now = at > this.now ? at : this.now;
    for (let t = 0; t < TAPE_TRACKS; t++) {
      if (!this.primed[t]) continue;
      this.primed[t] = 0;
      const s = this.state[t];
      if (this.clearing[t]) continue;
      if (s === EMPTY) this.startTake(t, now);
      else if (s === STOPPED || (s === PLAYING && !this.stopping[t])) {
        // An overdub on a tape at another tempo re-records it at this one
        // (startBounce); if the spare's busy with another track, wait for the next stone.
        if (!this.canBounce(t, now)) { this.primed[t] = 1; continue; }
        if (s === STOPPED) this.restart(t, now);
        this.startBounce(t, now);
        this.state[t] = OVERDUB; this.dubFrom[t] = now;
      }
    }
  }

  // Record the live output in outL/outR (n samples) and add the tapes'
  // playback to it. Call once per block, after the live sound is rendered and
  // with `now` set to the stream sample the block starts on. A block longer
  // than MAX_BLOCK is handled in parts; the parts cover disjoint ranges, so
  // each one still sees the live sound and never another tape's playback.
  process(outL, outR, n) {
    if (!Number.isInteger(n) || n <= 0) return;
    for (let off = 0; off < n; off += MAX_BLOCK) {
      const m = Math.min(MAX_BLOCK, n - off);
      this.processChunk(outL, outR, off, m);
      this.now += m;
    }
  }

  processChunk(outL, outR, off, n) {
    const cap = this.capacity, seam = this.seam;
    const tapeL = this.scratchL, tapeR = this.scratchR;
    let audible = false;
    for (let t = 0; t < TAPE_TRACKS; t++) {
      const s = this.state[t];
      if (s === EMPTY) { this.faderNow[t] = this.fader[t]; continue; } // nothing to glide over
      let base = this.slot[t] * cap;
      let len = this.length[t];
      let g = this.gain[t], punch = this.punch[t], tg = this.tailGain[t];
      let f = this.faderNow[t];
      const fTarget = this.fader[t], fa = this.faderGlide;
      let stepSeen = -1, stepBpm = 0;
      for (let i = 0; i < n; i++) {
        const at = this.now + i;
        if (f !== fTarget) { f += fa * (fTarget - f); if (f - fTarget < 1e-9 && fTarget - f < 1e-9) f = fTarget; } // exact, never subnormal
        const live = outL[off + i], liveR = outR[off + i];
        if (this.state[t] === RECORDING) {
          // The first take: written straight in from the beat (or the
          // take's start) until it finishes. The sample the take ends on is
          // played back in this very block — no `break` — so the tape's output
          // never depends on where the stream is split into blocks.
          if (this.takeEnd[t] < 0 && at >= this.deadline[t]) this.finishTake(t, at);
          if (this.takeEnd[t] >= 0 && at >= this.takeEnd[t]) this.endTake(t, this.takeEnd[t], at);
          if (this.state[t] === RECORDING) {
            if (at < this.takeStart[t]) { // before the stone: still the sound just before the take (its seam)
              const pa = this.takePreAt[t];
              this.takePreL[t * seam + pa] = live; this.takePreR[t * seam + pa] = liveR;
              this.takePreAt[t] = pa + 1 === seam ? 0 : pa + 1;
            }
            const k = at - this.origin[t];
            if (k >= 0 && k < cap) { this.L[base + k] = live; this.R[base + k] = liveR; }
            continue;
          }
          len = this.length[t]; // the take just ended: it has its length now
        }
        if (len <= 0) continue;
        const gapEnd = this.gapEnd[t];
        // A restarted tape's old tail fades out where it was.
        if (tg > 0) {
          const kt = mod(Math.floor(at - this.tailOrigin[t] + this.tailDelta[t]), len), j = base + kt;
          tg -= this.fadeOutStep; if (tg < 0) tg = 0;
          if (kt >= gapEnd) { tapeL[i] += this.L[j] * tg * f; tapeR[i] += this.R[j] * tg * f; }
          audible = true;
        }
        // Playing (or stopped and still fading out).
        const waiting = at < this.startAt[t];
        const target = waiting || this.muted[t] || this.stopping[t] || this.clearing[t] || this.state[t] === STOPPED ? 0 : 1;
        if (g < target) { g += this.fadeInStep; if (g > target) g = target; } else if (g > target) { g -= this.fadeOutStep; if (g < target) g = target; }
        // Erased or stopped only once everything it plays is silent — the
        // restart's tail included.
        if (g === 0 && target === 0 && !waiting && tg === 0) {
          if (this.clearing[t]) { this.erase(t); break; }
          if (this.stopping[t]) { this.stopping[t] = 0; this.state[t] = STOPPED; if (this.bounceT === t) this.bounceT = -1; }
        }
        if (this.state[t] === STOPPED || waiting) continue;
        // Where the playhead is: the stream's time since the loop's top, plus
        // how far following the tempo has moved it (delta).
        const rec = this.recBpm[t];
        let rate = 1;
        if (rec > 0) { // the tempo of this sample's step (looked up once a step)
          const st = Math.floor((at * SIM_RATE) / this.fs);
          if (st !== stepSeen) { stepSeen = st; stepBpm = this.grid.bpmAt(st); }
          rate = stepBpm / rec;
          if (rate - 1 < RATE_EPS && 1 - rate < RATE_EPS) rate = 1;
        }
        const posF = at - this.origin[t] + this.delta[t];
        // Where this sample falls in the current grain (at ≥ 0, whole). Each
        // track's grains are offset a quarter hop from the next, so their
        // searches (alignGrain) fall in different blocks.
        const x = (at + t * (this.hop >> 2)) % this.hop;
        if (x === 0) { // a new grain starts here
          this.grainB[t] = this.grainA[t];
          // Following the tempo, it starts near where the playhead is, nudged
          // to where it best lines up with the grain it fades in over (so a
          // held note doesn't beat against itself); at its own tempo, exactly there.
          this.grainA[t] = rate === 1 ? (this.delta[t] === 0 ? posF : this.grainB[t] + this.hop) // at its own speed: carry straight on
            : this.alignGrain(base, len, posF, this.grainB[t] + this.hop);
        }
        const pk = mod(Math.floor(posF), len), k = base + pk;
        if (pk === 0) this.gapWait[t] = 0; // at the top: the sweep from here clears it all
        // Faster than recorded, the playhead steps over samples: clear any of
        // those in the gap too (even on the step that leaves it).
        if (gapEnd > 0) for (let j = 1; j < rate; j++) { const q = pk - j; if (q >= 0 && q < gapEnd) { this.L[base + q] = 0; this.R[base + q] = 0; } }
        if (pk < gapEnd) { this.L[k] = 0; this.R[k] = 0; } // the gap, cleared as the playhead passes
        else if (gapEnd > 0 && !this.gapWait[t]) this.gapEnd[t] = 0; // passed it from the top: all clear
        let l, r;
        if (rate === 1 && this.delta[t] === 0) { l = this.L[k]; r = this.R[k]; } // at its own tempo: as recorded
        else {
          // Following the tempo: two grains, each read at the recorded speed
          // from where it started, crossfaded — the timing moves, the pitch
          // doesn't.
          const wA = this.window[x], wB = this.window[x + this.hop];
          const gEnd = this.gapEnd[t];
          let pa = this.grainA[t] + x, pb = this.grainB[t] + x + this.hop;
          pa -= len * Math.floor(pa / len); pb -= len * Math.floor(pb / len);
          let a0 = Math.floor(pa), b0 = Math.floor(pb);
          const fa2 = pa - a0, fb = pb - b0;
          if (a0 >= len) a0 -= len; // (rounding can land exactly on len)
          if (b0 >= len) b0 -= len;
          const a1 = a0 + 1 === len ? 0 : a0 + 1, b1 = b0 + 1 === len ? 0 : b0 + 1;
          const La0 = a0 < gEnd ? 0 : this.L[base + a0], La1 = a1 < gEnd ? 0 : this.L[base + a1];
          const Ra0 = a0 < gEnd ? 0 : this.R[base + a0], Ra1 = a1 < gEnd ? 0 : this.R[base + a1];
          const Lb0 = b0 < gEnd ? 0 : this.L[base + b0], Lb1 = b1 < gEnd ? 0 : this.L[base + b1];
          const Rb0 = b0 < gEnd ? 0 : this.R[base + b0], Rb1 = b1 < gEnd ? 0 : this.R[base + b1];
          l = wA * (La0 + (La1 - La0) * fa2) + wB * (Lb0 + (Lb1 - Lb0) * fb);
          r = wA * (Ra0 + (Ra1 - Ra0) * fa2) + wB * (Rb0 + (Rb1 - Rb0) * fb);
        }
        if (rate !== 1) this.delta[t] += rate - 1;
        // Overdub: the live sound goes on top (punched in and out over 10 ms),
        // read first, so this pass plays what was there and the next pass
        // plays both. A track being re-recorded at the current tempo (bounce)
        // writes what it plays, plus you, into the spare instead.
        const dub = this.state[t] === OVERDUB && !this.stopping[t] && at >= this.dubFrom[t] ? 1 : 0;
        // A plain overdub writes where the playhead is, which is right only at
        // the tape's own speed: if the tempo moves during one, it turns into a
        // re-recording at the new tempo (if it can — else the dub waits).
        // (Only at a steady tempo: one that moves mid-pass drops the pass, and
        // the dub waits for the tempo to settle — never a loop half at one
        // tempo, half at another.)
        if (this.bounceT === t && Math.abs(stepBpm / this.bounceBpm - 1) > RATE_EPS) this.bounceT = -1;
        if (dub && rate !== 1 && this.bounceT !== t && this.canBounce(t, at)) this.startBounce(t, at);
        // While it can't record (the tempo moving, no pass running), the dub
        // punches out over PUNCH_SECONDS like any other — never a cut.
        const dubTo = dub && (rate === 1 || this.bounceT === t) ? 1 : 0;
        if (punch < dubTo) { punch += this.punchStep; if (punch > 1) punch = 1; } else if (punch > dubTo) { punch -= this.punchStep; if (punch < 0) punch = 0; }
        if (this.bounceT === t) {
          // Written in order, one sample per sample, from where the pass
          // began; the last `seam` samples crossfade into the first ones, so
          // the new loop wraps without a click — and what's heard fades the
          // same way, so the swap carries straight on.
          if (this.bounceCount === 0) this.bounceW0 = Math.floor(mod(posF, len) * this.bounceRatio) % this.bounceLen;
          const w = (this.bounceW0 + this.bounceCount) % this.bounceLen, sb = this.spare * cap + w;
          const vL = l + punch * live, vR = r + punch * liveR, over = this.bounceCount - this.bounceLen;
          if (over < 0) { this.L[sb] = vL; this.R[sb] = vR; }
          else {
            const wgt = over / this.bounceSeam, startL = this.L[sb], startR = this.R[sb];
            this.L[sb] = (1 - wgt) * vL + wgt * startL; this.R[sb] = (1 - wgt) * vR + wgt * startR;
            l = (1 - wgt) * l + wgt * startL; r = (1 - wgt) * r + wgt * startR; // (the start already holds that pass's dub: heard once, as before)
          }
          if (++this.bounceCount >= this.bounceLen + this.bounceSeam) { this.finishBounce(t, at, w); len = this.length[t]; base = this.slot[t] * cap; }
        } else if (punch > 0) {
          // Each tape sample gets the dub once: at its own speed that's k; in
          // a punch-out mid-glide the playhead may repeat a sample (skipped)
          // or step over one (filled too).
          const last = this.dubAt[t];
          if (rate === 1 || last < 0) { this.L[k] += punch * live; this.R[k] += punch * liveR; }
          else if (pk !== last) {
            for (let q = last + 1, n2 = 0; n2 < 8; q++, n2++) {
              if (q >= len) q -= len;
              this.L[base + q] += punch * live; this.R[base + q] += punch * liveR;
              if (q === pk) break;
            }
          }
          this.dubAt[t] = pk;
        } else this.dubAt[t] = -1;
        if (g > 0) {
          tapeL[i] += l * g * f;
          tapeR[i] += r * g * f;
          audible = true;
        }
      }
      this.faderNow[t] = f; // (kept through an erase: the fader stays where the hand left it)
      if (this.state[t] === EMPTY) continue; // erased: erase() has reset it
      this.gain[t] = g;
      this.punch[t] = punch;
      this.tailGain[t] = tg;
      audible = true; // the mix stays the same while a tape is loaded
    }
    // Keep the newest input for the next take's seam (the live sound, before
    // any tape is mixed in below).
    for (let i = n > seam ? n - seam : 0; i < n; i++) {
      this.preL[this.preAt] = outL[off + i]; this.preR[this.preAt] = outR[off + i];
      this.preAt = this.preAt + 1 === seam ? 0 : this.preAt + 1;
    }
    // Mix: live + tapes, summed as they are. Layers add up past full scale;
    // the limiter at the end of the chain (limiter.js) turns the whole mix
    // down rather than clipping it.
    if (audible) {
      const target = this.tapeLevel * TAPE_MIX_GAIN, a = this.levelGlide;
      let lv = this.level;
      for (let i = 0; i < n; i++) {
        lv += a * (target - lv);
        if (lv - target < 1e-9 && target - lv < 1e-9) lv = target; // exact, never subnormal
        outL[off + i] = finite(outL[off + i] + lv * tapeL[i]);
        outR[off + i] = finite(outR[off + i] + lv * tapeR[i]);
        tapeL[i] = tapeR[i] = 0;
      }
      this.level = lv;
    } else {
      this.level = this.tapeLevel * TAPE_MIX_GAIN;
    }
    this.audible = audible;
  }

  // ---- internals ----------------------------------------------------------------

  // One beat of the shared grid, in samples.
  beat() {
    return (60 * this.fs) / this.grid.bpm;
  }

  startTake(t, now) {
    const fs = this.fs;
    let start = now;
    this.onGrid[t] = 0;
    if (this.grid) {
      // On the shared grid: the loop's position 0 is the beat at or before
      // now (the gesture looper's grid, started now if there isn't one — the
      // first take sets the downbeat).
      const g = this.grid;
      // (The step at or just before now, so the take starts on it, not a
      // beat earlier.)
      if (g.transportOrigin < 0) g.transportOrigin = Math.floor((now * SIM_RATE) / fs);
      const beat = this.beat(), origin = (g.transportOrigin * fs) / SIM_RATE;
      start = Math.floor(origin + Math.floor((now - origin) / beat) * beat);
      if (start > now) start = now;
      this.onGrid[t] = 1;
      // Finish by itself on the last beat that fits.
      this.deadline[t] = start + Math.max(1, Math.floor(this.capacity / beat)) * beat;
      if (this.deadline[t] > start + this.capacity) this.deadline[t] = start + this.capacity;
      this.deadline[t] = Math.floor(this.deadline[t]);
    } else {
      this.deadline[t] = start + this.capacity;
    }
    this.origin[t] = start;
    this.takeStart[t] = now;
    this.takeEnd[t] = -1;
    this.length[t] = 0;
    this.muted[t] = 0;
    this.stopping[t] = 0;
    this.gain[t] = 0;
    this.punch[t] = 0;
    this.startAt[t] = 0;
    // Silence before the take (from the beat) — cleared lazily, see
    // gapEnd — and the sound just before it.
    this.gapEnd[t] = Math.round(now - start);
    this.tailGain[t] = 0;
    for (let j = 0; j < this.seam; j++) {
      const src = (this.preAt + j) % this.seam;
      this.takePreL[t * this.seam + j] = this.preL[src];
      this.takePreR[t * this.seam + j] = this.preR[src];
    }
    this.takePreAt[t] = 0;
    this.state[t] = RECORDING;
  }

  // Ask a take to finish: now, or — on the grid — on the beat nearest now:
  // a little late (your hand on its way to the key), and the take ends on
  // the beat just gone, so the reach isn't heard as a gap every pass; a
  // little early, it records on to the coming beat. At least one beat.
  finishTake(t, now) {
    if (this.takeEnd[t] >= 0) return; // already finishing
    let end = now;
    if (this.onGrid[t]) {
      const beat = this.beat();
      let beats = Math.max(1, Math.round((now - this.origin[t]) / beat));
      // Rounded back so far that almost nothing of the take is left (begun
      // just before a beat): record on to the next beat instead.
      if (this.origin[t] + beats * beat - this.takeStart[t] < this.minTake) beats++;
      end = Math.min(this.deadline[t], Math.floor(this.origin[t] + beats * beat));
    }
    this.takeEnd[t] = end;
  }

  // The take is over: it ends at sample `end` — which can be behind `at`,
  // the sample now (a finish rounded back to the beat just gone; what was
  // recorded since is left out). Seal the seam and start playing: the loop
  // carries on from wherever `at` falls in it.
  endTake(t, end, at = end) {
    const len = Math.round(end - this.origin[t]);
    if (end - this.takeStart[t] < this.minTake || len <= 0) { this.erase(t); return; }
    this.length[t] = len;
    const base = this.slot[t] * this.capacity, X = Math.min(this.seam, Math.floor(len / 2));
    const gap = this.takeStart[t] > this.origin[t];
    if (gap) {
      // Silence follows the end around the loop: fade the end out.
      for (let j = 0; j < X; j++) {
        const k = base + len - X + j, w = 1 - (j + 1) / X;
        this.L[k] *= w; this.R[k] *= w;
      }
    }
    // The sound from just before the take leads into its first sample, so
    // the loop wraps without a click (a fade-in when silence comes before).
    const head = Math.round(this.takeStart[t] - this.origin[t]);
    // The blend goes into the last X samples of the gap: make them real
    // silence first and keep them out of the lazily-cleared part.
    const from = head - X > 0 ? head - X : 0;
    for (let k = from; k < head; k++) { this.L[base + k] = 0; this.R[base + k] = 0; }
    if (this.gapEnd[t] > from) this.gapEnd[t] = from;
    for (let j = 0; j < X; j++) {
      const k = base + mod(head - X + j, len), w = (j + 1) / X, pj = t * this.seam + (this.takePreAt[t] + this.seam - X + j) % this.seam;
      this.L[k] = this.L[k] * (1 - w) + this.takePreL[pj] * w;
      this.R[k] = this.R[k] * (1 - w) + this.takePreR[pj] * w;
    }
    this.startAt[t] = 0;
    this.gain[t] = 0;
    this.gapWait[t] = mod(at - this.origin[t], len) !== 0 ? 1 : 0; // playing on from mid-loop
    // It follows the tempo from here, as recorded at this one.
    this.recBpm[t] = this.onGrid[t] && this.grid ? this.tempoAt(end) : 0;
    this.delta[t] = 0;
    this.seedGrains(t, at - this.origin[t], at);
    this.state[t] = PLAYING;
  }

  // Where a new grain should start: near `nominal`, within ±hop/2, where the
  // tape best matches what the fading grain plays next (from `ref`): the
  // largest correlation over a short window, both at a stride of 2. Bounded:
  // (hop/2 + 1) × (hop/4) multiplies, once a grain.
  alignGrain(base, len, nominal, ref) {
    const S = this.hop >> 1, W = this.hop >> 1, L = this.L, R = this.R, ref2 = this.alignRef;
    const dec = this.alignDec, pt = 8 * dec; // strides in 48 kHz terms, so the cost is the same at any rate
    const r0 = mod(Math.floor(ref), len), n0 = mod(Math.floor(nominal), len);
    // What the fading grain plays next, once.
    let points = 0;
    for (let j = 0; j < W; j += pt) { let b = r0 + j; if (b >= len) b -= len; ref2[points++] = L[base + b] + R[base + b]; }
    // Coarse (every 4), from the nominal place outwards — a tie (silence)
    // keeps it — then fine (every 1) around the best.
    let best = this.alignScan(base, len, n0, 0, S, 4 * dec, points, pt, 0);
    best = this.alignScan(base, len, n0, best, 3 * dec, dec, points, pt, best);
    return n0 + best; // a whole sample: every grain reads its samples as recorded
  }

  // The best lag in [centre − span, centre + span] at `stride`, nominal first.
  alignScan(base, len, n0, centre, span, stride, points, pt, start) {
    const L = this.L, R = this.R, ref2 = this.alignRef;
    let best = start, bestScore = -Infinity;
    const steps = Math.floor(span / stride);
    for (let i = 0; i <= 2 * steps; i++) {
      const d = centre + (i === 0 ? 0 : i % 2 ? ((i + 1) >> 1) * stride : -(i >> 1) * stride);
      let score = 0, a = n0 + d;
      a = a % len; if (a < 0) a += len;
      for (let q = 0; q < points; q++) {
        score += (L[base + a] + R[base + a]) * ref2[q];
        a += pt; if (a >= len) a -= len;
      }
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }


  // Grains as if the tape had been playing at its own speed up to `at`, where
  // the playhead is at `pos` (so the first stretched samples read the right place).
  seedGrains(t, pos, at) {
    const x = (at + t * (this.hop >> 2)) % this.hop;
    this.grainA[t] = pos - x;
    this.grainB[t] = pos - x - this.hop;
  }

  // The tempo in force at stream sample `at` (the grid's, step by step).
  tempoAt(at) {
    return this.grid.bpmAt(Math.floor((at * SIM_RATE) / this.fs));
  }

  // How long track t would be re-recorded at the tempo at `at` (0: no need —
  // it's at its own tempo, or doesn't follow one).
  bounceLength(t, at) {
    const rec = this.recBpm[t];
    if (!(rec > 0) || !this.grid) return 0;
    const bpm = this.tempoAt(at);
    if (Math.abs(bpm / rec - 1) < RATE_EPS) return 0; // at its own tempo: overdub as it is
    const beats = Math.max(1, Math.round((this.length[t] * rec) / (60 * this.fs)));
    return Math.round((beats * 60 * this.fs) / bpm);
  }

  // Whether an overdub on track t can start at `at`: no re-recording needed,
  // or one that fits the tape and finds the spare free.
  canBounce(t, at) {
    const n = this.bounceLength(t, at);
    if (n === 0) return true;
    const g = this.grid; // not mid-glide: the pass is written at one tempo
    return n <= this.capacity && (this.bounceT < 0 || this.bounceT === t) && g.bpm === g.bpmTarget && Math.abs(this.tempoAt(at) / g.bpm - 1) <= RATE_EPS;
  }

  // An overdub on a tape at another tempo than it was recorded at: re-record
  // the track for one pass at this tempo (see processChunk). Call after
  // canBounce.
  startBounce(t, at) {
    const n = this.bounceLength(t, at);
    if (n === 0 || n > this.capacity) return;
    const bpm = this.tempoAt(at);
    this.bounceT = t;
    this.bounceRatio = this.recBpm[t] / bpm; // new samples per old
    this.bounceBpm = bpm;
    this.bounceLen = n;
    this.bounceSeam = Math.min(this.seam, n >> 1);
    this.bounceCount = 0;
  }

  // The pass is written: the spare becomes the track (recorded at this tempo),
  // and its playhead carries on from where the pass got to (w, at stream
  // sample `at`).
  finishBounce(t, at, w) {
    const old = this.slot[t];
    this.slot[t] = this.spare;
    this.spare = old;
    this.length[t] = this.bounceLen;
    this.recBpm[t] = this.bounceBpm;
    this.origin[t] = at - w; // next sample: w + 1
    this.delta[t] = 0;
    this.gapEnd[t] = 0;
    this.gapWait[t] = 0;
    this.seedGrains(t, w, at);
    this.bounceT = -1;
  }

  // Play a stopped tape from its top: now, or on the next beat if it's
  // on the grid.
  restart(t, now) {
    let start = now;
    const g = this.grid;
    if (this.onGrid[t] && g && g.transportOrigin >= 0) {
      const fs = this.fs, beat = this.beat(), origin = (g.transportOrigin * fs) / SIM_RATE;
      start = Math.floor(origin + Math.ceil((now - origin) / beat - 1e-9) * beat);
      if (start < now) start = now;
    }
    // A tail is still fading and the tape is sounding too (stop and play
    // tapped quickly): don't start over — that would cut one of them. Cancel
    // the stop and carry on where it is.
    if (this.tailGain[t] > 0 && this.gain[t] > 0) {
      this.stopping[t] = 0;
      this.state[t] = PLAYING;
      return;
    }
    // Still sounding (stopping, or playing): that sound fades out where it
    // is while the tape starts again from the top.
    if (this.gain[t] > 0 && this.length[t] > 0) {
      this.tailOrigin[t] = this.origin[t];
      this.tailDelta[t] = this.delta[t];
      this.tailGain[t] = this.gain[t];
    }
    if (this.bounceT === t) this.bounceT = -1; // a restart leaves the re-recording unfinished: dropped
    this.gain[t] = 0;
    this.origin[t] = start;
    this.delta[t] = 0;
    this.seedGrains(t, 0, start);
    this.startAt[t] = start;
    this.stopping[t] = 0;
    this.state[t] = PLAYING;
  }

  clear(t) {
    if (this.state[t] === RECORDING) { this.erase(t); return; } // nothing playing yet
    this.clearing[t] = 1;
    if (this.state[t] === OVERDUB) this.state[t] = PLAYING;
  }

  erase(t) {
    const held = this.onGrid[t] && this.state[t] !== EMPTY;
    this.state[t] = EMPTY;
    this.primed[t] = 0;
    this.onGrid[t] = 0;
    // The last tape off the grid frees it, if no loop is on it either.
    if (held && this.grid && this.grid.releaseGrid) this.grid.releaseGrid();
    this.length[t] = 0;
    this.muted[t] = 0;
    this.clearing[t] = 0;
    this.stopping[t] = 0;
    this.gain[t] = 0;
    this.punch[t] = 0;
    this.tailGain[t] = 0;
    this.gapEnd[t] = 0;
    this.gapWait[t] = 0;
    this.startAt[t] = 0;
    this.recBpm[t] = 0;
    this.delta[t] = 0;
    this.tailDelta[t] = 0;
    if (this.bounceT === t) this.bounceT = -1;
  }

  // Track status for the page (see visuals.js TAPE_FIELDS).
  writeStatus(frame, offset) {
    for (let t = 0; t < TAPE_TRACKS; t++) {
      const o = offset + t * 6, s = this.state[t], fs = this.fs;
      frame[o] = s;
      frame[o + 1] = this.muted[t];
      // Seconds at the tempo now (a tape following the tempo runs longer or shorter).
      const rate = this.recBpm[t] > 0 && this.grid ? this.grid.bpm / this.recBpm[t] : 1;
      frame[o + 2] = (s === RECORDING ? this.now - this.origin[t] : this.length[t] / rate) / fs;
      frame[o + 3] = (s === PLAYING || s === OVERDUB) && this.length[t] > 0 && this.now >= this.startAt[t]
        ? mod(this.now - this.origin[t] + this.delta[t], this.length[t]) / rate / fs : 0;
      // Waiting: 2 primed (for a stone to ring), 1 for a beat, 0 not.
      frame[o + 4] = this.primed[t] ? 2 : this.now < this.startAt[t] || (s === RECORDING && this.takeEnd[t] >= 0) ? 1 : 0;
      frame[o + 5] = this.clearing[t] ? 2 : this.stopping[t] ? 1 : 0; // fading out: 1 stopping, 2 clearing
    }
  }
}

function finite(x) {
  return x === x && x - x === 0 ? x : 0;
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}
