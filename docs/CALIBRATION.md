# Projector Calibration

Semi-automatic calibration of a **physical video projector** so the 3D scene can be projected onto the
real venue with sub-pixel geometric accuracy ("projection mapping"). A projector is mathematically an
inverse camera; we recover its **intrinsics** (focal length, principal point, lens distortion) and its
**pose** (position + orientation in the venue), then drive a matching virtual projector that renders
the 3D scene from the projector's exact viewpoint.

It is a **hybrid** of two independent solves:

- **Intrinsics + distortion — structured light.** A camera watches Gray-code patterns the projector
  throws onto a **printed checkerboard** held in several poses; decoding yields thousands of sub-pixel
  board-corner ↔ projector-pixel correspondences → OpenCV `calibrateCamera`. Needs a camera + a
  darkened room; needs **no** venue model.
- **Pose in the venue frame — model picks.** With intrinsics fixed, project a crosshair, aim it at a
  few known venue features, and click the matching points on the 3D model → OpenCV `solvePnP`. Anchors
  the projector directly in venue coordinates (no camera→venue registration).

> **Accuracy:** intrinsics + distortion are sub-pixel (dense data). Absolute pose is bounded by the
> handful of operator-aimed pose points — but `solvePnP` with locked intrinsics is well-conditioned.
> Spread the pose points and keep them non-coplanar.

---

## Requirements

- A **printed checkerboard** (rigid, matte). Note its *inner-corner* count (a 10×7-square board = 9×6)
  and square size in mm.
- A **camera** (any `getUserMedia` webcam/USB camera) positioned to see both the board and the
  projection.
- A **darkened room** (Gray-code decode needs the projection to dominate).
- A **venue model** (GLB) loaded in the 3D scene — needed for the pose step only.
- The native calibration addon (`native/calib/calib.node`) present. It ships as a committed prebuilt;
  see below to (re)build it.

## Building the native addon

The solver is a Rust/napi addon wrapping OpenCV (`native/calib`). Building it requires **OpenCV 4.11**
+ **LLVM/libclang** + MSVC (the `opencv` crate uses bindgen). The compiled `calib.node` is committed;
the large `opencv_world*.dll` is **not** committed — it's copied next to `calib.node` by the build and
bundled into the installer via electron-builder `extraResources`.

```
# one-time host setup: install LLVM, MSVC build tools, and extract the official OpenCV 4.11 prebuilt
#   to C:\opencv (no contrib needed — the Gray-code decode is hand-rolled)
npm run build:calib      # → scripts/build-calib.ps1 : sets env, disables unused OpenCV modules,
                         #   builds, copies calib.node + opencv_world4110.dll into native/calib/
```

Pin `opencv = "0.99"` in `native/calib/Cargo.toml` (older pins resolve a mismatched binding generator).
If the addon is missing the app still runs; the wizard's first checklist row shows it as unavailable.

---

## Using the wizard

Open **Outputs → Calibrate** on an output that is enabled and assigned to the projector's display. The
wizard is a left rail; the main window shows the **2D stage (left) + 3D scene (right)** split.

1. **Setup** — a live checklist (engine installed, output live, camera detected, venue model loaded)
   with inline fixes. Pick the camera here. Dim the room.
2. **Camera** — **Start** the camera; aim it so it sees the board *and* the projection. The projector
   shows white to light the board; a **live overlay** marks the detected checkerboard corners. Set the
   board's cols/rows/square-mm.
3. **Lens (intrinsics)** — hold the board in **~8–12 varied poses** (move + tilt + near/far) and
   **Capture** each; the **coverage grid** shows which frame regions + distances you've covered. At ≥3
   poses press **Solve lens** — the RMS badge should read *good* (< 1 px). More + more-varied poses
   improve it.
4. **Pose** — on the **projector**, drag/arrow the crosshair onto a distinct venue feature and press
   **Enter** (Shift ×10 px, Shift+Alt ×0.1 px fine); then click the **same** feature on the model in
   the **3D view (right)**. Repeat **≥4** well-spread, non-coplanar points. The pose solves
   automatically; the frustum appears in the 3D scene and the pose-RMS badge updates.
