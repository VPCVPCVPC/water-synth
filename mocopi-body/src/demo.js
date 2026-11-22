// demo.js — a made-up dancer, sent as real mocopi packets: for building and
// testing without the sensors (or the dancer) in the room. Y is up, metres.
//
// She cycles through a short "piece" so every feature moves:
//   still → swaying → big arm sweeps → low, wide and crouched → travelling
// A truly still stretch comes first in each cycle.

import { encodeSkeleton, encodeFrame } from './smf.js';
import { DEFAULT_PARENTS } from './skeleton.js';

// Rest offsets from each bone's parent (a T-pose, about 1.75 m tall).
const REST = [
  [0, 0.95, 0], // root (from the floor)
  [0, 0.08, 0], [0, 0.08, 0], [0, 0.08, 0], [0, 0.08, 0], [0, 0.08, 0], [0, 0.08, 0], [0, 0.08, 0],
  [0, 0.05, 0], [0, 0.05, 0], [0, 0.1, 0], // neck_1, neck_2, head
  [0.05, 0, 0], [0.12, 0, 0], [0.28, 0, 0], [0.26, 0, 0], // left arm (+x)
  [-0.05, 0, 0], [-0.12, 0, 0], [-0.28, 0, 0], [-0.26, 0, 0], // right arm
  [0.1, -0.05, 0], [0, -0.42, 0], [0, -0.42, 0], [0, -0.05, 0.12], // left leg
  [-0.1, -0.05, 0], [0, -0.42, 0], [0, -0.42, 0], [0, -0.05, 0.12], // right leg
];

const axisAngle = (x, y, z, a) => { const s = Math.sin(a / 2); return [x * s, y * s, z * s, Math.cos(a / 2)]; };
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const ID = [0, 0, 0, 1];

export function demoSkeleton() {
  return REST.map((p, id) => ({ id, parent: DEFAULT_PARENTS[id], tran: [0, 0, 0, 1, ...p] }));
}

// The piece's sections, in seconds; each blends into the next.
export const SECTIONS = [
  { name: 'still', seconds: 6, sway: 0, arms: 0, swing: 0, crouch: 0, wide: 0, travel: 0 },
  { name: 'sway', seconds: 10, sway: 1, arms: 0.1, swing: 0.2, crouch: 0, wide: 0.1, travel: 0 },
  { name: 'sweep', seconds: 10, sway: 0.5, arms: 1, swing: 1, crouch: 0, wide: 0.4, travel: 0 },
  { name: 'low', seconds: 8, sway: 0.3, arms: 0.4, swing: 0.3, crouch: 1, wide: 1, travel: 0 },
  { name: 'travel', seconds: 10, sway: 0.4, arms: 0.4, swing: 0.6, crouch: 0.2, wide: 0.3, travel: 1 },
];
const CYCLE = SECTIONS.reduce((s, x) => s + x.seconds, 0);

// Which section the demo is in at time t, and the blended settings.
export function demoSection(t) {
  let u = ((t % CYCLE) + CYCLE) % CYCLE;
  for (let i = 0; i < SECTIONS.length; i++) {
    const s = SECTIONS[i], next = SECTIONS[(i + 1) % SECTIONS.length];
    if (u < s.seconds) {
      const blend = Math.max(0, (u - (s.seconds - 1.5)) / 1.5); // last 1.5 s blends into the next
      const mix = {};
      for (const k of ['sway', 'arms', 'swing', 'crouch', 'wide', 'travel']) mix[k] = s[k] + (next[k] - s[k]) * blend;
      return { name: s.name, mix };
    }
    u -= s.seconds;
  }
  return { name: SECTIONS[0].name, mix: SECTIONS[0] };
}

// Every bone's local transform at time t → [{ id, tran }].
export function demoPose(t) {
  const { mix: m } = demoSection(t);
  const r = REST.map((p) => ({ q: ID, p: p.slice() }));
  // Travel: a slow circle round the floor, facing along it.
  const ang = t * 0.35 * m.travel;
  r[0].p = [1.2 * Math.sin(ang) * m.travel, REST[0][1], 1.2 * (Math.cos(ang) - 1) * m.travel];
  r[0].q = axisAngle(0, 1, 0, ang);
  // Crouch: knees bend, the hips drop to keep the feet on the floor.
  const knee = 1.1 * m.crouch;
  r[0].p[1] = REST[0][1] - 0.84 * (1 - Math.cos(knee / 2)) - 0.15 * m.crouch;
  // Wide stance.
  const stance = 0.35 * m.wide;
  r[19].q = mul(axisAngle(0, 0, 1, stance), axisAngle(1, 0, 0, -knee / 2));
  r[23].q = mul(axisAngle(0, 0, 1, -stance), axisAngle(1, 0, 0, -knee / 2));
  r[20].q = axisAngle(1, 0, 0, knee); r[24].q = axisAngle(1, 0, 0, knee);
  // Real sensors never hold perfectly still: a millimetre's tremble and
  // breath, always.
  r[0].p[0] += 0.0008 * Math.sin(t * 7.3); r[0].p[1] += 0.0012 * Math.sin(t * 1.9);
  // Sway through the spine.
  const sway = 0.12 * m.sway * Math.sin(t * 1.3);
  for (const i of [2, 4, 6]) r[i].q = axisAngle(0, 0, 1, sway);
  // Arms: their height (down −80°, overhead +60°), swinging.
  const lift = -1.4 + 1.5 * (m.arms + 0.3) + 0.9 * m.swing * Math.sin(t * 2.2);
  const lift2 = -1.4 + 1.5 * (m.arms + 0.3) + 0.9 * m.swing * Math.sin(t * 2.2 + 1.7);
  r[12].q = axisAngle(0, 0, 1, lift);
  r[16].q = axisAngle(0, 0, 1, -lift2);
  r[13].q = axisAngle(0, 1, 0, 0.4 * m.swing * Math.sin(t * 3.1));
  r[17].q = axisAngle(0, 1, 0, -0.4 * m.swing * Math.sin(t * 3.1 + 0.6));
  return r.map((b, id) => ({ id, tran: [...b.q, ...b.p] }));
}

// Packets, as the app would send them.
export const demoSkeletonPacket = () => encodeSkeleton(demoSkeleton());
export const demoFramePacket = (t, fnum = 0) => encodeFrame({ fnum, time: Math.round(t * 1000), bones: demoPose(t) });
