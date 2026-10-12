// water-worklet.js — runs the instrument (water, stones, bells) on the
// browser's audio thread. Gestures, knob changes and stone layouts arrive
// through the lock-free event queue (ring.js) and are handled by the
// Instrument itself; ~60 frames a second of the water go back to the page
// through the visuals seqlock (visuals.js). Nothing here allocates once
// constructed.

import { Instrument } from './instrument.js';
import { RingReader } from './ring.js';
import { VisualWriter } from './visuals.js';
import { Limiter } from './limiter.js';

const FRAME_RATE = 60;

class WaterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { eventBuffer, visualBuffer, seed } = options.processorOptions;
    // `sampleRate` is a global in the AudioWorklet scope.
    this.inst = new Instrument({ sampleRate, seed });
    // Last in the chain: keeps the water and every tape under full scale
    // by turning the mix down, never clipping it (limiter.js).
    this.limiter = new Limiter({ sampleRate });
    this.events = new RingReader(eventBuffer);
    this.visuals = new VisualWriter(visualBuffer);
    // The page sized the shared frame; refuse to write past it (or leave stale
    // heights) if the two sides ever disagree about the water's size.
    this.publish = this.visuals.frame.length === this.inst.frameSize();
    if (!this.publish) throw new Error(`visuals frame is ${this.visuals.frame.length} floats; the water needs ${this.inst.frameSize()}`);
    this.frameSamples = Math.round(sampleRate / FRAME_RATE);
    this.samplesSinceFrame = 0;
    this.scratch = new Float32Array(4096); // stands in for a missing right channel
    this.handle = (d, o) => this.inst.handleEvent(d, o); // created once, not per block
  }

  process(inputs, outputs) {
    this.events.drain(this.handle);
    const out = outputs[0];
    const L = out[0];
    if (!L) return true;
    // A mono device path gives no right channel; a host that hands the same
    // array for both would get the limiter applied twice to it, so fall back
    // to the scratch whenever the two are not distinct.
    const R = out[1] && out[1] !== L ? out[1] : this.scratch;
    this.inst.process(L, R, L.length);
    // (On a mono path the unheard right channel still counts toward the
    // limiter's peaks — it can only turn the left down a little more.)
    this.limiter.process(L, R, L.length);
    this.samplesSinceFrame += L.length;
    if (this.publish && this.samplesSinceFrame >= this.frameSamples) {
      // Exact 60 Hz on average; never accumulates a backlog with large blocks.
      this.samplesSinceFrame %= this.frameSamples;
      this.inst.prepareFrame();
      this.inst.writeFrame(this.visuals.begin());
      this.visuals.end();
    }
    return true;
  }
}

registerProcessor('water', WaterProcessor);
