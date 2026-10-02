// animate.js — stones that move on their own (Dash, Oct 2026). As a stone
// moves its note changes (where a stone sits sets its pitch), always on the
// scale, so the instrument keeps composing. Four kinds, to try with testers:
//
//   drift  — each stone wanders on a smooth, slowly turning course
//   path   — stones travel a line you drew, spaced along it, back and forth
//   water  — ripples push stones away from their crests (the water moves its
//            own stones); still water leaves them be
//   camera — your movement in front of the camera pulls stones toward it
//
// Page-side and pure: step() takes the stones' positions and returns new
// ones; the page sends the moves (and new pitches) to the audio thread.
// Positions are in [0, 1]² of the pond; stones stay inside MARGIN.

export const ANIMATE_MODES = ['off', 'drift', 'path', 'water', 'camera'];
const MARGIN = 0.03;
const MAX_SPEED = 0.35; // pond widths per second at full speed
const REST_SPEED = 1e-4; // pond widths per second: slower than this is stopped

export class Animator {
  constructor(seed = 1) {
    this.mode = 'off';
    this.speed = 0.2; // 0..1 (a gentle default: drift at full speed reshuffles notes every second)
    this.path = []; // [{ x, y }, …] drawn by the performer
    this.pathLength = 0;
    this.phase = 0; // how far along the path (0..1), shared by all stones
    this.vx = new Float64Array(0); this.vy = new Float64Array(0); // per-stone velocity (pond widths / s)
    this.heading = new Float64Array(0); // drift: each stone's slowly turning direction
    this.rng = seed >>> 0 || 1;
  }

