# ArtLux — Build Progress & Decisions

Living status log for the rewrite in [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md).
Newest decisions at the bottom of each section. Commit hashes are on `main`.

## Status by phase

| Phase | Scope | State | Commit |
|------|-------|-------|--------|
| 0 | Docs, README rewrite, strip Gemini/API, skill | ✅ done (skill pending) | `eacc45f`, `bd02f91` |
| A | Electron migration + native Art-Net (drop bridge) | ✅ done | `7a0b5bb` |
| B | WebGPU compute mapper + async readback | ✅ done | `b1404da` |
| C | WLED effects + palettes (per-fixture) | ✅ done (segments/fire deferred) | `254cff8` |
| D | 2D matrix + ledmap + color correctness | ✅ done | `063be08` |
| E | Per-fixture routing + output targeting (TS) | ✅ done | `4e5fe09` |
| F | Native sACN/E1.31 + **Rust output engine (napi-rs)** | ✅ done | `290d353`, `<pending>` |
| G | 3D LED fixture editor + simulator (r3f) | ✅ done | `2c59917` |
| Outputs | Projector outputs (warp/blend/gamma/MSAA/perf) + broadcast mode + consistent quit | ✅ done (v0.6.0–v0.6.1) | `b1a76bf`, `1edbca9`, `070c6a0`, `eb4d96b` |
| NDI | NDI receive onto surfaces + send per output (native grafton-ndi addon, prebuilt) | ✅ done (v0.7.0) | `e1cf527`, `e946bb5` |
| HAP | GPU-decompressed HAP video + vsync-locked playback | ✅ done (v0.9.0–v0.10.0) | `794723d`, `dfe31c3` |
| Timeline | DaVinci-style NLE: filmstrips, pro track headers, blade/snap/ripple, timecode/markers/shortcuts (editing-UX only) | ✅ done (v0.11.0) | `9cfbce1` |
| Timeline+ | Infinite/unbounded clock + optional loop region, wheel-zoom/middle-pan, maximize, and a state-machine control layer (emits transport intents; App stays sole transport writer) | ✅ done (v0.12.0) | `330549c` |

## What works today
- Runs as a native **Electron** desktop app: `npm run dev` (electron-vite). Three-process build: main / preload / renderer.
- **Native Art-Net** over UDP from the main process (`src/main/transport/artnet.ts`), wired via IPC (`shared/protocol.ts`, `src/preload/index.ts`, `src/main/ipc.ts`). The old WebSocket bridge is gone.
- **WebGPU compute** pixel mapper (`src/renderer/gpu/WebGPUMapper.ts`) with WebGL fallback (`src/renderer/services/GPUMapper.ts`) behind a shared `IPixelMapper` interface. Stage tries WebGPU first.
- **Projector outputs** (v0.6.0): per-surface fullscreen on a chosen display with corner-pin / Bézier warp, soft-edge blend, per-screen gamma, MSAA, and a performance fps cap — plus a `--broadcast` show mode (outputs + Art-Net, no editor UI). Architecture in [OUTPUTS.md](OUTPUTS.md) (`src/main/projector.ts`, `src/renderer/projector/`, the projector glue in `App.tsx`).

## Repo layout (post Phase A)
```
electron.vite.config.ts        shared/protocol.ts (IPC contract)
src/main/{index,ipc}.ts        src/main/transport/artnet.ts
src/preload/index.ts
src/renderer/                  (the React app)
  App.tsx index.html index.tsx types.ts
  components/  hooks/  services/  gpu/
```

## Key decisions
- **Hybrid native** (decided pre-build): Electron + React + WebGPU; only the high-rate output engine goes to **Rust (napi-rs)** in Phase F. No full Tauri/Rust rewrite (would break reliable WebGPU). See ARCHITECTURE_PLAN "Native-language assessment".
- **`package.json` has no `"type": "module"`** — main/preload build as CJS so the `sandbox: true` preload works. Renderer is still ESM (Vite handles it).
- **AppSettings** changed: `useWsBridge`/`wsBridgeUrl` → `outputEnabled`/`broadcast`.
- **WebGPU readback is async** → `WebGPUMapper.read()` returns the previous resolved frame (1-frame latency) via a 3-buffer staging ring. Acceptable for lighting.
- **Universe packing still CPU-side** in `Stage.tick` (the DMX Monitor also needs the per-LED buffer). Moving packing onto the GPU is a deferred Phase-B refinement.

## Gotchas / environment notes (for future-me)
- This dev sandbox sets **`ELECTRON_RUN_AS_NODE=1`**, which makes the Electron binary run as plain Node (`app` undefined). Launch with `env -u ELECTRON_RUN_AS_NODE npm run dev`. A normal user terminal won't have this.
- The `electron` npm **postinstall was skipped** here; if `node_modules/electron/path.txt` is missing, run `node node_modules/electron/install.js`.
- Use `ELECTRON_ENABLE_LOGGING=1` to surface renderer `console.log` on stdout when verifying.
- WebGPU **is** available in this Electron/Chromium (confirmed: "Using WebGPU compute mapper").

## Phase C notes
- Per-**fixture** effects (not yet multi-segment): each fixture has `source` (MEDIA|EFFECT),
  `effectId`, `paletteId`, `speed`, `intensity` (all optional, default MEDIA → back-compat).
