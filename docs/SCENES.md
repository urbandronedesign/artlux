# Scenes & Cues — architecture & usage

A **Scene** is a named snapshot of the whole *look* you can recall to reproduce exactly what was on
screen (and on the DMX/LED output) when you stored it. A **Cue** stores an arbitrary *subset* of
parameters and composes with other cues — firing it patches only those. Both can recall with a
**crossfade**. This implements the MadMapper "Scenes and Cues" model (cue-bank grid + fades).

> **Granular cues** (the grid, capture, triggers) are documented in the
> [Granular cues](#granular-cues-cue-bank-grid) section below; the Scene sections come first.

## Scenes vs Cues (the relationship)

Scenes and Cues are two points on one spectrum: **how much of the show state a trigger touches.** A
Scene is a *photograph* of the entire stage; a Cue is a *sticky note* that changes only the things
written on it.

| | **Scene** | **Cue** |
|---|---|---|
| Stores | The **whole look** (all surfaces, every fixture's look, LED brightness, 3D scene, projector outputs) — *the look, not the rig* | An **arbitrary subset** of parameters (you pick which) |
| On fire | **Replaces** the look — exactly what you saw when you stored it | **Patches** only its parameters; everything else stays |
| Composition | All-or-nothing (one Scene = the full picture) | **Composable** — fire several and they layer |
| Grid home | **Row 0** ("SC") | **Rows 1+** |
| Capture | One click snapshots everything | Build it up: capture individual parameters |
| Edit | Re-capture to update | Per-entry add / remove / retune |

**What they share** — both are recallable states in the same cue-bank grid, on the same machinery:
- **Crossfade**: both carry a `Fade` time + transition curve. Fadeable numeric params (LED brightness,
  geometry, opacity, effect speed/intensity) animate; discrete params (media, effect, palette, on/off)
  snap. `Fade = 0` is instant.
- **Triggers**: identical for both — manual **GO**/click, the timeline **state machine**
  (`recallScene` / `fireCue` actions), and **OSC**.
- **Persistence**: Scenes live in `scenes[]`; the grid (banks, which scene sits in each row-0 cell,
  and all cues) lives in `cueBanks[]`. Both save with the project.

**When to use which**
- **Scene** — sequenced shows, safe known-good states, "make it look exactly like this again."
- **Cue** — live performance / layering: change just the LEDs, or just the projector media, or just a
  fixture, while everything else keeps running. Build looks live by stacking cues.
- **Both** — Scenes as the backbone (one per show section in row 0), Cues as overrides fired on top.

**How they combine in the grid**

```
        col 1     col 2     col 3
 SC  [ Intro  ][ Verse  ][ Drop  ]   ← row 0: Scenes (full looks)
 R1  [ proj A ][        ][ proj B ]  ← cues: only projector content
 R2  [ leds 1 ][ leds 2 ][        ]  ← cues: only LED colour/effect
 R3  [ geo X  ][        ][ geo Y  ]  ← cues: only surface/fixture geometry
```

A **column header (▼)** fires the column as a unit: **if row 0 of that column holds a Scene, the
Scene fires** (a complete recall); **otherwise every Cue in the column fires** (bottom-to-top),
combining those stems into one look. This is the key pairing — row-0 Scenes for "go to this whole
state," column Cues to assemble a state from independent parts without pre-baking every combination.

**Typical workflow**
1. Set up a look → capture a **Scene** in row 0 (the baseline for that section).
2. Add **Cues** in the rows below for what you'll tweak live (blackout, warm wall, a geometry move).
3. Give each a **Fade** time.
4. Run it: click in **Live** mode, fire whole **columns**, or drive it from the **timeline FSM** / **OSC**.

## What a Scene captures

A Scene stores the visible state (and, optionally, its **own timeline**), **not** the media library or
rig wiring:

| Captured | Not captured |
|----------|--------------|
| `surfaces` (placement + content) | `assets` (media library) |
| `fixtures` — **the LOOK half only, see below** (live `colorData` stripped) | `controllers` (output devices) |
| `globalBrightness` | `settings` (Art-Net/OSC/output config) |
| `scene3D` | `groups` (**rig structure — see below**) |
| `projectorOutputs` (corner-pin / warp / soft-edge) | `trackingZones` (the room, not the look) |
| `timeline` **(REQUIRED — a per-scene decoupled NLE)** | |

Every field beyond `fixtures` / `globalBrightness` / `timeline` is optional, so projects saved with the
older minimal Scene shape still load and recall (fixtures + brightness).

### ⚠ A recall restores a fixture's LOOK, never the RIG

The snapshot holds whole `Fixture` objects, but **a GO writes back only the look fields** — the mapping
rect (`x/y/width/height/rotation`), `surfaceId`, the standalone-effect params (`source`, `effectId`,
`paletteId`, `speed`, `intensity`, `segments`) and the authored `dmx` values. The split is owned by
`services/sceneLook.ts` and it is an **allow-list**: a new `Fixture` field is rig until someone says
otherwise.

Everything else is the rig and **survives the recall**: identity, `profileId`, the patch
(`universe`/`startAddress`/`controllerId`), the wiring (`ledCount`, colour order, ledmap) and the 3D
placement. **Membership survives too** — a fixture patched since the scene was stored is left alone
rather than deleted, and one deleted since is not resurrected.

Restoring the array wholesale is what this replaces, and it was not theoretical: because the state
machine recalls a scene on entering **every** state — including its initial one, on load — opening a
project could delete a head that was patched after the scenes were stored and revert the survivors to
the old addresses, within seconds, silently. Same lesson as `trackingZones`: project-scope data must not
ride a look snapshot.

`groups` is the same story with no look content at all — a `FixtureGroup` is `{id, name, fixtureIds}`.
It is no longer captured and is ignored on recall, so a group made after a capture is not deleted by the
next GO. That one bites hardest with lighting clips, which target a group **by id**: the clip stays on
the timeline, reads as correctly configured, and drives nothing.

> ### ⚠ `timeline` is REQUIRED. It was optional, and that shape was **deleted**.
> A Scene could once have **no** `timeline` and "fall back to the shared global one". That state was the
> root of **two automation-clock blockers** — a lane copied into a scene was retagged to the *scene* clock
> *and* shadowed the real base lane, so a house fade on `audio.master.gain` **snapped +9.6 dB on every GO
> and persisted to disk**. It was also never a feature: **nothing in the UI could create one.** It was
> deleted on **2026-07-14**, which makes two of the three writers that could break the invariant
> *structurally impossible*.
>
> **Opening an older project is safe** — the loader gives a timeline-less scene an **empty** timeline. It
> does **not** fall back to the global one, so a scene saved under the old shape recalls to a black output
> rather than silently playing the global timeline. Delete it, or give it content.

> **Per-scene timelines.** Every Scene owns its own `timeline`; recalling it **warm-swaps** the
> playback engine to that timeline. This is
> the seam that turns Scenes into fully decoupled *states* you author one at a time. Full design —
> engine pools, the current-scene binding, the preloader, and the authoring-loop UX — is in
> [SCENE-TIMELINES.md](SCENE-TIMELINES.md). (`buildSceneSnapshot` stays look-only, so **Update Scene**
> never overwrites a scene's timeline.)

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
[components/CueBankPanel.tsx](../src/renderer/components/CueBankPanel.tsx)):

- **Capture scene** (toolbar) — capture the current look as a new scene.
- **GO** — recall the scene (snaps the look back, and makes it the current edit target — see
  [SCENE-TIMELINES.md](SCENE-TIMELINES.md)).
- **🎬 Edit** — enter *author mode* on that scene's own timeline (binds the Timeline editor to it).
- **↻ Update** — re-capture the current **look** into the existing scene (keeps id/name/fade — and the
  scene's own timeline, which `buildSceneSnapshot` never touches).
- **double-click name** — rename.
- **fade field** — the scene's recall fade time, in seconds; a recall crossfades the look over it
  (`onUpdateSceneFade` → `fadeSec`; see the fade engine above). `0` snaps.
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
(`atTime`, `onMarker`, `onClipEnd`, `onTimelineEnd`, `afterDelay`, `manual`) — the scene fires. This
lets a timed show recall looks as it plays. The action stores the scene **id**.

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

### Pose cues — the lighting arm

A Cue has a second, optional arm: `lighting?: LightingCueEntry[]`, each
`{ poseId, groupId, fadeSec?, transition? }`. It fires a **stored look** at a **fixture group**, in
role space (pan in degrees, dimmer 0..1), with **no timeline involved** — which is the whole point:
pose keys are the *storage* of a light show and can only be scrubbed on a timeline, so firing a look
from the cue grid, the tablet, an OSC GO or a state's entry action needed a different verb. Both
models share one atom — a `NamedPose` on `ProjectData.lightingPoses` — so keys are the storage and
cues are the invocation.

It sits **between the lighting clip and the automation lane** in precedence: a fired cue beats a clip
that happens to be running, a drawn lane still beats the cue, your hand on a fader beats everything.
Clearing a cue is a **release**, not a write of zeros — whatever was underneath shows again. Details
and the rest of the semantics: [LIGHTING-SHOW.md](LIGHTING-SHOW.md) → *Pose cues*.

The arm is additive and optional, so an older build ignores it and still fires the cue's ordinary
`entries`.

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

<!-- audience:contributor -->

## Not in this version (future work)

Red-overlay edit mode (click any control in the Inspector/Stage to cue it — currently authored via
the capture picker); projector-output fades (corner-pin/warp); MIDI/DMX trigger mapping.

*(Since shipped, and no longer future work: wall-clock **schedulers** and a multi-project **broadcast
playlist** — now in `@artlux/plugin-show-control`, see [SHOW-CONTROL.md](SHOW-CONTROL.md); and portable
projects with asset-path relativization, see [ASSETS.md](ASSETS.md).)*
