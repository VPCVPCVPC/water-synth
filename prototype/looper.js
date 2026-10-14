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
// Quantize (optional, off by default) moves a recorded touch's copy (a drop)
// toward a beat grid; drags flow — strength from lean to snap (default when
// on), plus swing — and rounds a new loop's length to whole bars. It never
// places notes. Live touches land as played (Dash, Oct 2026: on the page,
// quantize is for notes only — the instrument pulls when stones ring); how
// a returning looper should treat its copies is for that return to settle.
// While quantize is on the grid runs, so its beat can be shown and played to.
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
// Mute silences a loop and keeps its place. Stop then play restarts it from
// its top (at the next bar if it's on the quantize grid). Clear erases a
// layer completely; clear-all erases every layer and the shared bar grid.
export const LOOP_RECORD = 1, LOOP_PLAY_STOP = 2, LOOP_MUTE = 3, LOOP_CLEAR = 4, LOOP_CLEAR_ALL = 5;

export const LOOPER_PARAMS = {
  quantize: { min: 0, max: 1, def: 0 }, // 0 off, 1 on
  bpm: { min: 40, max: 240, def: 90 },
  // Grid points per beat: 0.25 a whole note (a bar of 4), 0.5 half notes, 1
  // quarters, 1.5 quarter triplets, 2 eighths, 3 eighth triplets, 4
  // sixteenths, 6 sixteenth triplets, 8 thirty-seconds.
  grid: { min: 0.25, max: 8, def: 2 },
  quantizeStrength: { min: 0, max: 1, def: 1 }, // 0 = as played, 1 = snapped (Dash: snap by default)
  swing: { min: 0, max: 0.5, def: 0 }, // fraction of a grid step that every second step is pushed late
};

