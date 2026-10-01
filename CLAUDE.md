# Water Synth — Design Doc

> Working title. This file is the source of truth for what this instrument *is*.
> Every agent and every session reads it first. When a technical choice conflicts
> with this doc, the doc wins — or the doc gets deliberately updated by Dash.

## The core idea

**You don't play notes. You disturb a medium, and the medium plays.**

The instrument is a body of water that sits at rest, with tuned points in it.
Every performer action injects energy. The medium responds on its own terms:
it ripples, carries, reflects, interferes, and slowly settles back to
stillness — and as it moves, it sounds notes in whatever scale and range is
set. It is generative: the music comes from what the water does, not from a
sequence anyone wrote.

This is a performance instrument first. It should feel alive, responsive, and a
little beyond full control — like touching water, not like pressing a key that
plays a sample. The goal is creative serendipity: phrases you wouldn't have
written, that still sit in your scale.

### What this means in practice
- The performer never picks a note directly. Input is *energy* placed somewhere
  in the medium, with some shape and intensity. Output is notes, chosen by
  where that energy travels, when it arrives, and what it meets.
- Where you disturb it matters: position sets which notes ring and when.
- Waves interact: two disturbances meeting make something neither makes alone.
- Silence is a state the medium returns to naturally.
- The same gesture should never sound exactly the same twice — mostly because
  it lands in water that is already moving.
- If a feature makes this feel like a preset synth or a step sequencer, it's
  the wrong feature.

## Structure

### Core: the medium
A simulated surface that holds energy, propagates it, reflects it off its
edges, and damps it over time. It runs at **human speed**: ripples visibly
travel across it. Wave speed is adjustable and acts as tempo, from slow drift
(seconds to cross) to busy cascades (well under a second). The surface is the
composer, not the oscillator: it decides *when*, *which*, and *how hard*.

### Tuned stones: how the medium sounds
Points on the surface — **stones** — each hold one pitch from the current
scale and range. When a ripple reaches a stone, the stone rings. How hard the
water hits sets how loud; ripples arriving together ring it brighter or set off
its neighbours. Distances between where you disturb and where the stones sit
make the rhythm; reflections make echoes that repeat but drift.

Stones ring with **water-struck bell** voices for now: clear, tuned resonant
tones with a soft bell/marimba-like decay. Voice character is expected to
evolve (and is where Phase will act).

### Prototype findings (Phase 1a, Sept 2026)
An audio-rate 2D wave grid read directly as audio sounded like a metal plate,
and sounded the same wherever you tapped: the physics is linear (ripples pass
through each other unchanged), waves crossed the whole grid in ~4 ms, and tap
position only rebalanced the same fixed resonances. Hence the move to a
human-speed surface driving tuned voices. The 1a code is in git history
(`7016618`) with its review notes and C++ port notes.

### Gestures (how you disturb it)
| Gesture | What it does to the medium |
|---|---|
| **Drop** | A single point impact that ripples outward. |
| **Stir** | Continuous circular motion that builds turbulence. |
| **Wave** | A broad sweep that moves the whole body at once. |
| **Still** | A hand on the surface: damps and calms the medium. |

### Modes
- **Phase** — the medium's state of matter.
  - *Ice*: brittle, granular, fractures rather than flows.
  - *Liquid*: flowing, resonant, clear wave propagation.
  - *Vapor*: diffuse, breathy, energy scatters.
  - Transitions must be playable (e.g. freezing a ripple mid-flight), not a menu switch.
- **Vessel** — an external source becomes the medium: a sample, a voice, or live
  input. The water takes the shape of whatever fills it.

### Underlying features
- **Erosion** — repeated gestures leave traces; the medium drifts over a set.
- **Cycle** — optional slow autonomous arc through phase states, for
  installations and long-form restorative pieces.

## Tuning and scales

What is tuned is the **stones**: each holds a scale degree within the set
**range** (a lowest and highest pitch). Changing the scale, root or range
retunes the stones; it never rewrites what the water is doing.

**Build one general engine, not a menu of scales.**

A scale is: a **root note**, an ordered list of **cents offsets** from that root,
and a **period** (usually 1200 cents). A tuning is: a **reference note** and a
**reference frequency in Hz**. Everything below is data on top of that:

- **12-TET modes** — major, minor, and all diatonic modes; subsets of the 12 semitones.
- **Chromatic** — all twelve.
- **Arabic / maqam** — 24-TET cents values, giving half-flats (e.g. 150, 350 cents).
- **Indian** — shruti and raga sets expressed as just-intonation ratios converted to cents.
- **Open microtonal** — quantization off; pitch is continuous.
- **Scala (.scl) import** — free access to thousands of historical and world tunings. Worth supporting early; it is a simple text format and makes the engine general.

