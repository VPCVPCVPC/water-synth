# Prototype: the medium in the browser

Phase 1 sketch of the medium (see [CLAUDE.md](../CLAUDE.md)). A 32×32 damped
wave surface runs at audio rate; the grid's own resonances are the sound.
There is no tuning, no modes, and no plugin here. Throwaway-friendly: the
point is to find out whether disturbing it feels alive.

## Run it

```bash
node prototype/serve.mjs
```

Open http://localhost:8123 in Chrome, Safari, or Firefox and click
**Click to wake the water** (browsers need a click before they play sound).
In the Claude desktop app, the browser pane can start it from
`.claude/launch.json` ("prototype").

The small Node server is needed instead of opening the file directly: it sends
the headers that let the page and the audio thread share memory.

## Playing

- **Click**: a drop — one impact where you click. Each drop varies slightly.
- **Drag**: the wake of your finger moving through the surface. Faster is
  louder. Holding still while pressed adds nothing.
- Every drag starts with a drop (pressing down is a click).
- Pen and touch: pressure sets drop strength; a mouse click is fixed strength.

## What you're seeing

The canvas is an **energy map**, not a picture of the water. Ripples cross
the grid in about 4 ms at audio rate, far too fast to see as rings, so it
shows where energy sits instead:

- brightness = how much energy the surface holds, on the same 60 dB scale the
  sound fades over;
- the pattern = standing waves (where energy pools), with contrast exaggerated
  so it reads;
- two faint circles = the listening points (left and right channels);
- meters = total surface energy, and output level (turns orange near the limiter).

Real water visuals come later (Phase 5, WebGL). Judge "does it feel like
water" by ear.

## The physics knobs

Dev knobs for tuning the medium, not instrument controls:

| Knob | What it does |
|---|---|
| decay | how long broad motion rings (time to fall 60 dB) |
| fine-ripple decay | how long sharp detail lasts; never longer than decay |
| wave speed | how fast ripples travel — **also moves the pitch of every resonance** |
| input strength | how hard each gesture pushes |
| volume | listening level |

Sweeping wave speed while the surface rings glides every resonance together
and changes the loudness too (like tightening a drumhead mid-note: faster is
louder and brighter, up to about +13 dB). That's the physics, not a
performance control: how pitch attaches to the medium is decided in Phase 4
(tuning) with Dash.

## Listening check — what to evaluate

Defaults: a soft "plip" with a low body around 170 Hz that rings for about
2.5 s; the brightest shimmer fades within about half a second and the mid
tones take a second or more. It will likely
sound more like a struck membrane or plate than water — that's the starting
point, to be shaped by ear with the two decay knobs.

1. Does a click feel like a drop into water, or like a drum / metal plate?
2. Does a drag sound like moving through water, or like filtered noise gated
   by the mouse?
3. Do repeated taps in one spot sound like the same water touched slightly
   differently, rather than randomly louder and softer?
4. Do drops layered on a still-ringing surface blend, and does the tail fade
   to true silence with no click at the end?
5. Heavy dragging: does it sound squashed (output meter orange = limiter)?
6. Fast drags vs slow ones: different in character, or only louder?
7. Drag across a listening-point circle: there's a brighter, scratchier hiss
   while you're right on it (like a microphone next to the hand). Welcome or
   distracting?
8. Does the fixed click strength already feel limiting?

### Decisions for Dash

- Should a drag begin with a drop (current), or start silently?
- Where variation comes from: currently small random nudges to each drop,
  plus the noise in a drag and whatever the surface is already doing. Lean
  more on the medium's state and the gesture's detail?
- The drag's wake already sounds turbulent, which overlaps with how CLAUDE.md
  describes Stir. This prototype shouldn't settle what Stir becomes.

### Provisional choices (not decisions)

- A square 32×32 grid with fixed edges. Wave speed and grid size set the
  resonances, so they act like pitch — this touches the open question of how
  tuning attaches to the medium. The square shape makes pairs of modes
  coincide, so there are fewer distinct resonances: sparser, more bell-like.
  A slightly non-square grid would spread them apart.
