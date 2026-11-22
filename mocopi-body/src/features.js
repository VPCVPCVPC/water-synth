// features.js — what a body is doing, in a few numbers an instrument can use.
//
// Fed the skeleton's world positions each frame (Skeleton.world, metres),
// it keeps:
//   energy      0…1  how much the body is moving now (smoothed over ~0.3 s)
//   energyLong  0…1  the same over the last `longSeconds` (a phrase, not a gesture)
//   limbs       m/s  each tracked point's speed: head, hips, hands, feet
//   height     −1…1+ the hands against the body: 0 at the hips, 1 a body-half
//                    above (overhead), −1 a body-half below (to the floor)
//   level       0…1  how upright: 1 standing, lower crouching or on the floor
//   spread      0…1  how open: hands and feet far apart vs. held in
//   stillness   s    how long the body has been (nearly) still
//   still       bool stillness has lasted `stillAfter` seconds
//   centre      m    where the hips are across the floor (two horizontal axes)
//   lost        bool no frames lately (the sensors or the network dropped) —
//                    never counted as stillness
//
// Which way is up, and how tall the body is, are learned from the first
// second of frames (standing), unless given.

import { BONE } from './skeleton.js';

const POINTS = [
  ['head', BONE.head, 0.5], ['hips', BONE.root, 1],
  ['leftHand', BONE.l_hand, 1], ['rightHand', BONE.r_hand, 1],
  ['leftFoot', BONE.l_foot, 1], ['rightFoot', BONE.r_foot, 1],
];
const AXES = { x: [0, 1], '-x': [0, -1], y: [1, 1], '-y': [1, -1], z: [2, 1], '-z': [2, -1] };

export class BodyFeatures {
  constructor({
    up = null, // 'y', '-z'…; null: learn it
    bodyHeight = null, // metres; null: learn it
    energyScale = 1.2, // m/s (half the points' weighted mean speed, half the fastest one's) that counts as full energy
    longSeconds = 12,
    stillBelow = 0.06, // energy under this counts as still
    stillAfter = 3, // seconds
    lostAfter = 0.5, // seconds without a frame
    frozenAfter = 1, // seconds of frames exactly alike (a sensor gone, its last pose repeated)
  } = {}) {
    Object.assign(this, { energyScale, longSeconds, stillBelow, stillAfter, lostAfter, frozenAfter });
    this.upAxis = up && AXES[up] ? AXES[up] : null;
    this.bodyHeight = bodyHeight > 0 ? bodyHeight : null;
    this.givenUp = Boolean(this.upAxis); this.givenHeight = Boolean(this.bodyHeight);
    this.calib = []; // early frames for learning up and height
    this.standingHips = null;
    this.prev = POINTS.map(() => new Float64Array(3));
    this.havePrev = false;
    this.lastT = -1;
    this.energy = 0; this.energyLong = 0;
    this.limbs = Object.fromEntries(POINTS.map(([n]) => [n, 0]));
    this.height = 0; this.level = 1; this.spread = 0;
    this.stillness = 0; this.still = false; this.lost = true;
    this.gone = true; // no frames lately
    this.frozenFor = 0; // seconds of frames exactly alike
    this.centre = [0, 0];
  }

  get ready() { return Boolean(this.upAxis && this.bodyHeight); }

