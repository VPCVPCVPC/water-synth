// main.js — page side: starts audio, draws the water and the stones, turns
// touches (any number of fingers, a pen, a mouse) into gestures, and sends
// loops, stones, tuning and knob changes to the audio thread.

import {
  createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT, EV_LOOP, EV_STONE_MOVE,
  EV_VOICE, EV_VOICE_OVERRIDE, EV_TAPE,
} from './ring.js';
import {
  createVisualBuffer, VisualReader, FRAME_FLASH, FRAME_LOOPS, FRAME_TAPES, FRAME_BEAT, FRAME_HEIGHTS, LOOP_FIELDS,
} from './visuals.js';
import { buildPitches, noteLabel, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';
import { PARAMS, PARAM_KEYS, VOICE_PARAMS, VOICE_KEYS, SHARED } from './instrument.js';
import {
  TAPE_TRACKS, TAPE_FIELDS, TAPE_RECORD, TAPE_PLAY_STOP, TAPE_MUTE, TAPE_CLEAR, TAPE_CLEAR_ALL,
} from './tape.js';
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
  refreshVoice(); // a stone the editor was on may be gone
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
    if (moveMode) pickMode = false; // one pond gesture at a time
    refreshVoice(); // also tells the pond's label which mode it's in
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

// Instrument-wide knobs (the water, the looper, the tapes, the output).
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
  { group: 'water', key: 'volume', label: 'volume', map: linMap('volume'),
    show: (v) => `${v.toFixed(2)}×`, hint: 'listening level' },
  { group: 'tapes', key: 'tapeLevel', label: 'tape level', map: linMap('tapeLevel'),
    show: (v) => `${v.toFixed(2)}×`, hint: 'the tapes under (or over) the water' },
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
  const row = {
    el, readout, show, get,
    refresh: () => { input.value = Math.round(to(get()) * SLIDER_STEPS); readout.textContent = show(get()); },
    setDisabled: (off) => { input.disabled = off; el.classList.toggle('off', off); },
  };
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
    for (const k of KNOBS) if (k.group === 'water') { values[k.key] = PARAMS[k.key].def; sendParam(k.key); }
    for (const row of knobs) row.refresh();
  });
}

// ---- the voice editor's controls --------------------------------------------------------

const voiceKnobs = [];
let playingStatus = '';
let pickMode = false;
let refreshVoice = () => {};

