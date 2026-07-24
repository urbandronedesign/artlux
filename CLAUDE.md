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
| **Installing on a real machine (build PC + venue PC) + the preflight** | [docs/INSTALL.md](docs/INSTALL.md) |
| **Plugin architecture — developer guide** | [docs/PLUGINS.md](docs/PLUGINS.md) |
| **Plugin SDK — API surface + stability policy** | [docs/SDK.md](docs/SDK.md) |
| **Plugin-architecture roadmap + next extraction plan** | [docs/ROADMAP.md](docs/ROADMAP.md) |
| **Unattended self-healing watchdog (crash/hang recovery + OS supervisor)** | [docs/WATCHDOG.md](docs/WATCHDOG.md) |
| **UI/UX + design-token conventions (read before adding UI)** | [docs/UI-UX-AUDIT.md](docs/UI-UX-AUDIT.md) |
| **Workspace contexts (the editor shell), layout + high-DPI UI scaling** | [docs/WORKSPACE.md](docs/WORKSPACE.md) |
| Surfaces engine (content/mapping model) | [docs/SURFACES.md](docs/SURFACES.md) |
| Outputs / controllers / routing | [docs/OUTPUTS.md](docs/OUTPUTS.md) |
| LED map / fixture geometry | [docs/LEDMAP.md](docs/LEDMAP.md) |
| Timeline NLE | [docs/TIMELINE.md](docs/TIMELINE.md) |
| Scenes & cues | [docs/SCENES.md](docs/SCENES.md) |
| **Project state machine (the "Show" graph over scenes)** | [docs/STATE-MACHINE.md](docs/STATE-MACHINE.md) |
| **Per-scene timelines + per-state authoring loop** | [docs/SCENE-TIMELINES.md](docs/SCENE-TIMELINES.md) |
| Effects & palettes (generative content) | [docs/EFFECTS.md](docs/EFFECTS.md) |
| **Example projects + written tutorials (state machine)** | [examples/README.md](examples/README.md) |
| Projector calibration (structured light + pose) | [docs/CALIBRATION.md](docs/CALIBRATION.md), [docs/AUTO-ALIGN.md](docs/AUTO-ALIGN.md), [docs/CALIB-OPTIMIZATIONS.md](docs/CALIB-OPTIMIZATIONS.md) |
| NVIDIA hardware warp/blend | [docs/NVWARP.md](docs/NVWARP.md) |
| NDI network video | [docs/NDI.md](docs/NDI.md) |
| Spout (Windows GPU video receive) | [docs/SPOUT.md](docs/SPOUT.md) |
| Video codecs (HAP, MP4/WebCodecs) | [docs/CODECS.md](docs/CODECS.md) |
| **AUDIO — the subsystem** (the bed vs a scene's own sound, **two clocks**, ambisonics + HRTF, insert chains, automation, the invariants) | **[docs/AUDIO.md](docs/AUDIO.md)** · hands-on: [examples/audio/tuto/](examples/audio/tuto/README.md) |
| Audio engine (JUCE addon) — build, and **"no sound?"** | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#the-audio-ui-is-all-there-and-nothing-plays--no-sound) |
| OSC control + LiDAR tracking protocol | [docs/OSC.md](docs/OSC.md), [docs/TRACKING_SYNC.md](docs/TRACKING_SYNC.md), [docs/TRACKING_TAKES.md](docs/TRACKING_TAKES.md) |
| Camera pose tracking (MediaPipe BlazePose) | [docs/MEDIAPIPE.md](docs/MEDIAPIPE.md) |
| Augmenta optical tracking (OSC v2) | [docs/AUGMENTA.md](docs/AUGMENTA.md) |
| **Tablet show-control remote + scheduler + project playlist** | [docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md) |
| Assets / portable projects | [docs/ASSETS.md](docs/ASSETS.md) |
| Metrics / monitoring | [docs/MONITORING.md](docs/MONITORING.md) |
| Feature overview / user guide | [docs/FEATURES.md](docs/FEATURES.md), [docs/USER_GUIDE.md](docs/USER_GUIDE.md), `docs/user-guide/` |
| Build log (chronological) | [docs/PROGRESS.md](docs/PROGRESS.md), [CHANGELOG.md](CHANGELOG.md) |
| Historical / superseded docs | [docs/archive/](docs/archive/) (pre-Electron `ARCHITECTURE_PLAN`, `UI_REFACTOR`, audio acceptance/plans) |

## Commands & the working loop

```bash
npm install
npm run build:native          # Rust crates → native/*/*.node (gitignored). Also: build:ndi / build:calib / build:nvwarp
npm run build:audio           # JUCE audio engine (native/audio-engine, cmake-js). REQUIRED for sound: plugins/audio
                              # graceful-degrades, so without it the audio UI renders and plays NOTHING, silently.
                              # build:native runs it too but only WARNS on failure; package + CI are strict.
                              # Close the app first — a running Electron locks the .node (LNK1104 → stale addon).
npm run dev                   # electron-vite dev + launch the app (hot-reloads the renderer)
```
- **Check your work (do this — there's no test suite):** `npm run verify` = **invariant guards + typecheck**.
  `verify:invariants` (`scripts/verify-invariants.cjs`) asserts the rules a typechecker cannot see —
  every one encodes a bug we shipped, where the code compiled, the app booted, nothing threw, and the
  symptom was "I can't select my fixtures" or "Art-Net stopped". It reads source, so it is instant,
  and `npm run package` runs it first. **When you fix a bug of that shape, add a check.**
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
    shell/           the context-driven editor shell (WorkspaceShell, ContextRail, ActionBar)
  contexts/          the 11 core workspace contexts + the panels they compose (nav.ts = goToContext)
  state/             EditorStore — what shell panels read instead of props (App still owns the state)
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
- **The editor shell is context-driven** (canonical: [docs/WORKSPACE.md](docs/WORKSPACE.md)). One
  **workspace context** is active at a time, chosen from the left rail, and it declares the whole
  workbench: browser column, viewport, dock tabs, parameter sections and the action bar. A context is a
  *manifest of panel ids* — it owns no components — so `contextRegistry.extend()` lets a plugin add to,
  or supply the viewport of, a context it does not own. `WorkspaceShell` imports zero panels.
  Panels read state via `useEditor()/useEditorActions()` (`state/EditorStore.tsx`), not props; **App
  still owns all state and every mutation**.
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
| `hap` | HAP video codec decode | **`@artlux/plugin-hap`** |
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
calibration code), `plugins/spout` (Windows Spout receive), `plugins/hap` (HAP video codec — the first
`VideoCodec` contribution), `plugins/mp4` (GPU WebCodecs MP4 decode, opt-in via `mp4WebCodecs`), `plugins/mediapipe`
(camera-based BlazePose tracking — a webcam pose *tracking source*, WASM in-renderer; see
[docs/MEDIAPIPE.md](docs/MEDIAPIPE.md)), and `plugins/augmenta` (Augmenta box optical tracking — an OSC v2
*tracking source* sharing the host OSC listener, renderer-only; see [docs/AUGMENTA.md](docs/AUGMENTA.md)),
and `plugins/show-control` (cross-process — an embedded HTTP+SSE server serving a tablet PWA for scene/cue/
transport/state-machine control, a wall-clock scheduler, live Grafana-style metrics, and an unattended
time-of-day multi-project broadcast playlist; adds a `host.show` SDK service + `ProjectData.schedule`; see
[docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md)).
`.mov`/`.mp4` decode dispatches through `videoCodecRegistry` from surfaces, the timeline, and thumbnails.
The SDK spans content-source, clip-kind, projector (data + GPU + panel), scene-viz, host-services, and
video-codec contributions. `npm run verify:plugins` guards single-identity. Two codecs ship (HAP + MP4);
DXV was considered and **dropped** (2026-07-03) — see ROADMAP.

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

**Shell + 3D rules (each is enforced by `npm run verify:invariants` — see WORKSPACE.md for the why):**
- **`Stage` must never unmount** — it publishes `dmx:frame`, so unmounting it stops Art-Net mid-show.
  It and the single `TimelinePanel` are passed to the shell as *persistent viewport elements* at fixed
  tree positions and hidden with CSS, never conditionally rendered.
- **One element, one position.** A persistent viewport named as a context's `bottom` renders there and
  nowhere else; two `TimelinePanel`s double its keyboard hook and engine subscription.
- **Switch contexts only via `goToContext()`** (`contexts/nav.ts`). Calling `layoutStore.setContext`
  directly drops the `layoutRev`, and a shipped layout change then silently never reaches an operator
  who already opened that context.
- **Bump `WorkspaceContext.layoutRev`** whenever a context's default `layout` changes meaningfully — a
  banked slice (the operator's own sizes) otherwise wins forever.
- **A fixture in 3D is picked by its BODY, not its LEDs** (`Simulator3D/FixtureBodies.tsx`): one slim
  housing per fixture, drawn behind the LED line, as a single InstancedMesh sharing one unit-cylinder
  geometry — so hundreds of fixtures cost one draw call. A 12mm LED sphere is not a target an operator
  can hit. Selecting a fixture must ALSO clear `selectedModelId` (Simulator3D gates the gizmo on
  `!selectedModelId`), or the click lands with no visible effect.
- **3D picking has a priority rule.** Venue screens are big planes and LEDs are 12mm spheres sitting ON
  them, so a screen is almost always NEARER the camera. Model/plane click handlers therefore YIELD
  (skip `stopPropagation`) when an LED is in the same intersection list, and r3f carries the click
  through — see `Simulator3D/pickPriority.ts`. Also: `InstancedMesh` caches `boundingSphere` from the
  first raycast, so `InstancedLeds` must `computeBoundingSphere()` whenever it rewrites instance
  matrices or fixtures silently stop being selectable.
- **Don't mount a second WebGL/3D scene.** The `scene3d` viewport id is re-exported from the shell, never
  re-declared; the 3D canvas is lazy-but-sticky (mounting it at 0×0 leaves r3f's raycaster dead).

- **Hover/press feedback is a FLOOR, not per-button work.** One `:where()`-wrapped base-layer rule pair
  in `styles/index.css` films every `<button>`/`[role=button]`/`<summary>`/`.pressable` on `:hover` and
  `:active`, composing over whatever the control already is. Don't add `hover:bg-*`/`active:*` just to
  make a control respond — it already does. `.no-press` opts out, `.pressable` opts a non-button in.
  The `:where()` wrapping is what keeps components able to override it; `verify:invariants` guards it.
- **Match the surrounding code:** dense, heavily-commented explaining **why** (not what); the comment
  density in existing files is intentional. ES2022, strict-ish TS, `moduleResolution: "bundler"`.
- The renderer **repaints per-frame during playback** — memoize child panels (`React.memo`) or a native
  `<select>` will drop selections mid-interaction.
- Camera/mic surfaces need the main process to grant the `'media'` permission — see DEVELOPMENT.md if a
  live camera source stays blank.
- Keep commit messages quote-free-ish when authored via PowerShell here-strings (DEVELOPMENT.md gotcha).
