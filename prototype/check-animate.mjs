// check-animate.mjs — stones that move on their own (animate.js).
//   node check-animate.mjs

import { Animator, motionFrom } from './animate.js';
import { stonePositions } from './layout.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const pond = () => { const { xs, ys } = stonePositions(16); return { xs: Float64Array.from(xs), ys: Float64Array.from(ys) }; };
const run = (a, p, seconds, opts = {}) => { for (let t = 0; t < seconds; t += 1 / 60) a.step(1 / 60, p.xs, p.ys, opts); };
const inside = (p) => [...p.xs, ...p.ys].every((v) => v >= 0.03 - 1e-9 && v <= 0.97 + 1e-9);

console.log('\n1. Off, and held stones');
{
  const a = new Animator(3), p = pond(), before = [...p.xs];
  run(a, p, 2);
  report(p.xs.every((v, i) => v === before[i]), 'off: nothing moves');
  a.mode = 'drift';
  const x0 = p.xs[4], y0 = p.ys[4];
  run(a, p, 5, { still: (i) => i === 4 });
  report(p.xs[4] === x0 && p.ys[4] === y0, 'a held (or dragged) stone stays where the hand has it');
}

console.log('\n2. Random drift');
{
  const a = new Animator(7), p = pond(), start = { xs: [...p.xs], ys: [...p.ys] };
  a.mode = 'drift';
  let fastest = 0;
  for (let t = 0; t < 60; t += 1 / 60) {
    const bx = [...p.xs], by = [...p.ys];
    a.step(1 / 60, p.xs, p.ys);
    for (let i = 0; i < 16; i++) fastest = Math.max(fastest, Math.hypot(p.xs[i] - bx[i], p.ys[i] - by[i]) * 60);
  }
  const travelled = Math.max(...p.xs.map((x, i) => Math.hypot(x - start.xs[i], p.ys[i] - start.ys[i])));
  report(inside(p) && travelled > 0.1 && fastest <= 0.35 + 1e-9, 'stones wander, stay inside the pond, and never outrun the speed limit',
    `furthest ${travelled.toFixed(2)} pond widths from start; fastest ${fastest.toFixed(2)}/s`);
  const b = new Animator(7), q = pond(); b.mode = 'drift'; run(b, q, 60);
  report(q.xs.every((v, i) => v === p.xs[i]), 'the same seed drifts the same way (repeatable)');
  const slow = new Animator(7), s = pond(); slow.mode = 'drift'; slow.speed = 0.05; run(slow, s, 10);
  const fast = new Animator(7), f = pond(); fast.mode = 'drift'; fast.speed = 1; run(fast, f, 10);
  const dist = (r) => r.xs.reduce((m, x, i) => m + Math.hypot(x - pond().xs[i], r.ys[i] - pond().ys[i]), 0);
  report(dist(f) > dist(s) * 3, 'the speed knob sets how far they go', `${dist(s).toFixed(2)} slow vs ${dist(f).toFixed(2)} fast (summed)`);
}

