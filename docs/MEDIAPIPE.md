# MediaPipe pose tracking (`plugins/mediapipe`)

Camera-based people tracking as a **content/tracking source** — a webcam + Google MediaPipe
**BlazePose** replacing (or complementing) the LiDAR tracker. Each detected person becomes a
normalized position that maps onto a surface exactly like a LiDAR blob, so a show gets body-driven
interactive mapping with zero specialized sensors.

It is a **standalone, renderer-only first-party plugin** modeled 1:1 on `plugins/lidar-tracking`
(the canonical tracking-plugin template): a render-free pub/sub store, a content-source drawable, a
projector data+GPU channel, a 3D scene-viz overlay, and a debug panel — but fed by BlazePose instead
of OSC blobs. Inference runs **in the renderer via WebAssembly** (`@mediapipe/tasks-vision`) with the
WebGL **GPU delegate**; there is no native crate.

## How it fits together

```
webcam (getUserMedia <video>, poseCamera — plugin owns its own stream)
  → PoseLandmarker.detectForVideo() in a rAF loop            [poseEngine, MAIN window only]
  → per-person position (hip midpoint, else bbox centroid), y-flipped to bottom-left normalized
  → poseStore (render-free pub/sub, serializable snapshot)
       ├─ poseTracking  — greedy nearest-neighbour ids + One-Euro smoothing + prediction + trails
       ├─ ContentSourceProvider(MEDIAPIPE) → poseDrawable → GPU markers/skeleton/trails on the surface
       ├─ ProjectorChannel('mediapipe')   → snapshot → MessagePort → projector windows self-render
       ├─ SceneViz(mediapipeViz)          → camera-field markers in the 3D simulator
       └─ Pose Monitor panel + Preferences section (camera / model / delegate / max-people / confidence)
```

Inference lives **only in the main editor window** (`poseEngine` gates on `ctx.window`). Projector
windows never open a camera — they receive detection snapshots over the projector bridge and render
the markers themselves. The engine is **refcounted** by the content source's `acquire`/`release`: it
starts on the first `MEDIAPIPE` surface and stops when the last one goes away.

<!-- audience:contributor -->

## Files

| File | Purpose |
|---|---|
| `plugin.renderer.ts` | Activation — registers the content source, clip kind, projector channel, scene-viz, panel, settings. |
| `poseStore.ts` | Render-free pub/sub store of the latest `Detection[]`; `snapshot()`/`applySnapshot()` bridge. |
| `poseEngine.ts` | Webcam + `PoseLandmarker` WASM inference loop; offline asset load; graceful degrade; settings-driven restart. |
| `poseCamera.ts` | The plugin's own `getUserMedia` stream + device enumeration. |
| `poseTracking.ts` | Cross-frame id assignment (BlazePose gives none) + One-Euro smoothing + prediction + trails. |
| `poseRenderer.ts` | Shared compute: marker instances, trails, `#id`/skeleton overlay, orientation transform. |
| `posePass.ts` | Self-contained WebGL marker/trail/quad primitives (a copy of the LiDAR `blobPass`). |
| `poseDrawable.ts` / `poseProjector.ts` | Stage GL canvas / projector-FBO render of `MEDIAPIPE` content. |
| `PoseViz.tsx` | r3f scene overlay: calibrated floor + world-mapped markers; the camera-field panel (uncalibrated markers, the interaction area, the counted parts) — gated on `scene.mediapipeViz`. |
| `poseField.ts` | The camera-field panel's one mapping (image/area → scene), shared by `PoseViz` and the area's `toWorld()`. |
| `PosePanel.tsx` | Pose Monitor modal — live camera preview, status, fps, tracked count. |
| `PoseCalibration.tsx` | Pose Calibration modal — three tabs: **Interaction area** (`Scene3D.mediapipeArea`), **Floor (3D)** (`Scene3D.mediapipeFloor`), **Test**. Staged edits, one patch per Save, in-app confirms, camera binding, Retry. |
| `QuadPicker.tsx` | The four-corner picker both tabs use: true video aspect, live skeleton + part overlay, walk-the-corners capture, loupe, arrow-key nudge, homography grid, zones drawn back on the picture, inline validation. |
| `poseAreaMath.ts` | Pure geometry: quad validation, image⇄area homography, BlazePose → body parts (`handL/handR/footL/footR/head/body`). |
| `poseArea.ts` | The **tracking surface `POSE`** registered with `ctx.trackingSurfaces`: per-frame tagged points in area space for the trigger-zone engine, `acquire` (zones keep the camera running), camera-mismatch warning. |
| `poseHomography.ts` / `poseFloor.ts` | Image→floor homography (reuses `@/projector/homography` + a 3×3 inverse/multiply; `invert` returns **null** when singular) and foot-point / world-rectangle helpers. |
| `poseSettings.tsx` / `poseContentEditor.tsx` | Preferences section / per-surface inspector fragment. |
| `poseHost.ts` | Stashes `ctx.host` for non-React settings reads + a reactive settings hook. |

