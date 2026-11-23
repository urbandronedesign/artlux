# The 3D view as a workbench — views, multi-view, object snapping, a detachable view

**Status:** 🟨 **audit + plan, nothing built; owner decisions taken 2026-11-23 (§6)** — build phases 1→3
in r3f now; detaching waits for E4 (workaround A′ documented meanwhile). **Owner ask (2026-11-23):** *"now we will focus
on the 3D scene — start a plan in order to have snapping, multiview etc. like in Rhino 3D or Blender; I
need also the ability to detach the 3D view. Don't code: do the assessment and audit, then plan these
features."*

**Placement:** Core (`src/renderer/components/Simulator3D/`, `contexts/panels/scene3d.tsx`,
`services/scene3dQuality.ts`, `shared/protocol.ts` `Scene3D`). **Risk:** 🟧 medium for phases 1–3 (additive,
each with an off state that is today's code path); 🔴 for phase 4 (it collides with an owner decision —
read §5 before anything else).

**Read first:** [native-engine.md](native-engine.md) (E4 *deletes* the r3f `Simulator3D` — this plan is
shaped around that), [gizmo-precision.md](gizmo-precision.md) (step snapping, nudge, World/Object — all
shipped, and the constraint list this plan inherits), [dockable-workspace.md](dockable-workspace.md) (why the
3D view is one element at one position), [multiscreen-workspace.md](multiscreen-workspace.md) (the rejected
shape for moving a view between windows, and why).

---

## 0. The ask, mapped to what Rhino and Blender actually give an operator

| Feature | Rhino | Blender | ArtLux today |
|---|---|---|---|
| Orthographic views (Top/Front/Right…) | four-view layout by default | numpad 1/3/7, toggle ortho/persp (5) | ❌ one perspective camera |
| Several views at once | 4 viewports, maximise one (double-click title) | Quad View (Ctrl+Alt+Q), split areas | ❌ |
| Zoom extents / zoom selected | `ZE`, `ZS` | Home, numpad `.` | ⚠ `focusView.ts` frames the venue for the calibration seat only |
| Named views | `NamedView` | camera bookmarks / cameras | ⚠ `viewBus` capture/apply, used by calibration only; `Scene3D.viewFrom` = look through a projector |
| Navigation cube / axis gizmo | view cube (Rhino 8) | navigation gizmo (click an axis = that view) | ⚠ `GizmoHelper`/`AxisTriad`, display only |
| Display modes | Wireframe / Shaded / Rendered / Ghosted / X-ray per viewport | Wireframe / Solid / Material / Rendered, X-ray (Alt+Z) | ❌ (the calibration `ProjectorScene` has shaded/edges/wireframe) |
| Construction plane | CPlane per viewport, grid on it | grid follows the ortho view | ⚠ ground grid only (`GroundGrid`, 1-2-5 m ladder) |
| Step snapping (grid/angle) | grid snap, `Ortho` | increment snap | ✅ fixtures only (`scene3dSnap`, S, Ctrl inverts) — **models are not snapped** |
| Object snaps | Osnap bar: End, Near, Point, Mid, Cen, Int, Perp, Tan, Quad, Knot, Vertex, OnCrv/OnSrf | Vertex, Edge, Face (+ align rotation to target), Edge centre, Perpendicular, Volume; snap base Closest/Centre/Median/Active | ⚠ `vertexSnap.ts` (occlusion-tested vertex snap) — **calibration anchors only** |
| Place on surface, align to normal | `OnSrf` + `Orient` | Face snap + "Align rotation to target" | ❌ (no drop-onto-mesh) |
| Measure | `Distance`, `Angle` | Measure tool | ❌ |
| Detach a view to another screen | floating viewports | new main window | ❌ disabled by design ("Viewports stay in the editor for now") |

The useful reading for a **venue** tool, not a modeller: ArtLux places *fixtures and screens onto a venue
someone else modelled*. So the snaps that matter most are the ones that put a LED bar **on a wall, along an
edge, at a corner, centred on a beam** — vertex, edge, midpoint, face-with-normal — plus orthographic views
to check a row is straight. Curve snaps (tangent, quadrant, knot) have no ArtLux object to act on and are
out of scope.

