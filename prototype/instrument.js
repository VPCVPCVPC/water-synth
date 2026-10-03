// instrument.js — the whole instrument for one audio stream: the water and
// its stones (engine.js) ringing one voice per stone (bells.js, voice.js),
// plus the handling of events from the page. The AudioWorklet and the Node checks both
// use this, so what's tested is what plays. No allocation after construction.

import { Engine, ENGINE_PARAMS, ENGINE_PARAM_KEYS } from './engine.js';
import { Bells, BELL_PARAMS } from './bells.js';
import { MAX_STONES, StrikeBuffer } from './stones.js';
import { VOICE_PARAMS, VOICE_KEYS, SHARED } from './voice.js';
import {
  EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT, EV_LOOP, EV_STONE_MOVE, EV_VOICE, EV_VOICE_OVERRIDE, EV_STILL,
  EV_TAPE, EV_STONE_TUNE, EV_TAPE_FADER,
} from './ring.js';
import { GestureLooper, LOOPER_PARAMS, GESTURE_DROP, GESTURE_TRAIL } from './looper.js';
import { TapeDeck, TAPE_PARAMS } from './tape.js';
import { SIM_RATE } from './surface.js';
import { FRAME_FLASH, FRAME_LOOPS, FRAME_TAPES, FRAME_BEAT, FRAME_HEIGHTS, frameLength } from './visuals.js';

// Every instrument-wide knob, in the order the page sends parameter indices.
// Voice parameters travel separately (EV_VOICE), by index into VOICE_KEYS.
export const PARAMS = { ...ENGINE_PARAMS, ...BELL_PARAMS, ...LOOPER_PARAMS, ...TAPE_PARAMS };
export { VOICE_PARAMS, VOICE_KEYS, SHARED };
// Water-held sustain follows the water every few simulation steps. Each such
// tick ends an audio segment, and every stone can ring once per simulation
// step, so a segment's strike list holds HOLD_STEPS × MAX_STONES of them.
const HOLD_STEPS = 4;
// A note this close after a grid point already counts as on it (rings now).
const ON_BEAT_SECONDS = 0.012;
const SEGMENT_STRIKES = HOLD_STEPS * MAX_STONES;
const BELL_KEYS_END = Object.keys(ENGINE_PARAMS).length + Object.keys(BELL_PARAMS).length;
const LOOPER_KEYS_END = BELL_KEYS_END + Object.keys(LOOPER_PARAMS).length;
export const PARAM_KEYS = Object.keys(PARAMS);

export class Instrument {
  constructor({ sampleRate = 48000, seed = 1 } = {}) {
    this.engine = new Engine({ sampleRate, seed });
    this.bells = new Bells({ sampleRate });
    this.looper = new GestureLooper();
    this.engine.stepListener = this.looper;
    // The tapes share the gesture looper's bar grid when quantize is on.
    this.tape = new TapeDeck({ sampleRate, grid: this.looper });
    this.looper.gridUser = this.tape;
    this.fs = sampleRate;
    // Stones arrive one event at a time and go live together on commit, so a
    // half-delivered retune never sounds. A commit only applies if every
    // stone it covers was written since the last one.
    this.stagedX = new Float64Array(MAX_STONES);
    this.stagedY = new Float64Array(MAX_STONES);
    this.stagedHz = new Float64Array(MAX_STONES);
    this.stagedWritten = new Uint8Array(MAX_STONES);
    this.rejectedCommits = 0; // diagnostics
    // Loudest audible strike per stone since the visuals last read it.
    this.flash = new Float32Array(MAX_STONES);
    // Every strike of the last process() call (the engine's own list holds
    // only the last segment's); step / SIM_RATE is its stream time.
    // Note quantize: struck stones held for the grid, in time order (stream
    // sample to ring at). Fixed capacity; if it's ever full a note rings now.
    this.heldCap = 16 * MAX_STONES; // the busiest pond at 90% on the coarsest grid peaks near 8 × MAX_STONES
    this.heldAt = new Float64Array(this.heldCap);
    this.heldStone = new Int32Array(this.heldCap);
    this.heldVel = new Float64Array(this.heldCap);
    this.heldCount = 0;
    this.heldOverflow = 0; // diagnostics
    // When each stone last rang on a grid point (stream sample; −∞ none): a
    // hit just after it, within the on-beat window, is the same note.
    this.gridRang = new Float64Array(MAX_STONES).fill(-Infinity);
    this.onBeat = Math.round(ON_BEAT_SECONDS * sampleRate);
    this.strikes = new StrikeBuffer(SEGMENT_STRIKES);
    this.outputPeak = 0;
    this.frameEnergy = 0;
    this.segmentGuards = 0; // diagnostics: a segment that would not have advanced
  }

