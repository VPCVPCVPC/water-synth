// check.mjs — the package's checks, no sensors needed.
//   node check/check.mjs

import { parse, encodeSkeleton, encodeFrame } from '../src/smf.js';
import { Skeleton, BONE, qmul, qrot } from '../src/skeleton.js';
import { BodyFeatures } from '../src/features.js';
import { demoSkeleton, demoPose, demoSkeletonPacket, demoFramePacket, demoSection } from '../src/demo.js';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

console.log('1. Packets');
{
  const sk = demoSkeleton();
  const p = parse(encodeSkeleton(sk));
  report(p && p.kind === 'skeleton' && p.bones.length === 27 && p.bones.every((b, i) => b.id === i && b.parent === (sk[i].parent < 0 ? 0xffff : sk[i].parent) && b.tran.every((v, k) => near(v, sk[i].tran[k]))),
    'a skeleton packet round-trips: 27 bones, ids, parents, transforms');
  const pose = demoPose(3.7);
  const f = parse(encodeFrame({ fnum: 1234, time: 98765, bones: pose }));
  report(f && f.kind === 'frame' && f.fnum === 1234 && f.time === 98765 && f.bones.length === 27 && f.bones.every((b, i) => b.tran.every((v, k) => near(v, pose[i].tran[k]))),
    'a frame packet round-trips: number, time, 27 transforms (quaternion then position)');
  // The layout itself, byte by byte, for one field: length (LE u32, value only), name, value.
  const bytes = encodeFrame({ fnum: 7, time: 0, bones: [{ id: 3, tran: [0, 0, 0, 1, 0.5, 0, 0] }] });
  const v = new DataView(bytes.buffer);
  const name = (o) => String.fromCharCode(...bytes.subarray(o + 4, o + 8));
  const headLen = v.getUint32(0, true); // head's value: its ftyp and vrsn chunks
  report(name(0) === 'head' && name(8) === 'ftyp' && headLen === (8 + 18) + (8 + 1) && name(8 + headLen) === 'sndf',
    'chunks are a little-endian length of the value only, then a 4-letter name', `head holds ${headLen} bytes`);
  report(parse(new Uint8Array(0)) === null && parse(Uint8Array.of(1, 2, 3)) === null && parse(bytes.subarray(0, bytes.length - 5)) === null && parse(new TextEncoder().encode('hello, not mocopi')) === null,
    'empty, short, truncated or foreign packets: null, never a throw');
  report(parse(demoFramePacket(1)).bones.length === 27, 'the demo dancer sends whole frames');
  // An unknown chunk (a newer app version, say) is skipped.
  const extra = new Uint8Array(8 + 3); new DataView(extra.buffer).setUint32(0, 3, true); extra.set([120, 120, 120, 120], 4);
  const pkt = demoFramePacket(1), withExtra = new Uint8Array(pkt.length + extra.length);
  withExtra.set(pkt); withExtra.set(extra, pkt.length);
  report(parse(withExtra) && parse(withExtra).bones.length === 27, 'an unknown chunk is skipped');
  // Mangled packets: thousands of random byte changes and cuts, never a throw.
  let threw = 0, seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  for (let k = 0; k < 5000; k++) {
    const b = Uint8Array.from(k % 2 ? demoFramePacket(k / 50, k) : demoSkeletonPacket());
    for (let j = 0; j < 4; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    try { parse(b.subarray(0, Math.floor(rnd() * b.length) + (k % 3 ? b.length : 0))); } catch { threw++; }
  }
  try { parse(null); parse(undefined); parse('x'); parse({}); parse(5); } catch { threw++; }
  report(threw === 0, '5000 mangled packets and odd inputs: never a throw', `${threw} threw`);
  // A value that isn't a number skips the bone, never reaching the body.
  const bad = demoPose(2); bad[14].tran[4] = NaN; bad[18].tran[0] = Infinity;
  const pb = parse(encodeFrame({ bones: bad }));
  report(pb && pb.bones.length === 25 && pb.bones.every((b) => b.tran.every(Number.isFinite)), 'a NaN or infinite value: that bone is skipped');
}

console.log('\n2. Skeleton');
{
  const q = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)]; // 90° about z
  const v = qrot(q, [1, 0, 0], [0, 0, 0]);
  report(near(v[0], 0) && near(v[1], 1) && near(v[2], 0), 'a quarter turn about z takes x to y');
  const qq = qmul(q, q, [0, 0, 0, 0]);
  const v2 = qrot(qq, [1, 0, 0], [0, 0, 0]);
  report(near(v2[0], -1) && near(v2[1], 0), 'two quarter turns make a half turn');
  const s = new Skeleton();
  s.setSkeleton(demoSkeleton().map((b) => ({ ...b, parent: b.parent < 0 ? 0xffff : b.parent })));
  const head = s.world[BONE.head], lh = s.world[BONE.l_hand], rh = s.world[BONE.r_hand], lf = s.world[BONE.l_foot];
  report(head[1] > 1.6 && head[1] < 1.85 && lf[1] < 0.15 && lh[0] > 0.6 && rh[0] < -0.6,
    'the rest pose stands up: head ~1.7 m, feet on the floor, arms out to each side', `head ${head[1].toFixed(2)}, hands ${lh[0].toFixed(2)} / ${rh[0].toFixed(2)}`);
  const loop = new Skeleton();
  loop.setSkeleton([{ id: 1, parent: 2, tran: [0, 0, 0, 1, 0, 1, 0] }, { id: 2, parent: 1, tran: [0, 0, 0, 1, 0, 1, 0] }]);
  report(loop.world.every((p) => p.every(Number.isFinite)), 'a parent table that loops can\'t hang it or make NaNs');
}

