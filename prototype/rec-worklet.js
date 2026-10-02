// rec-worklet.js — "record piece": copies what you hear (the water and the
// tape) into a shared ring the page drains. Lossless (the page writes the
// WAV), nothing allocated on the audio thread, never blocks: if the page falls
// behind, the frames that don't fit are counted, not waited for.
//
// Ring layout (SharedArrayBuffer): Int32 [read, write, armed, dropped], then
// interleaved stereo Float32 frames.

class Tap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer } = options.processorOptions;
    this.idx = new Int32Array(buffer, 0, 4);
    this.data = new Float32Array(buffer, 16);
    this.cap = this.data.length / 2; // frames
  }

  process(inputs) {
    if (Atomics.load(this.idx, 2) === 0) return true;
    const input = inputs[0];
    const L = input && input[0], R = (input && input[1]) || L, n = L ? L.length : 128; // no input: silence, not a gap
    let w = Atomics.load(this.idx, 1);
    const r = Atomics.load(this.idx, 0);
    const free = (r - w - 1 + this.cap) % this.cap;
    if (free < n) { Atomics.add(this.idx, 3, n); return true; } // the page fell behind
    const d = this.data;
    for (let i = 0; i < n; i++) {
      d[2 * w] = L ? L[i] : 0;
      d[2 * w + 1] = R ? R[i] : 0;
      w = w + 1 === this.cap ? 0 : w + 1;
    }
    Atomics.store(this.idx, 1, w); // publish after the frames are written
    return true;
  }
}

registerProcessor('tap', Tap);