  setParamIndex(i, value) {
    if (!Number.isInteger(i) || i < 0 || i >= PARAM_KEYS.length) return;
    if (i < ENGINE_PARAM_KEYS.length) this.engine.setParamIndex(i, value);
    else if (i < BELL_KEYS_END) this.bells.setParam(PARAM_KEYS[i], value);
    else if (i < LOOPER_KEYS_END) this.looper.setParam(PARAM_KEYS[i], value);
    else this.tape.setParam(PARAM_KEYS[i], value);
  }

  // An instrument knob, or a voice parameter by name (sets the shared voice).
  setParam(name, value) {
    const i = PARAM_KEYS.indexOf(name);
    if (i >= 0) this.setParamIndex(i, value);
    else this.bells.setParam(name, value);
  }

  setStones(xs, ys, hzs, count) {
    this.engine.setStones(xs, ys, hzs, count);
    this.bells.setStoneCount(this.engine.stones.count);
  }

  // Fill a visuals frame (see visuals.js) and reset the per-frame readings.
  // Call prepareFrame() first, outside the seqlock's write window (energy() is
  // the slow part), then writeFrame() between begin() and end().
  prepareFrame() {
    this.frameEnergy = this.engine.surface.asleep ? 0 : this.engine.surface.energy();
  }

  writeFrame(frame) {
    frame[0] = this.frameEnergy;
    frame[1] = this.outputPeak;
    for (let i = 0; i < MAX_STONES; i++) { frame[FRAME_FLASH + i] = this.flash[i]; this.flash[i] = 0; }
    this.looper.writeStatus(frame, FRAME_LOOPS);
    this.tape.writeStatus(frame, FRAME_TAPES);
    frame[FRAME_BEAT] = this.looper.beatPosition();
    this.engine.surface.snapshot(frame, FRAME_HEIGHTS);
    this.outputPeak = 0;
  }

  // Floats in a visuals frame for this instrument's water.
  frameSize() {
    return frameLength(this.engine.surface.w * this.engine.surface.h);
  }

