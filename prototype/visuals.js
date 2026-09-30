// visuals.js — audio thread → page snapshots of the medium for drawing.
//
// A seqlock over a SharedArrayBuffer: the audio thread bumps a counter to odd,
// writes the frame, bumps it to even. The page copies the frame and keeps it
// only if the counter was even and unchanged across the copy. Neither side
// waits or allocates; a torn frame is simply skipped.
//
// JS caveat: plain Float32 accesses aren't ordered against the Atomics ops,
// so rarely (~1 in millions under stress) a frame mixing two consecutive
// frames gets through. Harmless for display. The C++ port must use fences
// (release after the first increment, acquire before the re-check) or a
// lock-free triple buffer instead.
//
// Frame layout (Float32): [totalEnergy, outputPeak, cell0, cell1, …] where
// cells are the N×N local energy densities averaged over the frame.

export const FRAME_HEADER = 2;

export function createVisualBuffer(cells) {
  return new SharedArrayBuffer(8 + (FRAME_HEADER + cells) * 4);
}

export class VisualWriter {
  constructor(sab) {
    this.seq = new Int32Array(sab, 0, 1);
    this.frame = new Float32Array(sab, 8);
  }

  // acc holds sums over `count` accumulations; published as averages.
  publish(acc, count, totalEnergy, outputPeak) {
    const f = this.frame, inv = count > 0 ? 1 / count : 0;
    Atomics.add(this.seq, 0, 1); // odd: writing
    f[0] = totalEnergy;
    f[1] = outputPeak;
    for (let i = 0; i < acc.length; i++) f[FRAME_HEADER + i] = acc[i] * inv;
    Atomics.add(this.seq, 0, 1); // even: done
  }
}

export class VisualReader {
  constructor(sab) {
    this.seq = new Int32Array(sab, 0, 1);
    this.frame = new Float32Array(sab, 8);
    this.copy = new Float32Array(this.frame.length);
    this.scratch = new Float32Array(this.frame.length);
    this.lastSeq = -1;
  }

  // Returns the latest complete frame, or null if there's nothing new/whole.
  read() {
    const s1 = Atomics.load(this.seq, 0);
    if (s1 & 1 || s1 === this.lastSeq) return null;
    this.scratch.set(this.frame);
    if (Atomics.load(this.seq, 0) !== s1) return null;
    // Only a validated frame replaces the one handed out last time.
    const t = this.copy; this.copy = this.scratch; this.scratch = t;
    this.lastSeq = s1;
    return this.copy;
  }
}
