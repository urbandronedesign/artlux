# ArtLux — Plugin Architecture Roadmap

Forward-looking backlog for the plugin-architecture migration. For how the app works today see
[ARCHITECTURE.md](ARCHITECTURE.md); for the historical pre-Electron rewrite see
[ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md).

## Direction

ArtLux is being restructured around an **in-process, contribution-based plugin architecture**
(VS Code style). Decisions (locked):

- **In-process, trusted plugins** — bundled into the app's own main + renderer contexts, sharing
  memory/GPU. No sandbox (required for 61fps realtime + GPU paths). First-party only for now.
- **In-tree plugins against an UNSTABLE `@artlux/sdk`** — no public/versioned API or third-party
  disk-loading until enough plugins validate the contracts.
- **npm workspaces monorepo** — host app + `@artlux/sdk` + `plugins/*`.

Layout: `packages/sdk` (`@artlux/sdk`, subpaths `/main` + `/renderer`), `plugins/<name>` (barrels
per process), host registries in `src/renderer/host/registries.ts` + activation in
`src/{renderer,main}/host/plugins.ts`, generic plugin IPC bridge in preload
(`pluginInvoke/Send/On`, namespaced `plugin:<ch>`).

**Bundling rule (learned the hard way):** host imports a plugin ONLY through its barrel; internals
import each other relatively; `sideEffects:false` in the plugin package. Mixing the package alias
with relative imports duplicates singletons (writers hit one instance, readers the empty other).

## Status

| Plugin | State | Notes |
|---|---|---|
| **lidar-tracking** | ✅ shipped | Content source + OSC ingestion cleanly inverted. 3D-viz + projector self-render kept as transitional host→plugin imports (see Deferred). |
| **ndi** | ✅ shipped | Receive fully inverted (content source + discovery via provider editor); send routed through the generic bridge. Forced the `MainTransport`→general `MainPluginContext.ipc` fix + main-side activation. |
| **calibration** | 📋 planned | This document, below. The largest extraction. |

---

## Next: `@artlux/plugin-calibration` (projector auto-calibration)

Projector auto-calibration is a whole application *mode* — ~33 files, structured-light capture
(projector displays patterns ↔ camera captures ↔ OpenCV solves ↔ writes warp/pose). Worthwhile
(self-contained conceptually) and it forces the SDK's next real growth: a **host-services** surface
for feature plugins, and optionally the deferred **projector-contribution** seam.

### What's what (from the subsystem map)

- **Engine is clean.** `src/main/calibManager.ts` (calib.node/OpenCV) = 16 request/response methods
  (detect board/ArUco, mapCorners, calibrate{Projector,Guided}, solvePnp{,Ransac}, decodeDense,
  selfCalibrate, camera open/grab/close/get/set-prop) + `isAvailable`. No coupling to
  output/input/ndi/nvwarp. Native load is `process.resourcesPath`-based → survives the move; needs
  `calib.node` **+ `opencv_world4110.dll` (~64 MB)** in the plugin's `extraResources`.
- **Renderer logic, three tiers.** Pure math: `graycode`, `blendCompute`, `camMask`, `cvCamera`,
  `mpcdiData`, `venueRaycast` (three.js only). Orchestration (native + projector `send` callback +
  camera): `calibController`, `slCapture`, `markerlessController`, `calibCapture`, `gammaController`.
  UI (React-coupled to App state): `CalibWizard`, `AutoAlignWizard`, `components/calib/{CameraViewport,CameraParamsPanel}`.
- **Persisted state stays core.** `ProjectorCalibration` + `ProjectorOutput.calibration/useCalibration`
  and `scene3D.markerMap/camMask` are in the project file → stay in `shared/protocol.ts` / `types.ts`
  (like `SourceType.NDI` stayed core). Transient RPC result types move to the plugin.
- **Projector coupling is the crux.** Bidirectional over the MessagePort: main→projector
  `{t:'calib',mode}` / `{t:'calibPattern',kind,index,rgb}` / `{t:'scene'}`; projector→main
  `{t:'patternShown'}` / `{t:'calibCrosshair'}` / `{t:'calibConfirm'}`. `ProjectorApp` owns the mode
  gate + pattern render (`fillPattern`) + crosshair capture + `ProjectorScene` (3D render-from-projector).
- **NVWARP is orthogonal** (2D hardware scanout warp, `hwWarp` flag) — NOT part of calibration. Leave it.

### New SDK surface this requires

Calibration is a *feature* plugin (not content-source/transport) — it must reach core app
capabilities. Add a **host-services** object to `RendererPluginContext` (concrete in host, generic in
SDK) exposing only what calibration needs:

- `projectors`: `send(surfaceId, msg)` + `onMessage(cb)` — projector MessagePorts (wraps App's
  `sendToProjector` + `onProjectorMsg`).
- `projectorOutputs`: `get()` / `patch(surfaceId, partial)` — read/patch `ProjectorOutput` (wraps
  `upsertOutput`; plugin patches `.calibration`).
- `scene3D`: `get()` / `patch(partial)` + venue-mesh handle + `setPickMode(on)` + `onPick(cb)` — for
  markerless picking + raycast.
- `panels`: already exists (`PanelRegistry`) — the wizards register here (first real use).

This host-services surface is the significant, reusable API growth — evidence for the eventual
public-API doc.

### Staged plan

**Stage 1 — Engine + logic (clean, low-risk, mirrors NDI).** Create `plugins/calibration/` with
`/main` + `/renderer` barrels.
1. Main: move `calibManager.ts` in; `plugin.main.ts` registers all 16 methods via `ctx.ipc.handle`/`on`
   (`calib:available`, `calib:detect-board`, … `calib:camera-*`); add quit hook → `cameraClose()`;
   move transient RPC types to plugin `types.ts`.
