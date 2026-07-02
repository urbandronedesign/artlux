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
| **lidar-tracking** | ✅ shipped | Content source + OSC ingestion + clip-kind + projector data-channel + 3D-viz (scene-viz) + projector blob GPU self-render (`ProjectorChannel.renderSource` → `trackingProjector.ts`) all inverted. Fully self-contained. |
| **ndi** | ✅ shipped | Receive fully inverted (content source + discovery via provider editor); send routed through the generic bridge. Forced the `MainTransport`→general `MainPluginContext.ipc` fix + main-side activation. |
| **calibration** | ✅ fully inverted (Stage 1 → 3) | Engine + logic (1); host-services + back-channel (2-foundation); wizard/camera UIs relocated (2b); write path via `calibHost.ts` (2c); pose orchestration → `calibWorkspace.ts` (2d); projector-side rendering → a `ProjectorPanelContribution` (`CalibProjector.tsx` + moved `ProjectorScene.tsx`) (3). `App`/`ProjectorApp`/`ProjectorGL` import zero calibration code. **Wizard UI rig-confirmed 2026-07-02** (needed the Tailwind `content` glob to scan `plugins/` — see PLUGINS.md gotchas). The board/markerless calibration *pass* itself still needs on-rig sign-off. |
| **spout** | ✅ shipped | Windows Spout video receive fully inverted — native `spoutManager` (main) + refcounted `spoutContentSource` provider + `SpoutEditor` (renderer), all over the generic plugin bridge. Receive-only (no send). `SourceType.SPOUT`/`SurfaceContent.spoutName` stay core. `spout-receiver.node` stays root `extraResources`. Runtime receive needs a Spout sender on the rig. |
| **hap** | ✅ shipped | HAP video codec fully inverted — native `hapManager` (main) + prefetch-ring `hapDecode` + WebGL2 BC-decompress `hapGL` + surface `hapPlayer` (renderer), registered as the first **`VideoCodec`** contribution. The three consumers (`contentSource` surfaces, the timeline LAYER engine, `thumbnailCache`) dispatch `.mov` through `videoCodecRegistry` — no HAP code left in core. `hap.node` stays root `extraResources`. Rig-verified for playback (surface HAP auto-plays on boot; timeline-layer + thumbnails need on-rig sign-off). |

Also done: the **timeline clip-kind** inversion — `timeline.ts` no longer hardcodes `kind==='tracking'`;
the lidar plugin registers the `tracking` kind into `clipKindRegistry` (first end-to-end consumer).

---

## Next: more video codecs (DXV, native MP4) via the `VideoCodec` contribution

The `hap` plugin established the **`VideoCodec`** contribution (`@artlux/sdk/renderer`): a decoder
registers `canDecode`/`probe`/`openSurface`/`surfaceFrame`/`layerFrame`/`thumbnail`/`setPlaying`/… and
the three consumers (`contentSource` surfaces, timeline LAYER engine, `thumbnailCache`) dispatch a file
path to the first codec whose `canDecode` matches. New codecs slot in with **no host changes** — just a
new plugin + `videoCodecRegistry.register`.

