// instrument.js — the whole instrument for one audio stream: the water and
// its stones (engine.js) ringing one bell per stone (bells.js), plus the
// handling of events from the page. The AudioWorklet and the Node checks both
// use this, so what's tested is what plays. No allocation after construction.

import { Engine, ENGINE_PARAMS, ENGINE_PARAM_KEYS } from './engine.js';
import { Bells, BELL_PARAMS } from './bells.js';
import { MAX_STONES } from './stones.js';
import { EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT } from './ring.js';
import { FRAME_FLASH, FRAME_HEIGHTS, frameLength } from './visuals.js';

// Every knob, in the order the page sends parameter indices.
export const PARAMS = { ...ENGINE_PARAMS, ...BELL_PARAMS };
export const PARAM_KEYS = Object.keys(PARAMS);

export class Instrument {
  constructor({ sampleRate = 48000, seed = 1 } = {}) {
    this.engine = new Engine({ sampleRate, seed });
    this.bells = new Bells({ sampleRate });
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
    this.outputPeak = 0;
    this.frameEnergy = 0;
  }

  setParamIndex(i, value) {
    if (!Number.isInteger(i) || i < 0 || i >= PARAM_KEYS.length) return;
    if (i < ENGINE_PARAM_KEYS.length) this.engine.setParamIndex(i, value);
    else this.bells.setParam(PARAM_KEYS[i], value);
  }

  setParam(name, value) {
    const i = PARAM_KEYS.indexOf(name);
    if (i >= 0) this.setParamIndex(i, value);
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
      case EV_DROP: e.drop(d[o + 1], d[o + 2], d[o + 3]); break;
      case EV_STROKE: e.trail(d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5]); break;
      case EV_PARAM: this.setParamIndex(d[o + 1], d[o + 2]); break;
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

  // Render n samples into outL / outR.
  process(outL, outR, n) {
    for (let i = 0; i < n; i++) outL[i] = outR[i] = 0;
    const e = this.engine;
    this.bells.applyPending();
    e.process(n);
    const st = e.strikes, stones = e.stones, bells = this.bells;
    // Strikes come in time order. Render the bells up to each strike's sample,
    // then strike, so every bell starts exactly on its sample.
    let pos = 0;
    for (let i = 0; i < st.count; i++) {
      const at = e.strikeSample(i);
      if (at > pos) { bells.renderRange(outL, outR, pos, at); pos = at; }
      const k = st.stone[i];
      if (bells.strike(k, stones.hz[k], st.velocity[i], stones.x[k], at) && st.velocity[i] > this.flash[k]) {
        this.flash[k] = st.velocity[i];
      }
    }
    bells.renderRange(outL, outR, pos, n);
    bells.endBlock(outL, outR, n);
    let p = this.outputPeak;
    for (let i = 0; i < n; i++) {
      const a = outL[i] < 0 ? -outL[i] : outL[i], b = outR[i] < 0 ? -outR[i] : outR[i];
      if (a > p) p = a;
      if (b > p) p = b;
    }
    this.outputPeak = p;
  }
}
