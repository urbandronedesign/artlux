# CLAUDE.md

Entry point for Claude Code **and** human contributors. Orients you, gives the working loop, documents
the plugin architecture (the active migration — not covered in the older docs), and indexes the deep
docs. When a topic has a dedicated doc below, read it rather than reverse-engineering the code.

## What ArtLux is

A GPU-accelerated **addressable-LED pixel-mapping + projection-mapping** desktop app (Electron · React 19
· TypeScript · Vite/electron-vite · WebGPU · react-three-fiber · Rust napi-rs). It maps content
(video / image / camera / Spout / NDI / DMX-in / generative effects / LiDAR tracking) onto stage
**surfaces**, samples per-fixture LED colors on the GPU, and outputs **Art-Net / sACN** via a native Rust
engine — plus **projector** outputs with warp/blend and OpenCV auto-calibration. Also: a timeline NLE,
a project-level state machine, scenes/cues, OSC control, and a 3D simulator.

## Documentation index (read the relevant one before diving in)

| Topic | Doc |
|---|---|
| **How the system fits together (canonical)** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **Setup / build / test / release + env gotchas** | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| **Plugin architecture — developer guide** | [docs/PLUGINS.md](docs/PLUGINS.md) |
| **Plugin-architecture roadmap + next extraction plan** | [docs/ROADMAP.md](docs/ROADMAP.md) |
| Surfaces engine (content/mapping model) | [docs/SURFACES.md](docs/SURFACES.md) |
| Outputs / controllers / routing | [docs/OUTPUTS.md](docs/OUTPUTS.md) |
| LED map / fixture geometry | [docs/LEDMAP.md](docs/LEDMAP.md) |
| Timeline NLE | [docs/TIMELINE.md](docs/TIMELINE.md) |
| Scenes & cues | [docs/SCENES.md](docs/SCENES.md) |
| Projector calibration (structured light + pose) | [docs/CALIBRATION.md](docs/CALIBRATION.md), [docs/AUTO-ALIGN.md](docs/AUTO-ALIGN.md), [docs/CALIB-OPTIMIZATIONS.md](docs/CALIB-OPTIMIZATIONS.md) |
| NVIDIA hardware warp/blend | [docs/NVWARP.md](docs/NVWARP.md) |
| NDI network video | [docs/NDI.md](docs/NDI.md) |
| OSC control + LiDAR tracking protocol | [docs/OSC.md](docs/OSC.md), [docs/TRACKING_SYNC.md](docs/TRACKING_SYNC.md), [docs/TRACKING_TAKES.md](docs/TRACKING_TAKES.md) |
| Assets / portable projects | [docs/ASSETS.md](docs/ASSETS.md) |
| Metrics / monitoring | [docs/MONITORING.md](docs/MONITORING.md) |
| Feature overview / user guide | [docs/FEATURES.md](docs/FEATURES.md), [docs/USER_GUIDE.md](docs/USER_GUIDE.md), `docs/user-guide/` |
| Build log (chronological) | [docs/PROGRESS.md](docs/PROGRESS.md), [CHANGELOG.md](CHANGELOG.md) |

## Commands & the working loop

