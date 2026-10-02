// record.js — "record piece": what you hear (water and tape), saved as a WAV.
//
// A small tap on the audio thread (rec-worklet.js) copies the output into a
// shared ring; the page drains it a few times a second into 16-bit chunks
// (with TPDF dither) and, on stop, writes a stereo WAV. Lossless up to the
// 16-bit file; nothing waits on the audio thread. Capped at MAX_RECORD_SECONDS
// so a phone never runs out of memory (16-bit stereo is ~11.5 MB a minute at
// 48 kHz).

export const MAX_RECORD_SECONDS = 600; // a phone gets less (see PieceRecorder's maxSeconds)
const RING_SECONDS = 2; // the audio thread can run this far ahead of the page
const DRAIN_MS = 100;
const FOLD_BYTES = 4 * 1048576;

export class PieceRecorder {
  // `source` is the node whose output is recorded. Call after the tap module
  // (rec-worklet.js) has been added to the context.
  constructor(ctx, source, { maxSeconds = MAX_RECORD_SECONDS } = {}) {
    this.fs = ctx.sampleRate;
    this.maxSeconds = maxSeconds;
    const cap = Math.ceil(RING_SECONDS * this.fs);
    this.buffer = new SharedArrayBuffer(16 + cap * 2 * 4);
    this.idx = new Int32Array(this.buffer, 0, 4);
    this.ring = new Float32Array(this.buffer, 16);
    this.cap = cap;
    this.node = new AudioWorkletNode(ctx, 'tap', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
      processorOptions: { buffer: this.buffer },
    });
    source.connect(this.node);
    this.chunks = [];
    this.parts = []; // older chunks, folded into Blobs (the browser can keep them off the page's memory)
    this.pending = 0; // bytes in `chunks`
    this.frames = 0;
    this.gapFrames = 0; // time the page fell behind for, kept as silence
    this.seenDropped = 0;
    this.timer = 0;
    this.dither = { seed: 0x2545f491 };
    this.onlimit = null; // called if a recording reaches MAX_RECORD_SECONDS
  }

  get recording() { return Atomics.load(this.idx, 2) === 1; }
  get seconds() { return this.frames / this.fs; }
  get dropped() { return Atomics.load(this.idx, 3); }
  get gapSeconds() { return this.gapFrames / this.fs; }

  start() {
    this.chunks = [];
    this.parts = [];
    this.pending = 0;
    this.frames = 0;
    this.gapFrames = 0;
    this.seenDropped = 0;
    Atomics.store(this.idx, 0, 0);
    Atomics.store(this.idx, 1, 0);
    Atomics.store(this.idx, 3, 0);
    Atomics.store(this.idx, 2, 1);
    this.timer = setInterval(() => this.drain(), DRAIN_MS);
  }

  // Stop, and return the piece as a WAV Blob (null if nothing was recorded).
  stop() {
    Atomics.store(this.idx, 2, 0);
    clearInterval(this.timer);
    this.drain();
    if (this.frames === 0) return null;
    const blob = wavBlob([...this.parts, ...this.chunks], this.frames, this.fs);
    this.chunks = []; this.parts = []; this.pending = 0;
    return blob;
  }

  drain() {
    const limit = Math.floor(this.maxSeconds * this.fs);
    // Drops first, then the write index: every frame written before a counted
    // drop is then in this drain, so the silence always lands after it.
    const dropped = Atomics.load(this.idx, 3);
    const r = Atomics.load(this.idx, 0), w = Atomics.load(this.idx, 1);
    let n = (w - r + this.cap) % this.cap;
    const room = Math.max(0, limit - this.frames);
    if (n > room) n = room;
    if (n > 0) {
      const out = new Int16Array(n * 2);
      const first = Math.min(n, this.cap - r);
      toInt16(out, 0, this.ring, r * 2, first * 2, this.dither);
      if (first < n) toInt16(out, first * 2, this.ring, 0, (n - first) * 2, this.dither);
      this.chunks.push(out);
      this.pending += out.byteLength;
      this.frames += n;
      Atomics.store(this.idx, 0, (r + n) % this.cap);
    }
    // Frames the audio thread couldn't fit (the page fell behind — a hidden
    // tab, a long stall) came after what was in the ring: keep the timeline
    // by putting that much silence here, rather than splicing across it.
    if (dropped > this.seenDropped) {
      const gap = Math.min(dropped - this.seenDropped, Math.max(0, limit - this.frames));
      if (gap > 0) { this.chunks.push(new Int16Array(gap * 2)); this.frames += gap; this.gapFrames += gap; }
      this.seenDropped = dropped;
    }
    // Every ~4 MB, fold the chunks into a Blob: the finished file then joins
    // Blobs instead of copying a whole piece's samples a second time.
    if (this.pending >= FOLD_BYTES) { this.parts.push(new Blob(this.chunks)); this.chunks = []; this.pending = 0; }
    if (this.recording && this.frames >= limit) {
      Atomics.store(this.idx, 2, 0);
      if (this.onlimit) this.onlimit();
    }
  }
}

// Float samples → 16-bit with TPDF dither (±1 LSB), clipped. `rng` is
// { seed } (a xorshift state), so tests can repeat it.
export function toInt16(dst, at, src, from, count, rng) {
  let x = rng.seed >>> 0 || 1;
  for (let i = 0; i < count; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const a = x / 4294967296;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const b = x / 4294967296;
    const s = src[from + i];
    const v = Math.round((Number.isFinite(s) ? s : 0) * 32767 + (a - b));
    dst[at + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  rng.seed = x;
}

// A 16-bit stereo PCM WAV from interleaved Int16 chunks (or Blobs of them).
export function wavBlob(chunks, frames, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const bytes = frames * 4;
  const text = (o, s) => { for (let i = 0; i < s.length; i++) header.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); header.setUint32(4, 36 + bytes, true); text(8, 'WAVE');
  text(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 2, true); header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 4, true); header.setUint16(32, 4, true); header.setUint16(34, 16, true);
  text(36, 'data'); header.setUint32(40, bytes, true);
  return new Blob([header.buffer, ...chunks], { type: 'audio/wav' });
}

// "water-synth-2026-10-02-1430.wav"
export function pieceName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `water-synth-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.wav`;
}
