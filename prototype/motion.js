// motion.js — movement in front of the camera becomes gestures, like touch
// (CLAUDE.md, "Camera / motion input"): where something starts moving, a
// drop — harder for more movement; while it keeps moving, a drag that follows
// it. A dancer's hand sweeping across the frame draws a trail of ripples; a
// sudden flick drops one. The water, the stones and the tape don't care where
// a gesture came from.
//
// Pure and page-side: update() takes two small grey frames (Uint8 luminance,
// w × h, as camera.js makes them) and returns the gestures to send. Positions
// are in the camera picture's terms, mirrored like a mirror (you move to your
// left, the ripple is on your left), in [0, 1]². Nothing here sees more than
// a 32 × 24 grey thumbnail, and nothing is kept but where movement was.

const MAX_SPOTS = 4; // moving places followed at once (two hands, a head, a foot)
const MATCH = 0.18; // a spot this close (frame widths) to one seen last frame is the same thing moving
const LOST_SECONDS = 0.15; // a spot unseen this long has stopped
// How readily movement counts, from sensitivity 0 (only big, sharp moves)
// to 1 (small ones too): the bar above the camera's grain, and the movement
// a spot needs. The default sits in the middle.
const GRAIN_TIMES = [7, 3]; // movement must beat this many times the grain …
const BAR_FLOOR = 8; // … plus this many luminance steps
const MIN_MASS = [240, 40]; // movement (luminance steps × cells) a spot needs to count
export const DEFAULT_SENSITIVITY = 0.5;
const SPOT_APART = 0.17; // frame widths: closer peaks are one moving thing (a hand is one spot, not several)
const SPOT_REACH = 3; // cells each side over which a spot's movement is weighed
const MASS_PER_STRENGTH = 900; // a hand's quick wave ≈ strength 1
const MAX_STRENGTH = 2; // as hard as the hardest touch
const MIN_STRENGTH = 0.3;
const MAX_DROPS_PER_SECOND = 10; // the camera never floods the water
const MIN_DRAG = 0.008; // frame widths: smaller wobbles aren't a drag
const NOISE_ADAPT = 0.1; // how fast the grain estimate follows the camera (per frame)
const FOLLOW = 0.6; // a followed spot moves this far toward where it's seen each frame (steadies a wobbling centre)

export class MotionGestures {
  constructor() {
    this.spots = []; // { x, y, seen, moved, speed, sure, mass } — moving places being followed
    this.noise = 6; // the camera's frame-to-frame grain (the typical cell's change), learned
    this.sensitivity = DEFAULT_SENSITIVITY;
    this.hist = new Int32Array(511); // scratch: frame differences −255 … 255
    this.before = null; // the frame before `prev` (to tell a one-frame blip from movement)
    this.beforeW = 0; // its width (32 × 24 and 24 × 32 have the same number of cells)
    this.beforeShift = 0;
    this.time = 0;
    this.dropTokens = MAX_DROPS_PER_SECOND;
    this.motion = null; // scratch: movement per cell
  }

  // How much a cell must change to be movement, not grain.
  threshold() {
    const s = this.sensitivity;
    return Math.max(10, (GRAIN_TIMES[0] + (GRAIN_TIMES[1] - GRAIN_TIMES[0]) * s) * this.noise + BAR_FLOOR);
  }
  minMass() { return MIN_MASS[0] + (MIN_MASS[1] - MIN_MASS[0]) * this.sensitivity; }

  // The median of the differences in the histogram (k: how many there are).
  median(k) {
    const h = this.hist, half = k / 2;
    let c = 0;
    for (let v = 0; v < h.length; v++) { c += h[v]; if (c >= half) return v - 255; }
    return 0;
  }

