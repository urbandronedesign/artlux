# Precise 3D fixture transforms — live preview, snapping, nudge, and an object/world gizmo

**Status:** draft plan, nothing built. **Owner ask (2026-08-11):** *"when I edit the fixtures LED in the
3D view the update is done after release for optimization purposes, but I would like a helper in order
to precisely move/rotate/scale my LED strip fixtures, and an object mode / world mode so the gizmo
aligns to the fixture when needed — without breaking the current state of the 3D viewer."*

The whole plan is written so that **the current behaviour is the floor**: every phase is additive, each
new control has an off state that is byte-identically today's code path, and the document is still
written **once per gesture** (one Art-Net-safe state change, one undo entry).

---

## 1. What the code does today

`components/Simulator3D/FixtureGizmo.tsx` mounts one `<TransformControls>` on an invisible `anchor`
group parked on the **centroid** of the selection. During the drag it moves only that anchor. On
`mouseUp` it reads the anchor, computes per-fixture updates, and calls `onCommit(updates)` →
`App.handleCommitFixture3D` → the fixtures array. Only *then* do `InstancedLeds` and `FixtureBodies`
rebuild their instance matrices (both keyed on a JSON layout signature).

That deferral is deliberate and must stay — pushing the fixtures array on every pointer move re-renders
the whole editor at pointer rate and re-runs `computeLedPositions` over *every* fixture per move (this
is the same rule `verify:invariants` already enforces for Stage drags). **The cost of it is that the
operator drags a handle and sees nothing move until they let go**, which is exactly why precise work is
impossible. The fix is not to commit earlier — it is to **preview without committing**.

### Three defects found while reading (fix these first, they are not features)

> **Step 0 shipped 2026-08-11.** Defects 1 and 2 are fixed; defect 3 is deferred to Phase 2's readout.
> The rotate bug was reproduced against three's own composition before the fix (a bar at yaw 30° dragged
> by 10° committed at **yaw 70°**) and is now held by the `verify:invariants` check *"the fixture gizmo
> commits deltas, not the anchor's absolute transform"*.