- Effects run on the **WebGPU** path only (`src/renderer/gpu/{WebGPUMapper,effects,palettes}.ts`).
  The WebGL fallback ignores effects (samples media) — acceptable since Electron has WebGPU.
- Palettes: 7 WLED-style LUTs (Rainbow generated + 6 gradients) in a 256×N texture.
- Effects (stateless): Solid, Rainbow, Palette Flow, Wave. **Deferred**: stateful fire2012
  (needs ping-pong heat buffer) and multi-segment subdivision per fixture.
- Perf: per-LED static layout (`ledData`) vs per-fixture params (`fixParams`) are separate
  buffers; slider/dropdown changes only rewrite the tiny `fixParams` (no realloc) via
  `updateParams()`.
- Known wart: `onUpdateFixture` records undo history on every change, so dragging a slider
  spams the undo stack (pre-existing pattern). Debounce later.

## Phase D notes
- **Geometry on GPU** (`WebGPUMapper`): `LedShape.MATRIX` lays LEDs in a cols×rows grid
  with optional **serpentine**; `ledMap` remaps physical output index → geometry index
  (WLED ledmap, loadable from `.json` via the Inspector — accepts a bare array or `{map:[...]}`).
- **Auto-white on GPU**: per-fixture `rgbwMode` — `SUBTRACT` (default, W=min) or `NONE`
  (full RGB, W=0 for RGB strips). Stored as a 2nd vec4 per fixture in `fixParams`.
- **Output corrections in Stage packing** (keeps the raw RGBW buffer canonical for the
  monitor/3D): per-fixture **color order** (RGB/GRB/…), **channels** (3=RGB / 4=RGBW), and a
  global **gamma** LUT (`AppSettings.gamma`, default 1.0 = off; slider 1–3 in Output Config).
- Defaults preserve prior output exactly: LINE / RGB / SUBTRACT / 4ch / gamma 1.0.
- WebGL fallback still has no effects/matrix (Electron has WebGPU).

## Phase E notes
- **Per-fixture routing** ("jump from fixture to fixture"): `Fixture.output?` =
  `{ ip?, broadcast?, sparse? }`. Blank IP → global `AppSettings.artNetIp`.
- Stage groups universes by destination (`${ip}|${broadcast}`) into a pooled per-dest map and
  publishes `dmxSignal(pixels, destinations)`; App turns destinations into `UniverseTarget[]`
  and sends via IPC. `mockSocketService.sendArtNetFrame(targets)`.
- `main/transport/artnet.ts` fans out a packet per universe to each destination; **sparse**
  destinations skip universes whose bytes are unchanged since last send (dirty-tracking).
- **Bug fixed during verify**: `dgram.send` is async, so reusing one packet Buffer across
  sends corrupted in-flight packets (all got the last universe). Now copies per packet
  (`Buffer.from`). The Phase F Rust engine will avoid the per-packet copy.
- Verified with a 2-destination + sparse-skip UDP round-trip test (passed).

## Phase G notes
- **3D LED editor + live simulator** (`ViewMode.SIMULATOR_3D`, third TopBar toggle) built with
  **react-three-fiber v9** + drei + postprocessing. `components/Simulator3D/`.
- True per-fixture 3D transform on `Fixture`: `position3D`, `rotation3D` (deg), `layout3D`
  (`line|matrix|arc` + spacing/rows/cols/serpentine/arc params) — all optional; derived from
  the 2D layout when absent (migration), so old projects appear immediately.
- One `InstancedMesh` for all LEDs; `instanceIndex` matches the dmxSignal pixel order, so
  `useLedColors` writes live colors each frame with zero React re-renders. Bloom for glow.
- Editing: click an LED selects its fixture (shared `selectedFixtureId`); drei
  `<TransformControls>` (translate/rotate, toolbar toggle) with `<OrbitControls makeDefault>`
  auto-disabled while dragging. History recorded at drag-start; commit via
  `handleCommitFixture3D` (no re-record). Numeric "3D Layout" section in the Inspector.
- **Bundle hygiene**: three is heavy, so `Simulator3D` is `React.lazy` and the three-free
  effective-value helpers live in `services/led3dDefaults.ts` (the Inspector imports those,
  not `led3dLayout`). Result: main bundle ~695 KB; three lives only in the lazy 3D chunk
  (~2.25 MB) loaded on first 3D entry.
- Stage stays mounted (opacity, not unmount) so dmxSignal keeps flowing while in 3D.
- Verified: build passes; with the view temporarily defaulted to 3D the scene rendered with
  no errors (only a benign THREE.Clock deprecation warning from a dep).

## Phase F native engine (Rust napi-rs) — done
- Rust toolchain installed on this machine (rustc/cargo **1.96**, MSVC). The native engine
  is built and wired in.
- `native/output-engine/` — Rust crate (napi-rs) building Art-Net + sACN packets and sending
  UDP in Rust (`src/lib.rs`): `configure(broadcast)`, `sendFrame(targets)`, `isReady()`,
  `close()`. Per-universe sACN sequence + changed-only (sparse) dirty-tracking, multicast/
  unicast, priority — parity with the TS transports.
- Build: `npm run build:native` (cargo build --release + `scripts/copy-native.cjs` copies the
  cdylib to `native/output-engine/output-engine.node`). The `.node` and `native/**/target`
  are gitignored — **run `npm run build:native` after cloning** (or when the crate changes).
