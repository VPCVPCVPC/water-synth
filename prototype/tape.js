// tape.js — the audio looper: "a tape beside the pond". Several tape tracks
// record the water's sound and play it back as fixed audio, like a loop
// pedal. The one part of the instrument that isn't the water: what a tape
// plays never changes, and it never disturbs the water.
//
// Each track records the instrument's live output — the water's sound, not
// other tapes (an overdub never captures any tape's playback, so nothing
// doubles pass after pass). The first take sets a track's length; overdub
// layers more on top, heard live once and replayed from the next pass.
// Tracks have their own lengths and drift against each other. With quantize
// on, a take starts on a beat of the shared grid (the gesture looper's) and
// finishing waits for the next beat, so every tape is a whole number of
// beats: tapes follow the beat, but their lengths differ (3, 5, 7 beats…),
// so the way they line up keeps changing.
//
// A tape always plays back exactly what it recorded: retuning the stones
// never touches it, so a bassline, a melody and harmonies can be laid in
// different tunings.
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
const KNEE = 0.9; // the tape mix's soft clip leaves everything below this alone
const MAX_BLOCK = 4096; // samples of mix scratch; a longer block is processed in parts
const LEVEL_GLIDE_SECONDS = 0.02; // the tape level knob glides, never steps

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
    this.L = new Float32Array(TAPE_TRACKS * this.capacity);
    this.R = new Float32Array(TAPE_TRACKS * this.capacity);
    this.seam = Math.max(1, Math.round(SEAM_SECONDS * fs));
    // The last `seam` samples of input, always kept, so a take can borrow the
    // sound from just before it began for its seam.
    this.preL = new Float32Array(this.seam); this.preR = new Float32Array(this.seam);
    this.preAt = 0;
    this.takePreL = new Float32Array(TAPE_TRACKS * this.seam);
    this.takePreR = new Float32Array(TAPE_TRACKS * this.seam);
    this.state = new Uint8Array(TAPE_TRACKS);
    this.muted = new Uint8Array(TAPE_TRACKS);
    this.clearing = new Uint8Array(TAPE_TRACKS); // fading out, then erased
    this.stopping = new Uint8Array(TAPE_TRACKS); // fading out, then stopped
    this.onGrid = new Uint8Array(TAPE_TRACKS);
    this.origin = new Float64Array(TAPE_TRACKS); // stream sample of the loop's position 0
    this.takeStart = new Float64Array(TAPE_TRACKS);
    this.takeEnd = new Float64Array(TAPE_TRACKS); // a finishing take stops recording here (−1: not yet set)
    this.deadline = new Float64Array(TAPE_TRACKS); // a take finishes by itself here
    this.length = new Int32Array(TAPE_TRACKS); // samples (0 while the first take runs)
    this.startAt = new Float64Array(TAPE_TRACKS); // a restarted tape waits until this sample
    this.gain = new Float64Array(TAPE_TRACKS); // the track's fade, 0..1
    this.punch = new Float64Array(TAPE_TRACKS); // overdub input gain, 0..1
    // A tape restarted while it was still fading out keeps fading from where
    // it was (its tail) while the restart begins: never a jump.
    this.tailOrigin = new Float64Array(TAPE_TRACKS);
    this.tailGain = new Float64Array(TAPE_TRACKS);
    // A quantized take begins after its beat; the gap before it is silence.
    // It isn't zeroed all at once (up to a beat of memory in one block): reads
    // below gapEnd count as silence, and the playhead clears it as it passes,
    // starting from the top, during the first pass.
    this.gapEnd = new Int32Array(TAPE_TRACKS);
    this.fadeOutStep = 1 / Math.max(1, Math.round(TAPE_FADE_SECONDS * fs));
    this.fadeInStep = 1 / Math.max(1, Math.round(FADE_IN_SECONDS * fs));
    this.punchStep = 1 / Math.max(1, Math.round(PUNCH_SECONDS * fs));
    this.minTake = Math.round(MIN_TAKE_SECONDS * fs);
    this.tapeLevel = TAPE_PARAMS.tapeLevel.def;
    this.level = this.tapeLevel; // the smoothed tape level
    this.levelGlide = 1 - Math.exp(-1 / (LEVEL_GLIDE_SECONDS * fs));
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

  // An action from the page, applied at the start of the next block.
  action(track, act) {
    if (act === TAPE_CLEAR_ALL) {
      for (let t = 0; t < TAPE_TRACKS; t++) if (this.state[t] !== EMPTY) this.clear(t);
      return;
    }
    if (!Number.isInteger(track) || track < 0 || track >= TAPE_TRACKS) return;
    if (this.clearing[track]) return; // on its way out
    const s = this.state[track], now = this.now;
    switch (act) {
      case TAPE_RECORD:
        if (s === EMPTY) this.startTake(track, now);
        else if (s === RECORDING) this.finishTake(track, now);
        else if (s === OVERDUB) this.state[track] = PLAYING;
        else if (s === STOPPED) { this.restart(track, now); this.state[track] = OVERDUB; }
        else if (s === PLAYING && !this.stopping[track]) this.state[track] = OVERDUB;
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
      if (s === EMPTY) continue;
      const base = t * cap;
      let len = this.length[t];
      let g = this.gain[t], punch = this.punch[t], tg = this.tailGain[t];
      for (let i = 0; i < n; i++) {
        const at = this.now + i;
        const live = outL[off + i], liveR = outR[off + i];
        if (this.state[t] === RECORDING) {
          // The first take: written straight in from the beat (or the
          // take's start) until it finishes. The sample the take ends on is
          // played back in this very block — no `break` — so the tape's output
          // never depends on where the stream is split into blocks.
          if (this.takeEnd[t] < 0 && at >= this.deadline[t]) this.finishTake(t, at);
          if (this.takeEnd[t] >= 0 && at >= this.takeEnd[t]) this.endTake(t, at);
          if (this.state[t] === RECORDING) {
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
          const kt = mod(at - this.tailOrigin[t], len), j = base + kt;
          tg -= this.fadeOutStep; if (tg < 0) tg = 0;
          if (kt >= gapEnd) { tapeL[i] += this.L[j] * tg; tapeR[i] += this.R[j] * tg; }
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
          if (this.stopping[t]) { this.stopping[t] = 0; this.state[t] = STOPPED; }
        }
        if (this.state[t] === STOPPED || waiting) continue;
        const pk = mod(at - this.origin[t], len), k = base + pk;
        if (pk < gapEnd) { this.L[k] = 0; this.R[k] = 0; } // the gap, cleared as the playhead passes
        else if (gapEnd > 0) this.gapEnd[t] = 0; // passed it from the top: all clear
        const l = this.L[k], r = this.R[k];
        // Overdub: the live sound goes on top (punched in and out over 10 ms),
        // read first, so this pass plays what was there and the next pass
        // plays both.
        const dub = this.state[t] === OVERDUB && !this.stopping[t] ? 1 : 0;
        if (punch < dub) { punch += this.punchStep; if (punch > 1) punch = 1; } else if (punch > dub) { punch -= this.punchStep; if (punch < 0) punch = 0; }
        if (punch > 0) { this.L[k] = l + punch * live; this.R[k] = r + punch * liveR; }
        if (g > 0) {
          tapeL[i] += l * g;
          tapeR[i] += r * g;
          audible = true;
        }
      }
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
    // Mix: live + tapes, through a soft knee only while a tape sounds (the
    // water alone is never touched).
    if (audible) {
      const target = this.tapeLevel, a = this.levelGlide;
      let lv = this.level;
      for (let i = 0; i < n; i++) {
        lv += a * (target - lv);
        if (lv - target < 1e-9 && target - lv < 1e-9) lv = target; // exact, never subnormal
        outL[off + i] = knee(outL[off + i] + lv * tapeL[i]);
        outR[off + i] = knee(outR[off + i] + lv * tapeR[i]);
        tapeL[i] = tapeR[i] = 0;
      }
      this.level = lv;
    } else {
      this.level = this.tapeLevel;
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
    if (this.grid && this.grid.quantize) {
      // On the shared grid: the loop's position 0 is the beat at or before
      // now (the gesture looper's grid, started now if there isn't one).
      const g = this.grid;
      if (g.transportOrigin < 0) g.transportOrigin = Math.floor((now * SIM_RATE) / fs) + 1;
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
    this.state[t] = RECORDING;
  }

  // Ask a take to finish: now, or on the next beat if it's on the grid.
  finishTake(t, now) {
    if (this.takeEnd[t] >= 0) return; // already finishing
    let end = now;
    if (this.onGrid[t]) {
      const g = this.grid, fs = this.fs;
      const beat = this.beat();
      const beats = Math.max(1, Math.ceil((now - this.origin[t]) / beat - 1e-9));
      end = Math.min(this.deadline[t], Math.floor(this.origin[t] + beats * beat));
    }
    this.takeEnd[t] = end;
  }

  // The take is over at sample `at`: seal the seam and start playing.
  endTake(t, at) {
    const len = Math.round(at - this.origin[t]);
    if (at - this.takeStart[t] < this.minTake || len <= 0) { this.erase(t); return; }
    this.length[t] = len;
    const base = t * this.capacity, X = Math.min(this.seam, Math.floor(len / 2));
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
      const k = base + mod(head - X + j, len), w = (j + 1) / X, pj = t * this.seam + this.seam - X + j;
      this.L[k] = this.L[k] * (1 - w) + this.takePreL[pj] * w;
      this.R[k] = this.R[k] * (1 - w) + this.takePreR[pj] * w;
    }
    this.startAt[t] = 0;
    this.gain[t] = 0;
    this.state[t] = PLAYING;
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
      this.tailGain[t] = this.gain[t];
    }
    this.gain[t] = 0;
    this.origin[t] = start;
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
    this.startAt[t] = 0;
  }

  // Track status for the page (see visuals.js TAPE_FIELDS).
  writeStatus(frame, offset) {
    for (let t = 0; t < TAPE_TRACKS; t++) {
      const o = offset + t * 6, s = this.state[t], fs = this.fs;
      frame[o] = s;
      frame[o + 1] = this.muted[t];
      frame[o + 2] = (s === RECORDING ? this.now - this.origin[t] : this.length[t]) / fs; // seconds
      frame[o + 3] = (s === PLAYING || s === OVERDUB) && this.length[t] > 0 && this.now >= this.startAt[t]
        ? mod(this.now - this.origin[t], this.length[t]) / fs : 0;
      frame[o + 4] = this.now < this.startAt[t] || (s === RECORDING && this.takeEnd[t] >= 0) ? 1 : 0; // waiting for a beat
      frame[o + 5] = this.clearing[t] ? 2 : this.stopping[t] ? 1 : 0; // fading out: 1 stopping, 2 clearing
    }
  }
}

function knee(x) {
  const a = x < 0 ? -x : x;
  if (!(a > KNEE)) return Number.isFinite(x) ? x : 0;
  if (!Number.isFinite(a)) return 0;
  const y = KNEE + (1 - KNEE) * Math.tanh((a - KNEE) / (1 - KNEE));
  return x < 0 ? -y : y;
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}
