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

> **Markerless successor:** a camera-automated, **board-free** flow (the venue model is the reference)
> with multi-projector blend, NVAPI hardware warp/blend, and MPCDI interchange now exists — see
> [AUTO-ALIGN.md](AUTO-ALIGN.md). Open it from this same wizard via the **Board ↔ Auto-Align ↔
> Manual** header toggle. The board flow below remains the validated, hardware-tested path.

> **No camera at all?** The **Manual** flow needs only the projector and the venue model: the lens is
> entered from the spec sheet (throw ratio + lens shift) instead of measured, and the pose comes from
> the same crosshair↔model point pairs as the board flow's Pose step — see
> [The Manual flow](#the-manual-flow-no-board-no-camera).

---

## Requirements

- A **printed checkerboard** — use the ready-made [docs/checkerboard-9x6-25mm.svg](checkerboard-9x6-25mm.svg)
  (**9 × 6 inner corners, 25 mm squares** — matches the wizard default). Open it in a browser and print
  at **100% / Actual size** (A3, or A4 with *Fit to page*), onto rigid matte stock. After printing,
  **measure a square** with a ruler and enter that value in the wizard's *Square mm* field — the sheet
  has a 100 mm reference ruler so any print scaling is harmless. Regenerate it with
  `node scripts/gen-checkerboard.cjs`.
- A **camera** positioned to see both the board and the projection. Two interchangeable backends —
  any `getUserMedia` webcam (**Browser**), or **OpenCV (DirectShow)** for cameras the browser can't
  drive (notably the **PS3 Eye**) — see [Camera notes](#camera-notes).
- A **darkened room** (Gray-code decode needs the projection to dominate).
- A **venue model** (GLB) loaded in the 3D scene — needed for the pose step only.
- A **projector output**, either fullscreen on a display or **windowed** for single-monitor testing —
  see [Output on a single screen](#output-on-a-single-screen-windowed).
- The native calibration addon (`native/calib/calib.node`) present. It ships as a committed prebuilt;
  see below to (re)build it.

<!-- audience:contributor -->

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
The addon uses `core` + `imgproc` + `calib3d` (the Gray-code decode is hand-rolled, so no contrib
module) plus **`videoio`** for native DirectShow camera capture; `build-calib.ps1` disables every other
OpenCV module header before generating bindings (some crash bindgen or emit broken bindings). If you
re-enable `videoio` (or change which modules are on) after a prior build, run `cargo clean -p opencv`
once so its bindings regenerate. If the addon is missing the app still runs; the wizard's first
checklist row shows it as unavailable.

---

<!-- audience:operator -->

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
4. **Pose** — on the **projector**, put the crosshair on a distinct venue feature (drag or arrows;
   Shift ×10 px, Shift+Alt ×0.1 px fine); then click the **same** feature on the model in the
   **3D view (right)** — the model click pairs with wherever the crosshair is, no confirmation
   needed. Repeat **≥4** well-spread, non-coplanar points. The pose solves automatically; the
   frustum appears in the 3D scene and the pose-RMS badge updates.
5. **Verify** — review fx/fy/cx/cy + both RMS values; toggle **Test projection** to render the venue
   from the matched projector and confirm alignment on the real surface. **Apply & finish** enables
   render-from-projector for the output.

The result is cached on the output's `calibration` and persisted with the project. The **Render from
projector** toggle (Outputs → output settings) turns the calibrated 3D render on/off afterwards.

## The Manual flow (no board, no camera)

Switch with the **Manual** button in the wizard header. It replaces the measured lens with a
spec-sheet one and keeps the pose machinery — useful when there is no camera on site, or the object is
too small/complex for a board.

1. **Setup** — engine installed, output live, venue model loaded. The model is the **only metric
   reference** here: it must match the real object's true dimensions.
2. **Lens** — enter the **throw ratio** (throw distance ÷ image width) and **lens shift** (0% =
   centered on the lens axis; +100% vertical = image entirely above it — the common fixed-lens case),
   then **Apply lens**. With **Auto-solve lens from the points** on (default), these are only a
   seed: from 6 points every solve re-estimates the focal (single-view `calibrateCamera` seeded with
   the current K, principal point + aspect held), adopting it only when it is a plausible throw
   ratio AND fits the picks at least as well — a flat point spread falls back to the entered lens
   rather than exploding. So a rough throw ratio is genuinely fine.
3. **Points** — identical gesture to the board flow's Pose step: crosshair on a physical feature →
   click the matching vertex on the model (vertex-snapped; **Alt** picks freely) — the model click
   pairs with the current crosshair, there is no confirm step. ≥4
   pairs solve the pose (RANSAC from 6, so one bad click gets voted down); spread them across the
   raster **and across depth**. Every placed pick is drawn **numbered on the projection itself**, on
   the right-pane raster map and on the 3D markers — one numbering across all three views. Once
   solved each point lists its **own reprojection error**; fix the worst instead of clearing
   everything — editing is direct manipulation: **drag the point** where you see it (its 3D marker
   across the mesh, vertex-snapped; its dot on the raster map; or the numbered point grabbed on the
   projection itself) and the solve follows live. The selected point's **Move 3D point** /
   **Re-aim projector pixel** buttons remain as click-based alternatives; a stray click never moves
   a point — moving always starts ON the point (a grab) or from an explicit button. From the first solve,
   **Project wireframe while picking** (default on) projects the live mesh edges + vertex dots onto
   the object, so the residual alignment error is visible in place and every added/edited point pulls
   it in. The panel names the lens in play (*auto-solved from the points* / *entered value*) with
   the current throw ratio. With auto-solve off, **Refine lens** (≥8 pairs) and **Revert lens** do
   the same estimation on demand.
4. **Verify** — **Test projection**, defaulting to a **wireframe** look (bright mesh edges — a bound
   content layer or a dark CAD material would otherwise render near-black and read as "nothing"),
   plus the **solved projector distance**. That distance is the lens gauge: PnP absorbs a wrong focal
   into distance, so *real throw distance ÷ solved distance* is exactly the factor to multiply the
   throw ratio by (Lens step → re-apply; the pose re-solves from the kept points). Then
   **Apply & finish**.

Expect a good fit at and between the picked points and small drift far outside them — the spec-sheet
lens has no distortion model. A later board calibration on the same output replaces the lens and keeps
the picked points (the pose re-solves under the better lens).

The 3D scene's projector **frustum** extends just past the farthest pose pick, so a solved projector
visibly reaches the venue it lights; the wireframe option also exists on the board flow's Verify step.

**After Apply & finish** the project is saved in place and the output renders the venue from the
solved projector in the normal show (`useCalibration` — the *Render from projector* toggle in
Outputs). **Multi-projector:** calibrate each output manually against the same venue model — the
model is the shared metric reference, so all solves share one world frame by construction — then
solve the **Rig blend** from the Outputs panel. A manually-calibrated output needs no Auto-Align
scan for that: its dense projector-pixel→3D map is **traced** from the calibration by raycasting the
venue mesh (the same regeneration MPCDI export uses), so the only requirement is that the venue
model is loaded when solving. Traced maps are session-only and re-trace automatically after a
recalibration; camera-scanned maps, which measure geometry independently, are reused as before.

---

## Output on a single screen (windowed)

To develop or test on **one monitor** (no second display / real projector), set the output's display to
**"Windowed (this screen)"** in the Outputs panel. Instead of a fullscreen output on a physical
display, you get a **movable, resizable window** on the main screen showing the projector output.
Everything works on it — corner-pin align, NDI send, and the **full calibration wizard +
render-from-projector** — so you can exercise the whole flow on a laptop. The projector "raster" is
just the window's pixel size. (Internally this is the `WINDOWED_DISPLAY` sentinel display id; switching
an output between windowed ↔ a real display recreates the window.)

## Camera notes

The Camera step has a **Capture via** toggle with two backends:

### Browser (getUserMedia) — default, for UVC webcams
- Works for any normal `getUserMedia` device. **Windows camera privacy** must allow it (Settings →
  Privacy & security → Camera → *Camera access* + *Let desktop apps access your camera*); the app
  grants the renderer's media permission.
- With **multiple cameras** the wizard lists them by name and **auto-selects a real one, skipping IR
  webcams and virtual cameras** (an *NDI Webcam* shows black, an *IR* cam shows a dark image). Pick the
  device explicitly if needed — a USB overhead document camera (e.g. IPEVO V4K) works very well.
- On failure the wizard shows the reason: *blocked* (privacy), *busy* (another app — close
  Teams/Zoom/OBS), or *not found*. The start path auto-relaxes the requested resolution (720p → 480p →
  any) so a limited camera that can't start at 720p isn't misreported as busy.

### OpenCV (DirectShow) — for the PS3 Eye and other non-UVC cameras
Some cameras deliver frames to **OpenCV's `videoio` (DirectShow)** but **not** to Chromium's
`getUserMedia`, whose DirectShow support is stricter and fails to *start* the device
(`NotReadableError`). The **PlayStation 3 Eye** is the canonical case: its user-mode DirectShow source
filter (the [PS3EyeDirectShow](https://github.com/jkevin/PS3EyeDirectShow) driver) is invisible to
`getUserMedia` but works perfectly through OpenCV — the same way tools like vvvv use it.

For these, switch the Camera step to **OpenCV (DShow)**. The frames are captured natively in the addon
(`cameraOpen`/`cameraGrabGray`, `VideoCapture` + `CAP_DSHOW`, MJPG 1280×720) and streamed to the
wizard over IPC — bypassing Chromium entirely. OpenCV's DirectShow backend addresses devices by
**index** (it can't read device *names*), so the wizard shows a **Device index** field instead of a
name list: try **0–5**, pressing *Start* each time, until the feed appears (exactly like vvvv's "Device
Index"). Everything downstream — board detect, Gray-code capture, solve — is identical.

> **Black preview?** If a device *opens* (the log prints its resolution) but the preview stays black,
> it's almost always **contention** — another app (Teams, the **NDI Webcam** tool, OBS) is holding the
> camera, so OpenCV gets empty frames. The wizard flags this ("Camera opened but the image is black…").
> Close the other app, **unplug + replug** the camera, and press *Restart*. DirectShow indices aren't
> stable across replugs/reboots, so the Eye's index can change — re-scan 0–5 if needed.

> **PS3 Eye setup (Windows):** the Eye is not a UVC device; install the
> [PS3EyeDirectShow](https://github.com/jkevin/PS3EyeDirectShow/releases) driver (WinUSB + DirectShow
> filter). After install the camera's video interface should show **OK** in Device Manager (it binds to
> the `WinUSB` service). Then use the **OpenCV (DShow)** source here — no Chromium flags needed.

---

<!-- audience:contributor -->

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

Calibration now ships as the first-party plugin **`@artlux/plugin-calibration`** (see
[PLUGINS.md](PLUGINS.md)); its code lives under `plugins/calibration/src/` (the native solver stays in
`native/calib`).

- **Native solver** — `native/calib` exposes `detectBoard`, `mapCornersToProjector` (Gray-code decode
  + per-corner local homography), `calibrateProjector`, `solvePnp`. Loaded in main via
  `plugins/calibration/src/calibManager.ts`; the renderer drives it over IPC.
- **Gray-code** — `plugins/calibration/src/graycode.ts` generates the patterns; the projector window renders
  them on a raw 2D overlay (pixel-exact) and frame-syncs an ack so the camera grabs in step. The
  bit-ordering matches the Rust decode exactly (validated: 0 px round-trip).
- **CV → Three.js** — `plugins/calibration/src/cvCamera.ts` converts the OpenCV intrinsics/extrinsics into
  a Three.js camera (pose quaternion + an **exact** intrinsic GL projection matrix that represents
  `fx≠fy` and the principal point — validated to 1e-13 px vs OpenCV).
- **Render-from-projector** — `plugins/calibration/src/ProjectorScene.tsx` renders the venue models from
  that camera, with a lens-distortion post-pass (`@react-three/postprocessing`).

### Key files

| Area | File |
|---|---|
| Wizard UI | `plugins/calibration/src/CalibWizard.tsx` |
| SL orchestration | `plugins/calibration/src/calibController.ts` |
| Camera capture | `plugins/calibration/src/calibCapture.ts` |
| Gray-code | `plugins/calibration/src/graycode.ts` |
| CV↔Three.js math | `plugins/calibration/src/cvCamera.ts` |
| Render-from-projector | `plugins/calibration/src/ProjectorScene.tsx` |
| Native addon | `native/calib/` (`src/lib.rs`), `plugins/calibration/src/calibManager.ts` |
| Frustum overlay | `src/renderer/components/Simulator3D/ProjectorFrustum.tsx` |
| Data model | `ProjectorCalibration` / `useCalibration` in `shared/protocol.ts` |
| Embedded 3D split | `src/renderer/App.tsx` (split layout), `useModelUrls.ts` |

---

<!-- audience:operator -->

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