- `outputManager.ts` loads the `.node` at runtime via `createRequire` (candidate paths:
  `cwd` and `out/main/../../native/...`); **falls back to the TS artnet/sacn transport** if the
  addon is absent. N-API is ABI-stable, so the addon built with system Node loads in Electron.
- Verified: cargo build OK; the addon loads in Node and Electron; a UDP round-trip test
  asserted valid **Art-Net + sACN** straight from Rust (7/7 checks); app boots with
  "[output] native Rust engine loaded".
- **Dedicated send thread + binary handoff (done):** the addon spawns an OS thread that owns
  the UDP socket and paces transmission, woken by a condvar; `pushFrame(buffer)` just memcpys
  the frame + notifies (no socket work on the JS thread, no event-loop jitter). Frames are
  encoded once into a compact binary `ArrayBuffer` (`shared/frameCodec.ts`) and sent over IPC
  as one contiguous buffer instead of cloning an object-of-number-arrays.
  - Note: a true cross-process **SharedArrayBuffer** is not possible in Electron (renderer and
    main are separate processes; SAB only shares within one process). The binary buffer + Rust
    thread is the functional equivalent. The TS transport decodes the same binary frame for the
    fallback path.

## Phase F notes (sACN in TypeScript — the fallback path)
- Delivered: **native sACN / E1.31** in `src/main/transport/sacn.ts` (Root +
  Framing + DMP layers, CID, priority, per-universe sequence, multicast `239.255.x.x:5568`
  or unicast). `outputManager.ts` routes each frame's targets to Art-Net or sACN by
  `target.protocol`; `ipc.ts` now uses outputManager.
- Data model: `OutputProtocol`, `OutputTarget.protocol`/`priority`, `AppSettings.protocol`
  (global default; per-fixture override). Stage groups destinations by
  `${protocol}|${ip}|${broadcast}` (broadcast = UDP broadcast for Art-Net, multicast for sACN).
- Inspector: global Protocol select (Output Config) + per-fixture Protocol/Priority (Routing).
- Verified: build passes; E1.31 packet validated over UDP (11/11 structural checks);
  app boots clean with the dual-protocol manager.

## Phase H — fire2012 + multi-segment effects (done)
- `Segment { start, stop, source, effectId, paletteId, speed, intensity }` on `Fixture.segments?`
  (optional; no segments ⇒ one implicit full-range segment = identical to before).
- `WebGPUMapper`: per-LED `ledData.w` is now a **global segment index**; `segParams` holds
  2×vec4 per segment (+ a trailing "off" entry for gap LEDs); a per-LED `ledMeta`
  (segStart/segLen/localIndex) supports fire. `updateParams` rewrites only `segParams` when the
  segment count is unchanged.
- **fire2012** (effect id 4): persistent `heat` storage buffer + a separate `fire` compute pass
  (cool → propagate-up within segment → base sparks, hashed PRNG, in-place) run before `main`,
  which maps `heat`→palette. New `Params.frame` uniform; two pipelines (`main`, `fire`) with
  separate auto-layout bind groups.
- Inspector "Effect" section is segment-aware: Split/Merge, per-segment list with start/stop, and
  the effect/palette/speed/intensity controls retarget the selected segment.
- Verified: build + launch clean (no WGSL/validation errors). Two bugs caught at runtime and
  fixed: `meta` is a reserved WGSL keyword; the `main` auto-layout omits unused binding 7.

## Phase I — fixture groups & scenes (done)
- `FixtureGroup { id, name, fixtureIds }` and `Scene { id, name, fixtures, globalBrightness }`
  in `types.ts`; `groups`/`scenes` state in `App.tsx`; both persisted in project save/load.
- Groups: create from selection, add selected, **apply selected fixture's look** (effect/segments/
  palette) to all members (one history record), select, delete. Scenes: capture snapshot, instant
  recall (records history → undoable), delete. UI in `ScenePanel.tsx`.
- Cue/timeline playback (crossfades) intentionally deferred.

## Phase J — Art-Net / sACN input capture (done)
- `src/main/transport/input.ts`: UDP listeners — Art-Net (6454) and sACN (5568 + multicast
  join). Parses OpOutput / E1.31 → `{protocol, universe, data}`, coalesces per-universe and
  forwards to the renderer at ~30 Hz via IPC `input:frame`. `configureInput({enabled,protocol,
  universes})` over `input:configure`.
- `shared/protocol.ts` (InputConfig/InputFrame + channels), `preload` (`configureInput`,
  `onDmxInput`), `ipc.ts` wire it up.
- Renderer `services/dmxInput.ts` assembles incoming universes into a canvas (row = universe,
  RGB triples). New `SourceType.DMX_IN`: Stage draws that canvas as the content source, so
  incoming DMX drives fixtures through the normal mapping/effects pipeline. Inspector has a
  "DMX In" source button; App enables/disables the listener with the source.
- Not full HTP/LTP merge (deferred). Verified: input parser UDP round-trip passes (Art-Net +
  sACN, 4/4); app builds + launches clean.

## Phase K — native pacer + keep-alive + stats + packaging (done)
- Rust `configure(broadcast, fps, keepAlive)`: the send thread waits on the condvar with a
  pacing **timeout = 1000/fps**; on timeout it **re-sends the last frame** (keep-alive, forced
  past sparse) so receivers never starve. New frames still send immediately. `fps`/`keepAlive`
  are atomics, updatable at runtime.