5. **Verify** — review fx/fy/cx/cy + both RMS values; toggle **Test projection** to render the venue
   from the matched projector and confirm alignment on the real surface. **Apply & finish** enables
   render-from-projector for the output.

The result is cached on the output's `calibration` and persisted with the project. The **Render from
projector** toggle (Outputs → output settings) turns the calibrated 3D render on/off afterwards.

---

## How it works (architecture)

```
 Camera (getUserMedia)            Main window (App)                  Projector output window
 ─────────────────────           ─────────────────                  ───────────────────────
 checkerboard, N poses     →  calibController (SL sequence)     →  raw 2D Gray-code overlay
   detect + decode             → native calib.node (OpenCV)         (white/black/bit planes), acks
                               calibrateCamera → K + distortion
 (no camera; pose step)        crosshair pixel ⟷ model pick     ←  aim crosshair (drag/nudge)
 click on embedded 3D     →   solvePnP → R, t (venue frame)         render: 3D scene from the
                               store ProjectorCalibration       →   matched camera + distortion pass
```

- **Native solver** — `native/calib` exposes `detectBoard`, `mapCornersToProjector` (Gray-code decode
  + per-corner local homography), `calibrateProjector`, `solvePnp`. Loaded in main via
  `src/main/calibManager.ts`; the renderer drives it over IPC.
- **Gray-code** — `src/renderer/calib/graycode.ts` generates the patterns; the projector window renders
  them on a raw 2D overlay (pixel-exact) and frame-syncs an ack so the camera grabs in step. The
  bit-ordering matches the Rust decode exactly (validated: 0 px round-trip).
- **CV → Three.js** — `src/renderer/calib/cvCamera.ts` converts the OpenCV intrinsics/extrinsics into
  a Three.js camera (pose quaternion + an **exact** intrinsic GL projection matrix that represents
  `fx≠fy` and the principal point — validated to 1e-13 px vs OpenCV).
- **Render-from-projector** — `src/renderer/projector/ProjectorScene.tsx` renders the venue models from
  that camera, with a lens-distortion post-pass (`@react-three/postprocessing`).

### Key files

| Area | File |
|---|---|
| Wizard UI | `src/renderer/components/CalibWizard.tsx` |
| SL orchestration | `src/renderer/calib/calibController.ts` |
| Camera capture | `src/renderer/services/calibCapture.ts` |
| Gray-code | `src/renderer/calib/graycode.ts` |
| CV↔Three.js math | `src/renderer/calib/cvCamera.ts` |
| Render-from-projector | `src/renderer/projector/ProjectorScene.tsx` |
| Native addon | `native/calib/` (`src/lib.rs`), `src/main/calibManager.ts` |
| Frustum overlay | `src/renderer/components/Simulator3D/ProjectorFrustum.tsx` |
| Data model | `ProjectorCalibration` / `useCalibration` in `shared/protocol.ts` |
| Embedded 3D split | `src/renderer/App.tsx` (split layout), `useModelUrls.ts` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Calibration engine installed" ✗ | The addon isn't present — `npm run build:calib` on an OpenCV host, or check `opencv_world*.dll` sits next to `calib.node`. |
| Checkerboard not detected | More light on the board (white field), hold it flatter/steadier, verify cols/rows are the *inner* corners, reduce glare. |
| "only N corners decoded" | Focus the camera, increase contrast, darken the room, reduce projector keystone on the board area. |
| High lens RMS (> 2 px) | Capture more poses with more variety (tilt + near/far + frame corners — watch the coverage grid). |
| High pose RMS / unstable frustum | Use ≥6 points, spread across the scene and **non-coplanar** (vary depth); re-aim any outlier point. |
| Projection misaligned after distortion | The distortion post-pass uses a forward-distort convention; for a real lens it may need a sign flip (identity for zero distortion). The pose/geometry is exact regardless. |

## Caveats / follow-ups

- **Distortion convention** may need a sign flip validated on a real lens (identity for zero distortion).
- **Content on mesh** in the projector output currently shows GLB materials + locally-decoded layers;
  streaming arbitrary timeline-layer frames to render-mode projectors is a follow-up. (Assign a
  timeline layer to a mesh via the Scene panel — it textures the mesh via its UVs.)
- The wizard's "Polished" tier excludes **auto-capture** and **resume/persist** (the "Maximum" tier).
