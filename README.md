# Water Synth (working title)

A performance instrument built on one idea: **you don't trigger sounds, you
disturb a medium.** A simulated surface of sound sits at rest; gestures inject
energy; it ripples, carries, and settles on its own terms.

- **Concept and design:** see [CLAUDE.md](CLAUDE.md) — the source of truth.
- **Getting set up and building:** see [docs/SETUP.md](docs/SETUP.md).

## Status
Pre-alpha. Phase 1: browser prototype of the medium.

## Formats
AU, VST3, and Standalone, with macOS first and Windows/Linux via CI. Built with
JUCE and CMake; the UI is a WebView (HTML/JS/WebGL).

## Layout
```
source/dsp/      portable DSP — no JUCE, no platform code, unit-tested
source/plugin/   JUCE plugin wrapper, parameters, MIDI, audio↔UI bridge
ui/              WebView interface source
prototype/       browser sketches of the medium
tests/           unit tests and offline render/analysis harnesses
tools/           scripts for rendering, benchmarking, validation
docs/            setup and design documentation
.claude/agents/  subagent definitions for AI-assisted development
```

## License
TBD.