- **Stats**: the thread tallies packets/sec, frames/sec, and universes; `getStats()` (napi) is
  polled by main ~1 Hz and pushed to the renderer over IPC `dmx:stats`. Shown in the status bar
  (`44Hz · Npps · Nu`). `AppSettings.fps`/`keepAlive` + Inspector controls.
- **Packaging**: electron-builder `extraResources` copies `output-engine.node` into the app's
  resources; `outputManager` resolves `process.resourcesPath/output-engine.node` first (then dev
  paths), falling back to the TS transport.
- Verified: native rebuild OK; pacer test — a single `pushFrame` yields ~20 packets/s via
  keep-alive and `getStats` reports fps/pps/universes; app builds + launches clean with stats in
  the status bar.

## Packaging & CI (done)
- `npm run package` (installer) / `npm run package:dir` (unpacked, no signing). electron-builder
  config: per-OS targets (win nsis+portable, mac dmg, linux AppImage); `output-engine.node`
  bundled via `extraResources`; `release/` is gitignored.
- **Per-platform native prebuilds**: `.github/workflows/build.yml` — matrix (windows/macos/ubuntu)
  installs Rust, runs `build:native` (so each bundle's `.node` matches the OS), then
  `electron-builder --publish never`, uploading installers as artifacts. Triggers on `v*` tags or
  manual dispatch. (Runs on GitHub runners; not executed locally.)
- **Packaged smoke test (Windows)**: built `release/win-unpacked`; launched `ArtLux.exe` →
  `[output] native Rust engine loaded` from `resources/output-engine.node`, WebGPU engaged, no
  errors.

## UI/UX refactor → MadMapper-class console (in progress)
Reference: MadMapper (Art-Net LED-strip workflow). Full plan in the session plan file.
- **U1 (done)**: dropped the Tailwind **CDN** for a real build (`tailwind.config.js`, `postcss.config.js`,
  `src/renderer/styles/{tokens.css,index.css}`); semantic dark **tokens** + muted-teal accent
  (`#27b6c4`); seed `ui/` primitive kit (`Button/IconButton, Section, Field, NumberField, Slider,
  Select, Toggle, Segmented, ListRow`). Removed dead `SettingsPanel`/`FixtureList`; `tsc` clean.
  Existing classes kept working (legacy color names retained). Build/launch verified.
- **U2 (done)**: **AppShell** IA — top-left **module switcher** (Media/Map/Fixtures/3D) drives the
  center (2D Stage kept mounted for Media/Map/Fixtures, lazy 3D for the 3D module); left panel
  consolidated to **browser (ScenePanel) + inspector (InspectorPanel)** (right panel removed);
  **bottom Dock** (DMX Monitor + Fixture Editor placeholder); **StatusBar** (help line + stats);
  **Preferences modal** (output/engine settings moved out of the inspector). New: `Module`/`DockTab`
  types, `ModuleSwitcher`, `Dock`, `Preferences`, `StatusBar`; TopBar rebuilt on the kit.
- **U3 (done)**: migrated `InspectorPanel` + `ScenePanel` off hardcoded hex onto the design tokens
  (surfaces/lines/text/accent) — consistent teal/dark MadMapper look across the panels.
- **U4 (done)**: Stage toolbar + canvas handles onto tokens (**red** selection handles for DMX
  fixtures, **cyan** snap guides for surfaces); `Simulator3D` toolbar restyled; `DMXMonitor` rebuilt
  as a compact dock grid (stat bar + per-fixture live pixel strip with an intensity meter); new
  **`FixtureEditor`** dock tab (Patch / Pixel Type = color order + channels / Geometry = shape +
  matrix + serpentine / Wiring preview with serpentine "assignation" path) on the `ui/` kit.
- **U5 (done)**: polish + a11y. Contextual **hover help** bus (`services/helpBus.ts`) → StatusBar
  shows the hovered control's hint (falls back to the module help); wired into ModuleSwitcher,
  TopBar history/project/monitor/prefs, and the transport. Global **focus-visible** ring + slider
  focus; **motion** (modal/overlay entrance keyframes, dock height transition) all gated by a
  `prefers-reduced-motion` guard. A11y: icon-only buttons get accessible names (IconButton
  auto-derives `aria-label` from `title`; raw buttons labelled), `role=tablist/tab` +
  `aria-selected` on module/dock tabs, `aria-pressed`/`aria-expanded`, Preferences as a
  `role=dialog` with **Escape** to close. Token cleanup: removed leftover `red/green/gray/#hex`
  (deleted the dead legacy `components/Button.tsx`). **Packaged smoke test**: `npm run package:dir`
  → `release/win-unpacked/ArtLux.exe` launches, native Rust engine + WebGPU load, styled from the
  build (no CDN).

**UI/UX refactor (U1–U5) complete.** Backlog: contrast retune of tertiary `fg-3` text if needed,
keyboard focus-trap inside the modal, vendor the ui-ux-pro-max skill.

## New features (post-refactor)
Plan: Persistence (F1) → Art-Net Poll (F2) → Art-Net Sync (F2b) → Headless (F3) → Spout (F4).
- **F1 — Persistence (done)**: all file I/O moved to the main process (the renderer is sandboxed).
  New `src/main/persistence.ts`: native **Save/Open dialogs** (`.artlux`), **userData prefs**
  (`artlux-prefs.json` = appSettings + globalBrightness + recentFiles + lastProjectPath), **rig
  export/import** (`.artrig` = fixtures with patch/wiring/routing/geometry only — strips
  effects/segments/scenes/media), and `loadProjectPath` (recents/headless). IPC via
  `ipcMain.handle`/`invoke` (`project:*`, `rig:*`, `prefs:*`) in `shared/protocol.ts` +
  `src/preload/index.ts` + `src/main/ipc.ts`. `App.tsx`: restores settings + master brightness +
  recents (and auto-reopens the last project) on launch; debounced `setPrefs` on settings change;
  Save (to current path) / Save As / Open / Open Recent / Export Rig / Import Rig. `TopBar` gained a
  **File menu** (caret dropdown) for Save As/Open/recents/rig. Verified: `tsc`+build clean; launch
  writes `artlux-prefs.json` and round-trips prefs with no errors.
- **F2 — Art-Net Poll (done)**: `src/main/transport/discovery.ts` broadcasts **ArtPoll** (`0x2000`)
  on UDP 6454 (coexists with `input.ts` via `reuseAddr`), collects **ArtPollReply** (`0x2100`) for
  ~3s, parses node IP/short+long name/MAC/OEM per the Art-Net offsets (matching the `artnet_protocol`
  crate's `PollReply` layout), de-dups by IP. IPC `artnet:discover` (invoke) →
  `protocol.ts`/`preload`/`ipc.ts`; `ArtNetDevice` type. **Preferences → DMX Output** gained a
  **Discover** button + clickable device list that sets `artNetIp`. Verified: UDP round-trip test
  (fake node → reply parsed: ip/names/MAC) **PASS**; `tsc`+build+launch clean.
- **F2b — Art-Net Sync (done)**: after each frame's ArtDmx packets, emit an **ArtSync** (`0x5200`)
  per unique Art-Net destination so nodes latch + output simultaneously (tear-free multi-universe).
  Implemented in **both** paths: Rust engine (`native/output-engine/src/lib.rs` — `sync` atomic +
  `configure(broadcast,fps,keepAlive,sync)` + `build_artsync()`; rebuilt via `build:native`) and the
  TS fallback (`src/main/transport/artnet.ts` — constant `ARTSYNC` buffer, dest collection). New
  `artNetSync` in `AppSettings`/`OutputConfig`, threaded through `mockSocketService` →
  `outputManager` → native; a **Preferences** toggle. Verified: ArtSync emission test (2 ArtDmx + 1
  ArtSync) **PASS**; native engine loads with the new 4-arg configure; `tsc`+build+launch clean.
  Note: `cargo` lives in `~/.cargo/bin` (prepend to PATH before `npm run build:native`).
- **F3 — Headless (done)**: `--headless [--project=<path>]` runs only the Stage compute + output loop
  in an **invisible GPU-backed window** (no UI/3D/monitor). Second renderer entry
  (`electron.vite.config.ts` rollup input `headless`) → `src/renderer/headless.html` + `headless.tsx`
  (no StrictMode) + `HeadlessRunner.tsx` (loads the project via `loadProjectPath` IPC, renders
  `Stage` in a 1×1 offscreen host — the 512² canvas buffer is unaffected — and replicates App's
  `configureOutput` + `dmxSignal → sendArtNetFrame` wiring). `src/main/index.ts` parses argv, creates
  the window with `show:false` + `backgroundThrottling:false` (skips `ready-to-show→show`), loads the
  headless entry with `?project=`, and adds `disable-renderer-backgrounding`. Verified: headless
  launch loaded 1 fixture, used WebGPU, and emitted **334 ArtDmx + 334 ArtSync** (~44 fps) to a UDP
  listener over ~7.5s; `tsc`+build clean. Note: media sources aren't in the project format, so
  headless drives EFFECT/DMX-in fixtures (media-source fixtures render black).
- **F4 — Spout receiver (done)**: new `SourceType.SPOUT` content source (Windows GPU video from
  Resolume/MadMapper/TouchDesigner). Native addon **`native/spout-receiver`** (napi-rs) wraps the
  **`spout2-rs`** crate's DX11 receiver (vendors the Spout2 SDK, manages its own D3D11 device, CPU
  readback) — `listSenders`/`connect`/`disconnect`/`receiveFrame`; downscales to **512² RGBA** before
  handoff; BGRA→RGBA swap by `sender_format`. `#[cfg(windows)]` real impl + no-op stubs elsewhere
  (`spout2-rs` is a Windows-only target dep) so CI builds a valid `.node` on all platforms. Loaded in
  **main** via `src/main/transport/spoutManager.ts` (outputManager-style load + ~60 Hz forward
  interval → `spout:frame` IPC). Renderer `src/renderer/services/spoutReceiver.ts` mirrors
  `dmxInput.ts` (`getSpoutCanvas()`); `Stage.tick` SPOUT branch; App lifecycle effect (sourceUrl =
  sender name); InspectorPanel **Spout In** button + sender dropdown + refresh. Build: `build:native`
  builds both crates; `copy-native.cjs` generalized; `extraResources` + CI cache extended.
  Verified: native crate compiles (vendored Spout2 C++ SDK via `spout2-sys`), `.node` loads in main,
  and the napi boundary works (`listSenders()=[]`, `connect('')`/`receiveFrame()=null`/`disconnect()`
  with no sender running); `tsc`+build+launch clean (`[spout] native receiver loaded`). Live frame
  receive needs a running Spout sender (not available in this sandbox).

**New-features roadmap F1–F4 complete.**

## Surfaces engine (S-series, in progress)
Plan: S1 Surfaces+compositing → S2 effect surfaces → S3 strict per-surface sampling + linking →
S4 fixture library → S5 controllers + auto-patch → S6 routing spreadsheet.
- **S1a (done)**: `Surface`/`SurfaceContent` types + `Fixture.surfaceId`. App owns `surfaces[]` +
  `selectedSurfaceId` (selecting a surface clears the fixture selection and vice-versa); CRUD;
  surfaces persist in the project (`buildProjectData`/`applyProjectData`, default full-stage surface
  for back-compat). Content moved off the single global source onto **per-surface content** via new
  `services/surfaceMedia.ts` (manages a `<video>`/`<img>` per VIDEO/IMAGE surface + a single live
  camera/Spout/DMX-in; `getDrawable(surface)` each frame). `Stage` now **composites** every surface's
  content into the 512² canvas in z-order (fixtures still sample the composite — strict per-surface
  sampling is S3); stage aspect fixed at 16:9 (composition canvas). `ScenePanel` gained a **Surfaces**
  tree (add/select/rename/remove, content-type badge); `InspectorPanel` shows **Content** (type +
  Spout sender + effect params placeholder) + **Transform** when a surface is selected (the old global
  Input-Source section is gone). HeadlessRunner loads project surfaces. Verified tsc+build+launch.
- **S1b (done)**: on-canvas **cyan surface rectangles** on the Stage — click to select, drag body to
  move, corner handle to resize, top handle to rotate (self-contained surface drag, behind the
  fixtures layer). Surfaces show name + dashed outline (selected = solid + handles). `Stage` gained
  `surfaces`/`onUpdateSurfaces`/`selectedSurfaceId`/`onSelectSurface` props. **S1 complete.**
- **S2 (done)**: **effect surfaces** — `gpu/surfaceFx.ts` `SurfaceEffect` renders 2D effects
  (Solid/Rainbow/Palette-Flow/Wave/Fire) into a 96² offscreen canvas, sampling the shared palette LUT
  (`buildPaletteLut`). `surfaceMedia` keeps a `SurfaceEffect` per EFFECT surface (pruned on
  remove/retype) and returns it from `getDrawable`; `Stage` composites it like any source. Inspector
  surface-EFFECT block gained speed/intensity sliders. Verified headless: an effect surface drives a
  fixture → **552 ArtDmx packets, maxByte 255** (after freeing 6454 from Artnetominator). Per-fixture
  effect engine retained for now; UI retirement deferred.
- **S3 (done)**: **strict per-surface sampling + fixture↔surface linking** (the engine rewrite). Each
  fixture has `surfaceId` and samples ONLY its linked surface's texture, regardless of overlap.
  `WebGPUMapper`: `ledData` now stores **surface-local UVs**; each LED's surface index is in
  `ledMeta.w`; `renderSurfaces(getDrawable)` runs one compute pass per surface (binds that surface's
  drawable stretched into the 512² source via a scratch canvas; `params.p0` = active surface; the
  shader gates `if (surfIdx != p0) return`), clearing `outBuf` each frame so unlinked LEDs are black;
  one readback. Per-fixture effects retired in the engine (all segments = media). `IPixelMapper` gains
  `perSurface` + `renderSurfaces`; `updateMapping(fixtures, surfaces)`. `Stage` still composites a
  **preview** canvas (and the WebGL fallback samples it — degraded, not strict on overlap), but the
  WebGPU path uses `renderSurfaces`. App default-links fixtures (add/new/load → first surface);
  InspectorPanel fixture Mapping gained a **Surface** link dropdown. Verified headless: a fixture
  linked to an effect surface A with a black surface B composited ON TOP still output A's colors
  (**dmx 531, maxByte 255**) — composite-sampling would be black, proving strict isolation.
- **S4 (done)**: **fixture library** — `FixtureTemplate` (LED definition only), persisted to userData
  prefs (`Prefs.fixtureTemplates`) so it spans projects. `ScenePanel` **Library** section: save the
  selected fixture as a template, click a template to instantiate a fixture (default placement,
  auto-linked to the current/first surface), delete. App `templates` state + `persistTemplates`
  (writes prefs on change, loaded on launch). Verified tsc+build+boot.
- **S5 (done)**: **controllers + auto-patch**. `Controller` type (id/name/protocol/ip/broadcast/
  priority/startUniverse) + `Fixture.controllerId`/`patchLocked`. `services/addressing.ts`
  `autoPatch(fixtures, controllers)` packs universes/addresses sequentially per controller
  (channelsPerPixel-aware, wraps at 512; `patchLocked` fixtures keep manual; fixtures with no
  controller share one bucket). App holds `controllers` state (persisted in project); auto-patch runs
  on add/remove and on ledCount/channels/controller/lock changes, plus a **Re-patch** button in the
  Fixtures header. `Stage` resolves each fixture's destination from its controller (then per-fixture
  `output` override, then global settings). Controllers management + per-fixture assignment UI is the
  S6 routing spreadsheet. Verified: `autoPatch` unit test (sequential / startUniverse / locked) PASS;
  headless controller routing PASS (output went to the controller IP, not the global setting).