Core edits are minimal (persisted enum/fields stay core, behavior lives in the plugin):
`SourceType.MEDIAPIPE` + a `poseSkeleton` field (`renderer/types.ts`), `Scene3D.mediapipeViz`
(`shared/protocol.ts`), a picker button (`ContentEditor.tsx`) and menu item (`MenuBar.tsx`).
Plugin-local prefs live under `AppSettings.plugins.mediapipe` (no core field).

<!-- audience:operator -->

## Offline model + WASM assets (required)

`@mediapipe/tasks-vision` would fetch its WASM runtime + the `.task` model from a Google CDN per
session, which fails under Electron's offline/CSP posture. Assets are staged locally instead:

```bash
npm install                 # @mediapipe/tasks-vision ships the WASM runtime
npm run assets:mediapipe    # copies WASM + downloads pose_landmarker_{lite,full,heavy}.task
```

This populates `src/renderer/public/mediapipe/{wasm,models}/` (gitignored, large binaries). Vite
serves it at `/mediapipe/` in dev and copies it into `out/renderer/` for packaged builds (bundled by
electron-builder via `files: ["out/**/*"]` — no `extraResources` entry needed). `poseEngine` resolves
the base URL from `document.baseURI`, so the same path works in dev and packaged.

**If the assets are absent** the engine logs `[mediapipe] engine start failed — pose tracking
disabled` and no-ops (never crashes) — the app-wide native-degradation contract.

## Using it

1. `npm run assets:mediapipe` once, then `npm run dev`.
2. Select a surface → content type **MediaPipe**. Configure marker size / skeleton / IDs / trails /
   flip / rotate in the inspector.
3. Pick the camera + model in **Preferences ▸ Pose Tracking (MediaPipe)**.
4. Open **View ▸ Pose Monitor…** to see the live feed, fps, and tracked-people count.
5. Toggle **Camera pose markers (MediaPipe)** in the 3D scene panel for the simulator overlay.

## The interaction area → trigger zones → the show

