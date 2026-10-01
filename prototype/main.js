// main.js — page side: starts audio, draws the water and the stones, turns
// pointer input into gestures, and sends tuning and knob changes.

import { createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT } from './ring.js';
import { createVisualBuffer, VisualReader, FRAME_FLASH, FRAME_HEIGHTS } from './visuals.js';
import { buildPitches, noteLabel, SCALES } from './tuning.js';
import { stonePositions, LAYOUTS } from './layout.js';
import { PARAMS, PARAM_KEYS } from './instrument.js';
import { REFERENCE_SPEED, SURFACE_W, SURFACE_H } from './surface.js';
import { RANGE_LOW, RANGE_HIGH, REF_MIN_HZ, REF_MAX_HZ } from './tuning-limits.js';

const SAMPLE_RATE = 48000;
const GRID_W = SURFACE_W, GRID_H = SURFACE_H; // the water's cells
const ASPECT = GRID_H / GRID_W;

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const outputBar = document.getElementById('output');

let events = null;
let visuals = null;

// ---- tuning: scale, root, range, reference → stones ------------------------------

const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const tuning = { scale: 'pentatonicMajor', root: 0, low: 48, high: 84, refHz: 440, layout: 'scattered' };
let stones = { xs: new Float64Array(0), ys: new Float64Array(0), hzs: [], labels: [], count: 0 };
let stonesUnsent = false;

function retune() {
  let pitches;
  try {
    pitches = buildPitches({
      scale: SCALES[tuning.scale], root: 60 + tuning.root,
      reference: { note: 69, hz: tuning.refHz }, low: tuning.low, high: tuning.high,
    });
  } catch (err) {
    setTuningNote(`${err.message} — keeping the previous ${stones.count} stones`);
    return;
  }
  if (pitches.length === 0) { setTuningNote(`no scale notes in this range — keeping the previous ${stones.count} stones`); return; }
  setTuningNote(`${pitches.length} stones`);
  const { xs, ys } = stonePositions(pitches.length, tuning.layout);
  stones = { xs, ys, hzs: pitches.map((p) => p.hz), labels: pitches.map((p) => p.label), count: pitches.length };
  sendStones();
}

// Each stone is one event, then a commit makes them live together. If the
// queue is full, try the whole set again next frame.
function sendStones() {
  if (!events) return;
  for (let i = 0; i < stones.count; i++) {
    if (!events.push(EV_STONE, i, stones.xs[i], stones.ys[i], stones.hzs[i])) { stonesUnsent = true; return; }
  }
  stonesUnsent = !events.push(EV_STONES_COMMIT, stones.count);
}

function setTuningNote(text) {
  document.getElementById('tuning-note').textContent = text;
}

function buildTuningControls() {
  const fill = (id, entries, value) => {
    const sel = document.getElementById(id);
    for (const [v, label] of entries) sel.add(new Option(label, v));
    sel.value = String(value);
    return sel;
  };
  const notes = [];
  for (let n = RANGE_LOW; n <= RANGE_HIGH; n++) notes.push([n, noteLabel(n)]);
  const scale = fill('scale', Object.entries(SCALES).map(([k, s]) => [k, s.name]), tuning.scale);
  const root = fill('root', ROOTS.map((r, i) => [i, r]), tuning.root);
  const low = fill('low', notes, tuning.low);
  const high = fill('high', notes, tuning.high);
  const layout = fill('layout', Object.entries(LAYOUTS), tuning.layout);
  const ref = document.getElementById('ref');
  ref.value = tuning.refHz;

  scale.addEventListener('change', () => { tuning.scale = scale.value; retune(); });
  root.addEventListener('change', () => { tuning.root = Number(root.value); retune(); });
  low.addEventListener('change', () => {
    tuning.low = Number(low.value);
    if (tuning.high < tuning.low) { tuning.high = tuning.low; high.value = String(tuning.high); }
    retune();
  });
  high.addEventListener('change', () => {
    tuning.high = Number(high.value);
    if (tuning.low > tuning.high) { tuning.low = tuning.high; low.value = String(tuning.low); }
    retune();
  });
  layout.addEventListener('change', () => { tuning.layout = layout.value; retune(); });
  const setRef = (hz) => {
    if (!(hz >= REF_MIN_HZ && hz <= REF_MAX_HZ)) {
      ref.value = tuning.refHz;
      setTuningNote(`A4 must be ${REF_MIN_HZ}–${REF_MAX_HZ} Hz in this prototype`);
      return;
    }
    tuning.refHz = hz;
    ref.value = hz;
    retune();
  };
  ref.addEventListener('change', () => setRef(Number(ref.value)));
  document.getElementById('ref440').addEventListener('click', () => setRef(440));
  document.getElementById('ref432').addEventListener('click', () => setRef(432));
}

// ---- knobs ---------------------------------------------------------------------------

