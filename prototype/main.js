// main.js — page side: starts audio, draws the water and the stones, turns
// touches (any number of fingers, a pen, a mouse) into gestures, and sends
// loops, stones, tuning and knob changes to the audio thread.

import {
  createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT, EV_LOOP, EV_STONE_MOVE,
  EV_VOICE,
} from './ring.js';
import { createVisualBuffer, VisualReader, FRAME_FLASH, FRAME_LOOPS, FRAME_HEIGHTS, LOOP_FIELDS } from './visuals.js';
import { buildPitches, noteLabel, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { PARAMS as INSTRUMENT_PARAMS, PARAM_KEYS, VOICE_PARAMS, VOICE_KEYS, SHARED } from './instrument.js';
import { REFERENCE_SPEED, SURFACE_W, SURFACE_H, SIM_RATE } from './surface.js';
import { MAX_STONES } from './stones.js';
import { RANGE_LOW, RANGE_HIGH, REF_MIN_HZ, REF_MAX_HZ } from './tuning-limits.js';
import {
  LOOP_LAYERS, LOOP_RECORD, LOOP_PLAY_STOP, LOOP_MUTE, LOOP_CLEAR, LOOP_CLEAR_ALL,
  EMPTY, RECORDING, PLAYING, OVERDUB, STOPPED,
} from './looper.js';

const SAMPLE_RATE = 48000;
const GRID_W = SURFACE_W, GRID_H = SURFACE_H; // the water's cells
const ASPECT = GRID_H / GRID_W;
const GRAB_RADIUS_PX = 28; // how close a touch must be to pick up a stone

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const outputBar = document.getElementById('output');

let events = null;
let visuals = null;
let ctx = null;

// On small screens (or a phone held sideways) the controls start tucked away
// so the water fills the screen.
if (window.matchMedia('(max-width: 700px), (max-height: 500px)').matches) document.getElementById('drawer').open = false;

// iOS pauses audio on a lock, a call or an app switch; the next touch (or
// coming back to the page) brings it back.
function wake() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

// The pond is landscape (128 × 97). On a portrait screen it's shown turned a
// quarter-turn so it fills the height; touches and drawing map through the
// turn, so the water itself is the same either way.
let rotated = false;
function fitOrientation() {
  rotated = window.innerHeight > window.innerWidth;
  surface.style.aspectRatio = rotated ? `${GRID_H} / ${GRID_W}` : `${GRID_W} / ${GRID_H}`;
  document.querySelector('.stage').style.width = rotated
    ? `min(100%, calc((100dvh - 130px) * ${GRID_H} / ${GRID_W}))` : '';
}
fitOrientation();
window.addEventListener('resize', fitOrientation);

// Pond coordinates (x, y in [0, 1]) ↔ canvas coordinates (u, v in [0, 1]).
const toCanvas = (x, y) => (rotated ? { u: 1 - y, v: x } : { u: x, v: y });
const fromCanvas = (u, v) => (rotated ? { x: v, y: 1 - u } : { x: u, y: v });

// Two taps to confirm anything that can't be undone.
function confirmButton(button, action) {
  const label = button.textContent;
  let armed = 0;
  button.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed); armed = 0;
      button.textContent = label; button.classList.remove('confirm');
      action();
    } else {
      button.textContent = 'tap again'; button.classList.add('confirm');
      armed = setTimeout(() => { armed = 0; button.textContent = label; button.classList.remove('confirm'); }, 2500);
    }
  });
}

// ---- tuning and stones ---------------------------------------------------------------

const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const tuning = { scale: 'pentatonicMajor', root: 0, low: 48, high: 84, refHz: 440 };
const layout = { seed: 0, spread: 1 };
const placed = new Map(); // stone index → { x, y } placed by hand
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
  stones = { ...placeStones(pitches.length), hzs: pitches.map((p) => p.hz), labels: pitches.map((p) => p.label), count: pitches.length };
  sendStones();
}

