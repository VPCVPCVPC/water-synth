// skeleton.js — mocopi's 27 bones, and their places in the room.
//
// Bone names are Sony's (mocopi TechSpec). Parents come from the skeleton
// packets the app sends; the table below is only a fallback until one
// arrives (it follows the names — Sony doesn't publish it).
//
// Each bone's transform is local to its parent: world = parent ∘ local.

export const BONE_NAMES = [
  'root', 'torso_1', 'torso_2', 'torso_3', 'torso_4', 'torso_5', 'torso_6', 'torso_7',
  'neck_1', 'neck_2', 'head',
  'l_shoulder', 'l_up_arm', 'l_low_arm', 'l_hand',
  'r_shoulder', 'r_up_arm', 'r_low_arm', 'r_hand',
  'l_up_leg', 'l_low_leg', 'l_foot', 'l_toes',
  'r_up_leg', 'r_low_leg', 'r_foot', 'r_toes',
];
export const BONE = Object.freeze(Object.fromEntries(BONE_NAMES.map((n, i) => [n, i])));

export const DEFAULT_PARENTS = Object.freeze([
  -1, 0, 1, 2, 3, 4, 5, 6, // root, torso_1…7
  7, 8, 9, // neck_1, neck_2, head
  7, 11, 12, 13, // left arm
  7, 15, 16, 17, // right arm
  0, 19, 20, 21, // left leg
  0, 23, 24, 25, // right leg
]);

// ---- quaternions (x, y, z, w) ----

export function qmul(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}
// v rotated by unit quaternion q (into out).
export function qrot(q, v, out) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  out[0] = v[0] + w * tx + (y * tz - z * ty);
  out[1] = v[1] + w * ty + (z * tx - x * tz);
  out[2] = v[2] + w * tz + (x * ty - y * tx);
  return out;
}
export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0)) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; return q; }
  q[0] /= n; q[1] /= n; q[2] /= n; q[3] /= n;
  return q;
}

// A body: the latest local transforms, and their world positions.
export class Skeleton {
  constructor() {
    this.parents = DEFAULT_PARENTS.slice();
    this.rest = Array.from({ length: 27 }, () => Float64Array.of(0, 0, 0, 1, 0, 0, 0));
    this.local = Array.from({ length: 27 }, () => Float64Array.of(0, 0, 0, 1, 0, 0, 0));
    this.worldRot = Array.from({ length: 27 }, () => new Float64Array(4));
    this.world = Array.from({ length: 27 }, () => new Float64Array(3)); // each bone's position in the room
    this.hasSkeleton = false;
    this.order = this.solveOrder();
  }

  // A skeleton packet: parents and rest pose.
  setSkeleton(bones) {
    for (const b of bones) {
      if (!(b.id >= 0 && b.id < 27)) continue;
      const p = b.parent;
      this.parents[b.id] = p >= 0 && p < 27 && p !== b.id ? p : -1;
      this.rest[b.id].set(b.tran);
      this.local[b.id].set(b.tran);
    }
    this.order = this.solveOrder();
    this.hasSkeleton = true;
    this.solve();
  }

  // A frame packet: bones' current local transforms (bones not in it keep theirs).
  setFrame(bones) {
    for (const b of bones) if (b.id >= 0 && b.id < 27) this.local[b.id].set(b.tran);
    this.solve();
  }

  // Parents before children (a bad table can't loop: anything left over is
  // treated as hanging from the root).
  solveOrder() {
    const order = [], done = new Uint8Array(27);
    for (let pass = 0; pass < 27 && order.length < 27; pass++) {
      for (let i = 0; i < 27; i++) {
        if (done[i]) continue;
        const p = this.parents[i];
        if (p < 0 || done[p]) { order.push(i); done[i] = 1; }
      }
    }
    for (let i = 0; i < 27; i++) if (!done[i]) { this.parents[i] = -1; order.push(i); }
    return order;
  }

  solve() {
    const v = new Float64Array(3), q = new Float64Array(4);
    for (const i of this.order) {
      const l = this.local[i], p = this.parents[i];
      q[0] = l[0]; q[1] = l[1]; q[2] = l[2]; q[3] = l[3];
      qnorm(q);
      if (p < 0) {
        this.worldRot[i].set(q);
        this.world[i][0] = l[4]; this.world[i][1] = l[5]; this.world[i][2] = l[6];
      } else {
        v[0] = l[4]; v[1] = l[5]; v[2] = l[6];
        qrot(this.worldRot[p], v, v);
        this.world[i][0] = this.world[p][0] + v[0];
        this.world[i][1] = this.world[p][1] + v[1];
        this.world[i][2] = this.world[p][2] + v[2];
        qmul(this.worldRot[p], q, this.worldRot[i]);
      }
    }
  }
}
