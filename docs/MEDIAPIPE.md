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
| `PoseViz.tsx` | r3f scene overlay: the camera field + per-person markers (gated on `scene.mediapipeViz`). |
| `PosePanel.tsx` | Pose Monitor modal — live camera preview, status, fps, tracked count. |
| `poseSettings.tsx` / `poseContentEditor.tsx` | Preferences section / per-surface inspector fragment. |
| `poseHost.ts` | Stashes `ctx.host` for non-React settings reads + a reactive settings hook. |

Core edits are minimal (persisted enum/fields stay core, behavior lives in the plugin):
`SourceType.MEDIAPIPE` + a `poseSkeleton` field (`renderer/types.ts`), `Scene3D.mediapipeViz`
(`shared/protocol.ts`), a picker button (`ContentEditor.tsx`) and menu item (`MenuBar.tsx`).
Plugin-local prefs live under `AppSettings.plugins.mediapipe` (no core field).

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
3. Pick the camera + model in **Preferences → Pose Tracking (MediaPipe)**.
4. Open **View → Pose Monitor…** to see the live feed, fps, and tracked-people count.
5. Toggle **Camera pose markers (MediaPipe)** in the 3D scene panel for the simulator overlay.

## Scope + roadmap

v1 ships **pose positions as a tracking source**. The store/engine are modality-agnostic so these are
additive later (not built yet): hands + gesture recognition, face mesh/blendshapes, person
segmentation (masking/keying), gesture→cue/OSC control, camera→venue homography calibration, and
record/replay **takes** (mirror the LiDAR `trackingRecorder`/`trackingPlayback`).
