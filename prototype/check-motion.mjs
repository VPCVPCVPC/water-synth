// check-motion.mjs — camera movement → gestures (motion.js), without a camera.
//   node check-motion.mjs

import { MotionGestures } from './motion.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const W = 32, H = 24, DT = 1 / 30;
let seed = 7;
const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
// A grey scene with camera grain, and bright squares (hands) at given cells.
function frame(blobs = [], grain = 4, w = W, h = H) {
  const f = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = 90 + Math.round((rand() - 0.5) * 2 * grain);
  for (const b of blobs) {
    for (let y = Math.floor(b.y - b.r); y <= b.y + b.r; y++) for (let x = Math.floor(b.x - b.r); x <= b.x + b.r; x++) {
      if (x >= 0 && y >= 0 && x < w && y < h) f[y * w + x] = b.v ?? 220;
    }
  }
  return f;
}
// Feed frames; collect what came out.
function run(g, frames) {
  const out = [];
  for (let k = 1; k < frames.length; k++) out.push(...g.update(frames[k - 1], frames[k], W, H, DT));
  return out;
}
const drops = (o) => o.filter((e) => e.type === 'drop');
const drags = (o) => o.filter((e) => e.type === 'drag');

console.log('\n1. Still scene: nothing');
{
  const g = new MotionGestures();
  const fs = Array.from({ length: 90 }, () => frame([], 6)); // 3 s of grain
  const out = run(g, fs);
  report(out.length === 0, 'camera grain alone never makes a ripple', `${out.length} gestures; noise learned ${g.noise.toFixed(1)}`);
}

console.log('\n2. Something starts moving: one drop, where it is (mirrored)');
{
  const g = new MotionGestures();
  const fs = [...Array.from({ length: 20 }, () => frame()), frame([{ x: 6, y: 12, r: 2 }])];
  const out = run(g, fs);
  const d = drops(out);
  report(d.length === 1 && d[0].x > 0.7 && Math.abs(d[0].y - 0.52) < 0.1,
    'a hand appearing on the camera\'s left (your right, in a mirror) drops one ripple on the right', d.map((e) => `(${e.x.toFixed(2)}, ${e.y.toFixed(2)}) s${e.strength.toFixed(2)}`).join(' '));
}

console.log('\n3. Moving on: a steady trail that follows it, not more drops');
// A hand sweeping at a steady pace, in a landscape frame and in a portrait
// one (a phone held upright): the trail must keep going one way at about the
// hand's own speed — never hopping back and forth between the hand's front
// and back edges (each hop would be a hard slap: trail strength grows with speed).
for (const [w, h, axis] of [[32, 24, 'x'], [24, 32, 'y']]) {
  const g = new MotionGestures();
  const fs = Array.from({ length: 10 }, () => frame([], 4, w, h));
  const cells = axis === 'x' ? w : h, step = 0.6; // cells per frame
  for (let k = 0; k < 28; k++) {
    const at = 4 + k * step;
    fs.push(frame([axis === 'x' ? { x: at, y: h / 2, r: 2 } : { x: w / 2, y: at, r: 2 }], 4, w, h));
  }
  const out = [];
  for (let k = 1; k < fs.length; k++) out.push(...g.update(fs[k - 1], fs[k], w, h, DT));
  const d = drops(out), t = drags(out);
  const along = (e) => (axis === 'x' ? e.x1 - e.x0 : e.y1 - e.y0); // mirrored x: moving right in the picture is left on the pond
  const sign = axis === 'x' ? -1 : 1;
  const backwards = t.filter((e) => along(e) * sign < 0).length;
  const truth = (step / cells) / DT; // frame widths (or heights) per second
  // (The first moments catch the spot up from where it was first seen to the
  // hand's centre; after that it must keep the hand's pace.)
  const top = Math.max(...t.slice(3).map((e) => e.speed));
  report(d.length <= 1 && t.length >= 10 && backwards === 0 && top < 2 * truth,
    `${w}×${h} frame: a sweep draws a trail that keeps going one way, at about its own speed`,
    `${d.length} drop, ${t.length} drags, ${backwards} backwards; fastest after the start ${top.toFixed(2)} vs true ${truth.toFixed(2)} per s`);
}

