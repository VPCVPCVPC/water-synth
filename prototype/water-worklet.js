// water-worklet.js — runs the instrument (water, stones, bells) on the
// browser's audio thread. Gestures, knob changes and stone layouts arrive
// through the lock-free event queue (ring.js) and are handled by the
// Instrument itself. Nothing here allocates once constructed.

import { Instrument } from './instrument.js';
import { RingReader } from './ring.js';

class WaterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { eventBuffer, seed } = options.processorOptions;
    // `sampleRate` is a global in the AudioWorklet scope.
    this.inst = new Instrument({ sampleRate, seed });
    this.events = new RingReader(eventBuffer);
    this.scratch = new Float32Array(4096); // stands in for a missing right channel
    this.handle = (d, o) => this.inst.handleEvent(d, o); // created once, not per block
  }

  process(inputs, outputs) {
    this.events.drain(this.handle);
    const out = outputs[0];
    const L = out[0];
    if (!L) return true;
    const R = out[1] || this.scratch;
    this.inst.process(L, R, L.length);
    return true;
  }
}

registerProcessor('water', WaterProcessor);
