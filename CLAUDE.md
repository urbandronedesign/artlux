# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What ArtLux is

A GPU-accelerated **addressable-LED pixel-mapping + projection** app (Electron + React 19). It maps
video/image/camera/effect/NDI/LiDAR content onto stage **surfaces**, samples per-fixture colors on the
GPU, and outputs **Art-Net / sACN** (native engine) plus **projector** outputs with warp/blend and
OpenCV auto-calibration. Also: a timeline NLE, a project-level state machine, scenes/cues, and a 3D
simulator.

## Commands

- `npm run dev` — electron-vite dev (live reload). Launches the Electron app.
- `npm run build` — production bundle (main + preload + renderer).
- `npx tsc -p tsconfig.json --noEmit` — typecheck (there is **no** dedicated `typecheck` script and
  **no test suite**; verify changes with build + typecheck + running the app).
- `npm run package` — electron-builder installer.
- Native modules (Rust napi + C++): `npm run build:native` (output-engine/spout/hap), `build:calib`
  (OpenCV — needs C:\opencv + LLVM + MSVC, built in a vcvars64 env), `build:ndi`, `build:nvwarp`.
  Native addons degrade gracefully when absent (feature disabled, not a crash).

CLI flags: `--headless` (compute-only), `--broadcast` (hidden editor + fullscreen projector outputs),
`--project=<path>`.

## Architecture

Three processes (electron-vite, three renderer HTML entries: `index.html` editor, `projector.html`
per-surface fullscreen output, `headless.html`):

- **main** (`src/main`) — window/lifecycle, native module loading, persistence, transports
  (`src/main/transport/*`), projector windows.
- **preload** (`src/preload/index.ts`) — contextBridge exposes the typed `window.artlux` API
  (contextIsolation on; renderer can't `require` natives).
- **renderer** (`src/renderer`) — React UI + the WebGL/WebGPU mapping engine + R3F 3D scene.

- **IPC contract**: `shared/protocol.ts` — the `IPC` channel constants, the `ArtluxApi` interface, and
  shared types. Imported by all three processes.
- **Projector windows** talk to the main window over a **MessagePort** bridge
  (`src/renderer/projector/bridge.ts`), not IPC.
- **Native modules** (loaded in main, `process.resourcesPath`-based paths): output-engine, spout,
  hap, calib (OpenCV), nvwarp. NDI now lives in a plugin.
- Key renderer services: `services/contentSource.ts` (content → drawable registry),
  `services/timeline.ts`, `services/stateMachine.ts`, `services/cueBus.ts`, `gpu/WebGPUMapper.ts`.

Reference docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (current), [docs/SURFACES.md](docs/SURFACES.md),
[docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md) (historical).

## Plugin architecture (active migration)

The app is being restructured around an **in-process, contribution-based plugin architecture** (npm
workspaces): host app + `@artlux/sdk` (`packages/sdk`, subpaths `/main` + `/renderer`) + `plugins/*`
(shipped: `lidar-tracking`, `ndi`). Host contribution registries live in
`src/renderer/host/registries.ts`; plugin activation in `src/renderer/host/plugins.ts` and
`src/main/host/plugins.ts`; the generic plugin IPC bridge (`pluginInvoke/Send/On`, channels namespaced
`plugin:<ch>`) is in the preload.

**Conventions when touching / adding plugins:**
- **Barrel-only imports (critical):** host code imports a plugin ONLY through its barrel
  (`@artlux/plugin-x` or `@artlux/plugin-x/{main,renderer}`); the plugin's own files import each other
  **relatively**; set `"sideEffects": false` in the plugin's package.json. Mixing the package alias
  with relative imports **duplicates module singletons** (writers hit one instance, readers the empty
  other — this caused a real bug). Verify with a unique string marker: the singleton should appear
  once per window bundle.
- Core enum values / persisted project types (e.g. `SourceType.NDI/TRACKING`, `ProjectorCalibration`)
  **stay in core**; only behavior moves into the plugin (zero project-file migration).
- Plugins that span both processes use explicit `/main` + `/renderer` barrels (like `@artlux/sdk`);
  renderer-only plugins can use a single barrel.
- The SDK is **internal and unstable** — no public/versioned API yet.

**The roadmap + next extraction plan (projector calibration) is [docs/ROADMAP.md](docs/ROADMAP.md).**

## Conventions

- Match the surrounding code: dense, heavily-commented explaining **why** (not what). ES2022, strict-ish
  TS, `moduleResolution: "bundler"`.
- The renderer repaints per-frame during playback — memoize child panels or native `<select>`s drop
  selections (see existing `React.memo` usage).
- Commit/push only when asked. Keep the working tree buildable + typechecking clean.