  setPath(points) {
    this.path = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => ({ x: clamp(p.x), y: clamp(p.y) }));
    let len = 0;
    for (let i = 1; i < this.path.length; i++) len += Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].y - this.path[i - 1].y);
    this.pathLength = len;
  }

  // Advance `dt` seconds. xs, ys: Float64Arrays of the stones' positions,
  // changed in place. `still(i)`: a stone being held or dragged (left alone).
  // `heights(x, y)` (water) gives the water's height at a pond position;
  // `motion` (camera) is { x, y, amount } — where movement is and how much.
  // Returns true if anything moved.
  step(dt, xs, ys, { still = () => false, heights = null, motion = null } = {}) {
    const n = xs.length;
    if (this.mode === 'off' || n === 0 || !(dt > 0)) return false;
    dt = Math.min(dt, 0.1); // a stalled frame doesn't fling stones
    this.ensure(n);
    const speed = this.speed * MAX_SPEED;
    if (this.mode === 'path') return this.followPath(dt, xs, ys, still, speed);
    let moved = false;
    for (let i = 0; i < n; i++) {
      if (still(i)) { this.vx[i] = this.vy[i] = 0; continue; }
      let ax = 0, ay = 0, damping = 1.5;
      if (this.mode === 'drift') {
        // A smooth wander: the heading turns a little at random each step.
        this.heading[i] += (this.rand() - 0.5) * 4 * dt;
        ax = (Math.cos(this.heading[i]) * speed - this.vx[i]) * 1.5;
        ay = (Math.sin(this.heading[i]) * speed - this.vy[i]) * 1.5;
        damping = 0;
      } else if (this.mode === 'water' && heights) {
        // Pushed downhill, away from the crest: the slope of the water at the stone.
        const e = 0.02;
        const gx = (heights(xs[i] + e, ys[i]) - heights(xs[i] - e, ys[i])) / (2 * e);
        const gy = (heights(xs[i], ys[i] + e) - heights(xs[i], ys[i] - e)) / (2 * e);
        ax = -gx * 6 * this.speed; ay = -gy * 6 * this.speed;
      } else if (this.mode === 'camera' && motion && motion.amount > 1e-3) {
        // Pulled toward where the movement is, harder for more movement.
        const dx = motion.x - xs[i], dy = motion.y - ys[i], d = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, motion.amount) * speed * 4;
        ax = (dx / d) * pull; ay = (dy / d) * pull;
      }
      this.vx[i] += (ax - damping * this.vx[i]) * dt;
      this.vy[i] += (ay - damping * this.vy[i]) * dt;
      // The motion knob caps every kind's speed (drift already aims at it).
      const v = Math.hypot(this.vx[i], this.vy[i]);
      if (v > speed) { this.vx[i] *= speed / v; this.vy[i] *= speed / v; }
      // Come to rest: a stone creeping slower than this has stopped (so still
      // water lets the page stop redrawing and sending moves).
      if (v < REST_SPEED && damping > 0) { this.vx[i] = this.vy[i] = 0; continue; }
      let x = xs[i] + this.vx[i] * dt, y = ys[i] + this.vy[i] * dt;
      // The walls: bounce back in.
      if (x < MARGIN) { x = MARGIN; this.vx[i] = Math.abs(this.vx[i]); this.heading[i] = Math.PI - this.heading[i]; }
      if (x > 1 - MARGIN) { x = 1 - MARGIN; this.vx[i] = -Math.abs(this.vx[i]); this.heading[i] = Math.PI - this.heading[i]; }
      if (y < MARGIN) { y = MARGIN; this.vy[i] = Math.abs(this.vy[i]); this.heading[i] = -this.heading[i]; }
      if (y > 1 - MARGIN) { y = 1 - MARGIN; this.vy[i] = -Math.abs(this.vy[i]); this.heading[i] = -this.heading[i]; }
      if (x !== xs[i] || y !== ys[i]) { xs[i] = x; ys[i] = y; moved = true; }
    }
    return moved;
  }

  // The drawn line, travelled at `speed`; stones spaced evenly along it.
  followPath(dt, xs, ys, still, speed) {
    if (this.path.length < 2 || this.pathLength < 1e-3) return false;
    this.phase = (this.phase + (speed * dt) / (2 * this.pathLength)) % 1; // there and back is one cycle
    let moved = false;
    for (let i = 0; i < xs.length; i++) {
      if (still(i)) continue;
      // Back and forth along the line (no jump from its end to its start).
      const f = (this.phase + i / xs.length) % 1;
      const p = this.pointAt(f < 0.5 ? 2 * f : 2 - 2 * f);
      // Ease toward the path point, so stones glide onto the line rather than jump.
      const k = Math.min(1, dt * 6);
      const x = xs[i] + (p.x - xs[i]) * k, y = ys[i] + (p.y - ys[i]) * k;
      if (x !== xs[i] || y !== ys[i]) { xs[i] = x; ys[i] = y; moved = true; }
    }
    return moved;
  }

  // The point a fraction `f` of the way along the path.
  pointAt(f) {
    let target = f * this.pathLength;
    for (let i = 1; i < this.path.length; i++) {
      const a = this.path[i - 1], b = this.path[i], seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (target <= seg || i === this.path.length - 1) {
        const t = seg > 0 ? Math.min(1, target / seg) : 0;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      target -= seg;
    }
    return this.path[this.path.length - 1];
  }

  ensure(n) {
    if (this.vx.length === n) return;
    const grow = (old) => { const a = new Float64Array(n); a.set(old.subarray(0, Math.min(n, old.length))); return a; };
    const oldN = this.heading.length;
    this.vx = grow(this.vx); this.vy = grow(this.vy); this.heading = grow(this.heading);
    for (let i = oldN; i < n; i++) this.heading[i] = this.rand() * 2 * Math.PI;
  }

  rand() {
    let x = this.rng;
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    this.rng = x;
    return x / 4294967296;
  }
}

const clamp = (v) => (v < MARGIN ? MARGIN : v > 1 - MARGIN ? 1 - MARGIN : v);

// Camera movement → where it is and how much, from two small grey frames
// (Uint8 luminance, w × h). x is mirrored, as in a mirror: you move left, the
// stones go left. Returns { x, y, amount } in pond terms (amount 0..1).
export function motionFrom(prev, cur, w, h, threshold = 24) {
  let sum = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, d = Math.abs(cur[i] - prev[i]);
      if (d > threshold) { const m = d - threshold; sum += m; sx += m * x; sy += m * y; }
    }
  }
  if (sum === 0) return { x: 0.5, y: 0.5, amount: 0 };
  const amount = Math.min(1, sum / (w * h * 8));
  return { x: 1 - (sx / sum + 0.5) / w, y: (sy / sum + 0.5) / h, amount };
}
