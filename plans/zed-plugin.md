# ARTLux-ZED — ZED 2 camera plugin: person tracking first, then automated calibration

Working plan for the `ARTLux-ZED` branch/product line. Researched + designed 2026-07-31 (three
investigations: calibration seams, tracking-plugin patterns, ZED SDK feasibility). Implementation
happens on the dedicated hardware machine (RTX + ZED 2); this document is the contract.

## Context

Integrate a Stereolabs ZED 2 stereo/depth camera for two purposes: **(a)** person tracking to drive
interactive shows (like the LiDAR / MediaPipe / Augmenta sources, but with metric 3D positions and
SDK-stable IDs), and **(b)** automating projector calibration mapping (the AUTO-ALIGN markerless
pipeline currently needs a venue GLB, manual anchor picks, and a fragile self-calibration step — a
depth camera with factory intrinsics removes all three).

**Owner decisions (2026-07-31):** all target machines have NVIDIA GPUs (CUDA OK) · person tracking
ships first · the ZED SDK is an operator-installed prerequisite (no bundling, no helper process) ·
all work happens on branch `ARTLux-ZED`, shipping as a separate product **ARTLux-ZED** (Windows +
NVIDIA-CUDA only, developed separately from mainline) · **fully separate app identity** — own
appId/install dir/userData, side-by-side installable with regular ArtLux, no auto-update cross-talk.

## Feasibility verdict — feasible, with these hard facts

- SDK 5.x: Windows/Linux, NVIDIA **RTX 20-series+ (CC ≥ 7.5) mandatory**, no CPU fallback. CUDA is
  auto-installed by the Stereolabs installer.
- **No Windows runtime redistributable** (officially confirmed by Stereolabs) → operator runs the
  Stereolabs installer; plugin graceful-degrades when absent (splash shows `degraded`), like every
  other native module.
- Body tracking AI models download on **first use** + one-time multi-minute per-GPU TensorRT
  optimization → documented commissioning step ("enable once with internet").
- **No Node bindings and no mature Rust bindings exist** → we own the FFI over the official,
  maintained **C API (`zed-c-api`)**. Best reference: `copper-project/zed` (Apache-2.0).
- ZED 2 is passive stereo (no IR) → **projected gray codes are seen normally**; the existing
  structured-light decode works on ZED frames. Depth is <1% @3 m but error grows quadratically
  (±30–50 cm @10 m) → **hybrid**: gray code stays authoritative for projector geometry; depth
  supplies scene geometry, metric scale, and auto-anchoring.
- ZED 2 is sales-EOL (still SDK-supported); if buying another: **ZED 2i** (same SDK/USB path).
  USB 3.0 passive cable ≈ 3 m — venue runs need active/optical extension. Body-tracking range
  ~7–10 m per camera.

## Architecture: one feature-gated napi crate, no sidecar

**`native/zed`** (Rust, napi-rs) serves both body tracking (Rust-owned worker thread →
ThreadsafeFunction push) and calibration grabs (pull). A livelink-style sidecar exe was considered
and rejected: zero repo precedent vs seven napi crates; the owner declined a helper process;
calibration needs in-process grab sequencing anyway; and the crash-isolation benefit is already
covered by refcounted enable (CUDA never initializes unless a ZED feature is on) + the existing
watchdog. The `plugin:zed:*` IPC surface would let a sidecar be swapped in behind identical
channels later if field experience demands it.

Cargo pattern copied from `native/ndi/Cargo.toml`: an optional `zed` feature gates the SDK link;
without it the crate compiles to stubs; the real `zed.node` is built on the hardware machine and
**committed** (plus a self-built `sl_zed_c.dll`, which dynamically links the operator-installed
`sl_zed64.dll`), both shipped via root `extraResources`.

**Key validated simplification (Phase A):** `trackingStore.ingest(address, value)` is exported
through the lidar-tracking barrel (`plugins/lidar-tracking/src/index.ts`) and is address-keyed —
the ZED plugin feeds synthetic `/ZED/specs/*` + `/ZED/blobs/blob<n>/*` messages directly. That
inherits **trigger zones, `lidar.zone` FSM triggers, `.lblob` take record/replay (incl. the
replay-swallows-live gate), the TRACKING drawable and projector channel** with zero new
abstraction. No new `SourceType`, content source, clip kind, or projector channel in Phase A; a
`TRACKING` surface just sets `trackingSource: 'ZED'`.

---

## Phase 0 — the `ARTLux-ZED` branch + separate product identity

- Branch `ARTLux-ZED` from `main` (done 2026-07-31 — this document lands in its first commit).
  All ZED work commits here (deliberate exception to the commit-to-main convention). **Merge
  `main` into `ARTLux-ZED` periodically** so the fork stays current with mainline fixes.
- Product identity edits (root `package.json`):
  - `build.appId`: `com.urbandronedesign.artlux` → `com.urbandronedesign.artlux-zed` (separate
    install registration, coexists with ArtLux).
  - `build.productName`: `ArtLux` → `ARTLux-ZED` — this also renames the install dir, the
    Start-menu entry, `artifactName` output (`ARTLux-ZED-x.y.z-x64.exe`), and Electron's
    `userData` folder (prefs/layouts automatically separate; a fresh `artlux-prefs.json`).
