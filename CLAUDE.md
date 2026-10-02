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
- Where you disturb it matters: position sets which notes ring and when
  (with quantize on, *when* leans toward the beat grid).
- Waves interact: two disturbances meeting make something neither makes alone.
- Silence is a state the medium returns to naturally.
- The same gesture should never sound exactly the same twice — mostly because
  it lands in water that is already moving.
- If a feature makes this feel like a preset synth or a step sequencer, it's
  the wrong feature. (Quantize at full strength is Dash's deliberate
  exception: it puts the water's timing on a grid, but the water still
  chooses which notes, how hard, and what phrase — nothing is written in
  steps.)

## Structure

### Core: the medium
A simulated surface that holds energy, propagates it, reflects it off its
edges, and damps it over time. It runs at **human speed**: ripples visibly
travel across it. Its speed — **flow** — is adjustable, from slow drift
(up to ~30 s to cross) to busy cascades (well under a second). Flow is a
time-lapse: the whole water speeds up or slows down together, so the same
gesture plays the same phrase faster or slower. (Flow is the water's pace;
"tempo/BPM" means only the loopers' beat grid.) The surface is the composer,
not the oscillator: it decides *when* (leaning toward the beat when quantize
is on), *which*, and *how hard*.

### Tuned stones: how the medium sounds
Points on the surface — **stones** — each hold one pitch from the current
scale and range. When a ripple reaches a stone, the stone rings. How hard the
water hits sets how loud; ripples arriving together ring it brighter or set off
its neighbours. Distances between where you disturb and where the stones sit
make the rhythm (pulled toward the beat when quantize is on); reflections make
echoes that repeat but drift.

The performer can **move stones** — drag them by hand, randomize them, or
change how they spread (Dash, Phase 1c). A stone moved through moving water
rings as crests pass over it. Whether the *water* can move stones stays open.
A stone struck while still ringing rings on: it is one object, not a sampler.

### Voices: what a struck stone sounds like
The default voice is the **water-struck bell**: clear, tuned resonant tones with
a soft bell/marimba-like decay and a short "tick" of water touching the stone.
The voice can be designed (Phase 1c) — but the water still decides when
(within quantize), which, and how hard: how hard a stone is struck shapes its
loudness and brightness by default. A voice is the **bell** (its partials, decay, tick and
brightness, all editable) plus an optional **synth layer** (two oscillators →
filter → envelopes), mixed; the default is the bell alone (Dash, Oct 2026).
- All stones share one voice; any single stone can be given an override.
- **Stones have no note-off.** Every voice falls silent on its own. A voice may
  sustain only while the water around its stone keeps moving, releasing as the
  water calms — the water holds the note, never the player.
- No factory presets or preset browser. Saving the session's state is fine,
  and you can save and recall your own voices (Dash, Oct 2026): a voice you
  designed, by name, onto the shared voice or any stone. Nothing ships in
  the list.
- A stone's own voice stays with the stone when you retune (Dash, Oct 2026).
- The Phase mode (prototyped in build phase 2) will act on these voice
  parameters; the voice editor is a sound-design surface, not the Phase
  mechanism.

### Layers: loopers
- **On the page, the looper is the Tape** (Dash, Oct 2026): a 4-track tape
  machine that records the water's sound. Touch loops (the gesture looper
  below) are set aside for now — the engine and its checks stay in the code,
  unused by the page, for Erosion or a later return.
- **Gesture looper** (set aside on the page, Oct 2026) — records disturbances
  (drops and drags, with their timing), not notes, and replays them into the
  living water, so each pass lands in water that is already moving and
  differs. Several loops of different lengths can layer and drift. Loop
  playback is a natural input for Erosion later, so loops are stored as timed
  gesture events.