  // One frame: world positions (27 × [x, y, z]) at time t (seconds).
  update(world, t) {
    if (!this.ready || this.standingHips === null) this.learn(world);
    const dt = this.lastT < 0 ? 0 : t - this.lastT;
    this.lastT = t;
    if (this.gone) { this.gone = false; this.havePrev = false; this.frozenFor = 0; } // back: no jump from where it was
    const [ui, us] = this.upAxis || [1, 1];
    const up = (p) => p[ui] * us;
    const H = this.bodyHeight || 1.6;

    // Speeds.
    let sum = 0, weights = 0, most = 0, same = this.havePrev;
    POINTS.forEach(([name, bone, w], k) => {
      const p = world[bone], q = this.prev[k];
      if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) same = false;
      if (this.havePrev && !this.lost && dt > 0 && dt < 0.5) { // (not from a frozen pose: it may have come back far from it)
        const v = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / dt;
        if (Number.isFinite(v)) this.limbs[name] += (v - this.limbs[name]) * Math.min(1, dt / 0.15);
      }
      q[0] = p[0]; q[1] = p[1]; q[2] = p[2];
      sum += this.limbs[name] * w; weights += w;
      if (this.limbs[name] > most) most = this.limbs[name];
    });
    this.havePrev = true;
    // Real sensors always tremble a little: frames exactly alike for a
    // second mean the stream is repeating a dead pose — lost, not still.
    this.frozenFor = same && dt > 0 ? this.frozenFor + dt : 0;
    this.lost = this.frozenFor >= this.frozenAfter;
    if (this.lost) { this.stillness = 0; this.still = false; }
    else if (dt > 0 && dt < 0.5) {
      // Half the whole body, half its busiest part: arms alone, dancing
      // hard, are a lot of energy, though the rest of her is still.
      const raw = (0.5 * sum / weights + 0.5 * most) / this.energyScale;
      const now = Number.isFinite(raw) ? Math.min(1, raw) : 0;
      this.energy += (now - this.energy) * Math.min(1, dt / 0.3);
      this.energyLong += (now - this.energyLong) * Math.min(1, dt / this.longSeconds);
      this.stillness = this.energy < this.stillBelow ? this.stillness + dt : 0;
      this.still = this.stillness >= this.stillAfter;
    }

    // Shape.
    const hips = world[BONE.root], lh = world[BONE.l_hand], rh = world[BONE.r_hand];
    const lf = world[BONE.l_foot], rf = world[BONE.r_foot];
    const floor = Math.min(up(lf), up(rf));
    this.height = clamp(((up(lh) + up(rh)) / 2 - up(hips)) / (H / 2), -1, 1.5);
    const hipsUp = up(hips) - floor;
    if (this.standingHips) this.level = clamp(hipsUp / this.standingHips, 0, 1);
    const hands = dist(lh, rh), feet = dist(lf, rf);
    this.spread = clamp((hands + feet) / (1.2 * H), 0, 1);
    const [a, b] = [0, 1, 2].filter((i) => i !== ui);
    this.centre[0] = hips[a]; this.centre[1] = hips[b];
    return this;
  }

  // No frames for a while (call with the time now): lost, never still.
  tick(t) {
    if (!this.gone && this.lastT >= 0 && t - this.lastT > this.lostAfter) {
      this.gone = true; this.lost = true; this.stillness = 0; this.still = false;
    }
    return this;
  }

  // Learn up, height and the standing pose again (ask her to stand still
  // for a second); what was given in the options is kept.
  recalibrate() {
    if (!this.givenUp) this.upAxis = null;
    if (!this.givenHeight) this.bodyHeight = null;
    this.standingHips = null;
    this.calib = [];
  }

  // The first second of frames: up is the way from hips to head; the body's
  // height is from the feet to the head (plus a little for the crown); how
  // high the hips are when standing.
  learn(world) {
    const head = world[BONE.head], hips = world[BONE.root], lf = world[BONE.l_foot], rf = world[BONE.r_foot];
    this.calib.push([head[0] - hips[0], head[1] - hips[1], head[2] - hips[2], head, lf, rf, hips].map((v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : v)));
    if (this.calib.length < 30) return;
    if (!this.upAxis) {
      const m = [0, 1, 2].map((i) => this.calib.reduce((s, c) => s + c[i], 0) / this.calib.length);
      const i = [0, 1, 2].reduce((best, k) => (Math.abs(m[k]) > Math.abs(m[best]) ? k : best), 0);
      this.upAxis = [i, m[i] < 0 ? -1 : 1];
    }
    if (!this.bodyHeight) {
      const [ui, us] = this.upAxis;
      const hs = this.calib.map((c) => (c[3][ui] - Math.min(c[4][ui], c[5][ui])) * us).sort((x, y) => x - y);
      const h = hs[Math.floor(hs.length / 2)] * 1.08;
      this.bodyHeight = h > 0.8 && h < 2.6 ? h : 1.6;
    }
    // Standing hips (over the whole second, not one frame).
    const [ui, us] = this.upAxis;
    const hh = this.calib.map((c) => (c[6][ui] - Math.min(c[4][ui], c[5][ui])) * us).sort((x, y) => x - y);
    const mid = hh[Math.floor(hh.length / 2)];
    this.standingHips = mid > 0.2 ? mid : 0.9;
    this.calib = [];
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
