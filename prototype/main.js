// main.js — page side: starts audio, draws the water and the stones, turns
// touches (a finger, a pen, a mouse) into gestures, and sends
// loops, stones, tuning and knob changes to the audio thread.

import {
  createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_PARAM, EV_STONE, EV_STONES_COMMIT, EV_STONE_MOVE,
  EV_VOICE, EV_TAPE, EV_STONE_TUNE, EV_TAPE_FADER, EV_STIR,
} from './ring.js';
import {
  createVisualBuffer, VisualReader, frameLength, FRAME_FLASH, FRAME_LOOPS, FRAME_TAPES, FRAME_BEAT, FRAME_HEIGHTS, LOOP_FIELDS,
} from './visuals.js';
import { canShare, PortRingWriter, PortFrameReader } from './bridge.js';
import { buildPitches, noteLabel, SCALES, pitchAtX, PITCH_MARGIN } from './tuning.js';
import { stonePositions } from './layout.js';
import { PARAMS, PARAM_KEYS, VOICE_PARAMS, VOICE_KEYS, SHARED } from './instrument.js';
import {
  TAPE_TRACKS, TAPE_FIELDS, TAPE_RECORD, TAPE_PLAY_STOP, TAPE_MUTE, TAPE_CLEAR, TAPE_CLEAR_ALL,
} from './tape.js';
import { REFERENCE_SPEED, SURFACE_W, SURFACE_H, SIM_RATE } from './surface.js';
import { MAX_STONES } from './stones.js';
import { PieceRecorder, PortPieceRecorder, pieceName, MAX_RECORD_SECONDS } from './record.js';
import { FEEDBACK_URL } from './config.js';
import { Animator } from './animate.js';
import { CameraMotion } from './camera.js';
import { MotionGestures, DEFAULT_SENSITIVITY } from './motion.js';
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
// A sideways swipe on the pages turns the page (a slider track or a field
// keeps its own drag).
{
  const pagesEl = document.getElementById('pages');
  let swipe = null;
  pagesEl.addEventListener('pointerdown', (e) => {
    if (wideLayout.matches || e.pointerType === 'mouse' || !e.isPrimary) return;
    if (e.target.closest('.sl-track, input, select, textarea, video')) return;
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
// Chord pads (Dash, Oct 2026: "the best way to do a chord change if you
// wanted to have a progression built into your recording"): each holds a
// root and a scale (or chord); tapping one retunes the stones on the next
// bar line, and the progression plays them in order, `bars` bars each,
// counted from the beat's own downbeat — so takes on the beat line up with
// the changes. (Declared here: restoreSession reads them.)
const MAX_PADS = 8;
const pads = []; // { scale, root }
const progression = { on: false, bars: 2 };
let padActive = -1, padPending = -1, padAtBar = -1; // the pad sounding; the one tapped, and the bar it waits for
const layout = { seed: 0, spread: 1 };
const placed = new Map(); // stone index → { x, y } placed by hand
let stones = { xs: new Float64Array(0), ys: new Float64Array(0), hzs: [], labels: [], count: 0 };
let stonesUnsent = false;

let notesInRange = 0, stoneCountKnob = null; // scale notes in the range; the stone-count knob
let scaleNotes = []; // the scale notes in range, low to high — where a stone sits picks one
// `keepStones`: a chord change — same stones in the same places, only their
// notes change (a pad's chord may have more or fewer notes in range).
function retune(keepStones = false) {
  let pitches;
  try {
    pitches = buildPitches({
      scale: SCALES[tuning.scale], root: 60 + tuning.root,
      reference: { note: 69, hz: tuning.refHz }, low: tuning.low, high: tuning.high,
    });
  } catch (err) {
    setTuningNote(`${err.message} — keeping the previous ${stones.count} stones`);
    return false;
  }
  if (pitches.length === 0) { setTuningNote(`no scale notes in this range — keeping the previous ${stones.count} stones`); return false; }
  notesInRange = pitches.length;
  scaleNotes = pitches;
  // A chord change keeps the stones: if that's not one per note any more,
  // the count is pinned (so what's shown, and the next retune, agree).
  if (keepStones && stones.count && stones.count !== (tuning.stoneCount || notesInRange)) tuning.stoneCount = stones.count;
  const count = tuning.stoneCount || notesInRange;
  stoneNote();
  if (stoneCountKnob) stoneCountKnob.refresh();
  // The stones stay where they are (a retune never moves them — they may be
  // mid-animation); only a change in count lays out the new set.
  const kept = stones.count === count && stones.xs ? { xs: stones.xs, ys: stones.ys } : placeStones(count);
  stones = withPitches({ ...kept, count });
  sendStones();
  refreshVoice(); // a stone the editor was on may be gone
  return true;
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

// ---- chord pads and the progression ---------------------------------------------------

// "C maj7", "A m", "F sus4"… short enough for a pad.
const CHORD_SHORT = {
  // (Syncopate has only capitals, so "m" would read as "M": minor is spelled out.)
  majorTriad: '', minorTriad: 'min', sus2: 'sus2', sus4: 'sus4', major7: 'maj7', minor7: 'min7', dominant7: '7',
  major: 'major', minor: 'minor', dorian: 'dorian', pentatonicMajor: 'pent', pentatonicMinor: 'min pent', chromatic: 'chrom', rast: 'rast',
};
const CHORD_TIGHT = new Set(['', '7', 'maj7', 'sus2', 'sus4']); // written straight after the root
const padName = (p) => {
  const short = CHORD_SHORT[p.scale];
  if (short === undefined) return `${ROOTS[p.root]} ${SCALES[p.scale].name}`;
  return CHORD_TIGHT.has(short) ? `${ROOTS[p.root]}${short}` : `${ROOTS[p.root]} ${short}`;
};

function applyPad(i) {
  const p = pads[i];
  if (!p) return;
  const was = { scale: tuning.scale, root: tuning.root };
  tuning.scale = p.scale; tuning.root = p.root;
  if (!retune(true)) { Object.assign(tuning, was); padPending = -1; padFailed = i; paintPadState(); return; } // no notes in the range: stays as it was
  document.getElementById('scale').value = p.scale;
  document.getElementById('root').value = String(p.root);
  padActive = i; padPending = -1;
  // A tap that took over from the progression kept its beat running until
  // the chord landed; now it can go (unless a tape or quantize holds it).
  if (!progression.on && values.beatOn) { values.beatOn = 0; sendParam('beatOn'); }
  paintPadState();
}
// A pad tapped: on the next bar line if the beat runs, else now. Tapping
// one takes over from the progression (live changes win).
function queuePad(i, beat) {
  // (The progression stops but its beat runs on until this chord lands.)
  if (progression.on) { progression.on = false; document.getElementById('prog').checked = false; }
  if (beat < 0) { applyPad(i); return; }
  padPending = i; padAtBar = Math.floor(beat / 4) + 1;
  paintPadState();
}
let lastBeat = -1, padFailed = -1, padFailedBar = -1; // a pad that couldn't apply: not retried until the next bar
function chordsOnBeat(beat) {
  lastBeat = beat;
  // A chord waiting for a bar line the beat won't bring (it stopped, or
  // started over from a new downbeat): it lands now.
  if (beat < 0) { if (padPending >= 0) applyPad(padPending); return; }
  const bar = Math.floor(beat / 4);
  if (padPending >= 0 && (bar >= padAtBar || bar < padAtBar - 1)) applyPad(padPending);
  if (bar !== padFailedBar) { padFailed = -1; padFailedBar = bar; }
  if (progression.on && pads.length) {
    const i = Math.floor(bar / progression.bars) % pads.length;
    if (i !== padActive && i !== padFailed) applyPad(i);
  }
}
function setProgression(on) {
  progression.on = on && pads.length > 0;
  document.getElementById('prog').checked = progression.on;
  // Switched off with a chord still waiting for its bar: it lands now; on,
  // the progression takes over from it.
  if (padPending >= 0) { if (progression.on) padPending = -1; else applyPad(padPending); }
  // The progression keeps a beat running (it starts one if there's none yet).
  values.beatOn = progression.on ? 1 : 0;
  sendParam('beatOn');
  paintPadState();
}
// The tuning changed by hand: no pad is sounding any more.
function padsLetGo() { if (padActive >= 0) { padActive = -1; paintPadState(); } }
// Which pad is sounding, and which is waiting — without rebuilding the pads
// (focus, and a × tapped once, stay put).
function paintPadState() {
  document.querySelectorAll('#pads .pad').forEach((b, i) => {
    b.setAttribute('aria-pressed', i === padActive ? 'true' : 'false');
    b.classList.toggle('pending', i === padPending);
    const p = pads[i];
    if (p) b.setAttribute('aria-label', `${ROOTS[p.root]} ${SCALES[p.scale].name}${i === padPending ? ', on the next bar' : ''}`);
  });
}
// The pads themselves — only when the list changes.
function paintPads() {
  const box = document.getElementById('pads');
  box.replaceChildren(...pads.map((p, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'pad-wrap';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pad';
    b.textContent = padName(p);
    b.title = `${ROOTS[p.root]} ${SCALES[p.scale].name} — on the next bar line`;
    b.addEventListener('click', () => { wake(); queuePad(i, lastBeat); });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'pad-del'; del.textContent = '×';
    del.setAttribute('aria-label', `remove the ${ROOTS[p.root]} ${SCALES[p.scale].name} pad (tap twice)`);
    confirmButton(del, () => {
      pads.splice(i, 1);
      if (padActive === i) padActive = -1; else if (padActive > i) padActive--;
      if (padPending === i) padPending = -1; else if (padPending > i) padPending--;
      if (!pads.length) setProgression(false);
      paintPads();
    });
    wrap.append(b, del);
    return wrap;
  }));
  document.getElementById('pad-add').disabled = pads.length >= MAX_PADS;
  document.getElementById('prog').disabled = pads.length === 0;
  paintPadState();
}
function buildChordControls() {
  document.getElementById('pad-add').addEventListener('click', () => {
    if (pads.length >= MAX_PADS) return;
    pads.push({ scale: tuning.scale, root: tuning.root });
    padActive = pads.length - 1;
    paintPads();
  });
  document.getElementById('prog').addEventListener('change', (e) => setProgression(e.target.checked));
  const bars = slide({
    label: 'bars each', hint: 'how many bars each chord lasts when the progression plays them in order',
    get: () => progression.bars, set: (v) => { progression.bars = v; }, def: 2, steps: 7, keyStep: 1 / 7,
    to: (v) => (v - 1) / 7, from: (f) => 1 + Math.round(f * 7), show: (v) => `${v} bar${v === 1 ? '' : 's'}`,
  });
  document.getElementById('prog-controls').append(bars.el);
  paintPads();
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

  scale.addEventListener('change', () => { tuning.scale = scale.value; retune(); padsLetGo(); });
  root.addEventListener('change', () => { tuning.root = Number(root.value); retune(); padsLetGo(); });
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
  const count = slide({
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
  const row = slide({
    label: 'spread', hint: 'gathered in loose clumps ↔ spread evenly over the whole pond',
    get: () => layout.spread, set: (v) => { layout.spread = v; rearrange(); }, def: 1,
    to: (v) => v, from: (f) => f, show: (v) => (v > 0.95 ? 'even' : v < 0.05 ? 'gathered' : `${Math.round(v * 100)}`),
  });
  const motionKnob = slide({
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
    show: (v) => (v >= 0.995 ? 'snap' : v <= 0.005 ? 'as played' : `lean ${Math.round(v * 100)}%`), hint: 'how far notes move toward the beat' },
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

// A slider (Dash, Oct 2026: sliders everywhere, for touch): the label and
// its value on one line, a track under them, and a thumb after the logo's
// rings. Drag along it (it moves by how far you drag, so grabbing never
// jumps; Shift for fine), tap the track to jump there, double-tap to
// return to `def`; arrow keys step it. On a touch screen an upward or
// downward swipe that starts on it still scrolls the page.
// { el, readout, show, get, refresh, setDisabled }.
const THUMB = 7; // px: half the thumb, the track's margin at each end
function slide({ label, hint, get, set, to, from, show, def, steps = 0, keyStep = 0.01 }) {
  const el = document.createElement('div');
  el.className = 'slide';
  el.title = hint;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-description', hint);
  el.setAttribute('aria-valuemin', '0'); el.setAttribute('aria-valuemax', '100');
  el.innerHTML = `<div class="sl-head"><span class="sl-label"></span><output class="sl-value"></output></div>
    <div class="sl-track" aria-hidden="true"><div class="sl-line"></div><div class="sl-fill"></div><div class="sl-thumb"></div></div>`;
  el.querySelector('.sl-label').textContent = label;
  const track = el.querySelector('.sl-track'), readout = el.querySelector('.sl-value');
  let disabled = false;
  const frac = () => Math.min(1, Math.max(0, to(get())));
  const paint = () => {
    const f = frac();
    el.style.setProperty('--f', f.toFixed(4));
    readout.textContent = show(get());
    el.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    el.setAttribute('aria-valuetext', show(get()));
  };
  const setFrac = (f) => {
    if (disabled) return;
    const v = from(Math.min(1, Math.max(0, f)));
    if (v === get()) return; // nothing changed (e.g. a whole-number slider between steps)
    set(v);
    refreshReadouts();
    paint();
  };
  const hintHere = () => showHint(el, label, hint);
  // A mouse drags at once; a finger only once it moves sideways (moving up
  // or down first is the page scrolling — the browser takes it).
  let drag = null, lastTap = 0;
  const span = () => Math.max(1, track.clientWidth - 2 * THUMB);
  track.addEventListener('pointerdown', (e) => {
    if (disabled) return;
    el.focus({ preventScroll: true });
    if (e.pointerType === 'mouse') hintHere(); // a finger: only once it drags or taps (not every scroll that starts here)
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, f: frac(), shift: e.shiftKey, moved: 0, along: e.pointerType === 'mouse' };
    try { track.setPointerCapture(e.pointerId); } catch { /* gone */ }
    if (e.pointerType === 'mouse') e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.along) {
      if (Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { drag.along = true; hintHere(); }
      else return;
    }
    if (e.shiftKey !== drag.shift) { // fine/coarse changed: carry on from here
      Object.assign(drag, { x: e.clientX, f: frac(), shift: e.shiftKey });
      return;
    }
    drag.moved = Math.max(drag.moved, Math.abs(dx));
    setFrac(drag.f + (dx / span()) * (e.shiftKey ? 0.2 : 1));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = drag.moved < 4 && e.type === 'pointerup' && Math.abs(e.clientY - drag.y) < 10;
    drag = null;
    if (!tap) { lastTap = 0; return; }
    const now = performance.now();
    if (now - lastTap < 320 && def !== undefined) { setFrac(to(typeof def === 'function' ? def() : def)); lastTap = 0; return; }
    lastTap = now;
    hintHere();
    const r = track.getBoundingClientRect();
    setFrac((e.clientX - r.left - THUMB) / span()); // a tap jumps there
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) hintHere(); }); // from the keyboard
  el.addEventListener('keydown', (e) => {
    const unit = steps > 0 ? 1 / steps : 0;
    let step = { ArrowUp: keyStep, ArrowRight: keyStep, ArrowDown: -keyStep, ArrowLeft: -keyStep, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step !== undefined) {
      step *= e.shiftKey ? 0.2 : 1;
      if (unit && Math.abs(step) < unit) step = Math.sign(step) * unit; // a whole-number slider always moves one
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
    const make = k.group === 'tapes' ? slider : slide; // the tape's level is the deck's own fader
    const row = make({
      label: k.label, hint: k.hint, get: () => values[k.key], def: PARAMS[k.key].def,
      set: (v) => { values[k.key] = v; sendParam(k.key); }, to: k.map.to, from: k.map.from, show: k.show,
    });
    knobs.push(row);
    document.getElementById(`${k.group}-controls`).append(row.el);
  }
  // Camera ripples: how readily movement counts (Dash, Oct 2026: "way too
  // sensitive" — a room's grain and flicker must never play). Shown while
  // the camera makes ripples.
  cameraSenseRow = slide({
    label: 'camera sense', hint: 'how much movement the camera needs before it makes a ripple — lower for a busy or flickering room',
    get: () => motionGestures.sensitivity, set: (v) => { motionGestures.sensitivity = v; }, def: DEFAULT_SENSITIVITY,
    to: (v) => v, from: (f) => f, show: (v) => `${Math.round(v * 100)}%`,
  });
  cameraSenseRow.el.hidden = !cameraRipples;
  document.getElementById('water-controls').append(cameraSenseRow.el);
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
let cameraSenseRow = null; // the camera sensitivity slider (shown while camera ripples are on)
const motionGestures = new MotionGestures();
const camMarks = []; // where camera gestures landed lately: { x, y, at } (pond terms)
// (Declared here, before the page is built: a restored Animate mode calls
// syncCamera() during startup.)
let cameraAsk = 0; // which camera start is the latest (an older one's answer is ignored)
let statusBack = 0; // the timer that puts the status line back after a camera message
let pathDrawing = false, pathPoints = [], heightsFrame = null, lastAnimSend = 0, restoredAnimate = 'off';

function buildVoiceControls() {
  for (const k of VOICE_KNOBS) {
    const row = slide({
      label: k.label, hint: k.hint,
      get: () => voiceValue(k.key), set: (v) => setVoiceValue(k.key, v), def: VOICE_PARAMS[k.key].def,
      to: k.map.to, from: k.map.from, show: k.show,
    });
    voiceKnobs.push(row);
    document.getElementById(`${k.group}-controls`).append(row.el);
  }
  // One voice for every stone (Dash, Oct 2026: "it should be all stones").
  document.getElementById('voice-defaults').addEventListener('click', () => {
    const voice = voiceValues.get(SHARED);
    for (const k of VOICE_KEYS) { voice[k] = VOICE_PARAMS[k].def; sendVoice(k); }
    for (const row of voiceKnobs) row.refresh();
  });
  refreshVoice = () => {
    if (lastSelected >= stones.count) lastSelected = -1;
    if (heldStone >= stones.count) heldStone = -1;
    for (const [id, gr] of grabs) if (gr.i >= stones.count) grabs.delete(id);
    for (const row of voiceKnobs) row.refresh();
    const lifted = heldStone >= 0 ? `stone ${heldStone + 1} lifted — tap the water to put it down, or the stone to put it back` : '';
    if (lifted) status.textContent = lifted;
    else if (status.textContent.startsWith('stone ')) status.textContent = playingStatus;
    surface.setAttribute('aria-label', heldStone >= 0 ? 'Water surface: tap to put the lifted stone down'
      : 'Water surface: touch to drop, drag to disturb; tap a stone to pick it up');
  };
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
// One voice, shared by every stone (Dash, Oct 2026: per-stone voices are off
// the page; the engine keeps them, unused here). The page keeps its own copy
// of the voice's values — the audio thread owns the real ones and clamps
// whatever it is sent.

const voiceValues = new Map([[SHARED, Object.fromEntries(VOICE_KEYS.map((k) => [k, VOICE_PARAMS[k].def]))]]);
let voiceMarks = 0; // bumped whenever the pond's stone labels may change (for the redraw check)

const voiceValue = (key) => voiceValues.get(SHARED)[key];
// Voice events go out through one queue that holds only the latest wish for
// each knob: re-queueing an entry moves it to the back. If the ring is full,
// the rest wait for the next frame.
const voiceQueue = new Map(); // key → true
function flushVoice() {
  if (!events) return;
  const voice = voiceValues.get(SHARED);
  for (const key of voiceQueue.keys()) {
    if (!events.push(EV_VOICE, SHARED, VOICE_KEYS.indexOf(key), voice[key])) return;
    voiceQueue.delete(key);
  }
}
function sendVoice(key) {
  voiceQueue.delete(key);
  voiceQueue.set(key, true);
  flushVoice();
}

function setVoiceValue(key, v) {
  voiceValues.get(SHARED)[key] = v;
  sendVoice(key);
}

// ---- saved voices ---------------------------------------------------------------------
//
// Voices you designed, by name, kept in this browser (no presets ship). "use"
// puts one on every stone. Storage can be missing or full (a private
// window): the page works without it and says so.

const SAVED_KEY = 'water-synth.voices';
const SAVED_NOTE = 'Your saved voices live in this browser. "use" puts one on every stone.';
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
  Object.assign(voiceValues.get(SHARED), voiceFrom(saved));
  for (const k of VOICE_KEYS) sendVoice(k);
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
    all.set(n, { ...voiceValues.get(SHARED) });
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
  const shown = document.querySelector('.quantized'); // the notes' grid, strength and swing
  quantize.checked = values.quantize === 1; // a restored session
  shown.hidden = !quantize.checked;
  quantize.addEventListener('change', () => {
    values.quantize = quantize.checked ? 1 : 0;
    shown.hidden = !quantize.checked;
    sendParam('quantize');
  });
  // Tempo (Dash, Oct 2026: a slider, "so you can gradually speed up or slow
  // down your piece"): whole BPM; the engine glides there and keeps the beat
  // in its place.
  const span = PARAMS.bpm.max - PARAMS.bpm.min;
  const tempo = slide({
    label: 'tempo', hint: 'the beat — slide to speed up or slow down; it glides there and the beat keeps its place',
    get: () => values.bpm, set: (v) => { values.bpm = v; sendParam('bpm'); }, def: PARAMS.bpm.def, steps: span, keyStep: 1 / span, // arrows: 1 bpm
    to: (v) => (v - PARAMS.bpm.min) / span, from: (f) => Math.round(PARAMS.bpm.min + f * span), show: (v) => `${v} bpm`,
  });
  document.getElementById('tempo-controls').append(tempo.el);
  // The quantize grid, coarse to fine, as a stepped slider.
  const last = GRID_CHOICES.length - 1;
  const grid = slide({
    label: 'grid', hint: 'where notes are pulled to: from a whole note (once a bar) down to 32nds',
    get: () => values.grid, set: (v) => { values.grid = v; sendParam('grid'); }, def: PARAMS.grid.def, steps: last,
    to: (v) => gridIndex(v) / last, from: (f) => GRID_CHOICES[Math.round(f * last)][0], show: (v) => GRID_CHOICES[gridIndex(v)][1],
  });
  document.getElementById('quantize-controls').prepend(grid.el);
}
// Quantize grids: points per beat, and their names.
const GRID_CHOICES = [[0.25, 'whole notes'], [0.5, 'half notes'], [1, 'quarters'], [1.5, 'quarter triplets'],
  [2, '8ths'], [3, '8th triplets'], [4, '16ths'], [6, '16th triplets'], [8, '32nds']];
const gridIndex = (v) => { let best = 0; GRID_CHOICES.forEach(([per], i) => { if (Math.abs(per - v) < Math.abs(GRID_CHOICES[best][0] - v)) best = i; }); return best; };

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
  else text = whole ? `${Math.round(beats)} beats` : `${length.toFixed(1)} s`;
  if (state === STOPPED) text += ' · stop';
  if (muted) text += ' · mute';
  if (waiting === 2) text += state === EMPTY ? ' · primed: waits for a stone' : ' · primed to dub';
  else if (waiting) text += ' · on the beat…';
  if (state === OVERDUB) text += ' · dub';
  if (fading === 1) text += ' · stopping';
  if (fading === 2) text += ' · clearing';
  const primed = waiting === 2;
  const key = `${state}|${muted}|${text}`;
  if (key === ui.last) return;
  ui.last = key;
  ui.len.textContent = text;
  ui.ch.dataset.state = state === RECORDING || state === OVERDUB ? 'rec' : state === PLAYING ? 'play' : state === EMPTY ? 'empty' : 'stop';
  ui.ch.dataset.muted = muted ? '1' : '0';
  // Primed: rec again lets it go (nothing starts).
  const [rg, rl] = primed ? [REC, 'primed'] : state === EMPTY ? [REC, 'rec'] : state === RECORDING ? [REC, 'finish'] : state === OVERDUB ? [REC, 'end'] : [REC, 'dub'];
  setKey(ui.rec, rg, rl);
  ui.rec.classList.toggle('rec', state === RECORDING || state === OVERDUB);
  ui.rec.classList.toggle('primed', primed);
  ui.rec.setAttribute('aria-label', `track ${t + 1} ${recWords(rl)}`);
  const playing = (state === PLAYING || state === OVERDUB) && fading !== 1; // stopping (fading out): its key already says play
  setKey(ui.play, playing ? STOP : PLAY, playing ? 'stop' : state === RECORDING ? 'finish' : 'play');
  ui.play.setAttribute('aria-label', `track ${t + 1} ${playing ? 'stop' : state === RECORDING ? 'finish' : 'play'}`);
  ui.play.disabled = state === EMPTY;
  setKey(ui.mute, MUTE, 'mute');
  if (state === EMPTY && ui.clear.disarm) ui.clear.disarm(); // a cleared track's key isn't left armed
  ui.mute.classList.toggle('on', Boolean(muted));
  ui.mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
  ui.mute.setAttribute('aria-label', `track ${t + 1} mute`);
  ui.mute.disabled = ui.clear.disabled = state === EMPTY;
  paintQuick(t, state, rl, playing, muted, primed);
}
function recWords(label) {
  return label === 'rec' ? 'record' : label === 'dub' ? 'overdub' : label === 'end' ? 'end overdub'
    : label === 'primed' ? 'primed: recording starts when a stone rings — press to cancel' : label;
}
// The quick controls show the picked track's rec and play keys as they are
// on the deck, and every track's lamp on its number.
function paintQuick(t, state, recLabel, playing, muted, primed) {
  const look = state === RECORDING || state === OVERDUB ? 'rec' : primed ? 'primed' : state === PLAYING ? 'play' : state === EMPTY ? 'empty' : 'stop';
  const said = `${state === EMPTY ? (primed ? ', primed' : ', empty') : look === 'rec' ? ', recording' : playing ? ', playing' : ', stopped'}${primed && state !== EMPTY ? ', primed to dub' : ''}${muted ? ', muted' : ''}`;
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
    q.rec.classList.toggle('primed', primed);
    q.rec.setAttribute('aria-label', `track ${t + 1} ${recWords(recLabel)}`);
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
  rec.classList.toggle('primed', primed);
  rec.setAttribute('aria-label', `tape track ${t + 1} ${recWords(recLabel)}`);
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
    if (v !== undefined) values[k] = (k === 'quantize' || k === 'bpm') ? Math.round(v) : v;
  }
  values.grid = GRID_CHOICES[gridIndex(values.grid)][0]; // one of the page's grids
  values.beatOn = 0; // (the progression starts off; it turns the beat on itself)
  const t = saved.tuning || {};
  if (typeof t.scale === 'string' && Object.prototype.hasOwnProperty.call(SCALES, t.scale)) tuning.scale = t.scale;
  const root = num(t.root, 0, 11); if (root !== undefined) tuning.root = Math.round(root);
  const low = num(t.low, RANGE_LOW, RANGE_HIGH), high = num(t.high, RANGE_LOW, RANGE_HIGH);
  if (low !== undefined && high !== undefined && low <= high) { tuning.low = Math.round(low); tuning.high = Math.round(high); }
  const ref = num(t.refHz, REF_MIN_HZ, REF_MAX_HZ); if (ref !== undefined) tuning.refHz = ref;
  const count = num(t.stoneCount, 0, MAX_STONES); if (count !== undefined) tuning.stoneCount = Math.round(count);
  const ch = saved.chords || {};
  for (const p of Array.isArray(ch.pads) ? ch.pads : []) {
    const r = num(p && p.root, 0, 11);
    if (pads.length < MAX_PADS && p && typeof p.scale === 'string' && Object.prototype.hasOwnProperty.call(SCALES, p.scale) && r !== undefined) pads.push({ scale: p.scale, root: Math.round(r) });
  }
  padActive = pads.findIndex((p) => p.scale === tuning.scale && p.root === tuning.root);
  const bars = num(ch.bars, 1, 8); if (bars !== undefined) progression.bars = Math.round(bars);
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
  const sense = num(saved.cameraSensitivity, 0, 1); if (sense !== undefined) motionGestures.sensitivity = sense;
  if (Array.isArray(saved.faders)) for (let t = 0; t < TRACKS; t++) { const f = num(saved.faders[t], 0, 1); if (f !== undefined) tapeFaders[t] = f; }
  // (Stones' own voices from older sessions are left behind: one voice now.)
  if (saved.voices && saved.voices.shared) voiceValues.set(SHARED, voice(saved.voices.shared));
}
let lastSaved = '';
function saveSession() {
  const json = JSON.stringify({
    v: 1, values, tuning, layout, placed: [...placed].map(([i, p]) => [i, p.x, p.y]),
    chords: { pads, bars: progression.bars },
    voices: { shared: voiceValues.get(SHARED) },
    animate: { mode: animator.mode === 'camera' ? 'off' : animator.mode, speed: animator.speed, path: animator.path.map((p) => [p.x, p.y]) },
    faders: tapeFaders,
    cameraSensitivity: motionGestures.sensitivity,
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
buildChordControls();
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

  // Shared memory where the page is cross-origin isolated (the website);
  // otherwise — the app stores' web views — the same links over the
  // worklet's port (bridge.js).
  const shared = canShare();
  const eventBuffer = shared ? createRingBuffer(1024) : null;
  const visualBuffer = shared ? createVisualBuffer(GRID_W * GRID_H) : null;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1; // fresh every session
  const node = new AudioWorkletNode(ctx, 'water', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { eventBuffer, visualBuffer, seed },
  });
  if (shared) {
    events = new RingWriter(eventBuffer);
    visuals = new VisualReader(visualBuffer);
  } else {
    events = new PortRingWriter(node.port, 1024);
    visuals = new PortFrameReader(node.port, frameLength(GRID_W * GRID_H));
    node.port.onmessage = (e) => { if (e.data instanceof Float32Array) visuals.receive(e.data); };
  }
  node.connect(ctx.destination);
  // A phone gets a shorter cap: a long piece's samples, and the file built
  // from them, have to fit in its memory at once.
  const pieceMinutes = matchMedia('(pointer: coarse)').matches ? 6 : MAX_RECORD_SECONDS / 60;
  recorder = new (shared ? PieceRecorder : PortPieceRecorder)(ctx, node, { maxSeconds: pieceMinutes * 60 });
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
  const liveFrame = shared ? new Float32Array(visualBuffer, 8) : null;
  const live = () => liveFrame || visuals.copy; // the newest frame, either way
  window.waterDebug = {
    ctx, node, analyser, peak: () => peakOf(analyser), stones: () => stones, placed: () => placed,
    stirs: () => [...circling.values()].map((c) => c.slot), stirRings: () => stirRings,
    liveEnergy: () => live()[0], liveFlash: () => Array.from(live().subarray(FRAME_FLASH, FRAME_FLASH + stones.count)),
    liveLoops: () => Array.from({ length: LOOP_LAYERS }, (_, l) => Array.from(live().subarray(FRAME_LOOPS + l * LOOP_FIELDS, FRAME_LOOPS + (l + 1) * LOOP_FIELDS))),
    liveTapes: () => Array.from({ length: TAPE_TRACKS }, (_, t) => Array.from(live().subarray(FRAME_TAPES + t * TAPE_FIELDS, FRAME_TAPES + (t + 1) * TAPE_FIELDS))),
  };

  for (const k of Object.keys(PARAMS)) sendParam(k);
  for (const k of VOICE_KEYS) sendVoice(k);
  for (let t = 0; t < TRACKS; t++) sendFader(t); // the tape faders where they were left
  document.getElementById('quick').hidden = false;
  retune();
  requestAnimationFrame(draw); // draw even if iOS holds the resume back
  status.textContent = 'waking the water…';
  if (firstRun()) showGuide();
  await resumed;
  playingStatus = `${ctx.sampleRate} Hz · touch to drop, drag to disturb — two fingers run the tape`;
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
  if (cameraSenseRow) cameraSenseRow.el.hidden = !on;
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
// New camera frames → gestures, sent like a touch's (the tape hears the
// result, and a primed tape starts on them).
function cameraGestures(now) {
  if (!cameraRipples || !events || !camera.fresh) return;
  for (const g of motionGestures.update(camera.prev, camera.cur, camera.w, camera.h, camera.dt)) {
    if (g.type === 'drop') {
      const p = fromCanvas(g.x, g.y);
      events.push(EV_DROP, p.x, p.y, g.strength);
      camMarks.push({ x: p.x, y: p.y, at: now });
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

// ---- gestures: a finger (one at a time), a pen or a mouse disturbs the water ---------------

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
// Still (press and hold) is off the page (Dash, Oct 2026: "it doesn't
// really add anything and it distracts from playing"); the water's hands
// (EV_STILL) stay in the engine, unused here.
let stirVisible = false; // a stir ring is on the pond (keep redrawing)
// The page hidden or left: every stir lets go (nothing keeps churning).
function releaseAllStirs() {
  for (const id of [...circling.keys()]) releaseStir(id);
  forgetFingers(); // (defined with the two-finger tape below)
}
window.addEventListener('blur', releaseAllStirs);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllStirs(); });

// Stones by hand: tap a stone to pick it up (it lifts); tap the water to put
// it down there, or the stone to put it back. Pressing a stone and dragging
// moves it directly.

function selectStone(i, byKey = false) {
  lastSelected = i;
  refreshVoice();
  if (byKey) status.textContent = `stone ${i + 1} · ${stones.labels[i]} — Enter lifts it`;
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
    return;
  }
  // Apple Pencil pressure sets strength (with a floor: first-contact pressure
  // is often low); fingers and mice are a fixed-strength drop.
  const strength = e.pointerType === 'pen' && e.pressure > 0 ? 0.6 + 1.4 * e.pressure : 1;
  if (e.pointerType === 'touch') { fingerDown(e, p); return; } // a finger waits a moment for a partner (below)
  events.push(EV_DROP, p.x, p.y, strength);
  drags.set(e.pointerId, { x: p.x, y: p.y, t: e.timeStamp });
});

// ---- the tape by two fingers ------------------------------------------------------------
// Two fingers on the water are the tape, never the water (Dash, Oct 2026:
// "If someone is touching at any two points, only the swipe behavior is
// possible, no sound"). A finger plays alone: it waits PAIR_WAIT_MS before
// its drop, and if a second finger lands meanwhile — or later, while it is
// still down — every finger on the water falls silent until it lifts.
// Swiping two together runs the tape: up records (primes the picked track —
// again finishes, or dubs), down plays or stops it, left and right pick the
// track. It must be a flick, judged as the first of the two fingers lifts:
// both landed together, lift within SWIPE_MS, and moved straight, quickly,
// the same way and about as far — so a pinch, two fingers stirring (which
// never lift that soon) or two slow drags side by side never count (they
// are silent all the same). On a computer the keys do the same (1–4, R, P);
// a mouse or a pen plays at once, with no wait, and never counts as a
// second finger.
const PAIR_WAIT_MS = 60; // a first touch waits this long to hear if a partner is coming
const SWIPE_LAND_MS = 200; // the two fingers land within this of each other
const SWIPE_MIN_PX = 36; // each finger travels at least this far
const SWIPE_MS = 400; // …and the first finger lifts within this long of landing
const SWIPE_SPEED = 250; // px per second at least, on average (a flick, not a trail)
const SWIPE_STRAIGHT = 0.8; // how far it got ÷ how far it went (a circle is far below)
const SWIPE_AGREE = Math.cos(Math.PI / 6); // the two directions within 30°
// touch pointerId on the water → { x0, y0, x, y, path, at, from } — where it
// landed, where it is, how far it has travelled, when it landed, and the
// picked track as it was then (before this finger's own drop could start a
// primed take), so a swipe means what you saw when you began it.
const fingers = new Map();
const swiped = new Set(); // fingers that made a swipe (judged once)
const silent = new Set(); // fingers that met another on the water: no sound until they lift
const lone = new Map(); // a lone finger's drop, waiting PAIR_WAIT_MS for a partner: pointerId → { p, at, timer }
function fingerDown(e, p) {
  // The first finger of a new touch: anything still listed is a finger whose
  // lift never arrived — forget it, or it would keep every touch silent.
  if (e.isPrimary) forgetFingers();
  const o = FRAME_TAPES + armedTrack * TAPE_FIELDS, frame = lastFrameTracks;
  // (A track fading out after a stop is stopped, as far as a swipe goes.)
  const from = { state: frame ? (frame[o + 5] === 1 ? STOPPED : frame[o]) : EMPTY, primed: frame ? frame[o + 4] === 2 : false };
  fingers.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, path: 0, at: e.timeStamp, from, crowded: false });
  // A third finger: none of the fingers down now can make a swipe (lifts
  // come one at a time, and the last two would otherwise look like a pair).
  if (fingers.size > 2) for (const g of fingers.values()) g.crowded = true;
  if (fingers.size >= 2) { for (const id of fingers.keys()) silence(id); return; } // two on the water: the tape
  lone.set(e.pointerId, { p, at: e.timeStamp, timer: setTimeout(() => sound(e.pointerId), PAIR_WAIT_MS) });
}
// No partner came: the finger's drop plays (from where it landed; its trail
// follows from there).
function sound(id) {
  const w = lone.get(id);
  if (!w || !events) return;
  lone.delete(id);
  clearTimeout(w.timer);
  events.push(EV_DROP, w.p.x, w.p.y, 1);
  drags.set(id, { x: w.p.x, y: w.p.y, t: w.at }); // the trail's pace counts from the landing
}
function silence(id) {
  const w = lone.get(id);
  if (w) { clearTimeout(w.timer); lone.delete(id); }
  drags.delete(id); releaseStir(id);
  silent.add(id);
}
function forgetFingers() {
  for (const w of lone.values()) clearTimeout(w.timer);
  lone.clear(); fingers.clear(); silent.clear(); swiped.clear();
}
function fingerUp(id) {
  const w = lone.get(id);
  if (w) { clearTimeout(w.timer); lone.delete(id); }
  fingers.delete(id); swiped.delete(id); silent.delete(id);
}
// Move one finger; true if it makes no sound (lone, or one of two).
function watchSwipe(e) {
  const f = fingers.get(e.pointerId);
  if (!f) return false;
  f.path += Math.hypot(e.clientX - f.x, e.clientY - f.y);
  f.x = e.clientX; f.y = e.clientY;
  return silent.has(e.pointerId) || lone.has(e.pointerId);
}
// The first of two fingers lifts: was it a flick?
function swipeOnLift(e) {
  const f = fingers.get(e.pointerId);
  if (!f || swiped.has(e.pointerId) || fingers.size !== 2) return;
  f.path += Math.hypot(e.clientX - f.x, e.clientY - f.y);
  f.x = e.clientX; f.y = e.clientY;
  const [a, b] = [...fingers.values()];
  if (a.crowded || b.crowded) return;
  const first = a.at <= b.at ? a : b;
  if (Math.abs(a.at - b.at) > SWIPE_LAND_MS || e.timeStamp - first.at > SWIPE_MS) return;
  const ax = a.x - a.x0, ay = a.y - a.y0, bx = b.x - b.x0, by = b.y - b.y0;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < SWIPE_MIN_PX || lb < SWIPE_MIN_PX) return;
  if (la < SWIPE_STRAIGHT * a.path || lb < SWIPE_STRAIGHT * b.path) return; // curving: not a flick
  if (Math.min(la, lb) / Math.max((e.timeStamp - first.at) / 1000, 1e-3) < SWIPE_SPEED) return;
  if ((ax * bx + ay * by) / (la * lb) < SWIPE_AGREE || Math.min(la, lb) < 0.5 * Math.max(la, lb)) return;
  const mx = ax + bx, my = ay + by;
  let dir;
  if (Math.abs(my) > 1.5 * Math.abs(mx)) dir = my < 0 ? 'up' : 'down';
  else if (Math.abs(mx) > 1.5 * Math.abs(my)) dir = mx < 0 ? 'left' : 'right';
  else return; // diagonal
  for (const id of fingers.keys()) swiped.add(id);
  tapeSwipe(dir, first.from);
}
function tapeSwipe(dir, from) {
  const t = armedTrack, { state, primed } = from;
  let note;
  if (dir === 'left' || dir === 'right') {
    armTrack((t + (dir === 'right' ? 1 : TRACKS - 1)) % TRACKS);
    note = `tape ${armedTrack + 1}`;
  } else if (dir === 'up') {
    note = primed ? `tape ${t + 1} · rec off` : state === EMPTY ? `tape ${t + 1} · primed`
      : state === RECORDING ? `tape ${t + 1} · finish` : state === OVERDUB ? `tape ${t + 1} · dub off` : `tape ${t + 1} · dub primed`;
    // Primed, the swipe lets it go — but a stone the water was still ringing
    // may already have started the take: clear unprimes a track still
    // waiting, and erases a take only just begun. (A primed dub: rec
    // unprimes it, or ends the dub that stone began.)
    if (primed && state === EMPTY) { wake(); sendTape(t, TAPE_CLEAR); } else quickTape('rec');
  } else {
    note = state === EMPTY ? `tape ${t + 1} · ${primed ? 'rec off' : 'empty'}` : state === PLAYING || state === OVERDUB ? `tape ${t + 1} · stop` : `tape ${t + 1} · play`;
    if (state !== EMPTY) quickTape('play');
    else if (primed) { wake(); sendTape(t, TAPE_CLEAR); } // a ringing stone may have started the primed take
  }
  showSwipeNote(note);
}
let swipeNoteTimer = 0;
function showSwipeNote(text) {
  const el = document.getElementById('swipe-note');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(swipeNoteTimer);
  swipeNoteTimer = setTimeout(() => el.classList.remove('on'), 1200);
}

surface.addEventListener('pointermove', (e) => {
  if (!events) return;
  const p = toSurface(e);
  if (pathDrawing && e.pointerId === drawingPointer) {
    const last = pathPoints[pathPoints.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) pathPoints.push(p);
    return;
  }
  if (heldStone >= 0 && e.pointerType === 'mouse') hover = p;
  if (watchSwipe(e)) return; // a finger waiting for a partner, or one of two: no ripples
  const grab = grabs.get(e.pointerId);
  if (grab) {
    if (!grab.moved && Math.hypot(e.clientX - grab.x, e.clientY - grab.y) > 6) grab.moved = true; // moving the stone
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
    if (type === 'pointerup') { if (lone.has(e.pointerId)) sound(e.pointerId); swipeOnLift(e); } // a quick lone tap still plays
    drags.delete(e.pointerId); grabs.delete(e.pointerId);
    releaseStir(e.pointerId); fingerUp(e.pointerId);
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
    selectStone(e.key === 'ArrowRight' ? (from < 0 ? 0 : (from + 1) % n) : (from < 0 ? n - 1 : (from - 1 + n) % n), true);
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
let outputLevel = 0, lastFrameTime = 0, lastOutputWidth = '', lastSize = '', lastFrameEnergy = -1;

function draw(now) {
  if (stonesUnsent) sendStones();
  for (const key of unsent) sendParam(key);
  if (voiceQueue.size) flushVoice();
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
  // The beat runs while quantize is on or a tape is on it (tapes always
  // follow the tempo): the rim pulses whenever there's a beat to play to.
  const beating = beatAt >= 0;
  const beat = beating ? beatAt + ((now - beatTime) / 1000) * (values.bpm / 60) : -1;
  chordsOnBeat(beat);
  // A frame of perfectly still water after another one changes nothing on screen.
  if (frame && frame[0] === 0 && lastFrameEnergy === 0 && frame[1] === 0) frame = null;
  if (frame) lastFrameEnergy = frame[0];
  const fade = Math.pow(0.02, dt); // a flash fades to 2% in a second
  let glowing = false;
  for (let i = 0; i < flashShown.length; i++) { flashShown[i] *= fade; if (flashShown[i] > 0.01) glowing = true; }
  // Nothing new, nothing fading, nothing held: skip the redraw (battery).
  const size = `${surface.clientWidth}x${surface.clientHeight}x${rotated}x${showLabels}x${voiceMarks}x${document.activeElement === surface ? lastSelected : -1}x${heldStone}x${hover ? hover.x.toFixed(3) + hover.y.toFixed(3) : ''}`;
  if (!frame && !glowing && !beating && grabs.size === 0 && !stirVisible && !(camMarks.length && now - camMarks[camMarks.length - 1].at < 500) && heldStone < 0 && !animating && drawingPointer < 0 &&
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

  // Stones: a small dot; when one rings it glows, harder strikes brighter. The
  // stone chosen from the keyboard has a dashed ring; a lifted one glows
  // inside a slow pulsing ring.
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
    // A dark hairline keeps every stone visible on a bright crest.
    g.beginPath(); g.arc(x, y, r + Math.max(1, dpr), 0, Math.PI * 2);
    g.fillStyle = 'rgba(0, 0, 0, 0.6)'; g.fill();
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = grabbed ? 'rgba(255, 255, 255, 1)' : 'rgba(236, 236, 232, 0.85)';
    g.fill();
    if (i === lastSelected && document.activeElement === surface && i !== heldStone) { // chosen from the keyboard: a dashed ring
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
