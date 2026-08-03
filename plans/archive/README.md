# Archived plans (shipped)

These implementation plans are **complete** and are kept here for reference/history. They are no longer part
of the active build queue — see [`../SEQUENCING.md`](../SEQUENCING.md#status-tracker) for the per-wave record
and [`../README.md`](../README.md) for the active plans.

> **The whole Wave-3 audio subsystem is now merged to `main`.** The Wave-3 plans
> ([timeline-transport-and-audio-scoping](timeline-transport-and-audio-scoping.md),
> [asset-paths-scenes-and-audio](asset-paths-scenes-and-audio.md)) and the
> [native audio engine](audio-engine.md) (P0–P6) all landed via `wave-3-audio` (`4541743`, 2026-07-14) and
> the follow-on P6 merge (`f37f341`, 2026-07-15). P6's synthetic acceptance checklist is unrun (no
> multichannel hardware) and the JUCE licence election is still open — both tracked in
> [`../SEQUENCING.md`](../SEQUENCING.md#status-tracker), neither reason to keep the plans out of archive.

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
| [asset-paths-scenes-and-audio](asset-paths-scenes-and-audio.md) | **Wave 3 — merged (`wave-3-audio`, 4541743).** `mapAssetPaths` became per-container visitors over the top level, **every scene**, and the bed — a hard prerequisite for `Timeline.audio`. ⚠ Makes a saved project **forward-incompatible** with older builds. |
| [video-clip-audio](video-clip-audio.md) | **Shipped (`c2eb46e`)** — conform-first: a clip's audio track is conformed once to a WAV cache and the existing audio driver plays it on the clip's playhead, with **zero native changes**. Adds the `getVideoAudio` host service + `ClipAudioInspector`. *(This file has been in `archive/` since 2026-07-24 with no row here — added by the 2026-08-03 audit.)* |
| [audio-engine](audio-engine.md) | **Wave 3 — the whole native audio subsystem, merged (P0–P6).** JUCE + libspatialaudio N-API addon: the ambisonic bed, spatial UI, juce_dsp FX, the core automation-curve engine, and **P6** (device picker grouped by driver type, speaker commissioning, off-lock decoder rebuild, ASIO-behind-a-flag, and machine≠show persistence). `4541743` + `f37f341`, 2026-07-14/15. ⚠ P6 is a **synthetic pass** — venue verification + the JUCE licence election remain (see `../SEQUENCING.md`). |