2. Renderer logic: move pure-math + orchestration modules in; rewire native calls
   `window.artlux.calib*` → `pluginInvoke('calib:*')` via a thin `calibNative.ts`.
3. Native packaging: `calib.node` + `opencv_world4110.dll` → plugin `extraResources`; remove from root.
4. Strip core: `CALIB_*` out of ipc/preload/protocol IPC consts + ArtluxApi `calib*` methods; keep
   `ProjectorCalibration`/`ProjectorOutput` types core.
5. Wire into `activateMainPlugins`; add `@artlux/plugin-calibration/{main,renderer}` aliases.
   **Verify:** build + typecheck + single-identity (calib.node once in main) + clean boot with
   `[calib] native OpenCV addon loaded` firing via the plugin.

**Stage 2 — Wizards as panel contributions + host-services.**
1. Add the host-services surface (above) to `RendererPluginContext`, implemented in
   `src/renderer/host/plugins.ts` (wrapping App's `sendToProjector`, `upsertOutput`, scene3D setters,
   pick refs).
2. Move the 4 wizard/camera UIs in; register as **panel contributions** (`mount:'modal'`, toggled by
   `calibratingOutputId`); rewire their props to host-services handles.
3. Remove wizard mounts + calib orchestration from `App.tsx`; App keeps the port registry,
   `calibratingOutputId` toggle, and host-services wiring.
   **Verify:** open a wizard, run a board/markerless pass (needs camera + projector), confirm results
   write to `ProjectorOutput.calibration` and the projector renders from the pose.

**Stage 3 — Projector-contribution seam (decide: pragmatic vs. full).** The projector-side
pattern/crosshair/`ProjectorScene` rendering lives in `ProjectorApp`.
- **Pragmatic (recommended first):** leave it in `ProjectorApp` as a transitional host seam (same as
  LiDAR's projector self-render). Ship Stages 1–2; calibration fully works.
- **Full:** design a **projector-contribution** SDK type (plugin drives projector-window rendering +
  a typed bidirectional channel). Bigger investment, but it also inverts LiDAR's deferred projector
  tendril. Dedicated follow-up once Stages 1–2 are proven.

### Critical files
- Engine/native: `src/main/calibManager.ts`, `src/main/ipc.ts` (CALIB_*), `src/preload/index.ts`
  (calib*), `shared/protocol.ts` (IPC consts + transient types; keep `ProjectorCalibration`/`ProjectorOutput`),
  `package.json` (extraResources), `src/main/index.ts` (quit cleanup).
- Renderer logic: `src/renderer/calib/*` (10 files), `src/renderer/services/calibCapture.ts`.
- UI: `src/renderer/components/{CalibWizard,AutoAlignWizard}.tsx`, `src/renderer/components/calib/{CameraViewport,CameraParamsPanel}.tsx`.
- Host wiring: `src/renderer/App.tsx` (`calibratingOutputId`, `sendToProjector`, `handleStoreCalibration`/`upsertOutput`,
  `solvePose`, pick refs), `src/renderer/host/plugins.ts`, `src/renderer/projector/{bridge,ProjectorApp,ProjectorScene,ProjectorGL}.tsx` (Stage 3 only).
- Leave untouched: `nvwarpApply.ts` / `nvwarpManager.ts`.

### Risks / notes
- Biggest extraction yet (~2500 lines) — stage it; build + typecheck after each stage.
- Single-identity discipline (the LiDAR lesson): barrels only from host; internals relative;
  `sideEffects:false`; verify calib.node appears once in the main bundle.
- Runtime verification needs hardware (camera + projector). Smoke-test = clean boot + native-loads-
  via-plugin + wizard opens + camera-grab; the real calibration pass is a hardware task.
- Persisted-state compatibility: `ProjectorCalibration` byte-identical in the project file → existing
  calibrated projects load unchanged.
- Native ownership move (calib.node + 64 MB DLL → plugin extraResources) — double-check `electron-builder`.

---

## Deferred backlog (accumulated from shipped plugins)

- **LiDAR projector self-render + 3D-viz tendrils** — currently transitional host→plugin imports
  (`ProjectorApp`/`ProjectorGL`, `Simulator3D/TrackingViz`). Fully inverting needs the
  **projector-contribution** + a **scene-viz contribution** SDK type. The projector-contribution is
  shared with calibration Stage 3 — build once, use for both.
- **Timeline clip-kind inversion** — `timeline.ts` still uses `kind === 'tracking'` literals;
  `clipKindRegistry` exists but is unused. Swap the literals to registry lookups and register the
  `tracking` kind from the LiDAR plugin.
- **Settings/panels registry inversion** — `settingsSectionRegistry` + `PanelRegistry` exist but are
  unused; migrate the LiDAR OSC/tracking settings + OscMonitor/TakesBin panels onto them (calibration
  Stage 2 is the first PanelRegistry consumer).
- **Scene-viz contribution** — 3D-scene visualization contribution type (LiDAR TrackingViz, and any
  future 3D overlays).
- **Public API stabilization** — once calibration (plugin #3) validates the host-services surface,
  write up `@artlux/sdk` as a documented, versioned public plugin API. Only then consider a
  third-party / disk-loaded plugin tier (manifest + semver host-range + capability model + sandboxing
  for non-realtime plugins).
- **SurfaceContent.type widening** — generalize to an open string space + a settings namespace
  (`AppSettings.plugins.*`) once a plugin needs a genuinely new content type (all so far reuse core
  enum values: `TRACKING`, `NDI`).
- **Plugin test harness** — no automated tests yet; a per-plugin contract/validation harness.