- **Quantize** (optional, off by default) moves *when you touch the water*
  toward a beat grid — live touches and recorded ones — with a strength
  control from lean to snap (the default when enabled), plus swing. Touches
  lean; drags flow (never delayed — and, when the gesture looper is in use,
  a looped drag keeps its own timing).
  While it's on, the beat is visible on the pond. The same strength also pulls
  *when stones ring* toward the grid (a struck stone can wait for the next
  grid point, never sound early): at 0% the water keeps its own time, at 100%
  every note lands on the grid like a sequencer — a way to find serendipitous
  sequences and build songs that aren't only ambient. Quantize never chooses
  notes: which stones ring, and how hard, is still the water's. Note quantize
  never delays the water — only when struck stones are heard. (Dash,
  Oct 2026: quantizing only touches was too subtle to hear.)
- **Audio looper** (the *Tape* on the page) — "a tape beside the pond":
  records the instrument's output and layers fixed audio, like a loop pedal.
  The one feature that isn't the water; mainly for the standalone app. Several
  tape tracks of their own lengths, each with record, overdub, mute and clear
  (Dash, Oct 2026); they record the water's sound, not other tapes. A tape
  always plays back exactly what was recorded — retuning never touches it — so
  you can lay a bassline, then a melody, then harmonies in other tunings. With
  quantize on, a take starts on a beat and lasts whole beats: tapes follow the
  beat, but their lengths differ, so the way they line up keeps changing.
  Stopping, muting and clearing fade, never cut.

### Prototype findings (Phase 1a, Sept 2026)
An audio-rate 2D wave grid read directly as audio sounded like a metal plate,
and sounded the same wherever you tapped: the physics is linear (ripples pass
through each other unchanged), waves crossed the whole grid in ~4 ms, and tap
position only rebalanced the same fixed resonances. Hence the move to a
human-speed surface driving tuned voices. The 1a code is in git history
(`7016618`) with its review notes and C++ port notes.

### Listening results (Phase 1b, Oct 2026)
Dash: "It's gorgeous." Nothing felt off. He preferred the scattered stone
layout (pitch-by-position retired), and played with a much slower flow
(≈3.3 s to cross), longer water decay, and some splash — now the defaults.
The 1b design choices stand: a crest passing a threshold rings a stone;
flow as time-lapse; splash bounded by what you play; re-strikes that add to
a ringing stone (sometimes damping it).

### Listening results (Phase 1c A, Oct 2026)
Listening check 1 (loops, quantize, stone controls, touch): Dash — "it seems
good." Batch A's choices stand.

### Listening results (Phase 1c B, Oct 2026)
From listening check 2 so far: tapes must keep the tuning they were recorded
in (they do); Flow needs a much lower floor (~30 s to cross the pond);
quantize was hard to notice (now: live touches too, snap by default, a visible
beat); tapes follow the beat in whole-beat lengths. Water-held sustain:
"great". Tapes record only the water; a stone's own voice stays through
retunes; voices should be savable. The synth layer was too hidden to find. The
interface should become fun and pretty — and a near-final web prototype comes
before the app, for user testing (see Build phases).

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

## Look and feel (Dash, Oct 2026)
Zen garden minimalism: black and white, generous empty space, nothing
decorative that the water doesn't need. Type is all caps, wide and slightly
futurist (Syncopate), with extra letter spacing for a quiet sci-fi feel. The
tape section looks like a real 4-track tape machine, after Dieter Rams. The
water is drawn in greys — light crests, dark troughs — like light on still
water. Dash's brand mark is a set of white concentric rings on black (a
ripple); that motif carries through the knobs, the tape reels and the start
screen. Controls are knobs where a knob reads as part of an instrument; the
tape sits beside the pond so the page needs little scrolling. Fonts are
bundled, so the page works offline.

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

