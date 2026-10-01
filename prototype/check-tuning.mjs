// check-tuning.mjs — checks for the minimal tuning core (tuning.js).
//   node check-tuning.mjs

import { SCALES, REFERENCES, noteToHz, buildPitches, noteLabel, MAX_PITCHES } from './tuning.js';
import { RANGE_LOW, RANGE_HIGH, REF_MIN_HZ, REF_MAX_HZ } from './tuning-limits.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const cents = (a, b) => 1200 * Math.log2(a / b);
const near = (a, b, maxCents = 0.01) => Math.abs(cents(a, b)) <= maxCents;
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('\n1. Reference pitch');
report(noteToHz(69) === 440, 'A4 = 440 Hz by default');
report(near(noteToHz(60), 261.6255653), 'C4 = 261.63 Hz at A = 440', noteToHz(60).toFixed(4));
report(near(noteToHz(60, REFERENCES.a432), 256.8687), 'C4 = 256.87 Hz at A = 432', noteToHz(60, REFERENCES.a432).toFixed(4));
{
  const ref = { note: 69, hz: 415.3 }; // baroque pitch: arbitrary floats work
  report(noteToHz(69, ref) === 415.3 && near(noteToHz(81, ref), 830.6), 'arbitrary reference (A = 415.3)');
  const ref2 = { note: 60, hz: 256 }; // reference on a different note
  report(near(noteToHz(69, ref2), 256 * Math.pow(2, 9 / 12)), 'reference on another note (C4 = 256)');
}

console.log('\n2. Building pitches from scale, root and range');
{
  const p = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
  const notes = p.map((x) => x.note);
  const expected = [];
  for (let o = -1; o <= 1; o++) for (const c of [0, 2, 4, 7, 9]) expected.push(60 + 12 * o + c);
  expected.push(84);
  report(notes.length === 16 && notes.every((n, i) => n === expected[i]),
    'C major pentatonic, C3–C6: 16 pitches, exact notes', `${p[0].label} … ${p.at(-1).label}`);
  report(near(p[0].hz, 130.8127827) && near(p.at(-1).hz, 1046.502261), 'end pitches 130.81 Hz and 1046.50 Hz');
  report(p.every((x, i) => i === 0 || x.note > p[i - 1].note), 'sorted low → high');
}
{
  // Root above the bottom of the range: scale continues downward below the root.
  const p = buildPitches({ scale: SCALES.dorian, root: 62, low: 55, high: 67 });
  report(p.map((x) => x.label).join(' ') === 'G3 A3 B3 C4 D4 E4 F4 G4', 'D dorian, G3–G4 (root inside range)', p.map((x) => x.label).join(' '));
}
{
  // Range that isn't on scale notes at either end.
  const p = buildPitches({ scale: SCALES.major, root: 60, low: 60.5, high: 63.5 });
  report(p.map((x) => x.note).join(',') === '62', 'range edges between scale notes include only what lies inside', p.map((x) => x.label).join(' '));
}
{
  const p432 = buildPitches({ scale: SCALES.minor, root: 57, reference: REFERENCES.a432, low: 45, high: 69 });
  const p440 = buildPitches({ scale: SCALES.minor, root: 57, low: 45, high: 69 });
  report(p432.length === p440.length && p432.every((x, i) => near(x.hz / p440[i].hz, 432 / 440, 1e-6)),
    'A = 432 shifts every pitch by exactly 432/440');
}

console.log('\n3. Beyond 12-TET');
{
  const p = buildPitches({ scale: SCALES.rast, root: 60, low: 60, high: 72 });
  const e = p.find((x) => x.degree === 2), b = p.find((x) => x.degree === 6);
  report(near(e.hz, 261.6255653 * Math.pow(2, 350 / 1200)) && e.label === 'E4 −50¢',
    'Rast: E half-flat at 350 cents', `${e.label}, ${e.hz.toFixed(2)} Hz`);
  report(b.label === 'B4 −50¢', 'Rast: B half-flat at 1050 cents', b.label);
}
{
  // Bohlen–Pierce: 13 equal steps of a 3:1 "tritave" — a period that isn't an octave.
  const period = 1200 * Math.log2(3);
  const bp = { name: 'Bohlen–Pierce', cents: Array.from({ length: 13 }, (_, i) => (i * period) / 13), period };
  const p = buildPitches({ scale: bp, root: 60, low: 60, high: 60 + 2 * period / 100 });
  report(p.length === 27 && near(p[13].hz / p[0].hz, 3, 1e-6) && near(p[26].hz / p[0].hz, 9, 1e-6),
    'non-octave period (Bohlen–Pierce tritave)', `${p.length} pitches, period ratio ${(p[13].hz / p[0].hz).toFixed(6)}`);
}

