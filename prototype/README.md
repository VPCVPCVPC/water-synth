# Prototype: the generative medium

Phase 1b sketch of the instrument (see [CLAUDE.md](../CLAUDE.md)). A pond of
water you can watch, with tuned stones in it. You disturb the water; ripples
travel, reflect and meet; when a crest reaches a stone, the stone rings like a
water-struck bell at its pitch in the scale you've set. You don't pick notes
directly — the water does. No plugin here, and only two gestures (drop and drag).

## Run it

```bash
node prototype/serve.mjs
```

Open http://localhost:8123 and click **Click to wake the water** (browsers need
a click before they play sound). In the Claude desktop app, the browser pane
can start it from `.claude/launch.json` ("prototype").

The small Node server sends the headers that let the page and the audio
thread share memory; opening the file directly won't work.

## Playing

- **Click** — a drop: a ring of ripples spreads from where you click.
- **Drag** — a trail of small drops along your path; faster is stronger.
- Stones ring when a crest reaches them, harder for higher crests, and glow
  as they do (the glow shows how hard the water hit, not how loud the stone
  then rings). Two ripples too small to ring a stone alone can ring it together.
- Ripples bounce off the walls, so stones ring again as reflections pass.
- A stone struck while still ringing rings on (brighter, or partly damped,
  depending on how the new strike lines up) — it's one object, not a sampler.
- The water settles by itself; phrases thin out and fade as it calms.

## Controls

**Tuning** — scale (major, natural minor, dorian, major/minor pentatonic,
chromatic, maqam Rast), root, lowest and highest note (C1–C8), and the
reference pitch (A4 in Hz, 400–480 in this prototype; 440 and 432 one click
away — the tuning core itself takes any frequency). There is one stone per
scale note in the range. Note names are relative to A4 at the chosen reference
(at 432 Hz, A4 is still labelled "A4"). Changing these retunes the stones; it never touches
the water. A stone still ringing keeps its old pitch until it's next struck,
then its old ring crossfades out over 100 ms.

**Water**

| Knob | What it does |
|---|---|
| tempo | how fast ripples travel; the whole water speeds up or slows down together, so the same gesture plays the same phrase faster or slower |
| water decay | how long the water keeps moving (shown in seconds at the current tempo) |
| fine ripples | how long small, sharp ripples last |
| sensitivity | how much of the water the stones hear — and so how many notes a gesture makes and how long phrases last |
| splash | ringing stones send ripples of their own back into the water; chains always die out (the water never gives back more than you put in) |

**Bells** — bell decay (how long a struck stone rings, including stones already
ringing) and volume. **Stone layout** compares two ways of placing stones
(scattered, or low-to-high left-to-right); one will go once you decide.
**Show note names** is a dev aid, off by default.

The output meter turns orange when the limiter is working.

## Listening check — what to evaluate

At the defaults (C major pentatonic, C3–C6, 16 stones), one click in the
middle rings about 25 notes over about 2 seconds, with a soft bell tone and a
short water "tick" on each.

1. Does tapping in different places give clearly different phrases?
2. Do overlapping taps make moments neither would alone?
3. Do the bells sound water-struck (a soft tick, then a clear ring), or like a
   synth pluck preset? (The bell's partials are 1 : 2 : 3 : 4.07 : 5.4 — sweeter
   than before; a truer marimba-bar tuning is the alternative.)
4. Re-strikes of a ringing stone: does it sound like the same stone ringing on?
   About a third of re-strikes partly damp it (physics) — natural, or notes
   being swallowed?
5. Ripples make a crest, a trough and a smaller crest, so nearby stones often
   ring twice ~100 ms apart, the second softly. Charming water detail, or a
   stutter?
6. Density: is ~25 notes per click right, or should the default sit nearer 13
   (lower sensitivity)? Are distant stones too faint next to the loud nearby ones?
7. Does the music ending before the visible water stops feel natural, or
   disconnected?
8. Splash: good surprises, or mush — and does it ever fall into loop-like
   repetition?
9. Tempo: sweep it while the water rings. Same phrase, faster or slower?
   Changing tempo mid-flight speeds up the moving water — a possible seed for
   the Ice phase (not built).
10. Layouts: scattered vs pitch-by-position. Do you find yourself aiming at the
    dots like keys? Clicking right on a stone plays it first, loudly.
11. Stereo (stones panned by position, moderate width): pleasant?
12. Fast drags get loud steeply. Too much?

### Decisions for Dash

- **What makes a stone ring.** Phase 1b's hypothesis: a crest whose peak
  passes a threshold. The stones ignore water moving below it. The
  alternative CLAUDE.md lists is "energy arriving". It's isolated in one
  method (`Stones.detect`) so it can be swapped.
- **Tempo as time-lapse** (current) vs damping in real seconds (slow water
  sparser, fast water busier).
