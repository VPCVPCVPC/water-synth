// main.js — page side: starts audio, draws the water and the stones, turns
// touches (any number of fingers, a pen, a mouse) into gestures, and sends
// loops, stones, tuning and knob changes to the audio thread.

import {
  createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT, EV_STONE_MOVE,
  EV_VOICE, EV_VOICE_OVERRIDE, EV_TAPE, EV_STONE_TUNE, EV_STILL, EV_TAPE_FADER, EV_STIR,
} from './ring.js';
import {
  createVisualBuffer, VisualReader, FRAME_FLASH, FRAME_LOOPS, FRAME_TAPES, FRAME_BEAT, FRAME_HEIGHTS, LOOP_FIELDS,
} from './visuals.js';
import { buildPitches, noteLabel, SCALES, pitchAtX, PITCH_MARGIN } from './tuning.js';
import { stonePositions } from './layout.js';
import { PARAMS, PARAM_KEYS, VOICE_PARAMS, VOICE_KEYS, SHARED } from './instrument.js';
import {
  TAPE_TRACKS, TAPE_FIELDS, TAPE_RECORD, TAPE_PLAY_STOP, TAPE_MUTE, TAPE_CLEAR, TAPE_CLEAR_ALL,
} from './tape.js';
import { REFERENCE_SPEED, SURFACE_W, SURFACE_H, SIM_RATE, MAX_HANDS, HAND_RADIUS } from './surface.js';
import { MAX_STONES } from './stones.js';
import { PieceRecorder, pieceName, MAX_RECORD_SECONDS } from './record.js';
import { FEEDBACK_URL } from './config.js';
import { Animator } from './animate.js';
import { CameraMotion } from './camera.js';
import { MotionGestures } from './motion.js';
import { RANGE_LOW, RANGE_HIGH, REF_MIN_HZ, REF_MAX_HZ } from './tuning-limits.js';
import {
  LOOP_LAYERS, EMPTY, RECORDING, PLAYING, OVERDUB, STOPPED,
} from './looper.js';

const SAMPLE_RATE = 48000;
const GRID_W = SURFACE_W, GRID_H = SURFACE_H; // the water's cells
const ASPECT = GRID_H / GRID_W;
const STONE_HIT_MOUSE_PX = 10, STONE_HIT_TOUCH_PX = 18; // how close a tap must be to pick up a stone
const LIFT_TAP_MS = 300; // a press on a stone shorter than this (and still) lifts it
const LIFT_TIMEOUT_MS = 5000; // a lifted stone left alone goes back down
const HOLD_MS = 350; // a press held this long without moving becomes Still: a hand resting on the water
const HOLD_MOVE_PX = 8; // moving further than this first makes it a drag instead

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const outputBar = document.getElementById('output');

let events = null;
let visuals = null;
let ctx = null;

// ---- the control pages: tabs and swipes ------------------------------------------------------
//
// On a phone or tablet the controls are one strip of pages: tap a tab, or
// swipe the page sideways. On a wide screen only water and stones are tabs
// (the strip along the pond's bottom); the other pages always show.
const PAGES = ['water', 'stones', 'beat', 'tuning', 'voice', 'tape'];
const TAB_KEY = 'water-synth.tab';
const wideLayout = window.matchMedia('(min-width: 1000px) and (min-height: 600px)');
let page = 'water';
function showPage(name, { focus = false } = {}) {
  if (!PAGES.includes(name)) return;
  const from = PAGES.indexOf(page), to = PAGES.indexOf(name);
  page = name;
  for (const n of PAGES) {
    const tab = document.getElementById(`tab-${n}`), panel = document.getElementById(`page-${n}`), on = n === name;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    panel.classList.toggle('active', on);
    panel.classList.remove('in-right', 'in-left');
  }
  const panel = document.getElementById(`page-${name}`);
  if (to !== from) { void panel.offsetWidth; panel.classList.add(to > from ? 'in-right' : 'in-left'); }
  if (focus) document.getElementById(`tab-${name}`).focus();
  // Tabs stuck to the top of a long page: show the new page from its start.
  const tabs = document.querySelector('.tabs');
  const tab = document.getElementById(`tab-${name}`); // very narrow, the tabs scroll: keep this one in view
  if (tab.offsetLeft < tabs.scrollLeft) tabs.scrollLeft = tab.offsetLeft;
  else if (tab.offsetLeft + tab.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = tab.offsetLeft + tab.offsetWidth - tabs.clientWidth;
  if (to !== from && !wideLayout.matches && tabs.getBoundingClientRect().top <= 1) {
    window.scrollBy(0, document.getElementById('pages').getBoundingClientRect().top - tabs.getBoundingClientRect().height);
  }
  try { localStorage.setItem(TAB_KEY, name); } catch { /* storage off: fine */ }
}
// The tabs that show: on a wide screen only the strip's (water, stones).
const STRIP = ['water', 'stones'];
const visibleTabs = () => (wideLayout.matches ? STRIP : PAGES);
for (const tab of document.querySelectorAll('.tabs [role=tab]')) {
  tab.addEventListener('click', () => showPage(tab.dataset.page));
  tab.addEventListener('keydown', (e) => { // arrow keys move between tabs
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const tabs = visibleTabs();
    if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); showPage(tabs[e.key === 'Home' ? 0 : tabs.length - 1], { focus: true }); }
    if (!step) return;
    e.preventDefault();
    showPage(tabs[(tabs.indexOf(page) + step + tabs.length) % tabs.length], { focus: true });
  });
}
// A sideways swipe on the pages turns the page (a dial, a slider or a field
// keeps its own drag).
{
  const pagesEl = document.getElementById('pages');
  let swipe = null;
  pagesEl.addEventListener('pointerdown', (e) => {
    if (wideLayout.matches || e.pointerType === 'mouse' || !e.isPrimary) return;
    if (e.target.closest('.knob svg, input, select, textarea, video')) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp };
  });
  pagesEl.addEventListener('pointerup', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y, quick = e.timeStamp - swipe.at < 800;
    swipe = null;
    if (!quick || Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy)) return;
    const i = PAGES.indexOf(page) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < PAGES.length) showPage(PAGES[i]);
  });
  pagesEl.addEventListener('pointercancel', () => { swipe = null; });
}
{
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch { /* storage off */ }
  page = PAGES.includes(saved) ? saved : 'water';
  showPage(page);
}
// On a wide screen only water and stones share the strip (the rest always
// show), so one of them is the page — and the always-shown ones are plain
// regions, not tab panels.
function fitPages() {
  const wide = wideLayout.matches;
  if (wide && !STRIP.includes(page)) showPage('water');
  for (const n of PAGES) {
    if (STRIP.includes(n)) continue;
    const panel = document.getElementById(`page-${n}`);
    panel.setAttribute('role', wide ? 'region' : 'tabpanel');
    if (wide) { panel.removeAttribute('aria-labelledby'); panel.setAttribute('aria-label', n); } else { panel.removeAttribute('aria-label'); panel.setAttribute('aria-labelledby', `tab-${n}`); }
  }
}
fitPages();
wideLayout.addEventListener('change', fitPages);

// iOS pauses audio on a lock, a call or an app switch; the next touch (or
// coming back to the page) brings it back.
function wake() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  // The camera is off while the page is hidden (nothing looks while no one plays).
  if (document.hidden) { camera.stop(); showCamera(); return; }
  syncCamera(); // back: the camera comes on again if something uses it
  wake();
  if (recorder && recorder.recording) recorder.drain(); // catch up at once after being hidden
});

// The pond is landscape (128 × 97). On a portrait screen it's shown turned a
// quarter-turn so it fills the height; touches and drawing map through the
// turn, so the water itself is the same either way.
let rotated = false;
function fitOrientation() {
  rotated = window.innerHeight > window.innerWidth && !wideLayout.matches;
  surface.style.aspectRatio = rotated ? `${GRID_H} / ${GRID_W}` : `${GRID_W} / ${GRID_H}`;
  document.getElementById('instrument').classList.toggle('rotated', rotated); // the page's CSS sizes the pond
}
fitOrientation();
window.addEventListener('resize', () => { fitOrientation(); fitPages(); });

// Pond coordinates (x, y in [0, 1]) ↔ canvas coordinates (u, v in [0, 1]).
// Upright, the pond turns a quarter so its left (low notes) is at the bottom
// and its right (high notes) at the top.
const toCanvas = (x, y) => (rotated ? { u: y, v: 1 - x } : { u: x, v: y });
const fromCanvas = (u, v) => (rotated ? { x: 1 - v, y: u } : { x: u, y: v });

// Two taps to confirm anything that can't be undone.
function confirmButton(button, action) {
  let armed = 0, saved = null, savedAria = null;
  const restore = () => {
    clearTimeout(armed); armed = 0;
    if (saved) button.replaceChildren(...saved);
    if (savedAria !== null) button.setAttribute('aria-label', savedAria);
    saved = null; savedAria = null;
    button.classList.remove('confirm');
  };
  button.disarm = () => { if (armed) restore(); };
  button.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      restore();
      action();
    } else {
      saved = [...button.childNodes]; // keeps a key's glyph and label
      savedAria = button.getAttribute('aria-label');
      if (savedAria !== null) button.setAttribute('aria-label', `${savedAria}: tap again to confirm`);
      button.textContent = 'tap again'; button.classList.add('confirm');
      armed = setTimeout(restore, 2500);
    }
  });
}

// ---- tuning and stones ---------------------------------------------------------------

const ROOTS = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const tuning = { scale: 'pentatonicMajor', root: 0, low: 48, high: 84, refHz: 440, stoneCount: 0 }; // stoneCount 0: one per note
const layout = { seed: 0, spread: 1 };
const placed = new Map(); // stone index → { x, y } placed by hand
let stones = { xs: new Float64Array(0), ys: new Float64Array(0), hzs: [], labels: [], count: 0 };
let stonesUnsent = false;

let notesInRange = 0, stoneCountKnob = null; // scale notes in the range; the stone-count knob
let scaleNotes = []; // the scale notes in range, low to high — where a stone sits picks one
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
  notesInRange = pitches.length;
  scaleNotes = pitches;
  const count = tuning.stoneCount || notesInRange;
  stoneNote();
  if (stoneCountKnob) stoneCountKnob.refresh();
  // The stones stay where they are (a retune never moves them — they may be
  // mid-animation); only a change in count lays out the new set.
  const kept = stones.count === count && stones.xs ? { xs: stones.xs, ys: stones.ys } : placeStones(count);
  stones = withPitches({ ...kept, count });
  sendStones();
  refreshVoice(); // a stone the editor was on may be gone
}

// "16 notes in range · 16 stones · low left, high right" (or bottom → top upright).
function stoneNote() {
  if (!notesInRange) return;
  setTuningNote(`${notesInRange} notes in range · ${tuning.stoneCount || notesInRange} stones · ${rotated ? 'low at the bottom, high at the top' : 'low left, high right'}`);
}
window.addEventListener('resize', stoneNote); // turning the phone turns the pond

// Scattered positions, except stones placed by hand, which stay put.
function placeStones(count) {
  const { xs, ys } = stonePositions(count, layout);
  for (const [i, p] of placed) if (i < count) { xs[i] = p.x; ys[i] = p.y; }
  return { xs, ys };
}

function rearrange() {
  stones = withPitches({ ...stones, ...placeStones(stones.count) });
  sendStones();
}

