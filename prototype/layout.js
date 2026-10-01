// layout.js — where stones sit on the surface. Two layouts to compare while
// CLAUDE.md's open question about stone layout is answered; expect one to go.
//
//   scattered:          evenly spread but irregular, like stones dropped on
//                       a pond: Mitchell's best-candidate sampling with fixed
//                       pseudo-random candidates. Stone i is placed only from
//                       stones 0..i−1, so changing the range adds or removes
//                       stones at the end without moving the rest.
//   pitchByPosition:    low notes on the left, high on the right; heights
//                       from the scattered layout.
//
// Not for the audio path (allocates). Positions are in [0, 1]² of the
// surface; distances account for its shape (ASPECT = height / width).

export const LAYOUTS = { scattered: 'Scattered', pitchByPosition: 'Pitch by position' };

const MARGIN = 0.08;
const ASPECT = 97 / 128;
const CANDIDATES = 24;

export function stonePositions(count, layout = 'scattered') {
  const xs = new Float64Array(count), ys = new Float64Array(count);
  const span = 1 - 2 * MARGIN;
  for (let i = 0; i < count; i++) {
    let bestX = 0.5, bestY = 0.5, bestD = -1;
    for (let k = 0; k < CANDIDATES; k++) {
      const cx = MARGIN + span * hash01(i, 2 * k + 1);
      const cy = MARGIN + span * hash01(i, 2 * k + 2);
      let d = Infinity;
      for (let j = 0; j < i; j++) {
        const dx = cx - xs[j], dy = (cy - ys[j]) * ASPECT;
        const dd = dx * dx + dy * dy;
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; bestX = cx; bestY = cy; }
    }
    xs[i] = bestX;
    ys[i] = bestY;
  }
  if (layout === 'pitchByPosition') {
    for (let i = 0; i < count; i++) xs[i] = MARGIN + span * (count > 1 ? i / (count - 1) : 0.5);
  }
  return { xs, ys };
}

// A fixed pseudo-random number in [0, 1) for (i, salt): same every time.
function hash01(i, salt) {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
