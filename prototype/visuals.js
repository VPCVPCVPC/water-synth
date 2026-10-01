// visuals.js — audio thread → page frames for drawing the water.
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
// Frame layout (Float32):
//   [0]                     surface energy
//   [1]                     output peak since the last frame
//   [2 .. 2+MAX_STONES)     per stone: loudest audible strike since the last frame (0 = none)
//   [FRAME_LOOPS ..)        per looper layer, LOOP_FIELDS each: state, muted, length (steps),
//                           position (steps), fill (0–1), waiting for its downbeat (0/1)
//   [FRAME_TAPES ..)        per tape track, TAPE_FIELDS each: state, muted, length (s),
//                           position (s), waiting for a bar line, fading-out code
//   [FRAME_HEIGHTS ..)      the water's heights, w × h, row by row

import { MAX_STONES } from './stones.js';
import { LOOP_LAYERS } from './looper.js';
import { TAPE_TRACKS, TAPE_FIELDS } from './tape.js';

export const LOOP_FIELDS = 6;
export const FRAME_FLASH = 2;
export const FRAME_LOOPS = FRAME_FLASH + MAX_STONES;
export const FRAME_TAPES = FRAME_LOOPS + LOOP_LAYERS * LOOP_FIELDS;
export const FRAME_HEIGHTS = FRAME_TAPES + TAPE_TRACKS * TAPE_FIELDS;

export function frameLength(cells) {
  return FRAME_HEIGHTS + cells;
}

export function createVisualBuffer(cells) {
  return new SharedArrayBuffer(8 + frameLength(cells) * 4);
}

export class VisualWriter {
  constructor(sab) {
    this.seq = new Int32Array(sab, 0, 1);
    this.frame = new Float32Array(sab, 8);
  }

  // Write between begin() and end(); begin() returns the frame to fill.
  begin() {
    Atomics.add(this.seq, 0, 1); // odd: writing
    return this.frame;
  }

  end() {
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
