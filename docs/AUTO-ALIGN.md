# Camera auto-align + multi-projector blend (markerless, NVAPI, MPCDI)

Camera-automated projection-mapping alignment for a **multi-projector** rig onto **arbitrary 3D
geometry** (the loaded venue model), with **edge blending**, applied through **NVIDIA NVAPI** (Quadro/
RTX-pro) **and** ArtLux's GLSL engine, with **one-click recalibration**, interoperating via **MPCDI**.

Benchmarked against **Digital Projection Advanced Align** and **VIOSO ProjectionTools / WarpBlend**.
Built **in-house** on ArtLux's existing structured-light + OpenCV + R3F stack.

This is the markerless successor to the board-based flow in [CALIBRATION.md](CALIBRATION.md); see also
[NVWARP.md](NVWARP.md) for the NVAPI addon build.

---

## The governing architectural truth

NVAPI scanout warp is a **2D framebuffer resample** of a display — it **cannot** render view-dependent
3D perspective or occlusion. So for mapping onto **3D geometry**:

- **Geometry correction = the calibrated 3D render** from each projector's recovered viewpoint
  (ArtLux `ProjectorScene`). The venue model is the metric reference (it replaces the checkerboard).
- **NVAPI's jobs** = edge **blend** (`SetScanoutIntensity`), lens **distortion** (`SetScanoutWarping`),
  and **persistence / content-agnostic** application.
- **ArtLux GLSL** = the 3D render + in-app blend preview + the non-Quadro fallback.

**Viewing model = surface-painted:** content lives *on* the geometry (e.g. texture the venue model via
a timeline layer) — correct for every viewer, so the MVP needs no eyepoint machinery. (Dynamic eyepoint
is a clean future extension into the LiDAR tracking.)

### Calibration artifact (per projector)
1. **`ProjectorCalibration`** (intrinsics + distortion + pose in the venue frame) — drives the 3D render.
2. **Dense per-pixel 3D surface map** (projector pixel → world XYZ) — VIOSO `.vwf`-equivalent; drives
   world-space blend, NVAPI distortion warp, and MPCDI export. Both come from one scan.

---

## Phases & status

| Phase | What | Status |
|---|---|---|
| **0** | Per-projector markerless geometry (scan → self-cal → picks → raycast venue → resection) + **Auto-Align wizard** | code-complete; **needs hardware validation** |
| **1** | `native/nvwarp` NVAPI scanout warp/blend addon + ArtLux plumbing | **real build + on-hardware validated** (RTX 6000 Ada, 2026-06-29): `available()`/warp/intensity/clear all OK; renderer per-output apply (`hwWarp`, `nvwarpApply.ts`) + double-warp guard + panic-clear **wired**. Pending: warped geometry + multi-display mapping with a projector attached |
| **2** | World-space multi-projector **blend computation** (`blendCompute.ts`) | code-complete; **node-validated** (partition of unity); apply-to-outputs + multi-proj capture pending hardware |
| **3** | **One-click recalibration** via physical markers + brightness/colour uniformity | not started (needs a working hardware loop) |
| **4** | **MPCDI** export/import codec | export code-complete; **round-trip node-validated**; import-to-**apply** pending |

What's proven without hardware: the **blend partition-of-unity** (Σα ≈ 1 in overlaps → no seam) and the
**MPCDI round-trip** (geometry + alpha exact). Everything else compiles, typechecks, and boots.

---

## Using the Auto-Align wizard (Phase 0)

Open **Outputs → Calibrate** on an output, then toggle **Board → Auto-Align** in the wizard header.
Prerequisites: the calibration engine (`calib.node`), a **camera**, a **venue GLB** loaded in the 3D
scene, a **projector output** (windowed or a display), and a **darkened room**.