const values = Object.fromEntries(PARAM_KEYS.map((k) => [k, PARAMS[k].def]));
const knobs = {};
const SLIDER_STEPS = 1000;
const logMap = (k) => ({
  to: (v) => Math.log(v / PARAMS[k].min) / Math.log(PARAMS[k].max / PARAMS[k].min),
  from: (f) => PARAMS[k].min * Math.pow(PARAMS[k].max / PARAMS[k].min, f),
});
const linMap = (k) => ({
  to: (v) => (v - PARAMS[k].min) / (PARAMS[k].max - PARAMS[k].min),
  from: (f) => PARAMS[k].min + f * (PARAMS[k].max - PARAMS[k].min),
});
// Higher sensitivity = a lower crest threshold: stones hear more of the water.
const sensitivityMap = { to: (v) => 1 - logMap('threshold').to(v), from: (f) => logMap('threshold').from(1 - f) };
const tempoScale = () => REFERENCE_SPEED / values.waveSpeed; // decay times are given at the default tempo

const KNOBS = [
  { group: 'water', key: 'waveSpeed', label: 'tempo', map: logMap('waveSpeed'),
    show: (v) => `${(GRID_W / v).toFixed(1)} s to cross`, hint: 'how fast ripples travel — everything speeds up or slows down together' },
  { group: 'water', key: 'decay', label: 'water decay', map: logMap('decay'),
    show: (v) => `${(v * tempoScale()).toFixed(1)} s`, hint: 'how long the water keeps moving (seconds at the current tempo)' },
  { group: 'water', key: 'hfDecay', label: 'fine ripples', map: logMap('hfDecay'),
    show: (v) => `${(Math.min(v, values.decay) * tempoScale()).toFixed(2)} s`, hint: 'how long small, sharp ripples last' },
  { group: 'water', key: 'threshold', label: 'sensitivity', map: sensitivityMap,
    show: (v) => `${Math.round(sensitivityMap.to(v) * 100)} / 100`, hint: 'how much of the water the stones hear — and so how long phrases last' },
  { group: 'water', key: 'splash', label: 'splash', map: linMap('splash'),
    show: (v) => `${Math.round((v / PARAMS.splash.max) * 100)}%`, hint: 'ringing stones send ripples back into the water (never more than you put in)' },
  { group: 'bells', key: 'bellDecay', label: 'bell decay', map: logMap('bellDecay'),
    show: (v) => `${v.toFixed(1)} s`, hint: 'how long a struck stone rings' },
  { group: 'bells', key: 'volume', label: 'volume', map: linMap('volume'),
    show: (v) => `${v.toFixed(2)}×`, hint: 'listening level' },
];

function buildKnobs() {
  for (const k of KNOBS) {
    const row = document.createElement('label');
    row.className = 'control';
    row.title = k.hint;
    const name = document.createElement('span');
    name.textContent = k.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = 0;
    input.max = SLIDER_STEPS;
    const readout = document.createElement('output');
    const hint = document.createElement('small');
    hint.textContent = k.hint;
    input.addEventListener('input', () => {
      values[k.key] = k.map.from(Number(input.value) / SLIDER_STEPS);
      sendParam(k.key);
      refreshReadouts(); // decay readouts depend on tempo
    });
    row.append(name, input, readout, hint);
    document.getElementById(`${k.group}-controls`).append(row);
    knobs[k.key] = { input, readout, k };
  }
  document.getElementById('defaults').addEventListener('click', () => {
    for (const k of KNOBS) { values[k.key] = PARAMS[k.key].def; sendParam(k.key); }
    refreshKnobs();
  });
  refreshKnobs();
}

function refreshKnobs() {
  for (const { input, k } of Object.values(knobs)) input.value = Math.round(k.map.to(values[k.key]) * SLIDER_STEPS);
  refreshReadouts();
}

function refreshReadouts() {
  for (const { readout, k } of Object.values(knobs)) readout.textContent = k.show(values[k.key]);
}

// Parameters are state: a value that doesn't fit in the queue is retried each frame.
const unsent = new Set();
function sendParam(key) {
  if (!events) return;
  if (events.push(EV_PARAM, PARAM_KEYS.indexOf(key), values[key])) unsent.delete(key);
  else unsent.add(key);
}

// ---- start -------------------------------------------------------------------------

buildTuningControls();
buildKnobs();
document.getElementById('labels').addEventListener('change', (e) => { showLabels = e.target.checked; });
startButton.addEventListener('click', start, { once: true });

async function start() {
  startButton.hidden = true;
  if (!crossOriginIsolated) {
    status.textContent = 'Needs cross-origin isolation: run `node serve.mjs` and open http://localhost:8123';
    return;
  }
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('water-worklet.js');

  const eventBuffer = createRingBuffer(1024);
  const visualBuffer = createVisualBuffer(GRID_W * GRID_H);
  events = new RingWriter(eventBuffer);
  visuals = new VisualReader(visualBuffer);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1; // fresh every session
  const node = new AudioWorkletNode(ctx, 'water', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { eventBuffer, visualBuffer, seed },
  });
  node.connect(ctx.destination);
  node.onprocessorerror = () => {
    status.textContent = 'The audio engine stopped with an error — see the browser console.';
  };

  // For inspection from dev tools / automated checks; not used by the page.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  const live = new Float32Array(visualBuffer, 8);
  window.waterDebug = {
    ctx, node, analyser, peak: () => peakOf(analyser), stones: () => stones,
    liveEnergy: () => live[0], liveFlash: () => Array.from(live.subarray(FRAME_FLASH, FRAME_FLASH + stones.count)),
  };

  for (const k of PARAM_KEYS) sendParam(k);
  retune();
  await ctx.resume();
  status.textContent = `${ctx.sampleRate} Hz · click to drop, drag to disturb`;
  requestAnimationFrame(draw);
}

