// rec-worklet.js — "record piece": copies what you hear (the water and the
// tape) into a shared ring the page drains. Lossless (the page writes the
// WAV), nothing allocated on the audio thread, never blocks: if the page falls
// behind, the frames that don't fit are counted, not waited for. (Without
// shared memory it sends chunks over its port instead; see record.js.)
//
// Ring layout (SharedArrayBuffer): Int32 [read, write, armed, dropped], then
// interleaved stereo Float32 frames.

class Tap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer, chunk, pool } = options.processorOptions;
    if (buffer) {
      this.idx = new Int32Array(buffer, 0, 4);
      this.data = new Float32Array(buffer, 16);
      this.cap = this.data.length / 2; // frames
      return;
    }
    // No shared memory (record.js PortPieceRecorder): chunks over the port,
    // from a pool the page hands back. 'arm' / 'disarm' start and stop it.
    this.overPort = true;
    this.armed = false;
    this.chunk = chunk;
    this.pool = [];
    for (let i = 0; i < pool; i++) this.pool.push(new Float32Array(chunk * 2));
    this.cur = null; this.fill = 0; this.lost = 0; this.take = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.arm) { this.armed = true; this.take = d.arm; this.lost = 0; this.fill = 0; if (this.cur) { this.pool.push(this.cur); this.cur = null; } }
      else if (d === 'disarm') { this.armed = false; if (this.cur) { this.pool.push(this.cur); this.cur = null; } }
      else if (d instanceof ArrayBuffer && d.byteLength === this.chunk * 8) this.pool.push(new Float32Array(d));
    };
  }

  // Over the port: copy this block into chunks, sending each when full.
  processOverPort(inputs) {
    if (!this.armed) return true;
    const input = inputs[0];
    const L = input && input[0], R = (input && input[1]) || L, n = L ? L.length : 128;
    for (let i = 0; i < n; i++) {
      if (!this.cur) {
        this.cur = this.pool.pop() || null;
        this.fill = 0;
        if (!this.cur) { this.lost += n - i; break; } // the page fell behind: count, don't wait
      }
      const c = this.cur, k = 2 * this.fill;
      c[k] = L ? L[i] : 0; c[k + 1] = R ? R[i] : 0;
      if (++this.fill === this.chunk) {
        this.port.postMessage({ data: c, frames: this.fill, dropped: this.lost, take: this.take }, [c.buffer]);
        this.cur = null; this.lost = 0;
      }
    }
    return true;
  }

  process(inputs) {
    if (this.overPort) return this.processOverPort(inputs);
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