- **S6 (done)**: **routing spreadsheet modal** (`RoutingModal.tsx`) — opened from the TopBar Network
  button or File → Routing…. A **Controllers** sub-panel (add/edit/remove: name/protocol/IP/broadcast/
  start-universe/priority) over a **fixtures patch grid** (rows = fixtures; columns = name · surface ·
  controller · universe · start · channels · LEDs · span · lock). Inline-editable; universe/start are
  read-only until a row is **locked** (auto otherwise); **Auto-patch** button. Wired to the S5
  controller handlers + `autoPatch`. Verified tsc+build+boot.

**Surfaces engine S1–S6 COMPLETE** — surfaces with per-surface content, 2D effect surfaces, strict
per-surface sampling + fixture linking, fixture library, controllers + auto-patch, routing spreadsheet.

## Desktop chrome (post-features)
- **App icon** — authored `build/icon.svg` (teal "A" squircle matching the brand); `npm run gen:icon`
  (`scripts/gen-icon.cjs`, `@resvg/resvg-js` + `png-to-ico`) rasterizes `build/icon.{png,ico}` +
  `src/renderer/public/icon.png` (favicon), all committed. Wired into electron-builder
  (`build.win.icon`/`mac`/`linux`), `BrowserWindow.icon`, and both HTML `<link rel=icon>`. Packaging
  no longer logs "default Electron icon is used".