> **Two calibrations, two jobs.** The **interaction area** (`mediapipeArea`) is where trigger zones live:
> any plane, no units, it fires the show. The **floor** (`mediapipeFloor`, [below](#floor-calibration--real-world-position-preview))
> only places people in the 3D preview: a measured floor rectangle in metres, never read by zones. Both are
> four corners on the same picture and are stored separately. The wizard shows the comparison on both tabs
> (`AreaVsFloor` in `PoseCalibration.tsx`); the guide has the operator table in chapter 13.

The camera drives the state machine through the same **trigger zones** as the LiDAR, without the two
plugins knowing about each other:

1. **Mark the interaction area** — **View ▸ Pose Calibration…**, tab **Interaction area**. Four corners
   on any plane (a wall, a screen, the floor, a box of air), placed by dragging or by **Walk the
   corners** (hold a hand still 2 s at each corner). Saved as `Scene3D.mediapipeArea`: room scope, never
   in a scene snapshot (`SCENE3D_NOT_A_LOOK`), carries the camera's label and resolution so a swapped
   webcam is flagged.
2. **Draw zones on it** — the Trigger Zones editor lists **Camera area (MediaPipe)** as a surface. Each
   zone picks which body parts count (**Detect**: hands, feet, head, body, or any mix).
3. **Wire a transition** — trigger **Trigger zone**, exactly as for a LiDAR zone (enter, exit,
   occupied for, empty for, at least N, ALL/ANY combinations).

**What a zone counts.** Every inference frame, each person's parts are mapped from the camera picture
into the area: a hand is the mean of wrist and index (either alone if one is hidden), a foot is the
foot index or else the heel, the head is the nose, the body is the hip midpoint. A landmark below 0.5
visibility is ignored. Points up to 5 % outside the area are kept so a hand on the edge does not blink.
A zone counts **people** with at least one selected part inside, so both hands of one visitor are one.
Left and right are the person's own, whatever the mirror.

**Seeing it in 3D.** With **Camera pose markers (MediaPipe)** on in the 3D scene panel, the camera
picture stands as a vertical panel behind the floor origin: the marked area is its dashed outline, every
body part the zones count is a yellow dot, and the zones themselves sit on it, dashed while empty, solid
while occupied, with name and headcount. The panel shows whenever an area is marked, even with a floor
calibration. It is a picture of the camera's view, not a place in the room, because a 2D camera cannot say
which plane the area is on. *Implementation:* `poseField.ts` is the one mapping; the camera area's
`TrackingSurfaceContribution.toWorld()` places zones on it (null while the overlay is off), and the
LiDAR plugin's `ProviderZonesViz` draws them, so zones stay owned by the zone engine.

**Limits.** The camera sees in 2D: a hand "in" a zone is a hand in front of it from the camera's point
of view. BlazePose gives wrists and fingertips, not gestures. A stale camera (no frame for 500 ms) is
nobody, not a frozen crowd.

**Simulating people** (tests, rehearsals, no visitor): in the main window's devtools,
`__artluxPose.inject([{ u, v, score, landmarks }])` takes the pose store as a replay source (the live
camera cannot overwrite it) and `__artluxPose.release()` hands it back; `__artluxPose.points()` returns
what the zones see.

## Floor calibration & real-world position preview

When the camera points down at a **floor**, the raw image `(u,v)` is perspective-distorted — it doesn't
say where a person actually stands. A floor is a **plane**, so a **4-point homography** maps the video
feed to real floor metres exactly (no camera intrinsics/lens solve). This drives a real-world position
preview on the 3D floor.

- **Calibrate:** **View ▸ Pose Calibration…**, tab **Floor (3D)**. Point the camera at the floor, drag
  the four handles onto the corners of a floor rectangle whose real size you know (tape/measure e.g.
  3×2 m), enter its **width × depth** in metres, and **Save floor**. Order is top-left, top-right, bottom-right, bottom-left,
  with the image's top edge as the *far* side of the floor.
- **Preview:** enable **Camera pose markers (MediaPipe)** in the 3D scene panel. With a calibration set,
  `PoseViz` draws the real floor rectangle and a marker per person at their mapped `(x,z)` metres; without
  one the markers sit on the vertical camera-field panel. The panel is also drawn whenever an interaction
  area is marked, carrying the area, its zones and the counted body parts (see above).
- **Persistence:** the calibration lives in `Scene3D.mediapipeFloor` — saved per-project in the `.artlux`
  file and bridged to projector windows, exactly like `camMask`/`markerMap`. Like the interaction area
  it is the room, not a look: a scene snapshot no longer carries it (before 2026-11-09 it did, so a GO
  onto an older scene could put back an old floor).
- **How it maps:** the person's **ground-contact point** (foot — ankle/heel/foot-index midpoint from the
  landmarks, hip fallback) is mapped through `imageToWorld(imageQuad, worldQuad)` in `poseHomography.ts`,
  reusing the host's `squareToQuad`/`applyH` corner-pin math.

**Caveats.** The mapping assumes the foot is on the floor plane, so a **standing/walking** person maps
accurately; a **jumping** person is momentarily off-plane. Webcam lens distortion is ignored (fine for a
quick calibration; re-mark corners if the edges look bowed). This is **display only** in this
iteration — surface/DMX content still positions people in image space.

<!-- audience:contributor -->

## Scope + roadmap

v1 ships **pose positions as a tracking source** plus **floor calibration + real-world preview**. The
store/engine are modality-agnostic so these are additive later (not built yet): feeding the calibrated
world `(x,z)` into the content mapping path (world-space surfaces/effects), hands + gesture recognition,
face mesh/blendshapes, person segmentation (masking/keying), gesture→cue/OSC control, and record/replay
**takes** (mirror the LiDAR `trackingRecorder`/`trackingPlayback`).
