# Camera auto-align + multi-projector blend (markerless, NVAPI, MPCDI)

Camera-automated projection-mapping alignment for a **multi-projector** rig onto **arbitrary 3D
geometry** (the loaded venue model), with **edge blending**, applied through **NVIDIA NVAPI** (Quadro/
RTX-pro) **and** ArtLux's GLSL engine, with **one-click recalibration**, interoperating via **MPCDI**.

Benchmarked against **Digital Projection Advanced Align** and **VIOSO ProjectionTools / WarpBlend**.
Built **in-house** on ArtLux's existing structured-light + OpenCV + R3F stack.

This is the markerless successor to the board-based flow in [CALIBRATION.md](CALIBRATION.md); see also
[NVWARP.md](NVWARP.md) for the NVAPI addon build and
[CALIB-OPTIMIZATIONS.md](CALIB-OPTIMIZATIONS.md) for the VIOSO-parity workflow additions (ArUco
one-click recalibration, camera/projector masking, exposure controls, colour/black-level matching).

---

<!-- audience:contributor -->

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
| **2** | World-space multi-projector **blend computation** + **apply** | **wired end-to-end 2026-07-28.** Scans are kept (`blendStore` + a sidecar under `<project>/calib/`), `solveRig` feeds `computeBlendMaps`, the result persists as `ProjectorOutput.blend` and is applied by the GPU **or** the scanout — never both. `npm run test:blend` |
| **3** | **One-click recalibration** via physical markers + unattended self-recalibration | **built 2026-07-28** (was "not started"): per-corner marker registration, a persisted camera profile, a ~5 s dot-based drift check, a conservative validate-better gate, rollback, scheduler/tablet triggers, Prometheus + JSONL audit. **`autoApply` ships OFF.** `npm run test:recal` |
| **4** | **MPCDI** export/import codec | export code-complete; **round-trip node-validated**; import-to-**apply** pending |

What's proven without hardware: the **blend partition-of-unity** (Σα ≈ 1 in overlaps → no seam) and the
**MPCDI round-trip** (geometry + alpha exact). Everything else compiles, typechecks, and boots.

### The two bugs Phases 2–3 uncovered (read before trusting an old build)

- **Enabling `useCalibration` silently disabled blending.** Render-from-projector mounts `ProjectorScene`
  as an opaque overlay *above* the projector window's base GL canvas, and that scene had no alpha stage
  at all — so `ProjectorGL`'s soft-edge shader never touched the picture, including a feather the
  operator had set by hand. Two calibrated overlapping projectors doubled up with a hard border. Fixed
  by a `BlendEffect` in `ProjectorScene`, ordered **after** the distortion pass (the blend map is
  indexed by physical raster pixels, which only exist once distortion has been applied). Guarded.
- **`computeBlendMaps` had three defects**, invisible because it had zero callers: its world-voxel
  association was a hard hash, so cells whose centroids straddled a boundary never found their partner
  and kept alpha 1.0 *inside the seam* (a bright band); dilating with `max` then biased every value by
  about a cell; and the voxel was sized from the scene diagonal rather than the cell, so raising
  `mapW` stopped helping. All three are fixed and asserted — the residual is now provably
  discretization (3× the resolution cuts it 2.9×).

### Unattended recalibration (Phase 3) — the shape of it

Reachable at **Preferences ▸ Recalibration**, and schedulable as a `recalibrate` Show Control command
(so the nightly scheduler *and* the tablet reach it with no extra plumbing).

1. **The camera is never an absolute reference.** It is mounted but bumpable, so its pose is re-solved
   from the ArUco marker map at the start of every run and used only within that session. Everything
   persisted is in projector/world space. Markers must be registered with **four corners** (`⌗` in the
   wizard) — a centre pairs all four detected image corners with one 3D point, which is four rays
   through a point, and the unattended path refuses a pose built that way.
2. **The nightly check is cheap.** The stored probes are projected as time-multiplexed dots (~6 frames,
   under 5 s) rather than a 42-plane Gray-code scan, and scored in **millimetres on the surface**.
3. **A gross fault does not auto-solve.** A knocked projector aimed at the floor still solves
   "successfully", with a low RMS, and the answer is garbage.
4. **A low residual is not evidence of a correct solve.** The gate rejects an implausible pose jump
   *regardless of score*: a projector is bolted, so a large jump means the camera anchor is wrong, and
   applying it destroys a working install. Same for implausible optics and coverage loss.
5. **It must be better by a margin**, or nothing changes — hysteresis, so nightly noise never churns a
   good calibration.
