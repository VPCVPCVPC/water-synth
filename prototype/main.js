// main.js — page side: starts audio, turns pointer input into gestures, and
// draws the surface from frames the audio thread publishes.

import { createRingBuffer, RingWriter, EV_DROP, EV_STROKE } from './ring.js';
import { createVisualBuffer, VisualReader, FRAME_HEADER } from './visuals.js';
import { LISTEN_POINTS } from './medium.js';

const SAMPLE_RATE = 48000; // the JS sim isn't real-time at 96k+; the port will fix this
const GRID_SIZE = 32;

// Display: overall brightness follows the mean energy density on a dB scale
// (REF ≈ just after a fresh drop, fading to dark RANGE_DB below it). Waves
// cross the grid in a few ms, so energy spreads everywhere almost at once;
// the local pattern (standing waves, where energy pools) is shown as contrast
// around that mean, exaggerated by CONTRAST so it reads.
const DENSITY_REF = 3e-5;
const RANGE_DB = 60;
const CONTRAST = 0.18; // level change per doubling of local/mean density
const DROP_ENERGY = 3.6e-2; // total energy of one default drop, for the meter

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');
const energyBar = document.getElementById('energy');
const outputBar = document.getElementById('output');

let events = null;
let visuals = null;

startButton.addEventListener('click', start, { once: true });

async function start() {
  startButton.hidden = true;
  if (!crossOriginIsolated) {
    status.textContent = 'Needs cross-origin isolation: run `node serve.mjs` and open http://localhost:8123';
    return;
  }
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('medium-worklet.js');

  const eventBuffer = createRingBuffer(256);
  const visualBuffer = createVisualBuffer(GRID_SIZE * GRID_SIZE);
  events = new RingWriter(eventBuffer);
  visuals = new VisualReader(visualBuffer);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1; // fresh every session
  const node = new AudioWorkletNode(ctx, 'medium', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { eventBuffer, visualBuffer, seed, size: GRID_SIZE },
  });
  node.connect(ctx.destination);
  node.onprocessorerror = () => {
    status.textContent = 'The audio engine stopped with an error — see the browser console.';
  };

  // For inspection from dev tools / automated checks; not used by the page.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  window.waterDebug = { ctx, node, analyser, peak: () => peakOf(analyser), frame: () => lastFrame };

  await ctx.resume();
  status.textContent = `${ctx.sampleRate} Hz · ${GRID_SIZE}×${GRID_SIZE} · click to drop, drag to disturb`;
  requestAnimationFrame(draw);
}

// ---- gestures ---------------------------------------------------------------

let drag = null; // { x, y, t } of the last pointer sample while pressed

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
  const speed = Math.hypot(p.x - drag.x, p.y - drag.y) / dt; // surface-widths per second
  if (speed > 0) {
    // Each segment's wake lasts twice the time between samples, so segments
    // overlap by half and add up to a steady stream.
    // (Capped generously so slow pointer streams still overlap, not burst.)
    const seconds = Math.min(0.25, Math.max(0.008, 2 * dt));
    events.push(EV_STROKE, drag.x, drag.y, p.x, p.y, Math.min(16, speed), seconds);
  }
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

// ---- drawing ----------------------------------------------------------------

const g = surface.getContext('2d');
const grid = document.createElement('canvas');
grid.width = grid.height = GRID_SIZE;
const gridCtx = grid.getContext('2d');
const image = gridCtx.createImageData(GRID_SIZE, GRID_SIZE);
const shown = new Float32Array(GRID_SIZE * GRID_SIZE);
const palette = buildPalette();
let lastFrame = null;
let energyLevel = 0, outputLevel = 0;

function draw() {
  const frame = visuals.read();
  if (frame) {
    lastFrame = frame;
    for (let i = 0; i < shown.length; i++) shown[i] = 0.5 * shown[i] + 0.5 * frame[FRAME_HEADER + i];
    energyLevel = meterLevel(frame[0] / DROP_ENERGY, -60, 20);
    outputLevel = Math.max(meterLevel(frame[1] * frame[1], -60, 0), outputLevel * 0.9);
  }

  const px = image.data;
  let mean = 0;
  for (let i = 0; i < shown.length; i++) mean += shown[i];
  mean /= shown.length;
  const base = (10 * Math.log10(mean / DENSITY_REF + 1e-30) + RANGE_DB) / RANGE_DB;
  for (let i = 0; i < shown.length; i++) {
    const local = mean > 0 ? Math.log2(shown[i] / mean + 1e-6) : 0;
    const level = Math.min(1, Math.max(0, base > 0 ? base * 0.85 + CONTRAST * local * Math.min(1, 1.5 * base) : 0));
    const c = palette[Math.round(level * 255)];
    px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
  }
  gridCtx.putImageData(image, 0, 0);

  fitCanvas();
  const w = surface.width, h = surface.height;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(grid, 0, 0, w, h);

  // Listening points: where the medium is heard.
  g.strokeStyle = 'rgba(201, 214, 226, 0.35)';
  g.lineWidth = Math.max(1, w / 400);
  for (const [lx, ly] of LISTEN_POINTS) {
    // Same mapping as the medium: [0,1] spans the centres of the edge cells.
    const cx = (lx * (GRID_SIZE - 1) + 0.5) / GRID_SIZE, cy = (ly * (GRID_SIZE - 1) + 0.5) / GRID_SIZE;
    g.beginPath();
    g.arc(cx * w, cy * h, w / 80, 0, Math.PI * 2);
    g.stroke();
  }

  energyBar.style.width = `${(energyLevel * 100).toFixed(1)}%`;
  outputBar.style.width = `${(outputLevel * 100).toFixed(1)}%`;
  outputBar.classList.toggle('hot', lastFrame && lastFrame[1] > 0.9);
  requestAnimationFrame(draw);
}

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.round(surface.clientWidth * dpr);
  if (surface.width !== size) surface.width = surface.height = size;
}

function meterLevel(powerRatio, minDb, maxDb) {
  const db = 10 * Math.log10(powerRatio + 1e-30);
  return Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)));
}

function buildPalette() {
  // still → deep → moving → bright crest
  const stops = [
    [0.0, [15, 24, 34]],
    [0.35, [18, 52, 96]],
    [0.7, [36, 150, 184]],
    [1.0, [225, 246, 255]],
  ];
  const out = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    out.push(c0.map((v, j) => Math.round(v + (c1[j] - v) * f)));
  }
  return out;
}

function peakOf(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}