// Scattered positions, except stones placed by hand, which stay put.
function placeStones(count) {
  const { xs, ys } = stonePositions(count, layout);
  for (const [i, p] of placed) if (i < count) { xs[i] = p.x; ys[i] = p.y; }
  return { xs, ys };
}

function rearrange() {
  stones = { ...stones, ...placeStones(stones.count) };
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

function fillSelect(id, entries, value) {
  const sel = document.getElementById(id);
  for (const [v, label] of entries) sel.add(new Option(label, v));
  sel.value = String(value);
  return sel;
}

function buildTuningControls() {
  const notes = [];
  for (let n = RANGE_LOW; n <= RANGE_HIGH; n++) notes.push([n, noteLabel(n)]);
  const scale = fillSelect('scale', Object.entries(SCALES).map(([k, s]) => [k, s.name]), tuning.scale);
  const root = fillSelect('root', ROOTS.map((r, i) => [i, r]), tuning.root);
  const low = fillSelect('low', notes, tuning.low);
  const high = fillSelect('high', notes, tuning.high);
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

let moveMode = false;
function buildStoneControls() {
  const move = document.getElementById('move');
  move.addEventListener('click', () => {
    moveMode = !moveMode;
    move.classList.toggle('on', moveMode);
    move.setAttribute('aria-pressed', moveMode ? 'true' : 'false');
    move.textContent = moveMode ? 'done moving' : 'move stones';
    surface.classList.toggle('moving', moveMode);
  });
  document.getElementById('randomize').addEventListener('click', () => { layout.seed++; rearrange(); });
  confirmButton(document.getElementById('release'), () => { placed.clear(); rearrange(); });
  // Spread: gathered ↔ spread evenly over the whole pond.
  const row = slider({
    label: 'spread', hint: 'gathered in loose clumps ↔ spread evenly over the whole pond',
    get: () => layout.spread, set: (v) => { layout.spread = v; rearrange(); },
    to: (v) => v, from: (f) => f, show: (v) => (v > 0.95 ? 'even' : v < 0.05 ? 'gathered' : `${Math.round(v * 100)}`),
  });
  document.getElementById('stone-controls').append(row.el);
}

// ---- knobs ---------------------------------------------------------------------------

// Instrument knobs and the shared voice's parameters, by name.
const PARAMS = { ...INSTRUMENT_PARAMS, ...VOICE_PARAMS };
const values = Object.fromEntries(Object.keys(PARAMS).map((k) => [k, PARAMS[k].def]));
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
const flowScale = () => REFERENCE_SPEED / values.waveSpeed; // decay times are given at the reference speed

const KNOBS = [
  { group: 'water', key: 'waveSpeed', label: 'flow', map: logMap('waveSpeed'),
    show: (v) => `${(GRID_W / v).toFixed(1)} s to cross`, hint: 'how fast ripples travel — the whole water speeds up or slows down together' },
  { group: 'water', key: 'decay', label: 'water decay', map: logMap('decay'),
    show: (v) => `${(v * flowScale()).toFixed(1)} s`, hint: 'how long the water keeps moving (seconds at the current flow)' },
  { group: 'water', key: 'hfDecay', label: 'fine ripples', map: logMap('hfDecay'),
    show: (v) => `${(Math.min(v, values.decay) * flowScale()).toFixed(2)} s`, hint: 'how long small, sharp ripples last' },
  { group: 'water', key: 'threshold', label: 'sensitivity', map: sensitivityMap,
    show: (v) => `${Math.round(sensitivityMap.to(v) * 100)} / 100`, hint: 'how much of the water the stones hear — and so how long phrases last' },
  { group: 'water', key: 'splash', label: 'splash', map: linMap('splash'),
    show: (v) => `${Math.round((v / PARAMS.splash.max) * 100)}%`, hint: 'ringing stones send ripples back into the water (never more than you put in)' },
  { group: 'bells', key: 'bellDecay', label: 'bell decay', map: logMap('bellDecay'),
    show: (v) => `${v.toFixed(1)} s`, hint: 'how long a struck stone rings' },
  { group: 'bells', key: 'volume', label: 'volume', map: linMap('volume'),
    show: (v) => `${v.toFixed(2)}×`, hint: 'listening level' },
  { group: 'quantize', key: 'quantizeStrength', label: 'strength', map: linMap('quantizeStrength'),
    show: (v) => (v >= 0.995 ? 'snap' : v <= 0.005 ? 'as played' : `lean ${Math.round(v * 100)}%`), hint: 'how far recorded touches move toward the grid' },
  { group: 'quantize', key: 'swing', label: 'swing', map: linMap('swing'),
    show: (v) => `${Math.round(v * 200)}%`, hint: 'every second grid point lands late' },
];
const knobs = [];

// A labelled slider row. `to`/`from` map a value to [0, 1] and back.
function slider({ label, hint, get, set, to, from, show }) {
  const el = document.createElement('label');
  el.className = 'control';
  el.title = hint;
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range'; input.min = 0; input.max = SLIDER_STEPS;
  const readout = document.createElement('output');
  const small = document.createElement('small');
  small.textContent = hint;
  input.addEventListener('input', () => { set(from(Number(input.value) / SLIDER_STEPS)); refreshReadouts(); readout.textContent = show(get()); });
  el.append(name, input, readout, small);
  const row = { el, refresh: () => { input.value = Math.round(to(get()) * SLIDER_STEPS); readout.textContent = show(get()); }, readout, show, get };
  row.refresh();
  return row;
}

function buildKnobs() {
  for (const k of KNOBS) {
    const row = slider({
      label: k.label, hint: k.hint, get: () => values[k.key],
      set: (v) => { values[k.key] = v; sendParam(k.key); }, to: k.map.to, from: k.map.from, show: k.show,
    });
    knobs.push(row);
    document.getElementById(`${k.group}-controls`).append(row.el);
  }
  document.getElementById('defaults').addEventListener('click', () => {
    for (const k of KNOBS) if (k.group !== 'quantize') { values[k.key] = PARAMS[k.key].def; sendParam(k.key); }
    for (const row of knobs) row.refresh();
  });
}

function refreshReadouts() {
  for (const row of knobs) row.readout.textContent = row.show(row.get()); // decay readouts depend on flow
}

// Parameters are state: a value that doesn't fit in the queue is retried each frame.
const unsent = new Set();
function sendParam(key) {
  if (!events) return;
  const sent = PARAM_KEYS.includes(key)
    ? events.push(EV_PARAM, PARAM_KEYS.indexOf(key), values[key])
    : events.push(EV_VOICE, SHARED, VOICE_KEYS.indexOf(key), values[key]);
  if (sent) unsent.delete(key);
  else unsent.add(key);
}

// ---- loops ---------------------------------------------------------------------------

const layerUi = [];
function buildLoopControls() {
  const host = document.getElementById('layers');
  for (let l = 0; l < LOOP_LAYERS; l++) {
    const row = document.createElement('div');
    row.className = 'layer';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = String(l + 1);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const mk = (text) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; buttons.append(b); return b; };
    const rec = mk('record'), play = mk('play'), mute = mk('mute'), clear = mk('clear');
    for (const [b, what] of [[rec, 'record'], [play, 'play or stop'], [mute, 'mute'], [clear, 'clear']]) b.setAttribute('aria-label', `loop ${l + 1} ${what}`);
    mute.setAttribute('aria-pressed', 'false');
    rec.addEventListener('click', () => sendLoop(l, LOOP_RECORD));
    play.addEventListener('click', () => sendLoop(l, LOOP_PLAY_STOP));
    mute.addEventListener('click', () => sendLoop(l, LOOP_MUTE));
    confirmButton(clear, () => sendLoop(l, LOOP_CLEAR));
    const info = document.createElement('div');
    info.className = 'info';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const pos = document.createElement('div');
    bar.append(pos);
    const text = document.createElement('span');
    info.append(bar, text);
    row.append(name, buttons, document.createElement('span'), info);
    host.append(row);
    layerUi.push({ row, rec, play, mute, pos, text, last: '', lastPos: '' });
  }
  confirmButton(document.getElementById('clear-all'), () => sendLoop(0, LOOP_CLEAR_ALL));

  const quantize = document.getElementById('quantize');
  const shown = document.querySelector('.quantized');
  quantize.addEventListener('change', () => {
    values.quantize = quantize.checked ? 1 : 0;
    shown.hidden = !quantize.checked;
    sendParam('quantize');
  });
  const bpm = document.getElementById('bpm');
  bpm.value = values.bpm;
  bpm.addEventListener('change', () => {
    const v = Math.round(Number(bpm.value));
    if (!(v >= PARAMS.bpm.min && v <= PARAMS.bpm.max)) { bpm.value = values.bpm; return; }
    values.bpm = v; sendParam('bpm');
  });
  const grid = fillSelect('grid', [[1, '1/4'], [2, '1/8'], [3, '1/8 triplets'], [4, '1/16']], values.grid);
  grid.addEventListener('change', () => { values.grid = Number(grid.value); sendParam('grid'); });
}

function sendLoop(layer, action) {
  if (events) events.push(EV_LOOP, layer, action);
}

// Show each layer's state from the latest frame (only touching the DOM on change).
function updateLoops(frame) {
  const bar = (4 * 60 * SIM_RATE) / values.bpm;
  for (let l = 0; l < LOOP_LAYERS; l++) {
    const o = FRAME_LOOPS + l * LOOP_FIELDS;
    const state = frame[o], muted = frame[o + 1], length = frame[o + 2], pos = frame[o + 3], fill = frame[o + 4], waiting = frame[o + 5];
    const ui = layerUi[l];
    const width = state === PLAYING || state === OVERDUB
      ? `${Math.min(100, (pos / Math.max(1, length)) * 100).toFixed(0)}%` : state === RECORDING ? '100%' : '0';
    if (width !== ui.lastPos) { ui.pos.style.width = width; ui.lastPos = width; }
    const secs = (length / SIM_RATE).toFixed(1);
    // Bars only exist when quantize is on; a free loop is just seconds.
    let text = state === EMPTY ? 'empty' : state === RECORDING ? `recording ${secs} s`
      : values.quantize ? `${Math.max(1, Math.round(length / bar))} bars` : `${secs} s`;
    if (state === STOPPED) text += ' · stopped';
    if (muted) text += ' · muted';
    if (waiting) text += ' · waiting for the bar';
    if (state === OVERDUB) text += ' · overdubbing';
    const full = fill >= 0.99;
    if (full) text += ' · full: new gestures aren\'t recorded';
    const key = `${state}|${muted}|${text}`;
    if (key === ui.last) continue;
    ui.last = key;
    ui.text.textContent = text;
    ui.text.classList.toggle('full', full);
    ui.row.classList.toggle('recording', state === RECORDING || state === OVERDUB);
    ui.rec.textContent = state === EMPTY ? 'record' : state === RECORDING ? 'finish' : state === OVERDUB ? 'end overdub' : 'overdub';
    ui.rec.classList.toggle('rec', state === RECORDING || state === OVERDUB);
    ui.play.textContent = state === PLAYING || state === OVERDUB ? 'stop' : state === RECORDING ? 'finish' : 'play';
    ui.play.disabled = state === EMPTY;
    ui.mute.classList.toggle('on', Boolean(muted));
    ui.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    ui.mute.disabled = state === EMPTY;
  }
}

// ---- start ---------------------------------------------------------------------------

buildTuningControls();
buildKnobs();
buildLoopControls();
buildStoneControls();
document.getElementById('labels').addEventListener('change', (e) => { showLabels = e.target.checked; });
startButton.addEventListener('click', start);

async function start() {
  startButton.hidden = true;
  if (!crossOriginIsolated) {
    status.textContent = 'Needs cross-origin isolation: run `node serve.mjs` (or `--https` for a phone or tablet)';
    return;
  }
  try {
    await startAudio();
  } catch (err) {
    // No console on a phone: say what went wrong and let it be tried again.
    status.textContent = `Couldn't start the audio: ${err && err.message ? err.message : err}. Tap to try again.`;
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    events = null;
    startButton.hidden = false;
  }
}

async function startAudio() {
  // Play through the iPhone's silent mode (Safari 17+); older iOS mutes web audio in silent mode.
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  const resumed = ctx.resume(); // inside the tap, before anything is awaited
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
    ctx, node, analyser, peak: () => peakOf(analyser), stones: () => stones, placed: () => placed,
    liveEnergy: () => live[0], liveFlash: () => Array.from(live.subarray(FRAME_FLASH, FRAME_FLASH + stones.count)),
    liveLoops: () => Array.from({ length: LOOP_LAYERS }, (_, l) => Array.from(live.subarray(FRAME_LOOPS + l * LOOP_FIELDS, FRAME_LOOPS + (l + 1) * LOOP_FIELDS))),
  };

  for (const k of Object.keys(PARAMS)) sendParam(k);
  retune();
  requestAnimationFrame(draw); // draw even if iOS holds the resume back
  status.textContent = 'waking the water…';
  await resumed;
  status.textContent = `${ctx.sampleRate} Hz · touch to drop, drag to disturb — any number of fingers`;
}