```bash
npm install
npm run build:native          # Rust crates → native/*/*.node (gitignored). Also: build:ndi / build:calib / build:nvwarp
npm run dev                   # electron-vite dev + launch the app (hot-reloads the renderer)
```
- **Typecheck (do this — there's no test suite):** `npx tsc -p tsconfig.json --noEmit` (checks the whole tree).
- **Build:** `npm run build` (main + preload + renderer). Needed after adding an HTML entry / dep / native change.
- **Package:** `npm run package` (installers) or `npm run package:dir` (unpacked, fast smoke test).
- **Verify a change in the real app:** run `npm run dev` and exercise it. There is no unit-test runner;
  see DEVELOPMENT.md → Testing for the patterns (throwaway `tsc`-checked scripts for pure logic;
  `--headless --project=<file>` + a `dgram` listener parsing ArtDmx/sACN for output; the LiDAR emitter
  `node scripts/lidar-emitter.cjs` for tracking; CDP `scripts/capture-docs.cjs` for renderer screenshots).

**Loop rules:**
- **Renderer** code hot-reloads. **Main / preload** changes need a **full app restart** (stop dev, kill
  stray `electron`, relaunch).
- **Rebuilding a native `.node` while the app runs fails `EBUSY`** — stop dev + kill `electron` first.
- Native addons **degrade gracefully** when missing/unbuilt (feature disabled + a `[module] unavailable`
  log, never a crash). If a native feature "does nothing," check it built and loaded.
- This repo **commits directly to `main`** (small, scoped commits). **Push/commit only when asked.** Keep
  the tree buildable + typechecking clean. Releases are driven by a `vX.Y.Z` tag (DEVELOPMENT.md → Release).

## Repo layout

```
src/main/            Electron main: lifecycle, windows, native loading, persistence
  transport/         Art-Net/sACN output engine wrapper, sACN, discovery, input, spout/hap managers
  host/              main-side plugin activation (plugins.ts)
src/preload/         contextBridge → the typed `window.artlux` API (contextIsolation ON)
src/renderer/        React UI + the frame-generation loop
  components/        UI (Stage, panels, wizards, timeline/, Simulator3D/, calib/)
  services/          engine singletons: contentSource, surfaceMedia, timeline, stateMachine,
                     cueBus, dmxSignal, addressing, mediaCache, …
  gpu/               WebGPUMapper (WGSL compute), GPUMapper (WebGL fallback), surfaceFx, palettes
  projector/         per-surface fullscreen output window (ProjectorApp) + MessagePort bridge
  calib/             projector-calibration logic (structured light, gray code, pose, blend) — see ROADMAP
  host/              renderer-side plugin registries + activation
shared/              protocol.ts (IPC contract + `ArtluxApi` + shared types), frameCodec.ts
native/              Rust/C++ napi crates: output-engine, spout-receiver, hap, calib, ndi, nvwarp
packages/sdk/        @artlux/sdk — internal plugin SDK (subpaths /main, /renderer)
plugins/             first-party plugins: lidar-tracking, ndi
docs/                topic docs (see index above)
scripts/             build/copy helpers, doc capture, lidar emitter
```

## Architecture in brief (full detail: docs/ARCHITECTURE.md)

Three processes: **main** (OS access — UDP, fs, `.node` addons), **preload** (`window.artlux` over IPC),
**renderer** (React + the GPU frame loop). Three renderer HTML entries: `index.html` (editor + embedded
3D + timeline), `projector.html` (per-display fullscreen output), `headless.html` (compute-only).

- **IPC contract:** `shared/protocol.ts` — `IPC` channel constants, the `ArtluxApi` interface, shared
  types. Imported by all three processes. `.on/.send` = fire-and-forget; `.invoke/.handle` = req/response.
- **Frame pipeline** (`components/Stage.tsx` `tick()`): composite surfaces → per-surface WebGPU sampling
  (strict per-surface UVs) → universe packing (color order + gamma + channels/pixel) → publish over
  `dmx:frame` → main → native output engine.
- **Projector windows** talk to the main window over a **MessagePort** bridge
  (`renderer/projector/bridge.ts`), NOT ipc.
- **Persistence** (`main/persistence.ts` + `projectFolder.ts`): `.artlux` JSON projects (portable
  folders with `assets/`); **all asset-path translation lives in main — the renderer always sees absolute
  paths.** Prefs in `userData/artlux-prefs.json`.
- **Domain model** (`renderer/types.ts`): `Surface` (rect + one `SurfaceContent`), `Fixture` (LED layout
  linked to one surface), `Controller` (output device), `Scene`/`Cue`, `Timeline`, `StateMachine`,
  `ProjectorOutput` (+ `ProjectorCalibration`).

## Native modules

Six napi crates in `native/`, loaded in **main** via `process.resourcesPath`-based paths, packaged as
electron-builder `extraResources`, all graceful-degrading:

| Crate | Purpose | Loaded by |
|---|---|---|
| `output-engine` | Art-Net/sACN send thread (pacer, keep-alive, sparse, ArtSync) | `transport/outputManager.ts` |
| `spout-receiver` | Windows Spout video receive | **`@artlux/plugin-spout`** |
| `hap` | HAP video codec decode | `transport/hapManager.ts` |
| `ndi` | NDI network video (receive + send) | **`@artlux/plugin-ndi`** |
| `calib` | OpenCV projector calibration (needs `opencv_world4110.dll`) | `main/calibManager.ts` (→ plugin, see ROADMAP) |
| `nvwarp` | NVIDIA NVAPI scanout warp/blend (Quadro/RTX) | `main/nvwarpManager.ts` |

Toolchain: Rust (rustup, stable) + MSVC on Windows; `calib` additionally needs OpenCV + LLVM (built in a
vcvars64 env — see `scripts/build-calib.ps1`). `.node` files are gitignored.

## Plugin architecture (active migration — guide: docs/PLUGINS.md · roadmap: docs/ROADMAP.md)

The app is being restructured into an **in-process, contribution-based plugin architecture** (VS Code
style), so features become self-contained first-party plugins. Shipped: `plugins/lidar-tracking`
(fully inverted — content source, clip-kind, projector data + GPU-render channel, 3D scene-viz),
`plugins/ndi`, `plugins/calibration` (fully inverted through Stage 3 — engine, host-services,
back-channel, wizards, pose orchestration, projector-panel rendering; App/ProjectorApp import zero
calibration code), and `plugins/spout` (Windows Spout receive — a receive-only NDI-shaped extraction).
The SDK now spans content-source, clip-kind, projector (data + GPU + panel), scene-viz, and
host-services contributions. `npm run verify:plugins` guards single-identity. See ROADMAP for backlog.

- **Workspaces:** host app + `@artlux/sdk` (`packages/sdk`, subpaths `/main` + `/renderer`) + `plugins/*`.
- **SDK is internal + UNSTABLE** — no public/versioned API or third-party disk-loading yet.
- **Host wiring:** contribution registries in `src/renderer/host/registries.ts` (content source, clip
  kind, projector channel, settings section, panel); plugin activation in `src/renderer/host/plugins.ts`
  and `src/main/host/plugins.ts`.
- **Generic plugin IPC bridge** in the preload: `pluginInvoke` / `pluginSend` / `pluginOn`, channels
  namespaced `plugin:<ch>` (contextIsolation means plugins can't add named preload methods). Main-side
  plugins get a `ctx.ipc.{handle,on,send}`.

**Conventions when touching / adding plugins (non-negotiable):**
- **Barrel-only imports (this caused a real bug):** host code imports a plugin ONLY through its barrel
  (`@artlux/plugin-x`, or `@artlux/plugin-x/{main,renderer}` for cross-process plugins); the plugin's own
  files import each other **relatively**; set `"sideEffects": false` in the plugin package.json. Mixing
  the package alias with relative imports makes the bundler treat them as two modules and **duplicates
  singletons** (writers hit one instance, readers the empty other). Verify with a unique string marker —
  the singleton must appear once per window bundle (`grep -o "<marker>" out/.../*.js | wc -l`).
- **Core stays core:** persisted project types and enum values used across the app (`SourceType.NDI`/
  `TRACKING`, `ProjectorCalibration`, `SurfaceContent.ndiName`, …) stay in `shared/protocol.ts` /
  `renderer/types.ts`. Only *behavior* moves into the plugin → zero project-file migration.
- **Cross-process plugins** (native in main + UI in renderer, e.g. ndi/calib) use explicit `/main` +
  `/renderer` barrels like the SDK; renderer-only plugins (lidar-tracking) use one barrel.
- **Structural edits don't HMR cleanly into open projector windows** — close & reopen them after such
  changes when testing.

## Conventions

- **Match the surrounding code:** dense, heavily-commented explaining **why** (not what); the comment
  density in existing files is intentional. ES2022, strict-ish TS, `moduleResolution: "bundler"`.
- The renderer **repaints per-frame during playback** — memoize child panels (`React.memo`) or a native
  `<select>` will drop selections mid-interaction.
- Camera/mic surfaces need the main process to grant the `'media'` permission — see DEVELOPMENT.md if a
  live camera source stays blank.
- Keep commit messages quote-free-ish when authored via PowerShell here-strings (DEVELOPMENT.md gotcha).