- **Native menu** — `src/main/menu.ts` (File / Edit / View / Window / Help) set in `index.ts`
  (`autoHideMenuBar` now false for GUI, hidden in headless). Renderer-bound items send
  `IPC.MENU_ACTION`; `App.tsx` dispatches to existing handlers (new/open/save/save-as/rig/prefs/
  about + open-recent submenu from prefs). Undo/Redo use `registerAccelerator:false` so the
  renderer keydown owns the shortcut (no double-fire). New `handleNewProject`.
- **About modal** — `src/renderer/components/About.tsx` (mirrors Preferences); version via
  `app:get-info` IPC; external links via `app:open-external` (shell.openExternal).
- **Play/Pause** — replaced the dual-button toggle with a single source-aware toggle in `TopBar`
  (disabled unless source is VIDEO/CAMERA; icon reflects state). Verified `tsc`+build+launch+package.
- **Content aspect ratio** — the stage now follows the **source aspect** instead of a fixed square.
  Mapper sampling is normalized (verified), so the 512² canvas + mapper are unchanged: sources are
  drawn **stretched-to-fill** the square and the canvas is shown `object-fill`, while the stage
  container takes the source's w/h (`Stage.tsx` `contentAspect` from video/image natural dims or
  Spout). Spout addon now reports `srcWidth/srcHeight` (`SpoutFrame`) so its true aspect survives the
  512² downscale; `spoutReceiver.getSpoutAspect()`. DMX-in/NONE default 16:9. Output values
  unchanged (normalized). `tsc`+build+build:native+launch clean.