// ---- gestures ---------------------------------------------------------------------

let drag = null; // last pointer sample while pressed

surface.addEventListener('pointerdown', (e) => {
  if (!events) return;
  surface.setPointerCapture(e.pointerId);
  const p = toSurface(e);
  // Pen and touch report real pressure; a mouse click is a fixed-strength drop.
  const strength = e.pointerType !== 'mouse' && e.pressure > 0 ? 2 * e.pressure : 1;
  events.push(EV_DROP, p.x, p.y, strength);
  drag = { x: p.x, y: p.y, t: e.timeStamp };
});

surface.addEventListener('pointermove', (e) => {
  if (!events || !drag) return;
  const p = toSurface(e);
  const dt = (e.timeStamp - drag.t) / 1000;
  if (dt < 0.004) return; // let very fast event streams accumulate a little
  const speed = Math.sqrt((p.x - drag.x) ** 2 + ((p.y - drag.y) * ASPECT) ** 2) / dt; // surface-widths per second
  if (speed > 0) events.push(EV_STROKE, drag.x, drag.y, p.x, p.y, Math.min(16, speed));
  drag = { x: p.x, y: p.y, t: e.timeStamp };
});

for (const type of ['pointerup', 'pointercancel']) {
  surface.addEventListener(type, () => { drag = null; });
}

function toSurface(e) {
  const r = surface.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

// ---- drawing -------------------------------------------------------------------------

// The water: crests light, troughs dark, still water a deep blue. Heights are
// compressed (tanh) so small ripples stay visible next to fresh drops.
const HEIGHT_SCALE = 0.05;
const STILL = [14, 30, 48], CREST = [196, 230, 246], TROUGH = [4, 10, 18];
const g = surface.getContext('2d');
const grid = document.createElement('canvas');
grid.width = GRID_W; grid.height = GRID_H;
const gridCtx = grid.getContext('2d');
const image = gridCtx.createImageData(GRID_W, GRID_H);
const flashShown = new Float32Array(128);
let showLabels = false;
let outputLevel = 0, lastFrameTime = 0;

function draw(now) {
  if (stonesUnsent) sendStones();
  for (const key of unsent) sendParam(key);
  const dt = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0;
  lastFrameTime = now;

  const frame = visuals.read();
  const fade = Math.pow(0.02, dt); // a flash fades to 2% in a second
  for (let i = 0; i < flashShown.length; i++) flashShown[i] *= fade;
  if (frame) {
    const px = image.data;
    for (let i = 0; i < GRID_W * GRID_H; i++) {
      const t = Math.tanh(frame[FRAME_HEIGHTS + i] / HEIGHT_SCALE);
      const to = t > 0 ? CREST : TROUGH, a = t > 0 ? t : -t;
      px[i * 4] = STILL[0] + (to[0] - STILL[0]) * a;
      px[i * 4 + 1] = STILL[1] + (to[1] - STILL[1]) * a;
      px[i * 4 + 2] = STILL[2] + (to[2] - STILL[2]) * a;
      px[i * 4 + 3] = 255;
    }
    gridCtx.putImageData(image, 0, 0);
    for (let i = 0; i < stones.count; i++) flashShown[i] = Math.max(flashShown[i], frame[FRAME_FLASH + i]);
    outputLevel = Math.max(frame[1], outputLevel * 0.9);
  }

  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(surface.clientWidth * dpr), h = Math.round(surface.clientHeight * dpr);
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(grid, 0, 0, w, h);

  // Stones: a small dot; when one rings it glows, harder strikes brighter.
  const r = Math.max(2, w / 180);
  g.font = `${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
  for (let i = 0; i < stones.count; i++) {
    const x = stones.xs[i] * w, y = stones.ys[i] * h, f = flashShown[i];
    if (f > 0.01) {
      g.fillStyle = `rgba(255, 236, 190, ${(0.25 + 0.6 * f).toFixed(3)})`;
      g.beginPath(); g.arc(x, y, r * (1.5 + 4 * f), 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(225, 235, 245, 0.75)';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    if (showLabels) {
      g.fillStyle = 'rgba(225, 235, 245, 0.7)';
      g.fillText(stones.labels[i], x + r * 2, y - r * 1.5);
    }
  }

  outputBar.style.width = `${Math.min(100, outputLevel * 100).toFixed(1)}%`;
  outputBar.classList.toggle('hot', outputLevel > 0.9);
  requestAnimationFrame(draw);
}

function peakOf(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}
