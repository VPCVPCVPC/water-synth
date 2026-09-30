// medium-worklet.js — runs the medium on the browser's audio thread.
// Gestures and parameter changes arrive through a lock-free ring (ring.js);
// frames for the visuals leave through a seqlock (visuals.js). Nothing here
// allocates once constructed.

import { Medium } from './medium.js';
import { RingReader, EV_DROP, EV_STROKE, EV_PARAM } from './ring.js';
import { VisualWriter } from './visuals.js';

const FRAME_RATE = 60;

class MediumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { eventBuffer, visualBuffer, seed, size } = options.processorOptions;
    // `sampleRate` is a global in the AudioWorklet scope.
    this.medium = new Medium({ size, sampleRate, seed });
    this.events = new RingReader(eventBuffer);
    this.visuals = new VisualWriter(visualBuffer);
    this.density = new Float64Array(size * size);
    this.densityCount = 0;
    this.outputPeak = 0;
    this.frameSamples = Math.round(sampleRate / FRAME_RATE);
    this.samplesSinceFrame = 0;
    this.scratch = new Float32Array(4096); // stands in for a missing right channel
    this.handle = (d, o) => this.handleEvent(d, o); // created once, not per block
  }

  handleEvent(d, o) {
    const m = this.medium;
    switch (d[o]) {
      case EV_DROP: m.drop(d[o + 1], d[o + 2], d[o + 3]); break;
      case EV_STROKE: m.stroke(d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6]); break;
      case EV_PARAM: m.setParamIndex(d[o + 1], d[o + 2]); break;
    }
  }

  process(inputs, outputs) {
    this.events.drain(this.handle);
    const out = outputs[0];
    const L = out[0];
    if (!L) return true;
    const R = out[1] || this.scratch;
    const n = L.length;
    const m = this.medium;
    m.process(L, R, n);

    // Visuals: sample the surface once per block, publish ~60 times a second.
    if (!m.asleep) m.accumulateEnergyDensity(this.density);
    this.densityCount++;
    let p = this.outputPeak;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > p) p = a;
      if (b > p) p = b;
    }
    this.outputPeak = p;
    this.samplesSinceFrame += n;
    if (this.samplesSinceFrame >= this.frameSamples) {
      this.visuals.publish(this.density, this.densityCount, m.asleep ? 0 : m.energy(), this.outputPeak);
      this.density.fill(0);
      this.densityCount = 0;
      this.outputPeak = 0;
      this.samplesSinceFrame = 0;
    }
    return true;
  }
}

registerProcessor('medium', MediumProcessor);