## v0.3.x — workspace rework, square canvas, output/preview fixes, auto-update

Shipped across **v0.3.0** and **v0.3.1** (see `CHANGELOG.md`; UI detail in `UI_REFACTOR.md`,
"Workspace layout v2").

- **Workspace UI v2** — three-region shell in `App.tsx`: left `ScenePanel` (outliners + sliders),
  center stage + dock, **right `InspectorPanel`** (re-added). `CollapsibleSection` primitive (header
  toggles; `grow` mode → Surfaces/Fixtures fill the panel). Dock Fixture Editor tab now also holds
  fixture **Create** + **Library** and opens by default. **Multi-select** fixtures (`selectedFixtureId`
  primary + `selectedFixtureIds` set): click / ctrl·cmd / shift-range / Master-Layer / Ctrl·Cmd+A, in
  outliner and on stage; group ops act on the set. **Smooth sliders** (`ui/Slider`): local value during
  drag, commit on release; master brightness drives a render-free `--preview-brightness` channel
  (`services/livePreview.ts`) the Stage rAF reads (avoids re-rendering all of `App` per drag tick;
  nothing is memoized).
- **Square UV canvas** (`Stage.tsx` `contentAspect = 1`) on a mid-grey backdrop with a **configurable
  layout grid** (toggle + divisions; surfaces & fixtures snap to it). **Surfaces auto-fit their
  content's aspect** on load (`surfaceMedia.getContentAspect`) and corner-resize scales uniformly (no
  distortion). Fixtures/surfaces layers use `pointer-events-none` containers + `pointer-events-auto`
  items (fixed surfaces being unclickable under the fixtures layer). *Supersedes the earlier
  "Content aspect ratio" entry (stage no longer follows a single source aspect).*
- **Preview-only fixes**: composite preview canvas at full opacity (was `opacity-50`); `DMXMonitor`
  folds the RGBW white channel back into RGB so whites display. Output was always correct.
- **Camera surfaces fixed**: main process now grants the `media` permission
  (`session.setPermissionRequestHandler`/`setPermissionCheckHandler`, `src/main/index.ts`) —
  `getUserMedia` was silently denied. Renderer logs the precise `DOMException` name.
- **Art-Net dropped-packets fix**: sequence is now **per port-address** (per universe) in both the
  native Rust engine (`native/output-engine/src/lib.rs`) and the TS fallback (`artnet.ts`) — a single
  global counter made each universe's seq jump, which monitors read as missing packets.
