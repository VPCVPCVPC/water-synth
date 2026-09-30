# Setup, Workflow, and Packaging

A step-by-step guide to running this as a real software project: where the code
lives, how to work with Claude Code and its agents, how to test, and how to ship
installable plugins for every major DAW and OS.

Target: **macOS + Logic Pro first**, cross-platform from the same codebase.

---

## 1. Install the toolchain (macOS)

1. **Xcode** from the App Store, then open it once to accept the license.
2. **Command line tools:** `xcode-select --install`
3. **Homebrew:** https://brew.sh
4. **Build tools:** `brew install cmake git git-lfs`
5. **Node.js** (for the WebView UI build): `brew install node`
6. **Claude Code** — in the Claude desktop app's Code tab, or the CLI.
7. **Logic Pro** — your listening environment.
8. **JUCE AudioPluginHost** — a lightweight host for fast testing without
   launching Logic. It builds from the JUCE repo (`extras/AudioPluginHost`).
9. **pluginval** (Tracktion) — automated plugin validation. Download the release
   binary and keep it in `tools/`.

Windows later: Visual Studio (Desktop C++ workload), CMake, Git, Node.
Linux later: gcc/clang, CMake, Ninja, and the JUCE dev packages (ALSA, X11, FreeType).
You do not need those machines — see CI in section 7.

---

## 2. Create the project

```bash
mkdir -p ~/Projects && cd ~/Projects
# unzip the starter repo here, so you end up with ~/Projects/water-synth
cd water-synth
git init
git add .
git commit -m "Project concept, agents, and structure"
```

Put it on GitHub early (private is fine). It's your undo button, your CI trigger,
and how other developers will eventually read the project.

```bash
gh repo create water-synth --private --source=. --push
# or create it on github.com and: git remote add origin <url> && git push -u origin main
```

### Where the code lives

| Path | What goes there | Rule |
|---|---|---|
| `source/dsp/` | The medium, gestures, phases, tuning engine | Pure C++. No JUCE, no platform code. Must compile and be tested on its own. |
| `source/plugin/` | JUCE processor/editor, parameters, state, MIDI, audio↔UI bridge | Plumbing only. No sound design decisions here. |
| `ui/` | WebView interface: HTML/CSS/JS/WebGL | Built to `ui/dist`, embedded in the plugin binary. |
| `prototype/` | Browser sketches of the medium | Throwaway-friendly. Never shipped. |
| `tests/` | Unit tests, render harness, analysis scripts | Every DSP change lands with a test. |
| `tools/` | Scripts: render, benchmark, validate, package | Anything you'd otherwise retype. |
| `docs/` | This file and future design notes | For humans arriving later. |
| `.claude/agents/` | Subagent definitions | Committed, so they improve over time. |

**The one structural rule that matters:** `source/dsp/` never knows it's in a
plugin. That's what makes it testable offline, portable across OSes, and
reusable later in a standalone app, an iOS build, or even WebAssembly.

### Getting JUCE

Don't copy JUCE into the repo. Let CMake fetch a pinned version, so any
developer (or CI machine) gets the identical toolkit:

```cmake
include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG <pin-a-specific-release-tag>)
FetchContent_MakeAvailable(JUCE)
```

Ask Claude Code to write the full `CMakeLists.txt` with
`juce_add_plugin(... FORMATS AU VST3 Standalone ...)`, a unique plugin code and
manufacturer code, and the WebView option enabled.

---

## 3. Working in Claude Code

Open the project folder and start a session from the repo root. Claude reads
`CLAUDE.md` automatically, so every session begins grounded in the concept.

### The loop that works

1. **Ask for a plan before code.** "Read CLAUDE.md and propose a plan for the
   browser prototype of the medium. Don't write code yet."
2. **Read the plan and push back.** This is where your judgment matters most and
   where mistakes are cheapest to fix.
3. **Approve, then let it build.** It writes files, compiles, reads errors, and
   fixes them without you copy-pasting.
4. **Commit at every working state.** `git commit` after anything that builds and
   sounds acceptable. If a session goes sideways, you `git reset` instead of
   untangling it.
5. **One milestone per session.** Start fresh (`/clear` or a new session) between
   tasks. Long sessions drift.
6. **Listen before moving on.** Nothing is done until you've played it.

### Using the agents

Five specialists live in `.claude/agents/`. Claude delegates to them
automatically when a task matches, and you can call them explicitly:

- `dsp-engineer` — the medium, gestures, phases, erosion, cycle.
- `tuning-engineer` — scales, cents, maqam/shruti, Scala import, reference pitch.
- `plugin-engineer` — JUCE, CMake, formats, parameters, MIDI, build errors.
- `ui-engineer` — WebView interface, water visuals, XY gesture input.
- `realtime-safety-reviewer` — read-only audit of audio-thread safety.
- `concept-keeper` — read-only check that the work still matches the design doc.

Explicit delegation looks like:

> "Use the tuning-engineer subagent to implement Scala .scl import, with tests."

> "Use the realtime-safety-reviewer subagent to audit everything reachable from
> processBlock, then have plugin-engineer fix what it finds."