// Each stone's note from where it sits (left low → right high, on the scale).
function withPitches(st) {
  const ps = Array.from(st.xs, (x) => pitchAtX(scaleNotes, x));
  return { ...st, hzs: ps.map((p) => p.hz), labels: ps.map((p) => p.label) };
}
// A stone that moved: if it crossed into another note's place, it takes that
// note (from its next strike).
function repitch(i) {
  const x = stones.xs[i], p = pitchAtX(scaleNotes, x);
  if (!p || p.hz === stones.hzs[i]) return;
  // A little give at each band edge: a stone resting on the line between two
  // notes doesn't flicker between them.
  const give = 0.15 * (1 - 2 * PITCH_MARGIN) / Math.max(1, scaleNotes.length);
  const near = [pitchAtX(scaleNotes, x - give), pitchAtX(scaleNotes, x + give)];
  if (near.some((q) => q && q.hz === stones.hzs[i])) return;
  stones.hzs[i] = p.hz;
  stones.labels[i] = p.label;
  voiceMarks++;
  if (events && !events.push(EV_STONE_TUNE, i, p.hz)) stonesUnsent = true; // the full set goes again next frame
  if (i === voiceTarget) refreshVoice();
}

// Each stone is one event, then a commit makes them live together. If the
// queue is full, try the whole set again next frame.
function sendStones() {
  if (!events) return;
  for (let i = 0; i < stones.count; i++) {
    if (!events.push(EV_STONE, i, stones.xs[i], stones.ys[i], stones.hzs[i])) { stonesUnsent = true; return; }
  }
  stonesUnsent = !events.push(EV_STONES_COMMIT, stones.count);
  sentXs = Float64Array.from(stones.xs); sentYs = Float64Array.from(stones.ys); // animate has nothing to resend
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

// Stones are picked up by tapping them (see the pond's pointer handling).
function buildStoneControls() {
  document.getElementById('randomize').addEventListener('click', () => { layout.seed++; rearrange(); });
  confirmButton(document.getElementById('release'), () => { placed.clear(); rearrange(); });
  // Spread: gathered ↔ spread evenly over the whole pond.
  const count = knob({
    label: 'stones', hint: 'how many stones: all (one per scale note in the range), fewer (spread over the range), or more (notes repeat in other places)',
    // "All" (one per note) is the detent at the number of notes in range, so
    // turning goes …14, 15, all (16), 17…
    get: () => tuning.stoneCount || notesInRange || 1,
    set: (v) => { tuning.stoneCount = v === notesInRange ? 0 : v; retune(); }, def: () => notesInRange || 1,
    to: (v) => (v - 1) / (MAX_STONES - 1), from: (f) => 1 + Math.round(f * (MAX_STONES - 1)),
    steps: MAX_STONES - 1,
    show: (v) => (v === notesInRange ? `all · ${v}` : String(v)),
  });
  stoneCountKnob = count;
  const row = knob({
    label: 'spread', hint: 'gathered in loose clumps ↔ spread evenly over the whole pond',
    get: () => layout.spread, set: (v) => { layout.spread = v; rearrange(); }, def: 1,
    to: (v) => v, from: (f) => f, show: (v) => (v > 0.95 ? 'even' : v < 0.05 ? 'gathered' : `${Math.round(v * 100)}`),
  });
  const motionKnob = knob({
    label: 'motion', hint: 'how fast animated stones move',
    get: () => animator.speed, set: (v) => { animator.speed = v; }, def: 0.2,
    to: (v) => v, from: (f) => f, show: (v) => `${Math.round(v * 100)}`,
  });
  document.getElementById('stone-controls').append(count.el, row.el, motionKnob.el);
  buildAnimateControls();
  if (restoredAnimate !== 'off') setAnimate(restoredAnimate);
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
  { group: 'tapes', key: 'tapeLevel', label: 'level', map: linMap('tapeLevel'),
    show: (v) => `${v.toFixed(2)}×`, hint: 'the tape under (or over) the live water' },
  { group: 'quantize', key: 'quantizeStrength', label: 'strength', map: linMap('quantizeStrength'),
    show: (v) => (v >= 0.995 ? 'snap' : v <= 0.005 ? 'as played' : `lean ${Math.round(v * 100)}%`), hint: 'how far touches and notes move toward the beat' },
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

// A knob, after the logo's concentric rings: faint inner rings, the value as
// an arc on the outer ring, and a pointer. Drag up/down (or sideways) to turn
// — Shift for fine — double-tap to return to `def`, arrow keys step it. Same
// interface as slider(): { el, readout, show, get, refresh, setDisabled }.
const KNOB_SWEEP = 270; // degrees, from 7:30 to 4:30
const knobArc = (f) => {
  const a0 = (-KNOB_SWEEP / 2 - 90) * (Math.PI / 180), a1 = a0 + f * KNOB_SWEEP * (Math.PI / 180), R = 18;
  const p = (a) => `${(20 + R * Math.cos(a)).toFixed(2)} ${(20 + R * Math.sin(a)).toFixed(2)}`;
  return f <= 0.001 ? '' : `M ${p(a0)} A ${R} ${R} 0 ${f * KNOB_SWEEP > 180 ? 1 : 0} 1 ${p(a1)}`;
};
function knob({ label, hint, get, set, to, from, show, def, steps = 0 }) {
  const el = document.createElement('div');
  el.className = 'knob';
  el.title = hint;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-description', hint);
  el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
  el.innerHTML = `<svg viewBox="0 0 40 40" aria-hidden="true">
    <circle class="ring" cx="20" cy="20" r="18"/><circle class="ring faint" cx="20" cy="20" r="12.5"/>
    <circle class="ring faint" cx="20" cy="20" r="7"/><path class="arc"/><line class="pointer" x1="20" y1="20" x2="20" y2="6"/></svg>
    <span class="knob-label"></span><output class="knob-value"></output>`;
  el.querySelector('.knob-label').textContent = label;
  const dial = el.querySelector('svg'); // only the dial turns; the label and value scroll the page
  const arc = el.querySelector('.arc'), pointer = el.querySelector('.pointer'), readout = el.querySelector('.knob-value');
  let disabled = false;
  const frac = () => Math.min(1, Math.max(0, to(get())));
  const paint = () => {
    const f = frac();
    arc.setAttribute('d', knobArc(f));
    pointer.setAttribute('transform', `rotate(${(-KNOB_SWEEP / 2 + f * KNOB_SWEEP).toFixed(1)} 20 20)`);
    readout.textContent = show(get());
    el.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    el.setAttribute('aria-valuetext', show(get()));
  };
  const setFrac = (f) => {
    if (disabled) return;
    const v = from(Math.min(1, Math.max(0, f)));
    if (v === get()) return; // nothing changed (e.g. a whole-number knob between steps)
    set(v);
    refreshReadouts();
    paint();
  };
  const hintHere = () => showHint(el, label, hint);
  // Turning: vertical and horizontal movement both count (up/right = more).
  // A tap (moved < 4 px) right after another tap returns it to its default.
  let drag = null, lastTap = 0;
  dial.addEventListener('pointerdown', (e) => {
    if (disabled) return;
    el.focus({ preventScroll: true });
    hintHere();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, f: frac(), shift: e.shiftKey, moved: 0, at: performance.now() };
    try { dial.setPointerCapture(e.pointerId); } catch { /* gone */ }
    e.preventDefault();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (e.shiftKey !== drag.shift) { // fine/coarse changed: carry on from here
      Object.assign(drag, { x: e.clientX, y: e.clientY, f: frac(), shift: e.shiftKey });
      return;
    }
    const px = (drag.y - e.clientY) + (e.clientX - drag.x);
    drag.moved = Math.max(drag.moved, Math.abs(px));
    setFrac(drag.f + px / (e.shiftKey ? 900 : 180));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = drag.moved < 4 && e.type === 'pointerup';
    drag = null;
    if (!tap) { lastTap = 0; return; }
    const now = performance.now();
    if (now - lastTap < 320 && def !== undefined) { setFrac(to(typeof def === 'function' ? def() : def)); lastTap = 0; }
    else lastTap = now;
  };
  dial.addEventListener('pointerup', end);
  dial.addEventListener('pointercancel', end);
  el.addEventListener('focus', hintHere);
  el.addEventListener('keydown', (e) => {
    const unit = steps > 0 ? 1 / steps : 0;
    let step = { ArrowUp: 0.01, ArrowRight: 0.01, ArrowDown: -0.01, ArrowLeft: -0.01, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step !== undefined) {
      step *= e.shiftKey ? 0.2 : 1;
      if (unit && Math.abs(step) < unit) step = Math.sign(step) * unit; // a whole-number knob always moves one
      setFrac(frac() + step); e.preventDefault();
    }
    else if (e.key === 'Home') { setFrac(0); e.preventDefault(); }
    else if (e.key === 'End') { setFrac(1); e.preventDefault(); }
  });
  const row = {
    el, readout, show, get, refresh: paint,
    setDisabled: (off) => { disabled = off; el.classList.toggle('off', off); el.setAttribute('aria-disabled', off ? 'true' : 'false'); },
  };
  paint();
  return row;
}

// Each section has one hint line: what the knob last touched or focused does
// (touch screens never show tooltips).
function showHint(el, label, hint) {
  const box = el.closest('fieldset, section');
  if (!box) return;
  let line = box.querySelector('.hint-line');
  if (!line) { line = document.createElement('div'); line.className = 'note hint-line'; }
  // Right under the group of knobs just touched (the synth layer's included).
  const group = el.closest('.knobs') || el;
  if (line.previousElementSibling !== group) group.after(line);
  line.textContent = `${label} — ${hint}`;
}

function buildKnobs() {
  for (const k of KNOBS) {
    const make = k.group === 'tapes' ? slider : knob; // the tape's level stays a fader
    const row = make({
      label: k.label, hint: k.hint, get: () => values[k.key], def: PARAMS[k.key].def,
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
let refreshVoice = () => {};
let lastSelected = -1; // the stone last tapped on the pond (−1: none yet)
let drawingPointer = -1; // the finger drawing an animate path
let sentXs = new Float64Array(0), sentYs = new Float64Array(0); // where animate last sent each stone
const grabs = new Map(); // pointerId → { i, x, y, moved, at } — a press that began on a stone
let heldStone = -1; // the lifted stone, waiting for a tap to put it down
let hover = null; // the mouse over the pond while a stone is lifted (a preview of where it goes)
// Animate's state (see "animate" below), declared here so the controls built
// at startup can read it.
const animator = new Animator(crypto.getRandomValues(new Uint32Array(1))[0] || 1);
const camera = new CameraMotion(document.getElementById('camera'));
let cameraRipples = false; // "camera" in the bar: movement makes ripples (see syncCamera)
const motionGestures = new MotionGestures();
const camMarks = []; // where camera gestures landed lately: { x, y, at } (pond terms)
// (Declared here, before the page is built: a restored Animate mode calls
// syncCamera() during startup.)
let cameraAsk = 0; // which camera start is the latest (an older one's answer is ignored)
let statusBack = 0; // the timer that puts the status line back after a camera message
let pathDrawing = false, pathPoints = [], heightsFrame = null, lastAnimSend = 0, restoredAnimate = 'off';

function buildVoiceControls() {
  for (const k of VOICE_KNOBS) {
    const row = knob({
      label: k.label, hint: k.hint,
      get: () => voiceValue(k.key), set: (v) => setVoiceValue(k.key, v), def: VOICE_PARAMS[k.key].def,
      to: k.map.to, from: k.map.from, show: k.show,
    });
    voiceKnobs.push(row);
    document.getElementById(`${k.group}-controls`).append(row.el);
  }
  const one = document.getElementById('voice-one');
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
    if (lastSelected >= stones.count) lastSelected = -1;
    if (heldStone >= stones.count) heldStone = -1;
    for (const [id, gr] of grabs) if (gr.i >= stones.count) grabs.delete(id);
    const isOne = voiceTarget !== SHARED && voiceTarget < stones.count;
    if (!isOne && voiceTarget !== SHARED) voiceTarget = SHARED;
    const isOwn = isOne && overridden.has(voiceTarget);
    voiceMarks++;
    const text = isOne
      ? `stone ${voiceTarget + 1} · ${stones.labels[voiceTarget]}${isOwn ? ' · its own voice' : ' · follows the shared voice'}`
      : lastSelected < 0 ? 'all stones · tap a stone on the pond to select it' : 'all stones';
    if (label.textContent !== text) label.textContent = text; // aria-live: announce changes only
    ownReset.disabled = isOne && !isOwn;
    ownReset.textContent = isOne ? 'this stone\'s voice back to defaults' : 'shared voice back to defaults';
    own.hidden = !isOne;
    own.textContent = isOwn ? 'back to the shared voice' : 'give it its own voice';
    own.classList.toggle('on', isOwn);
    for (const row of voiceKnobs) { row.setDisabled(isOne && !isOwn); row.refresh(); }
    all.setAttribute('aria-pressed', isOne ? 'false' : 'true');
    one.setAttribute('aria-pressed', isOne ? 'true' : 'false');
    if (lastSelected < 0 && document.activeElement === one) all.focus(); // never lose focus to a disabled button
    one.disabled = lastSelected < 0;
    const lifted = heldStone >= 0 ? `stone ${heldStone + 1} lifted — tap the water to put it down, or the stone to put it back` : '';
    if (lifted) status.textContent = lifted;
    else if (status.textContent.startsWith('stone ')) status.textContent = playingStatus;
    surface.setAttribute('aria-label', heldStone >= 0 ? 'Water surface: tap to put the lifted stone down'
      : 'Water surface: touch to drop, drag to disturb; tap a stone to pick it up');
  };
  all.addEventListener('click', () => { voiceTarget = SHARED; refreshVoice(); });
  one.addEventListener('click', () => { if (lastSelected >= 0) { voiceTarget = lastSelected; refreshVoice(); } });
  own.addEventListener('click', () => {
    if (voiceTarget === SHARED) return;
    if (overridden.has(voiceTarget)) {
      overridden.delete(voiceTarget);
      voiceValues.delete(voiceTarget);
      sendOverride(voiceTarget, 0);
    } else {
      giveOwnVoice(voiceTarget);
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
// An override starts as a copy of the shared voice, as the audio thread makes it.
function giveOwnVoice(stone) {
  voiceValues.set(stone, { ...voiceValues.get(SHARED) });
  overridden.add(stone);
  sendOverride(stone, 1);
}

function setVoiceValue(key, v) {
  const voice = voiceValues.get(voiceTarget);
  if (!voice) return; // not an override: its knobs are disabled
  voice[key] = v;
  sendVoice(key);
}

// ---- saved voices ---------------------------------------------------------------------
//
// Voices you designed, by name, kept in this browser (no presets ship). "use"
// puts one on the voice the editor shows; a stone that still follows the
// shared voice gets its own first. Storage can be missing or full (a private
// window): the page works without it and says so.

const SAVED_KEY = 'water-synth.voices';
const SAVED_NOTE = 'Your saved voices live in this browser. "use" puts one on the voice you\'re editing (a stone that still follows the shared voice gets its own).';
// Saved voices as a Map (names are any text — "constructor" or "__proto__"
// included — so never keys on a plain object). Entries that aren't objects
// are dropped. null when storage can't be read.
function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    const pairs = Array.isArray(raw) ? raw : Object.entries(raw || {}); // [[name, voice], …] (or an older object)
    return new Map(pairs.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && p[1] && typeof p[1] === 'object'));
  } catch { return null; }
}
function storeSaved(all) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...all])); return true; } catch { return false; }
}
// A saved voice back to values: only known keys, clamped; anything that isn't
// a number defaults.
function voiceFrom(saved) {
  const out = {};
  for (const k of VOICE_KEYS) {
    const p = VOICE_PARAMS[k], v = saved[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def;
  }
  return out;
}
function useVoice(saved) {
  if (voiceTarget !== SHARED && !overridden.has(voiceTarget)) giveOwnVoice(voiceTarget); // its own voice first
  const voice = voiceValues.get(voiceTarget);
  if (!voice) return;
  Object.assign(voice, voiceFrom(saved));
  for (const k of VOICE_KEYS) sendVoiceTo(voiceTarget, k);
  refreshVoice();
}
function buildSavedVoices() {
  const name = document.getElementById('voice-name'), save = document.getElementById('voice-save');
  const list = document.getElementById('voice-saved'), note = document.getElementById('voice-saved-note');
  const say = (ok, msg) => { note.textContent = ok ? SAVED_NOTE : msg; };
  const render = () => {
    const all = loadSaved();
    if (!all) say(false, "This browser isn't keeping data (a private window?), so voices can't be saved here.");
    const names = all ? [...all.keys()].sort((a, b) => a.localeCompare(b)) : [];
    list.replaceChildren(...names.map((n) => {
      const row = document.createElement('div');
      row.className = 'saved';
      const label = document.createElement('span');
      label.textContent = n;
      const use = document.createElement('button'), del = document.createElement('button');
      use.type = del.type = 'button';
      use.textContent = 'use'; del.textContent = 'delete';
      use.setAttribute('aria-label', `use the voice ${n}`);
      use.addEventListener('click', () => { const v = loadSaved()?.get(n); if (v) useVoice(v); });
      confirmButton(del, () => {
        const a = loadSaved();
        if (!a) return;
        a.delete(n);
        say(storeSaved(a), "Couldn't delete it (this browser isn't keeping data).");
        render();
      });
      row.append(label, use, del);
      return row;
    }));
    const n = name.value.trim();
    save.textContent = n && all && all.has(n) ? 'replace' : 'save voice';
    save.disabled = !n || !all;
  };
  name.addEventListener('input', render);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save.click(); });
  save.addEventListener('click', () => {
    const n = name.value.trim(), all = loadSaved();
    if (!n || !all) return;
    all.set(n, { ...voiceOf(voiceTarget) });
    const ok = storeSaved(all);
    say(ok, "Couldn't save here (this browser isn't keeping data — a private window?).");
    if (ok) name.value = '';
    render();
  });
  render();
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
  { group: 'voice-synthlevel', key: 'synthLevel', label: 'synth layer', map: voiceLin('synthLevel'), show: (v) => (v < 0.01 ? 'off' : v.toFixed(2)), hint: 'a synth under the bell — off until you raise it; shape it below' },
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

// The Tape (Dash): a four-track machine that records the water's sound and
// plays it back the same every pass. (Touch loops — the gesture looper — are
// set aside on the page; the engine stays.) Track t is tape track t.
const TRACKS = TAPE_TRACKS;
const trackUi = [];
// Each track's fader (Dash, Oct 2026): where it sits, 0 (down) to 1 (up), so
// a track can be faded in and out while you play. Its level is the position
// squared — an audio taper, so the travel feels even (halfway ≈ −12 dB).
const tapeFaders = new Array(TRACKS).fill(1);
// Quick tape (Dash, Oct 2026): one track is picked — the quick controls over
// the pond and the computer keys (1–4, R, P, M) work on it — so a take can
// start mid-phrase without scrolling to the deck.
let armedTrack = 0;
const faderLevel = (p) => p * p;
const fadersUnsent = new Set(); // a fader move the queue couldn't take: sent again next frame
// A track's fader can show in two places (the deck, and the tape over the
// pond); both move together.
const tapeFaderEls = Array.from({ length: TRACKS }, () => []);
function trackFader(t) {
  const el = fader({
    label: `track ${t + 1} fader`, get: () => tapeFaders[t],
    set: (v) => { tapeFaders[t] = v; sendFader(t); for (const f of tapeFaderEls[t]) if (f !== el) f.repaint(); },
  });
  tapeFaderEls[t].push(el);
  return el;
}
function sendFader(t) {
  if (!events) return;
  if (events.push(EV_TAPE_FADER, t, faderLevel(tapeFaders[t]))) fadersUnsent.delete(t); else fadersUnsent.add(t);
}

// A vertical fader: drag the cap up or down (it moves by how far you drag, so
// grabbing it never jumps the level); double-tap for full; arrow keys too.
function fader({ label, get, set }) {
  const el = document.createElement('div');
  el.className = 'fader';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.innerHTML = '<div class="fader-slot"></div><div class="fader-cap"></div>';
  const cap = el.querySelector('.fader-cap');
  const paint = () => {
    const p = get();
    cap.style.bottom = `calc(${(p * 100).toFixed(2)}% - ${(p * 12).toFixed(2)}px)`; // the cap stays inside the slot
    el.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    el.setAttribute('aria-valuetext', p <= 0.001 ? 'silent' : `${Math.round(20 * Math.log10(faderLevel(p)))} dB`);
  };
  const put = (p) => { set(Math.min(1, Math.max(0, p))); paint(); };
  let drag = null, lastTap = 0;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.focus({ preventScroll: true }); // so the arrow keys move this fader after a click
    try { el.setPointerCapture(e.pointerId); } catch { /* gone */ }
    drag = { id: e.pointerId, y: e.clientY, p: get(), moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 3) drag.moved = true;
    put(drag.p - dy / Math.max(40, el.clientHeight - 12));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) { // a tap: a second within 350 ms brings it to full
      if (e.timeStamp - lastTap < 350) { put(1); lastTap = 0; } else lastTap = e.timeStamp;
    }
    drag = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => {
    const p = get(), step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.2, PageDown: -0.2 }[e.key];
    if (step !== undefined) { e.preventDefault(); put(p + step); }
    else if (e.key === 'Home') { e.preventDefault(); put(0); }
    else if (e.key === 'End') { e.preventDefault(); put(1); }
  });
  paint();
  el.repaint = paint; // (a twin fader moved: show where it is now)
  return el;
}
function buildLoopControls() {
  const host = document.getElementById('layers');
  for (let t = 0; t < TRACKS; t++) {
    const ch = document.createElement('div');
    ch.className = 'ch';
    ch.setAttribute('role', 'group');
    ch.setAttribute('aria-label', `track ${t + 1}`);
    ch.innerHTML = `<div class="ch-head"><span class="ch-num">${t + 1}</span><span class="lamp"></span></div>
      <div class="ch-pos"><div></div></div><div class="ch-len">—</div><div class="ch-body"><div class="keys"></div></div>`;
    ch.querySelector('.ch-body').append(trackFader(t));
    const keys = ch.querySelector('.keys');
    const mk = () => { const b = document.createElement('button'); b.type = 'button'; b.className = 'key'; keys.append(b); return b; };
    const rec = mk(), play = mk(), mute = mk(), clear = mk();
    const ui = { ch, rec, play, mute, clear, pos: ch.querySelector('.ch-pos > div'), len: ch.querySelector('.ch-len'), last: '', lastPos: '' };
    rec.addEventListener('click', () => sendTape(t, TAPE_RECORD));
    play.addEventListener('click', () => sendTape(t, TAPE_PLAY_STOP));
    mute.addEventListener('click', () => sendTape(t, TAPE_MUTE));
    setKey(clear, '×', 'clear');
    clear.setAttribute('aria-label', `track ${t + 1} clear`);
    confirmButton(clear, () => sendTape(t, TAPE_CLEAR));
    host.append(ch);
    trackUi.push(ui);
    paintTrack(ui, t);
  }
  confirmButton(document.getElementById('clear-all'), () => sendTape(0, TAPE_CLEAR_ALL));
  buildQuickDeck();
  armTrack(armedTrack);

  const quantize = document.getElementById('quantize');
  const shown = document.querySelector('.quantized');
  quantize.checked = values.quantize === 1; // a restored session
  shown.hidden = !quantize.checked;
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

// ---- sound loops (tapes) -------------------------------------------------------------

function sendTape(track, action) {
  if (events) events.push(EV_TAPE, track, action);
}


// Each track's state from the latest frame (only touching the DOM on change).
let lastFrameTracks = null, lastRunning = null, lastCounter = '';
function updateTracks(frame) {
  lastFrameTracks = frame;
  let running = false, counter = 0, longest = -1;
  for (let t = 0; t < TRACKS; t++) {
    const o = FRAME_TAPES + t * TAPE_FIELDS, st = frame[o];
    // The counter follows the longest track that's turning (a recording one
    // counts up its own length).
    if (st === RECORDING || st === PLAYING || st === OVERDUB) {
      running = true;
      if (frame[o + 2] > longest) { longest = frame[o + 2]; counter = st === RECORDING ? frame[o + 2] : frame[o + 3]; }
    }
    paintTrack(trackUi[t], t);
  }
  if (running !== lastRunning) { document.getElementById('deck').classList.toggle('running', running); lastRunning = running; }
  const tenths = Math.round(counter * 10), m = Math.floor(tenths / 600), sec = (tenths - m * 600) / 10;
  const text = `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
  if (text !== lastCounter) { document.getElementById('tape-counter').textContent = text; lastCounter = text; }
}
// Key glyphs, in text style (U+FE0E) so iOS never draws them as emoji.
const REC = '●\uFE0E', PLAY = '▶\uFE0E', STOP = '■\uFE0E', MUTE = '◐\uFE0E';
// A key: a glyph over a small label.
function setKey(b, glyph, label) {
  b.replaceChildren();
  const gl = document.createElement('span');
  gl.className = 'glyph';
  gl.textContent = glyph;
  b.append(gl, label);
}
function paintTrack(ui, t) {
  const frame = lastFrameTracks, o = FRAME_TAPES + t * TAPE_FIELDS;
  const state = frame ? frame[o] : EMPTY, muted = frame ? frame[o + 1] : 0;
  const length = frame ? frame[o + 2] : 0, pos = frame ? frame[o + 3] : 0;
  const waiting = frame ? frame[o + 4] : 0, fading = frame ? frame[o + 5] : 0;
  const width = state === PLAYING || state === OVERDUB ? `${Math.min(100, (pos / Math.max(1e-3, length)) * 100).toFixed(0)}%` : state === RECORDING ? '100%' : '0';
  if (width !== ui.lastPos) { ui.pos.style.width = width; ui.lastPos = width; }
  const beat = 60 / values.bpm, beats = length / beat, whole = Math.abs(beats - Math.round(beats)) < 0.01 && beats >= 0.99;
  let text;
  if (state === EMPTY) text = 'empty';
  else if (state === RECORDING) text = `rec ${length.toFixed(1)} s`;
  else text = values.quantize && whole ? `${Math.round(beats)} beats` : `${length.toFixed(1)} s`;
  if (state === STOPPED) text += ' · stop';
  if (muted) text += ' · mute';
  if (waiting) text += ' · on the beat…';
  if (state === OVERDUB) text += ' · dub';
  if (fading === 1) text += ' · stopping';
  if (fading === 2) text += ' · clearing';
  const key = `${state}|${muted}|${text}`;
  if (key === ui.last) return;
  ui.last = key;
  ui.len.textContent = text;
  ui.ch.dataset.state = state === RECORDING || state === OVERDUB ? 'rec' : state === PLAYING ? 'play' : state === EMPTY ? 'empty' : 'stop';
  ui.ch.dataset.muted = muted ? '1' : '0';
  const [rg, rl] = state === EMPTY ? [REC, 'rec'] : state === RECORDING ? [REC, 'finish'] : state === OVERDUB ? [REC, 'end'] : [REC, 'dub'];
  setKey(ui.rec, rg, rl);
  ui.rec.classList.toggle('rec', state === RECORDING || state === OVERDUB);
  ui.rec.setAttribute('aria-label', `track ${t + 1} ${rl === 'rec' ? 'record' : rl === 'dub' ? 'overdub' : rl === 'end' ? 'end overdub' : rl}`);
  const playing = state === PLAYING || state === OVERDUB;
  setKey(ui.play, playing ? STOP : PLAY, playing ? 'stop' : state === RECORDING ? 'finish' : 'play');
  ui.play.setAttribute('aria-label', `track ${t + 1} ${playing ? 'stop' : state === RECORDING ? 'finish' : 'play'}`);
  ui.play.disabled = state === EMPTY;
  setKey(ui.mute, MUTE, 'mute');
  if (state === EMPTY && ui.clear.disarm) ui.clear.disarm(); // a cleared track's key isn't left armed
  ui.mute.classList.toggle('on', Boolean(muted));
  ui.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  ui.mute.setAttribute('aria-label', `track ${t + 1} mute`);
  ui.mute.disabled = ui.clear.disabled = state === EMPTY;
  paintQuick(t, state, rl, playing, muted);
}
// The quick controls show the picked track's rec and play keys as they are
// on the deck, and every track's lamp on its number.
function paintQuick(t, state, recLabel, playing, muted) {
  const look = state === RECORDING || state === OVERDUB ? 'rec' : state === PLAYING ? 'play' : state === EMPTY ? 'empty' : 'stop';
  const said = `${state === EMPTY ? ', empty' : look === 'rec' ? ', recording' : playing ? ', playing' : ', stopped'}${muted ? ', muted' : ''}`;
  const chip = document.querySelector(`.quick-track[data-t="${t}"]`);
  if (chip) {
    chip.dataset.state = look; chip.dataset.muted = muted ? '1' : '0';
    chip.setAttribute('aria-label', `pick track ${t + 1}${said}`);
    chip.title = `pick track ${t + 1} (key ${t + 1})`;
  }
  const q = quickUi[t];
  if (q) {
    q.rec.textContent = REC;
    q.rec.classList.toggle('rec', look === 'rec');
    q.rec.setAttribute('aria-label', `track ${t + 1} ${recLabel === 'rec' ? 'record' : recLabel === 'dub' ? 'overdub' : recLabel === 'end' ? 'end overdub' : recLabel}`);
    q.play.textContent = playing ? STOP : PLAY;
    q.play.setAttribute('aria-label', `track ${t + 1} ${playing ? 'stop' : state === RECORDING ? 'finish' : 'play'}`);
    q.play.disabled = state === EMPTY;
    q.mute.textContent = MUTE;
    q.mute.classList.toggle('on', Boolean(muted));
    q.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    q.mute.disabled = state === EMPTY;
    if (state === EMPTY && q.clear.disarm) q.clear.disarm();
    q.clear.disabled = state === EMPTY;
  }
  if (t !== armedTrack) return;
  const pick = document.getElementById('quick-pick'), rec = document.getElementById('quick-rec');
  pick.dataset.state = look; pick.dataset.muted = muted ? '1' : '0';
  document.getElementById('quick-num').textContent = String(t + 1);
  pick.setAttribute('aria-label', `tape track ${t + 1}${said} — pick another`);
  rec.querySelector('.word').textContent = recLabel;
  rec.classList.toggle('rec', state === RECORDING || state === OVERDUB);
  rec.setAttribute('aria-label', `tape track ${t + 1} ${recLabel === 'rec' ? 'record' : recLabel === 'dub' ? 'overdub' : recLabel === 'end' ? 'end overdub' : recLabel}`);
}
function armTrack(t) {
  if (!(t >= 0 && t < TRACKS)) return;
  armedTrack = t;
  document.querySelectorAll('.quick-track').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.t) === t ? 'true' : 'false'));
  trackUi.forEach((ui, k) => { ui.ch.classList.toggle('armed', k === t); ui.last = ''; paintTrack(ui, k); });
}
function quickTape(action) {
  if (!events) return;
  wake(); // a laptop that slept, or iOS holding the audio back
  if (action === 'rec') sendTape(armedTrack, TAPE_RECORD);
  else if (action === 'play') sendTape(armedTrack, TAPE_PLAY_STOP);
  else if (action === 'mute') sendTape(armedTrack, TAPE_MUTE);
}
// Tap TAPE n and the whole tape opens over the pond — every track's rec,
// play/stop, mute, clear and fader, and clear all — one performance space.
// It stays open while you play (riding a fader shouldn't fold it); fold it
// with its ▴ or Escape.
const quick = document.getElementById('quick'), quickPick = document.getElementById('quick-pick');
const quickUi = [];
function openQuick(open) {
  quick.classList.toggle('open', open);
  quickPick.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) { const on = quick.querySelector(`.quick-track[data-t="${armedTrack}"]`); if (on) on.focus({ preventScroll: true }); }
}
function buildQuickDeck() {
  const host = document.getElementById('quick-deck');
  const head = document.createElement('div');
  head.className = 'qd-head';
  head.innerHTML = '<span class="qd-title">tape</span>';
  const all = document.createElement('button');
  all.type = 'button'; all.textContent = '× all'; all.setAttribute('aria-label', 'clear all tracks');
  confirmButton(all, () => sendTape(0, TAPE_CLEAR_ALL));
  const fold = document.createElement('button');
  fold.type = 'button'; fold.className = 'qd-fold'; fold.textContent = '▴\uFE0E'; fold.setAttribute('aria-label', 'fold the tape away');
  fold.addEventListener('click', () => { openQuick(false); quickPick.focus({ preventScroll: true }); });
  head.append(all, fold);
  host.append(head);
  const make = (cls, label) => { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; b.setAttribute('aria-label', label); return b; };
  const rows = { num: [], rec: [], play: [], mute: [], clear: [], fader: [] };
  for (let t = 0; t < TRACKS; t++) {
    const num = make('quick-track', `track ${t + 1}`);
    num.dataset.t = String(t); num.textContent = String(t + 1); num.setAttribute('aria-keyshortcuts', String(t + 1));
    num.setAttribute('aria-pressed', t === armedTrack ? 'true' : 'false');
    num.addEventListener('click', () => armTrack(t));
    const rec = make('', `track ${t + 1} record`); rec.addEventListener('click', () => { armTrack(t); quickTape('rec'); });
    const play = make('', `track ${t + 1} play`); play.addEventListener('click', () => { wake(); sendTape(t, TAPE_PLAY_STOP); });
    const mute = make('', `track ${t + 1} mute`); mute.addEventListener('click', () => { wake(); sendTape(t, TAPE_MUTE); });
    const clear = make('', `track ${t + 1} clear`); clear.textContent = '×';
    confirmButton(clear, () => sendTape(t, TAPE_CLEAR));
    rows.num.push(num); rows.rec.push(rec); rows.play.push(play); rows.mute.push(mute); rows.clear.push(clear); rows.fader.push(trackFader(t));
    quickUi.push({ rec, play, mute, clear });
  }
  // Laid out a row at a time (each column a track), like the deck's strips turned sideways.
  for (const row of ['num', 'rec', 'play', 'mute', 'clear', 'fader']) host.append(...rows[row]);
}
quickPick.addEventListener('click', () => openQuick(true));
// Escape folds it from anywhere (a lifted stone's Escape — put it back — comes first).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !quick.classList.contains('open') || heldStone >= 0) return;
  if (!document.getElementById('guide').hidden) return;
  const inside = quick.contains(document.activeElement);
  openQuick(false);
  if (inside) quickPick.focus({ preventScroll: true });
});
document.getElementById('quick-rec').addEventListener('click', () => quickTape('rec'));
// The computer's keys: 1–4 pick a track, R records (finish, dub), P plays or
// stops, M mutes — never while typing in a field, or with a modifier held.
// Track numbers go by the key's place (Digit1…, Numpad1…), so they work on
// any keyboard layout.
document.addEventListener('keydown', (e) => {
  if (!events || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const el = e.target;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (!document.getElementById('guide').hidden) return;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
  const k = (e.key || '').toLowerCase();
  if (digit && Number(digit[1]) <= TRACKS) { armTrack(Number(digit[1]) - 1); e.preventDefault(); }
  else if (k === 'r') { quickTape('rec'); e.preventDefault(); }
  else if (k === 'p') { quickTape('play'); e.preventDefault(); }
  else if (k === 'm') { quickTape('mute'); e.preventDefault(); }
});

// ---- start ---------------------------------------------------------------------------

// ---- the session: settings kept in this browser ----------------------------------------
//
// Knobs, tuning, the stone layout and voices come back when a tester returns.
// Everything read back is checked and clamped; a broken or foreign entry is
// ignored. (Tapes and recordings are not kept; the tape faders are.)

const SESSION_KEY = 'water-synth.session';
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
function restoreSession() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return; }
  if (!saved || saved.v !== 1) return;
  for (const [k, p] of Object.entries(PARAMS)) {
    const v = num(saved.values && saved.values[k], p.min, p.max);
    if (v !== undefined) values[k] = (k === 'quantize' || k === 'grid' || k === 'bpm') ? Math.round(v) : v;
  }
  if (!(values.grid >= 1 && values.grid <= 4)) values.grid = PARAMS.grid.def; // the page offers quarters to sixteenths
  const t = saved.tuning || {};
  if (typeof t.scale === 'string' && Object.prototype.hasOwnProperty.call(SCALES, t.scale)) tuning.scale = t.scale;
  const root = num(t.root, 0, 11); if (root !== undefined) tuning.root = Math.round(root);
  const low = num(t.low, RANGE_LOW, RANGE_HIGH), high = num(t.high, RANGE_LOW, RANGE_HIGH);
  if (low !== undefined && high !== undefined && low <= high) { tuning.low = Math.round(low); tuning.high = Math.round(high); }
  const ref = num(t.refHz, REF_MIN_HZ, REF_MAX_HZ); if (ref !== undefined) tuning.refHz = ref;
  const count = num(t.stoneCount, 0, MAX_STONES); if (count !== undefined) tuning.stoneCount = Math.round(count);
  const l = saved.layout || {};
  const seed = num(l.seed, 0, 1e9); if (seed !== undefined) layout.seed = Math.round(seed);
  const spread = num(l.spread, 0, 1); if (spread !== undefined) layout.spread = spread;
  for (const e of Array.isArray(saved.placed) ? saved.placed : []) {
    const i = num(e && e[0], 0, MAX_STONES - 1), x = num(e && e[1], 0, 1), y = num(e && e[2], 0, 1);
    if (i !== undefined && x !== undefined && y !== undefined) placed.set(Math.round(i), { x, y });
  }
  const voice = (o) => Object.fromEntries(VOICE_KEYS.map((k) => {
    const p = VOICE_PARAMS[k], v = num(o && o[k], p.min, p.max);
    return [k, v === undefined ? p.def : v];
  }));
  const an = saved.animate || {};
  if (typeof an.mode === 'string' && ['off', 'drift', 'path', 'water'].includes(an.mode)) restoredAnimate = an.mode; // never the camera unasked
  const speed = num(an.speed, 0, 1); if (speed !== undefined) animator.speed = speed;
  if (Array.isArray(an.path)) animator.setPath(an.path.slice(0, 2000).map((p) => ({ x: num(p && p[0], 0, 1), y: num(p && p[1], 0, 1) })));
  if (Array.isArray(saved.faders)) for (let t = 0; t < TRACKS; t++) { const f = num(saved.faders[t], 0, 1); if (f !== undefined) tapeFaders[t] = f; }
  if (saved.voices && saved.voices.shared) voiceValues.set(SHARED, voice(saved.voices.shared));
  for (const e of Array.isArray(saved.voices && saved.voices.own) ? saved.voices.own : []) {
    const i = num(e && e[0], 0, MAX_STONES - 1);
    if (i === undefined) continue;
    voiceValues.set(Math.round(i), voice(e[1]));
    overridden.add(Math.round(i));
  }
}
let lastSaved = '';
function saveSession() {
  const own = [...overridden].map((i) => [i, voiceValues.get(i)]);
  const json = JSON.stringify({
    v: 1, values, tuning, layout, placed: [...placed].map(([i, p]) => [i, p.x, p.y]),
    voices: { shared: voiceValues.get(SHARED), own },
    animate: { mode: animator.mode === 'camera' ? 'off' : animator.mode, speed: animator.speed, path: animator.path.map((p) => [p.x, p.y]) },
    faders: tapeFaders,
  });
  if (json === lastSaved) return;
  try { localStorage.setItem(SESSION_KEY, json); lastSaved = json; } catch { /* private window: not kept */ }
}
restoreSession();
const autosave = setInterval(saveSession, 2000);
window.addEventListener('pagehide', saveSession);
confirmButton(document.getElementById('fresh'), () => {
  clearInterval(autosave); // nothing may re-save the old settings on the way out
  window.removeEventListener('pagehide', saveSession);
  try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing kept anyway */ }
  location.reload();
});

// ---- first run: how to play; help and feedback ------------------------------------------

const GUIDE_KEY = 'water-synth.guided';
const guide = document.getElementById('guide'), guideClose = document.getElementById('guide-close');
let guideOpener = null;
function showGuide() {
  guideOpener = document.activeElement !== document.body ? document.activeElement : surface;
  guide.hidden = false;
  guideClose.focus();
}
function hideGuide() {
  if (guide.hidden) return;
  guide.hidden = true;
  try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* shows again next time */ }
  if (guideOpener && guideOpener.focus) guideOpener.focus({ preventScroll: true });
}
guideClose.addEventListener('click', hideGuide);
guide.addEventListener('click', (e) => { if (e.target === guide) hideGuide(); });
document.addEventListener('keydown', (e) => {
  if (guide.hidden) return;
  if (e.key === 'Escape') hideGuide();
  else if (e.key === 'Tab') { e.preventDefault(); guideClose.focus(); } // the guide's one control keeps focus
});
document.getElementById('help').addEventListener('click', showGuide);
const firstRun = () => { try { return !localStorage.getItem(GUIDE_KEY); } catch { return true; } };
const feedback = document.getElementById('feedback');
if (FEEDBACK_URL) {
  feedback.hidden = false;
  // Device and settings, for context (only the tester's own setup), filled
  // in whenever the link is about to be used — tap, click, long-press, focus.
  const withInfo = () => {
    const info = `${navigator.userAgent.replace(/\s+/g, ' ').slice(0, 160)} | ${tuning.scale} ${ROOTS[tuning.root]} ` +
      `${stones.count} stones | flow ${values.waveSpeed.toFixed(0)} | quantize ${values.quantize ? 'on' : 'off'}`;
    feedback.href = FEEDBACK_URL.replace('{info}', encodeURIComponent(info));
  };
  for (const type of ['pointerdown', 'focus', 'click', 'contextmenu']) feedback.addEventListener(type, withInfo);
  feedback.href = FEEDBACK_URL.replace('{info}', '');
}

buildTuningControls();
buildKnobs();
buildVoiceControls();
buildSavedVoices();
buildLoopControls();
buildStoneControls();
document.getElementById('labels').addEventListener('change', (e) => { showLabels = e.target.checked; });
startButton.addEventListener('click', start);
window.waterReady = true; // the page's code loaded (index.html's guard stops worrying)

async function start() {
  startButton.hidden = true;
  const startError = document.getElementById('start-error');
  startError.textContent = '';
  if (!crossOriginIsolated) {
    // Said on the start screen itself (the status line is below the fold).
    startButton.hidden = false;
    startError.textContent = 'This page needs its security headers to run (cross-origin isolation). Locally: run node serve.mjs. Hosted: upload the whole dist folder, including _headers.';
    status.textContent = startError.textContent;
    return;
  }
  try {
    await startAudio();
  } catch (err) {
    // No console on a phone: say what went wrong, on the start screen, and let it be tried again.
    const why = err && err.message ? err.message : String(err);
    startError.textContent = `Couldn't start the audio: ${why}. If you just updated the page, reload it (an old copy may be cached). Tap to try again.`;
    status.textContent = startError.textContent;
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
  await ctx.audioWorklet.addModule('rec-worklet.js');

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
  // A phone gets a shorter cap: a long piece's samples, and the file built
  // from them, have to fit in its memory at once.
  const pieceMinutes = matchMedia('(pointer: coarse)').matches ? 6 : MAX_RECORD_SECONDS / 60;
  recorder = new PieceRecorder(ctx, node, { maxSeconds: pieceMinutes * 60 });
  recorder.onlimit = () => finishPiece(`stopped at the ${pieceMinutes}-minute limit`);
  document.getElementById('piece-rec').disabled = false;
  document.getElementById('camera-toggle').disabled = false;
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
    stirs: () => [...circling.values()].map((c) => c.slot), stirRings: () => stirRings,
    liveEnergy: () => live[0], liveFlash: () => Array.from(live.subarray(FRAME_FLASH, FRAME_FLASH + stones.count)),
    liveLoops: () => Array.from({ length: LOOP_LAYERS }, (_, l) => Array.from(live.subarray(FRAME_LOOPS + l * LOOP_FIELDS, FRAME_LOOPS + (l + 1) * LOOP_FIELDS))),
    liveTapes: () => Array.from({ length: TAPE_TRACKS }, (_, t) => Array.from(live.subarray(FRAME_TAPES + t * TAPE_FIELDS, FRAME_TAPES + (t + 1) * TAPE_FIELDS))),
  };

  for (const k of Object.keys(PARAMS)) sendParam(k);
  for (const k of VOICE_KEYS) sendVoice(k);
  for (const i of overridden) sendOverride(i, 1); // stones with their own voice (restored)
  for (let t = 0; t < TRACKS; t++) sendFader(t); // the tape faders where they were left
  document.getElementById('quick').hidden = false;
  retune();
  requestAnimationFrame(draw); // draw even if iOS holds the resume back
  status.textContent = 'waking the water…';
  if (firstRun()) showGuide();
  await resumed;
  playingStatus = `${ctx.sampleRate} Hz · touch to drop, drag to disturb — any number of fingers`;
  status.textContent = playingStatus;
}

