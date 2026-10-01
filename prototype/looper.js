// looper.js — the gesture looper: records disturbances (drops and drags, with
// their timing), not notes, and replays them into the living water. Each pass
// lands in water still moving from the last, so no two passes are the same.
//
// Live gestures are recorded from any input source — a finger, a mouse, MIDI,
// a camera — as timed gesture events (Erosion can read the same events later).
// Loop playback is never re-recorded: an overdubbing layer must not capture
// its own (or another layer's) replay, or loops would double every pass.
//
// Time is counted in simulation steps (1 ms of water time), so loops are
// identical at any sample rate and block size. Several layers can run at
// once; loops of different lengths drift against each other.
//
// Quantize (optional, off by default) moves *when a recorded touch lands*
// toward a beat grid — strength from lean (default when on) to snap, plus
// swing — and rounds a new loop's length to whole bars. It never places notes:
// when stones ring is still the water's business. Live touches are never
// delayed; only their recorded copies are quantized.
//
// Fixed capacity, allocated up front. onStep() and record() allocate nothing.

import { SIM_RATE } from './surface.js';

export const LOOP_LAYERS = 4;
export const LOOP_EVENTS = 4096; // per layer
export const MAX_LOOP_SECONDS = 60;
const MAX_BAR_STEPS = (4 * 60 * SIM_RATE) / 40; // the longest bar (40 bpm)
const MAX_LOOP_STEPS = Math.ceil(MAX_LOOP_SECONDS * SIM_RATE + MAX_BAR_STEPS); // after rounding to bars
const RECORD_BUDGET = 32; // live gestures recorded per audio block, at most (bursts can't stall)
export const GESTURE_DROP = 1, GESTURE_TRAIL = 2;

// Layer states.
export const EMPTY = 0, RECORDING = 1, PLAYING = 2, OVERDUB = 3, STOPPED = 4;
// Actions the page sends.
export const LOOP_RECORD = 1, LOOP_PLAY_STOP = 2, LOOP_MUTE = 3, LOOP_CLEAR = 4;

export const LOOPER_PARAMS = {
  quantize: { min: 0, max: 1, def: 0 }, // 0 off, 1 on
  bpm: { min: 40, max: 240, def: 90 },
  grid: { min: 1, max: 8, def: 2 }, // subdivisions per beat (2 = eighths, 4 = sixteenths, 3 = triplets)
  quantizeStrength: { min: 0, max: 1, def: 0.5 }, // 0 = as played, 1 = snapped
  swing: { min: 0, max: 0.5, def: 0 }, // fraction of a grid step that every second step is pushed late
};

const BEATS_PER_BAR = 4;

export class GestureLooper {
  constructor() {
    const n = LOOP_LAYERS * LOOP_EVENTS;
    this.time = new Float64Array(n); // step within the loop
    this.kind = new Uint8Array(n);
    this.skip = new Uint8Array(n); // overdubbed this pass: first plays on the next pass
    this.p = new Float32Array(n * 5); // x0, y0, x1, y1, strength (or speed)
    this.count = new Int32Array(LOOP_LAYERS);
    this.state = new Uint8Array(LOOP_LAYERS);
    this.muted = new Uint8Array(LOOP_LAYERS);
    this.origin = new Float64Array(LOOP_LAYERS); // step at which loop position 0 falls
    this.takeStart = new Float64Array(LOOP_LAYERS); // step the first take began
    this.length = new Float64Array(LOOP_LAYERS); // steps (0 while the first take runs)
    this.cursor = new Int32Array(LOOP_LAYERS); // next event to play
    this.lastPos = new Float64Array(LOOP_LAYERS);
    this.scratchTime = new Float64Array(LOOP_EVENTS);
    this.scratchKind = new Uint8Array(LOOP_EVENTS);
    this.scratchSkip = new Uint8Array(LOOP_EVENTS);
    this.histogram = new Int32Array(MAX_LOOP_STEPS + 1); // counting sort over loop positions
    this.recordBudget = RECORD_BUDGET;
    this.scratchP = new Float32Array(LOOP_EVENTS * 5);
    this.transportOrigin = -1; // shared bar grid, set by the first quantized take
    this.quantize = LOOPER_PARAMS.quantize.def;
    this.bpm = LOOPER_PARAMS.bpm.def;
    this.grid = LOOPER_PARAMS.grid.def;
    this.quantizeStrength = LOOPER_PARAMS.quantizeStrength.def;
    this.swing = LOOPER_PARAMS.swing.def;
    this.dropped = 0; // diagnostics: events that didn't fit
    this.step = 0; // the engine's current step, kept up to date by onStep
  }