// ---- gestures: every finger, pen or mouse is its own disturbance ------------------------

const drags = new Map(); // pointerId → last sample { x, y, t }
const grabs = new Map(); // pointerId → stone index (move mode)

surface.addEventListener('pointerdown', (e) => {
  if (!events) return;
  e.preventDefault();
  wake();
  // Keep receiving this finger's moves even if it slides off the surface.
  try { surface.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  const p = toSurface(e);
  if (moveMode) {
    const i = nearestStone(e);
    if (i >= 0) grabs.set(e.pointerId, i);
    return;
  }
  // Apple Pencil pressure sets strength (with a floor: first-contact pressure
  // is often low); fingers and mice are a fixed-strength drop.
  const strength = e.pointerType === 'pen' && e.pressure > 0 ? 0.6 + 1.4 * e.pressure : 1;
  events.push(EV_DROP, p.x, p.y, strength);
  drags.set(e.pointerId, { x: p.x, y: p.y, t: e.timeStamp });
});

surface.addEventListener('pointermove', (e) => {
  if (!events) return;
  const p = toSurface(e);
  const grabbed = grabs.get(e.pointerId);
  if (grabbed !== undefined) {
    stones.xs[grabbed] = p.x; stones.ys[grabbed] = p.y;
    placed.set(grabbed, { x: p.x, y: p.y });
    if (!events.push(EV_STONE_MOVE, grabbed, p.x, p.y)) stonesUnsent = true;
    return;
  }
  const drag = drags.get(e.pointerId);
  if (!drag) return;
  const dt = (e.timeStamp - drag.t) / 1000;
  if (dt < 0.004) return; // let very fast event streams accumulate a little
  const speed = Math.sqrt((p.x - drag.x) ** 2 + ((p.y - drag.y) * ASPECT) ** 2) / dt; // surface-widths per second
  if (speed > 0) events.push(EV_STROKE, drag.x, drag.y, p.x, p.y, Math.min(16, speed));
  drags.set(e.pointerId, { x: p.x, y: p.y, t: e.timeStamp });
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  surface.addEventListener(type, (e) => { drags.delete(e.pointerId); grabs.delete(e.pointerId); });
}
surface.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menus on touch

function toSurface(e) {
  const r = surface.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return fromCanvas(u, v);
}

function nearestStone(e) {
  const r = surface.getBoundingClientRect();
  let best = -1, bestD = GRAB_RADIUS_PX * GRAB_RADIUS_PX;
  for (let i = 0; i < stones.count; i++) {
    const c = toCanvas(stones.xs[i], stones.ys[i]);
    const dx = r.left + c.u * r.width - e.clientX, dy = r.top + c.v * r.height - e.clientY;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
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
const flashShown = new Float32Array(MAX_STONES);
let showLabels = false;
let outputLevel = 0, lastFrameTime = 0, lastOutputWidth = '', lastSize = '', lastFrameEnergy = -1;

function draw(now) {
  if (stonesUnsent) sendStones();
  for (const key of unsent) sendParam(key);
  const dt = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0;
  lastFrameTime = now;

  let frame = visuals.read();
  // A frame of perfectly still water after another one changes nothing on screen.
  if (frame && frame[0] === 0 && lastFrameEnergy === 0 && frame[1] === 0) frame = null;
  if (frame) lastFrameEnergy = frame[0];
  const fade = Math.pow(0.02, dt); // a flash fades to 2% in a second
  let glowing = false;
  for (let i = 0; i < flashShown.length; i++) { flashShown[i] *= fade; if (flashShown[i] > 0.01) glowing = true; }
  // Nothing new, nothing fading, nothing held: skip the redraw (battery).
  const size = `${surface.clientWidth}x${surface.clientHeight}x${rotated}x${moveMode}x${showLabels}`;
  if (!frame && !glowing && grabs.size === 0 && size === lastSize) { requestAnimationFrame(draw); return; }
  lastSize = size;
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
    updateLoops(frame);
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1); // the water is a 128×97 image; 3× only costs
  const w = Math.round(surface.clientWidth * dpr), h = Math.round(surface.clientHeight * dpr);
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'medium';
  if (rotated) {
    g.save();
    g.translate(w, 0);
    g.rotate(Math.PI / 2);
    g.drawImage(grid, 0, 0, h, w);
    g.restore();
  } else {
    g.drawImage(grid, 0, 0, w, h);
  }

  // Stones: a small dot; when one rings it glows, harder strikes brighter. In
  // move mode, stones are larger targets and hand-placed ones are ringed.
  const r = Math.max(2, Math.max(w, h) / 180) * (moveMode ? 1.8 : 1);
  g.font = `${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
  for (let i = 0; i < stones.count; i++) {
    let grabbed = false;
    for (const s of grabs.values()) if (s === i) grabbed = true;
    const c = toCanvas(stones.xs[i], stones.ys[i]);
    const x = c.u * w, y = c.v * h, f = flashShown[i];
    if (f > 0.01) {
      g.fillStyle = `rgba(255, 236, 190, ${(0.25 + 0.6 * f).toFixed(3)})`;
      g.beginPath(); g.arc(x, y, r * (1.5 + 4 * f), 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = grabbed ? 'rgba(255, 255, 255, 0.95)' : 'rgba(225, 235, 245, 0.75)';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    if (moveMode && placed.has(i)) {
      g.strokeStyle = 'rgba(225, 235, 245, 0.6)';
      g.lineWidth = Math.max(1, dpr);
      g.beginPath(); g.arc(x, y, r * 1.9, 0, Math.PI * 2); g.stroke();
    }
    if (showLabels) {
      g.fillStyle = 'rgba(225, 235, 245, 0.7)';
      g.fillText(stones.labels[i], x + r * 2, y - r * 1.5);
    }
  }

  const ow = `${Math.min(100, outputLevel * 100).toFixed(0)}%`;
  if (ow !== lastOutputWidth) { outputBar.style.width = ow; lastOutputWidth = ow; }
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