  // Two consecutive frames, `dt` seconds apart → [{ type: 'drop', x, y,
  // strength } | { type: 'drag', x0, y0, x1, y1, speed }] (speed in frame
  // widths per second).
  update(prev, cur, w, h, dt) {
    const out = [];
    if (!prev || !cur || prev.length !== w * h || cur.length !== w * h || !(dt > 0)) { this.before = null; return out; }
    dt = Math.min(dt, 0.25);
    this.time += dt;
    this.dropTokens = Math.min(MAX_DROPS_PER_SECOND, this.dropTokens + MAX_DROPS_PER_SECOND * dt);
    if (!this.motion || this.motion.length !== w * h) this.motion = new Float32Array(w * h);
    const m = this.motion;

    // The whole picture brightening or dimming at once — the camera's
    // exposure adjusting, a light flickering — isn't movement: the median
    // change over the frame is taken off every cell first. Then the grain:
    // the median of what's left (movement only ever covers part of the
    // frame, so it barely moves the median, and dancing never raises the bar).
    const n = w * h, hist = this.hist;
    hist.fill(0);
    let any = false;
    for (let i = 0; i < n; i++) { const d = cur[i] - prev[i]; hist[d + 255]++; if (d) any = true; }
    if (!any) { // the same frame twice (a camera that repeats one): nothing to learn or see, but time passes
      this.spots = this.spots.filter((o) => this.time - o.seen <= LOST_SECONDS);
      return out;
    }
    const shift = this.median(n);
    hist.fill(0);
    for (let i = 0; i < n; i++) { const d = cur[i] - prev[i] - shift; hist[(d < 0 ? -d : d) + 255]++; }
    const grain = Math.max(1, this.median(n));
    this.noise += (grain - this.noise) * NOISE_ADAPT;
    const t = this.threshold(), minMass = this.minMass();
    for (let i = 0; i < n; i++) { const d = Math.abs(cur[i] - prev[i] - shift) - t; m[i] = d > 0 ? d : 0; }

    // Spots: the local peaks of movement (3 × 3), each weighed over a 7 × 7
    // window; peaks closer than SPOT_APART are one moving thing, merged into
    // one weighted centre (a moving hand changes the picture at its front and
    // back edges: merged, the spot sits on the hand instead of hopping
    // between them).
    const found = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = m[y * w + x];
        if (!(v > 0)) continue;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) {
            const n = m[yy * w + xx];
            if (n > v || (n === v && (dy < 0 || (dy === 0 && dx < 0)))) { peak = false; break; }
          }
        }
        if (!peak) continue;
        let mass = 0, sx = 0, sy = 0;
        for (let dy = -SPOT_REACH; dy <= SPOT_REACH; dy++) for (let dx = -SPOT_REACH; dx <= SPOT_REACH; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const n = m[yy * w + xx];
          mass += n; sx += n * xx; sy += n * yy;
        }
        if (mass < minMass) continue;
        found.push({ x: 1 - (sx / mass + 0.5) / w, y: (sy / mass + 0.5) / h, mass, sx, sy });
      }
    }
    found.sort((a, b) => b.mass - a.mass);
    const groups = [];
    for (const f of found) {
      const g = groups.find((s) => Math.hypot(s.x - f.x, s.y - f.y) < SPOT_APART);
      if (g) { g.mass += f.mass; g.sx += f.sx; g.sy += f.sy; }
      else groups.push({ x: f.x, y: f.y, mass: f.mass, sx: f.sx, sy: f.sy });
    }
    const spots = [];
    for (const g of groups) spots.push({ x: 1 - (g.sx / g.mass + 0.5) / w, y: (g.sy / g.mass + 0.5) / h, mass: g.mass, cx: g.sx / g.mass, cy: g.sy / g.mass });
    // Against the frame before last: something there for one frame only
    // appears and vanishes in the same place — two frames of change — but
    // leaves little change across both, so it rarely drops (a blip close to
    // another can still take over its track).
    const before = this.before && this.before.length === n && this.beforeW === w ? this.before : null;
    if (before) {
      hist.fill(0);
      for (let i = 0; i < n; i++) hist[cur[i] - before[i] + 255]++;
      this.beforeShift = this.median(n);
    }
    const lasting = (sp) => {
      if (!before) return true;
      const x0 = Math.round(sp.cx), y0 = Math.round(sp.cy);
      let mass = 0;
      for (let y = Math.max(0, y0 - SPOT_REACH); y <= Math.min(h - 1, y0 + SPOT_REACH); y++) {
        for (let x = Math.max(0, x0 - SPOT_REACH); x <= Math.min(w - 1, x0 + SPOT_REACH); x++) {
          const d = Math.abs(cur[y * w + x] - before[y * w + x] - this.beforeShift) - t;
          if (d > 0) mass += d;
        }
      }
      return mass >= minMass;
    };
    spots.sort((a, b) => b.mass - a.mass);
    spots.length = Math.min(spots.length, MAX_SPOTS);

    // Follow: each spot takes the nearest spot from before (a drag from
    // there to here); a spot with none may be something starting to move —
    // it drops a ripple only if it's still moving the next frame (one odd
    // frame — a flicker, a compression blip — is never a touch).
    const taken = new Set(), fresh = [];
    for (const s of spots) {
      let best = -1, bestD = MATCH;
      for (let k = 0; k < this.spots.length; k++) {
        if (taken.has(k)) continue;
        const o = this.spots[k], d = Math.hypot(o.x - s.x, o.y - s.y);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best >= 0) {
        taken.add(best);
        const o = this.spots[best];
        if (!o.sure) { // seen twice, and changed across both frames: it really is moving — now it drops
          if (!lasting(s)) { o.seen = this.time; continue; } // a blip: keep watching, no drop
          o.sure = true;
          if (this.dropTokens >= 1) {
            this.dropTokens -= 1;
            const strength = Math.min(MAX_STRENGTH, Math.max(MIN_STRENGTH, Math.max(o.mass, s.mass) / MASS_PER_STRENGTH));
            out.push({ type: 'drop', x: s.x, y: s.y, strength });
          }
          o.x = s.x; o.y = s.y; o.seen = this.time; o.moved = this.time;
          continue;
        }
        const x = o.x + (s.x - o.x) * FOLLOW, y = o.y + (s.y - o.y) * FOLLOW, d = Math.hypot(x - o.x, y - o.y);
        if (d >= MIN_DRAG) {
          // The pace, steadied over a few frames (a 32-cell picture moves in
          // whole-cell steps; trail strength grows with speed, so a jerky
          // pace would come out as uneven slaps).
          const raw = d / Math.max(dt, this.time - o.moved);
          o.speed = o.speed > 0 ? o.speed + (raw - o.speed) * 0.4 : raw;
          out.push({ type: 'drag', x0: o.x, y0: o.y, x1: x, y1: y, speed: o.speed });
          o.x = x; o.y = y; o.moved = this.time;
        }
        o.seen = this.time;
      } else {
        fresh.push({ x: s.x, y: s.y, seen: this.time, moved: this.time, speed: 0, sure: false, mass: s.mass });
      }
    }
    this.spots.push(...fresh);
    this.spots = this.spots.filter((o) => this.time - o.seen <= LOST_SECONDS);
    if (!this.before || this.before.length !== n) this.before = new Uint8Array(n);
    this.before.set(prev); // next time, `prev` is the frame before last
    this.beforeW = w;
    return out;
  }

  reset() { this.spots = []; this.time = 0; this.dropTokens = MAX_DROPS_PER_SECOND; this.before = null; }
}