- **Auto-update (v0.3.1)**: user-gated `electron-updater` (`src/main/updater.ts`, GitHub provider) —
  check on launch + Help menu, in-app `UpdateNotice` prompt, Download → Restart & Install. Windows/Linux
  update in place; macOS links to Releases (no Developer ID). `build.publish=github` emits `latest.yml`;
  CI uploads `*.yml`/`*.blockmap`. Works for upgrades from v0.3.1 onward.

## v0.4.0 — 3D Scene window + video-layer timeline

- **3D Scene as a separate window** (`src/renderer/scene.html`/`scene.tsx` → `scene/SceneApp.tsx`; opened by
  `main/index.ts` `createSceneWindow`). Main↔Scene bridge via `MessageChannelMain` (port forwarded into the
  main world by the preload through `window.postMessage` — a MessagePort can't cross `contextBridge`);
  `scene/bridge.ts` message union. Main streams `state` + per-LED `pixels` (~30 fps) + `timeline` +
  `transport`; Scene sends `select`/`commit`/`sceneConfig`/`save`.
- **Scene objects** (`shared/protocol.ts` `SceneModel`, `Scene3D`): GLB meshes (`ModelObject` — stable
  group + drei `TransformControls`, bbox-recentred pivot, frustumCull off, shared clones = instancing,
  blob-URL-by-path loader with `useGLTF.clear` on remove) and **screen planes** (`PlaneObject` —
  `PlaneGeometry` + `THREE.VideoTexture` from the timeline engine). `FixtureLights` (≤12 point lights
  coloured by live LED average), `ReflectiveFloor` (`MeshReflectorMaterial`), env/exposure/grid, `Save`.
- **Video-layer timeline** (NLE): `types.ts` `VideoLayer`/`VideoClip`/`Timeline`; engine
  `services/timeline.ts` (render-free clock, one `<video>` per track, clip resolution + blob loading,
  `external` mode in the Scene window driven by the bridged transport); UI `components/Timeline.tsx`
  (dock tab, tracks/clips, drag-drop MP4s, move/trim, scrub). `SourceType.LAYER` + `SurfaceContent.layerId`
  → `surfaceMedia.getDrawable` returns the layer drawable; Inspector "Layer" content picker; planes bind a
  `layerId`. Unified transport = top-bar Play. Persisted in `ProjectData.timeline`.
- File IPC: `READ_FILE` + `PICK_VIDEO` (`ipc.ts`/preload) + `getPathForFile` (preload `webUtils`) for
  drag-dropped clips.
- **Top bar slimmed** (removed logo/undo/save/module switcher; `ModuleSwitcher` deleted; `module` state
  gone) + **Scene** button. **Background throttling disabled** on both windows (+ command-line switches)
  so the engine/timeline/DMX never stall when the other window has focus.

## Portable projects (project folders + Collect Assets)
- **Project = folder**: `project.artlux` + `assets/{video,models,images}/`. New `src/main/projectFolder.ts`
  owns the **single asset-path visitor** `mapAssetPaths` (the only code that knows where asset paths live:
  `timeline.clips[].path`, `scene3D.models[].path` meshes, `surfaces[].content.url` VIDEO/IMAGE, skipping
  `blob:`/`http:`). `relativizeAssets` (save) / `resolveAssets` (load) keyed off `dirname(projectFile)`.
- **Design rule**: all path translation lives in main → the renderer always sees **absolute paths**.
  `persistence.ts` resolves on `open`/`load-path` (so recents + last-project restore work) and relativizes
  on `save`. New IPC: `project:new-folder` / `open-folder` / `collect-assets` (`shared/protocol.ts`,
  `ipc.ts`, preload). Menu items: New/Open **Project Folder…**, **Collect Assets…** (`menu.ts`).
- **collectAssets**: copies externals into `assets/<category>/` (de-dupe by name + size), returns remapped
  data; renderer (`App.tsx` `handleCollectAssets`) applies it + saves; `window.alert` summary.
- **Surface media fix**: `InspectorPanel` stores the real file path (`getPathForFile`), not an ephemeral
  blob URL, so surface video/image persist + collect. Shared `src/renderer/services/mediaCache.ts`
  (`resolveMediaUrl`/`ensureBlobUrl`/`getBlobUrl`) reads a path→blob once; used by `timeline.ts` +
  `surfaceMedia.ts`. Project format `version: '1.1'`.
- Gotcha handled: New-folder save builds payload from fresh locals (not `buildProjectData()`) because the
  reset `setState` hasn't applied to the closure yet.

## Open items
- **ui-ux-pro-max skill** not yet vendored: the `uipro-cli` global install was blocked by the sandbox. Plan: copy `src/ui-ux-pro-max/` from the named GitHub repo into `.claude/skills/` (needs approval). Skill is already usable in-session meanwhile.
- Deferred effects: stateful **fire2012**, **multi-segment** subdivision per fixture.
- **Parity check**: WebGPU vs WebGL pixel output verified only as "initializes + runs"; confirm visually with a loaded source against the DMX Monitor.

## Verification cheatsheet
- Build: `npm run build` (compiles main+preload+renderer).
- Native engine: `npm run build:native` (Rust → `output-engine.node`). Required once after clone.
- Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- Art-Net bytes: a UDP listener on `127.0.0.1:6454` + the transport produces a valid `Art-Net` OpOutput packet (header, `0x5000`, universe, length, payload, non-zero seq) — validated during Phase A.
