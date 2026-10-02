# Prototype: the generative medium

Browser prototype of the instrument (see [CLAUDE.md](../CLAUDE.md)) — Phase 1
follow-ups, and the first of build phase 2's designed interface. A pond of
water you can watch, with tuned stones in it. You disturb the water; ripples
travel, reflect and meet; when a crest reaches a stone, the stone rings like a
water-struck bell at its pitch in the scale you've set. You don't pick notes
directly — the water does. A four-track tape records the sound itself. A
voice editor shapes what the stones sound like. No plugin here, and only two gestures (drop and drag).

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

**Tape** — a four-track tape machine beside the pond (styled after Dieter
Rams): it records the water's *sound* and plays it back fixed, like a loop
pedal — every pass the same, the one part that isn't the water. It records
the water, never another track, and always plays exactly what it recorded —
retuning never touches it — so you can lay a bassline, retune, add a melody,
retune, add harmonies. Each track up to 30 s. (Touch loops, which replayed
your touches into the water, are set aside for now.)
- Each track: **rec** starts a take, **finish** ends it and it plays; **dub**
  adds more on top (heard live once, replayed from the next pass); **mute**
  silences it and keeps its place; **stop** then **play** restarts it from its
  top; **clear** (tap twice) erases it. Stop, mute and clear fade (0.3 s);
  the loop wraps without a click; overdubs add up with no decay, so a
  much-overdubbed track gets louder. The lamp is solid while a track plays,
  blinks while it records, and goes dotted when muted; the reels turn while
  any track runs, and the counter follows the longest one.
- **level** sets the tape under (or over) the live water; **clear all** (tap
  twice) erases every track. Clearing never touches the water.
- Tracks have their own lengths, so they drift against each other.

**Beat** — **quantize** (off by default) pulls toward a beat grid — strength
from lean to snap (snap by default), swing, BPM and grid size:
- *the notes*: a struck stone can wait for the next grid point (never sound
  early). At full strength every note lands on the grid, like a sequencer —
  the water still picks which stones ring and how hard; lower, the water
  keeps more of its own time. The water itself is never delayed.
- *your touches*: a touch just before a grid point waits for it (a faint ring
  at your finger closes in until it lands); one just after lands at once.
  Drags flow: never delayed.
- *the tape*: a take starts on a beat and **finish** waits for the next beat,
  so each track is a whole number of beats of its own (3, 5, 7…) and they
  line up differently each time.

While quantize is on, the beat runs and the pond's rim pulses on it (brighter
on each bar's first beat). BPM and grid only appear when it's on.

**Look** — zen garden minimalism (CLAUDE.md, "Look and feel"): black and
white, Syncopate in wide-tracked capitals, the water in greys — light crests,
dark troughs — and the logo's concentric rings in the knobs, the reels and the
start screen. Syncopate is bundled in `fonts/` (Apache 2.0), so the page works
offline. On wide screens the tape sits beside the pond; on phones, under it.

**Knobs** — most controls are knobs: drag up or down (or sideways) to turn,
Shift for fine; double-tap to return to the default; arrow keys, Page Up/Down,
Home and End step them. On a computer, hover one for what it does. The tape's
level stays a fader.

**Water**

| Knob | What it does |
|---|---|
| flow | how fast ripples travel, from ~32 s to cross the pond (very slow drift) to well under a second; the whole water speeds up or slows down together, so the same gesture plays the same phrase faster or slower |
| water decay | how long the water keeps moving (shown in seconds at the current flow) |
| fine ripples | how long small, sharp ripples last |
| sensitivity | how much of the water the stones hear — and so how many notes a gesture makes and how long phrases last |
| splash | ringing stones send ripples of their own back into the water; chains always die out (the water never gives back more than you put in) |

**Stones** — **move stones**, then drag any stone to place it; placed stones
keep their place when you retune or randomize (which note each one holds
follows the scale: lowest stone, lowest note), and a stone dragged through
moving water rings as crests pass over it. **randomize** rearranges the stones you
haven't placed. **stones** sets how many: *all* (one per scale note in the
range, the default), fewer (spread evenly over the range, lowest and highest
kept) or more (every note gets one and the extras repeat notes evenly, so a
note can ring from two places). **spread** goes from gathered in loose clumps
to spread evenly over the whole pond. **release placed** (tap twice) frees the
stones you placed.

