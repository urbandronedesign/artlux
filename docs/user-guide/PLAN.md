# ArtLux User Documentation — Plan

Goal: a **task/workflow-oriented**, **screenshot-illustrated** user guide covering **every UI
context** of ArtLux. English. Lives as Markdown in `docs/user-guide/`. Screenshots are real,
captured by driving the running app.

## Decisions (agreed)

| Topic | Decision |
|-------|----------|
| Format | Markdown files in `docs/user-guide/`, images in `docs/user-guide/images/` |
| Audience / depth | Task/workflow-oriented (controls covered in the context of what operators do) |
| Language | English only (FR can follow later, mirroring the in-app EN/FR help) |
| Screenshots | Real captures, produced by driving the running app over Electron CDP |
| Capture script | **Committed** at `scripts/capture-docs.cjs` for repeatable re-shoots |
| Demo project | Built/seeded at capture time into the scratchpad; **no binary assets committed** — only the resulting PNGs |
| Hardware contexts | Capture the real panels + add an explicit "live preview needs a connected X" note |
| Existing `docs/USER_GUIDE.md` | Becomes the overview/index that links out to the per-context pages |

## Capture pipeline

1. `scripts/capture-docs.cjs` launches ArtLux dev build with `--remote-debugging-port=<port>`.
2. It connects via `puppeteer-core` (CDP, no Chromium download) and **seeds a demo project**
   programmatically (surfaces with video/image/effect content, a strip + a serpentine matrix
   fixture, a couple of timeline clips, a 3D plane, one projector output). Sample media is
   generated to the scratchpad at runtime so nothing binary lands in the repo.
3. For each context it sets the relevant UI state / clicks the tab, waits for paint, and calls
   `page.screenshot()` (or Electron `capturePage`) into `docs/user-guide/images/`.
4. Hardware-only contexts (NDI, Spout, Camera content, live LiDAR/OSC tracking, physical
   projector output, Calibration & Auto-Align camera workspaces) are captured as real panels;
   their live previews remain blank and the doc notes the device requirement.

## Page map (one page per context)

- `README.md` — overview, signal-flow mental model (Content → Surface → Fixture → Art-Net/sACN), 5-step first light
- `01-interface-tour.md` — title bar + menus, left/right panels, dock, status bar, Help panel
- `02-surfaces-and-content.md` — Stage, surfaces, every content source
- `03-fixtures.md` — Fixture Editor: geometry, pixel type, templates, wiring preview, ledmap
- `04-patching-and-routing.md` — auto-patch, Routing sheet, controllers, per-fixture overrides
- `05-color-effects-groups-scenes.md` — Inspector params, effects, groups, scenes, cue banks
- `06-timeline.md` — clips, tracks, markers, placing takes on a lane, state machine + graph editor
- `07-audio.md` — the Audio Bed mixer, the bed vs a scene's own audio (two clocks), spatial audio + FX, automation
- `08-projector-outputs.md` — Outputs panel, corner-pin align, Bézier warp, soft-edge, NDI out
- `09-3d-scene.md` — split-pane 3D, outliner, gizmos, models/planes
- `10-calibration.md` — Calibration Wizard (structured light) + Auto-Align (markerless), camera workspace
- `11-projects-media-broadcast.md` — projects-as-folders, Media library, Asset Manager, broadcast mode
- `12-preferences-monitoring.md` — Preferences tabs, DMX/OSC Monitor, Prometheus/Grafana metrics
- `13-tracking.md` — LiDAR (OSC) / camera (MediaPipe) / Augmenta tracking sources, blobs in 3D, trigger zones + combinations, record/replay takes
- `14-show-state-machine.md` — the project state machine: states over scenes, triggers, hold-at-end + requireEnd, cold-start, the desktop Show context + tablet remote + OSC
- `15-keyboard-reference.md` — consolidated keyboard & mouse reference

> **Added after the initial v0.17.0 pass (app v0.24.0):** chapters **13-tracking** and
> **14-show-state-machine** were written to close the tracking + interactive-show gap; the keyboard
> reference moved 13 → 15. Their prose is complete, but their **screenshots are pending capture** —
> each figure is a `<!-- TODO screenshot: … -->` placeholder to be shot via `scripts/capture-docs.cjs`
> (the demo project's seed needs an OSC blob feed / trigger zones / a small state graph to populate
> the tracking + state-graph panels).

## Per-page template

1. **What it's for** (1–2 lines).
2. **Annotated/clean screenshot(s)** with a figure caption.
3. **Walkthrough** of the controls in the order an operator uses them.
4. **Tips / gotchas / troubleshooting** for that context.

## Execution order

1. Build `scripts/capture-docs.cjs` + demo-seed logic; verify the app launches and CDP connects on this machine.
2. Capture the full software-only context set; eyeball the PNGs.
3. Draft pages 00–12 against the captured images, reusing accurate prose from the existing
   `USER_GUIDE.md` and the internal `docs/` where correct.
4. Rewire `USER_GUIDE.md` into the overview/index; link the guide from `README.md`.
5. Re-run capture once at the end so every shot matches the shipped v0.17.0 UI.