function buildVoiceControls() {
  for (const k of VOICE_KNOBS) {
    const row = slider({
      label: k.label, hint: k.hint,
      get: () => voiceValue(k.key), set: (v) => setVoiceValue(k.key, v),
      to: k.map.to, from: k.map.from, show: k.show,
    });
    voiceKnobs.push(row);
    document.getElementById(`${k.group}-controls`).append(row.el);
  }
  const pick = document.getElementById('voice-pick');
  const all = document.getElementById('voice-all');
  const own = document.getElementById('voice-own');
  const label = document.getElementById('voice-target');
  const ownReset = document.getElementById('voice-defaults');
  ownReset.addEventListener('click', () => {
    // Only the voice the knobs show — and only if they're live.
    const target = voiceTarget === SHARED ? SHARED : overridden.has(voiceTarget) ? voiceTarget : null;
    if (target === null) return;
    for (const k of VOICE_KEYS) { voiceValues.get(target)[k] = VOICE_PARAMS[k].def; sendVoiceTo(target, k); }
    for (const row of voiceKnobs) row.refresh();
  });
  refreshVoice = () => {
    const one = voiceTarget !== SHARED && voiceTarget < stones.count;
    if (!one && voiceTarget !== SHARED) { voiceTarget = SHARED; pickMode = false; }
    const isOwn = one && overridden.has(voiceTarget);
    voiceMarks++;
    const text = one
      ? `stone ${voiceTarget + 1} · ${stones.labels[voiceTarget]}${isOwn ? ' · its own voice' : ' · still follows the shared voice'}`
      : 'all stones';
    if (label.textContent !== text) label.textContent = text; // aria-live: announce changes only
    ownReset.disabled = one && !isOwn;
    ownReset.textContent = one ? 'this stone\'s voice back to defaults' : 'shared voice back to defaults';
    own.disabled = !one;
    all.hidden = !one;
    own.textContent = isOwn ? 'back to the shared voice' : 'give it its own voice';
    own.classList.toggle('on', isOwn);
    for (const row of voiceKnobs) { row.setDisabled(one && !isOwn); row.refresh(); }
    pick.classList.toggle('on', pickMode);
    pick.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
    pick.textContent = pickMode ? 'tap a stone… (cancel)' : one ? 'pick another stone' : 'edit one stone';
    if (pickMode) status.textContent = 'tap a stone to edit its voice — the pond is quiet until you do';
    else if (status.textContent.startsWith('tap a stone')) status.textContent = playingStatus;
    surface.setAttribute('aria-label', pickMode ? 'Water surface: tap a stone to edit its voice'
      : moveMode ? 'Water surface: drag a stone to move it' : 'Water surface: touch to drop, drag to disturb');
  };
  pick.addEventListener('click', () => {
    pickMode = !pickMode;
    if (pickMode && moveMode) document.getElementById('move').click(); // one pond gesture at a time
    refreshVoice();
  });
  all.addEventListener('click', () => { voiceTarget = SHARED; pickMode = false; refreshVoice(); });
  own.addEventListener('click', () => {
    if (voiceTarget === SHARED) return;
    if (overridden.has(voiceTarget)) {
      overridden.delete(voiceTarget);
      voiceValues.delete(voiceTarget);
      sendOverride(voiceTarget, 0);
    } else {
      // An override starts as a copy of the shared voice, as the audio thread makes it.
      voiceValues.set(voiceTarget, { ...voiceValues.get(SHARED) });
      overridden.add(voiceTarget);
      sendOverride(voiceTarget, 1);
    }
    refreshVoice();
  });
  refreshVoice();
}

function refreshReadouts() {
  for (const row of knobs) row.readout.textContent = row.show(row.get()); // decay readouts depend on flow
}

// Parameters are state: a value that doesn't fit in the queue is retried each frame.
const unsent = new Set();
function sendParam(key) {
  if (!events) return;
  if (events.push(EV_PARAM, PARAM_KEYS.indexOf(key), values[key])) unsent.delete(key);
  else unsent.add(key);
}

// ---- the voice editor ------------------------------------------------------------------
//
// The voice the editor is changing: SHARED (every stone) or one stone's own.
// The page keeps its own copy of each voice's values — the audio thread owns the
// real ones and clamps whatever it is sent — and an override starts as a copy of
// the shared voice, exactly as the audio thread makes it.

let voiceTarget = SHARED;
const voiceValues = new Map([[SHARED, Object.fromEntries(VOICE_KEYS.map((k) => [k, VOICE_PARAMS[k].def]))]]);
const overridden = new Set(); // stones the page has given their own voice
let voiceMarks = 0; // bumped whenever the pond's voice marks may change (for the redraw check)

// A stone the page has not given its own voice shows (and would follow) the
// shared one; its knobs are disabled, so nothing can be sent for it.
const voiceOf = (target) => voiceValues.get(target) || voiceValues.get(SHARED);
const voiceValue = (key) => voiceOf(voiceTarget)[key];
// Voice events go out in the order they were made, through one queue that
// holds only the latest wish for each override and each knob: re-queueing an
// entry moves it to the back. If the ring is full, the rest wait for the next
// frame — in order, so a stone's edits never arrive before its override (the
// audio thread ignores edits to a stone without one).
const voiceQueue = new Map(); // "o:stone" → on (0/1); "v:target:key" → [target, key]
function queueVoice(id, item) {
  voiceQueue.delete(id);
  voiceQueue.set(id, item);
  flushVoice();
}
function flushVoice() {
  if (!events) return;
  for (const [id, item] of voiceQueue) {
    let sent = true;
    if (id[0] === 'o') sent = events.push(EV_VOICE_OVERRIDE, Number(id.slice(2)), item);
    else {
      const voice = voiceValues.get(item[0]);
      if (voice) sent = events.push(EV_VOICE, item[0], VOICE_KEYS.indexOf(item[1]), voice[item[1]]); // else: gone, nothing to send
    }
    if (!sent) return;
    voiceQueue.delete(id);
  }
}
function sendVoiceTo(target, key) { queueVoice(`v:${target}:${key}`, [target, key]); }
function sendOverride(stone, on) {
  queueVoice(`o:${stone}`, on);
  // Its values follow the override, so both sides agree however the override
  // toggles arrived.
  if (on) for (const k of VOICE_KEYS) sendVoiceTo(stone, k);
}
function sendVoice(key) { sendVoiceTo(voiceTarget, key); }
function setVoiceValue(key, v) {
  const voice = voiceValues.get(voiceTarget);
  if (!voice) return; // not an override: its knobs are disabled
  voice[key] = v;
  sendVoice(key);
}

