# Water Synth — Design Doc

> Working title. This file is the source of truth for what this instrument *is*.
> Every agent and every session reads it first. When a technical choice conflicts
> with this doc, the doc wins — or the doc gets deliberately updated by Dash.

## The core idea

**You don't trigger sounds. You disturb a medium.**

The instrument is a body of sound — a "medium" — that sits at rest. Every
performer action injects energy into it. The medium responds on its own terms:
it ripples, carries, interferes, and slowly settles back to stillness.

This is a performance instrument first. It should feel alive, responsive, and a
little beyond full control — like touching water, not like pressing a key that
plays a sample.

### What this means in practice
- There is no "note" in the usual sense. Input is *energy* placed somewhere in
  the medium, with some shape and intensity.
- Silence is a state the medium returns to naturally.
- The same gesture should never sound exactly the same twice.
- If a feature makes this feel like a preset synth, it's the wrong feature.

## Structure

### Core: the medium
A simulated surface that holds energy, propagates it, and damps it over time.
Starting hypothesis: a 2D grid simulation (finite-difference wave equation or
mass-spring / waveguide mesh) with one or more "listening points" that read the
surface's motion as audio. Open to change after the prototype.

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

The medium has no notes, so what is tuned is its **resonances** — the pitches the
surface rings at when disturbed. How quantization attaches to the simulation is
an open question to answer during the prototype (candidates: a tuned resonator
bank read alongside the grid; quantizing the grid's tension/size so ripples ring
at scale pitches; snapping listening-point positions).

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
snapping fights the concept of a flowing medium; the medium should be able to
slide toward a scale degree rather than jump.

Later, if it earns its place: MTS-ESP support and MPE per-note pitch.

## Control and performance

Build in this order:
1. **XY surface in the plugin UI** — click = Drop, drag = Stir, swipe = Wave,
   press-and-hold = Still. No hardware needed; the primary way to play.
2. **MIDI keyboard** — note selects the scale degree that rings, velocity sets
   energy, aftertouch feeds continuous stirring, sustain pedal engages Still.
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
1. **Browser prototype** of the medium — iterate until the behavior feels right.
2. **Plugin skeleton** — builds, loads in a host, makes a sound, passes pluginval.
3. **Port the medium** to C++ in `source/dsp`.
4. **Tuning engine** + quantization of the medium's resonances.
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
- Which mechanism attaches quantization to the medium's resonances.
- How many listening points, and whether they move during performance.
- How Vessel mode injects outside audio into the grid.
- Instrument name.
