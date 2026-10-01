// layout.js — where stones sit on the surface. Two layouts to compare while
// CLAUDE.md's open question about stone layout is answered; expect one to go.
//
//   scattered:          evenly spread but irregular (an R2 low-discrepancy
//                       sequence). Stone i always gets point i, so changing
//                       the range adds or removes stones without reshuffling
//                       the rest.
//   pitchByPosition:    low notes on the left, high on the right; heights
//                       scattered the same way.
//
// Not for the audio path (allocates). Positions are in [0, 1]².

export const LAYOUTS = { scattered: 'Scattered', pitchByPosition: 'Pitch by position' };

const MARGIN = 0.08;
const PLASTIC = 1.324717957244746; // R2 sequence constant
const A1 = 1 / PLASTIC, A2 = 1 / (PLASTIC * PLASTIC);

export function stonePositions(count, layout = 'scattered') {
  const xs = new Float64Array(count), ys = new Float64Array(count);
  const span = 1 - 2 * MARGIN;
  for (let i = 0; i < count; i++) {
    const rx = frac(0.5 + A1 * (i + 1)), ry = frac(0.5 + A2 * (i + 1));
    xs[i] = MARGIN + span * (layout === 'pitchByPosition' ? (count > 1 ? i / (count - 1) : 0.5) : rx);
    ys[i] = MARGIN + span * ry;
  }
  return { xs, ys };
}

function frac(v) {
  return v - Math.floor(v);
}