6. **There is a way back.** An apply keeps `calibrationPrev`; Revert (panel or `calibRevert` command)
   restores it. Show mode has no undo and no crash-recovery file, so that slot is load-bearing.

> **Commissioning happens by itself.** A successful Auto-Align scan stores the camera intrinsics it used
> and a reference observation, so calibrating a projector by hand is what enables the unattended path —
> an operator never has to know this subsystem exists.

**Alerting is pull-based**, on the monitoring box. Two rules matter; the second is the one people miss:
`artlux_calib_result >= 2` (a fault) and `time() - artlux_calib_last_run_ts > 26*3600` — **a maintenance
task that silently stopped running**, which over a year is far more likely and otherwise invisible.
Forensics live in `userData/artlux-calibration.log`.

---

<!-- audience:operator -->

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
   correspondences are easy to verify. Each pick lists **both** halves — `#1 cam(435,13) ▸ 0.557, 0.172,
   1.566` — and the log names the surface every model click landed on, so a pair that is *not* the same
   physical point shows up without re-deriving it.
   - **The model click snaps to the nearest vertex.** Move toward a corner and an **amber dot** appears
     on it — faint while it is just the nearest candidate, **solid** once it will capture the click. The
     anchor then lands exactly on that vertex, so the model half of the pair is the same nameable
     feature as the camera half. A mid-face click stays a mid-face point, and **holding Alt** gives the
     exact surface point. Corners make the best anchors for this reason: you can hit the same one in
     both views. Orbiting the camera never places a point, however the drag starts or ends.
   - To **fix** a placed pair, select it (list row, camera marker or 3D sphere) and drag / arrow-nudge its
     camera marker; to move its 3D point, press **move 3D point** in the editing bar and then click the
     model — one click, and only while that is lit. Clicking the model at any other time always *places*
     a new point, never moves an existing one.
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

<!-- audience:contributor -->

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
| Markerless per-projector solve | `plugins/calibration/src/markerlessController.ts` |
| Shared Gray-code scan | `plugins/calibration/src/slCapture.ts` |
| Dense decode / RANSAC PnP / guided resection / self-cal (native) | `native/calib/src/lib.rs` |
| Camera→world ray, CV↔Three math | `plugins/calibration/src/cvCamera.ts` |
| Batch venue raycaster | `plugins/calibration/src/venueRaycast.ts` (registered by `Simulator3D/ModelObject.tsx`) |
| World-space blend (maths) | `plugins/calibration/src/blendCompute.ts` — `npm run test:blend` |
| Rig blend: keep scans, solve, apply, staleness | `blendStore.ts`, `calibArtifacts.ts`, `blendController.ts`, `components/RigBlendStrip.tsx` |
| The ONE soft-edge ramp (both GPU paths interpolate it) | `src/renderer/projector/blendGlsl.ts` |
| Venue meshes with no 3D viewport (`--broadcast`) | `plugins/calibration/src/venueRegistrar.ts` |
| Unattended recalibration | `autoRecal.ts` (orchestrator), `validateSolve.ts` (the gate), `driftScore.ts` (pure) + `driftCheck.ts` (IO), `RecalPanel.tsx` — `npm run test:recal` |
| Audit log + in-flight marker + Prometheus gauges | `calibAudit.ts`, `src/main/metrics.ts` `setPluginGauge` |
| Cross-plugin command seam (`recalibrate`, `calibRevert`) | `plugins/show-control/src/commandExt.ts` |
| Auto-Align wizard | `plugins/calibration/src/AutoAlignWizard.tsx` (App `calibFlow` switches Board ↔ Auto) |
| NVAPI addon | `native/nvwarp/` (`src/shim.cpp`, `src/lib.rs`, `build.rs`), `src/main/nvwarpManager.ts` |
| MPCDI codec / region build | `src/main/mpcdi.ts`, `plugins/calibration/src/mpcdiData.ts` |
| Data model | `ProjectorCalibration` / `MpcdiRegion` in `shared/protocol.ts` |
| Render-from-projector (unchanged) | `plugins/calibration/src/ProjectorScene.tsx` |

## Native build prerequisites
- `calib.node` (incl. the markerless functions + self-cal): `npm run build:calib` — OpenCV 4.11 + LLVM
  + MSVC (see [CALIBRATION.md](CALIBRATION.md)).
- `nvwarp.node`: `npm run build:nvwarp` (stub) / `-NvapiSdk` for the real path (see [NVWARP.md](NVWARP.md)).