---

## 1. Audit — what exists, with the parts this plan builds on

### 1.1 Architecture (the hard constraints)
- **One `<Simulator3D>`, one GPU context, never unmounted.** Lazy-but-sticky (`App.tsx:418-427`), drawn by
  `PersistentLayer` over the winning `ViewportSlot` by direct style writes (no portal), parked at −10000 px
  with a real size when hidden (a 0×0 canvas kills r3f's raycaster). Guarded: *only one `<Simulator3D>` mount
  site*, *the scene3d viewport id is declared once*, *persistent viewports are positioned, never reparented*.
- **Renderer:** WebGPU by default (`renderer3d.ts`), WebGL fallback with a badge, device-loss remount via
  `glEpoch`. The `gl` factory must stay **synchronous** (an async one left the canvas at 300×150). Three owns
  its own device; sharing the mapper's device renders black (closed in `webgpu-unified-device.md`).
- **Frame cap & render scale** are per-machine prefs (`scene3dQuality.ts`); a capped view runs
  `frameloop='never'` and is advanced by `FrameRateCap` — guarded *a capped 3D viewport hands its clock over*.
- **Anything WebGL-only is banned** (`gizmo-precision.md` constraint; several *draws on both backends* checks —
  drei `Grid` already failed on WebGPU and was replaced by `GroundGrid` LineSegments).

### 1.2 Camera & navigation
- r3f default **perspective** camera (`[0,1.2,3]`, fov 50), drei `OrbitControls makeDefault`
  (`Simulator3D.tsx:623, 785`). `AdaptiveClipping` sets near/far from the orbit distance (guarded).
- `viewBus.ts` already captures/applies `{position, target}`; `focusView.ts` frames the venue bounds;
  `ProjectorView` swaps pose+projection in place to look through a calibrated projector. **These three are the
  seeds of named views and zoom-extents** — they exist, they are just not offered to the operator.
- No orthographic camera anywhere in the editor scene. No view shortcuts.

### 1.3 Objects, picking, transforms
- Models (GLB, `.blend` re-exported to GLB; planes), fixtures as InstancedMesh bodies + one InstancedMesh of
  every LED, movers, GDTF meshes, beams, projector frusta, calibration markers, plugin overlays.
- Picking = r3f raycasts; **pick priority** (`pickPriority.ts`): backdrops yield to fixtures; fixtures are
  picked by their **body**. Box select (`MarqueePicker`) selects fixtures only; models are single-select.
- **Fixture gizmo** (`FixtureGizmo.tsx`): drei `TransformControls` on a centroid anchor, commits a **delta**
  from the grab basis (`gizmoDelta.ts`), live preview through the pointer-rate `fixturePreview` channel (never
  React state), one undo step per gesture. World/Object space (X), step snap (S, Ctrl inverts), nudge.
- **Model/plane gizmo:** its own `TransformControls`, **no snapping**, commits the absolute transform.
- **Arrange panel** (offset, turn, align, distribute, line, arc, fan — `services/fixtureLayout.ts`) and numeric
  Position/Rotation/Scale fields exist.
- **`vertexSnap.ts`** (174 lines): nearest visible mesh vertex under the cursor, 22 px capture / 70 px preview,
  Alt bypasses, occlusion-checked (guarded *vertex snap only takes a vertex the camera can see*), drawn by
  `SnapCursor.tsx`. Used only for calibration picks — **it is the prototype of the object-snap engine.**
- `three-mesh-bvh` 0.8.3 is installed (a drei dependency) and **unused** by our code.

### 1.4 Display
- Scene lighting panel (light gain, haze, beams, ambient env, grid, grid numbers), per-model visibility eye.
  No wireframe/X-ray modes in the editor view.

### 1.5 Already rendering the scene from another camera
`projectorDepth.ts` (depth from each projector into render targets), `projectorBake.ts`, `viewerCamera.ts`,
and the calibration plugin's **separate** `ProjectorScene.tsx` Canvas (595 lines, its own WebGL renderer, with
`shaded | edges | wireframe`). So the codebase already knows how to render one scene from several cameras —
but only offscreen or in a projector window, never as several on-screen views of the editor scene.