- **Auto-update must not cross-talk:** `src/main/updater.ts` checks the GitHub `publish` feed 4 s
  after boot — on this branch, disable the automatic check (guard on
  `app.getName() === 'ARTLux-ZED'` or drop the `build.publish` block) until/unless a separate
  release channel exists. Otherwise a ZED install would offer itself regular ArtLux releases.
- `src/main/watchdog.ts` `TASK_NAME = 'ArtLux Watchdog'` → `'ArtLux-ZED Watchdog'` so the two
  products' OS scheduled tasks don't collide on one machine.
- Cosmetic (same commit): window/splash title showing ARTLux-ZED; optionally
  `transport/sacn.ts` `SOURCE_NAME`.
- npm workspace `name: "artlux"` stays (internal, not user-facing).
- Verify: `npm run verify` + `npm run package:dir` → the unpacked exe is `ARTLux-ZED.exe`, boots,
  and writes prefs to a new `%APPDATA%/ARTLux-ZED` folder while an existing ArtLux install remains
  untouched.

## Phase A — `@artlux/plugin-zed` + person tracking

Build order (demo-able early):
- **A0 — no native code:** scaffold plugin + **fake-body generator** in main (`zedFake.ts`, orbit
  pattern like `scripts/lidar-emitter.cjs`) → `zed:bodies` push → renderer `zedIngest.ts` →
  `trackingStore` under surface `'ZED'`. Demo: fake people crossing zones, firing FSM rules,
  visible in 3D + on a projector surface — entire downstream proven before any FFI.
- **A1:** `native/zed` stub crate + `zedManager.ts` loader (`ensureZedOnPath()`:
  `%ZED_SDK_ROOT_DIR%\bin`, CUDA bin — mirrors `plugins/ndi/src/ndiManager.ts`) + splash status.
- **A2 (needs RTX + camera):** real FFI over zed-c-api; open/bodies path; One-Euro smoothing only
  (**ids are SDK-stable — never re-associate**, the Augmenta lesson); commit `zed.node` +
  `sl_zed_c.dll`.
- **A3:** `ZedRig` transform + rig panel, skeleton scene-viz (`ZedViz.tsx` gated on
  `Scene3D.zedViz`), monitor panel, docs finalization.

**New files:** `plugins/zed/` (types, zedManager, zedFake, zedIngest, zedRig, ZedPanel,
ZedRigPanel, ZedViz, zedSettings, plugin.main, plugin.renderer, barrels ×2) · `native/zed/`
(Cargo.toml, build.rs, lib.rs, ffi.rs, worker.rs, README) · `docs/ZED.md` (hybrid,
MEDIAPIPE.md-shaped).

**Modified:** `FIRST_PARTY` in `src/renderer/host/plugins.ts` + `src/main/host/plugins.ts` ·
`electron.vite.config.ts` sdkAliases + `tsconfig.json` paths · root `package.json` extraResources
+ lockfile · `shared/protocol.ts` (`ZedRig`, `Scene3D.zedRig?`, `Scene3D.zedViz?` +
`defaultScene3D` — all optional, zero migration) · `plugins/lidar-tracking/src/ZonePanel.tsx`
`SURFACES` gains `'ZED'` + the TRACKING content editor surface picker · MenuBar action + scene3d
panel toggle · `scripts/verify-plugins.cjs` CHECKS/CONTRIBUTIONS entries · `docs/manifest.json`
(`"ZED.md": "hybrid"`) · user-guide `13-tracking.md` (ZED source) + `17-installing.md` (SDK
prerequisite).

**FFI surface (minimal):** `zed_available` · `zed_open(opts) -> info?` · `zed_close` ·
`zed_start_bodies(cfg, tsfn)` · `zed_stop_bodies`. All SDK calls confined to one worker thread via
a command channel.

**IPC:** `zed:available` (handle) · `zed:status` (handle) · `zed:configure` (on —
enable/fake/resolution/bodyModel/confidence) · `zed:bodies` (push ~30 Hz, a few KB/frame).

**Metric→stage transform — decision:** persisted **`Scene3D.zedRig`**
`{ camPos, camRotDeg, floorRect {x,z,width,depth} }`, **not** a mediapipeFloor-style image
homography (BlazePose needed one because it has no metric data; ZED has metric world positions +
IMU gravity + `getFloorPlane`). Body pos → stage space → floor projection → normalize in
`floorRect` → `u,v` bottom-left; publish `floorRect` dims as `/ZED/specs/Scalex|Scaley`. Default
when unset: SDK floor plane + 8×6 m rect ahead of the camera, so tracking works before the rig
panel is opened. Phase B's anchoring can later *solve* this transform; Phase C Fusion extrinsics
slot into the same shape.

## Phase B — calibration integration