  // One event from the page's queue (ring.js layout: d[o] is the type).
  handleEvent(d, o) {
    const e = this.engine;
    switch (d[o]) {
      // Live gestures — from any source — land at the next step and are
      // recorded by any looper layer that's listening.
      // With quantize on, a touch (a drop) can be held back toward the next
      // grid point; a drag's trail is never delayed, so stirring stays fluid.
      case EV_DROP: {
        const now = e.simStep + 1, at = this.looper.liveStep(now);
        // Held only while the gesture queue has room to spare; otherwise it
        // lands now, and its copy keeps the time it was heard.
        const held = at > now && e.canHold() && at - now < this.looper.holdLimit();
        const landed = held ? e.drop(d[o + 1], d[o + 2], d[o + 3], at / SIM_RATE) : e.drop(d[o + 1], d[o + 2], d[o + 3]);
        // Recorded as sent — quantize moves the copy to the same place `at`
        // is — and only if it went into the water at all.
        if (landed) this.looper.record(GESTURE_DROP, d[o + 1], d[o + 2], 0, 0, d[o + 3], now, at > now && !held);
        break;
      }
      case EV_STROKE:
        e.trail(d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5]);
        this.looper.record(GESTURE_TRAIL, d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], e.simStep + 1);
        break;
      case EV_LOOP: this.looper.action(d[o + 1], d[o + 2]); break;
      case EV_STONE_MOVE: e.stones.moveStone(e.surface, d[o + 1], d[o + 2], d[o + 3]); break;
      case EV_STONE_TUNE: e.stones.setPitch(e.surface, d[o + 1], d[o + 2]); break;
      case EV_STILL: e.still(d[o + 1], d[o + 2], d[o + 3], d[o + 4]); break; // not recorded: the tape hears what it does
      case EV_PARAM: this.setParamIndex(d[o + 1], d[o + 2]); break;
      case EV_VOICE: this.bells.voices.set(d[o + 1], d[o + 2], d[o + 3]); break;
      case EV_VOICE_OVERRIDE: this.bells.voices.override(d[o + 1], d[o + 2] === 1); break;
      case EV_TAPE: this.tape.action(d[o + 1], d[o + 2]); break;
      case EV_TAPE_FADER: this.tape.setFader(d[o + 1], d[o + 2]); break;
      case EV_STONE: {
        const i = d[o + 1];
        if (Number.isInteger(i) && i >= 0 && i < MAX_STONES) {
          this.stagedX[i] = d[o + 2]; this.stagedY[i] = d[o + 3]; this.stagedHz[i] = d[o + 4];
          this.stagedWritten[i] = 1;
        }
        break;
      }
      case EV_STONES_COMMIT: {
        const n = d[o + 1];
        let complete = Number.isInteger(n) && n >= 0 && n <= MAX_STONES;
        for (let i = 0; complete && i < n; i++) if (!this.stagedWritten[i]) complete = false;
        if (complete) this.setStones(this.stagedX, this.stagedY, this.stagedHz, n);
        else this.rejectedCommits++;
        this.stagedWritten.fill(0);
        break;
      }
    }
  }

  // ---- note quantize --------------------------------------------------------------

  // When a stone struck at stream sample t is heard: t, or — with quantize
  // on — leaning toward the next grid point by the strength (never earlier;
  // a note within ON_BEAT_SECONDS after a grid point is already on it).
  noteTarget(t) {
    const lp = this.looper;
    if (!lp.quantize || !(lp.quantizeStrength > 0) || lp.transportOrigin < 0) return t;
    const fs = this.fs, g = (60 * fs) / (lp.bpm * lp.grid), x = (t - (lp.transportOrigin * fs) / SIM_RATE) / g;
    let prev = -Infinity, next = Infinity;
    for (let k = Math.floor(x) - 1, last = k + 3; k <= last; k++) { // swing moves a point by < 1 grid step
      const p = k + ((((k % 2) + 2) % 2) === 1 ? lp.swing : 0);
      if (p <= x && p > prev) prev = p;
      if (p >= x && p < next) next = p;
    }
    if ((x - prev) * g <= this.onBeat || !(next < Infinity)) return t;
    return t + Math.round(lp.quantizeStrength * (next - x) * g);
  }

  // Hold a note to ring at stream sample `at`; false if the queue is full.
  // A stone already waiting for that same moment is struck once, as hard as
  // the harder of the two (one note per stone per grid point).
  hold(at, stone, velocity) {
    for (let j = this.heldCount - 1; j >= 0 && this.heldAt[j] >= at; j--) {
      if (this.heldAt[j] === at && this.heldStone[j] === stone) {
        if (velocity > this.heldVel[j]) this.heldVel[j] = velocity;
        return true;
      }
    }
    let i = this.heldCount;
    if (i >= this.heldCap) { this.heldOverflow++; return false; }
    while (i > 0 && this.heldAt[i - 1] > at) { // keep time order (later of equal times after)
      this.heldAt[i] = this.heldAt[i - 1]; this.heldStone[i] = this.heldStone[i - 1]; this.heldVel[i] = this.heldVel[i - 1];
      i--;
    }
    this.heldAt[i] = at; this.heldStone[i] = stone; this.heldVel[i] = velocity;
    this.heldCount++;
    return true;
  }

  // Ring the held notes due before block sample `until` (or at it, with
  // `inclusive`), rendering up to each. Returns the new render position.
  ringHeld(outL, outR, pos, until, blockStream, inclusive) {
    let n = 0;
    while (n < this.heldCount) {
      const at = this.heldAt[n] - blockStream;
      if (inclusive ? at > until : at >= until) break;
      const t = at > pos ? at : pos;
      if (t > pos) { this.bells.renderRange(outL, outR, pos, t); pos = t; }
      this.ring(this.heldStone[n], this.heldVel[n], t);
      this.gridRang[this.heldStone[n]] = blockStream + t;
      n++;
    }
    if (n > 0) {
      this.heldAt.copyWithin(0, n, this.heldCount);
      this.heldStone.copyWithin(0, n, this.heldCount);
      this.heldVel.copyWithin(0, n, this.heldCount);
      this.heldCount -= n;
    }
    return pos;
  }

  // A stone heard now, at block sample `at` (its pitch and place as they are
  // now). A stone a retune has since removed or disabled stays silent.
  ring(k, velocity, at) {
    const stones = this.engine.stones;
    if (!(k < stones.count) || !stones.enabled[k]) return;
    if (this.bells.strike(k, stones.hz[k], velocity, stones.x[k], at) && velocity > this.flash[k]) this.flash[k] = velocity;
  }

  // Render n samples into outL / outR.
  process(outL, outR, n) {
    for (let i = 0; i < n; i++) outL[i] = outR[i] = 0;
    if (!Number.isInteger(n) || n <= 0) return;
    const e = this.engine, stones = e.stones, bells = this.bells, tape = this.tape;
    const blockStream = e.sample; // stream sample of this block's first sample
    // The tapes run on the same stream position the water does, so their loop
    // positions never depend on how the stream is split into blocks.
    tape.now = e.sample;
    this.strikes.clear();
    bells.applyPending();
    this.looper.beginBlock();
    // The block goes in segments that end just after each hold tick (every
    // HOLD_STEPS simulation steps): the water and the stones run up to the
    // tick, the bells catch up, then water-held sustain follows the water.
    // Ticks fall on fixed stream samples, so the output never depends on
    // how the stream is split into blocks.
    let pos = 0;
    while (pos < n) {
      const tick = (Math.floor(e.simStep / HOLD_STEPS) + 1) * HOLD_STEPS;
      const tickAt = pos + e.stepSample(tick) - e.sample; // ≥ pos: that step hasn't run yet
      let end = tickAt + 1 < n ? tickAt + 1 : n;
      // The loop must always advance: a tick that lands at or behind `pos`
      // (a rounding edge, a step already taken) must not stall the audio.
      if (!(end > pos)) { end = n; this.segmentGuards++; }
      e.process(end - pos);
      const st = e.strikes, segment = pos;
      this.strikes.append(st);
      // Strikes come in time order. Render the bells up to each strike's
      // sample, then strike, so every bell starts exactly on its sample. With
      // quantize on, a strike may instead wait for the grid (held notes ring
      // in time order among the rest).
      for (let i = 0; i < st.count; i++) {
        const at = segment + e.strikeSample(i), k = st.stone[i];
        const target = this.noteTarget(blockStream + at) - blockStream;
        if (target > at && this.hold(blockStream + target, k, st.velocity[i])) continue;
        pos = this.ringHeld(outL, outR, pos, at, blockStream, true); // held notes due by now ring first
        if (blockStream + at - this.gridRang[k] <= this.onBeat) continue; // already rang on this grid point
        if (at > pos) { bells.renderRange(outL, outR, pos, at); pos = at; }
        this.ring(k, st.velocity[i], at);
      }
      pos = this.ringHeld(outL, outR, pos, end, blockStream, false);
      bells.renderRange(outL, outR, pos, end);
      pos = end;
      if (e.simStep >= tick) bells.updateHold(stones);
    }
    bells.endBlock(outL, outR, n);
    // The tapes record what the water just played (never another tape) and add
    // their own playback on top.
    tape.process(outL, outR, n);
    let p = this.outputPeak;
    for (let i = 0; i < n; i++) {
      const a = outL[i] < 0 ? -outL[i] : outL[i], b = outR[i] < 0 ? -outR[i] : outR[i];
      if (a > p) p = a;
      if (b > p) p = b;
    }
    this.outputPeak = p;
  }
}