1. **Setup** — checklist + an assumed-horizontal-FOV slider (a rough lens seed; self-cal refines it).
2. **Camera** — Start (Browser or OpenCV/DShow); grayscale preview.
3. **Anchor** — click a recognizable point in the **camera image**, then the **same point on the 3D
   model** (right split); repeat **≥4** well-spread, non-coplanar → RANSAC solvePnP camera pose. Each
   pair drops a **numbered marker** on both sides (cyan crosshair on the preview, matching numbered
   marker in the 3D scene; a dashed orange ring marks a camera point still awaiting its model match) so
   correspondences are easy to verify.
4. **Scan** — *dim the room*, **Scan venue**: Gray-code → dense decode → (optional) **self-calibrate
   the camera lens from the scan** → re-solve pose → raycast the venue mesh → resection the projector.
5. **Verify** — **residual heatmap** (green good / red ≥4 px — speckle = decode noise, *structured =
   model/scale mismatch*), fx/fy/cx/cy + lens/pose RMS, the lens source (self-cal vs assumed FOV), and
   an honest "low RMS ≠ correct scale" warning. **Apply & finish** enables render-from-projector;
   **Export MPCDI** writes the calibration as an interchange file.

> **Honest caveats:** self-cal (focal-from-fundamental-matrix) is noise/degeneracy-sensitive — it's
> gated and silently falls back to the FOV guess (Verify shows which). A wrong GLB **scale** still
> reprojects with low RMS — confirm the projection lands right on the real surface. The **PS3 Eye's
> 640×480** is marginal for precise work; prefer the 4K IPEVO or an industrial camera.

---

## Continuing on the Quadro (hardware session)

1. **Build the real NVAPI addon** — on the RTX 6000, install the NVIDIA NVAPI SDK, then
   `npm run build:nvwarp -- -NvapiSdk "C:\path\to\nvapi"`, and **re-commit** the real `nvwarp.node`
   (see [NVWARP.md](NVWARP.md)). Confirm `[nvwarp] NVAPI warp/blend available` in the log.
2. **Validate Phase 0** — run Auto-Align against a loaded venue GLB in a dim room; confirm the
   render-from-projector lands on the real surface and the residual heatmap is speckle (not structured).
3. **Then** wire the remaining apply/integration (Phase 1 distortion push, Phase 2 blend apply, multi-
   projector capture, Phase 3 markers, MPCDI import-apply) — each benefits from being seen on hardware.

---

## File map

| Area | File |
|---|---|
| Markerless per-projector solve | `src/renderer/calib/markerlessController.ts` |
| Shared Gray-code scan | `src/renderer/calib/slCapture.ts` |
| Dense decode / RANSAC PnP / guided resection / self-cal (native) | `native/calib/src/lib.rs` |
| Camera→world ray, CV↔Three math | `src/renderer/calib/cvCamera.ts` |
| Batch venue raycaster | `src/renderer/calib/venueRaycast.ts` (registered by `Simulator3D/ModelObject.tsx`) |
| World-space blend | `src/renderer/calib/blendCompute.ts` |
| Auto-Align wizard | `src/renderer/components/AutoAlignWizard.tsx` (App `calibFlow` switches Board ↔ Auto) |
| NVAPI addon | `native/nvwarp/` (`src/shim.cpp`, `src/lib.rs`, `build.rs`), `src/main/nvwarpManager.ts` |
| MPCDI codec / region build | `src/main/mpcdi.ts`, `src/renderer/calib/mpcdiData.ts` |
| Data model | `ProjectorCalibration` / `MpcdiRegion` in `shared/protocol.ts` |
| Render-from-projector (unchanged) | `src/renderer/projector/ProjectorScene.tsx` |

## Native build prerequisites
- `calib.node` (incl. the markerless functions + self-cal): `npm run build:calib` — OpenCV 4.11 + LLVM
  + MSVC (see [CALIBRATION.md](CALIBRATION.md)).
- `nvwarp.node`: `npm run build:nvwarp` (stub) / `-NvapiSdk` for the real path (see [NVWARP.md](NVWARP.md)).