console.log('\n3b. The same frame twice teaches nothing');
{
  const g = new MotionGestures();
  for (let k = 0; k < 30; k++) { const f = frame([], 6); g.update(f, f, W, H, DT); }
  report(g.noise > 5, 'a camera that repeats a frame doesn\'t lower the bar (so its grain never makes ripples)', `noise ${g.noise.toFixed(1)}`);
}

console.log('\n4. Stronger for more movement');
{
  const small = drops(run(new MotionGestures(), [...Array.from({ length: 10 }, () => frame()), frame([{ x: 16, y: 12, r: 1, v: 140 }])]));
  const big = drops(run(new MotionGestures(), [...Array.from({ length: 10 }, () => frame()), frame([{ x: 16, y: 12, r: 4 }])]));
  report(small.length === 1 && big.length === 1 && big[0].strength > small[0].strength && big[0].strength <= 2,
    'a bigger, sharper movement drops harder (never harder than the hardest touch)',
    `small ${small[0] ? small[0].strength.toFixed(2) : '—'}, big ${big[0] ? big[0].strength.toFixed(2) : '—'}`);
}

console.log('\n5. Two hands: two drops');
{
  const g = new MotionGestures();
  const out = run(g, [...Array.from({ length: 10 }, () => frame()), frame([{ x: 5, y: 8, r: 2 }, { x: 26, y: 16, r: 2 }])]);
  const d = drops(out);
  report(d.length === 2 && Math.abs(d[0].x - d[1].x) > 0.4, 'two hands moving at once drop two ripples, each where it is', d.map((e) => `(${e.x.toFixed(2)}, ${e.y.toFixed(2)})`).join(' '));
}

console.log('\n6. Never a flood');
{
  const g = new MotionGestures();
  const fs = [];
  for (let k = 0; k < 60; k++) { // flickering blobs everywhere for 2 s (a strobe, a busy scene)
    const blobs = [];
    for (let j = 0; j < 6; j++) blobs.push({ x: Math.floor(rand() * W), y: Math.floor(rand() * H), r: 2 });
    fs.push(frame(k % 2 ? blobs : []));
  }
  const d = drops(run(g, fs));
  report(d.length <= 10 * 2 + 10, 'at most ~10 drops a second, however busy the picture', `${d.length} drops in 2 s`);
}

console.log('\n7. Stops: nothing more once it\'s still');
{
  const g = new MotionGestures();
  const fs = Array.from({ length: 10 }, () => frame());
  for (let k = 0; k < 8; k++) fs.push(frame([{ x: 8 + k, y: 12, r: 2 }]));
  const still = frame([{ x: 15, y: 12, r: 2 }]);
  for (let k = 0; k < 30; k++) fs.push(Uint8Array.from(still));
  const out = [];
  for (let k = 1; k < fs.length; k++) { const o = g.update(fs[k - 1], fs[k], W, H, DT); if (k > 20) out.push(...o); }
  report(out.length === 0 && g.spots.length === 0, 'a hand that stops makes no more ripples, and is let go', `${out.length} gestures after it stopped`);
}

console.log('\n8. Bad input');
{
  const g = new MotionGestures();
  const a = frame(), b = frame([{ x: 10, y: 10, r: 2 }]);
  const outs = [g.update(null, b, W, H, DT), g.update(a, b, W, H, 0), g.update(a, b, W, H, NaN), g.update(a, new Uint8Array(5), W, H, DT)];
  report(outs.every((o) => o.length === 0), 'missing frames, wrong sizes, no time: nothing');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll motion checks passed.');
process.exit(failures ? 1 : 0);
