// layout.js — where stones sit on the surface: scattered, evenly spread but
// irregular, like stones dropped on a pond (Mitchell's best-candidate
// sampling with fixed pseudo-random candidates). Stone i is placed only from
// stones 0..i−1, so changing the range adds or removes stones at the end
// without moving the rest. (Dash preferred this to pitch-by-position in the
// Phase 1b listening session.)
//
// Not for the audio path (allocates). Positions are in [0, 1]² of the
// surface; distances account for its shape (ASPECT = height / width).


const MARGIN = 0.08;
const ASPECT = 97 / 128;
const CANDIDATES = 24;

// `seed` picks a different arrangement (randomize); `spread` in [0, 1] goes
// from gathered (stones loosely clustered around the middle, with natural
// clumps) to spread evenly over the whole pond (the default).
export function stonePositions(count, { seed = 0, spread = 1 } = {}) {
  const xs = new Float64Array(count), ys = new Float64Array(count);
  const s = spread < 0 ? 0 : spread > 1 ? 1 : spread;
  const span = (1 - 2 * MARGIN) * (0.35 + 0.65 * s); // the region stones fill
  const lo = 0.5 - span / 2;
  const candidates = Math.max(1, Math.round(1 + (CANDIDATES - 1) * (0.25 + 0.75 * s))); // fewer = clumpier
  const salt = Math.imul(seed | 0, 2 * CANDIDATES + 7);
  for (let i = 0; i < count; i++) {
    let bestX = 0.5, bestY = 0.5, bestD = -1;
    for (let k = 0; k < candidates; k++) {
      const cx = lo + span * hash01(i, salt + 2 * k + 1);
      const cy = lo + span * hash01(i, salt + 2 * k + 2);
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