  setParam(name, value) {
    const p = LOOPER_PARAMS[name];
    if (!p || !Number.isFinite(value)) return;
    let v = value < p.min ? p.min : value > p.max ? p.max : value;
    if (name === 'grid' || name === 'quantize') v = Math.round(v);
    this[name] = v;
  }

  // An action from the page on one layer.
  action(layer, act) {
    if (!Number.isInteger(layer) || layer < 0 || layer >= LOOP_LAYERS) return;
    const s = this.state[layer], now = this.step + 1;
    switch (act) {
      case LOOP_RECORD:
        if (s === EMPTY) this.startTake(layer, now);
        else if (s === RECORDING) this.finishTake(layer, now);
        else if (s === OVERDUB) this.state[layer] = PLAYING;
        else this.state[layer] = OVERDUB; // playing or stopped: layer more on top
        break;
      case LOOP_PLAY_STOP:
        if (s === PLAYING || s === OVERDUB) this.state[layer] = STOPPED;
        else if (s === STOPPED) this.state[layer] = PLAYING;
        else if (s === RECORDING) this.finishTake(layer, now);
        break;
      case LOOP_MUTE:
        if (s !== EMPTY) this.muted[layer] ^= 1;
        break;
      case LOOP_CLEAR:
        this.state[layer] = EMPTY;
        this.count[layer] = 0;
        this.length[layer] = 0;
        this.muted[layer] = 0;
        if (this.allEmpty()) this.transportOrigin = -1;
        break;
    }
  }