console.log('\n3. Trace a path');
{
  const a = new Animator(1), p = pond();
  a.mode = 'path';
  a.setPath([{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, { x: 0.9, y: 0.2 }]);
  run(a, p, 4);
  // Every stone should now be on (close to) the drawn line.
  const off = (x, y) => Math.min(Math.abs(y - 0.5) + Math.max(0, 0.1 - x) + Math.max(0, x - 0.9), Math.abs(x - 0.9) + Math.max(0, y - 0.5) + Math.max(0, 0.2 - y));
  const worst = Math.max(...p.xs.map((x, i) => off(x, p.ys[i])));
  report(worst < 0.02, 'stones gather onto the drawn line', `furthest ${worst.toFixed(3)} from it`);
  const before = [...p.xs];
  run(a, p, 1);
  report(p.xs.some((x, i) => Math.abs(x - before[i]) > 0.01), 'and keep travelling along it');
  const b = new Animator(1), q = pond(); b.mode = 'path'; b.setPath([{ x: 0.5, y: 0.5 }]);
  const qb = [...q.xs]; run(b, q, 1);
  report(q.xs.every((v, i) => v === qb[i]), 'a path too short to follow: nothing moves');
}

console.log('\n4. Carried by the water');
{
  // A crest in the middle: stones near it are pushed outward, down its slope.
  const a = new Animator(1); a.mode = 'water'; a.speed = 1;
  const p = { xs: Float64Array.from([0.45, 0.55, 0.5, 0.5]), ys: Float64Array.from([0.5, 0.5, 0.45, 0.55]) };
  const crest = (x, y) => 0.3 * Math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) / 0.01);
  const d0 = p.xs.map((x, i) => Math.hypot(x - 0.5, p.ys[i] - 0.5));
  run(a, p, 1, { heights: crest });
  const d1 = p.xs.map((x, i) => Math.hypot(x - 0.5, p.ys[i] - 0.5));
  report(d1.every((d, i) => d > d0[i] + 0.01), 'stones near a crest are pushed away from it', d1.map((d) => d.toFixed(3)).join(', '));
  const still = new Animator(1), q = pond(); still.mode = 'water'; const qb = [...q.xs];
  run(still, q, 2, { heights: () => 0 });
  report(q.xs.every((v, i) => v === qb[i]), 'still water leaves the stones be');
  // A crest that fades: the stones come to a stop soon after (no endless creep).
  const f = new Animator(1), r = pond(); f.mode = 'water'; f.speed = 0.2;
  let t = 0, top = 0, lastMove = -1;
  const fading = (x, y) => 0.3 * Math.exp(-t / 1.5) * Math.exp(-((x - 0.5) ** 2 + (y - 0.5) ** 2) / 0.02);
  for (; t < 30; t += 1 / 60) {
    const bx = [...r.xs], by = [...r.ys];
    if (f.step(1 / 60, r.xs, r.ys, { heights: fading })) lastMove = t;
    for (let i = 0; i < r.xs.length; i++) top = Math.max(top, Math.hypot(r.xs[i] - bx[i], r.ys[i] - by[i]) * 60);
  }
  report(lastMove >= 0 && lastMove < 15, 'as the water settles, the stones come to rest', `last move at ${lastMove.toFixed(1)} s`);
  report(top <= 0.2 * 0.35 + 1e-9, 'the motion knob caps how fast the water carries them', `top ${top.toFixed(3)} widths/s`);
}

console.log('\n5. Steered by the camera');
{
  const a = new Animator(1), p = pond(); a.mode = 'camera';
  const mean = (r) => [r.xs.reduce((s, v) => s + v, 0) / r.xs.length, r.ys.reduce((s, v) => s + v, 0) / r.ys.length];
  const [mx0, my0] = mean(p);
  run(a, p, 2, { motion: { x: 0.85, y: 0.2, amount: 1 } });
  const [mx1, my1] = mean(p);
  report(mx1 > mx0 + 0.05 && my1 < my0 - 0.05 && inside(p), 'stones are drawn toward where the movement is', `centre (${mx0.toFixed(2)}, ${my0.toFixed(2)}) → (${mx1.toFixed(2)}, ${my1.toFixed(2)})`);
  const b = new Animator(1), q = pond(); b.mode = 'camera'; const qb = [...q.xs];
  run(b, q, 1, { motion: { x: 0.5, y: 0.5, amount: 0 } });
  report(q.xs.every((v, i) => v === qb[i]), 'no movement in front of the camera: no pull');
  // Movement on the camera's left half of the picture is the performer's right: mirrored.
  const w = 32, h = 24, prev = new Uint8Array(w * h), cur = new Uint8Array(w * h);
  for (let y = 8; y < 16; y++) for (let x = 2; x < 8; x++) cur[y * w + x] = 200;
  const m = motionFrom(prev, cur, w, h);
  const none = motionFrom(cur, cur, w, h);
  report(m.amount > 0 && m.x > 0.7 && Math.abs(m.y - 0.5) < 0.1 && none.amount === 0,
    'camera frames → where movement is (mirrored) and how much; no change, no movement', `x ${m.x.toFixed(2)}, y ${m.y.toFixed(2)}, amount ${m.amount.toFixed(2)}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll animate checks passed.');
process.exit(failures ? 1 : 0);
