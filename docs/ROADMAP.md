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
| **lidar-tracking** | ✅ shipped | Content source + OSC ingestion + clip-kind + projector data-channel + 3D-viz (scene-viz contribution) inverted. Projector blob *self-render* (GL draw) kept as transitional host import (see Deferred). |
| **ndi** | ✅ shipped | Receive fully inverted (content source + discovery via provider editor); send routed through the generic bridge. Forced the `MainTransport`→general `MainPluginContext.ipc` fix + main-side activation. |
| **calibration** | 🚧 Stage 1 + 2-foundation + 2b + 2c-writepath shipped | Engine + logic (1); host-services SDK surface + back-channel plugin (2-foundation); wizard/camera UIs relocated into `plugins/calibration` (2b); the wizards' **write path** (sendToProjector / storeCalibration / setUseCalibration / camMask / markerMap) rewired off App onto `ctx.host` via `calibHost.ts` (2c). Remaining: the App-owned **workspace** props (embedded-3D pick, camera portal, split, pose pairing) + registering as a panel contribution — the rig-verified deep part; and **Stage 3** (projector-contribution pattern render). |

Also done: the **timeline clip-kind** inversion — `timeline.ts` no longer hardcodes `kind==='tracking'`;
the lidar plugin registers the `tracking` kind into `clipKindRegistry` (first end-to-end consumer).

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
capabilities. This is the **host-services** object on `RendererPluginContext.host` (concrete in host,
generic in SDK). **The reusable core shipped (Stage 2 foundation):**

- ✅ `projectors`: `send(surfaceId, msg)` + `onMessage(cb)` — projector MessagePorts (wraps App's
  `sendToProjector` + the projector→main router). First consumer: the calibration renderer plugin taps
  `patternShown` here (moved out of `App`).
- ✅ `projectorOutputs`: `get(id)` / `list()` / `patch(id, partial)` / `subscribe(cb)` — read/patch
  `ProjectorOutput` (wraps `upsertOutput`). Consumed by the wizard move (Stage 2b) for `.calibration`.
- ✅ `scene3D`: `get()` / `patch(partial)` / `subscribe(cb)` — read/patch the 3D scene. Already
  consumed (LiDAR migrated off the old `getScene3D()`); the wizard move patches `camMask`/`markerMap`.
- ⏳ **Not yet** — the *workspace* bits calibration's wizards need beyond plain state: venue-mesh handle
  + `setPickMode(on)` + `onPick(cb)` for markerless picking, the camera-viewport DOM portal, and the
  split layout. These couple to App's embedded Simulator3D and move with the wizards (Stage 2b).
- `panels`: `PanelRegistry` already exists — the wizards register here when moved (first real use).

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

**Stage 2 foundation — host-services + back-channel (✅ shipped).**
1. ✅ Added the reusable host-services surface (`RendererHostServices` on `ctx.host`) to the SDK,
   implemented in `src/renderer/host/plugins.ts` (no-op impls for projector windows) + `App.tsx` (a
   stable object whose methods delegate to live refs; subscriber sets fired by change effects).
2. ✅ Added a calibration **renderer plugin** (`plugins/calibration/src/plugin.renderer.ts`, now in
   renderer `FIRST_PARTY`) that taps `ctx.host.projectors.onMessage` for `patternShown` →
   `calibController`/`slCapture` — removing that routing from `App`. Migrated LiDAR off `getScene3D()`.

**Stage 2b — relocate the wizard UIs (✅ shipped).** `git mv` the 4 wizard/camera UIs (`CalibWizard`,
`AutoAlignWizard`, `calib/CameraViewport`, `CameraParamsPanel`) into `plugins/calibration/src`; barrel
imports rewired to relative (barrel rule); host bridge type via `@/projector/bridge` (transitional).
Exported from the `/renderer` barrel; `App` imports the wizards from there and **mounts them with the
same props** (a documented seam — App still owns the embedded Simulator3D + camera portal they drive).
All calibration code now lives in the plugin. Verified build + tsc + single-identity + boot.