**Tuning** — scale (major, natural minor, dorian, major/minor pentatonic,
chromatic, maqam Rast), root, lowest and highest note (C1–C8), and the
reference pitch (A4 in Hz, 400–480 in this prototype; 440 and 432 one tap
away — the tuning core itself takes any frequency). The stones knob decides
how many stones share the scale notes in the range. Note names are relative
to A4 at the chosen reference (at 432 Hz, A4 is still labelled "A4"). Changing these retunes the stones; it
never touches the water. A stone still ringing keeps its old pitch until it's
next struck, then its old ring crossfades out over 100 ms.

**Voice** — what a struck stone sounds like. Every stone shares one voice;
**edit one stone**, then tap a stone, to edit just that one (the pond is quiet
while you pick; a tap away from every stone cancels and plays as usual):
**give it its own voice** (a copy of the shared one; it gets a white rim on
the pond, and the stone you're editing a dashed ring), **back to the shared
voice** undoes it, **back to all stones** returns the editor to the shared
voice. No presets. A stone's own voice belongs to its slot (stone 1 is the
lowest note): if a retune leaves fewer stones it's kept, hidden, and comes back
when the stones do — possibly on a different note.
- *Bell*: level, decay, tone (upper partials), clang (bar-like ↔ clangy
  partials), tick (the water touching the stone).
- *Strike*: dynamics (how much louder a hard strike is) and strike brightness.
- *Water-held sustain*: while the water around a stone keeps moving, its note
  decays more slowly; as the water calms it lets go. The water holds the note,
  never you.
- *Synth layer*: the **synth layer** knob (off until you raise it — raising
  it opens the rest), then **shape the synth layer**: two oscillators (sine →
  triangle → saw → square), osc 2's pitch and detune, their mix, a low-pass
  that follows the stone's pitch and opens with each strike (cutoff, resonance,
  filter envelope and its decay), attack and decay. No note-off: it fades on
  its own like the bell.

**Saved voices** — name the voice you're editing and **save voice** (the same
name **replace**s it). Each saved voice has **use** (puts it on the voice
you're editing; a stone that still follows the shared voice gets its own) and
**delete** (tap twice). They're kept in this browser; nothing ships in the list.

Edits reach stones that are already ringing. **… voice back to defaults**
resets only the voice the knobs show. **Volume** and **water knobs back to
defaults** are with the water; **show note names** is a dev aid, off by
default.

The output meter blinks when the limiter is working.

## Listening check 2 — what to evaluate

Listening check 1 passed ("it seems good"). Defaults are unchanged: with the
voice editor untouched you hear exactly the Phase 1c bell.

1. **Bell knobs:** try decay, tone, clang and tick. Is there a bell you like
   better than the default? Should any of them have a wider or narrower range?
2. **Strike:** turn dynamics and strike brightness down. With both at zero
   every strike sounds the same — does the water lose its say in *how hard*?
   Should those knobs have a floor?
3. **Water-held sustain:** turn it up and play — keep touching, since moving
   water is what holds a note. Do notes bloom and sustain while ripples cross
   their stones, then let go as the water calms? Does long playing with
   hold on keep getting louder or harsher (the output meter blinking)?
4. **Synth layer:** raise synth level. Does the bell + synth blend work, or
   does the synth bury the water's character? Try a slow attack (it can be up
   to 2 s): still the water playing, or a pad that ignores it?
5. While a note rings, sweep cutoff and synth level: smooth, or stepped?
6. High saw or square notes (above about C6): any metallic, inharmonic shimmer?
7. Synth decay doesn't shorten for high stones the way the bell's does. Do
   high synth notes ring too long?
8. **One stone's own voice:** give one or two stones their own voice. Does
   that feel like composing the pond? Is it clear on the pond which stones are
   which, and which one you're editing?
9. Give a stone its own voice, then change the scale so there are fewer
   stones, then more again. The voice belongs to the stone's slot, so it may
   come back on a different note. Right, or should overrides clear?
10. **Tapes:** record a phrase, let it loop, record another track. Does "a
    tape beside the pond" sit well with the water, or does fixed audio fight
    it? Overdub: useful?
11. A tape records only the water, never other tapes (so tapes can't be
    bounced together). Right, or should a tape be able to capture the whole mix?
12. Stop, mute and clear all fade over 0.3 s. Right length? Overdubs add up
    with no decay — should older layers fade a little each overdub pass?
13. With quantize on, tapes follow the loops' bar grid: a take starts on it
    and **finish** waits for the next bar line. Should tapes follow the grid
    at all — and if so, is the wait clear?
14. Tapes, loops and the water together: does it get too loud? **tape level**
    sets the tapes under (or over) the water. (The tape mix has a soft clip
    above 0.9; the blinking meter shows it.)
15. Did the voice editor pull you away from playing the water? Which knobs
    would you never touch mid-performance?
