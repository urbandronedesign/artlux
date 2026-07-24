# ArtLux User Guide

ArtLux is a professional **addressable‑LED pixel‑mapping console**. You point a *content source*
(a video, image, live camera, network stream, or built‑in effect) at one or more *surfaces*, lay
your LED *fixtures* over those surfaces, and ArtLux samples the picture per‑pixel and streams it to
your hardware over **Art‑Net** or **sACN / E1.31**. The same rig can also drive video **projectors**
with corner‑pin / warp, run a video **timeline**, and be previewed in a true‑to‑venue **3D scene**.

This guide is **task‑oriented and illustrated** — every screen ("context") of the app has its own
page with a screenshot and a walkthrough of what each control does and when you'd use it.

> Screenshots are captured from a small built‑in demo project (two surfaces, a strip + a matrix
> fixture, a timeline, a 3D scene and an output) so the panels look the way they will in real use.

---

## The mental model — read this first

The signal flows in **one direction**:

```
Content source  →  Surface  →  Fixture  →  Art‑Net / sACN  →  your controller
                              ↘  Projector output (corner‑pin / warp)
                              ↘  3D scene preview
```

- A **surface** is a rectangle on the 2D stage that shows **one** piece of content.
- A **fixture** is your physical LED product (a strip, a matrix panel…). You place it on the stage
  *over* a surface and link it to that surface; each LED samples the color underneath it.
- The same fixtures can be sent to LED hardware **and** to a video projector, and arranged in 3D.

Keep that order in mind and everything follows: **no surface → nothing to sample; surface but no
fixture linked → nothing goes out; fixture linked but content is *None* → it stays black.**

![The ArtLux main editor](images/00-main-editor.png)
*The main editor: left panel (Scene/Media), the 2D Stage, the 3D Scene split pane, the Inspector on the right, and the dock along the bottom.*

---

## First light in 5 steps

1. **Add a surface** — left panel ▸ *Surfaces* ▸ **+**. A cyan rectangle appears on the Stage.
2. **Give it content** — select the surface and pick a type in the Inspector's *Content* grid
   (Video, Image, Effect, Camera…). See [Surfaces & content](02-surfaces-and-content.md).
3. **Add a fixture** — open the **Fixture Editor** dock tab ▸ **Add fixture** (or build a Matrix in
   the *Geometry* card). See [Fixtures](03-fixtures.md).
4. **Place & link it** — drag the fixture over the surface; set the Inspector's *Mapping ▸ Surface*.
5. **Send output** — **Preferences ▸ DMX Output**: pick Art‑Net/sACN, set the target IP, enable
   output, then **Auto‑patch**. See [Patching & routing](04-patching-and-routing.md).

Save with **Ctrl/Cmd+S**.

---

## Contents

| # | Page | What it covers |
|---|------|----------------|
| 1 | [Interface tour](01-interface-tour.md) | The title bar, panels, dock, status bar, Help & About |
| 2 | [Surfaces & content](02-surfaces-and-content.md) | The Stage, surfaces, and every content source |
| 3 | [Fixtures](03-fixtures.md) | The Fixture Editor: geometry, pixel type, templates, wiring, ledmap |
| 4 | [Patching & routing](04-patching-and-routing.md) | Auto‑patch, the Routing sheet, controllers, overrides |
| 5 | [Color, effects, groups & scenes](05-color-effects-groups-scenes.md) | Inspector params, effects, groups, scenes, cue banks |
| 6 | [Timeline](06-timeline.md) | Clips, tracks, markers, Takes, the state machine |
| 7 | [Audio](07-audio.md) | The Audio Bed mixer, the bed vs a scene's own sound, spatial audio, FX, automation |
| 8 | [Projector outputs](08-projector-outputs.md) | The Outputs panel, corner‑pin, warp, soft‑edge, NDI out |
| 9 | [3D scene](09-3d-scene.md) | The split‑pane 3D view, outliner, gizmos, models & planes |
| 10 | [Calibration](10-calibration.md) | The structured‑light & auto‑align projector calibration wizard |
| 11 | [Projects, media & broadcast](11-projects-media-broadcast.md) | Projects‑as‑folders, the Media library, Asset Manager, show mode |
| 12 | [Preferences & monitoring](12-preferences-monitoring.md) | Preferences, the DMX & OSC monitors, Prometheus/Grafana |
| 13 | [Tracking](13-tracking.md) | LiDAR / camera (MediaPipe) / Augmenta sources, blobs in 3D, trigger zones, takes |
| 14 | [Show / state machine](14-show-state-machine.md) | The Show graph over scenes: states, transitions, hold, cold‑start, Show context + tablet |
| 15 | [Keyboard & mouse reference](15-keyboard-reference.md) | Every shortcut, by context |

For engine internals and protocol details, see the other files in [`docs/`](../) (ARCHITECTURE,
SURFACES, OUTPUTS, LEDMAP, NDI, TIMELINE, ASSETS, CALIBRATION, OSC, MONITORING).

---

*Screenshots in this guide are produced by `scripts/capture-docs.cjs`, which launches the app,
loads a deterministic demo project, and re‑shoots every panel — so they can be refreshed on each
release with one command.*
