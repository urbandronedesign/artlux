# Archived plans (shipped & merged)

These implementation plans have **landed on `main`** and are kept here for reference/history. They are no
longer part of the active build queue — see [`../SEQUENCING.md`](../SEQUENCING.md#status-tracker) for the
per-wave record and [`../README.md`](../README.md) for the active plans.

| Plan | Shipped as |
|------|-----------|
| [cue-authoring-robustness](cue-authoring-robustness.md) | Wave 1 — array-safe param writes + per-entry fade/transition (also fixed a Stage crash) |
| [dmx-io-fidelity](dmx-io-fidelity.md) | Wave 1 — channelsPerPixel-correct Monitor + fixture-derived DMX-in universes |
| [asset-ops-safety](asset-ops-safety.md) | Wave 1 — non-destructive Collect-a-Copy + confirm/report guardrails |
| [headless-plugin-host](headless-plugin-host.md) | Wave 1 — `--headless` runs the full show engine + schedule (runtime-verified) |
| [fixture-segments-finish](fixture-segments-finish.md) | Wave 2 — segment gap/off (verified on-wire) + removed dead effect UI |
| [autopatch-collision-detection](autopatch-collision-detection.md) | Wave 2 — collision detector + opt-in reservation (Phase C split-brain deferred) |
| [docs-browser](docs-browser.md) | v0.21.0 — in-app detachable markdown viewer |