console.log('\n4. Labels');
{
  const cases = [[60, 'C4'], [61, 'C♯4'], [70, 'B♭4'], [21, 'A0'], [63.5, 'E4 −50¢'], [60.25, 'C4 +25¢'], [59.99, 'C4 −1¢']];
  const bad = cases.filter(([n, l]) => noteLabel(n) !== l).map(([n, l]) => `${n}: got ${noteLabel(n)}, want ${l}`);
  report(bad.length === 0, 'note names and cent deviations', bad.join('; '));
}

console.log('\n5. Bad input is rejected');
{
  const ok = { scale: SCALES.major, root: 60, low: 48, high: 72 };
  const cases = {
    'descending cents': { ...ok, scale: { cents: [0, 300, 200], period: 1200 } },
    'step ≥ period': { ...ok, scale: { cents: [0, 1200], period: 1200 } },
    'negative step': { ...ok, scale: { cents: [-100, 0], period: 1200 } },
    'empty scale': { ...ok, scale: { cents: [], period: 1200 } },
    'scale not starting at the root': { ...ok, scale: { cents: [100, 300], period: 1200 } },
    'zero period': { ...ok, scale: { cents: [0], period: 0 } },
    'NaN root': { ...ok, root: NaN },
    'low > high': { ...ok, low: 72, high: 48 },
    'zero reference Hz': { ...ok, reference: { note: 69, hz: 0 } },
    'infinite range': { ...ok, high: Infinity },
    [`more than ${MAX_PITCHES} pitches`]: { ...ok, scale: SCALES.chromatic, low: 0, high: 200 },
  };
  const missed = Object.entries(cases).filter(([, args]) => !throws(() => buildPitches(args))).map(([k]) => k);
  report(missed.length === 0, `${Object.keys(cases).length} kinds of bad input throw`, missed.length ? `not rejected: ${missed.join(', ')}` : '');
}

console.log('\n6. Edges and guarantees');
{
  const p = buildPitches({ scale: SCALES.major, root: 60, low: 61.1, high: 61.9 });
  report(Array.isArray(p) && p.length === 0, 'a range with no scale notes gives zero pitches (valid, not an error)');
}
{
  const at128 = !throws(() => buildPitches({ scale: SCALES.chromatic, root: 60, low: 0, high: 127 }));
  const at129 = throws(() => buildPitches({ scale: SCALES.chromatic, root: 60, low: 0, high: 128 }));
  report(at128 && at129, `MAX_PITCHES boundary: ${MAX_PITCHES} allowed, ${MAX_PITCHES + 1} rejected`);
}
{
  let mutated = false;
  try { SCALES.major.cents.push(1150); } catch { /* frozen */ }
  try { SCALES.major.period = 1000; } catch { /* frozen */ }
  try { REFERENCES.a440.hz = 1; } catch { /* frozen */ }
  mutated = SCALES.major.cents.length !== 7 || SCALES.major.period !== 1200 || REFERENCES.a440.hz !== 440;
  report(!mutated, 'built-in scales and references are read-only');
}
{
  const a = noteLabel(63.5), b = noteLabel(63.49999999999999);
  report(a === 'E4 −50¢' && b === 'E4 −50¢', 'quarter-tone labels are stable against float noise', `${a} / ${b}`);
}

console.log('\n7. Every setting the page allows gives playable stones');
{
  // Every scale × root × reference at the limits and in between × a spread of ranges.
  let combos = 0, maxCount = 0, lo = Infinity, hi = 0, bad = 0;
  const refs = [REF_MIN_HZ, 415.3, 432, 440, REF_MAX_HZ];
  for (const scale of Object.values(SCALES)) for (let root = 0; root < 12; root++) for (const hz of refs) {
    for (let low = RANGE_LOW; low <= RANGE_HIGH; low += 7) for (let high = low; high <= RANGE_HIGH; high += 5) {
      combos++;
      let p;
      try { p = buildPitches({ scale, root: 60 + root, reference: { note: 69, hz }, low, high }); } catch { bad++; continue; }
      maxCount = Math.max(maxCount, p.length);
      for (const x of p) { lo = Math.min(lo, x.hz); hi = Math.max(hi, x.hz); }
    }
  }
  report(bad === 0 && maxCount <= MAX_PITCHES && lo >= 8 && hi < 0.45 * 44100,
    `${combos} reachable settings: none rejected, at most ${maxCount} stones`, `pitches ${lo.toFixed(1)}–${hi.toFixed(0)} Hz (limits 8 Hz – ${(0.45 * 44100).toFixed(0)} Hz)`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll tuning checks passed.');
process.exit(failures ? 1 : 0);
