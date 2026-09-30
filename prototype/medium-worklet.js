// medium-worklet.js — runs the medium on the browser's audio thread.
// Gestures and parameter changes arrive through a lock-free ring (ring.js);
// nothing here allocates once constructed.

import { Medium } from './medium.js';
import { RingReader, EV_DROP, EV_STROKE, EV_PARAM } from './ring.js';

class MediumProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { eventBuffer, seed, size } = options.processorOptions;
    // `sampleRate` is a global in the AudioWorklet scope.
    this.medium = new Medium({ size, sampleRate, seed });
    this.events = new RingReader(eventBuffer);
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
    this.medium.process(L, R, L.length);
    return true;
  }
}

registerProcessor('medium', MediumProcessor);
