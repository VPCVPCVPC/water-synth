# Prototype: the generative medium

Phase 1c sketch of the instrument (see [CLAUDE.md](../CLAUDE.md)). A pond of
water you can watch, with tuned stones in it. You disturb the water; ripples
travel, reflect and meet; when a crest reaches a stone, the stone rings like a
water-struck bell at its pitch in the scale you've set. You don't pick notes
directly — the water does. Loops record your touches and replay them into the
moving water. No plugin here, and only two gestures (drop and drag).

## Run it

```bash
node prototype/serve.mjs
```

Open http://localhost:8123 and tap **Touch to wake the water** (browsers need a
tap before they play sound). In the Claude desktop app, the browser pane can
start it from `.claude/launch.json` ("prototype"). The small Node server sends
the headers that let the page and the audio thread share memory; opening the
file directly won't work.

## Playing on iPad or iPhone

The page needs a secure connection to run on another device (`localhost` only
counts on the computer itself), so the server has an HTTPS mode. It needs a
certificate your devices trust. One-time setup with
[mkcert](https://github.com/FiloSottile/mkcert) — these steps install a local
certificate authority on your Mac and your device, so they're yours to run:

1. On the Mac: `brew install mkcert`, then `mkcert -install`.
2. Make the certificate, outside the project. It covers your Mac's `.local`
   name (stable) and its current Wi-Fi address (System Settings → Wi-Fi →
   Details → IP address; replace 192.168.1.20 below). If the address changes
   later, use the `.local` name or run this again:
   ```bash
   mkdir -p ~/.water-synth/certs && mkcert -cert-file ~/.water-synth/certs/cert.pem -key-file ~/.water-synth/certs/key.pem localhost "$(scutil --get LocalHostName).local" 192.168.1.20
   ```
3. Put mkcert's root certificate on the iPad/iPhone: run `mkcert -CAROOT`, and
   AirDrop **only `rootCA.pem`** from that folder to the device. Never share or
   copy `rootCA-key.pem` — anyone with it can make certificates your devices
   trust. The downloaded profile appears at the top of Settings; install it
   within a few minutes (or find it under Settings → General → VPN & Device
   Management), then turn on full trust for it (Settings → General → About →
   Certificate Trust Settings).
4. Start the server with `node prototype/serve.mjs --https` (if macOS asks
   whether node may accept incoming connections, click Allow) and open, on the
   device, the `.local` address it prints or the one matching your Wi-Fi
   address (ignore VPN ones). While it runs, anyone on that network can reach
   the page — stop it when you're done.

On iOS 17 and later the page asks to play through silent mode; on older
iOS, turn silent mode off (ring/silent switch or Action button) or you'll
hear nothing. If iOS pauses the sound (a lock, a call, switching apps), touch
the water to bring it back. Held upright, the pond turns a quarter so it fills the screen — the
water is the same, so stereo still follows the pond: its left and right are
the top and bottom of an upright phone. Older devices may struggle with the
CPU; say if it stutters.

## Playing

- **Touch** — a drop: a ring of ripples spreads from where you touch. Every
  finger is its own drop or drag, so two hands play at once. Apple Pencil
  pressure sets how hard; a mouse click is fixed strength.
- **Drag** — a trail of small drops along your path; faster is stronger.
- Stones ring when a crest reaches them, harder for higher crests, and glow
  as they do (the glow shows how hard the water hit, not how loud the stone
  then rings). Two ripples too small to ring a stone alone can ring it together.
- Ripples bounce off the walls, so stones ring again as reflections pass.
- A stone struck while still ringing rings on (brighter, or partly damped,
  depending on how the new strike lines up) — it's one object, not a sampler.
- The water settles by itself; phrases thin out and fade as it calms.

## Controls

The controls live under the pond (tucked into a "Controls" drawer on phones).

**Loops** — four layers. Each records your touches, not sound, and replays
them into the water, so each pass lands in water still moving from the last
and plays a different phrase.
- **record** starts a take; **finish** ends it and the loop starts playing.
  On a playing loop, **overdub** adds more on top; what you add is heard live
  once and replays from the next pass.
- **mute** silences a loop and keeps its place; **stop** then **play**
  restarts it from its top (at the next bar if quantize is on).
- **clear** (tap twice) erases a layer completely; **clear all loops** (tap
  twice) erases every layer and the beat grid — a fresh start. Clearing never
  touches the water: what's already moving rings out.
- A layer holds 4096 gestures; if one fills, it says so and stops recording.
- **Quantize** (off by default) moves when your *recorded* touches land toward
  a beat grid — strength from lean to snap, swing, BPM and grid size — and
  rounds new loops to whole bars so they stay in time. Live touches are never
  delayed, and the water still decides when stones ring. BPM and bars only
  appear when quantize is on.

**Water**

| Knob | What it does |
|---|---|
| flow | how fast ripples travel; the whole water speeds up or slows down together, so the same gesture plays the same phrase faster or slower |
| water decay | how long the water keeps moving (shown in seconds at the current flow) |
| fine ripples | how long small, sharp ripples last |
| sensitivity | how much of the water the stones hear — and so how many notes a gesture makes and how long phrases last |
| splash | ringing stones send ripples of their own back into the water; chains always die out (the water never gives back more than you put in) |

**Stones** — **move stones**, then drag any stone to place it; placed stones
keep their place when you retune or randomize (which note each one holds
follows the scale: lowest stone, lowest note), and a stone dragged through
moving water rings as crests pass over it. **randomize** rearranges the stones you
haven't placed. **spread** goes from gathered in loose clumps to spread evenly
over the whole pond. **release placed** (tap twice) frees the stones you placed.

**Tuning** — scale (major, natural minor, dorian, major/minor pentatonic,
chromatic, maqam Rast), root, lowest and highest note (C1–C8), and the
reference pitch (A4 in Hz, 400–480 in this prototype; 440 and 432 one tap
away — the tuning core itself takes any frequency). There is one stone per
scale note in the range. Note names are relative to A4 at the chosen reference
(at 432 Hz, A4 is still labelled "A4"). Changing these retunes the stones; it
never touches the water. A stone still ringing keeps its old pitch until it's
next struck, then its old ring crossfades out over 100 ms.

**Bells** — bell decay (how long a struck stone rings, including stones already
ringing) and volume. **Show note names** is a dev aid, off by default. (The
voice editor comes in the second half of Phase 1c.)

The output meter turns orange when the limiter is working.

## Listening check 1 — what to evaluate

Defaults: your Phase 1b settings (slow flow, long water decay, some splash),
C major pentatonic, C3–C6, 16 stones, today's bell.

1. **Loops:** record a few touches and let them loop. Does each pass feel like
   the same gesture landing in different water — rich layers — or does it
   fight the water or turn mushy?
2. Layer loops of different lengths. Do they drift against each other in a
   good way?
3. **Quantize:** turn it on, record, and try lean vs snap. Does it keep the
   water feeling free, or does it start to feel like a step sequencer?
4. **Mute vs stop/restart:** both useful?
5. **Stones:** move a few by hand, randomize, change spread. Does arranging
   the pond feel like composing? Does dragging a stone through ripples work
   as a way to play?
6. **Touch:** on the iPad (or phone), play with several fingers. Natural?
   Is anything too small to hit, or does the page scroll or zoom when it
   shouldn't?
7. Portrait vs landscape on the phone.
8. CPU on the device: any stutter?
9. **Rest:** with several loops running and splash at its new default, does
   the water still get room to settle between phrases, or does it become a
   constant wash? Does the output meter turn orange?
10. **Many fingers:** loudness rises steeply with drag speed — with five
    fingers dragging, does it get harsh or overload?
11. **Move mode on touch:** is it always clear whether you're playing the
    water or moving stones?
12. **Placed stones and retune:** after arranging stones by hand, change the
    scale or the lowest note — each place keeps its spot but its note changes.
    Does that feel right, or should a note follow the stone you placed?
13. **Rearranging during play:** stones keep listening as they move, so
    randomizing or changing spread while the water is busy can ring the stones
    that land on crests. Welcome, or should a rearranged stone wait for calm water?

### Decisions for Dash

- **What makes a stone ring.** Phase 1b's hypothesis — a crest whose peak
  passes a threshold — stands for now. It's isolated in one method
  (`Stones.detect`) so it can be swapped.
- **Re-strikes** — physically accurate (sometimes damping) or always adding.
- **Retunes** — a ringing stone crossfades its old pitch out over 100 ms when
  next struck; the alternative is to let the old ring decay under the new one.
- **Whether the water can move stones** (you can; the water can't, yet).
- **Bell partials** and **velocity range** (30 dB) — taste; the voice editor
  will open these up.

### Provisional choices (not decisions)

- A 128 × 97 surface with free edges (reflections stay crests), stepped 1000
  times a second of water time, with an isotropic grid stencil so ripples are
  the same in every direction.
- One stone per scale note in the range; at most 128.
- Each stone panned by its left–right position (range 0.2–0.8).
- Loops: 4 layers, up to 60 s each, 4096 gestures per layer.
- Drops vary slightly (position, strength, size); most variation comes from
  the water already moving.

## Known quirks

- Pen pressure is often near zero at first contact, so pen drops can be weak.
- Gestures land at the next audio block and simulation step (≤ ~4 ms late).
- Very rarely the display shows a frame mixed from two consecutive frames.
- A very dense chromatic range at maximum splash and long bell decay can push
  into the limiter.
- A hard-driven pond sits in the limiter, with the meter orange as normal rather
  than as a fault. The level comes from how many stones the drops ring at once
  and how long the sustain holds them ringing, not from any runaway: in the
  test's never-calming water, hold on vs off is pre-limiter peak 1.98 vs 0.66
  with the same stones ringing. How loud a busy pond should be is a taste
  question for the listening gate.
- All 128 stones ringing at once, each with a synth layer, costs about 510 µs
  per 128-sample block at 48 kHz on the development machine (the budget is
  2667 µs, and the check allows 30%). That figure is measured in its own
  process: the same workload costs ~40% more when the process has already
  rendered the earlier checks, which is not the engine's doing. A faded bell
  or a silent synth layer drops out of the calculation, which is where the
  headroom comes from.

## Checks

```bash
cd prototype && npm run check
```

About three minutes; five files:

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
- `check-voices.mjs` — the synth layer in tune within 2 cents (sine, saw,
  square; 44.1/48/192 kHz; osc 2 transposed) and band-limited at two pitches
  where the folded-back partials cannot hide among the harmonics; envelopes and
  no note-off; click-free re-strikes and retunes; harder strikes louder and
  brighter (and not, with dynamics and strike brightness at 0); moving a knob
  (synth level, oscillator mix, cutoff, resonance) and the filter's own fastest
  strike sweep never step at a control refresh, by the output's phase-binned
  curvature and by the running value's own trajectory; overrides through the
  event path; water-held sustain holds while the water moves, lets go as it
  calms, and always ends in silence; the bell settling over 30 s of held
  strikes and still answering a strike by its hardness at that settled level;
  the incremental hold decay tracking a rebuilt exp(); the mix stopping growing
  over 30 s of looped drops in water that never calms; bit-identical at any
  block size; extremes; bad input; a faded bell, a silent synth layer and a
  guarded block segment; CPU.
- `check-looper.mjs` — loops replay every gesture at the same place each pass
  while each pass plays a different phrase; overdub, mute, stop/restart,
  clear and clear all; quantize snap/lean/swing and whole bars on a shared
  grid; live touches never delayed; identical at any sample rate and block
  size; limits; bad input; CPU.

## Files

| File | What |
|---|---|
| `tuning.js` | Scales, reference pitch, range → pitches. |
| `surface.js` | The water: damped 2D waves at human speed, free edges, craters. |
| `stones.js` | When a crest rings a stone (the Phase 1b hypothesis). |
| `layout.js` | Where stones sit: scattered, with a seed (randomize) and spread. |
| `looper.js` | The gesture looper and quantize. |
| `tuning-limits.js` | What the page lets you choose (checked to always give playable stones). |
| `engine.js` | Water + stones on one fixed clock; gestures; splash. |
| `voice.js` | Voice parameters: one shared voice, an optional override per stone. |
| `bells.js` | One voice per stone: the water-struck bell and the synth layer; water-held sustain. |
| `instrument.js` | Everything for one audio stream; page events; visuals frames. |
| `water-worklet.js` | Runs the instrument on the browser's audio thread. |
| `ring.js` | Lock-free queue: page → audio thread. |
| `visuals.js` | Lock-free frames: audio thread → page. |
| `main.js`, `index.html` | The page: drawing, gestures, controls. |
| `serve.mjs` | Local server with the headers shared memory needs; `--https` for devices. |
| `check-*.mjs` | The checks (`check-lib.mjs`: FFT and pitch measuring shared by them). |

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
- **Voices (Phase 1c):** the same structure ports directly —
  - Every partial is a rotating phasor plus a per-sample decay. Give the bell a
    capacity (the sum of the partials' magnitudes, which bounds the peak) *and*
    let a hit drive it past that capacity by its own energy, bleeding the excess
    back over ~0.1 s: a hard cap alone bounds the level correctly but swallows
    re-strikes once the water holds the note, so the held note stops answering
    how hard it is hit. The bleed is not what stops the runaway (the ring's own
    held decay does that, settling near 4.9 with the bleed off); what it buys
    is ~6 dB of headroom, so ordinary hits land in the transparent branch
    instead of being scaled back. The only path that eats dynamics is that
    hard-peak scale-back (`BELL_HARD_PEAK`): if it engages during play, raise
    it or bleed faster — never accept it. The synth layer keeps a fixed
    envelope cap (`SYNTH_PEAK`) with no bleed. Keep the tick uncapped.
  - `level()` (the sum of the partials' magnitudes) is a phase-independent
    *bound*, not a loudness: a hit at capacity can reduce it while adding
    energy. Never use it to measure loudness, energy or drift.
  - Read the voice's targets (filter cutoff and resonance, synth level,
    oscillator mix) every N samples but follow them **per sample** with a
    one-pole glide; a control-rate step on a ringing note is audible as a
    zipper, and the filter's own post-strike sweep is the worst case. Drive the
    filter envelope per sample and treat the glide's target as control-rate.
  - Round filter state below ~1e-15 to zero: subnormals cost badly on Intel.
    Retire the bell once its level is below hearing (the synth layer may ring
    on), and retire the synth layer once no oscillator has gain and the filter
    has drained — otherwise both keep costing CPU while silent.
  - Water-held sustain rebuilds the partial decays when the water clock moves
    the hold factor: scale `exp(lnd·Δf)` from where the decay was (its own
    two-term series) rather than calling `exp` per partial per update.
  - Voice parameters are state, so prefer shared atomics/APVTS over queued
    events; an override per stone is a *copy* of the shared voice (a slot
    index), and switching it on or off mid-note must reach a ringing stone at
    the next block.
  - The block-splitting loop (water → hold tick → voices) must always advance:
    clamp the segment end so a tick that lands at or behind the cursor cannot
    spin. Validate every float → int conversion on the voice path (strike
    sample offsets, parameter indices and targets).
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
- **Looper:** times as integer steps; ending a take sorts in O(n + length)
  (counting sort); budget recorded gestures per block and stop firing into a
  full gesture queue — MIDI, OSC and camera sources can burst. Benchmark a
  combined worst case (looper burst + water burst + retune burst in one block).
- **Tuning:** stones must stay within audible, playable pitches (8 Hz to below
  0.45·fs); the page limits the range to C1–C8. A Scala importer (Phase 4)
  must decide how to treat out-of-order or ≥-period degrees.