// A voice knob's value maps are the voice's own ranges.
const voiceLin = (key) => ({
  to: (v) => (v - VOICE_PARAMS[key].min) / (VOICE_PARAMS[key].max - VOICE_PARAMS[key].min),
  from: (f) => VOICE_PARAMS[key].min + f * (VOICE_PARAMS[key].max - VOICE_PARAMS[key].min),
});
const voiceLog = (key) => ({
  to: (v) => Math.log(v / VOICE_PARAMS[key].min) / Math.log(VOICE_PARAMS[key].max / VOICE_PARAMS[key].min),
  from: (f) => VOICE_PARAMS[key].min * Math.pow(VOICE_PARAMS[key].max / VOICE_PARAMS[key].min, f),
});
const pct = (v) => `${Math.round(v * 100)}%`;
const VOICE_KNOBS = [
  // The bell: partials, decay, tick and brightness.
  { group: 'voice-bell', key: 'bellLevel', label: 'bell level', map: voiceLin('bellLevel'), show: (v) => v.toFixed(2), hint: 'how loud the bell is' },
  { group: 'voice-bell', key: 'bellDecay', label: 'bell decay', map: voiceLog('bellDecay'), show: (v) => `${v.toFixed(1)} s`, hint: 'how long a struck stone rings' },
  { group: 'voice-bell', key: 'bellTone', label: 'bell tone', map: voiceLin('bellTone'), show: (v) => v.toFixed(2), hint: 'how loud the upper partials are' },
  { group: 'voice-bell', key: 'bellPartials', label: 'clang', map: voiceLin('bellPartials'), show: (v) => (v < 0.02 ? 'bar-like' : v > 0.98 ? 'clangy' : pct(v)), hint: 'bar-like and tuneful ↔ clangy free-bar partials' },
  { group: 'voice-bell', key: 'tick', label: 'tick', map: voiceLin('tick'), show: (v) => v.toFixed(2), hint: 'the water touching the stone' },
  // How a strike shapes it.
  { group: 'voice-strike', key: 'dynamics', label: 'dynamics', map: voiceLin('dynamics'), show: (v) => `${v.toFixed(0)} dB`, hint: 'how much louder a hard strike is than a soft one' },
  { group: 'voice-strike', key: 'strikeBright', label: 'strike brightness', map: voiceLin('strikeBright'), show: (v) => pct(v), hint: 'how much brighter a harder strike is' },
  // The water holds the note.
  { group: 'voice-sustain', key: 'hold', label: 'water-held sustain', map: voiceLin('hold'), show: (v) => (v < 0.02 ? 'off' : pct(v)), hint: "how much the moving water slows the note's decay — the water holds it, never the player" },
  // The synth layer, silent until its level is raised.
  { group: 'voice-synth', key: 'synthLevel', label: 'synth level', map: voiceLin('synthLevel'), show: (v) => (v < 0.01 ? 'off' : v.toFixed(2)), hint: 'the synth layer under the bell (0 = the bell alone)' },
  { group: 'voice-synth', key: 'osc1Shape', label: 'osc 1 shape', map: voiceLin('osc1Shape'), show: (v) => shapeName(v), hint: 'sine → triangle → saw → square (morphs between)' },
  { group: 'voice-synth', key: 'osc2Shape', label: 'osc 2 shape', map: voiceLin('osc2Shape'), show: (v) => shapeName(v), hint: 'sine → triangle → saw → square (morphs between)' },
  { group: 'voice-synth', key: 'osc2Pitch', label: 'osc 2 pitch', map: voiceLin('osc2Pitch'), show: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)} st`, hint: "semitones from the stone's pitch" },
  { group: 'voice-synth', key: 'osc2Detune', label: 'osc 2 detune', map: voiceLin('osc2Detune'), show: (v) => `${v.toFixed(0)}¢`, hint: 'cents, against osc 1' },
  { group: 'voice-synth', key: 'oscMix', label: 'osc mix', map: voiceLin('oscMix'), show: (v) => (v < 0.02 ? 'osc 1' : v > 0.98 ? 'osc 2' : pct(v)), hint: 'osc 1 only ↔ osc 2 only' },
  { group: 'voice-synth', key: 'cutoff', label: 'cutoff', map: voiceLin('cutoff'), show: (v) => `${v.toFixed(1)} oct`, hint: "the low-pass, octaves above the stone's pitch" },
  { group: 'voice-synth', key: 'resonance', label: 'resonance', map: voiceLin('resonance'), show: (v) => v.toFixed(2), hint: 'how much the filter rings at its cutoff' },
  { group: 'voice-synth', key: 'filterEnv', label: 'filter envelope', map: voiceLin('filterEnv'), show: (v) => `${v.toFixed(1)} oct`, hint: 'how far a strike opens the filter' },
  { group: 'voice-synth', key: 'filterDecay', label: 'filter decay', map: voiceLog('filterDecay'), show: (v) => `${v.toFixed(2)} s`, hint: 'how long the opening takes to close' },
  { group: 'voice-synth', key: 'attack', label: 'attack', map: voiceLog('attack'), show: (v) => `${(v * 1000).toFixed(0)} ms`, hint: "the layer's fade-in" },
  { group: 'voice-synth', key: 'synthDecay', label: 'synth decay', map: voiceLog('synthDecay'), show: (v) => `${v.toFixed(1)} s`, hint: 'how long the layer rings' },
];
function shapeName(v) {
  const names = ['sine', 'triangle', 'saw', 'square'];
  const i = Math.min(3, Math.max(0, Math.round(v)));
  return v === i ? names[i] : `${names[Math.floor(v)]}→${names[Math.ceil(v)]}`;
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

// ---- tapes ---------------------------------------------------------------------------

const tapeUi = [];
function buildTapeControls() {
  const host = document.getElementById('tapes');
  for (let t = 0; t < TAPE_TRACKS; t++) {
    const row = document.createElement('div');
    row.className = 'layer';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = String(t + 1);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const mk = (text) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; buttons.append(b); return b; };
    const rec = mk('record'), play = mk('play'), mute = mk('mute'), clear = mk('clear');
    for (const [b, what] of [[rec, 'record'], [play, 'play or stop'], [mute, 'mute'], [clear, 'clear']]) b.setAttribute('aria-label', `tape ${t + 1} ${what}`);
    mute.setAttribute('aria-pressed', 'false');
    rec.addEventListener('click', () => sendTape(t, TAPE_RECORD));
    play.addEventListener('click', () => sendTape(t, TAPE_PLAY_STOP));
    mute.addEventListener('click', () => sendTape(t, TAPE_MUTE));
    confirmButton(clear, () => sendTape(t, TAPE_CLEAR));
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
    tapeUi.push({ row, rec, play, mute, pos, text, last: '', lastPos: '' });
  }
  confirmButton(document.getElementById('clear-tapes'), () => sendTape(0, TAPE_CLEAR_ALL));
}

function sendTape(track, action) {
  if (events) events.push(EV_TAPE, track, action);
}

// Show each tape's state from the latest frame (only touching the DOM on change).
function updateTapes(frame) {
  for (let t = 0; t < TAPE_TRACKS; t++) {
    const o = FRAME_TAPES + t * TAPE_FIELDS;
    const state = frame[o], muted = frame[o + 1], length = frame[o + 2], pos = frame[o + 3], waiting = frame[o + 4], fading = frame[o + 5];
    const ui = tapeUi[t];
    const width = state === PLAYING || state === OVERDUB
      ? `${Math.min(100, (pos / Math.max(1e-3, length)) * 100).toFixed(0)}%` : state === RECORDING ? '100%' : '0';
    if (width !== ui.lastPos) { ui.pos.style.width = width; ui.lastPos = width; }
    let text = state === EMPTY ? 'empty' : `${length.toFixed(1)} s`;
    if (state === RECORDING) text = `recording ${length.toFixed(1)} s`;
    if (state === STOPPED) text += ' · stopped';
    if (muted) text += ' · muted';
    if (waiting) text += ' · waiting for the bar';
    if (state === OVERDUB) text += ' · overdubbing';
    if (fading === 1) text += ' · stopping';
    if (fading === 2) text += ' · clearing';
    const key = `${state}|${muted}|${text}`;
    if (key === ui.last) continue;
    ui.last = key;
    ui.text.textContent = text;
    ui.row.classList.toggle('recording', state === RECORDING || state === OVERDUB);
    ui.rec.textContent = state === EMPTY ? 'record' : state === RECORDING ? 'finish' : state === OVERDUB ? 'end overdub' : 'overdub';
    ui.rec.setAttribute('aria-label', `tape ${t + 1} ${ui.rec.textContent}`);
    ui.rec.classList.toggle('rec', state === RECORDING || state === OVERDUB);
    ui.play.textContent = state === PLAYING || state === OVERDUB ? 'stop' : state === RECORDING ? 'finish' : 'play';
    ui.play.setAttribute('aria-label', `tape ${t + 1} ${ui.play.textContent}`);
    ui.play.disabled = state === EMPTY;
    ui.mute.classList.toggle('on', Boolean(muted));
    ui.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    ui.mute.disabled = state === EMPTY;
  }
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
buildVoiceControls();
buildLoopControls();
buildTapeControls();
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
    liveTapes: () => Array.from({ length: TAPE_TRACKS }, (_, t) => Array.from(live.subarray(FRAME_TAPES + t * TAPE_FIELDS, FRAME_TAPES + (t + 1) * TAPE_FIELDS))),
  };

  for (const k of Object.keys(PARAMS)) sendParam(k);
  for (const k of VOICE_KEYS) sendVoice(k);
  retune();
  requestAnimationFrame(draw); // draw even if iOS holds the resume back
  status.textContent = 'waking the water…';
  await resumed;
  playingStatus = `${ctx.sampleRate} Hz · touch to drop, drag to disturb — any number of fingers`;
  status.textContent = playingStatus;
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
  if (pickMode) { // choosing which stone the voice editor is changing
    const i = nearestStone(e);
    pickMode = false;
    if (i >= 0) {
      voiceTarget = i;
      refreshVoice();
      document.getElementById('voice').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    refreshVoice(); // a miss: back to playing, and this touch plays (the water is never dead)
  }
  if (moveMode) {
    const i = nearestStone(e);
    if (i >= 0) grabs.set(e.pointerId, i);
    return;
  }
  // Apple Pencil pressure sets strength (with a floor: first-contact pressure
  // is often low); fingers and mice are a fixed-strength drop.
  const strength = e.pointerType === 'pen' && e.pressure > 0 ? 0.6 + 1.4 * e.pressure : 1;
  events.push(EV_DROP, p.x, p.y, strength);
  // With quantize on, a touch just before a grid point waits for it (the
  // audio thread decides; this mirrors it): show where it will land.
  const hold = heldFor();
  if (hold > 0.02) pending.push({ x: p.x, y: p.y, from: performance.now(), until: performance.now() + hold * 1000 });
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
let beatAt = -1, beatTime = 0; // beats since the grid began, at the latest frame (and when it came)
let beatNow = -1; // the beat as last drawn
const pending = []; // touches waiting for the grid: { x, y, from, until } (ms)

// How long (s) a touch made now waits for the grid — the page's mirror of the
// looper's liveStep (nearest grid point, swing on every second; only a point
// ahead holds it, by the quantize strength).
function heldFor() {
  if (!values.quantize || beatNow < 0 || values.quantizeStrength <= 0) return 0;
  const t = beatNow * values.grid, k = Math.round(t);
  const target = k + (((k % 2) + 2) % 2 === 1 ? values.swing : 0);
  if (!(target > t)) return 0;
  return (values.quantizeStrength * (target - t) * 60) / (values.bpm * values.grid);
}
let outputLevel = 0, lastFrameTime = 0, lastOutputWidth = '', lastSize = '', lastFrameEnergy = -1;

function draw(now) {
  if (stonesUnsent) sendStones();
  for (const key of unsent) sendParam(key);
  if (voiceQueue.size) flushVoice();
  const dt = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0;
  lastFrameTime = now;

  let frame = visuals.read();
  // The beat (when quantize is on) comes with every frame, still water or not;
  // between frames it's carried forward at the tempo.
  if (frame) { beatAt = frame[FRAME_BEAT]; beatTime = now; }
  const beating = values.quantize === 1 && beatAt >= 0;
  const beat = beating ? beatAt + ((now - beatTime) / 1000) * (values.bpm / 60) : -1;
  beatNow = beat;
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].until <= now) pending.splice(i, 1);
  // A frame of perfectly still water after another one changes nothing on screen.
  if (frame && frame[0] === 0 && lastFrameEnergy === 0 && frame[1] === 0) frame = null;
  if (frame) lastFrameEnergy = frame[0];
  const fade = Math.pow(0.02, dt); // a flash fades to 2% in a second
  let glowing = false;
  for (let i = 0; i < flashShown.length; i++) { flashShown[i] *= fade; if (flashShown[i] > 0.01) glowing = true; }
  // Nothing new, nothing fading, nothing held: skip the redraw (battery).
  const size = `${surface.clientWidth}x${surface.clientHeight}x${rotated}x${moveMode}x${showLabels}x${pickMode}x${voiceTarget}x${voiceMarks}`;
  if (!frame && !glowing && !beating && !pending.length && grabs.size === 0 && size === lastSize) { requestAnimationFrame(draw); return; }
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
    updateTapes(frame);
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
  // move mode, stones are larger targets and hand-placed ones are ringed. A
  // stone with its own voice has an amber centre; the one the voice editor
  // is on has an amber ring (stones are larger targets while picking one).
  const r = Math.max(2, Math.max(w, h) / 180) * (moveMode || pickMode ? 1.8 : 1);
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
    if (overridden.has(i)) { // its own voice: an amber rim, visible at any size
      g.strokeStyle = 'rgba(255, 196, 110, 0.95)';
      g.lineWidth = Math.max(1.5, 1.2 * dpr);
      g.beginPath(); g.arc(x, y, r + g.lineWidth, 0, Math.PI * 2); g.stroke();
    }
    if (i === voiceTarget) {
      g.strokeStyle = 'rgba(255, 196, 110, 0.9)';
      g.lineWidth = Math.max(1.5, 1.5 * dpr);
      g.beginPath(); g.arc(x, y, r * 2.4, 0, Math.PI * 2); g.stroke();
    }
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

  // A touch waiting for the beat: a faint ring at the touch point that closes
  // in as its moment comes (then the ripple itself takes over).
  for (const m of pending) {
    const c = toCanvas(m.x, m.y), left = Math.max(0, (m.until - now) / (m.until - m.from));
    g.strokeStyle = `rgba(200, 230, 255, ${(0.25 + 0.45 * (1 - left)).toFixed(3)})`;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.arc(c.u * w, c.v * h, (4 + 14 * left) * dpr, 0, Math.PI * 2); g.stroke();
  }

  // The beat: the pond's rim pulses on every beat, brighter on each bar's first.
  if (beating) {
    const frac = beat - Math.floor(beat), downbeat = ((Math.floor(beat) % 4) + 4) % 4 === 0;
    const pulse = Math.exp(-frac * 7) * (downbeat ? 1 : 0.55);
    if (pulse > 0.01) {
      g.strokeStyle = `rgba(150, 205, 255, ${(0.85 * pulse).toFixed(3)})`;
      g.lineWidth = (2 + 4 * pulse) * dpr;
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
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