// Run the demo dancer through the whole path (packets → skeleton → features).
function dance(seconds, { from = 0, fps = 50, gapAt = -1, gapFor = 0, features = {} } = {}) {
  const s = new Skeleton(), f = new BodyFeatures(features), log = [];
  s.setSkeleton(parse(demoSkeletonPacket()).bones);
  for (let k = 0; k < seconds * fps; k++) {
    const t = from + k / fps;
    if (gapAt >= 0 && t >= gapAt && t < gapAt + gapFor) { f.tick(t); log.push({ t, lost: f.lost, still: f.still, stillness: f.stillness }); continue; }
    const p = parse(demoFramePacket(t, k));
    s.setFrame(p.bones);
    f.update(s.world, t);
    log.push({ t, section: demoSection(t).name, energy: f.energy, energyLong: f.energyLong, height: f.height, level: f.level, spread: f.spread, still: f.still, stillness: f.stillness, lost: f.lost });
  }
  return { f, log };
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const during = (log, name, key) => mean(log.filter((e) => e.section === name && !e.lost).slice(25).map((e) => e[key]));

console.log('\n3. Features from the demo dancer');
{
  const { f, log } = dance(44);
  report(f.ready && f.upAxis[0] === 1 && f.upAxis[1] === 1 && f.bodyHeight > 1.6 && f.bodyHeight < 2.0,
    'it learns that y is up and how tall she is', `up axis ${f.upAxis}, height ${f.bodyHeight.toFixed(2)} m`);
  const still = during(log, 'still', 'energy'), sweep = during(log, 'sweep', 'energy');
  report(still < 0.05 && sweep > 0.25, 'energy: near 0 standing still, well up in big arm sweeps', `still ${still.toFixed(3)}, sweeps ${sweep.toFixed(2)}`);
  const stillFlag = log.filter((e) => e.t > 3.2 && e.t < 4.5).every((e) => e.still); // (from 4.5 s she starts to move into the sway)
  report(stillFlag && !log.filter((e) => e.section === 'sweep').some((e) => e.still), 'still: after 3 s of stillness, and never while sweeping');
  const hSweep = during(log, 'sweep', 'height'), hLow = during(log, 'low', 'height');
  report(hSweep > hLow + 0.3, 'height: arms raised read higher than arms low', `sweeps ${hSweep.toFixed(2)}, low ${hLow.toFixed(2)}`);
  const lvl = during(log, 'low', 'level'), lvlStand = during(log, 'sway', 'level');
  report(lvl < lvlStand - 0.1, 'level: crouched reads lower than standing', `low ${lvl.toFixed(2)}, standing ${lvlStand.toFixed(2)}`);
  const wide = during(log, 'low', 'spread'), held = during(log, 'sway', 'spread');
  report(wide > held + 0.05, 'spread: wide stance reads wider than swaying', `wide ${wide.toFixed(2)}, swaying ${held.toFixed(2)}`);
  const long = log.at(-1).energyLong, short = log.at(-1).energy;
  report(Number.isFinite(long) && long > 0 && log.every((e) => [e.energy, e.height, e.level, e.spread].every(Number.isFinite)), 'every feature stays a number', `energy ${short.toFixed(2)}, long ${long.toFixed(2)}`);
}

console.log('\n4. Lost is not stillness');
{
  const { log } = dance(20, { from: 10, gapAt: 14, gapFor: 5 }); // frames stop for 5 s mid-sway
  const gap = log.filter((e) => e.t >= 14.6 && e.t < 19);
  report(gap.length > 0 && gap.every((e) => e.lost && !e.still && e.stillness === 0), 'frames stopping: lost after 0.5 s, and never counted as still');
  const back = log.filter((e) => e.t >= 19.2);
  report(back.length > 0 && back.every((e) => !e.lost) && back.every((e) => e.energy < 1), 'frames back: found again, with no jump in energy');
}

console.log('\n4b. A stream repeating a dead pose is lost, not still');
{
  const s = new Skeleton(), f = new BodyFeatures();
  s.setSkeleton(parse(demoSkeletonPacket()).bones);
  const frozen = parse(demoFramePacket(12, 0)).bones; // mid-sway, then the same frame over and over
  let lostAt = -1, everStill = false;
  for (let k = 0; k < 50 * 8; k++) {
    const t = 10 + k / 50;
    s.setFrame(t < 12 ? parse(demoFramePacket(t, k)).bones : frozen);
    f.update(s.world, t);
    if (f.lost && lostAt < 0) lostAt = t;
    if (f.still) everStill = true;
  }
  report(lostAt > 12.9 && lostAt < 13.2 && !everStill, 'frames exactly alike for a second: lost, and never still', `lost at ${lostAt.toFixed(2)} s`);
  // NaN reaching the features directly (a bad caller) can't stick.
  const g = new BodyFeatures({ up: 'y', bodyHeight: 1.7 });
  const w = s.world.map((p) => Array.from(p));
  g.update(w, 0); w[14][0] = NaN; g.update(w, 0.02); w[14][0] = 0.5;
  for (let k = 2; k < 100; k++) { w[14][0] = 0.5 + 0.3 * Math.sin(k / 3); g.update(w, k / 50); } // then the hand moves
  report(Number.isFinite(g.limbs.leftHand) && g.energy > 0.05 && Number.isFinite(g.energyLong), 'a NaN fed in once doesn\'t poison the features for good', `energy ${g.energy.toFixed(2)}, hand ${g.limbs.leftHand.toFixed(2)} m/s`);
}

console.log('\n4c. Standing, learned over a second');
{
  const f = new BodyFeatures();
  const s = new Skeleton();
  s.setSkeleton(parse(demoSkeletonPacket()).bones);
  for (let k = 0; k < 50 * 2; k++) { s.setFrame(parse(demoFramePacket(1 + k / 50, k)).bones); f.update(s.world, 1 + k / 50); }
  const lvl = f.level;
  f.recalibrate();
  report(!f.ready && lvl > 0.95, 'standing reads as level 1; recalibrate() learns again', `level ${lvl.toFixed(2)}`);
}

console.log('\n5. Given, not learned');
{
  const f = new BodyFeatures({ up: '-z', bodyHeight: 1.5 });
  report(f.ready && f.upAxis[0] === 2 && f.upAxis[1] === -1 && f.bodyHeight === 1.5, 'up and height can be set instead of learned');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll mocopi-body checks passed.');
process.exit(failures ? 1 : 0);
