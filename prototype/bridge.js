// bridge.js — the page ↔ audio-thread links without shared memory.
//
// The instrument normally talks to its audio thread through
// SharedArrayBuffers (ring.js for events, visuals.js for frames, the piece
// recorder's ring), which a browser only allows on a cross-origin isolated
// page. The app stores' web views (iOS's WKWebView, Android's WebView) can't
// be isolated, so there the same links go over the worklet's MessagePort
// instead — with the same interfaces, so nothing else in the page or the
// engine changes:
//
//   events  page → audio: PortRingWriter (page) batches pushes and posts
//           them once per task; PortEventInbox (audio) copies each batch
//           into a local ring (ring.js's own layout, unshared) that
//           process() drains at the top of a block, as before.
//   frames  audio → page: PortFramePublisher (audio) fills a frame from a
//           small pool of buffers and transfers it; PortFrameReader (page)
//           copies the newest into its own frame and transfers the buffer
//           straight back. A frame with no free buffer is skipped.
//
// Messages are tagged by type: events are Float32Arrays, returned frame
// buffers are ArrayBuffers. Nothing is allocated inside process(): what
// messages cost (the event objects, a view on a returned buffer) happens in
// the port's handler, between blocks, and frames travel in the pool.

import { EVENT_FLOATS, createRingBuffer, RingWriter, RingReader } from './ring.js';

// Whether the shared-memory links can be used here.
export function canShare() {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
}

// ---- events: page → audio -------------------------------------------------------------

export class PortRingWriter {
  constructor(port, capacity = 1024) {
    this.port = port;
    this.capacity = capacity;
    this.batch = new Float32Array(capacity * EVENT_FLOATS);
    this.n = 0;
    this.queued = false;
  }

  // Same as RingWriter.push: false (dropped) only if a single task pushes
  // more than `capacity` events — the audio side's ring is the same size.
  push(type, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0) {
    if (this.n >= this.capacity) return false;
    const o = this.n * EVENT_FLOATS, s = this.batch;
    s[o] = type; s[o + 1] = a; s[o + 2] = b; s[o + 3] = c;
    s[o + 4] = d; s[o + 5] = e; s[o + 6] = f; s[o + 7] = g;
    this.n++;
    if (!this.queued) { this.queued = true; queueMicrotask(() => this.flush()); }
    return true;
  }

  flush() {
    this.queued = false;
    if (this.n === 0) return;
    const out = this.batch.slice(0, this.n * EVENT_FLOATS);
    this.n = 0;
    this.port.postMessage(out, [out.buffer]);
  }
}

// Nothing is ever dropped here: the page believes every push it made went
// through (it only retries pushes refused at once), so what doesn't fit the
// ring — batches piling up while the audio was suspended, say — waits in a
// backlog (kept by the message handler, between blocks) and moves into the
// ring, in order, as process() drains it.
export class PortEventInbox {
  constructor(capacity = 1024) {
    const buf = createRingBuffer(capacity, false);
    this.writer = new RingWriter(buf);
    this.reader = new RingReader(buf);
    this.backlog = []; // { d, o }: batches (and where in them) still to go into the ring
  }

  // A batch from the page (call from the port's message handler).
  receive(d) {
    if (this.backlog.length) { this.backlog.push({ d, o: 0 }); return; } // keep the order
    const o = this.fill(d, 0);
    if (o < d.length) this.backlog.push({ d, o });
  }

  // Push d's events from float `o` on until the ring is full; where it got to.
  fill(d, o) {
    for (; o + EVENT_FLOATS <= d.length; o += EVENT_FLOATS) {
      if (!this.writer.push(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], d[o + 5], d[o + 6], d[o + 7])) return o;
    }
    return d.length;
  }

  // Hand the ring's events to the handler, refilling it from the backlog
  // (bounded: at most one ring's worth per call).
  drain(handler) {
    const b = this.backlog;
    while (b.length) {
      const e = b[0];
      e.o = this.fill(e.d, e.o);
      if (e.o < e.d.length) break; // the ring is full: the rest next block
      b.shift();
    }
    return this.reader.drain(handler);
  }
}

// ---- frames: audio → page -------------------------------------------------------------

const FRAME_POOL = 3;

export class PortFramePublisher {
  // `length`: floats in a frame (visuals.js frameLength).
  constructor(port, length) {
    this.port = port;
    this.length = length;
    this.free = [];
    for (let i = 0; i < FRAME_POOL; i++) this.free.push(new Float32Array(length));
    this.current = null;
    this.skipped = 0; // diagnostics: frames with no free buffer (the page is behind)
  }

  // A buffer the page has finished with (call from the port's message handler).
  receive(buffer) {
    if (buffer.byteLength === this.length * 4 && this.free.length < FRAME_POOL) this.free.push(new Float32Array(buffer));
  }

  // Like VisualWriter: begin() returns the frame to fill (null: skip this one), end() sends it.
  begin() {
    this.current = this.free.pop() || null;
    if (!this.current) this.skipped++;
    return this.current;
  }

  end() {
    const f = this.current;
    this.current = null;
    if (f) this.port.postMessage(f, [f.buffer]);
  }
}

export class PortFrameReader {
  constructor(port, length) {
    this.port = port;
    this.scratch = new Float32Array(length); // the newest frame received
    this.copy = new Float32Array(length); // the frame last handed out (stays as it was until the next read)
    this.fresh = false;
  }

  // A frame from the audio thread (call from the port's message handler):
  // keep its contents, hand the buffer straight back.
  receive(frame) {
    if (frame.length === this.scratch.length) { this.scratch.set(frame); this.fresh = true; }
    this.port.postMessage(frame.buffer, [frame.buffer]);
  }

  // Like VisualReader.read: the newest frame, or null if nothing new.
  read() {
    if (!this.fresh) return null;
    this.fresh = false;
    const t = this.copy; this.copy = this.scratch; this.scratch = t;
    return this.copy;
  }
}
