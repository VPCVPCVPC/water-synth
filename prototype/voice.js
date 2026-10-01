// voice.js — what a struck stone sounds like: the voice parameters, one shared
// voice for every stone plus an optional override per stone.
//
// A voice is the water-struck bell (its partials, decay, tick and brightness)
// plus an optional synth layer (two oscillators → filter → envelopes), mixed.
// The defaults are today's bell alone: the synth layer is silent until its
// level is raised. There is no note-off: every voice falls silent on its own.
// `hold` lets the water hold a note — a stone's decay slows while the water
// around it keeps moving, and resumes as it calms (the player never holds it).
//
// No presets: the shared voice is edited in place, and an override starts as
// a copy of the shared voice. Fixed memory; nothing here allocates after
// construction.

import { MAX_STONES } from './stones.js';

export const VOICE_PARAMS = {
  // The bell.
  bellLevel: { min: 0, max: 1.5, def: 1 },
  bellDecay: { min: 0.2, max: 8, def: 2.5 }, // s, T60 of the fundamental at ~220 Hz
  bellTone: { min: 0, max: 2, def: 1 }, // level of the upper partials
  bellPartials: { min: 0, max: 1, def: 0 }, // 0 bar-like and tuneful → 1 clangy (free-bar ratios)
  tick: { min: 0, max: 3, def: 1 }, // the water touching the stone
  // How the strike shapes the sound (both layers).
  dynamics: { min: 0, max: 48, def: 30 }, // dB between the softest and the hardest strike
  strikeBright: { min: 0, max: 1, def: 1 }, // how much harder strikes are brighter
  // Water-held sustain: 0 off → 1 the note barely decays while the water moves.
  hold: { min: 0, max: 1, def: 0 },
  // The synth layer.
  synthLevel: { min: 0, max: 1.5, def: 0 },
  osc1Shape: { min: 0, max: 3, def: 2 }, // 0 sine, 1 triangle, 2 saw, 3 square (morphs between)
  osc2Shape: { min: 0, max: 3, def: 2 },
  osc2Pitch: { min: -24, max: 24, def: 0 }, // semitones from the stone's pitch
  osc2Detune: { min: -50, max: 50, def: 7 }, // cents
  oscMix: { min: 0, max: 1, def: 0.5 }, // 0 osc 1 only → 1 osc 2 only
  cutoff: { min: 0, max: 7, def: 2 }, // low-pass, octaves above the stone's pitch
  resonance: { min: 0, max: 0.9, def: 0.2 },
  filterEnv: { min: 0, max: 6, def: 2.5 }, // octaves a strike opens the filter
  filterDecay: { min: 0.02, max: 4, def: 0.5 }, // s for the opening to close (T60)
  attack: { min: 0.001, max: 2, def: 0.004 }, // s
  synthDecay: { min: 0.1, max: 12, def: 2.5 }, // s, T60
};
export const VOICE_KEYS = Object.keys(VOICE_PARAMS);
export const VOICE_SIZE = VOICE_KEYS.length;
const MINS = VOICE_KEYS.map((k) => VOICE_PARAMS[k].min);
const MAXS = VOICE_KEYS.map((k) => VOICE_PARAMS[k].max);
const DEFS = VOICE_KEYS.map((k) => VOICE_PARAMS[k].def);

// Parameter indices, for the audio code.
export const V = Object.fromEntries(VOICE_KEYS.map((k, i) => [k, i]));

export const SHARED = -1; // target of an edit to the shared voice

export class VoiceBank {
  constructor() {
    // Slot 0 is the shared voice; slot 1 + i is stone i's override.
    this.p = new Float64Array((MAX_STONES + 1) * VOICE_SIZE);
    this.overridden = new Uint8Array(MAX_STONES);
    this.dirty = new Uint8Array(MAX_STONES + 1); // edited since the bells last looked
    this.anyDirty = false;
    for (let s = 0; s <= MAX_STONES; s++) this.p.set(DEFS, s * VOICE_SIZE);
  }

  // Slot in p that stone i plays: 0 the shared voice, else its own override.
  slot(stone) {
    return this.overridden[stone] ? stone + 1 : 0;
  }

  // Set parameter `index` of the shared voice (target SHARED) or of stone
  // `target`'s override. Editing a stone without an override does nothing.
  set(target, index, value) {
    if (!Number.isInteger(index) || index < 0 || index >= VOICE_SIZE || !Number.isFinite(value)) return;
    let slot;
    if (target === SHARED) slot = 0;
    else if (Number.isInteger(target) && target >= 0 && target < MAX_STONES && this.overridden[target]) slot = target + 1;
    else return;
    this.p[slot * VOICE_SIZE + index] = value < MINS[index] ? MINS[index] : value > MAXS[index] ? MAXS[index] : value;
    this.dirty[slot] = 1;
    this.anyDirty = true;
  }

  // Give stone i its own voice (a copy of the shared voice) or return it to
  // the shared voice. Only an explicit 1/true switches it on.
  override(stone, on) {
    if (!Number.isInteger(stone) || stone < 0 || stone >= MAX_STONES) return;
    const want = on === 1 || on === true ? 1 : 0;
    if (this.overridden[stone] === want) return;
    if (want) this.p.copyWithin((stone + 1) * VOICE_SIZE, 0, VOICE_SIZE);
    this.overridden[stone] = want;
    this.dirty[stone + 1] = 1;
    this.anyDirty = true;
  }

  get(target, key) {
    const i = V[key];
    const slot = target === SHARED ? 0 : target + 1;
    return this.p[slot * VOICE_SIZE + i];
  }

  clearDirty() {
    this.dirty.fill(0);
    this.anyDirty = false;
  }
}