Reference pitch is a float in Hz. Ship A=440 and A=432 as presets, but never
hard-code the two; arbitrary reference pitches must work from day one internally.

Quantization must have a **strength/glide** control, not just on/off. Hard
snapping fights the concept of a flowing medium. The water can bend a ringing
stone's pitch (e.g. pressure from passing waves); quantization strength sets
how firmly the stone is pulled back to its scale degree, and glide how fast.

Later, if it earns its place: MTS-ESP support and MPE per-note pitch.

## Control and performance

Build in this order:
1. **XY surface in the plugin UI** — click = Drop, drag = Stir, swipe = Wave,
   press-and-hold = Still. No hardware needed; the primary way to play.
2. **MIDI keyboard** — a note drops energy at the stone holding that scale
   degree (the water then carries it to the others), velocity sets energy, aftertouch feeds continuous stirring, sustain pedal engages Still.
   Mod wheel / CCs morph Phase.
3. **MPE controllers** (Seaboard, LinnStrument, Push) — per-note pressure and
   glide map naturally onto disturbance and microtonal pitch.

Later possibilities: tablet/pen pressure, multi-touch second screen, OSC from a
phone's motion sensors.

## Tech stack
- **Framework:** JUCE (C++), built with CMake.
- **Formats:** AU + VST3 + Standalone first (AU is required for Logic). CLAP
  when convenient. AAX only if Pro Tools support is ever needed — it requires an
  Avid partnership and PACE signing.
- **Platforms:** macOS first (Apple Silicon + Intel), Windows and Linux via CI.
  No platform-specific code in the DSP layer, ever.
- **UI:** JUCE WebView — interface and water visuals in HTML/CSS/JS/WebGL.
- **Prototyping:** medium physics sketched in the browser (JS + Web Audio) in
  `prototype/`, then ported to C++.

## Build phases
1. **Browser prototype** of the generative medium — iterate until it feels
   right. (1a, the audio-rate grid, is done; see Prototype findings.) 1b: a
   human-speed surface, tuned stones, bell voices, and a *minimal* tuning core
   (root, cents list, period, reference pitch, range) with a few built-in
   scales. Click = Drop, drag = a trail; no other gestures or modes yet.
2. **Plugin skeleton** — builds, loads in a host, makes a sound, passes pluginval.
3. **Port the medium** to C++ in `source/dsp`.
4. **Full tuning engine** — every scale family above, Scala import,
   quantization strength/glide.
5. **WebView UI** with the XY surface.
6. **Gestures → Phase → Vessel → Erosion → Cycle**, in that order.

Do not jump ahead of the current phase without Dash's go-ahead.

## Working rules for agents

### The listening gate
Agents cannot hear. Code that compiles and passes tests is not "done." At the
end of every milestone, stop and ask Dash to listen and play. Describe what
should be audible so he knows what to evaluate.

### Real-time audio safety (non-negotiable)
Inside `processBlock` and anything it calls:
- No memory allocation or deallocation (watch hidden ones: container growth,
  `std::string`, `std::function` captures, `shared_ptr` copies).
- No locks, mutexes, or blocking waits.
- No file, network, or console I/O, including logging.
- No unbounded loops.
- UI ↔ audio communication via atomics or lock-free FIFOs only.
- Smooth parameter changes; guard against denormals and NaNs.
- Handle any block size and sample rate the host provides.

### Objective checks agents can run themselves
- **Offline render:** render a fixed gesture sequence to WAV.
- **Settling:** output decays to silence after a disturbance; energy never runs away.
- **Stability:** stable across sample rates (44.1–192k) and parameter extremes;
  no NaNs or infinities.
- **Tuning accuracy:** FFT the render and assert partials land within a few cents
  of the target frequencies. This is how tuning gets verified without ears.
- **CPU benchmark:** processing time per block; flag regressions.
- **pluginval** at a strict level, and `auval` on macOS.

## Open questions
- Stones: how many, how they're laid out over the range (pitch by position or
  scattered), and whether the performer or the water can move them.
- What exactly makes a stone ring: a wave crest passing a threshold, energy
  arriving, or both — and how simultaneous arrivals combine.
- How Phase changes the surface and the bell voices (ice / liquid / vapor).
- How Vessel works now: outside audio disturbing the water, or becoming the
  stones' voice.
- Instrument name.