**Stage 2c — rewire the wizard write path (✅ shipped).** The wizards now perform mutations + IO through
`ctx.host` instead of App callback props: `plugins/calibration/src/calibHost.ts` stashes `ctx.host` (set
in the renderer plugin's `activate`) and exposes `sendToProjector` (→ `projectors.send`),
`storeCalibration` / `setUseCalibration` (→ `projectorOutputs.patch`), `storeCamMask` / `storeMarkerMap`
(→ `scene3D.patch`). Each wizard binds same-named locals to these (call sites unchanged) and drops the 5
props; `App` stops passing them (keeps its own `handleStoreCalibration`/`sendToProjector` for the pose
orchestration below + gamma). Reactive data (`output`/`scene3D`/`live`/`hasModel`) stays props.

**Stage 2d — the workspace + panel-ization (remaining, rig-verified).** What's left is the genuinely
App-coupled part: the wizards still take the embedded-Simulator3D pick handles (`onSetCalibPickMode`,
`onRegisterMarkerlessPick`/`Select`, `onPicksChange`, `onSelectionChange`, `onPoseModeChange`,
`onClearPoses`), the camera-viewport DOM portal (`cameraHost`), the split toggle, and lifecycle
(`surfaceId`/`onSwitchFlow`/`onClose`) as props, and App still owns `handleCalibPick` + the
crosshair/`pendingPixel` pose pairing. Inverting these (a calibration "workspace" surface + registering
the wizard as a panel contribution so App no longer mounts it) is the deep part — **do it on the rig**,
since the board/markerless pass can't be smoke-tested from a clean boot.

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

- **Projector-contribution** — DATA half ✅ and **GL render hook** ✅ shipped. Data: `ProjectorChannel`
  (appliesTo/subscribe/build/apply) + a generic `{t:'pluginData'}` bridge + projector-window plugin
  activation; LiDAR's snapshot→projector bridge rides it. GL render hook: `ProjectorChannel` gained
  `projectorSourceSize`/`renderSource`/`onConfig` + a `ProjectorRenderHost` (timeMs + getLayerDrawable);
  `ProjectorGL.drawTracking` → generic `drawComposited(w,h,composite,opts)` (host no longer imports
  `blobPass`/`trackingRenderer`); LiDAR composites bg+trails+blobs+overlay in `trackingProjector.ts`.
  **Remaining:** (a) **calibration's** projector pattern/3D rendering still lives in `ProjectorApp`
  transitionally (it needs the render hook + a back-channel, not just a source composite), and (b) the
  **projector→main back-channel** (for calibration's patternShown/crosshair/confirm).
- ~~**LiDAR 3D-viz tendril**~~ ✅ done — added a **scene-viz contribution** (`SceneVizContribution` +
  `sceneVizRegistry`): `TrackingViz` moved into the lidar plugin and registers as scene-viz; `Simulator3D`
  now maps `sceneVizRegistry.all()` inside its `<Canvas>` instead of importing `TrackingViz`.
- ~~**Timeline clip-kind inversion**~~ ✅ done — the literals are gone; the LiDAR plugin registers the
  `tracking` kind into `clipKindRegistry` (first end-to-end consumer).
- **Settings/panels registry inversion** — `settingsSectionRegistry` + `PanelRegistry` exist but are
  unused; migrate the LiDAR OSC/tracking settings + OscMonitor/TakesBin panels onto them (calibration
  Stage 2 is the first PanelRegistry consumer).
- **Public API stabilization** — once calibration (plugin #3) validates the host-services surface,
  write up `@artlux/sdk` as a documented, versioned public plugin API. Only then consider a
  third-party / disk-loaded plugin tier (manifest + semver host-range + capability model + sandboxing
  for non-realtime plugins).
- **SurfaceContent.type widening** — generalize to an open string space + a settings namespace
  (`AppSettings.plugins.*`) once a plugin needs a genuinely new content type (all so far reuse core
  enum values: `TRACKING`, `NDI`).
- **Plugin test harness** — no automated tests yet; a per-plugin contract/validation harness.