- `plugins/calibration/src/calibCapture.ts`: `CaptureSource` gains `'zed'`; branches in
  start/stop/grab/grabColor/dims/setProp/current; new `DepthFrame` + `grabDepth()` (null on other
  sources). `shared/protocol.ts` `CalibCameraProfile.source` widens + optional `serial` for
  unattended reopen. Wizard source toggles (`AutoAlignWizard.tsx`, `CalibWizard.tsx`) → 3 elements.
- `markerlessController.ts` on zed source: **factory intrinsics replace `self_calibrate_stereo`**
  (the fragile fallback path dies); **depth unprojection (`depthUnproject.ts`) replaces the
  venue-GLB raycast** (GLB becomes optional sanity check — kills the "wrong GLB scale reprojects
  with low RMS" caveat; metric scale from the stereo baseline); gray-code decode unchanged.
- Venue scan: `zed_mapping_start/stop/extract` → `THREE.BufferGeometry` →
  `venueRaycast.registerVenueMesh('zed-scan', obj)` (contract already trivial). Auto-anchoring
  (point cloud ↔ mesh coarse ICP) behind a beta flag; manual picks stay the fallback.
- Pattern frames: manual exposure/gain + WB lock via `zed_set_prop` before the sequence + settle
  frames (the ZED grab is free-running).
- FFI adds: `zed_grab_gray/color/depth`, `zed_get_calib`, `zed_set_prop`, `zed_mapping_*`; IPC adds
  the matching `handle` pull channels (720p frames within what `calib:camera-grab` already moves).
- New: `plugins/calibration/src/zedSource.ts` + `depthUnproject.ts`, `plugins/zed/src/zedCapture.ts`
  (exported via barrel so calibration owns no channel strings). Dependency direction:
  **calibration → zed → lidar-tracking** (no cycles).
- Docs: `docs/AUTO-ALIGN.md` ZED section, user-guide `10-calibration.md`, ZED.md appended.

## Phase C (stretch)

Fusion multi-camera (ZED360 extrinsics JSON → fused bodies → same `/ZED/` surface; `ZedRig` grows a
per-camera list) · mm-domain drift check in `driftCheck.ts`/`autoRecal.ts` (measured depth, not
inferred reprojection).

## What needs the RTX machine vs what can be built anywhere

**Any machine (no RTX / no SDK / no camera):** Phase 0 entirely · Phase A0 (the whole fake-data
pipeline, the bulk of Phase A) · Phase A1 (the stub crate needs only Rust/MSVC) · Phase A3 (all UI
on fake data) · Phase B plumbing (source toggles, types, `depthUnproject` code path, exercised via
fake gray/depth/K frames).

**RTX (CC ≥ 7.5) machine + ZED 2 only:** Phase A2 (building `zed-c-api` + the real `zed` feature,
first-run model optimization, live bodies, committing the real `zed.node`) · all live validation
(zones/takes live, calibration solve quality vs the PS3 Eye baseline, spatial mapping) · Phase C.
`ffi.rs` can be written blind against the zed-c-api headers, but not compiled/tested until the SDK
is installed — expect an iteration loop there.

## Verification

- Every phase: `npm run verify` (invariants + docs + typecheck) + `npm run build`.
- **Without hardware:** dev-run → ZED settings → **Simulate** → fake bodies orbit; zone on surface
  ZED fires a `lidar.zone` FSM rule; TRACKING surface with `trackingSource:'ZED'` renders on a
  projector output; splash shows `zed: degraded` cleanly on SDK-less machines. Phase B fake mode
  extends to synthetic gray/depth/K frames to exercise the wizard plumbing end-to-end.
- **With hardware:** real enable → walk the room → zones/viz/takes live; take replay swallows the
  live feed. Phase B: full auto-align vs the PS3 Eye baseline (RMS + physical scale); a
  commissioned `{source:'zed'}` profile reopens unattended.

## Key risks

1. `zed-c-api` has no prebuilts → build once with CMake/MSVC/CUDA on the hardware machine, commit
   the DLL beside `zed.node`.
2. First-run model optimization (minutes, needs internet) → surfaced in `zed:status`, documented as
   commissioning.
3. Depth noise at range → gray code stays authoritative; depth gated by confidence/range with
   per-pixel GLB-raycast fallback.
4. SDK version drift → pin one 5.x version, log the loaded version, document.
5. New plugin→plugin import (zed → lidar-tracking barrel) → barrel-only keeps single identity; the
   existing CHECKS marker catches duplication.

## Reference templates (reuse, don't reinvent)

`native/ndi/Cargo.toml` (feature gate) · `plugins/ndi/src/ndiManager.ts` (loader/PATH/status) ·
`plugins/ndi/src/plugin.main.ts` (push pattern) · `plugins/mediapipe/src/plugin.renderer.ts`
(renderer registration) · `plugins/calibration/src/calibNative.ts` (typed null-degrading IPC
wrapper) · `plugins/lidar-tracking/src/trackingStore.ts` (ingestion contract) ·
`scripts/lidar-emitter.cjs` (fake-data harness shape).
