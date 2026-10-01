// check-voices-cpu.mjs — the voice engine's CPU budget, measured in its own
// process. Run by check-voices.mjs (and by `npm run check` through it):
//   node check-voices-cpu.mjs
//
// Why its own process: this workload costs ~40% more per block when the same
// process has already rendered the suite's earlier sections (508 µs at the
// start of a run against 730–830 µs after them), and the engine's code and
// state are identical either way. Buffers built once at start-up and then a
// steady stream of blocks is how the plugin actually runs, so the budget is
// taken here.

import { Bells } from './bells.js';
import { MAX_STONES } from './stones.js';
import { performance } from 'node:perf_hooks';

let failures = 0;
function report(ok, name, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const FS = 48000, BLOCK = 128, BUDGET = 2667; // µs per 128-sample block at 48 kHz
const blockUs = (run, blocks) => {
  const t = performance.now();
  for (let i = 0; i < blocks; i++) run(i);
  return ((performance.now() - t) * 1000) / blocks;
};

console.log('CPU per 128-sample block at 48 kHz (budget 2667 µs)');
{
  // A busy instrument: a drop every ~150 blocks, the synth layer under the
  // bell, water-held sustain following the water.
  const voice = { synthLevel: 1, hold: 1, synthDecay: 6, resonance: 0.4 };
  const { Instrument } = await import('./instrument.js');
  const { buildPitches, SCALES } = await import('./tuning.js');
  const { stonePositions } = await import('./layout.js');
  const pitches = buildPitches({ scale: SCALES.pentatonicMajor, root: 60, low: 48, high: 84 });
  const inst = new Instrument({ sampleRate: FS, seed: 2 });
  inst.setParam('waveSpeed', 64); inst.setParam('decay', 8); inst.setParam('splash', 0);
  inst.setParam('threshold', 0.005);
  for (const [k, v] of Object.entries(voice)) inst.setParam(k, v);
  const { xs, ys } = stonePositions(pitches.length);
  inst.setStones(xs, ys, pitches.map((p) => p.hz), pitches.length);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  let k = 0;
  const drive = () => { if (k++ % 150 === 0) inst.engine.drop((k * 0.37) % 1, (k * 0.59) % 1, 1.5); };
  for (let i = 0; i < 300; i++) { drive(); inst.process(L, R, BLOCK); } // warm up
  let ringing = 0;
  const blocks = 3000, t0 = performance.now();
  for (let i = 0; i < blocks; i++) { drive(); inst.process(L, R, BLOCK); ringing += inst.bells.activeVoices(); }
  const us = ((performance.now() - t0) * 1000) / blocks;
  report(us / BUDGET < 0.3,
    `busy playing, synth layer + hold (avg ${(ringing / blocks).toFixed(1)} stones ringing): ${us.toFixed(0)} µs/block, ${((us / BUDGET) * 100).toFixed(1)}%`, 'limit 30%');
}
{
  // Every stone ringing, each with its synth layer, in water that keeps moving
  // (so water-held sustain is recomputed as it changes). The best of three
  // fresh engines: one run can be inflated by a JIT or scheduling hiccup, and
  // a real regression raises all three. `faded` is the same load with a bell
  // that has already fallen below hearing — it must be clearly cheaper, which
  // is the CPU half of "a layer that has gone quiet stops being computed".
  const voice = { synthLevel: 1, hold: 1, synthDecay: 6, resonance: 0.4 };
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  const timeStones = (bellDecay, warm) => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const b = new Bells({ sampleRate: FS });
      for (const [kk, v] of Object.entries({ ...voice, synthDecay: 12, bellDecay })) b.setParam(kk, v);
      for (let s = 0; s < MAX_STONES; s++) b.strike(s, 60 + s * 15, 1, (s % 10) / 9, 0);
      let wetAt = 0;
      const wet = { wet: () => 0.75 + 0.25 * Math.sin(wetAt * 0.11) };
      const run = () => {
        L.fill(0); R.fill(0);
        b.render(L, R, BLOCK);
        if (wetAt % 2 === 0) b.updateHold(wet);
        wetAt++;
      };
      for (let i = 0; i < warm; i++) run();
      const us = blockUs(run, 800);
      if (us < best) best = us;
      if (b.activeVoices() !== MAX_STONES) return { us: best, alive: false };
    }
    return { us: best, alive: true };
  };
  const alive = timeStones(8, 700);
  const faded = timeStones(0.2, 1200); // the bell has faded below hearing by now
  report(alive.alive && alive.us / BUDGET < 0.3,
    `all ${MAX_STONES} stones ringing with the synth layer, the water moving: ${alive.us.toFixed(0)} µs/block, ${((alive.us / BUDGET) * 100).toFixed(1)}%`, 'limit 30%');
  report(faded.alive && faded.us < alive.us * 0.9,
    'the same load with the bells already faded is clearly cheaper',
    `${faded.us.toFixed(0)} vs ${alive.us.toFixed(0)} µs/block (${(((alive.us - faded.us) / alive.us) * 100).toFixed(0)}% less)`);
}

console.log(failures ? `\n${failures} CPU check(s) FAILED` : '\nCPU section passed.');
process.exit(failures ? 1 : 0);