### 1.6 Size
`Simulator3D/` + `scene3d.tsx` + `scene3dQuality.ts` ≈ 8,200 lines; ~25 `verify:invariants` checks touch
the 3D view. Every phase below lists the checks it must keep green.

### 1.7 The decisive fact: E4 deletes this renderer
[native-engine.md](native-engine.md) §views (:128) and phase **E4 Views** (:300, 3–4 months): the 3D scene
moves into the Rust engine — *one scene, any number of cameras*, shown in the editor as a `sharedTexture`
frame on a canvas **with React overlays on top**, or as a **native window** on any screen; picking via a GPU
id buffer, gizmo drawn by the engine. It **deletes r3f `Simulator3D`**. Order (owner, 2026-11-20): E5 (done) →
E0–E4; E4 is the last engine phase.

**Consequence for this plan:** anything built *inside* the r3f renderer is thrown away at E4. Anything built
as **data + pure logic + DOM overlays** survives it. So every feature below is split into a
**renderer-independent core** (kept) and a **thin r3f adapter** (replaced at E4 by an engine adapter of the
same interface).

---

## 2. Design rule: a renderer-independent core, a thin adapter

```
            ┌──────────────── KEPT through E4 ────────────────┐      ┌── REPLACED at E4 ──┐
 operator → │ view model      snap solver      overlays (DOM)  │ ───▶ │ r3f adapter        │ → pixels
            │ (cameras, layout, (candidates,    (view labels,   │      │ (cameras, scissor, │
            │  named views,     ranking,        snap marker,    │      │  BVH queries,      │
            │  CPlanes, modes)  constraints)    measure, cube)  │      │  gizmo, picking)   │
            └──────────────────────────────────────────────────┘      └────────────────────┘
```

- **View model** (`services/view3d/`): pure TypeScript — a view is `{ id, kind: 'persp' | 'top' | 'front' |
  'right' | 'back' | 'left' | 'bottom' | 'named', pose, ortho half-height, display mode, cplane }`; a layout
  is `1 | 2h | 2v | 4` plus which view is maximised. Unit-testable with a throwaway `tsc` script, as
  DEVELOPMENT.md → Testing prescribes.
