// main.js — page side: starts audio, turns pointer input into gestures.

import { createRingBuffer, RingWriter, EV_DROP } from './ring.js';

const SAMPLE_RATE = 48000; // the JS sim isn't real-time at 96k+; the port will fix this
const GRID_SIZE = 32;

const surface = document.getElementById('surface');
const status = document.getElementById('status');
const startButton = document.getElementById('start');

let events = null;

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
  events = new RingWriter(eventBuffer);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1; // fresh every session
  const node = new AudioWorkletNode(ctx, 'medium', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { eventBuffer, seed, size: GRID_SIZE },
  });
  node.connect(ctx.destination);
  node.onprocessorerror = () => {
    status.textContent = 'The audio engine stopped with an error — see the browser console.';
  };

  // For inspection from dev tools / automated checks; not used by the page.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  node.connect(analyser);
  window.waterDebug = { ctx, node, analyser, peak: () => peakOf(analyser) };

  await ctx.resume();
  status.textContent = `${ctx.sampleRate} Hz · ${GRID_SIZE}×${GRID_SIZE} · click the surface`;
}

surface.addEventListener('pointerdown', (e) => {
  if (!events) return;
  const { x, y } = toSurface(e);
  events.push(EV_DROP, x, y, 1);
});

function toSurface(e) {
  const r = surface.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

function peakOf(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
}