- **DXV** (Resolume's GPU codec, in `.mov`/`.avi`). Closest to HAP: all-intra, BC/GPU-decompressible.
  1. New Rust crate `native/dxv` (demux + per-frame block extract; DXV1–3). Mirror `native/hap`.
  2. `plugins/dxv` (cross-process): `dxvManager` (main, native) + `dxvDecode` (prefetch ring — reuse
     HAP's shape) + `dxvGL` (BC-decompress; DXV3 = DXT5+alpha, DXV1/2 = DXT1/5) + a `VideoCodec`.
     `canDecode` must probe the container's codec fourcc (both HAP and DXV live in `.mov`), so **codec
     probe order matters** — the registry returns the first `canDecode` true; make `probe` authoritative
     (open native, confirm fourcc) and have `canDecode` gate on extension only, letting `probe` decline.
  3. Register; `.mov` now tries HAP then DXV then falls back to `<video>` (H.264).
- ~~**Native MP4**~~ ✅ **shipped + working** (`plugins/mp4`, renderer-only) — GPU-accelerated H.264/H.265
  via `WebCodecs VideoDecoder` (`hardwareAcceleration:'prefer-hardware'`) + `mp4box` demux, registered as
  a `VideoCodec`. **Design:** demux once → keep only the tiny *encoded* samples (decode order); decode **on
  demand** around the playhead from the nearest keyframe; return the `VideoFrame` **directly** so the
  compositor uploads it zero-copy as a texture (no 2D-canvas round-trip). **Opt-in** via the `mp4WebCodecs`
  setting (off → `.mp4` keeps the default `<video>`). **Rig-tested on 4K/RTX A6000: plays smooth, loops
  clean.** Key correctness/perf lessons baked in:
  - **Feed in DECODE order, never presentation order** — sorting samples by `cts` feeds B-frames before
    their references → corruption. Drive seek/look-ahead off `cts` but keep the feed in decode order.
  - **Keep few *decoded* frames live** — a HW decoder's output-surface pool is small; holding ~24 live 4K
    `VideoFrame`s exhausts it and NVDEC *blocks* (the 4K-judder cause). Pace to ~`TARGET_AHEAD` frames
    ahead, retire past frames immediately, `optimizeForLatency:false` for throughput/reorder.
  - **Drop the buffer on a backward (loop-wrap/scrub) seek** — stale end-of-clip frames otherwise read as
    "ahead" and poison the feed-pacing counter → the loop freezes on round 2. Keep only the newest frame to
    cover the seam.
  - Thumbnails use **dedicated** decoders (isolated from the playing surface's decoder — reusing it made a
    filmstrip scrub reseek playback and stutter).
  - **Optimization pass — code landed, pending rig verification** (user stopped mid-test to continue in a
    later session): (a) **seamless loop** — the decoder feeds in an absolute index/timestamp space so a
    looping surface runs straight past the last sample into sample 0 (a keyframe) of the next loop with no
    reset/no buffer drop → no loop-seam hitch; (b) **per-layer timeline decoders** — each timeline codec
    clip gets its own seekable decoder (keyed by layerId) for frame-exact scrub, isolated from the surface's
    decoder. **Rig-confirmed working** (loop seam continuous; timeline scrub + timeline loop play cleanly on
    every pass — a loop-back freeze was fixed by detecting the playhead moving backward via lastWantUs).
    Still deferred: HEVC on-rig verify, DXV (native crate like HAP). (Full detail in the plugin-architecture
    memory.)

**Contract gaps to close when adding the 2nd codec:** `canDecode` currently returns the first match;
with HAP+DXV both `.mov`, make the registry try each codec's async `probe` in order and cache the winner
per path (today `contentSource`/`timeline` call `forPath` = first `canDecode`, then rely on `probe`
returning false to fall back — fine for one codec, needs the try-in-order loop for two).

---

## Next: `@artlux/plugin-spout` (Windows Spout video receive)

A direct parallel to the shipped **ndi** plugin, but **simpler**: Spout is Windows-only and **receive-only**
(no send path), so no generic-bridge send routing. Cross-process (`/main` + `/renderer` barrels). The
NDI plugin is the exact template — mirror `ndiManager`/`ndiReceiver`/`ndiContentSource`/`NdiEditor`.

**Current wiring to invert (all mirrors NDI's pre-extraction state):**
- Main: `src/main/transport/spoutManager.ts` (native `spout-receiver.node` — setCap/listSenders/start/stop);
  `src/main/ipc.ts` `SPOUT_LIST`/`SPOUT_CONFIGURE`/`SPOUT_FRAME` handlers; `src/main/index.ts` broadcast
  `spout.setCap(1920,1080)`.
- Renderer: `src/renderer/services/spoutReceiver.ts` (uses `window.artlux.configureSpout`/`onSpoutFrame`/
  `listSpoutSenders`); `src/renderer/services/contentSource.ts` still has the **built-in** SPOUT dispatch
  (`spoutConsumers`/`reconcileSpout`/`getSpoutCanvas`) — NDI's equivalent was removed when it became a
  provider; `src/renderer/components/ContentEditor.tsx` SPOUT picker button + sender dropdown.
- Core stays: `SourceType.SPOUT`, `SurfaceContent.spoutName`. `SpoutConfig`/`SpoutFrame` + the `SPOUT_*`
  IPC consts + `ArtluxApi.{listSpoutSenders,configureSpout,onSpoutFrame}` move to the plugin.

**Steps (mirror ndi):**
1. Create `plugins/spout/` (`/main`+`/renderer` barrels, `sideEffects:false`); alias in
   `electron.vite.config.ts` + `tsconfig.json`; `npm install` (lockfile).
2. Main: move `spoutManager.ts` in; `plugin.main.ts` registers `spout:list` (handle), `spout:configure`
   (on → start/stop, push frames via `ctx.ipc.send('spout:frame', …)`); broadcast setCap via a
   transitional `@artlux/plugin-spout/main` import in `main/index.ts` (like NDI's recv-cap). Move
   `SpoutConfig`/`SpoutFrame` to plugin `types.ts`.
3. Renderer: move `spoutReceiver.ts` in, rewire to `pluginInvoke/Send/On`; add `spoutContentSource.ts`
   (a `ContentSourceProvider` — move `reconcileSpout`/refcount/`getSpoutCanvas` out of `contentSource.ts`
   into acquire/release/getDrawable + `getAspect`); `SpoutEditor.tsx` (the provider's `editor` +
   `pickerButton`).
4. Strip core: remove SPOUT from `contentSource.ts`, `ContentEditor.tsx`, `ipc.ts`, `preload/index.ts`,
   `shared/protocol.ts` (`SPOUT_*` consts + spout `ArtluxApi` methods + `SpoutConfig`/`SpoutFrame`). Keep
   `SourceType.SPOUT`/`SurfaceContent.spoutName`.
5. Add to `FIRST_PARTY` (main + renderer). `spout-receiver.node` stays **root** `extraResources`
   (electron-builder reads root only). Add a `spout:configure` marker to `scripts/verify-plugins.cjs`.
6. Verify: build + tsc + `npm run verify:plugins` + clean boot (`[spout] native receiver loaded` via the
   plugin). Runtime: needs a Spout **sender** on the Windows rig (OBS Spout-out / Resolume / TouchDesigner)
   — the user can confirm receive end-to-end (unlike NDI which needed an external NDI source).

**Risk:** low — smallest real extraction (receive-only, one native, NDI-proven pattern). No new SDK
surface. `spoutManager` is Windows-only + graceful-degrades, so non-Windows/CI still builds+boots.

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
props; `App` stops passing them (keeps its own `sendToProjector` for gamma). Reactive data
(`output`/`scene3D`/`live`/`hasModel`) stays props.

**Stage 2d — move the pose-pairing orchestration off App (✅ shipped).** Chosen mechanism: the
*orchestration move* (not panel-ization — the wizard is a Stage-coupled workspace, so a no-props panel +
App→plugin store would add indirection for the same coupling). New `plugins/calibration/src/calibWorkspace.ts`
owns the board/markerless pose logic that lived in App — `pick(world)` (crosshair↔model-pick pairing),
`solvePose` (solvePnP via `calibNative`), `poseModeChange`/`clearPoses`, the `pendingPixel`/`latestCrosshair`
refs, and `registerMarkerlessPick`/`Select` + `selectPick`. The crosshair/confirm back-channel moved into
the plugin's `host.projectors.onMessage` tap; `App` forwards embedded-3D picks via `onCalibPick={(w) =>
calibWorkspace.pick(w)}` and syncs the target via `setTarget(calibratingOutputId)`. App shed
`handleStoreCalibration`/`solvePose`/`handleCalibPick`/`handlePoseModeChange`/`handleClearPoses` + 4 refs +
the `calibNative` import. The wizard **rendering** (embedded Simulator3D + camera portal) + UI state stay
App-owned by design. **Rig-verified:** build/tsc/single-identity/boot pass; the board/markerless pass
needs camera+projector.

**Stage 3 — Projector-panel contribution (✅ shipped, the "full" option).** Added a
`ProjectorPanelContribution` to the SDK: a plugin React component the projector window mounts full-window
over the base GL canvas, with a `ProjectorPanelContext` = `{ onMessage, send }` (the projector's
bidirectional bridge) + a reactive `size`. `ProjectorApp` now mounts every registered panel generically
(fanning the main→projector message stream to `panelMsgSubs`) and no longer imports calibration — the
structured-light pattern (raw pixel-exact 2D canvas + double-rAF `patternShown` ack), the pose crosshair
(pointer/key capture → `calibCrosshair`/`calibConfirm`), and render-from-projector all moved into
`plugins/calibration/src/CalibProjector.tsx` (+ `ProjectorScene.tsx` moved in, importing the host
`useLayerTexture` via `@/` transitionally). The projector chunk shrank ~11 KB; `calibCrosshair`/
`patternShown` now live only in the plugins chunk. **Rig-verified:** build/tsc/single-identity/boot pass,
but pattern display / crosshair / render-from-projector — and the normal projector-output path through the
rewired mount — need a real projector to confirm.

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

- ~~**Projector-contribution**~~ ✅ complete. Three seams shipped: (1) **data channel** — `ProjectorChannel`
  (appliesTo/subscribe/build/apply) + a generic `{t:'pluginData'}` bridge (LiDAR snapshots); (2) **GPU
  render hook** — `ProjectorChannel.{projectorSourceSize,renderSource,onConfig}` + `ProjectorRenderHost`;
  `ProjectorGL.drawTracking` → generic `drawComposited` (LiDAR blob composite in `trackingProjector.ts`);
  (3) **projector-panel** — `ProjectorPanelContribution` (a full-window React overlay + a bidirectional
  `ProjectorPanelContext`) for calibration's pattern/crosshair/render (`CalibProjector.tsx`). The
  projector→main **back-channel** rides `ProjectorPanelContext.send` + the main-side `host.projectors.onMessage`
  tap. `ProjectorApp`/`ProjectorGL` no longer import any plugin.
- ~~**LiDAR 3D-viz tendril**~~ ✅ done — added a **scene-viz contribution** (`SceneVizContribution` +
  `sceneVizRegistry`): `TrackingViz` moved into the lidar plugin and registers as scene-viz; `Simulator3D`
  now maps `sceneVizRegistry.all()` inside its `<Canvas>` instead of importing `TrackingViz`.
- ~~**Timeline clip-kind inversion**~~ ✅ done — the literals are gone; the LiDAR plugin registers the
  `tracking` kind into `clipKindRegistry` (first end-to-end consumer).
- ~~**Settings/panels registry inversion**~~ ✅ done — both registries now have real consumers.
  **Settings sections:** Preferences renders `settingsSectionRegistry.all()` after the core sections; the
  **mp4** plugin contributes the "Video" (GPU-decode) section (`VideoSettings.tsx`) — the `mp4WebCodecs`
  field stays core (persisted), only its editor moved. **Modal panels:** App mounts `panelRegistry.byMount('modal')`
  and routes menu actions to them (a `default:` case toggles the panel whose `menuAction` matches); the
  **lidar** plugin contributes **OscMonitor** (moved out of core, toggled by the `osc-monitor` menu action).
  Grew the SDK: `host.settings` (read + subscribe) on `RendererHostServices` (a modal panel has no props
  path to settings — OscMonitor reads live OSC settings via `trackingHost.useHostSettings`), and
  `PanelContribution.Component` now takes `PanelProps { onClose? }`. **Left core on purpose:** the
  OSC/Tracking Preferences section (OSC is shared control + tracking infra, not plugin-specific) and
  **TakesBin** (tightly timeline-engine-coupled — takes/record/lane/remove all from Timeline's own logic;
  inverting it would over-fit the SDK). `dock`/`timeline-bin` panel mounts were **trimmed** (see below).
- ~~**Public API stabilization (write-up)**~~ ✅ done — [docs/SDK.md](SDK.md) documents the API surface
  (registries / host-services / IPC bridge), the **UNSTABLE/INTERNAL** stability policy, the invariants
  a plugin must uphold, the layered testing model, and the concrete gate to a versioned third-party API
  (contract soak → semver + host-range → capability model → sandboxing → disk loading). The third-party
  *tier itself* remains future work (tracked there), not this write-up.
- ~~**SurfaceContent.type widening**~~ ✅ done — `SurfaceContent.type` is now
  `SourceType | 'EFFECT' | (string & {})` (open to plugin type strings; the compositor already
  dispatches unknown types through `contentSourceRegistry`), plus an `AppSettings.plugins?:
  Record<string, unknown>` namespace for plugin-private prefs. Core enum + top-level persisted fields
  unchanged → zero migration. (No plugin *uses* a new string type yet — the surface is now ready.)
- ~~**Plugin test harness (static)**~~ ✅ extended — `npm run verify:plugins` now asserts single-identity
  **and** contribution-coverage (each guarded UI contribution string is present in the build; catches a
  settings section / panel that silently stops registering). Type conformance is enforced by `tsc` via
  the `RendererPlugin[]`/`MainPlugin[]` arrays. **Still deferred:** a *runtime* behavioral harness
  (mock-context activation → assert registrations → IPC round-trip) — blocked on a headless activation
  environment (plugins import host `@/` + browser/GPU globals at import time). See docs/SDK.md → testing.
- **Panel mounts trimmed to `'modal'`** — `dock`/`timeline-bin` had no consumer; an unstable SDK
  shouldn't ship speculative surface. Re-add a mount kind together with its host mount point when a real
  consumer appears.
