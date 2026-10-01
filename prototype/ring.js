// ring.js — lock-free single-producer / single-consumer event queue over a
// SharedArrayBuffer. The page writes gestures and parameter changes; the audio
// thread drains them at the top of each block. Same design the C++ plugin will
// use between UI and processBlock: no locks, no allocation on either side.
//
// Layout: Int32 [read, write] header, then `capacity` slots of EVENT_FLOATS
// floats each: [type, a, b, c, d, e, f, g].

export const EVENT_FLOATS = 8;
export const EV_DROP = 1; // x, y, strength
export const EV_STROKE = 2; // x0, y0, x1, y1, speed (a drag segment)
export const EV_PARAM = 3; // paramIndex, value
export const EV_STONE = 4; // index, x, y, hz — staged until EV_STONES_COMMIT
export const EV_STONES_COMMIT = 5; // count — the staged stones go live together
export const EV_LOOP = 6; // layer, action (looper.js LOOP_*)
export const EV_STONE_MOVE = 7; // index, x, y — move one stone now (no commit needed)

const HEADER_BYTES = 8;

export function createRingBuffer(capacity = 256) {
  return new SharedArrayBuffer(HEADER_BYTES + capacity * EVENT_FLOATS * 4);
}

export class RingWriter {
  constructor(sab) {
    this.idx = new Int32Array(sab, 0, 2);
    this.data = new Float32Array(sab, HEADER_BYTES);
    this.capacity = this.data.length / EVENT_FLOATS;
  }

  // Returns false (event dropped) if the queue is full.
  push(type, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0) {
    const w = Atomics.load(this.idx, 1);
    const next = (w + 1) % this.capacity;
    if (next === Atomics.load(this.idx, 0)) return false;
    const o = w * EVENT_FLOATS;
    const s = this.data;
    s[o] = type; s[o + 1] = a; s[o + 2] = b; s[o + 3] = c;
    s[o + 4] = d; s[o + 5] = e; s[o + 6] = f; s[o + 7] = g;
    Atomics.store(this.idx, 1, next); // publish after the payload is written
    return true;
  }
}

export class RingReader {
  constructor(sab) {
    this.idx = new Int32Array(sab, 0, 2);
    this.data = new Float32Array(sab, HEADER_BYTES);
    this.capacity = this.data.length / EVENT_FLOATS;
  }

  // Calls handler(data, offset) for each pending event; bounded by capacity.
  drain(handler) {
    let r = Atomics.load(this.idx, 0);
    const w = Atomics.load(this.idx, 1);
    let n = 0;
    while (r !== w && n < this.capacity) {
      handler(this.data, r * EVENT_FLOATS);
      r = (r + 1) % this.capacity;
      n++;
    }
    Atomics.store(this.idx, 0, r);
    return n;
  }
}