16. After shaping a voice, did you want to keep it for next time? (Answered:
    yes — now **save voice**.)
17. On the iPad/phone: are the voice and tape controls usable in the drawer?

**Since your check-2 notes (Phase 1d):**

0. **The synth layer** is now in plain view: the **synth layer** knob under
   water-held sustain. Raise it — does bell + synth work?

18. **Quantize, now felt:** turn it on (it snaps by default) and play to the
    pulsing rim. Do touches that wait for the beat feel like the water waiting,
    or like lag? Is the closing ring at your finger enough? At slow BPM on a
    1/4 grid a touch can wait up to 1.5 s — too long?
19. Touch and drag at once with quantize on: the drag starts moving the water
    while the touch waits for the beat, so the ripple lands behind your
    finger. Fine, or should the drag wait too?
20. Drags never snap, live or looped (a snapped drag became stutters on the
    grid). Right?
21. **Tapes on the beat:** with quantize on, record tapes of different numbers
    of beats (say 3 and 4). Do they line up in interesting new ways?
22. **Very slow flow** (down to ~32 s to cross): at the slowest, water decay
    stretches with it (time-lapse), so the pond can take many minutes to fall
    silent. Is that the drift you wanted, or should decay not stretch so far?

**Notes on the grid, and one looper (since your last notes):**

23. **Quantize at full strength:** do notes now squash into time like a
    sequencer? Find a sequence you like and record it to tape — does it hold together
    as a song part? Try lean (around 50%): does it sit between water and
    grid in a useful way?
24. A note that comes just after a grid point (within 12 ms) rings at once;
    any later and it waits for the next one — up to a whole grid step. Does
    that sound tight, or do some notes feel late?
25. **Tape:** the looper is now a four-track tape machine (touch loops set
    aside). Does it feel like an instrument you'd reach for? Anything a
    tape machine should have that it doesn't? With several tracks running,
    does the pond still feel like the instrument?
26. Turning quantize on now snaps notes as well as touches straight away
    (snap is the default). Should notes and touches share one strength and
    one default, or should notes start at lean?
27. At full strength, several crests on one stone within a grid step now
    ring as **one** note on the grid point, as hard as the hardest (one note
    per stone per step, like a sequencer). Right, or should each hit ring
    (stacking, sometimes damping)?
28. A stone glows when it's *heard*, which can be up to a grid step after
    the crest visibly passed it (1.5 s at 40 BPM on a 1/4 grid). Does the
    pond still read as the cause of the sound?
29. **The look:** black and white, wide capitals, grey water. Calm and zen,
    or too stark? Is everything still readable on the phone (the small
    hint text especially)? The light tape machine is the brightest thing on
    the page and now sits beside the pond (under it on a phone) — right?
30. **Knobs:** do they feel like an instrument? Easy to turn on the iPad
    (drag up/down; double-tap resets)? Any control that should stay a slider?
31. **Number of stones:** try fewer stones than notes (a sparse pond) and
    more (notes doubled in other places). Useful? Is "all" the right default?
    A stone's own voice and a hand-placed spot belong to its slot, so
    changing the count can move them to another note — fine, or should they
    follow a note?

### Decisions for Dash

- **What makes a stone ring.** Phase 1b's hypothesis — a crest whose peak
  passes a threshold — stands for now. It's isolated in one method
  (`Stones.detect`) so it can be swapped.
- **Re-strikes** — physically accurate (sometimes damping) or always adding.
- **Retunes** — a ringing stone crossfades its old pitch out over 100 ms when
  next struck; the alternative is to let the old ring decay under the new one.