const BEATS_PER_BAR = 4;
const GRIDS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8]; // the grids the page offers (points per beat)
const BPM_LOG = 4096; // steps of tempo history kept (4 s)
// A tempo change glides there over about this (Dash, Oct 2026: "the
// transition should be smooth, so you can gradually speed up or slow down
// your piece"), and the beat keeps its place: the grid's origin moves so
// the beat count carries on from where it was, only faster or slower.
const BPM_GLIDE = 1 - Math.exp(-1 / (0.2 * SIM_RATE)); // per step

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
    this.onGrid = new Uint8Array(LOOP_LAYERS); // recorded on the shared bar grid
    this.startAt = new Float64Array(LOOP_LAYERS); // a restarted loop waits until this step
    this.scratchTime = new Float64Array(LOOP_EVENTS);
    this.scratchKind = new Uint8Array(LOOP_EVENTS);
    this.scratchSkip = new Uint8Array(LOOP_EVENTS);
    this.histogram = new Int32Array(MAX_LOOP_STEPS + 1); // counting sort over loop positions
    this.recordBudget = RECORD_BUDGET;
    this.scratchP = new Float32Array(LOOP_EVENTS * 5);
    this.transportOrigin = -1; // the shared grid: starts when quantize is turned on (or a quantized take begins)
    // Anything else on the grid (the tapes): its usesGrid() keeps the grid
    // alive while it holds a tape on it.
    this.gridUser = null;
    this.quantize = LOOPER_PARAMS.quantize.def;
    this.bpm = LOOPER_PARAMS.bpm.def; // the tempo now (gliding toward bpmTarget)
    this.bpmTarget = this.bpm;
    // The tempo in force at each recent step (a ring), so the tapes can follow
    // a glide sample by sample, the same however the stream is split.
    this.bpmLog = new Float64Array(BPM_LOG).fill(this.bpm);
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
    if (name === 'quantize') v = Math.round(v);
    if (name === 'grid') { // one of the grids
      let near = GRIDS[0];
      for (let i = 1; i < GRIDS.length; i++) if (Math.abs(GRIDS[i] - v) < Math.abs(near - v)) near = GRIDS[i];
      v = near;
    }
    if (name === 'bpm') { // glides there (see onStep); with no beat running yet, nothing to glide
      this.bpmTarget = v;
      if (this.transportOrigin < 0 || this.transportOrigin === this.step + 1) this.bpm = v; // (just started: set, no glide)
      return;
    }
    this[name] = v;
    if (name === 'quantize') {
      if (v && this.transportOrigin < 0) this.transportOrigin = this.step + 1; // the beat starts now
      else if (!v) this.releaseGrid();
    }
  }

  // The tempo in force during step `step` (one of the last BPM_LOG steps;
  // before the first step ran, the current tempo).
  bpmAt(step) {
    return step >= 0 && step <= this.step && this.step - step < BPM_LOG ? this.bpmLog[step & (BPM_LOG - 1)] : this.bpm;
  }

  // One step of a tempo glide. The beat count at this step stays as it was:
  // the origin moves so (step − origin) · bpm is unchanged.
  glideTempo(step) {
    const t = this.bpmTarget;
    let next = this.bpm + (t - this.bpm) * BPM_GLIDE;
    if (Math.abs(t - next) < 1e-3) next = t;
    if (this.transportOrigin >= 0) {
      let o = step - ((step - this.transportOrigin) * this.bpm) / next;
      // Slowing down moves the origin earlier — maybe before the stream
      // began, which would read as "no grid" (−1). Move it later by whole
      // bars instead: every beat and downbeat stays where it is.
      if (o < 0) { const bar = (BEATS_PER_BAR * 60 * SIM_RATE) / next; o += Math.ceil(-o / bar) * bar; }
      this.transportOrigin = o;
    }
    this.bpm = next;
  }

  // Beats since the grid began (−1 when there's no grid), for the page.
  beatPosition() {
    if (this.transportOrigin < 0) return -1;
    const b = ((this.step - this.transportOrigin) * this.bpm) / (60 * SIM_RATE);
    // (Early on, a slowdown can put the origin a bar or two ahead of now — see
    // glideTempo: count from a bar earlier, downbeats unchanged.)
    return b >= 0 ? b : b + Math.ceil(-b / BEATS_PER_BAR) * BEATS_PER_BAR;
  }

  // An action from the page on one layer.
  action(layer, act) {
    if (act === LOOP_CLEAR_ALL) {
      for (let l = 0; l < LOOP_LAYERS; l++) this.clear(l);
      // A fresh start: a new beat from now if quantize is on (unless a tape
      // still holds the old one).
      if (!(this.gridUser && this.gridUser.usesGrid())) this.transportOrigin = this.quantize ? this.step + 1 : -1;
      return;
    }
    if (!Number.isInteger(layer) || layer < 0 || layer >= LOOP_LAYERS) return;
    const s = this.state[layer], now = this.step + 1;
    switch (act) {
      case LOOP_RECORD:
        if (s === EMPTY) this.startTake(layer, now);
        else if (s === RECORDING) this.finishTake(layer, now);
        else if (s === OVERDUB) this.state[layer] = PLAYING;
        else if (s === STOPPED) { this.restart(layer, now); this.state[layer] = OVERDUB; }
        else this.state[layer] = OVERDUB; // playing: layer more on top
        break;
      case LOOP_PLAY_STOP:
        if (s === PLAYING || s === OVERDUB) this.state[layer] = STOPPED;
        else if (s === STOPPED) this.restart(layer, now);
        else if (s === RECORDING) this.finishTake(layer, now);
        break;
      case LOOP_MUTE:
        if (s !== EMPTY) this.muted[layer] ^= 1;
        break;
      case LOOP_CLEAR:
        this.clear(layer);
        this.releaseGrid();
        break;
    }
  }

  // A gesture that just landed in the water at `step` (from any live source).
  // `asPlayed`: keep this touch's time as is (it was heard unquantized).
  record(kind, x0, y0, x1, y1, strength, step, asPlayed = false) {
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
      // A touch's copy (a drop) leans toward the shared grid; a drag's trail
      // is kept as played, so a stroke keeps its shape in the loop instead
      // of bunching onto grid points.
      const q = kind === GESTURE_DROP && !asPlayed && this.transportOrigin >= 0
        ? this.transportOrigin + this.quantizeTime(step - this.transportOrigin) : step;
      let t = q - this.origin[l];
      // An overdubbed gesture whose copy lands ahead of now (leaning to a
      // grid point past the loop's wrap) was just heard live: its copy first
      // plays on the pass after, never alongside it.
      const skip = s === OVERDUB && q > this.step ? 1 : 0;
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
    if (this.bpm !== this.bpmTarget) this.glideTempo(step);
    this.bpmLog[step & (BPM_LOG - 1)] = this.bpm;
    const at = step / SIM_RATE;
    for (let l = 0; l < LOOP_LAYERS; l++) {
      const s = this.state[l];
      if (s === RECORDING && step - this.takeStart[l] >= MAX_LOOP_SECONDS * SIM_RATE) this.finishTake(l, step);
      if (s !== PLAYING && s !== OVERDUB) continue;
      if (step < this.startAt[l]) continue; // restarted: waiting for its downbeat
      const len = this.length[l];
      const pos = mod(step - this.origin[l], len);
      if (pos < this.lastPos[l]) this.cursor[l] = 0; // wrapped
      this.lastPos[l] = pos;
      const base = l * LOOP_EVENTS, n = this.count[l];
      let c = this.cursor[l];
      while (c < n && this.time[base + c] <= pos) {
        const i = base + c;
        if (this.skip[i]) this.skip[i] = 0;
        else if (!this.muted[l] && this.time[i] > pos - 1) {
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

  // Play a stopped loop again from its top: now, or at the next bar of the
  // shared grid if the loop was recorded on it.
  restart(layer, now) {
    let start = now;
    if (this.onGrid[layer] && this.transportOrigin >= 0) {
      const bar = this.barSteps();
      start = this.transportOrigin + Math.ceil((now - this.transportOrigin) / bar) * bar;
    }
    start = Math.round(start);
    this.origin[layer] = start;
    this.startAt[layer] = start;
    this.cursor[layer] = 0;
    this.lastPos[layer] = -1;
    this.state[layer] = PLAYING;
  }

  clear(layer) {
    this.state[layer] = EMPTY;
    this.count[layer] = 0;
    this.length[layer] = 0;
    this.muted[layer] = 0;
    this.startAt[layer] = 0;
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
      this.onGrid[layer] = 1;
    } else {
      this.origin[layer] = now;
      this.onGrid[layer] = 0;
    }
    this.startAt[layer] = 0;
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
      this.releaseGrid();
      return;
    }
    this.length[layer] = len;
    this.wrapEvents(layer, len, now - this.origin[layer]);
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
  // Events still due after `nowRel` (a touch held for the grid past the end
  // of the take) are about to be heard live: skipped on their first pass.
  wrapEvents(layer, len, nowRel) {
    const base = layer * LOOP_EVENTS, n = this.count[layer], h = this.histogram;
    const L = Math.min(len, MAX_LOOP_STEPS);
    for (let i = 0; i < n; i++) {
      const t = Math.min(L - 1, Math.max(0, Math.round(mod(this.time[base + i], len))));
      this.scratchTime[i] = t;
      this.scratchKind[i] = this.kind[base + i];
      this.scratchSkip[i] = this.time[base + i] > nowRel ? 1 : 0;
      for (let j = 0; j < 5; j++) this.scratchP[i * 5 + j] = this.p[(base + i) * 5 + j];
      h[t + 1]++;
    }
    for (let t = 1; t <= L; t++) h[t] += h[t - 1]; // h[t] = first slot for time t
    for (let i = 0; i < n; i++) {
      const k = base + h[this.scratchTime[i]]++;
      this.time[k] = this.scratchTime[i];
      this.kind[k] = this.scratchKind[i];
      this.skip[k] = this.scratchSkip[i];
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
    // (Swing is for beats and their parts: on a whole- or half-note grid it
    // would push every second bar late, so it's left off there.)
    const target = k * g + (this.grid >= 1 && (((k % 2) + 2) % 2) === 1 ? this.swing * g : 0);
    return Math.round(t + this.quantizeStrength * (target - t));
  }

  // Layer status for the page (see visuals.js LOOP_FIELDS).
  writeStatus(frame, offset) {
    for (let l = 0; l < LOOP_LAYERS; l++) {
      const o = offset + l * 6, s = this.state[l];
      frame[o] = s;
      frame[o + 1] = this.muted[l];
      frame[o + 2] = s === RECORDING ? this.step - this.takeStart[l] : this.length[l];
      frame[o + 3] = s === PLAYING || s === OVERDUB
        ? (this.step < this.startAt[l] ? 0 : mod(this.step - this.origin[l], this.length[l] || 1)) : 0;
      frame[o + 4] = this.count[l] / LOOP_EVENTS;
      frame[o + 5] = this.step < this.startAt[l] ? 1 : 0;
    }
  }

  // Forget the bar grid once nothing is on it any more: no loop, and no tape.
  releaseGrid() {
    if (this.quantize || !this.allEmpty() || (this.gridUser && this.gridUser.usesGrid())) return;
    this.transportOrigin = -1;
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