Run `/agents` to view, edit, or add subagents. Add one whenever you notice
yourself giving the same instructions a third time.

**Milestone ritual** — run these two before you call anything finished:
`realtime-safety-reviewer`, then `concept-keeper`. One catches clicks and
dropouts; the other catches the instrument quietly turning into a normal synth.

### What agents can't do
They can't hear, and they can't feel whether a gesture is satisfying. They will
confidently report success on something that sounds terrible. Treat every green
test as "not obviously broken," not "good." You are the ear, always.

---

## 4. Testing

Four layers, from fastest to slowest:

**1. Unit tests (`tests/`)** — Catch2 or GoogleTest fetched via CMake. Cover the
pure DSP: cents→Hz conversion, scale degree lookups, `.scl` parsing, energy
injection, damping. Agents run these constantly; they're the cheapest feedback.

**2. Offline render harness (`tools/render`)** — a small command-line program
that runs a fixed gesture script through the engine and writes a WAV. This is
the key piece of infrastructure: it lets an agent produce something measurable,
and lets you listen to a reproducible test case.

Automated assertions on those renders:
- **Settling:** energy decays to near-silence within N seconds.
- **Stability:** no NaNs or infinities; no runaway amplitude; stable at 44.1k
  through 192k and at parameter extremes.
- **Tuning accuracy:** FFT the render, find the peaks, assert they land within a
  few cents of the target frequencies. This is how tuning gets verified without ears.
- **CPU:** processing time per block, tracked over time to catch regressions.

**3. Plugin validation** — `pluginval` at a strict level catches host-compatibility
bugs before a DAW does. On macOS, `auval -v aumu <PluginCode> <ManufacturerCode>`
must pass or Logic won't load the plugin at all. Both belong in CI.

**4. You, in Logic.** The listening gate. Play it, try to break it, automate a
parameter, change the sample rate mid-session, load two instances, save and
reopen the project. Bugs live in exactly these places.

---

## 5. Making it work in every DAW

| Format | Hosts | Notes |
|---|---|---|
| **AU** | Logic, GarageBand | macOS only. Required for your own workflow. Must pass `auval`. |
| **VST3** | Ableton, Reaper, Cubase, Studio One, Bitwig, FL | The cross-platform default. Free licence. |
| **Standalone** | — | Handy for testing and live use without a DAW. |
| **CLAP** | Bitwig, Reaper, Studio One | Cheap to add via a JUCE extension; nice-to-have. |
| **AAX** | Pro Tools | Requires an Avid developer agreement and PACE signing. Skip unless needed. |

JUCE builds all of these from one codebase. The portability work isn't the
formats — it's the discipline of keeping `source/dsp/` free of platform code.

---

## 6. Packaging and distribution

**macOS**
1. Join the Apple Developer Program (annual fee) to get a Developer ID certificate.
2. Code-sign the `.component`, `.vst3`, and app.
3. **Notarize** with Apple and staple the ticket, or users get a scary warning.
4. Build an installer `.pkg` with `pkgbuild` / `productbuild` that places files in
   `/Library/Audio/Plug-Ins/Components` and `/Library/Audio/Plug-Ins/VST3`.

**Windows**
1. Get a code-signing certificate (these now require hardware-token storage,
   which adds cost and lead time).
2. Build an installer with Inno Setup or WiX; VST3s go in
   `C:\Program Files\Common Files\VST3`.

**Linux** — a tarball with a README is normal and acceptable.

**Housekeeping that saves pain later:** semantic version numbers wired into the
plugin metadata, a plugin/manufacturer code you never change (changing it breaks
every saved project), a factory preset set, and a changelog.

---

## 7. Continuous integration

A GitHub Actions workflow with a macOS/Windows/Linux matrix that builds all
formats, runs the unit tests, runs the render assertions, and runs pluginval on
every push. This is how you get "works on any OS" without owning the machines,
and it's how a future collaborator's pull request proves itself.

Ask `plugin-engineer` to write this once the plugin skeleton builds locally.

---

## 8. Making it readable for other developers

- `README.md` — what it is, how to build it, in under five minutes of reading.
- `CLAUDE.md` — the design doc. Doubles as the human onboarding document.
- `docs/` — architecture notes and decisions as they're made.
- Small, well-described commits. A build that works from a clean clone.
- Choose a licence before sharing the repo. It determines what anyone else may
  legally do with it, and "no licence" means "all rights reserved."

---

## 9. Suggested first three sessions

**Session 1 — Prototype the medium.** In `prototype/`, a browser sketch: a grid
simulation you can click and drag on, that ripples and settles. No plugin, no
tuning. Goal: does disturbance feel alive?

**Session 2 — Plugin skeleton.** CMake + JUCE, AU/VST3/Standalone, loads in Logic
and passes `auval` and `pluginval`, makes any sound at all. Boring and essential.

**Session 3 — Tuning engine.** Pure C++ in `source/dsp/tuning/`, fully unit-tested,
before it's wired to anything. Cents-based scales, reference pitch, `.scl` import.

Then: port the medium, wire tuning to its resonances, build the XY surface.