- **Whether the water can move stones** (you can; the water can't, yet).
- **Saving voices** — yes (Oct 2026): your own, by name, in this browser.
- **Overrides on retune** — kept (Oct 2026); they belong to a stone's slot.
- **Tapes** record only the water (Oct 2026).
- **Stone count** is the performer's (Oct 2026): one per note by default, or
  any number.

### Provisional choices (not decisions)

- A 128 × 97 surface with free edges (reflections stay crests), stepped 1000
  times a second of water time, with an isotropic grid stencil so ripples are
  the same in every direction.
- By default one stone per scale note in the range; the stones knob sets any
  count up to 128.
- Each stone panned by its left–right position (range 0.2–0.8).
- Loops: 4 layers, up to 60 s each, 4096 gestures per layer.
- Tapes: 4 tracks, up to 30 s each (stereo, about 46 MB at 48 kHz), 0.3 s
  fades, 10 ms seam crossfade and overdub punch.
- Water-held sustain slows decay to at most 5% speed (it always ends), and
  measures the water at each stone against the ring threshold — so the
  sensitivity knob also changes how easily the water holds a note.
- Drops vary slightly (position, strength, size); most variation comes from
  the water already moving.

## Known quirks

- Pen pressure is often near zero at first contact, so pen drops can be weak.
- Gestures land at the next audio block and simulation step (≤ ~4 ms late).
- Very rarely the display shows a frame mixed from two consecutive frames.
- A very dense chromatic range at maximum splash and long bell decay can push
  into the limiter.
- A hard-driven pond sits in the limiter, with the meter blinking as normal rather
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

About four minutes; seven files (the voices CPU budget is a process of its own):

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
- `check-voices-cpu.mjs` — the voice engine's CPU budget, in its own process (a
  workload that costs 510 µs per block cold costs ~40% more once this suite has
  rendered its earlier sections, and that is not the engine's doing). Run by
  `check-voices.mjs`; also runs standalone.
- `check-tape.mjs` — the audio looper: a take records the instrument's output
  and plays it back fixed (every pass identical, and it does not follow the
  water as it sounds now); tapes never record another tape's playback; overdub is
  heard live once and replays from the next pass; mute, stop and clear fade
  rather than cut (restarts and clears mid-fade included); the loop seam is
  crossfaded; with quantize on, takes start on a beat and last whole beats of
  their own lengths; retuning never touches a tape; the status frame; bit-identical at
  block sizes 1…8192 and the same loudness over time at 44.1/48/96 kHz; limits
  and bad input; the whole path through the instrument (the knob, `EV_TAPE`,
  the frame); CPU.
- `check-looper.mjs` — loops replay every gesture at the same place each pass
  while each pass plays a different phrase; overdub, mute, stop/restart,
  clear and clear all; quantize snap/lean/swing and whole bars on a shared
  grid; a live touch waits for the next grid point (never sent into the past) and its copy replays where it was heard; identical at any sample rate and block
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
| `tape.js` | The audio looper: several tape tracks of the water's sound. |
| `bells.js` | One voice per stone: the water-struck bell and the synth layer; water-held sustain. |
| `instrument.js` | Everything for one audio stream; page events; visuals frames. |
| `water-worklet.js` | Runs the instrument on the browser's audio thread. |
| `ring.js` | Lock-free queue: page → audio thread. |
| `visuals.js` | Lock-free frames: audio thread → page. |
| `main.js`, `index.html` | The page: drawing, gestures, controls. |
| `fonts/` | Syncopate (Apache 2.0), bundled so the page works offline. |
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
- **Note quantize:** held notes as int64 stream samples (`std::floor` into
  int64 for the grid index; `((k % 2) + 2) % 2` is right for signed ints);
  one note per stone per grid point; a stone removed by a retune stays
  silent; a ring buffer avoids the `copyWithin` shifts (optional — both are
  bounded). Size the queue for the coarsest grid at lean strengths, where
  notes don't merge: 128 busy stones at 90% on a 1.5 s grid peak near
  8 × MAX_STONES, so the prototype holds 16 × MAX_STONES. A hit within the
  on-beat window after its stone rang on that grid point is the same note.
- **Quantize:** schedule a held touch by integer step (an `atStep` entry
  point), not by seconds (the JS round trip can land 1 ms late after ~75 min);
  hold at most half the gesture queue; record a copy only if the touch went
  into the water; a copy whose moment is still ahead (held past a loop's
  wrap) is skipped on its first pass.
- **Tapes:** positions (`now`, `origin`, `startAt`, `takeEnd`, `deadline`) as
  int64 sample counts with an integer `mod`; validate the track and action
  floats from the ring before any int cast. Preallocate the tape memory and the
  mix scratch in `prepareToPlay` and touch every page there (no first-write
  page faults on the audio thread); a sample-rate change reallocates off the
  audio thread and clears (or resamples) the tapes. Memory is 4 tracks × 30 s ×
  2 channels — 46 MB at 48 kHz but 184 MB at 192 kHz, too much for an iOS AUv3:
  cap tape memory in seconds × rate, store int16/half floats, or allocate a
  track only when armed (off the audio thread, handed over lock-free). A
  quantized take's gap is never zeroed in one block (it's cleared as the
  playhead passes); a restart mid-fade keeps the old tail fading. The grid
  release callback from `erase()` stays on the audio thread (bounded).
- **Tuning:** stones must stay within audible, playable pitches (8 Hz to below
  0.45·fs); the page limits the range to C1–C8. A Scala importer (Phase 4)
  must decide how to treat out-of-order or ≥-period degrees.