- **Splash is bounded by what you play** — it can outlive your last gesture by
  about the water's decay. A more local, energy-based bound is possible.
- **Stone layout** — keep scattered, pitch-by-position, or something else.
- **Re-strikes** — physically accurate (sometimes damping) or always adding.
- **Retunes** — a ringing stone crossfades its old pitch out over 100 ms when
  next struck (my reading of "a stone has one pitch"); the alternative is to
  let the old ring decay naturally under the new one.
- **Bell partials** and **velocity range** (30 dB) — taste.

### Provisional choices (not decisions)

- A 128 × 97 surface with free edges (reflections stay crests), stepped 1000
  times a second of water time, with an isotropic grid stencil so ripples are
  the same in every direction.
- One stone per scale note in the range; at most 128.
- Each stone panned by its left–right position (range 0.2–0.8).
- Drops vary slightly (position, strength, size); most variation comes from
  the water already moving.

## Known quirks

- Pen pressure is often near zero at first contact, so pen drops can be weak.
- Gestures land at the next audio block and simulation step (≤ ~4 ms late).
- Very rarely the display shows a frame mixed from two consecutive frames.
- A very dense chromatic range at maximum splash and long bell decay can push
  into the limiter.

## Checks

```bash
cd prototype && npm run check
```

About a minute and a half; three files:

- `check-tuning.mjs` — references (440, 432, any), scale building, maqam Rast,
  a non-octave scale, labels, bad input.
- `check-water.mjs` — energy never rises once gestures stop; wave speed and
  tempo invariance; stones ring in distance order on time; position matters;
  interference; reflections; only scale notes; retuning never touches the
  water; splash always dies out; moving water changes phrases; identical
  notes at any sample rate and block size; bad input; CPU.
- `check-bells.mjs` — bell pitch by FFT within 2 cents (exactly 0.00 measured)
  at 44.1/48/192 kHz including A = 432 and a quarter tone, end to end through
  the event queue; no aliasing; decay; click-free re-strikes and retunes;
  tick tone independent of sample rate; limiter headroom; visuals frame; CPU.

## Files

| File | What |
|---|---|
| `tuning.js` | Scales, reference pitch, range → pitches. |
| `surface.js` | The water: damped 2D waves at human speed, free edges, craters. |
| `stones.js` | When a crest rings a stone (the Phase 1b hypothesis). |
| `layout.js` | Where stones sit (two layouts to compare). |
| `engine.js` | Water + stones on one fixed clock; gestures; splash. |
| `bells.js` | One water-struck bell per stone. |
| `instrument.js` | Everything for one audio stream; page events; visuals frames. |
| `water-worklet.js` | Runs the instrument on the browser's audio thread. |
| `ring.js` | Lock-free queue: page → audio thread. |
| `visuals.js` | Lock-free frames: audio thread → page. |
| `main.js`, `index.html` | The page: drawing, gestures, controls. |
| `serve.mjs` | Local server with the headers shared memory needs. |
| `check-*.mjs` | The checks. |

## Notes for the C++ port (Phase 3)

Collected from the real-time safety, DSP and tuning reviews of Phases 1a and 1b.

- **Validate before every float → int conversion** (NaN/Inf/out-of-range casts
  are undefined behaviour in C++): event types and indices, stone counts,
  `floor`/`ceil` in crater windows and `heightAt`, strike sample offsets.
- **Fixed simulation clock:** keep the 1 kHz water clock and the mapping of
  step k to stream sample `floor(k·fs/1000)`; port the rate- and
  block-size-independence checks.
- **Bells:** keep phasor state in `double` (float drifts 1–4% in magnitude over
  long tails). Render each strike from its exact sample. Size the per-block
  strike list to `MAX_STONES × ceil(maxBlock / samplesPerStep)` or render per
  step; splash already reads a per-step list.
- **Water:** `float` is fine for the grid with `juce::ScopedNoDenormals`; sum
  `energy()` in double. Craters are added at rest (to both height arrays) with
  the cached Laplacian refreshed over the window.
- **Event queue:** `std::atomic<uint32_t>` indices with release/acquire (or
  `juce::AbstractFifo`), one queue per producer. Stones: staged events plus a
  commit that applies only if every stone arrived.
- **Visuals:** the JS seqlock can rarely pass a mixed frame; in C++ use fences
  or a lock-free triple buffer, and assert frame sizes.
- **Parameters** are state: prefer shared atomic targets (or APVTS) to queued
  events. Consider smoothing tempo/decay on the water clock if jumps sound lumpy.
- **Guards:** keep the runaway/NaN resets (counted), the silence snap and sleep,
  NaN-safe voice release, and input validation at every boundary.
- **Tuning:** stones must stay within audible, playable pitches (8 Hz to below
  0.45·fs); the page limits the range to C1–C8. A Scala importer (Phase 4)
  must decide how to treat out-of-order or ≥-period degrees.
