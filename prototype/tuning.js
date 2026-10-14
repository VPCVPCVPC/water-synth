// tuning.js — the minimal tuning core for Phase 1b.
//
// One general engine, not a menu of scales (CLAUDE.md "Tuning and scales"):
//   scale     = an ordered list of cents offsets from the root, within a period
//   root      = a pitch, as a (possibly fractional) MIDI-style note number
//   reference = a note number and its frequency in Hz (any positive float)
//   range     = lowest and highest pitch, as note numbers
// Built-in scales are just data on top of that. Scala import, open microtonal
// and quantization strength/glide arrive with the full engine in Phase 4.
//
// Pure functions, no Web Audio; runs in the page, the AudioWorklet and Node.
// Not for the audio path: buildPitches allocates. Call it when settings change.

const scale = (name, cents) => Object.freeze({ name, cents: Object.freeze(cents), period: 1200 });

// Read-only: callers can't alter the built-ins by accident.
export const SCALES = Object.freeze({
  major: scale('Major', [0, 200, 400, 500, 700, 900, 1100]),
  minor: scale('Natural minor', [0, 200, 300, 500, 700, 800, 1000]),
  dorian: scale('Dorian', [0, 200, 300, 500, 700, 900, 1000]),
  pentatonicMajor: scale('Major pentatonic', [0, 200, 400, 700, 900]),
  pentatonicMinor: scale('Minor pentatonic', [0, 300, 500, 700, 1000]),
  chromatic: scale('Chromatic', [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100]),
  // Maqam Rast on its tonic: E and B are half-flat (24-TET quarter tones).
  rast: scale('Maqam Rast', [0, 200, 350, 500, 700, 900, 1050]),
  // Chords (Dash, Oct 2026: chord changes for a progression): only the
  // chord's notes, repeated up the range — the stones ring nothing else.
  majorTriad: scale('Major chord', [0, 400, 700]),
  minorTriad: scale('Minor chord', [0, 300, 700]),
  sus2: scale('Sus2 chord', [0, 200, 700]),
  sus4: scale('Sus4 chord', [0, 500, 700]),
  major7: scale('Major 7th chord', [0, 400, 700, 1100]),
  minor7: scale('Minor 7th chord', [0, 300, 700, 1000]),
  dominant7: scale('Dominant 7th chord', [0, 400, 700, 1000]),
});

export const REFERENCES = Object.freeze({
  a440: Object.freeze({ name: 'A = 440', note: 69, hz: 440 }),
  a432: Object.freeze({ name: 'A = 432', note: 69, hz: 432 }),
});

// Stones are one per pitch; keep the count sane. buildPitches throws past
// this — callers should catch it and keep their current stones.
export const MAX_PITCHES = 128;

const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// Frequency of a (fractional) note number under a reference.
export function noteToHz(note, reference = REFERENCES.a440) {
  return reference.hz * Math.pow(2, (note - reference.note) / 12);
}

// Every pitch of `scale` rooted at `root` that lies within [low, high]
// (note numbers, inclusive, with a hair of tolerance), sorted low → high.
// Returns [{ hz, note, degree, label }] where `note` is the fractional note
// number and `degree` the index into scale.cents.
export function buildPitches({ scale, root, reference = REFERENCES.a440, low, high }) {
  validateScale(scale);
  if (!Number.isFinite(root)) throw new RangeError('root must be a finite note number');
  if (!(reference && reference.hz > 0 && Number.isFinite(reference.hz) && Number.isFinite(reference.note))) {
    throw new RangeError('reference needs a finite note and a positive frequency');
  }
  if (!(Number.isFinite(low) && Number.isFinite(high) && low <= high)) {
    throw new RangeError('range needs finite low ≤ high');
  }

  const eps = 1e-6;
  const periodNotes = scale.period / 100;
  // Enough periods either side of the root to cover the range.
  const first = Math.floor((low - root) / periodNotes) - 1;
  const last = Math.ceil((high - root) / periodNotes) + 1;
  const out = [];
  for (let p = first; p <= last; p++) {
    for (let d = 0; d < scale.cents.length; d++) {
      const note = root + p * periodNotes + scale.cents[d] / 100;
      if (note < low - eps || note > high + eps) continue;
      out.push({ hz: noteToHz(note, reference), note, degree: d, label: noteLabel(note) });
      if (out.length > MAX_PITCHES) {
        throw new RangeError(`range holds more than ${MAX_PITCHES} pitches; narrow it`);
      }
    }
  }
  out.sort((a, b) => a.note - b.note);
  return out;
}

// Where a stone sits sets its pitch: left to right across the pond runs low
// to high through the scale notes in range (`pitches`, low to high), each note
// owning an equal band of the width (inside a small margin at the walls).
// Always a scale note — never between two. `x` in [0, 1]; null if no notes.
export const PITCH_MARGIN = 0.04;
export function pitchAtX(pitches, x) {
  const m = pitches.length;
  if (m === 0) return null;
  let f = (Number.isFinite(x) ? x : 0.5) - PITCH_MARGIN;
  f /= 1 - 2 * PITCH_MARGIN;
  const i = Math.floor((f < 0 ? 0 : f > 1 ? 1 : f) * m);
  return pitches[i >= m ? m - 1 : i];
}

// "C4", "E♭5", or with a deviation from the nearest 12-TET name: "E4 −50¢".
// Names are relative to note numbers (69 = A4), so they stay meaningful under
// any reference frequency.
export function noteLabel(note) {
  // The tiny bias makes exact quarter tones always name the upper note
  // ("E4 −50¢"), even when float noise lands a hair below the .5.
  const nearest = Math.round(note + 1e-9);
  const name = NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
  const dev = Math.round((note - nearest) * 100);
  return dev === 0 ? name : `${name} ${dev > 0 ? '+' : '−'}${Math.abs(dev)}¢`;
}

export function validateScale(scale) {
  if (!scale || !Array.isArray(scale.cents) || scale.cents.length === 0) {
    throw new RangeError('scale needs a non-empty cents list');
  }
  if (!(Number.isFinite(scale.period) && scale.period > 0)) {
    throw new RangeError('scale period must be a positive number of cents');
  }
  for (let i = 0; i < scale.cents.length; i++) {
    const c = scale.cents[i];
    if (!Number.isFinite(c) || c < 0 || c >= scale.period) {
      throw new RangeError(`scale step ${i} (${c}) must be in [0, period)`);
    }
    if (i > 0 && c <= scale.cents[i - 1]) throw new RangeError('scale cents must ascend');
  }
  // Degree 0 is the root itself (as in Scala's implicit 1/1).
  if (scale.cents[0] !== 0) throw new RangeError('scale must start at 0 cents (the root)');
}