// ---- animate: stones that move on their own --------------------------------------------
//
// Drift, a drawn path, carried by the water, or steered by the camera. As a
// stone moves its note follows where it is (always on the scale). A held or
// dragged stone is left to the hand.

function setAnimate(mode) {
  animator.mode = mode;
  for (const b of document.querySelectorAll('#animate-modes button')) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
  document.getElementById('path-row').hidden = mode !== 'path';
  document.getElementById('camera-row').hidden = mode !== 'camera';
  if (mode !== 'path') setPathDrawing(false);
  syncCamera();
}

// ---- the camera: movement makes ripples, and/or steers the stones ------------------------
//
// One camera serves both: "camera" in the bar (your movement drops and drags
// ripples, like touch) and Animate's "camera" (it steers the stones). It's on
// while either wants it. Everything stays on this device: the picture is
// shrunk to a 32 × 24 grey thumbnail here and compared with the last one.
function syncCamera() {
  const want = cameraRipples || animator.mode === 'camera';
  const note = document.getElementById('camera-note');
  // A word in the status line, then back to what it said (the playing hint).
  const say = (text) => {
    if (note) note.textContent = text;
    const before = statusBack ? status.dataset.before : status.textContent;
    clearTimeout(statusBack);
    status.dataset.before = before;
    status.textContent = text;
    statusBack = setTimeout(() => { statusBack = 0; if (status.textContent === text) status.textContent = before; }, 5000);
  };
  if (want && !camera.on && !document.hidden) {
    const ask = ++cameraAsk;
    camera.start().then((on) => {
      if (ask !== cameraAsk) return;
      if (on && camera.on) say(cameraRipples ? 'camera on — move in front of it to make ripples. The picture stays on this device.'
        : 'camera on — move in front of it; the stones follow. The picture stays on this device.');
      showCamera();
    }).catch((err) => {
      if (ask !== cameraAsk || camera.on) return; // a newer start, or it's running after all
      if (cameraRipples || animator.mode === 'camera') say(`no camera: ${err && err.message ? err.message : err}`);
      if (cameraRipples) showCameraRipples(false); // the button lets go (without asking again)
    });
  } else if (!want) { cameraAsk++; camera.stop(); } // also cancels a start still asking
  showCamera();
}
function showCamera() {
  document.getElementById('camera').classList.toggle('on', camera.on);
}
function showCameraRipples(on) {
  cameraRipples = on;
  const b = document.getElementById('camera-toggle');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.classList.toggle('on', on);
}
function setCameraRipples(on) {
  if (on && !cameraRipples) motionGestures.reset(); // nothing followed from before (the camera may have stayed on for Animate)
  showCameraRipples(on);
  syncCamera();
}
document.getElementById('camera-toggle').addEventListener('click', () => { wake(); setCameraRipples(!cameraRipples); });
// New camera frames → gestures, sent like a touch's (quantize holds camera
// drops for the beat just the same; the tape hears the result).
function cameraGestures(now) {
  if (!cameraRipples || !events || !camera.fresh) return;
  for (const g of motionGestures.update(camera.prev, camera.cur, camera.w, camera.h, camera.dt)) {
    if (g.type === 'drop') {
      const p = fromCanvas(g.x, g.y);
      events.push(EV_DROP, p.x, p.y, g.strength);
      camMarks.push({ x: p.x, y: p.y, at: now });
      const hold = heldFor(); // with quantize on, it waits for the beat like a touch: show where
      if (hold > 0.02) pending.push({ x: p.x, y: p.y, from: now, until: now + hold * 1000 });
    } else {
      const a = fromCanvas(g.x0, g.y0), b = fromCanvas(g.x1, g.y1);
      const across = Math.hypot(g.x1 - g.x0, g.y1 - g.y0), took = across / g.speed; // seconds the move took
      const speed = Math.sqrt((b.x - a.x) ** 2 + ((b.y - a.y) * ASPECT) ** 2) / took; // surface-widths per second, as for a drag
      if (speed > 0 && Number.isFinite(speed)) events.push(EV_STROKE, a.x, a.y, b.x, b.y, Math.min(16, speed));
      camMarks.push({ x: b.x, y: b.y, at: now });
    }
  }
  while (camMarks.length > 24) camMarks.shift();
}
function setPathDrawing(on) {
  pathDrawing = on;
  const b = document.getElementById('path-draw');
  b.classList.toggle('on', on);
  b.textContent = on ? 'drawing — drag on the pond' : 'draw a path';
  if (!on) { drawingPointer = -1; pathPoints = []; }
}
function buildAnimateControls() {
  for (const b of document.querySelectorAll('#animate-modes button')) b.addEventListener('click', () => setAnimate(b.dataset.mode));
  document.getElementById('path-draw').addEventListener('click', () => setPathDrawing(!pathDrawing));
}
// The water's height at a pond position, from the latest frame (for "water").
function waterHeight(x, y) {
  if (!heightsFrame) return 0;
  const gx = Math.min(GRID_W - 1.001, Math.max(0, x * (GRID_W - 1))), gy = Math.min(GRID_H - 1.001, Math.max(0, y * (GRID_H - 1)));
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, at = (i, j) => heightsFrame[FRAME_HEIGHTS + j * GRID_W + i];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}
// One animation step (from the draw loop). Moves are sent ~30 times a second,
// only for stones that moved since they were last sent (a move resets a
// stone's crest detection, so still stones are left alone).
function animateStones(dt, now) {
  if (animator.mode === 'off' || !events || stones.count === 0) return false;
  if (sentXs.length !== stones.count) { sentXs = Float64Array.from(stones.xs); sentYs = Float64Array.from(stones.ys); }
  let motion = null;
  if (animator.mode === 'camera') {
    const m = camera.motion; // screen terms (mirrored) → the pond's (sampled once a frame in draw)
    const p = fromCanvas(m.x, m.y);
    motion = { x: p.x, y: p.y, amount: m.amount };
  }
  const held = new Set([heldStone, ...[...grabs.values()].map((g) => g.i)]);
  const moved = animator.step(dt, stones.xs, stones.ys, { still: (i) => held.has(i), heights: waterHeight, motion });
  let unsent = false;
  for (let i = 0; i < stones.count && !unsent; i++) unsent = Math.abs(stones.xs[i] - sentXs[i]) > 1e-5 || Math.abs(stones.ys[i] - sentYs[i]) > 1e-5;
  if (unsent && now - lastAnimSend > 33) {
    lastAnimSend = now;
    for (let i = 0; i < stones.count; i++) {
      if (held.has(i)) { sentXs[i] = stones.xs[i]; sentYs[i] = stones.ys[i]; continue; } // the hand sends its own
      if (Math.abs(stones.xs[i] - sentXs[i]) <= 1e-5 && Math.abs(stones.ys[i] - sentYs[i]) <= 1e-5) continue;
      if (!events.push(EV_STONE_MOVE, i, stones.xs[i], stones.ys[i])) { stonesUnsent = true; break; }
      sentXs[i] = stones.xs[i]; sentYs[i] = stones.ys[i];
      repitch(i);
    }
  }
  return moved || unsent;
}

