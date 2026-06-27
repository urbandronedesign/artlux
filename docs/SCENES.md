# Scenes & Cues — architecture & usage

A **Scene** is a named snapshot of the *look* that you can recall on demand to reproduce exactly
what was on screen (and on the DMX/LED output) when you stored it. This is the MadMapper "Scenes"
concept, scoped to a Scene-list MVP. Recall is **instant** in this version (no crossfade yet).

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

`fadeSec` is stored per scene but **not applied yet** — it's reserved for a future crossfade engine.
The number field in the panel is intentionally dimmed to signal this.

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

## Not in this version (future work)

Crossfade/transition engine (use `fadeSec`); granular per-parameter cues + cue-bank grid; auto-play
and schedulers; MIDI/DMX trigger mapping; cross-project scene portability (asset-path relativization).