- **Snap solver** (`services/snap3d/`): given a cursor ray (or a moving object's base point), the enabled
  modes and a *geometry provider*, returns the best candidate `{ point, normal?, kind, label, sourceId }`.
  The provider is the adapter's job (CPU BVH now; engine query or a UI-side CPU copy later).
- **Overlays** are DOM over the canvas (view titles, snap marker + label, measure readout, view cube),
  positioned from the view model's projection — exactly the shape E4's embedded view expects (*"a
  `sharedTexture` frame on a `<canvas>`, with React overlays on top"*).

---

## 3. Phases

Each phase ships alone, is **off-by-default where it changes behaviour**, ships its usage docs in the same
commits (the documentation rule), and keeps the listed invariants green.

### Phase 1 — Views & navigation (one view, many cameras) · ~2–3 wk

> **Progress 2026-11-23 — items 1–3 built** (orthographic views with rotation locked, the view keys, zoom
> extents / zoom selected), checked in the packaged ArtLux Show on WebGPU and WebGL. The core is
> `services/view3d.ts` (renderer-free); the r3f adapter is `Simulator3D/ViewControls.tsx`. What the run
> found:
> - **An ortho view must be ENFORCED every frame, not placed once.** Placing Top from an effect lost the
>   first Perspective → Top switch: the camera kept the new up and zoom but ended at the perspective
>   camera's position and direction (an oblique "Top"); ortho → ortho held. The view now re-derives the
>   position from the orbit target along its axis each frame, after OrbitControls' update.
> - **GridLabels chose its reading side from where the camera STANDS** relative to the grid origin — a coin
>   toss for a camera straight above its target (the numbers came out upside down in Top). It now reads it
>   from the direction the camera LOOKS, falling back to the screen's up when looking straight down.
> - `screenScale.worldPerPixel` answers for an orthographic camera too, so the anchor markers and the snap
>   cursor no longer skip one. `window.__artluxView3d()` reports the live camera (read-only diagnostic).
> - Items 4–7 (clickable axis gizmo, named views, display modes, grid on the view plane — a side view shows
>   the floor grid edge-on today) are next.
1. **Orthographic views** Top / Bottom / Front / Back / Right / Left + Perspective, toggle ortho↔persp.
   - r3f: an `OrthographicCamera` swapped in as default; ortho zoom = half-height, not distance.
   - ⚠ `AdaptiveClipping` derives near/far from *orbit distance*, which means nothing in ortho — needs an
     ortho branch (near/far from the scene bounds), and the *near plane follows the orbit distance* check
     must learn about it. **Orbit rotate is locked in an ortho view (pan + zoom only), Rhino-style —
     owner decision §6.4.**
2. **Shortcuts** through the shortcut registry (`shortcuts/registry.ts`, so they are rebindable and land in
   the generated keymap): numpad 1/3/7 (+Ctrl = opposite), 5 ortho/persp, 0 = back to perspective; Home =
   zoom extents, `.`/F = zoom selected. Check collisions with the existing 3D keys (X world/object, S snap,
   arrows/PageUp nudge).
3. **Zoom extents / zoom selected** — generalise `focusView.ts` (venue bounds → any bounds: selection,
   fixtures, everything visible), animated, in persp and ortho.
4. **Clickable navigation gizmo** — make `GizmoViewport`/`AxisTriad` clickable (axis = that ortho view). Must
   work on WebGPU (`AxisTriad` is ours for exactly that reason).
5. **Named views** — save/recall/rename/delete, stored in the **project** (`Scene3D.views[]`, venue
   knowledge, travels with the show; distinct from `viewFrom`). Reuses `viewBus` capture/apply.
6. **Display mode per view** — Shaded (today) / Wireframe / X-ray (models semi-transparent, fixtures solid —
   the useful one for LED work behind screens). WebGPU-safe materials only; mode is per-view state.
7. **Grid on the view plane** — in an ortho view the grid lies in that view's plane (Top = XZ floor, Front =
   XY…). `GroundGrid` is the single writer of the grid frame; it gains a plane input.

*Docs:* 09-3d-scene.md (Navigate, new Views section), 15-keyboard-reference (generated). *Checks kept:* near
plane, both backends, memoized props, history (a view change is **not** an undo step — camera is not
document state; a named view save **is**).

### Phase 2 — Multi-view (Rhino four-view) · ~3–4 wk, starts with a spike
1. **Layouts:** single / two side-by-side / two stacked / four (Top, Front, Right, Perspective — Rhino's
   default). Maximise/restore one view (double-click its title, or a key). Active view = the one under the
   last click; it receives shortcuts.
2. **How — inside the ONE canvas.** Several `<View>`s scissored in a single `<Canvas>` (drei `View`, which
   exists in our drei 10.7.7), each with its own camera and controls. This keeps **one GPU context and one
   `<Simulator3D>`** — every single-instance invariant holds as written. Not several Canvases (that is a
   second context per view, the *halved frame rate* failure WORKSPACE.md describes).
3. **Spike first (2–3 days), because three things are unknown on WebGPU:** (a) drei `View`'s scissor path on
   `WebGPURenderer` (our history: drei `Grid` failed there); (b) r3f event routing per scissored view (pick
   priority, marquee, gizmo drags must hit the right view); (c) cost — 4 views ≈ 4× the draw calls; the frame
   cap and render scale must apply to the whole canvas, and hidden/minimised views must not render. Fallback
   if (a) fails: render each view through `setViewport`/`setScissor` in our own `useFrame` loop (the r3f
   adapter owns it; the view model is unchanged).
4. **Per-view state:** camera, display mode, grid plane, label (overlay). **Shared:** selection, gizmo (one
   gizmo, drawn in every view, draggable from any), snap settings.
5. **Where the layout lives:** per **machine/workspace** (it is how *this* operator likes to work — like the
   dock tree), not in the project. Named views stay in the project.
6. **Pointer-rate work stays out of React** (the `fixturePreview` rule): live gizmo preview must update all
   views from the same channel, not via state.

*Docs:* 09-3d-scene.md (Several views at once). *New check:* "multi-view stays in one canvas" (no second
`<Canvas>` under `Simulator3D/` besides the existing calibration exceptions).

### Phase 3 — Object snapping (Osnaps) · ~4–5 wk
1. **The snap engine** generalises `vertexSnap.ts` into `services/snap3d/` (core) + a geometry provider
   (adapter):
   - **Modes (v1):** Grid · Vertex/End · Midpoint (of an edge) · Edge (nearest point on an edge) · Face (point
     on a surface, **with its normal**) · Centre (of a face / of an object's bounds) · Origin & world axes ·
     **Fixture ends** (both ends of a LED bar, its centre — so bars chain end-to-end). **v2:** Intersection
     (edge×edge in view), Perpendicular, Rhino-style *SmartTrack*-lite (axis-aligned guides from the last
     snapped point).
   - **Ranking:** screen-space distance within a capture radius (today 22 px), then a mode priority
     (Vertex > Mid > Edge > Face), occlusion-tested as `vertexSnap` already is (guarded).
   - **Performance:** a **BVH per model** (`three-mesh-bvh`, already in node_modules) built once on load,
     off the frame — venue GLBs can be millions of triangles; edge candidates from the BVH's triangles near
     the ray, not from a global edge list. Must not stall the frame (budget: < 1 ms per pointer move on the
     RTX box; measure on a production build).
2. **Where snaps apply:**
   - **Gizmo drags** (fixtures *and* models — models gain snapping): the dragged selection's **base point**
     snaps to the target. **Base point = the point where the drag was grabbed** (owner decision §6.3,
     Rhino-like) — so the gizmo needs the grab point in world space at mouse-down, alongside the grab basis
     `gizmoDelta.ts` already records.
   - **Place on surface + align to normal** (the venue killer feature): drop a fixture/plane onto a wall —
     position from the Face snap, rotation from the normal (LED bar lies flat on the surface). Respects
     `fixtureKind.ts` (a *light* is placed in 3D only — fine; nothing here touches the 2D canvas).
   - **Measure tool** (distance, angle) uses the same snaps.
3. **UI:** an Osnap bar under the 3D header (Rhino-like toggles: Grid, End, Mid, Edge, Face, Centre, Fixture),
   ⚠ *the 36 px header must not grow* (gizmo-precision constraint) — so it is a second strip that only shows
   when snapping is on, or a popover from the existing magnet button. Marker + label at the cursor (DOM
   overlay). Modifiers keep today's meaning: **S** toggles, **Ctrl** inverts during a drag, **Alt** bypasses.
4. **Commits are unchanged:** still one delta per gesture through `gizmoDelta.ts`, one undo step, live
   preview through `fixturePreview` — snapping only changes *the delta*, which is why it can be added without
   touching the commit path (guarded *the fixture gizmo commits deltas*).

*Docs:* 09-3d-scene.md (Snap and nudge → Object snaps, Place on a surface, Measure). *New checks:* snap query
stays off React state; BVH built off the frame.

### Phase 4 — A detachable 3D view · decision first (§5)

---

## 4. Order and sizes

| Phase | Depends on | Size | Survives E4? |
|---|---|---|---|
| 1 Views & navigation | — | 2–3 wk | view model, named views, shortcuts, overlays: yes · ortho camera/grid code: rewritten as engine cameras |
| 2 Multi-view | 1 + WebGPU spike | 3–4 wk | layout model + overlays: yes · scissor code: replaced (E4 gives "any number of cameras" natively) |
| 3 Object snapping | 1 (2 helps) | 4–5 wk | solver, modes, ranking, UI: yes · BVH provider: kept UI-side or replaced by an engine query |
| 4 Detach | §5 decision | 0 (option A) to ~4 wk (option B) | see §5 |

---

## 5. Detaching the 3D view — the decision this needs

**What stands in the way is a decision, not a bug.** The owner decided on 2026-11-20 (native-engine.md
:349, :351, :827, open question 5 marked decided): *"GPU viewports stay docked in the editor window until E4.
Another process would duplicate the scene and every texture upload, a performance drop, and a same-process
window would still rebuild them on every move."* The tab menu says so today ("Viewports stay in the editor
for now", `DockRenderer.tsx:270-277`), and `verify:invariants` fails a panel window whose import graph holds
GPU code.

The options, honestly priced:

| Option | What it is | Cost | Verdict |
|---|---|---|---|
| **A. Wait for E4** | the engine draws the 3D view; a view is a native window on any screen at full refresh, or embedded; moving it rebuilds nothing | 0 extra; arrives with E4 (after E1–E3, months) | the adopted plan |
| **A′. Now, with what exists** | put the **editor window itself** on screen 2 with the 3D view filling it, and detach everything else (all 40 panels can leave since W5) to screen 1 | 0 — already possible; at most a "3D only" workbench layout | **recommended interim** |
| **B. Same-process child window, one renderer, two canvases** | `window.open` child in the editor's process; three's `CanvasTarget` (present in our three 0.184) lets the ONE renderer draw into a canvas in the child document; scene, textures and device shared | ~3–4 wk incl. a spike; still one main thread for every window (the reason the owner rejected multiscreen-workspace.md); thrown away at E4 | reverses the 2026-11-20 decision — owner call |
| C. Second process with its own scene | a panel window running its own r3f scene from the Show Host replica + streamed textures | duplicates every upload and the scene | rejected (that is the "performance drop") |
| D. Move the canvas DOM node | portal / `adoptNode` | loses the canvas contents, guarded against | rejected |

**Decided (owner, 2026-11-23): A′ now + E4.** No r3f detach work. Phase 1 documents A′ in 09-3d-scene.md
("the 3D view on its own screen": the editor window on that screen, the other panels detached to the first),
and the detachable 3D view is delivered **as part of E4**. Option B stays unbuilt unless the owner reopens
the 2026-11-20 decision.

---

## 6. Owner decisions (2026-11-23)

1. **Detach (§5): A′ now + E4.** No code now: the 3D view goes to another screen by putting the editor
   window there and detaching the other panels. A real detached 3D window arrives with E4. The 2026-11-20
   decision stands; option B is not built.
2. **Build phases 1–3 now** in r3f, with the §2 split (core kept, adapter replaced at E4).
3. **Snap base point = the point you grabbed** (Rhino-like): the point where the drag started is what snaps
   onto the target. Not Blender's "closest".
4. **Ortho views lock rotation** (Rhino): an orthographic view only pans and zooms; rotation happens in a
   perspective view.
5. **Multi-view layout is per machine/workspace**, like the dock tree. Named views stay in the project.
6. **v1 snaps = all four groups:** Vertex + Midpoint + Edge · Face + align to surface · Fixture ends +
   centre · Measure tool. (Grid already exists.)
7. **Order = the plan's:** Phase 1 views → Phase 2 multi-view → Phase 3 snapping.

---

## 7. Testing (per DEVELOPMENT.md → Testing; no unit runner)

- View model + snap ranking: throwaway `tsc`-checked scripts with fixed geometry (a box, a plane, a LED bar).
- Real app: the packaged Show build on the RTX box (both backends — `artlux.scene3dWebGL='1'` for WebGL);
  CDP screenshots per view; a 1M-triangle venue GLB for snap cost.
- Every phase re-runs `npm run verify` and the 3D checks listed in §1 (picking priority, near plane, one
  mount, both backends, gizmo deltas, preview channel, history).