// ---- record piece: what you hear, as a WAV -------------------------------------------------

let recorder = null, pieceUrl = '', pieceTimer = 0, pieceSaved = true, discardArmed = 0;
const pieceRec = document.getElementById('piece-rec'), pieceLabel = document.getElementById('piece-label');
const pieceTime = document.getElementById('piece-time'), pieceSave = document.getElementById('piece-save');
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
pieceRec.addEventListener('click', () => {
  if (!recorder) return;
  if (recorder.recording) { finishPiece(); return; }
  // A take that hasn't been saved yet: the first tap only asks.
  if (pieceUrl && !pieceSaved && !discardArmed) {
    // The question gets the room (the time and "save" step aside for it).
    pieceLabel.textContent = matchMedia('(max-width: 900px)').matches ? 'discard?' : 'tap again: discard the last piece';
    pieceRec.parentElement.classList.add('confirming');
    discardArmed = setTimeout(() => { discardArmed = 0; pieceLabel.textContent = 'record piece'; pieceRec.parentElement.classList.remove('confirming'); }, 3000);
    return;
  }
  clearTimeout(discardArmed); discardArmed = 0;
  pieceRec.parentElement.classList.remove('confirming');
  if (pieceUrl) { URL.revokeObjectURL(pieceUrl); pieceUrl = ''; }
  pieceSave.hidden = true;
  recorder.start();
  pieceRec.classList.add('rec');
  pieceLabel.textContent = 'stop';
  pieceRec.setAttribute('aria-label', 'stop recording the piece');
  pieceTimer = setInterval(() => { pieceTime.textContent = clock(recorder.seconds); }, 250);
});
pieceSave.addEventListener('click', () => { pieceSaved = true; });
function finishPiece(note) {
  clearInterval(pieceTimer);
  const blob = recorder.stop();
  pieceRec.classList.remove('rec');
  pieceLabel.textContent = 'record piece';
  pieceRec.setAttribute('aria-label', 'record the piece');
  if (!blob) { pieceTime.textContent = ''; return; }
  pieceUrl = URL.createObjectURL(blob);
  pieceSaved = false;
  pieceSave.href = pieceUrl;
  pieceSave.download = pieceName();
  pieceSave.hidden = false;
  const gap = recorder.gapSeconds >= 0.05 ? ` · ${recorder.gapSeconds.toFixed(1)} s silent where the page fell behind` : '';
  pieceTime.textContent = `${clock(recorder.seconds)} · ${(blob.size / 1048576).toFixed(1)} MB${gap}${note ? ` · ${note}` : ''}`;
}