  // A gesture that just landed in the water at `step` (from any live source).
  record(kind, x0, y0, x1, y1, strength, step) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1) ||
        !Number.isFinite(strength) || !Number.isFinite(step)) return;
    let listening = false;
    for (let l = 0; l < LOOP_LAYERS; l++) if (this.state[l] === RECORDING || this.state[l] === OVERDUB) listening = true;
    if (!listening) return;
    if (this.recordBudget <= 0) { this.dropped++; return; }
    this.recordBudget--;
    for (let l = 0; l < LOOP_LAYERS; l++) {
      const s = this.state[l];
      if (s !== RECORDING && s !== OVERDUB) continue;
      let t = this.quantizeTime(step - this.origin[l]);
      // An overdubbed gesture was just heard live: its copy first plays next pass.
      const skip = s === OVERDUB && mod(t, this.length[l]) > this.lastPos[l] ? 1 : 0;
      if (s === OVERDUB) t = mod(t, this.length[l]);
      this.insert(l, t, kind, x0, y0, x1, y1, strength, skip);
    }
  }

  // Called by the engine once per simulation step, before that step's
  // gestures land. Plays every loop's events that fall on this step.
  // Call once per audio block, before its events are handled.
  beginBlock() {
    this.recordBudget = RECORD_BUDGET;
  }

  onStep(step, engine) {
    this.step = step;
    const at = step / SIM_RATE;
    for (let l = 0; l < LOOP_LAYERS; l++) {
      const s = this.state[l];
      if (s === RECORDING && step - this.takeStart[l] >= MAX_LOOP_SECONDS * SIM_RATE) this.finishTake(l, step);
      if (s !== PLAYING && s !== OVERDUB && s !== STOPPED) continue;
      const len = this.length[l];
      const pos = mod(step - this.origin[l], len);
      if (pos < this.lastPos[l]) this.cursor[l] = 0; // wrapped
      this.lastPos[l] = pos;
      const base = l * LOOP_EVENTS, n = this.count[l];
      let c = this.cursor[l];
      while (c < n && this.time[base + c] <= pos) {
        const i = base + c;
        if (this.skip[i]) this.skip[i] = 0;
        else if (s !== STOPPED && !this.muted[l] && this.time[i] > pos - 1) {
          // A snapped pile-up can't flood the water's gesture queue.
          if (engine.queueFull()) this.dropped++;
          else this.fire(i, engine, at);
        }
        c++;
      }
      this.cursor[l] = c;
    }
  }

  // ---- internals ----------------------------------------------------------------

  fire(i, engine, at) {
    const p = this.p, o = i * 5;
    if (this.kind[i] === GESTURE_DROP) engine.drop(p[o], p[o + 1], p[o + 4], at);
    else engine.trail(p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], at);
  }

  startTake(layer, now) {
    this.takeStart[layer] = now;
    this.count[layer] = 0;
    this.length[layer] = 0;
    this.muted[layer] = 0;
    if (this.quantize) {
      // Quantized loops share one bar grid so they stay in time together.
      if (this.transportOrigin < 0) this.transportOrigin = now;
      this.origin[layer] = this.transportOrigin;
    } else {
      this.origin[layer] = now;
    }
    this.state[layer] = RECORDING;
  }

  finishTake(layer, now) {
    let len = now - this.takeStart[layer];
    if (this.quantize) {
      // Whole bars; times are measured from the shared grid's origin, so a
      // whole-bar length keeps every quantized loop in time with the others.
      const bar = this.barSteps();
      len = Math.max(1, Math.round(len / bar)) * bar;
    }
    len = Math.max(1, Math.round(len));
    if (this.count[layer] === 0) { // nothing recorded: nothing to loop
      this.state[layer] = EMPTY;
      if (this.allEmpty()) this.transportOrigin = -1;
      return;
    }
    this.length[layer] = len;
    this.wrapEvents(layer, len);
    this.cursor[layer] = 0;
    this.lastPos[layer] = mod(now - this.origin[layer], len);
    // Start just after "now" in the loop, so nothing double-fires.
    const base = layer * LOOP_EVENTS, n = this.count[layer];
    let c = 0;
    while (c < n && this.time[base + c] <= this.lastPos[layer]) c++;
    this.cursor[layer] = c;
    this.state[layer] = PLAYING;
  }

  // After the first take: fold event times into [0, length) and re-sort
  // (one rotation, since times were increasing), via preallocated scratch.
  // Times are whole steps in [0, len) with len ≤ MAX_LOOP_STEPS, so a stable
  // counting sort does it in O(n + len) — no matter how the take wrapped.
  wrapEvents(layer, len) {
    const base = layer * LOOP_EVENTS, n = this.count[layer], h = this.histogram;
    const L = Math.min(len, MAX_LOOP_STEPS);
    for (let i = 0; i < n; i++) {
      const t = Math.min(L - 1, Math.max(0, Math.round(mod(this.time[base + i], len))));
      this.scratchTime[i] = t;
      this.scratchKind[i] = this.kind[base + i];
      for (let j = 0; j < 5; j++) this.scratchP[i * 5 + j] = this.p[(base + i) * 5 + j];
      h[t + 1]++;
    }
    for (let t = 1; t <= L; t++) h[t] += h[t - 1]; // h[t] = first slot for time t
    for (let i = 0; i < n; i++) {
      const k = base + h[this.scratchTime[i]]++;
      this.time[k] = this.scratchTime[i];
      this.kind[k] = this.scratchKind[i];
      this.skip[k] = 0;
      for (let j = 0; j < 5; j++) this.p[k * 5 + j] = this.scratchP[i * 5 + j];
    }
    h.fill(0, 0, L + 1);
  }

  // Insert keeping times sorted (later of equal times goes after).
  insert(layer, t, kind, x0, y0, x1, y1, strength, skip) {
    const base = layer * LOOP_EVENTS;
    const n = this.count[layer];
    if (n >= LOOP_EVENTS) { this.dropped++; return; }
    let i = n;
    while (i > 0 && this.time[base + i - 1] > t) {
      this.time[base + i] = this.time[base + i - 1];
      this.kind[base + i] = this.kind[base + i - 1];
      this.skip[base + i] = this.skip[base + i - 1];
      for (let j = 0; j < 5; j++) this.p[(base + i) * 5 + j] = this.p[(base + i - 1) * 5 + j];
      i--;
    }
    this.time[base + i] = t;
    this.kind[base + i] = kind;
    this.skip[base + i] = skip;
    const o = (base + i) * 5;
    this.p[o] = x0; this.p[o + 1] = y0; this.p[o + 2] = x1; this.p[o + 3] = y1; this.p[o + 4] = strength;
    this.count[layer] = n + 1;
    // Keep the playhead pointing at the same next event.
    if ((this.state[layer] === OVERDUB) && i < this.cursor[layer]) this.cursor[layer]++;
  }

  barSteps() {
    return (BEATS_PER_BAR * 60 * SIM_RATE) / this.bpm;
  }

  // Move a time (steps from the loop's origin) toward the grid, by strength,
  // with swing on every second grid point.
  quantizeTime(t) {
    if (!this.quantize || this.quantizeStrength <= 0) return t;
    const g = (60 * SIM_RATE) / (this.bpm * this.grid);
    const k = Math.round(t / g);
    const target = k * g + ((((k % 2) + 2) % 2) === 1 ? this.swing * g : 0);
    return Math.round(t + this.quantizeStrength * (target - t));
  }

  allEmpty() {
    for (let l = 0; l < LOOP_LAYERS; l++) if (this.state[l] !== EMPTY) return false;
    return true;
  }
}

function mod(a, n) {
  const r = a % n;
  return r < 0 ? r + n : r;
}
