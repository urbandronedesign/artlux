# Archived plans (shipped)

These implementation plans are **complete** and are kept here for reference/history. They are no longer part
of the active build queue — see [`../SEQUENCING.md`](../SEQUENCING.md#status-tracker) for the per-wave record
and [`../README.md`](../README.md) for the active plans.

> **Two of these are complete but not yet on `main`.** The Wave-3 plans
> ([timeline-transport-and-audio-scoping](timeline-transport-and-audio-scoping.md) and
> [asset-paths-scenes-and-audio](asset-paths-scenes-and-audio.md)) are done and fully tested, but they land
> **with the `wave-3-audio` branch** rather than ahead of it. They are archived because the *work* is
> finished, which is what this folder is for — not because the branch has merged. The status column says so.

| Plan | Shipped as |
|------|-----------|
| [cue-authoring-robustness](cue-authoring-robustness.md) | Wave 1 — array-safe param writes + per-entry fade/transition (also fixed a Stage crash) |
| [dmx-io-fidelity](dmx-io-fidelity.md) | Wave 1 — channelsPerPixel-correct Monitor + fixture-derived DMX-in universes |
| [asset-ops-safety](asset-ops-safety.md) | Wave 1 — non-destructive Collect-a-Copy + confirm/report guardrails |
| [headless-plugin-host](headless-plugin-host.md) | Wave 1 — `--headless` runs the full show engine + schedule (runtime-verified) |
| [fixture-segments-finish](fixture-segments-finish.md) | Wave 2 — segment gap/off (verified on-wire) + removed dead effect UI |
| [autopatch-collision-detection](autopatch-collision-detection.md) | Wave 2 — collision detector + opt-in reservation (Phase C split-brain deferred) |
| [docs-browser](docs-browser.md) | v0.21.0 — in-app detachable markdown viewer |
| [watchdog-relaunch-throttle](watchdog-relaunch-throttle.md) | Wave 0 — `minRelaunchGapSec` pacing (first relaunch instant, 2nd+ deferred-not-dropped) + the Preferences field |
| [show-control-tablet-parity](show-control-tablet-parity.md) | Wave 0 — tablet multi-bank + per-cue fire + Kick hard-cuts SSE |
| [timeline-transport-and-audio-scoping](timeline-transport-and-audio-scoping.md) | **Wave 3 — complete, lands with `wave-3-audio`.** Wave A: the bounded clock, a working Loop, Stop/Set-In/Set-Out, `onTimelineEnd`, scene-vs-global legibility (live-tested on hardware 2026-07-12). Wave B: the **show clock**, audio lanes, the mixer, audio on scenes/cues. It **supersedes P5** of `audio-engine.md`. |
| [asset-paths-scenes-and-audio](asset-paths-scenes-and-audio.md) | **Wave 3 — complete, lands with `wave-3-audio`.** `mapAssetPaths` became per-container visitors over the top level, **every scene**, and the bed — a hard prerequisite for `Timeline.audio`. ⚠ Makes a saved project **forward-incompatible** with older builds. |