// ---- gestures: every finger, pen or mouse is its own disturbance ------------------------

const drags = new Map(); // pointerId → last sample { x, y, t }
// Stir: a drag that keeps circling (about three-quarters of a turn within
// the last 0.6 s) stirs instead of trailing — the engine builds turbulence
// around its circle while you keep going, and lets it die away when you stop
// circling or lift. Straighten out and it's a trail again.
const STIR_WINDOW_MS = 600, STIR_TURN = 1.5 * Math.PI, UNSTIR_TURN = 0.6 * Math.PI, MAX_STIR_SLOTS = 10;
const circling = new Map(); // pointerId → { pts: [{ x, y, t }], slot, at }
const stirRings = []; // { x, y, r, until } — the faint ring shown while stirring, fading after
// A free slot — preferring one whose last stir has finished fading (so a new
// stir starts from calm, and never takes over a ring still dying away).
function stirSlot() {
  const now = performance.now();
  let fallback = -1, oldest = Infinity;
  for (let k = 0; k < MAX_STIR_SLOTS; k++) {
    let used = false;
    for (const c of circling.values()) if (c.slot === k) used = true;
    if (used) continue;
    const ring = stirRings[k];
    if (!ring || ring.until <= now) return k;
    if (ring.until < oldest) { oldest = ring.until; fallback = k; }
  }
  return fallback;
}
// Follow a drag's recent path; returns the stir it's making ({ x, y, r, turns })
// or null while it isn't circling. Pond terms, with y scaled to widths.
function followCircle(id, p, t) {
  let c = circling.get(id);
  if (!c) { c = { pts: [], slot: -1, at: 0 }; circling.set(id, c); }
  c.pts.push({ x: p.x, y: p.y * ASPECT, t });
  while (c.pts.length > 2 && t - c.pts[0].t > STIR_WINDOW_MS) c.pts.shift();
  // How far the path has turned: the angle between successive steps, summed
  // (tiny steps skipped so a trembling finger doesn't count).
  let turn = 0, len = 0, prev = null, last = c.pts[0];
  for (let k = 1; k < c.pts.length; k++) {
    const q = c.pts[k], dx = q.x - last.x, dy = q.y - last.y, d = Math.hypot(dx, dy);
    if (d < 0.004) continue;
    const ang = Math.atan2(dy, dx);
    if (prev !== null) {
      let da = ang - prev;
      da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
      if (Math.abs(da) < 0.75 * Math.PI) turn += da; // a sharp reversal (a wipe back and forth) isn't turning
    }
    prev = ang; len += d; last = q;
  }
  const span = Math.max(0.05, (t - c.pts[0].t) / 1000), turning = Math.abs(turn);
  let cx = 0, cy = 0;
  for (const q of c.pts) { cx += q.x; cy += q.y; }
  cx /= c.pts.length; cy /= c.pts.length;
  // …and a circle spreads both ways: the path's narrow spread against its
  // wide one (a line, however wiggly, is nearly flat).
  let sxx = 0, syy = 0, sxy = 0;
  for (const q of c.pts) { const dx = q.x - cx, dy = q.y - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const round = tr > 0 ? (tr / 2 - disc) / (tr / 2 + disc) : 0; // 1: a circle, 0: a line (variances: a 3:1 oval ≈ 0.11)
  const stirring = c.slot >= 0 ? turning > UNSTIR_TURN && round > 0.08 : turning > STIR_TURN && len > 0.08 && round > 0.1; // (up to ~3:1 ovals: quick stirring on glass is rarely round)
  if (!stirring) return null;
  let r = 0;
  for (const q of c.pts) r += Math.hypot(q.x - cx, q.y - cy);
  r /= c.pts.length;
  return { x: cx, y: cy / ASPECT, r: Math.max(0.02, r), turns: turn / (2 * Math.PI) / span }; // signed: which way round
}
function sendStir(c, st, t) {
  if (c.slot < 0) c.slot = stirSlot();
  if (c.slot < 0 || !events) return;
  if (t - c.at < 30 && st) return; // ~30 a second is plenty (a let-go always goes)
  c.at = t;
  if (st) { events.push(EV_STIR, c.slot, st.x, st.y, st.r, st.turns); stirRings[c.slot] = { x: st.x, y: st.y, r: st.r, until: Infinity }; }
}
function releaseStir(id) {
  const c = circling.get(id);
  circling.delete(id);
  if (!c || c.slot < 0) return;
  if (events) events.push(EV_STIR, c.slot, 0.5, 0.5, 0.05, 0);
  const ring = stirRings[c.slot];
  if (ring) ring.until = performance.now() + 900; // the turbulence dies away over about this
}
// Still: a press held without moving rests a hand on the water (it damps
// and calms the water under it); sliding it calms along the way; lifting
// the finger lifts the hand. pointerId → { slot, x, y } (pond terms).
const hands = new Map();
const holds = new Map(); // pointerId → { timer, cx, cy } — a press that may yet become Still
let stirVisible = false; // a stir ring is on the pond (keep redrawing)
function freeHandSlot() {
  for (let k = 0; k < MAX_HANDS; k++) {
    let used = liftsUnsent.has(k); // still waiting for its lift to go
    for (const h of hands.values()) if (h.slot === k) used = true;
    if (!used) return k;
  }
  return -1;
}
// Only a press that hasn't moved can become Still; once it's a drag, it
// stays a drag (a pause mid-drag doesn't turn into a hand).
function watchHold(e, p, after = HOLD_MS) {
  cancelHold(e.pointerId);
  const pressure = handPressure(e);
  holds.set(e.pointerId, { cx: e.clientX, cy: e.clientY,
    timer: setTimeout(() => { holds.delete(e.pointerId); restHand(e.pointerId, p, pressure); }, after) });
}
// Apple Pencil pressure sets how firmly the hand rests; a finger or mouse rests fully.
const handPressure = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.max(0.3, Math.min(1, e.pressure * 1.5)) : 1);
function cancelHold(id) { const h = holds.get(id); if (h) { clearTimeout(h.timer); holds.delete(id); } }
function restHand(id, p, pressure = 1) {
  const slot = freeHandSlot();
  if (slot < 0 || !events) return;
  if (!events.push(EV_STILL, slot, p.x, p.y, pressure)) return; // the queue was full: no hand (the page never shows one the water lacks)
  grabs.delete(id); // a held stone press is Still now, not handling
  hands.set(id, { slot, x: p.x, y: p.y, pressure, t: 0 });
}
// The page hidden or left: every hold and hand lets go (nothing stays calmed).
function releaseAllHands() {
  for (const id of [...holds.keys()]) cancelHold(id);
  for (const id of [...hands.keys()]) liftHand(id);
  for (const id of [...circling.keys()]) releaseStir(id);
}
window.addEventListener('blur', releaseAllHands);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllHands(); });
// A lift must reach the water, or that spot stays calmed: one the queue
// couldn't take is sent again every frame until it goes.
const liftsUnsent = new Map(); // slot → { x, y }
function liftHand(id) {
  const h = hands.get(id);
  if (!h) return;
  hands.delete(id);
  liftsUnsent.set(h.slot, { x: h.x, y: h.y });
  sendLifts();
}
function sendLifts() {
  if (!events) return;
  for (const [slot, q] of liftsUnsent) {
    if (!events.push(EV_STILL, slot, q.x, q.y, 0)) return;
    liftsUnsent.delete(slot);
  }
}

