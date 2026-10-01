// main.js — page side: starts audio, sends the stones, turns pointer input
// into gestures. (Phase 1b step 3: the water isn't drawn yet — step 4 adds
// ripples, controls and stone flashes.)

import { createRingBuffer, RingWriter, EV_DROP, EV_STROKE, EV_STONE, EV_STONES_COMMIT } from './ring.js';
import { buildPitches, SCALES } from './tuning.js';
import { stonePositions } from './layout.js';

const SAMPLE_RATE = 48000;
const ASPECT = 97 / 128; // the water's shape (height / width)

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');

let events = null;
let stones = { xs: [], ys: [], hzs: [], count: 0 };
let stonesUnsent = false;

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
  events = new RingWriter(eventBuffer);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1; // fresh every session
  const node = new AudioWorkletNode(ctx, 'water', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { eventBuffer, seed },
  });
  node.connect(ctx.destination);
  node.onprocessorerror = () => {
    status.textContent = 'The audio engine stopped with an error — see the browser console.';
  };

  // For inspection from dev tools / automated checks; not used by the page.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  window.waterDebug = { ctx, node, analyser, peak: () => peakOf(analyser), stones: () => stones };

  setStones(buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 }), 'scattered');
  await ctx.resume();
  status.textContent = `${ctx.sampleRate} Hz · ${stones.count} stones · click to drop, drag to disturb`;
  requestAnimationFrame(frame);
}

// ---- stones ---------------------------------------------------------------------

function setStones(pitches, layout) {
  const { xs, ys } = stonePositions(pitches.length, layout);
  stones = { xs, ys, hzs: pitches.map((p) => p.hz), count: pitches.length };
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

// ---- drawing (placeholder until step 4) -------------------------------------------

const g = surface.getContext('2d');

function frame() {
  if (stonesUnsent) sendStones();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(surface.clientWidth * dpr), h = Math.round(surface.clientHeight * dpr);
  if (surface.width !== w || surface.height !== h) { surface.width = w; surface.height = h; }
  g.fillStyle = '#0f1822';
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(201, 214, 226, 0.55)';
  for (let i = 0; i < stones.count; i++) {
    g.beginPath();
    g.arc(stones.xs[i] * w, stones.ys[i] * h, Math.max(2, w / 160), 0, Math.PI * 2);
    g.fill();
  }
  requestAnimationFrame(frame);
}

function peakOf(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}