- Two fixed listening points. Whether they move is an open question.
- Audio runs at 48 kHz for CPU headroom: the JavaScript simulation uses about
  17% of real time at 48k, about 40% at 96k and about 100% at 192k.

## Known quirks

- Pen pressure is often near zero at first contact, so pen drops can be weak.
- Gestures take effect at the next 128-sample block (up to ~2.7 ms late).
- If the event queue is ever full (in practice only while audio is suspended),
  gestures are dropped; slider changes are retried until they get through.
- Very rarely (about 1 in millions of frames under stress) the display shows a
  frame mixed from two consecutive frames. Harmless; see port notes.

## Checks

```bash
node prototype/check.mjs
```

About a minute. It checks stability across 44.1–192 kHz and parameter
extremes, that energy never grows once gestures stop and the knobs are held
still (checked every step), that the
decay knobs give the decay times they promise and pitch doesn't drift with
sample rate, settling to exact silence, identical output at any block size,
bad-input handling, variation between identical drops, drag loudness across
sample rates and pointer timing, the event queue, and CPU cost. It writes a
reference render to `prototype/output/drops.wav` (not committed).

## Files

| File | What |
|---|---|
| `medium.js` | The simulation. No browser audio code, nothing allocated while processing; shaped for the C++ port. |
| `medium-worklet.js` | Runs the medium on the browser's audio thread. |
| `ring.js` | Lock-free queue: page → audio thread (gestures, knob changes). |
| `visuals.js` | Lock-free snapshots: audio thread → page (energy map, meters). |
| `main.js`, `index.html` | Page: pointer input, drawing, knobs. |
| `check.mjs` | Objective checks, run with Node. |
| `serve.mjs` | Local server with the headers shared memory needs. |

## Notes for the C++ port (Phase 3)

Collected from the real-time safety and DSP reviews:

- **Validate before every float → int conversion.** In C++, converting NaN,
  Inf or an out-of-range float to an integer is undefined behaviour (JS just
  gives 0 or wraps). Keep the finite checks and clamps in `drop`, `stroke`,
  `setParamIndex` and the `exLen` clamp, and check event fields are finite
  before casting them (event type, parameter index, `floor(centre ± half)` in
  `fillKernel`). Otherwise a bad UI or host value becomes an out-of-bounds
  write into the grid.
- Keep block-size independence: the persistent sub-block position (`subPos`)
  means smoothing, the output-gain ramp and excitation shapes advance every 32
  samples of stream time, not per host block. Port the bit-identical
  any-block-size check too.
- Drain the event queue at the top of `processBlock`; never call `Medium`
  from the message thread. `snapshot`/`energy` also run on the audio thread
  and leave through the visuals buffer.
- Keep the guards: NaN/runaway reset (counted), silence snap and sleep. Port
  `check.mjs` to a native test harness, including the CPU benchmark at every
  supported sample rate.
- Parameters are state: prefer shared atomic targets (or APVTS) to queued
  parameter events, so a full queue can't drop a final value.
- Use `float` for the grid with `juce::ScopedNoDenormals` in `processBlock`
  (the JS grid is Float64 only to avoid float32 subnormals in JS). Sum
  `energy()` in double; with a float grid, relax the per-step energy check's
  tolerance to ~1e-6.
- Event queue: `std::atomic<uint32_t>` indices with release on publish and
  acquire on the other side (relaxed would be a bug), separate cache lines —
  or `juce::AbstractFifo`. Single producer only; add a queue per producer.
- Visuals: the JS seqlock can rarely pass a mixed frame because plain accesses
  aren't ordered against the atomics. In C++ use fences (release after the
  first increment, acquire before the re-check) or a lock-free triple buffer.
  Assert the frame size matches the grid.
- Size any scratch buffer to the host's maximum block size.
- Consider a fixed internal simulation rate with resampling: CPU scales with
  sample rate (in JS at 192k: ~100% of real time while playing, ~122% with
  all 16 excitations active — benchmark the worst case), and near the stability limit
  the finest ripples shift with sample rate (FDTD dispersion).
- Keep the xorshift state as `uint32_t`.
- Grid size is capped at 64 in the prototype; N ≥ 128 wasn't real-time and
  produced subnormals even in doubles. Keep a cap.
