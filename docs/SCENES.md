# Scenes & Cues — architecture & usage

A **Scene** is a named snapshot of the whole *look* you can recall to reproduce exactly what was on
screen (and on the DMX/LED output) when you stored it. A **Cue** stores an arbitrary *subset* of
parameters and composes with other cues — firing it patches only those. Both can recall with a
**crossfade**. This implements the MadMapper "Scenes and Cues" model (cue-bank grid + fades).

> **Granular cues** (the grid, capture, triggers) are documented in the
> [Granular cues](#granular-cues-cue-bank-grid) section below; the Scene sections come first.

## What a Scene captures

A Scene stores the visible state, **not** the playing transport or rig wiring:

| Captured | Not captured |
|----------|--------------|
| `surfaces` (placement + content) | `timeline` (playhead / clips) |
| `fixtures` (patch, effects, segments — live `colorData` stripped) | `assets` (media library) |
| `globalBrightness` | `controllers` (output devices) |
| `groups` | `settings` (Art-Net/OSC/output config) |
| `scene3D` | |
| `projectorOutputs` (corner-pin / warp / soft-edge) | |

Every field beyond `fixtures`/`globalBrightness` is optional, so projects saved with the older
minimal Scene shape still load and recall (fixtures + brightness).

`fadeSec` is the per-scene **crossfade** time. On recall, fadeable numeric params (global brightness,
surface/fixture geometry, surface **opacity**, and effect speed/intensity) animate from their current
value to the scene's over `fadeSec`; discrete params (media, effectId, palette, booleans) snap.
`fadeSec = 0` recalls instantly. The fade runs render-free in the Stage frame pump
([transitions.ts](../src/renderer/services/transitions.ts) + [paramPath.ts](../src/renderer/services/paramPath.ts)),
so it never re-renders React. Per-surface **opacity** (`content.opacity`, set in the Inspector) enables
fade-in/out and crossfades.

> **Note:** video URLs inside captured `surfaces` and model paths inside `scene3D` are stored as
> absolute paths in the scene. Scenes are reliable within a project; they are not yet portable across
> project folders. (Top-level project save *does* relativize asset paths — scenes don't, by design,
> for the MVP.)

Type: `Scene` in [src/renderer/types.ts](../src/renderer/types.ts). Persistence is free: `scenes`
already rides in `buildProjectData`/`applyProjectData` and `ProjectData.scenes`.

## Creating & managing scenes

In the bottom dock → **Scenes & Cues** tab (next to Timeline,
[components/ScenesCuesPanel.tsx](../src/renderer/components/ScenesCuesPanel.tsx)):

- **Capture scene** (toolbar) — capture the current look as a new scene.
- **GO** — recall the scene (snaps the look back).
- **↻ Update** — re-capture the current look into the existing scene (keeps id/name/fade).
- **double-click name** — rename.
- **fade field** — store a fade time (inactive in this version).
- **OSC trigger** column — shows the ready-to-copy OSC address for each scene.
- **🗑** — delete.

## Triggering scenes

Scenes can be fired from three sources, all routed through the React-free `cueBus` singleton
([services/cueBus.ts](../src/renderer/services/cueBus.ts)) so trigger sources never touch React
directly. App subscribes once and resolves the request against the current scene list.

### 1. Manual
The **GO** button in the Scenes & Cues panel.

### 2. Timeline state machine (FSM)
The control-layer FSM ([services/stateMachine.ts](../src/renderer/services/stateMachine.ts), see
[TIMELINE.md](TIMELINE.md)) gains a new **state-entry action: `recallScene`**. Add it to a state in
the state-graph editor and pick a scene. When the FSM enters that state — via any trigger
(`atTime`, `onMarker`, `onClipEnd`, `afterDelay`, `manual`) — the scene fires. This lets a timed
show recall looks as it plays. The action stores the scene **id**.

### 3. OSC
Under the control prefix (default `/artlux`), resolve by scene **id or name**:

```
/artlux/scene/recall  <ref>     # ref = scene id OR name (string arg)
/artlux/scene/<ref>/go          # ref in the address (URL-decoded)
```

Routed in [services/oscController.ts](../src/renderer/services/oscController.ts) alongside the
existing `/transport/*` and `/state/*` controls.

## Flow

```
manual GO ─┐
FSM action ─┤→ cueBus.requestRecall(ref) → App.subscribeRecall → resolve id|name → recall (snap)
OSC ───────┘
```

## Granular cues (cue-bank grid)

A **Cue** stores a subset of parameters as dot-path **entries** (`globalBrightness`,
`surfaces.<id>.content.opacity`, `fixtures.<id>.rotation`, …; see
[paramPath.ts](../src/renderer/services/paramPath.ts)). Firing patches only those: fadeable numerics
animate, discrete params (media, effectId, palette, booleans) snap — so cues **compose** (a colour
cue + a geometry cue don't clobber each other).

### Cue banks
Cues live in a **grid** ([CueBankPanel.tsx](../src/renderer/components/CueBankPanel.tsx), in the
Scenes & Cues dock tab): **row 0 = Scenes**, **rows 1+ = Cues**, multiple **banks**. A **column**
header fires its row-0 scene if present, else every cue in the column (bottom-to-top). Persisted as
`cueBanks` in the project; opening a pre-cues project auto-migrates its scenes into Bank 1, row 0.

### Authoring (Live / Edit)
- **Live** mode: click a cell to fire it.
- **Edit** mode: click a cell to select it; in the cue inspector set name / **Fade** / transition
  (`smooth`/`linear`/`damper`/`none`) / restart-media, then **capture** params — pick a target
  (Global / a surface / a fixture) and click a parameter to snapshot its current value into the cue.
  Each entry can override the cue's fade/transition.

### Triggering cues
- **Manual:** Live-mode click, or a column header.
- **FSM:** a `fireCue` state-entry action (cue picker in the state-graph editor).
- **OSC** (under `/artlux`):
  ```
  /artlux/cue/fire <ref>            # ref = cue id OR name
  /artlux/cue/<ref>/go
  /artlux/cues/bank_<b>/col_<c>     # fire a column (bank id/name, 1-based column)
  ```

## Flow

```
manual GO / column ─┐
FSM action ─────────┤→ cueBus (requestRecall | requestFireCue | requestFireColumn)
OSC ────────────────┘     → App resolves id/name → commit target + start render-free fade
```

## Not in this version (future work)

Red-overlay edit mode (click any control in the Inspector/Stage to cue it — currently authored via
the capture picker); projector-output fades (corner-pin/warp); auto-play and cue/calendar schedulers;
MIDI/DMX trigger mapping; cross-project scene portability (asset-path relativization).