Pitch quantization must have a **strength/glide** control, not just on/off.
Hard pitch snapping fights the concept of a flowing medium. (This is pitch,
not the loopers' timing quantize.) The water can bend a ringing
stone's pitch (e.g. pressure from passing waves); quantization strength sets
how firmly the stone is pulled back to its scale degree, and glide how fast.

Later, if it earns its place: MTS-ESP support and MPE per-note pitch.

## Control and performance

Build in this order:
1. **XY surface in the plugin UI** — click = Drop, drag = Stir, swipe = Wave,
   press-and-hold = Still. No hardware needed; the primary way to play.
   **Touch first:** on iPad and iPhone — likely the ideal way to play — every
   finger is its own disturbance (multi-touch), and Apple Pencil pressure sets
   strength.
2. **MIDI keyboard** — a note drops energy at the stone holding that scale
   degree (the water then carries it to the others), velocity sets energy, aftertouch feeds continuous stirring, sustain pedal engages Still.
   Mod wheel / CCs morph Phase.
3. **MPE controllers** (Seaboard, LinnStrument, Push) — per-note pressure and
   glide map naturally onto disturbance and microtonal pitch.

**Camera / motion input (planned, not yet scheduled):** a dancer plays the
instrument with her movement. Camera motion is an input, not Vessel. Motion in
the camera frame becomes gesture events, like touch — at first drops and drags
where movement happens, stronger for faster motion; how body motion maps to
Stir, Wave and Still stays open — so the water, the stones and the loopers
don't care where a gesture came from. Every
input source enters through one gesture path, and the gesture looper (when in
use) records gestures from any source. Motion analysis stays on the device.

Later possibilities: a second-screen surface, OSC from a phone's motion sensors.

## Tech stack
- **Framework:** JUCE (C++), built with CMake.
- **Formats:** AU + VST3 + Standalone first (AU is required for Logic). CLAP
  when convenient. AAX only if Pro Tools support is ever needed — it requires an
  Avid partnership and PACE signing.
- **Platforms:** macOS first (Apple Silicon + Intel), Windows and Linux via CI.
  **iPad and iPhone** are an intended target — a standalone app and AUv3, via
  JUCE — likely the ideal way to play; this doesn't reorder the build phases.
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
   (1b passed its listening gate.) 1c: layers and voices, in two halves, each
   ending in a listening gate —
   A: gesture looper with optional quantize, stone controls (move, randomize,
   spread), multi-touch and phone/iPad layout, played with today's bell;
   B: the voice editor (shared voice with per-stone overrides, water-held
   sustain) and the audio looper. 1d: follow-ups from listening check 2.
2. **Web prototype for user testing** (Dash, Oct 2026) — a close-to-final
   instrument in the browser that other people play before any app ships:
   a designed interface, fun and pretty (the water visuals, and the Tape as
   a 4-track tape machine — see Look and feel); the remaining gestures
   (Stir, Wave, Still) and Phase (ice / liquid / vapor); and some of MIDI, Vessel
   and hosting for testers, scoped with Dash when we get there. It ends in
   user testing; what testers find feeds the phases below.
3. **Plugin skeleton** — builds, loads in a host, makes a sound, passes pluginval.
4. **Port the medium** to C++ in `source/dsp` (what build phase 2 proved,
   including its gestures and the Phase modes).
5. **Full tuning engine** — every scale family above, Scala import,
   quantization strength/glide.
6. **WebView UI** with the XY surface (the build-phase-2 interface).
7. **Vessel → Erosion → Cycle**, in that order (and any gestures or Phase-mode
   behaviour build phase 2 didn't settle).

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
- Whether the water can move stones (the performer can; layout is
  scattered). How many stones there are is now the performer's: one per scale
  note in the range by default, or any count (Dash, Oct 2026).
- What exactly makes a stone ring: a wave crest passing a threshold, energy
  arriving, or both — and how simultaneous arrivals combine. (The crest
  threshold stands for now.)
- How Phase changes the surface and the bell voices (ice / liquid / vapor).
- How Vessel works now: outside audio disturbing the water, or becoming the
  stones' voice.
- How camera / body motion maps to gestures, and when camera input is scheduled.
- Instrument name.