1. **Rotate double-applies a single fixture's own rotation.** [FixtureGizmo.tsx:62](../src/renderer/components/Simulator3D/FixtureGizmo.tsx#L62)
   parks `anchor.rotation` on `effectiveRot(f)` for a one-fixture selection, and
   [FixtureGizmo.tsx:96](../src/renderer/components/Simulator3D/FixtureGizmo.tsx#L96) then treats the
   anchor's **absolute** rotation as if it were the drag **delta**: `out = rotQuat * s.rot`, where
   `rotQuat` already contains `s.rot`. A fixture at yaw 0 is unaffected (identity), which is why this
   survived — a fixture at yaw 30° jumps to 60°+delta on the first rotate drag. **Verify in-app before
   fixing** (set a fixture to yaw 30, rotate 10°, read the inspector).
2. **W / E / R / Q are advertised and bound to nothing.** The toolbar tooltips say "Move (W)",
   "Rotate (E)", "Scale (R)", "Box select (Q)" ([Simulator3D.tsx:330-334](../src/renderer/components/Simulator3D/Simulator3D.tsx#L330-L334))
   and [docs/user-guide/09-3d-scene.md:25](../docs/user-guide/09-3d-scene.md#L25) tells the operator to
   press them — but there is **no `scene3d` scope in `shortcuts/registry.ts`** and no keydown handler
   anywhere that calls `setMode`. Only the buttons work.
3. **Scale is silently two different operations** and nothing says so: one fixture scales its own LED
   layout, many fixtures spread apart about the centroid (the comment explains it; the UI does not).
   Phase 2's readout is where this gets said out loud.

---

## 2. Phase 1 — live preview during the drag (no document write)

**Goal:** while the handle is held, the LEDs and bodies of the *selected* fixtures follow it, at frame
rate, with **zero React state changes and zero document writes**. Release still commits exactly once.

### 1a. Extract the delta maths into one pure function

New `components/Simulator3D/gizmoDelta.ts`:

```ts
export interface GizmoStart { id: string; pos: THREE.Vector3; rot: THREE.Euler; scale: number }
export interface GizmoBasis { centroid: THREE.Vector3; startQuat: THREE.Quaternion; startScale: number }

/** The SAME transform used for the live preview and for the commit. One code path, by construction. */
export function gizmoDelta(
  start: GizmoStart[], basis: GizmoBasis, anchor: THREE.Object3D,
  mode: 'translate' | 'rotate' | 'scale',
): Array<{ id: string } & FixtureTransform>
```

It is today's `onUp` body, with **one correction**: the rotation delta is
`deltaQ = anchorQuatNow * startQuat⁻¹` (world-space), never the anchor's absolute quaternion — that is
defect #1, and it is also what makes Phase 3 possible, because in local space the anchor *starts*
rotated on purpose. Likewise `spread = anchor.scale.x / basis.startScale`. Snapshot `startQuat` and
`startScale` in the existing `mouseDown` handler alongside `centroidRef`.

`FixtureGizmo` then becomes: `objectChange` → `preview.set(gizmoDelta(...))`; `mouseUp` →
`onCommit(gizmoDelta(...))` + `preview.clear()`. Nothing else changes.

### 1b. A render-free preview channel

New `components/Simulator3D/fixturePreview.ts` — a module singleton in the shape the repo already uses
for pointer-rate channels (`vertexSnap.ts`, `dmxSignal`):

```ts
let map: Map<string, FixtureTransform> | null = null;
let rev = 0;                       // bumped on every write; consumers compare and skip unchanged frames
export function setPreview(updates) { … rev++ }
export function clearPreview() { map = null; rev++ }
export function getPreview() { return map }
export function previewRev() { return rev }
```

**It must not import React.** Consumers are inside the `<Canvas>`, so they poll it in `useFrame` and
early-out on an unchanged `rev` — cheaper than a subscription and impossible to turn into a re-render.

### 1c. Consumers rewrite only the affected instances

- **`InstancedLeds`** already builds `indexToFixture`; also build `offsetByFixture: Map<id, {start, count}>`
  from the same loop. A `usePreviewInstances(meshRef, …)` hook then, per changed rev, recomputes
  `computeLedPositions` **for the previewed fixtures only** (a synthetic `Fixture` = the real one with
  the previewed `position3D`/`rotation3D`/`scale3D` merged) and writes just that index range.
- **`FixtureBodies`** does the same for one instance per previewed fixture (always cheap).
- **`MoverBodies` / `GdtfFixture`** get the same treatment so a selected *light* previews too — GdtfFixture
  is a plain group, so it just writes `group.position/quaternion` in `useFrame`. The gizmo already moves
  lights; leaving them un-previewed would be a worse inconsistency than not shipping the preview.
- **`FixtureLights` / `Beams`** are deliberately **not** previewed: they read the committed fixtures and
  a beam swinging at pointer rate is a fill-rate cost with no placement value. Say so in a comment.

**Two traps to respect:**
- `computeBoundingSphere()` is O(instances) and must **not** run per preview frame. Run it once when the
  preview clears (the committed layout effect already does it). Picking during a drag is not a thing.
- If React re-renders mid-drag for an unrelated reason, the committed layout effect rewrites the whole
  buffer — the next `useFrame` re-applies the preview on top, so this self-heals rather than flickering.

### 1d. The budget guard + the escape hatch

- If the previewed selection exceeds ~20 000 LEDs, preview **bodies only** and log once. A row of bars is
  the real case; a 30k-pixel selection dragged as one is not, and the bar preview still shows the move.
- New per-machine pref `scene3dLivePreview` (default **on**) in `services/scene3dQuality.ts`, exposed in
  *Preferences ▸ GPU rendering* next to render scale / FPS cap. Off = today's code path exactly. This is
  the "did the new thing break the viewport" answer an operator can reach without a build.

---

## 3. Phase 2 — the precision helpers

### 2a. A live readout in the viewport header

The header is reserved chrome (nothing paints over the canvas — keep that). Add a right-aligned readout
that appears **only while dragging**:

```
Δ 0.250  0.000 -1.125 m   ·   |Δ| 1.152 m        (translate)
Δ yaw 15.0°  pitch 0.0°  roll 0.0°                (rotate)
spread ×1.250  ·  4 fixtures                      (scale, multi)
scale ×1.250  ·  LED run 1.20 → 1.50 m            (scale, single — names the two behaviours)
```

Implemented as a tiny `<GizmoReadout>` that subscribes to the preview channel and writes
`ref.current.textContent` directly — **no `setState`**, per the repo's render-free-live-channel rule.
Absolute anchor position on a second line, so "where is it now" is answerable without the inspector.

### 2b. Snapping

`TransformControls` (drei 10 / three 0.184) takes `translationSnap`, `rotationSnap`, `scaleSnap` as
props — the whole feature is those three values plus a UI for them.

- Header: a magnet toggle + a compact step select (translate `0.001 / 0.01 / 0.05 / 0.1 / 0.25 / 1 m`,
  rotate `1 / 5 / 15 / 45°`, scale `0.05 / 0.1 / 0.25`). The visible step follows the active mode.
- **Hold `Ctrl` to invert snap for the duration of the drag** (the DCC convention). Implemented as a
  keydown/keyup listener mounted only while dragging, flipping one prop on one component.
- Persisted per machine (`scene3dSnap*` prefs), not in `Scene3D` — it is a tool setting, like render
  scale, and must not travel to the venue inside the project.
- Default **off**, so nothing changes until asked.

### 2c. Keyboard nudge — the actual "precise" tool

A rigger types numbers or taps arrows; they do not drag a 12 mm target. Add a **`scene3d` shortcut
scope** (`shortcuts/types.ts` + `registry.ts`) — this also fixes defect #2:

| id | default | action |
|---|---|---|
| `scene3d.modeTranslate/Rotate/Scale/Select` | `W` / `E` / `R` / `Q` | what the tooltips already promise |
| `scene3d.gizmoSpace` | `X` | toggle world ⇄ object (Phase 3) |
| `scene3d.nudgeLeft/Right` | `Left` / `Right` | ∓ step on world X |
| `scene3d.nudgeFwd/Back` | `Up` / `Down` | ∓ step on world Z |
| `scene3d.nudgeUp/Down` | `PageUp` / `PageDown` | ∓ step on world Y |
| `scene3d.toggleSnap` | `S` | magnet on/off |

- Step = the snap step (or 0.01 m when snapping is off). `Shift` ×10, `Alt` ÷10 — same convention as the
  projector warp nudge already in the registry.
- In rotate mode the arrows rotate about the world Y/X axis by the angle step instead.
- **One press = one `onCommit` + one `onRecordHistory`**, exactly like the warp nudge. No coalescing in
  v1; if held-key repeat proves noisy in undo, coalesce inside a 400 ms window in a follow-up.
- Scope is active when the 3D viewport is hovered/focused (the same gate the `timeline` scope uses), so
  arrows still belong to the timeline when the timeline is under the pointer.

### 2d. Numeric entry for a multi-selection (small, high value)

`FixtureLayout3DPanel` / `FixturePositionPanel` are single-fixture and absolute. Add, **only when 2+
fixtures are selected**, three "offset selection by" fields (X/Y/Z, and a rotate-about-centroid angle)
with an Apply button → one `onCommit` array → one undo step. This is how a row of bars gets moved
exactly 250 mm, and it reuses the Phase-1a delta function with a synthetic anchor.

---

## 4. Phase 3 — object (local) vs world space

- `Simulator3D` gains `space: 'world' | 'local'`, defaulting to **`'world'` = today's visible behaviour**
  (drei's default is world, so the handles are world-aligned today even for a single fixture). Persisted
  per machine (`scene3dGizmoSpace`), toggled from a header button (globe / cube icon) and `X`.
- `FixtureGizmo` takes `space` and:
  - passes it straight to `<TransformControls space={space}>`;
  - orients the anchor accordingly — `'local'` → `anchor.quaternion` = the **active** fixture's rotation
    (`selectedFixtureId`, else the first of the selection); `'world'` → identity. Multi-selection in local
    space therefore behaves like Blender's *median point + active object orientation*: pivot on the
    centroid, axes from the active fixture. That is what "align the gizmo to my fixture" means for a row
    of bars angled across a truss.
- **This only becomes correct once defect #1 is fixed**, because a local-space anchor legitimately starts
  rotated and the commit must read a delta, not an absolute.
- The pivot stays the centroid in both spaces. A separate *pivot* selector (centroid / active / world
  origin) is a plausible follow-up and is deliberately **not** in this plan.

---

## 5. What must not break — the checklist to run before committing

- `npm run verify` clean (invariants + docs + typecheck).
- **Commit is still one array on release.** One drag of ten fixtures = one state change, one undo entry.
- **No React state at pointer rate.** The preview channel and the readout write outside React entirely.
- **No new rAF in a component** — everything runs in the existing `useFrame` inside the Canvas (the
  frame-engine decoupling rule is about the *output* loop, and this touches none of it).
- **Picking still works after a drag**: `computeBoundingSphere()` after the final rewrite in both
  `InstancedLeds` and `FixtureBodies`; `LED_PICK` userData untouched; `pickPriority` unchanged.
- **Still exactly one `<Simulator3D>` mount**, and the header additions must not grow the 36 px bar
  (h-9) — it is a fixed-height dock chrome. Check the **dockable** path *and* the fallback shell.
- **WebGPU path**: nothing added may be WebGL-only (`TransformControls` is renderer-agnostic; only
  `GizmoViewport` was not — see the existing `webgpuSpike` branch).
- Projector windows and the calibration scene import none of this; confirm no new import reaches
  `plugins/calibration/src/ProjectorScene.tsx`.

**New invariant checks to add** (`scripts/verify-invariants.cjs`), each encoding one of the above:
1. `fixturePreview.ts` imports no React and the gizmo commits only from a `mouseUp` listener.
2. Every instance-matrix rewrite path in `InstancedLeds`/`FixtureBodies` is followed by
   `computeBoundingSphere()` in the non-preview path.
3. `FixtureGizmo` computes its rotation from a start-quaternion delta (the regression that defect #1 is).

---

## 6. Docs — same commits, per the documentation gate

- `docs/user-guide/09-3d-scene.md` § *Transform a fixture in 3D*: live preview, the snap magnet + steps,
  the Ctrl invert, nudge keys, world/object, and the readout. Its W/E/R claim becomes true for the first
  time. Verbs and destinations, no panel coordinates.
- Help entries (`renderer/help/entries/scene3d.ts`): `scene3d.gizmo-space`, `scene3d.gizmo-snap`,
  `scene3d.gizmo-nudge`, `scene3d.live-preview` — the new controls need `helpId`s like the existing
  `ToolBtn`s have.
- The shortcut table in the guide is a `<!-- generated:x -->` block; `npm run docs:gen` picks the new
  `scene3d` scope up automatically. Do not hand-write it.
- `docs/LEDMAP.md` needs no change (geometry model is untouched); `docs/WORKSPACE.md` needs none (no
  context or panel added).

---

## 7. Suggested order

| Step | Work | Why first |
|---|---|---|
| 0 | ✅ **DONE** — rotate delta fixed + guarded, W/E/R/Q bound | Wrong today; Phase 3 depends on the fix |
| 1 | ✅ **DONE** — `gizmoDelta.ts` + `fixturePreview.ts` + LEDs/bodies preview | The actual complaint |
| 1b | ✅ **DONE** — movers/GDTF preview, budget guard, `scene3dLivePreview` pref | Consistency + the escape hatch |
| 2 | ✅ **DONE** — readout, snapping (+ Ctrl invert), nudge keys | "Precisely" |
| 2d | **NOT BUILT** — offset-selection numeric entry | Cheap, high value for rows |
| 3 | ✅ **DONE** — World/Object toggle (header button + `X`, per-machine) | Needs step 0 |

Each step is independently shippable and independently revertible. Nothing before step 3 changes what
the gizmo *does* — only what you can see and how finely you can drive it.