// Stones by hand: tap a stone to pick it up (it lifts, and the voice editor
// turns to it); tap the water to put it down there, or the stone to put it
// back. Pressing a stone and dragging moves it directly.

function selectStone(i) {
  lastSelected = i;
  voiceTarget = i;
  refreshVoice();
}
function putStone(i, p) {
  if (!(i >= 0 && i < stones.count)) return; // gone in a retune
  stones.xs[i] = p.x; stones.ys[i] = p.y;
  placed.set(i, { x: p.x, y: p.y });
  if (!events.push(EV_STONE_MOVE, i, p.x, p.y)) stonesUnsent = true;
  repitch(i);
}

surface.addEventListener('pointerdown', (e) => {
  if (!events) return;
  e.preventDefault();
  wake();
  // Keep receiving this finger's moves even if it slides off the surface.
  try { surface.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  const p = toSurface(e);
  if (pathDrawing && drawingPointer < 0) { pathPoints = [p]; drawingPointer = e.pointerId; return; } // this drag draws the path (other fingers play)
  const hit = stoneAt(e);
  if (heldStone >= 0 && hit >= 0 && hit !== heldStone) { // another stone: the lift moves to it
    setLift(-1);
  } else if (heldStone >= 0) { // putting the lifted stone down (this tap doesn't play)
    if (hit !== heldStone) putStone(heldStone, p);
    setLift(-1);
    return;
  }
  if (hit >= 0) { // a press on a stone: a quick, still tap lifts it, a drag moves it
    grabs.set(e.pointerId, { i: hit, x: e.clientX, y: e.clientY, moved: false, at: e.timeStamp });
    selectStone(hit);
    watchHold(e, p); // held on the stone: Still there (a quick tap lifts, a drag moves)
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
  // The hand always comes down after this touch's drop (which quantize may hold for the beat).
  watchHold(e, p, Math.max(HOLD_MS, hold * 1000 + 60));
});

surface.addEventListener('pointermove', (e) => {
  if (!events) return;
  const p = toSurface(e);
  if (pathDrawing && e.pointerId === drawingPointer) {
    const last = pathPoints[pathPoints.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) pathPoints.push(p);
    return;
  }
  if (heldStone >= 0 && e.pointerType === 'mouse') hover = p;
  const hand = hands.get(e.pointerId);
  if (hand) { // Still, sliding: the hand calms along the way (no ripples)
    hand.x = p.x; hand.y = p.y;
    if (e.pointerType === 'pen') hand.pressure = handPressure(e);
    if (e.timeStamp - hand.t >= 8) { hand.t = e.timeStamp; events.push(EV_STILL, hand.slot, p.x, p.y, hand.pressure); } // like drags: ≤ ~120 a second
    return;
  }
  const hold = holds.get(e.pointerId);
  if (hold && Math.hypot(e.clientX - hold.cx, e.clientY - hold.cy) > HOLD_MOVE_PX) cancelHold(e.pointerId); // a drag, not a rest
  const grab = grabs.get(e.pointerId);
  if (grab) {
    if (!grab.moved && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) > 6) { grab.moved = true; cancelHold(e.pointerId); } // moving the stone: never a hand
    if (grab.moved) putStone(grab.i, p); // dragged: it follows, ringing as it crosses crests
    return;
  }
  const drag = drags.get(e.pointerId);
  if (!drag) return;
  const dt = (e.timeStamp - drag.t) / 1000;
  if (dt < 0.004) return; // let very fast event streams accumulate a little
  const st = followCircle(e.pointerId, p, e.timeStamp);
  const c = circling.get(e.pointerId);
  if (st) sendStir(c, st, e.timeStamp); // circling: it stirs (no trail)
  else {
    if (c && c.slot >= 0) { // straightened out: back to a trail, the stir let go
      events.push(EV_STIR, c.slot, 0.5, 0.5, 0.05, 0);
      const ring = stirRings[c.slot];
      if (ring) ring.until = performance.now() + 900;
      c.slot = -1;
    }
    const speed = Math.sqrt((p.x - drag.x) ** 2 + ((p.y - drag.y) * ASPECT) ** 2) / dt; // surface-widths per second
    if (speed > 0) events.push(EV_STROKE, drag.x, drag.y, p.x, p.y, Math.min(16, speed));
  }
  drags.set(e.pointerId, { x: p.x, y: p.y, t: e.timeStamp });
});

// The line is drawn (or the finger was lost): the stones take to it.
function finishPath() {
  if (pathPoints.length > 1) animator.setPath(pathPoints);
  setPathDrawing(false);
}
surface.addEventListener('pointerup', (e) => {
  if (pathDrawing && e.pointerId === drawingPointer) { finishPath(); return; }
  const grab = grabs.get(e.pointerId);
  // Only a quick, still tap lifts (a lingering press just selects).
  if (grab && !grab.moved && e.timeStamp - grab.at < LIFT_TAP_MS) setLift(grab.i);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  surface.addEventListener(type, (e) => {
    drags.delete(e.pointerId); grabs.delete(e.pointerId);
    cancelHold(e.pointerId); liftHand(e.pointerId); releaseStir(e.pointerId);
    if (pathDrawing && e.pointerId === drawingPointer) finishPath();
  });
}
surface.addEventListener('pointerleave', () => { hover = null; });
window.addEventListener('keydown', (e) => { // Escape: put a lifted stone back where it was lifted from
  if (e.key === 'Escape' && heldStone >= 0) {
    if (liftFrom && liftFrom.i === heldStone) putStone(heldStone, liftFrom);
    setLift(-1);
  }
});
// Lift a stone (−1: none). A lifted stone left alone goes back down where it
// was after LIFT_TIMEOUT_MS, so a stray tap never leaves the pond in a mode.
let liftTimer = 0, liftFrom = null; // where the lifted stone was when it was lifted
function setLift(i) {
  clearTimeout(liftTimer);
  if (i >= 0 && i !== heldStone) liftFrom = { i, x: stones.xs[i], y: stones.ys[i] };
  if (i < 0) liftFrom = null;
  heldStone = i;
  hover = null;
  if (i >= 0) liftTimer = setTimeout(() => { if (heldStone === i) setLift(-1); }, LIFT_TIMEOUT_MS);
  refreshVoice();
}
// The keyboard: with the pond focused, ←/→ select a stone, Enter lifts it (or
// puts it down), the arrows move a lifted stone, Escape puts it back.
surface.tabIndex = 0;
surface.addEventListener('keydown', (e) => {
  if (!events || stones.count === 0) return;
  const step = 0.02;
  if (heldStone >= 0 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    const i = heldStone;
    // Arrows follow the screen: on a portrait screen the pond is drawn turned a quarter.
    const sx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, sy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    const dx = rotated ? -sy : sx, dy = rotated ? sx : sy;
    putStone(i, { x: Math.min(1, Math.max(0, stones.xs[i] + dx)), y: Math.min(1, Math.max(0, stones.ys[i] + dy)) });
    setLift(i); // keeps it lifted (and restarts the timer)
    e.preventDefault();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const n = stones.count, from = lastSelected;
    selectStone(e.key === 'ArrowRight' ? (from < 0 ? 0 : (from + 1) % n) : (from < 0 ? n - 1 : (from - 1 + n) % n));
    e.preventDefault();
  } else if (e.key === 'Enter' && lastSelected >= 0) {
    setLift(heldStone >= 0 ? -1 : lastSelected);
    e.preventDefault();
  }
});
surface.addEventListener('contextmenu', (e) => e.preventDefault()); // long-press menus on touch

function toSurface(e) {
  const r = surface.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return fromCanvas(u, v);
}

// The stone under a pointer, if it lands right on one: a fingertip gets a
// little more room than a mouse, but near-misses still play the water.
function stoneAt(e) {
  const r = surface.getBoundingClientRect();
  // A crowded pond gives each stone a smaller handle, so most taps still play.
  const crowd = Math.min(1, Math.sqrt(16 / Math.max(1, stones.count)));
  const reach = Math.max(6, (e.pointerType === 'mouse' ? STONE_HIT_MOUSE_PX : STONE_HIT_TOUCH_PX) * crowd);
  let best = -1, bestD = reach * reach;
  for (let i = 0; i < stones.count; i++) {
    const c = toCanvas(stones.xs[i], stones.ys[i]);
    const dx = r.left + c.u * r.width - e.clientX, dy = r.top + c.v * r.height - e.clientY;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ---- drawing -------------------------------------------------------------------------

// The water in greys: crests light, troughs black, still water charcoal. Heights are
// compressed (tanh) so small ripples stay visible next to fresh drops.
const HEIGHT_SCALE = 0.05;
const STILL = [18, 18, 18], CREST = [236, 236, 232], TROUGH = [0, 0, 0]; // light on still water, in greys
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
  if (liftsUnsent.size) sendLifts();
  // A stirring finger that has stopped moving has stopped stirring.
  for (const c of circling.values()) {
    if (c.slot >= 0 && now - c.at > 250) {
      if (events) events.push(EV_STIR, c.slot, 0.5, 0.5, 0.05, 0);
      const ring = stirRings[c.slot];
      if (ring) ring.until = now + 900;
      c.slot = -1; c.pts.length = 0; // circling again must be seen afresh
    }
  }
  for (const t of fadersUnsent) sendFader(t);
  const dt = lastFrameTime ? Math.min(0.1, (now - lastFrameTime) / 1000) : 0;
  lastFrameTime = now;

  let frame = visuals.read();
  if (frame) heightsFrame = frame;
  if (camera.on) { camera.sample(); cameraGestures(now); }
  const animating = animateStones(dt, now);
  // The beat (when quantize is on) comes with every frame, still water or not;
  // between frames it's carried forward at the tempo.
  if (frame) { beatAt = frame[FRAME_BEAT]; beatTime = now; updateTracks(frame); } // tracks change even in still water
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
  const size = `${surface.clientWidth}x${surface.clientHeight}x${rotated}x${showLabels}x${voiceTarget}x${voiceMarks}x${heldStone}x${hands.size}x${hover ? hover.x.toFixed(3) + hover.y.toFixed(3) : ''}`;
  if (!frame && !glowing && !beating && !pending.length && grabs.size === 0 && hands.size === 0 && !stirVisible && !(camMarks.length && now - camMarks[camMarks.length - 1].at < 500) && heldStone < 0 && !animating && drawingPointer < 0 &&
      size === lastSize) { requestAnimationFrame(draw); return; }
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
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1); // the water is a 128×97 image; 3× only costs
  const w = Math.round(surface.clientWidth * dpr), h = Math.round(surface.clientHeight * dpr);
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'medium';
  if (rotated) {
    g.save();
    // The same quarter turn as toCanvas: the pond's left (x = 0) at the bottom.
    g.translate(0, h);
    g.rotate(-Math.PI / 2);
    g.drawImage(grid, 0, 0, h, w);
    g.restore();
  } else {
    g.drawImage(grid, 0, 0, w, h);
  }

  // Stones: a small dot; when one rings it glows, harder strikes brighter. A
  // stone with its own voice is hollow; the one the voice editor is on has a
  // dashed ring; a lifted one glows inside a slow pulsing ring.
  const r = Math.max(2, Math.max(w, h) / 180);
  g.font = `${Math.round(11 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
  for (let i = 0; i < stones.count; i++) {
    let grabbed = i === heldStone;
    for (const gr of grabs.values()) if (gr.i === i) grabbed = true;
    const c = toCanvas(stones.xs[i], stones.ys[i]);
    const x = c.u * w, y = c.v * h, f = flashShown[i];
    if (f > 0.01) {
      g.fillStyle = `rgba(255, 255, 255, ${(0.2 + 0.6 * f).toFixed(3)})`;
      g.beginPath(); g.arc(x, y, r * (1.5 + 4 * f), 0, Math.PI * 2); g.fill();
    }
    // A dark hairline keeps every stone visible on a bright crest; a stone
    // with its own voice is hollow (a white ring around a dark centre).
    const own = overridden.has(i);
    g.beginPath(); g.arc(x, y, r + Math.max(1, dpr), 0, Math.PI * 2);
    g.fillStyle = 'rgba(0, 0, 0, 0.6)'; g.fill();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = grabbed ? 'rgba(255, 255, 255, 1)' : 'rgba(236, 236, 232, 0.85)';
    g.fill();
    if (own) {
      g.beginPath(); g.arc(x, y, r * 0.5, 0, Math.PI * 2);
      g.fillStyle = 'rgba(0, 0, 0, 0.9)'; g.fill();
    }
    if (i === voiceTarget) { // the stone the voice editor is on: a dashed ring
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.lineWidth = Math.max(1, dpr);
      g.setLineDash([3 * dpr, 3 * dpr]);
      g.beginPath(); g.arc(x, y, r * 2.6, 0, Math.PI * 2); g.stroke();
      g.setLineDash([]);
    }
    if (i === heldStone) { // lifted: a soft glow and a slow pulsing ring, clear even on a phone; on a mouse, a preview where it would go
      const pulse = 0.5 + 0.5 * Math.sin(now / 260), ring = Math.max(r * 4, 11 * dpr) * (1 + 0.12 * pulse);
      const glow = g.createRadialGradient(x, y, 0, x, y, ring * 1.4);
      glow.addColorStop(0, 'rgba(255, 255, 255, 0.35)'); glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
      g.fillStyle = glow;
      g.beginPath(); g.arc(x, y, ring * 1.4, 0, Math.PI * 2); g.fill();
      g.strokeStyle = `rgba(255, 255, 255, ${(0.7 + 0.3 * pulse).toFixed(3)})`;
      g.lineWidth = Math.max(1.5, 1.8 * dpr);
      g.beginPath(); g.arc(x, y, ring, 0, Math.PI * 2); g.stroke();
      if (hover) {
        const hc = toCanvas(hover.x, hover.y);
        g.setLineDash([2 * dpr, 3 * dpr]);
        g.beginPath(); g.arc(hc.u * w, hc.v * h, r * 1.6, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
    }
    if (showLabels) {
      g.fillStyle = 'rgba(236, 236, 232, 0.7)';
      g.fillText(stones.labels[i], x + r * 2, y - r * 1.5);
    }
  }

  // A touch waiting for the beat: a faint ring at the touch point that closes
  // in as its moment comes (then the ripple itself takes over).
  for (const m of pending) {
    const c = toCanvas(m.x, m.y), left = Math.max(0, (m.until - now) / (m.until - m.from));
    g.strokeStyle = `rgba(255, 255, 255, ${(0.25 + 0.45 * (1 - left)).toFixed(3)})`;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.arc(c.u * w, c.v * h, (4 + 14 * left) * dpr, 0, Math.PI * 2); g.stroke();
  }

  // Where the camera's movement touched the water: a small ring that fades.
  for (const mk of camMarks) {
    const age = (now - mk.at) / 500;
    if (age >= 1) continue;
    const c = toCanvas(mk.x, mk.y);
    g.strokeStyle = `rgba(255, 255, 255, ${(0.55 * (1 - age)).toFixed(3)})`;
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.arc(c.u * w, c.v * h, (3 + 6 * age) * dpr, 0, Math.PI * 2); g.stroke();
  }

  // Stir: a faint ring where the water is being stirred, fading as it calms.
  let stirShown = false;
  for (const ring of stirRings) {
    if (!ring) continue;
    const left = ring.until === Infinity ? 1 : (ring.until - now) / 900;
    if (left <= 0) continue;
    stirShown = true;
    const c = toCanvas(ring.x, ring.y), rr = ring.r * (rotated ? h : w);
    g.strokeStyle = `rgba(255, 255, 255, ${(0.28 * left).toFixed(3)})`;
    g.lineWidth = Math.max(1, dpr);
    g.setLineDash([2 * dpr, 4 * dpr]);
    g.beginPath(); g.arc(c.u * w, c.v * h, rr, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
  }
  stirVisible = stirShown;

  // Still: each resting hand, a soft pale patch the size of what it calms.
  for (const hd of hands.values()) {
    const c = toCanvas(hd.x, hd.y), x = c.u * w, y = c.v * h, rr = (HAND_RADIUS * 1.6 / GRID_W) * (rotated ? h : w);
    const glow = g.createRadialGradient(x, y, 0, x, y, rr);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.16)'); glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = glow;
    g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    g.lineWidth = Math.max(1, dpr);
    g.beginPath(); g.arc(x, y, rr * 0.75, 0, Math.PI * 2); g.stroke();
  }

  // A drawn path (path mode): a faint dashed line the stones travel.
  const line = pathDrawing && pathPoints.length ? pathPoints : animator.mode === 'path' ? animator.path : [];
  if (line.length > 1) {
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = Math.max(1, dpr);
    g.setLineDash([4 * dpr, 5 * dpr]);
    g.beginPath();
    line.forEach((p, k) => { const c = toCanvas(p.x, p.y); if (k) g.lineTo(c.u * w, c.v * h); else g.moveTo(c.u * w, c.v * h); });
    g.stroke();
    g.setLineDash([]);
  }

  // The beat: the pond's rim pulses on every beat, brighter on each bar's first.
  if (beating) {
    const frac = beat - Math.floor(beat), downbeat = ((Math.floor(beat) % 4) + 4) % 4 === 0;
    const pulse = Math.exp(-frac * 7) * (downbeat ? 1 : 0.55);
    if (pulse > 0.01) {
      g.strokeStyle = `rgba(255, 255, 255, ${(0.7 * pulse).toFixed(3)})`;
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
