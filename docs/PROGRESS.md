# ArtLux — Build Progress & Decisions

Living status log for the rewrite in [ARCHITECTURE_PLAN.md](archive/ARCHITECTURE_PLAN.md).
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
| Plugins | In-process, contribution-based **plugin architecture** (npm workspaces + `@artlux/sdk` + host registries + generic plugin IPC bridge). Contribution types: content-source, clip-kind, projector-channel (data + GPU-render hook), scene-viz, settings/panel; plus a **host-services** surface (`ctx.host` = projectorOutputs/scene3D/projectors) for feature plugins. First-party plugins: **lidar-tracking** (fully inverted — content/clip/projector-data+GPU/scene-viz), **ndi**, **calibration** (fully inverted — engine, host-services, back-channel, wizards, write-path, pose orchestration, and projector-side rendering via a projector-panel contribution; App/ProjectorApp/ProjectorGL import zero plugin code), **spout** (Windows Spout receive — receive-only NDI-shaped extraction), **hap** (HAP video codec — the first `VideoCodec` contribution; `.mov` decode dispatched through `videoCodecRegistry` from surfaces + timeline + thumbnails), **mp4** (GPU WebCodecs H.264/H.265 decode — 2nd `VideoCodec`, **on by default** since `1bbbf4d` (`mp4WebCodecs` absent ⇒ true); hardware `VideoDecoder` + `mp4box` demux, on-demand keyframe-seek streaming, zero-copy `VideoFrame`; a track WebCodecs cannot configure declines at probe time and falls back to `<video>`). Guide: [PLUGINS.md](PLUGINS.md); roadmap: [ROADMAP.md](ROADMAP.md). Automated guard: `npm run verify:plugins` (single-identity). | ✅ core done (v0.18.0); calibration fully migrated (rig-verification pending) | `3ae4480`, `ba498bc`, `e3774e8`, `a389eee`, `7cf6ecd`, `24890d2` |
| Perf | Render/output loop performance pass: renderer frame-time instrumentation (`services/perfMonitor` + `PerfHud` + `artlux_render_*` Prometheus gauges), frame-loop GC wins + broadcast composite skip + throttle-first Art-Net, and a **surface atlas** in the WebGPU mapper (one upload + one compute pass for all surfaces) that fixes a multi-projector GPU-process stall — heavy 4-projector broadcast goes ~16 fps → locked 60. Bottleneck localized by isolation runs; atlas output verified byte-identical (solid + gradient A/B over captured Art-Net). | ✅ done (v0.19.0) | `99d4720`, `05d3d13`, `f0f7ea8` |
| Spanning | **One picture across several projectors, and a soft edge that actually blends.** A `SLICE` surface shows a cropped region of another (`SurfaceContent { sliceOf, sliceRect }`), resolved in `services/surfaceMedia.getDrawable` — the single seam the Stage composite, the WebGPU LED sampler, the projector frame pump and the projector window all pass through — so the output layer, projector IPC, SDK, calibration plugin, NVAPI and NDI are untouched and no project migrates. The source decodes **once** however many projectors it feeds, and the pump ships each output an already-cropped, slice-sized `ImageBitmap` (less IPC traffic than one unsliced output). Outputs ▸ **Spans** cuts a cols×rows grid from one overlap number, deriving every crop *and* every feather together (`services/outputSpan.ts`, pure), with a live cut map, draggable pieces and **Align span** (grids up on the whole wall at once). Also fixed: the soft-edge ramp was `alpha^γ` — inverted — so the middle of every seam emitted **~7%** of full light instead of 100%; now `alpha^(1/γ)` in the GLSL path and mirrored in the NVAPI intensity map. Guide: [OUTPUTS.md](OUTPUTS.md) → Spanning. | ✅ done (CDP-verified: adjacent crops, feather on shared edges only; NVAPI mirror pending Quadro hardware) | `f82ed24`, `8358ea1` |
| Scene timelines | **Per-scene decoupled timelines + per-state authoring loop.** Each `Scene` may own a `Timeline`; recall **warm-swaps** the engine (pool-keyed per-layer decoders, one active at a time — `warmPool`/`swap`/`releasePool`) with a clean first-frame start, backed by a tiered preloader (`services/timelinePreloader.ts`: ACTIVE/WARM/COLD + FSM look-ahead) so swaps stay hitless and steady-state load matches a single-timeline app. Editor binds to the current scene (follows GO/FSM; initial-state scene on load); `buildSceneSnapshot` is look-only; projectors get the current scene's timeline. UX: scene pill + author strip, empty-timeline CTA, per-state accent identity, graph status badges. CDP-verified (`scripts/test-scene-timelines.cjs`, 10/10). Guide: [SCENE-TIMELINES.md](SCENE-TIMELINES.md). | ✅ done (interactive verified; 60 fps warm-swap still to be measured) | `c85483e` |
| Workspace UI | **The editor is context-driven.** One **workspace context** at a time, chosen from a 48px rail, each declaring its whole shell (browser column, viewport, dock tabs, parameter sections, action bar). A context is a *manifest of panel ids* and owns no components, so `contextRegistry.extend()` lets a plugin add to — or supply the viewport of — a context it does not own (`calib`/`audio`/`show` are plugin-supplied, with the host's viewport as the fallback so the rail never has a dead entry). Eleven contexts in four clusters: Build `timeline`·`mapping`·`3d` / Align `project`·`calib` / Show `scenes`·`machine`·`audio`·`tracking`·`show` / App `settings`. Panels read state via `useEditor()` (`state/EditorStore.tsx`) instead of props — **App still owns all state and every mutation**. Presets are gone (`edit`→`mapping`, `perform`→`show`, `calibrate`→`calib` migrate); each context banks its own sizes. Nearly every modal became a workbench (Outputs, Routing, StateGraph, AudioBed, both calib wizards, ShowControl, Preferences; AssetManager deleted). Adds a **Context** menu in both menus, `Ctrl+1..9`/`Ctrl+Tab`, a `Ctrl+K` command palette over every context × action, a full-width `bottom` region for the timeline's NLE shape + program monitor, a multi-output preview, the tablet remote's schedule/playlist/metrics on the desktop, and a **mosaic** Preferences. Also: a global hover/press **interaction floor** (one `:where()`-wrapped base-layer rule; 267 raw buttons had no pressed state, 642 controls covered after) and the 3D **fixture-picking** fix (four causes: 0×0 mount, cached `boundingSphere`, screens stealing 648/649 clicks, model-id not cleared) with a pickable fixture **body**. Guarded by `npm run verify` (10 invariants + typecheck). Guide: [WORKSPACE.md](WORKSPACE.md); interaction states: [UI-UX-AUDIT.md](UI-UX-AUDIT.md). | ✅ done (CDP-verified across all 11 contexts: output stays LIVE on every switch, exactly one three.js context, 0 controls without feedback) | `29579ce`, `0103f38`, `cc43b2a`, `7d02309`, `9b553f6` |
| Cold start | **A show's first run is smooth, and a track holds one clip at a time.** The state machine is HELD on project open until the opening look is decoded — first frame *and* a primed decode-ahead buffer (`VideoCodec.preRoll`) — then both clocks are rewound and it arms (`services/bootGate.ts`; outputs show **PRELOADING SHOW** meanwhile). Cosmetic decoding yields to it: waveforms decode audio containers only (drawing one used to blob-read the SOURCE VIDEO — a 1 GB HAP `.mov` read whole, main RSS 125 MB → 3.7 GB, event loop stalled 1.7 s), and filmstrips wait for the arm, then run one job/second and never open a fresh whole-file read mid-show. HAP hardening alongside: an undecodable variant (HapM) is refused at `open()` instead of retrying at full speed forever, and one decode now serves every window (in-flight dedupe + frame cache; a projector decodes only the layer it draws — it used to run a ring over the whole document). Timeline placement is occupancy-checked, so a clip can no longer be dropped on top of another and vanish under it. Measured on the reporting rig (Iris Xe, 1080p60 HAP): first 30 s went 61→22→61 fps with 251 ring misses → **61 fps on every sample**, 0 long tasks, startup file reads 1.27 GB → 0.5 MB; projector ring 2298 req/30 s → 0, main ring miss rate 13.8 % → 0.1 %. Guides: [STATE-MACHINE.md](STATE-MACHINE.md), [TIMELINE.md](TIMELINE.md), [CODECS.md](CODECS.md). | ✅ done (v0.24.0; bed-during-preload parked for the test campaign) | `7d097f0`, `8ce295a`, `a3dafaa` |
| Moving lights | **DMX fixtures: a library, a rig in 3D, an encoded show, and a USB widget — plus the shell change the last of those forced.** Until now a `Fixture` was a *pixel array* (`ledCount` cells of RGB/W from `startAddress`), so a moving head could not be patched, addressed, driven or seen. Added: a compact **`FixtureProfile`** (channels carry a `role`; a mode is a **flat slot array indexed by DMX offset**, so packing is a loop with no lookup and `slots.length === footprint` is checkable; **pan/tilt stored in physical DEGREES**, which is what lets a take recorded on a 540° head replay on a 630° one — MagicQ calls it head morphing); **`scripts/build-fixture-library.mjs`**, an offline converter turning a pinned Open Fixture Library clone into **506 validated profiles** + its gobo images, committed under `resources/fixture-library/` and shipped as `extraResources` (run it twice ⇒ empty `git diff`); **GDTF import** (`src/main/gdtf.ts`, over `mpcdi.ts`'s dependency-free ZIP reader) for the real manufacturer mesh, resolving which geometry node Pan/Tilt drive **from the DMX mode** (GDTF labels an `<Axis>` but not which axis it is), with the procedural body as the permanent fallback; **articulated movers + additive volumetric beams + capped spotlights** in the 3D scene, **marquee select** and a **multi-fixture gizmo** committing a centroid *delta* in one undo step; **light-show encoding** — a fixture-agnostic `LightingTake` in role space (RDP-reduced curves — **superseded**, see the *Fixture kinds + lighting authoring* row) instanced onto an **ordered** fixture group by a timeline clip carrying phase spread / wing / block / random / mirror / role-mask (the console effects engine as an NLE clip, with generated forms so it is usable before anything is recorded), precedence stated once and enforced in one place (`profile default < authored dmx < lighting clip < automation lane < live override` — a **pose-cue layer was later inserted between the clip and the lane**; HTP on intensity / LTP elsewhere); and **ENTTEC DMX USB Pro** output as `protocol == 2` with the COM path in the existing `ip` field — no wire-format change — behind **one writer thread per port with a single-slot mailbox** so a stalled widget can never stop the network pacer. `Fixture` gained only `profileId`/`profileMode`/`dmx` ⇒ **zero project migration**, and all **seven** DMX-footprint sites now route through `fixtureFootprint()` in `addressing.ts` (the plan counted five). **Shell fallout:** wanting the 3D rig and the timeline on screen together nearly bought a twelfth context, which exposed that the timeline is a **tool, not a place** — it is now a full-width **drawer** eight of nine contexts pull up with `Ctrl+T`, remembered per workbench. That dissolved the `timeline` context (program monitor + media library are dock tabs in Mapping) and merged `tracking` into `3d` (retitled *Venue and Rig*; its three plugins now `extend('3d')`): **eleven contexts → nine**, the timeline no longer **remounts** on a context switch, and `splitView` inside a 3D context no longer yields an empty left pane (a context may name a `companion` viewport). Guides: [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md), [LIGHTING-SHOW.md](LIGHTING-SHOW.md), [OUTPUTS.md](OUTPUTS.md) → ENTTEC, [WORKSPACE.md](WORKSPACE.md). | ✅ done (CDP-verified: 22 assertions incl. the timeline surviving a nine-context tour unremounted; `verify` = 40 invariants + typecheck). **Unverified for want of hardware: the ENTTEC widget on a real rig (COM baud + Mk2 port 2) and GDTF pan/tilt articulation (no mover GDTF).** Deferred: PDF-derived draft profiles, gobo projection | `09abd0a` |

| Fixture kinds + lighting authoring | **Two devices stopped sharing one type, and a light show became authorable.** `Fixture` described a *pixel array*, so a moving head was offered an LED count, a colour order and a serpentine toggle, and was drawn on the 2D canvas where a stray rect silently teleports it. **`services/fixtureKind.ts` is now the only place that decides which kind a fixture is** (derived from `profileId`, never persisted ⇒ no migration), with a three-way `lightState()` because a `profileId` we cannot resolve is *a light we cannot describe*, not a pixel; every inspector section declares `appliesTo` in its **registration**; `autoPatch` resolves a fixture's bucket in one place whose fallback chain still ends on `controllers[0]`, so an unclassified rig patches byte-identically (proved against a pre-change golden over five rigs). The **Fixture Editor dock shrank** to what exists nowhere else — Library + Wiring & Ledmap. On the encoding side: **one curve format** (a take stores `Keyframe[]`, the same thing an automation lane stores; `LightingCurve` survives read-only), a **bezier fitter** replacing RDP so a busk arrives as keys you can grab (Schneider 1990; it must score itself the way the *sampler* reads it — the first version was 238° out on the wire), **pose sequences** (a sparse per-role rule, compiled on edit and never resolved in the frame loop), **Store Key** (the verb that closes select → place → aim → store; a three-case table that never silently does nothing), **pose cues** (`Cue.lighting`, firing a stored look at a group with no timeline involved, sitting between the clip and the lane), **per-slot editing** of a stored key, and a **display map** letting a Pan lane read `270 deg` while storing `0.50` — read by the lane UI only, because `min`/`max` are what `compileAutomation` clamps to. Also fixed while proving it: **a scene recall was replacing the rig** — a Scene snapshotted whole `Fixture` objects, and since the FSM recalls on entering *every* state including its initial one, opening a project deleted a head patched after the capture within nine seconds; `services/sceneLook.ts` now folds only the **look** onto the live rig, and `groups` no longer travels at all (restoring it deleted the group a lighting clip targets by id). Guides: [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md), [LIGHTING-SHOW.md](LIGHTING-SHOW.md), [SCENES.md](SCENES.md), [TIMELINE.md](TIMELINE.md). | ⚠ **built and pushed, but expected to be REWORKED** — treat the decisions as revisable and the findings as durable. `verify` went 57 → 77 checks. Status + how every claim was proved: [plans/lighting-rework-status.md](../plans/lighting-rework-status.md) | `e7b7cfd` … `eae730e` |

| Shaders + node editor | **Generative content you write, and a patcher that writes it for you.** A surface can run a **GLSL shader** (`plugins/shader`, one shared WebGL2 context serving every consumer, `OffscreenCanvas.transferToImageBitmap` per surface): an in-app editor that compiles on `Ctrl+Enter` and **saves only what builds**, an ISF-style header whose declared inputs become inspector knobs *and* timeline lanes *and* OSC addresses through one `AutomationTargetProvider`, an effect library that **copies text into the project** (a venue machine has a different `userData`), feedback via `lastFrame`, and audio uniforms — 16-band FFT, level, and four-channel beat detection with per-shader damping. On top of it, **Shader Nodes**: 83 catalogue nodes and a compiler (`nodeGraph.ts`) that emits *the same text a human would type*, so the compile cache, loop lint, frame budget, header, automation registry, library and projector path never learn a graph exists. The canvas is React Flow with everything shader-specific ours: a menu **at the cursor** on its categories with alias search (`lerp`→Mix, `voronoi`→Worley), typed ports that refuse an illegal wire, drop-a-wire-on-canvas → only the nodes that can receive it, then add **and connect**; `Tidy` (longest-path columns + barycentre ordering); an inspector rendered from the catalogue so a new node is inspectable the day it is added; six **help patches**; and **subpatches** — collapse a selection (`Ctrl+G`), edit the definition in place with the pins shown as `In ·`/`Out ·` nodes, save one to `userData/subpatches/`. A subpatch is **inlined by `flatten()` before generation**, so the GLSL is byte-identical to the flat graph and it costs nothing on the wall. Docs are generated from the catalogue itself ([SHADER-NODES.md](SHADER-NODES.md) — each snippet produced by calling that node's own `emit`), with `verify:docs` failing on drift. Guides: [SHADERS.md](SHADERS.md), [SHADER-COOKBOOK.md](SHADER-COOKBOOK.md); plans: [shader-nodes](../plans/shader-nodes.md), [shader-subgraphs](../plans/shader-subgraphs.md). | ✅ done (v0.25.3). **All 83 nodes compiled on a real driver** (one wired program each) and every gesture driven through the running app. **Unverified on macOS:** whether the Edit menu's copy/paste roles swallow ⌘C/⌘V before the canvas, and audio nodes (needs the JUCE build there). | `d98c713` |

| Precise 3D transforms | **A fixture can be placed exactly, not merely nudged.** Three defects first: the rotate commit **double-applied a single fixture's own rotation** (the handles park on the active fixture, and the commit then read that *absolute* orientation as the drag — yaw 30 dragged by 10 committed at 70; yaw 0 is the identity case, which is why it survived), `W`/`E`/`R`/`Q` were advertised in the tooltips and guide chapter 9 with **nothing bound** (there is now a `scene3d` shortcut scope, live while the pointer is over the viewport, and the tooltips read their key *from* the keymap), and scale silently meant two operations — `Fixture.scaleXYZ` joins the legacy `scale3D` in the shape `SceneModel` already uses (no migration), resolved by one `effectiveScale3`. Then the precision half: the rig **follows the handle** through a React-free module channel (`fixturePreview.ts`) the 3D renderers poll by revision in their own `useFrame`, so the document is still written once on release; snap (mm / degrees / factor, following the armed tool, **Ctrl inverts mid-drag**); rebindable arrow nudge on the same step, where the camera *chooses* the axis and the world *owns* it so a snapped step stays on a round number; a live header readout (offset · distance, angle, factor — *spread* for a multi-selection); and world/object axes. Plus two rows in the existing multi-selection **Arrange** card — *Move by* and *Turn about the centre* — applied on a button, composing rotations through a three-free `services/rotate3.ts` (checked against three over tilted starts and the gimbal pole: worst disagreement 4.4e-16) so the Inspector never pulls three into the main bundle. Plan: [gizmo-precision](../plans/gizmo-precision.md). | ✅ done (v0.25.4). Four new invariant checks — the delta form, the preview staying out of React, the single scale resolver, and the layout signatures naming every field that moves a fixture. The Arrange card was **documented nowhere** before this — guide chapter 9 now covers all of it. | `38fae22`, `7849c6e`, `f575a6e` |

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

Shipped across **v0.3.0** and **v0.3.1** (see `CHANGELOG.md`; UI detail in `archive/UI_REFACTOR.md`,
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

## Startup splash + the licence elections (2026-07-25)
- **`src/main/splashWindow.ts` + `renderer/splash.html`/`splash.tsx` + `components/splash/`** — its own
  760×620 frameless window, opened at `whenReady()` **before** `createWindow()`. A window rather than an
  overlay because the editor window is hidden until `ready-to-show` (4s backstop): an overlay inside
  `index.html` cannot cover a window that is not visible yet.
- **`src/main/bootReport.ts`** collects what loaded, in two waves — host natives + main plugin halves
  during `registerIpc`, then the editor renderer's halves once App mounts — and **re-sends the whole
  report on every change**, so a splash that attaches late renders a snapshot instead of reassembling a
  stream it joined. Plugins report through a new optional `status?()` on both SDK halves.
- **Timing was got wrong twice, and the measurements are why it is what it is.** Anchoring the wait on the
  editor's *paint* failed: the editor is visible at ~100ms but its plugins don't activate until ~6.3s
  (5MB of bundles + App mount), so at a 2.5s grace the second wave missed **every** run and the console
  always showed half a report. And `MIN_MS` from window-show closed the splash ~100ms after the last row
  landed, so the completed console — the whole point — was never readable. Now: grace measured from the
  splash's own clock (9s), plus a **dwell measured from report completion** (900ms), plus a hard 14s
  backstop for "the editor never came up at all". Instrumented in the log (`editor visible at Nms`,
  `renderer reported N plugin(s) at Nms`, `closing after Nms — report complete|PARTIAL`).
- **Console height was measured, not guessed:** 14 rows ≈ 245px of well. At 480 and 560 tall the well
  fitted 6 then 11 rows — and because it auto-scrolls to the tail, the rows cut were always the *first*
  ones (the native addons). 620 fits the lot.
- **Licensing, settled and recorded:** `LICENSE` (Non-Commercial Educational, © Jawhari + Recoules), JUCE 8
  under the free **Starter** tier with **AGPLv3 expressly not elected** (it would grant the commercial
  rights `LICENSE` §2 withholds), `JUCE_DISPLAY_SPLASH_SCREEN=0` reconciled, and libspatialaudio's LGPL
  static-link obligation discharged by a written relink offer. `NOTICE` open questions (a)/(b)/(d) closed;
  the Starter revenue test is still unconfirmed with JUCE and is named as such.
- **Guards** (`verify:invariants`): `splash.open()` has one call site, gated `!HEADLESS && !BROADCAST`
  (broadcast is the watchdog's relaunch mode — an always-on-top window over live projector output); and
  the credit + licence line have one source and are rendered by both the splash and About, which is a
  `LICENSE` §3 obligation. Both negative-tested.
- **Found in passing:** `bg-bg-stage` was documented in DESIGN-SYSTEM §1.1 but the `bg` key was never in
  `tailwind.config.js`, so the class silently rendered transparent. Fixed.
- **Both authors hold a free personal JUCE Starter seat** (§1.7), which is also what keeps §1.2.1's revenue
  test on the individual definition. The MIT HRTF dataset was reviewed — MIT-licensed, credit to Digenis /
  Gardner / Martin — and no SOFA data is bundled, closing that notice item.
- **v0.25.0 is the first release since v0.21.0**: v0.22–v0.24 were each prepared and never tagged, so this
  is also the first *distributed* build to carry a LICENSE, a settled JUCE election, and notices that match
  what the installer actually ships.
- **The release was cut three times, and both failures are worth keeping.**
  1. *macOS wouldn't compile.* `juce::jmin<size_t>` drags `SIMDRegister<size_t>` into overload resolution;
     on arm64 macOS `size_t` is `unsigned long` while JUCE's NEON header only defines `SIMDNativeOps` for
     `unsigned long long`. Green on Windows and Linux, where the types coincide, for weeks. → `std::min`.
  2. *The splash never appeared in the packaged installer* — created, never shown, because it revealed on
     `ready-to-show` alone. **This was already documented in DEVELOPMENT.md → Testing from v0.19.2, where
     it cost a day on the editor window, and the entry even prescribes the fix.** Nobody re-read it before
     adding a second window. That doc entry is now the guard's rationale, and `verify:invariants` enforces
     it so the knowledge no longer depends on someone remembering to look.
  Both bugs share a shape: **invisible in dev, only real once packaged.** `npm run dev` and `electron .`
  against `out/` are not valid tests for window reveal (the dev-server load triggers `ready-to-show`), and
  neither is a CDP probe — `ARTLUX_CDP_PORT` forces a paint, so it falsely passes. Only launching the
  packaged `ArtLux.exe` with no CDP port proves it.

## Engine decoupling — a UI-independent render/output engine (approved 2026-07-26)

The frame loop lives in a React effect, and **Art-Net stops if a DOM node is missing** (`Stage.tsx:295`
`containerRef`, `:414` `canvasRef`) — even on the WebGPU path, where sampling never touches the visible
canvas (it composites into a private offscreen atlas). That is the root cause of the "Stage must never
unmount" invariant, and therefore of every expensive workspace redesign. Two code surveys also established
that the engine is **already 95% decoupled in disguise**: nothing under `services/` or `gpu/` imports React,
the tick reads only refs + singletons, outputs are pub/sub buses, and the timeline engine already self-starts
at module import. Approved programme: extract a self-starting `renderer/engine/frameEngine.ts` (main thread),
modernize media to `VideoFrame`, then move the engine into a **Worker** with a zero-main-thread-hop
MessagePort to main — keeping React panels so the plugin SDK is untouched. A new-UI-library migration
(Solid) and a full GPU widget toolkit were **evaluated and rejected**, on the evidence that every recorded fps
incident here was GPU/decode/IO and never React. Canonical plan, WP tracker and session protocol:
[plans/engine-decoupling.md](../plans/engine-decoupling.md).

- **WP-0.1 — the UI's cost is now measurable** (`59d89d7`). `services/uiPerfMonitor` adds the two signals
  `perfMonitor` structurally cannot see: **long tasks** (`PerformanceObserver`, always on — the browser
  reports only the rare offenders) and **React commit time per named region** (opt-in behind `?uiperf=1`,
  because `<Profiler>` is not free), surfaced in the Performance dock tab and as
  `artlux_ui_blocked_ms` / `artlux_ui_long_tasks` / `artlux_ui_commit_ms`. Reads are **non-mutating**
  (100 ms buckets over a 1 s sliding window) because two independent 1 Hz readers poll it and a
  drain-on-read accumulator would give each of them half the events. The opt-in flag is read **once at
  module load with no runtime toggle** — `UiProfiler` branches on it, and React keys a child by position
  *and element type*, so a flag that could flip mid-session would remount `Stage` (which publishes
  `dmx:frame`), `Simulator3D` and the single `TimelinePanel`. Invariant-guarded, and the guard's first
  version **passed a deliberate break** because a leftover import still matched the identifier — the trap
  this repo already documents — so it now asserts the branch. CDP-verified end to end: a 400 ms synthetic
  stall travelled observer → IPC → main → Prometheus (baseline 0 → peak 320 ms / 4 tasks).
- **WP-0.2 — a geometry drag is local until you let go** (`c70c13a`). Dragging a fixture pushed the whole
  array up to App on **every pointermove**, re-rendering the entire editor at pointer rate — every
  `useEditor()` panel, all five persistent viewports, and a full rebuild of `Simulator3D`'s LED
  `InstancedMesh` (its layout signature includes `x/y/w/h/rotation`, so `computeLedPositions` ran over
  every fixture in the rig, per move). A local draft now drives Stage's own render and App is told once,
  on release — the rule the timeline already follows. Two things deliberately do **not** wait: the refs
  stay live (so the frame loop keeps sampling the drag, and Art-Net follows it), and `updateMapping` is
  called directly from the move handlers, because the effect that used to do it is keyed on committed
  props that now stop changing mid-drag. The **surface** drag had the identical defect and was fixed with
  it. A/B measured live by hot-swapping the file mid-session: unrelated-viewport commits during an
  identical synthetic drag **51 → 10**, drags still track live / commit once / never snap back, 60 fps
  held. The 3D scene now follows on release — that being exactly the rebuild described above.
- **WP-0.3 — an idle editor rebuilt itself twice a second** (`9124252`). Nobody touching anything, nothing
  playing, and every panel + all five persistent viewports + Stage + the 3D scene + the timeline were being
  reconciled 2×/s, forever. The cause was two numbers: `renderFps` and the native pacer's `outputStats`,
  both `useState` in **App** — which owns all document state, so one of its renders rebuilds the whole tree
  — and both drawn in one corner of the status bar, read by nothing else. They moved to
  `services/telemetry` (the `cueBus`/`helpBus`/`layoutStore` idiom, with no-op updates dropped); only
  StatusBar subscribes, re-rendering at 1 Hz, which is correct for a 1 Hz number. **A/B measured idle**:
  commits on the viewports that have no clock of their own — and can therefore only move when App renders
  — went **6 per idle second → 0**. ⚠ The originally-planned `React.memo` on those viewports was
  **deliberately not done**: each is handed freshly built props every render (inline `extraControls`
  element, arrays rebuilt by `filter`/`map`, a dozen inline arrows), so a shallow compare can never bail
  out — it would have cost a compare per render, bought nothing, and read as protection. Stabilizing App's
  handler identities (the `ActionsCtx` facade already does this for panels) is tracked as its own pass.
- **WP-1.1 — the frame loop leaves the component** (`0e34015`). Composite, GPU sampling, universe
  packing and publish now live in **`renderer/engine/frameEngine.ts`**; `Stage.tsx` sheds ~450 lines and
  becomes a viewport, some draggable overlays and a canvas the engine paints into. None of that work was
  ever React work — every service it calls was already framework-free, and the component was reaching all
  of it through a dozen refs mirrored out of props. Those refs *were* the input contract; it is now one
  `setInputs()` struct, and the three `JSON.stringify` signature memos + their effects collapsed into
  plain change detection inside it. **Not moved yet, deliberately:** Stage still owns the rAF and builds
  the mapper, and the engine still refuses a frame until `domReady` — the last DOM gate on output, kept
  under that name so WP-1.2 deletes it rather than discovers it. **A/B verified live** (hot-swapping the
  file mid-session): the native output engine receives **61 Hz over 1 universe** before *and* after, with
  the renderer at 60 fps — exercising the whole publish path (tick → `dmxSignal` → App → `encodeFrame` →
  IPC → the Rust send thread). New guard: `engine/` never imports React.
- **WP-1.2 — output stops being a property of the view** (`4a95626`). The engine starts its **own** rAF
  when its module loads (the `services/timeline` idiom) and **both DOM gates are deleted**. Those gates
  were the entire coupling, and they were two lines: the loop bailed out if the container ref was empty,
  and again if the canvas ref was empty — the second one *even on the WebGPU path, where sampling never
  touches the visible canvas*. That is what "Stage must never unmount" was protecting, and why the
  workspace had to be built around a viewport that could not move. The composite is inverted to match:
  the engine composites into its own canvas and the visible one is a **blit** — previously, on the WebGL
  fallback, the sampling source *was* the Stage's visible canvas, so LED output was reading pixels out of
  a component's DOM node. **Verified by deleting the Stage's canvas and container out of the running
  app**: the native output engine held **61 Hz / 1 universe** throughout. WebGL fallback re-checked
  (61 Hz, blit lands). New guard: the engine drives the rAF, `Stage.tsx` drives none, no `domReady`
  returns, and the engine never early-returns on a missing preview canvas.
- **WP-1.3 — the engine owns the mapper and the wire; a show mounts no view** (`52136f3`). Three
  leftovers of the same shape. The **GPU mapper** was built and torn down by a component effect, so the
  app's ability to sample pixels was created and destroyed by a React lifecycle — the engine builds it
  now and publishes *which backend came up* as status, which the Stage subscribes to purely in order to
  keep showing the reduced-mode banner. **Sending Art-Net** was a `dmxSignal` subscriber inside App,
  which made putting frames on the wire something the document opted into (and re-subscribed on every
  settings change); it is the last step of a frame instead. And **headless rendered a hidden 1×1 Stage**
  — a venue machine mounting a React viewport in an invisible one-pixel box so that DMX would come out;
  the show branch now returns `null`. That forced the useful part: engine inputs are pushed from **App**,
  which owns the document, so **`Stage` lost ten props** and what remains is what a viewport actually
  needs. **Verified:** headless with a purpose-built project and no Stage anywhere → 61 Hz / 1 universe
  at 60 fps renderer; the editor still survives its Stage DOM being deleted; drags unchanged.
- **WP-1.4 — the docs stop describing a wall that is no longer there** (`2a042ba`). Six places still said
  the Stage owns the output and must never unmount — the single most load-bearing sentence in the
  workspace docs, and the reason the shell was designed around an immovable viewport. A stale invariant is
  worse than none: someone reads it, believes the constraint, and designs around it. The **Stage half of
  the mounted-exactly-once guard was dropped, not demoted** (docking may legitimately want the 2D stage in
  more than one pane); the `TimelinePanel` half stands on its own. New guard: **one engine, and it is the
  only thing that publishes a frame** — two instances would each run a loop and each publish, giving the
  fixtures two interleaved DMX streams that would present as unplaceable flicker. WORKSPACE's *Out of
  scope* note on free-form docking is **corrected rather than deleted**: half its reasoning ("a poor fit
  for the per-frame GPU repaint loop") was really "the Stage cannot move", and what actually remains
  single-instance is `Simulator3D` and `TimelinePanel` — two elements, not the whole shell.
- **Phase 1 is code-complete; C1 (rig checkpoint) is open.** Smoke-tested against a real 66 KB project
  (2 surfaces, 2 fixtures, 6 scenes, 23 assets, enabled 6-state machine): **4345 ArtDmx packets on
  universes 0–3**, 60 Hz native / 61 fps renderer, a full nine-context tour with output never dropping,
  and headless verified with no view mounted at all. **What still needs a human and hardware:** the
  real fixtures on the wire, a broadcast/projector run, and a longer soak.
  The **packaged** half of that checkpoint is done: `npm run package:dir` → `release/win-unpacked/`,
  launched **with no CDP port**, reveals its window (`"ARTLux" 1456×908`) and runs 61 Hz / 4 universes /
  59.9 fps; `--headless` runs 61 Hz / 4 universes with **no window at all**. That is the check this repo
  has twice been burned by skipping — a dev run *and* a CDP probe both force a paint, so both pass while
  the shipped app shows nothing. (Benign packaged log lines: `nvwarp NVAPI unavailable` on a non-pro GPU,
  and `app-update.yml ENOENT`, which only exists in a full installer build.)
  See [plans/engine-decoupling.md](../plans/engine-decoupling.md) → tracker.
- **WP-2.1 — WebCodecs is the default `.mp4` decoder, and a codec stopped claiming files it cannot
  decode** (`1bbbf4d`). Flipping `mp4WebCodecs` to default-on was the small half. `mp4Decoder.open()`
  proved only that **mp4box could demux** the container — it never asked whether WebCodecs could
  **decode** the track. An HEVC profile or a 10-bit pixel format demuxes perfectly and then fails at
  `configure()`, which surfaces far away as a console warning and **no frames** — by which point the host
  has handed the file to the codec and dropped the `<video>` that would have played it. The surface goes
  **black while the app reports it is playing**: the exact "UI claims something the engine is not doing"
  shape this repo kills on sight, and a foot-gun that would have become everyone's default. `open()` now
  asks **`VideoDecoder.isConfigSupported()`**, so the three fallbacks that already existed and were
  already correct finally get reached. **Verified on the wire** (not by inspection): purpose-built
  project, `tears_of_steel.mp4` on a surface, 60-LED fixture, headless with a UDP listener on universe 0
  — WebCodecs on gives **1301/1503 frames carrying light, peak channel 112, 351 distinct channel-sums**
  (a picture that moves); forced back to `<video>`, 1069/1281 and 283 sums. Both light the fixture, which
  is what makes the escape hatch worth keeping. `.mov` was deliberately **not** widened into — that
  extension belongs to HAP.
- **WP-2.2 — images decode to `ImageBitmap`, the camera reads `VideoFrame`s** (`0ecc0da`). Both were DOM
  elements pretending to be pictures, and both are the things that cannot follow the engine off the main
  thread. `getUserMedia` still runs in the window (it needs the permission context), but what comes back
  is a **`MediaStreamTrackProcessor`** frame stream rather than a player. Both new kinds are
  `CanvasImageSource` and `drawableSize` already duck-typed `displayWidth`/`width`, so every consumer and
  the whole slice/crop path took them unchanged. **The real work was ownership:** an `ImageBitmap` holds
  GPU memory the collector won't hurry to reclaim, and a `VideoFrame` pins a decoder buffer — leak a few
  and the camera stalls outright — and **neither failure looks like anything on screen** (the picture is
  fine, the memory climbs). So the drop path closes bitmaps, the pump closes the frame it replaces,
  `stopCamera` closes the held one, and a decode superseded mid-flight closes its own result.
  Invariant-guarded, because none of it is visible when it breaks. **Verified on the wire:** a still on a
  surface, 60-LED fixture, headless + UDP listener — 1923/1929 frames carrying light, exactly **2**
  distinct channel-sums (what a *still* should give), RSS flat. ⚠ **Camera pixels are UNVERIFIED**: this
  machine has no working camera (5 video inputs enumerated, none deliver frames), confirmed as the
  machine and not the change by an A/B against HEAD, which is equally black. The `<video>` path remains
  an automatic fallback where the processor is unavailable.
- **WP-2.3 — the byte-sources leave the DOM, and stop repainting nothing** (`832eb11`). DMX-in, Spout and
  NDI all receive raw bytes over IPC and assemble a picture for the sampler. That canvas is **never
  displayed** — it exists only to be sampled — so a DOM element was wrong twice: it cannot live in a
  worker, and it tied a background data path to the document. All three now use an **`OffscreenCanvas`**.
  The half that costs something *today*: each is asked for a picture once per consuming surface **and**
  again inside the GPU sampler's per-surface closure, so unchanged bytes were re-packed into `ImageData`
  and re-uploaded several times per frame — and on **every** frame while a sender sat idle. They now
  count arrivals and skip. **Verified end to end on DMX-in** (the only one drivable here): a `DMX_IN`
  surface fed a moving pattern at 30 Hz into the app's Art-Net input → **1035/1043 output frames lit,
  peak 255, 393 distinct channel-sums**, i.e. the picture arrives *and* keeps moving, which is what rules
  out the skip sticking on a stale frame. ⚠ Spout and NDI share the code shape but have no sender on this
  machine and are **unexercised**. The planned `queue.writeTexture` was **deliberately deferred to Phase
  3**: it needs a drawable-contract change across the SDK, the mapper, `surfaceMedia` and the projector
  pump while the 2D composite still needs a `CanvasImageSource` — and the thing actually blocking the
  worker was the DOM canvas, which is gone.
- **WP-2.4 — HAP decompresses into an `OffscreenCanvas`** (`ea68908`), the last DOM canvas on the media
  path. `hapGL` draws BC blocks to a canvas that is **never displayed** — a decompression target that
  gets sampled. Two ways back, because HAP is the codec real shows here are built on: an **automatic**
  fallback when `OffscreenCanvas` *or a WebGL2 context on it* is unavailable (API-present ≠ API-works),
  and a per-machine `localStorage['artlux.hapDomCanvas']` revert for a venue that needs the old path
  without a rebuild. **Tested against a real 1080p60 Hap1 file on the wire**: 2239/2250 frames lit, peak
  253, 724 distinct channel-sums, renderer **flat at 59.9 fps across 12 samples** — no dip, which is the
  shape the 61→22→61 HAP startup regression would have taken. **The revert was exercised**, not merely
  written: flag set, app restarted, HAP still playing on the DOM path (1201/1201 lit).
- **Phase 2 is code-complete; C2 (media soak) is open.** Verified on the wire against real media:
  MP4/WebCodecs, images, DMX-in, HAP. **Unexercised for want of a source on this machine: Spout** (no
  sender), **NDI** (no source), and **camera pixels** (no working camera). Those three are what C2 is
  for. See [plans/engine-decoupling.md](../plans/engine-decoupling.md) → tracker.
- **WP-3.1 — a direct road from the engine to the wire** (`dc01ad9`). Main opens a `MessageChannelMain`
  on every load and hands one end to the renderer (the **projector-port recipe**: preload relays it with
  `window.postMessage`, because a port cannot cross the contextBridge). Packed universes travel that port
  instead of `ipcRenderer`, so once the engine leaves the main thread it can keep sending without hopping
  back onto it. Payload is **identical** to `IPC.FRAME` (`encodeFrame` output) — a second road to the
  same door, not a second protocol — and a missing port **falls back to IPC**. ⚠ **The finding, and the
  reason this took a while:** `postMessage(buf, [buf])` — the standard zero-copy idiom, perfectly legal
  on a DOM MessagePort — **does not work across Electron renderer→main**. The message *arrives* (the
  handler fires, on time, every frame) but **`e.data` is `null`**. No error, no warning, nothing in
  either console: a steady stream of empty messages and a venue with no output, while every gate you
  would suspect reports healthy — transport ready, port alive, renderer at 61 fps. Frames are now copied
  (539 bytes at a 44 Hz cap) and a guard prevents the "optimisation" back to transfer, which would
  silently kill the show. **Verified on the wire:** 834 ArtDmx packets, 274 distinct channel-sums, native
  63 Hz, renderer 61 fps.
- **Phase 3 (the Worker) is PAUSED at a measured fork.** WP-3.2 assumed media production was already
  `VideoFrame`-based; it is not. `contentSource` still creates `<video>` elements for anything the codecs
  decline (and calls `window.artlux`, absent in a worker), and `services/timeline` keeps a per-layer
  `<video>` pool *and* is the show engine. The platform is fine — probed: a Worker here has
  `navigator.gpu` **with an acquirable device**, `OffscreenCanvas`, `VideoFrame`, `VideoDecoder`, WebGL2,
  and takes a transferred `MessagePort`. So the question became *what would the worker buy?*, and it was
  measured on the real project:
  **the wire is already immune to a frozen renderer** — through a deliberate **900 ms main-thread
  freeze**, 172 packets went out over 967 ms (178/s vs 226/s idle), worst gap **45 ms**, because the
  native Rust pacer re-sends the last frame. Ordinary UI stress (three full context tours + forced
  reflow) produced **0 wire gaps over 100 ms**. What degrades is *frame timing* — render p99 **54 → 155
  ms**, long frames **18 → 40**. **So a worker buys smoother content under heavy UI load, not show
  survival**, and Phase 3 waits for evidence that is worth the rewrite.
  ⚠ **The measurement also caught a flaw in our own instrument:** `artlux_ui_blocked_ms` reported
  **101 ms for a 900 ms freeze**, and only 1.4 s later. It under-reports and lags — read `0 ms/s` as *no
  evidence of blocking*, never as *no blocking*.
- **`scripts/test-engine-output.cjs`** (`967648d`) — a committed harness that proves on the wire what
  `verify` can only assert about source: output survives the Stage's canvas *and container* being
  deleted out of the live DOM, a full context tour, and `--headless` with no view mounted at all.
- **WP-0.4 — the Stage is memoized, and the real UI cost turns out to be elsewhere** (`eced6ea`).
  `hooks/useStableHandlers` extracts the `EditorStore` Proxy trick (permanent identities forwarding to
  today's closures) so App can apply it to callbacks passed as **props**; with that plus a memoized
  toolbar, every Stage prop is referentially stable and `viewport:stage2d` commit time during a context
  tour drops **1.2 ms → 0.0 ms**. **The measurement matters more than the change:** the same run shows
  **`viewport:timeline` at 224 ms/s across 10 commits** (~22 ms each) — on the panel open in eight of
  nine contexts — versus scenes 13.7 ms, outputs 2.5 ms, stage 1.2 ms. **That is the source of the
  p99 54 → 155 ms hitching**, so the next UI-cost work belongs in `TimelinePanel`, not in another
  memoization sweep. ⚠ Commit *counts* would have hidden this entirely: the Profiler measures its whole
  subtree and App rebuilds each viewport's wrapper `<div>` every render, so the count read 1 → 1 while
  the **time** read 1.2 → 0.
- **WP-0.5 — the timeline stops re-rendering itself on a clock** (`34904d9`). The 224 ms/s above was
  not the cost of touring contexts; it was a `setInterval(…, 100)` **inside `Timeline.tsx`** sampling the
  playhead and the show clock into React state so the automation lanes could print a live value. Ten full
  renders of the panel a second — toolbar, ruler, every track header, every clip, every lane — **for
  ever, in eight of nine contexts, whether or not the transport was moving and whether or not a single
  automation lane existed**. (Ten commits in a one-second window *is* the interval; nothing about the
  tour.) The lanes now take the **name** of their clock (`clock: 'playhead' | 'show'`), read it
  themselves, and write the readout straight to the DOM via `engine.subscribe` — the discipline the 60 Hz
  playhead and timecode always used. The 1 Hz automation-target re-enumeration stays (it is how a lane
  notices its target was deleted) but compares a signature and returns the same object when nothing
  changed. **A/B on the operator's real project, idle: `artlux_ui_commit_ms` mean 177 → 0.0 ms/s, peak
  207 → 0.0.** Functionally proven against a ramp on both clocks — 20 distinct readout values in 20
  samples, at 0.0 ms/s — with a positive control (context switching still commits, 96 ms/s) so the zero
  could not be a dead instrument. Also fixed: "add a keyframe here" wrote the stale 100 ms sample as both
  the key's time and value. Guard: `the timeline never puts a clock in React state`.

- **WP-0.6 — the clip drag stops rebuilding the ruler** (`f55fea6`). WP-0.5 removed the timeline's *idle*
  cost; this is the interaction one. A clip drag setStates a draft per pointer move — idle 0.0 → **277–493
  ms/s while dragging** — and attribution with temporary in-panel profilers put **170 ms of the panel's 341
  in `TimelineRuler`**, 61 in the toolbar, and only 9.5 in the lanes. The instinct was to memoize the lanes;
  the measurement said the ruler, which renders one tick element across the full width of an unbounded
  timeline — **32,957 px in a live session, ~800 ticks**, rebuilt on every pointer move. Both are
  `React.memo` now, handed one `useStableHandlers` bag each, a memoized `overrun`, and a shared
  `EMPTY_MARKERS` in place of `timeline.markers ?? []` (the fresh-array-per-render that would have made the
  whole thing inert). Re-probed mid-drag they report **0.1 ms across 35 commits** — they genuinely bail.
  End-to-end the drag went **493 → 378 ms/s** in one A/B and sat in noise in another, which the finding
  itself explains: the cost scales with how far the timeline has grown, so it is small on a fresh project
  and large in a long venue session. Verified live that nothing broke: zoom redraws the ruler, Snap toggles,
  Add Track adds, Add Marker lands a flag, no `stableHandlers` warning. Guard: `the timeline ruler and
  toolbar are memoized, and handed props that hold still`. **What remains is ~10 ms per render of
  Timeline's own body**, which no memo reaches — making the drag render-free is the next idea.

- **WP-0.M — the closing measurement: what the Phase-0 UI work actually bought** (`4546ad1`). Re-ran
  WP-3.M's stress on the same project with the profiler off. **Idle frame p99 54 → 21 ms and long frames
  18 → 0 / 240** — the tail is gone, which is WP-0.5's 177 ms/s seen from the frame-timing end instead of
  the React end. **Under heavy UI load the p99 is unchanged (155 → 168).** That is the finding rather than
  a failure: the load-case hitching was never React commit cost — it is the context switch itself (~70–105
  ms) plus forced layout, and no memoization reaches either. Output dipped 61.9 → 54.7 Hz through the load
  (worst second 50 Hz, 141 packets/s throughout) and never stopped, as 3.M found. So 3.M's conclusion
  stands for a better reason: a worker would buy smoother content under load, and that load is now
  demonstrably all that is left to buy.

- **The dockable workspace (Phase 5, WP-5.1 to 5.6)** (`cb09097`, `db0956c`, `27ee1c6`, `ab8ec95`, `1f7202c`, `f5d35de`, `5d3e644`). Panels drag between
  groups, drop on an edge to split, add, close, collapse, and reset — per context, persisted.
  **ON BY DEFAULT** since WP-5.6; both renderers ship one release, with two ways back (*Preferences ›
  Appearance › Dockable workspace* and `localStorage['artlux.docking']='0'`). **The flip was a RENAME,
  not a value change** — it shipped as `docking?: boolean` defaulting to false, so every install that
  had saved a layout carried `docking: false` and would never have seen the new default; the key is
  now `dockingOff?`, where absence means the current default. That is the same failure mode
  `layoutRev` exists for, and the fix generalises to any persisted boolean whose default you flip.
  **It costs the SDK nothing:** the
  arrangement is compiled from the flat manifest a context already declares, and the ABSENCE of a
  saved tree is the migration trigger, so an upgrading install sees nothing move. The elements that
  cannot be moved or duplicated (`Simulator3D`, `TimelinePanel`) are POSITIONED over slots
  by direct style writes rather than reparented. **What made this affordable was Phase 1:** deleting
  “Stage must never unmount” removed the constraint every previous docking design had to be
  built around. **Three layout bugs were then found by the operator within minutes of real use**, all
  invisible to checks that only ever ran at two window heights: a fixed pane that could not shrink
  (painting the lower half of a short window black), `fr` factors summing under 1 (flexbox then
  distributes only that fraction of the free space — a black band across the middle), and a
  splitter drag whose pixel values stayed pinned, because React rewrites a style property only when
  its own props change. All three are guarded; the reasoning is in docs/WORKSPACE.md.

## v0.25.2 — a heavy show opens without reading itself, and the engine stops asking faster than the decoder can answer (2026-08-06)

Two halves of one campaign (branch `preload-optimization`, 20 commits). Full record, including what was
measured and **dropped**: [plans/preload-optimization.md](../plans/preload-optimization.md).

**The gate had never worked.** ArtLux holds the show at project open until the opening look is decoded
(`services/bootGate.ts`), and the measurement that opened this work said it had **never once reached
`ready`** — on any project, ever. It always failed open at its deadline, which means its readiness logic
and the codec pre-roll that serves it had been applying to nothing. The owner's real show: 17.1 s
`armedBy=timeout` → **7.3 s `armedBy=ready`**. When a gate reports a timeout every single time, suspect
the gate, not the workload.

**Nothing is read to be played any more.** Media streams over an `artlux-media://` scheme with HTTP Range
against a per-project allowlist, instead of being read whole-file over IPC into a Blob. On a 60-scene /
2400-clip / 2.3 GB fixture: bytes read at open **887 MB → 0**, renderer heap 1459 → 326 MB, peak main RSS
1963 → 284 MB, codec residency while walking the show 3793 MB-and-climbing → **~250 MB flat**. `mediaCache`'s
blob path was **deleted** rather than budgeted — after streaming it had no consumers left. The warm-pool
budget now actually binds (its own protect set had been bypassing it), candidates are ranked by imminence
including `fromAny` transitions, and pools can release.

**Then playback stuttered, and it was not a preload problem.** With shows opening fast, heavy video
visibly stopped and started. It presented as late loading — *"as if we load the video when the playhead
reaches it"* — and three decoder-side fixes failed before the cause came out: **every engine tick asks
each layer's codec for the exact frame at the playhead, and asking faster than the decoder can serve does
not produce more pictures.** The ring answers with the *nearest* frame it holds, and a burst of those is
the stutter. Uncapped (~60 Hz of asks): **19.0%** of exact frames missed, 78 in the worst half-second. At
25 Hz on identical content: **0.27%**, worst half-second 9, and 4 of 4 scene cuts clean.

What pointed there, after the guesses: the **projector** window — decoding the same media, but only for
the one surface it draws — missed **0.007%** throughout. The window doing *more* work barely suffered,
which is an argument against the decoder and for how often it was being asked.

Ships as **Preferences ▸ Engine ▸ Engine rate (fps)**, `AppSettings.engineFps`, default **30**,
machine-scoped because the right value depends on the computer's disk and GPU rather than on the show.
⚠ **This changes every show, not only heavy ones** — the engine no longer runs at display rate. It is
**not** the Art-Net rate: the native pacer sends at `AppSettings.fps` with keep-alive, so a slower engine
repeats the last frame on the wire rather than starving a node.

**Dropped on their own evidence, not deferred.** The planned "make the open O(1) in scene count" phase:
the `normalizeTimeline` it targeted costs **3.3 ms at 160 scenes** — 0.5% of the open, against the largest
blast radius in the plan. And HAP `MAX_INFLIGHT` 3→6, which moved the miss rate 18.1% → 20.6%.

**The method note worth keeping.** Resident bytes tell you something is *cached* — never that the frame
being *asked for* is there. Two failed fixes measured green against residency while the operator still
saw the hitch. The instrumentation that finally separated the two ships with it, measure-only:
`window.__artluxLayerGaps()` and `__artluxHapPulls()`.

⚠ **Projector output windows and real Art-Net to hardware are unexercised** — no projector or LED node on
this machine. Both paths typecheck and are invariant-guarded, but this release changes how often frames
are produced. Exercise a fullscreen output and watch a real node before it drives a show.


### …and the four places that assumed the engine ran at display rate

Capping the engine did not just change a number — it invalidated an assumption four unrelated places had
baked in, and every one of them was invisible in the editor preview. Found by running a **fullscreen
projector output in broadcast mode**, which is the path the rest of this release could not exercise.

**Three producer/consumer seams, all gated at 33 ms.** Each was written when the engine always ran faster
than it was sampled, so "every other tick" was stable. Against a 30 Hz producer they alias: sub-millisecond
jitter drops a whole update.

| Seam | Symptom on the wall |
|---|---|
| Transport → projector | The playhead arrived 33, 33, **66**, 33 ms apart. A projector decoding a HAP layer *locally* uses it as its time base → a visible hitch |
| Frame pump → projector | A codec's drawable generation only advances when the engine asks, so pump and producer beat against each other and frames were held |
| mp4 refill | `pump()` ran only from `frame()` — **the decoder refilled only when asked**. Half the asks, half the refill rate at a cold clip entry → most of a second of missing video |

The gates are now finer than any selectable producer period (15 ms passes every tick at both 30 and 60 Hz),
and the mp4 decoder tops itself up from its **own** rAF. Shipping did not get more expensive: the generation
dedup still decides when a bitmap is made. The consumers that *cannot* dedup — live sources with no
generation, the render-from-projector layer streams, the referenced-surface budget — explicitly keep the
original cadence.

**The fourth was the tablet's health tiles**, which is the one nobody would have reported. Both thresholds
were absolute (`fps < 50`, `p99 > 25 ms`), written when 60 Hz was the only possibility. A perfectly healthy
30 Hz show reads 30 fps with a ~33 ms p99 — so an unattended venue's remote would have sat **permanently
amber**, which is worse than no indicator: it teaches the operator to ignore the colour. Now judged against
the show's own frame period. The long-frames tile needed no change; it was already relative (`p50 × factor`),
which is the pattern the other two should have followed.

Verified in broadcast on a real fullscreen output, after resetting every counter so the window contains no
boot noise: **0 gap events across 5 clip switches, 0 HAP ring misses in 3055 asks, 5442 pump ships with 0
aliased skips**, frame delivery 33.3 ms median / 33.5 p95 / 66.5 max. The same run before the reset — which
included boot — showed 492 gaps and an 816 ms pump stall.

**And the Art-Net question is now measured, not argued:** `artlux_render_fps 30.12` with
`artlux_output_fps 61`, live in broadcast. A slower engine does not starve the wire; the native pacer sends
at its own rate with keep-alive.


## v0.25.1 — a relaunch cannot inherit a dev server, and a packaged tray needs a packaged icon (2026-08-05)

Two independent defects, both in broadcast mode, both silent, found in one session.

**The relaunch.** `app.relaunch` spawns the successor with the current process's environment — there is
no `env` option — so it inherited electron-vite's `ELECTRON_RENDERER_URL`. The `app.exit(0)` that
follows is precisely what makes electron-vite tear that dev server down, so the successor spent its
whole life loading a port nobody was listening on. **Nothing threw**: main booted, argv was right, the
plugins activated, the tray appeared, `/metrics` answered `mode="broadcast"` — and the renderer never
painted, so `App` never ran and no projector output opened. Broadcast keeps its editor window at
opacity 0 and off the taskbar, so the dead process stayed invisible while holding the metrics port, the
Art-Net socket and the audio device, which then broke the *next* `npm run dev` and read as an unrelated
fault. Diagnosed off the live process itself: `mode="broadcast"` with `artlux_render_fps 0` — main up,
renderer never painted a frame. Four sites relaunch the app (broadcast, calibration profile, watchdog
self-heal, playlist switch), each hand-rolling the same argv under a comment claiming it mirrored the
proven pattern; `runProfile` now owns both halves (`relaunchArgs()` / `rendererDevUrl()`).

**Why it was silent, which mattered more than the bug.** `did-fail-load` was not handled anywhere.
`ready-to-show` and `did-finish-load` both stay quiet when the load *fails*, and the watchdog arms on
`did-finish-load` — so the one tier that could have caught it was armed by the very event that never
came. This is the same "process alive, nothing on screen" state the three reveal paths exist to
prevent, reached from the other side.

**The tray icon** pointed at `build/icon.png`, but electron-builder packs `files: ["out/**/*"]` —
`build/` holds the *installer's* icon sources and is not in the asar. It resolved in dev and never in a
shipped build, and `new Tray()` sits in a `try/catch`, so packaged broadcast logged one line and ran on
with no tray: in the one mode with no window and no menu, leaving `Ctrl+Shift+Q` as the operator's only
way to quit a live show. **Only visible by launching the packaged app** — `npm run dev` cannot see it,
the same trap as the `ready-to-show` rule two entries up.

Four invariants added, each negative-tested. Verified one variable at a time in dev *and* packaged;
the packaged run was driven through the real relaunch from the editor (pid changed, successor carried
`--broadcast` and correctly no `--built-renderer`, `render_fps` 59.9 at `mode="broadcast"`).

## v0.26.4 — a USB DMX widget that dies is retried, and its death is reportable (2026-09-01)

First time the ENTTEC path had been run against hardware: a real DMX USB Pro (FTDI `VID_0403+PID_6001`)
on COM3 driving a Cameo MOVO BEAM 100 in 15-channel mode, alongside an Art-Net universe.

**What held.** Both transports ran together — `universes 2`, Art-Net steady at 60 pkt/s with the widget
transmitting — and pulling the USB cable mid-run did not perturb the network side at all: universe 1
held 60 pkt/s across the yank, `pps` dropped by exactly the serial half, the app did not crash. The
per-port writer thread and single-slot mailbox did the one job they exist for. The 115200 open baud is
confirmed working; the Mk2's second port is still unconfirmed.

**What did not.** `alive=false` was terminal. `SerialPorts::send` only spawned a writer when the path was
ABSENT from the map, so the dead entry sat there returning false forever; `serial_ports.close()` is the
only thing that clears it, and it runs solely when the engine thread stops — reached through
`outputManager.close()`, which **nothing in main has ever called** (`grep -n "output\.\(close\|configure\)" src/main/*.ts`
returns one hit, and it is `configure`). `configure()` is not even passed `cfg.enabled`, so the
Preferences output toggle could not do it either. **The only recovery was relaunching the app**, and
replugging the widget was measured doing nothing: COM3 back in the device tree, port free, no second
`serial DMX open` line, `pps` flat at the Art-Net rate.

It was invisible in every channel an operator has. Art-Net was unaffected, so nothing looked wrong;
`artlux_output_universes` still reported **2** with the widget unplugged on the bench, because universes
are counted per destination processed regardless of whether the write landed; and `alive` never left
serial.rs — `grep -rn "serialAlive\|portAlive\|serialStatus" src shared packages` returned **zero**
hits. Half the rig keeps working, which is the best disguise the other half could have.

**The fix.** A dead writer is reaped and re-opened on a 2 s backoff (`PortEntry.retry_at`), so a
replugged widget resumes by itself. The backoff is the whole reason this is not a one-liner: without it
a missing widget spawns a thread on every frame, sixty a second, each failing to open — a worse failure
than the one being fixed. Retries are quiet (an absent widget would otherwise log every two seconds for
the length of a show); a successful re-open still logs, so recovery stays traceable. `SerialPorts::status()`
returns (live, down) writer counts, carried through `StatsData`/`Stats` into `OutputStats` and out as
`artlux_output_serial_ok` / `artlux_output_serial_down`. The hot path keeps `contains_key` + `get_mut`
rather than the `entry` API, which would allocate a `String` per port per frame.

**Verified.** Recovery proven by seizing COM3 from another process so the open fails, then releasing it:
`serial_down=1` held for 16 s across ~8 silent retries with exactly ONE failure line, then an automatic
re-open and `pps` back to 69 within a second of release. The rebuilt engine drove the head for 90 s
continuously with no regression, and the built app exports the new gauges alongside `universes 2`.
`cargo test` (4 framing tests) and `npm run verify` (149 invariants incl. the new one, 11 doc checks,
typecheck) pass.

**Not verified: a physical cable pull inside the app.** The seize/release test fails on OPEN; a real
yank fails mid-WRITE first. Same recovery code, different entry into it. Two watch windows were left
running for the operator to pull the cable and neither yank happened, so that path is reasoned, not
measured.

**Left undone, deliberately.** The Routing panel still shows a dead widget as healthy — per-port
liveness means widening the `Copy` stats struct the pacer writes under a lock, plus IPC and renderer
work, which is its own change. And `artlux_output_pps` still over-reports USB DMX (queued, not written);
fixing that means counting on the writer thread. Both are documented in OUTPUTS.md instead.

## v0.26.5 — a global release paired with a per-pool memo, and the image that went black (2026-09-04)

Reported as "an image on a track is not playing when we switch from state to state". It was not an
image bug and not a timeline bug: `contentSource` is keyed `layer:<id>` **globally**, while the "do I
already hold this?" memo (`lv.content` / `lv.contentClipId`) is **per pool**. Four sites released the
registry entry and left the memo standing, so `syncContentLayer`'s guard —
`lv.contentClipId !== clip.id || lv.content !== content` — read "already acquired" forever and the layer
**never re-acquired**. Black for the rest of the session, on that layer and then on every other, with
nothing logged, nothing thrown, the transport still running and the FSM still advancing.

**Why the guard was always true across a swap.** Both halves survive re-normalisation byte-identically:
`clip.id` obviously, and `clip.content` because `normalizeTimeline` SHALLOW-copies each clip
(`sanitizeClip` is `{...c, …coerced numbers}`), so the content object keeps its identity. A guard written
to detect "the clip changed" cannot detect "the thing behind the clip was freed".

**Why only images were reported.** `getDrawable` re-creates a missing EFFECT on the spot, so effects
self-heal and hid the fault; IMAGE / VIDEO / CAMERA / DMX-in and every plugin live source return null
and stay black. The symptom names the one content type that neither heals nor is live.

**Why it needed the SECOND entry.** A first cut acquires normally; only a swap AWAY leaves the lie
behind. So a click-through of the show passes, and `releasePool` masks it further — a pool the LRU has
demoted is deleted outright, so the next entry builds a fresh `lv` and works. It bites exactly the
small, warm, cycling show: the shape an installation runs all night.

**The fix.** `forgetLayerContent(layerId)` clears the memo in EVERY pool (the key it frees is global, so
any pool holding that id is now lying too), paired at all four bare `contentSource.release(layerKey(...))`
sites. `releaseContent()` stays the paired form for the one case that holds an `lv` already. Alongside:
`warmPoolVideos` now acquires an IMAGE start clip with its pool — an image decodes asynchronously
(fetch → `createImageBitmap`), so re-entering a state used to flash black while the bitmap landed.
Live receivers are deliberately NOT warmed (only the active pool may open a camera or an NDI feed).

**Verified on the wire, both directions.** A two-scene project, one image clip per scene on its own
track, each scene's surfaces bound to its own track, FSM cycling on a 4 s delay, Art-Net to loopback
(6469 — 6454 is the app's own input socket):

```
before   RED · BLUE · BLACK …and black from there on
after    RED · BLUE · RED · BLUE · RED · BLUE
```

The control run was done by reverting the one file and rebuilding, so the two runs differ in exactly
that. Invariant #150 (`contentSource.release(layerKey(...)) clears the pool memo`) negative-tested by
removing a pairing; `npm run verify` = 150 invariants + 11 doc checks + typecheck.

**The class is not closed.** Anywhere a globally keyed shared resource is guarded by a per-consumer
boolean memo, the same silent black is reachable. `codecResidency` is the other holder of this shape and
is safe because it refcounts; the layer path had a bare memo, which is not the same thing.

**Also documented, and NOT a bug:** a surface's track choice (`SourceType.LAYER` + `layerId`) resolves
only against the currently bound scene's timeline, and every scene mints its own track ids
(`defaultTimeline()` has no layers). It works because `buildSceneSnapshot` captures `surfaces` into the
scene look and recall writes them back — so the routing must be re-saved on the state. A **cue** cannot
do this at all: `surfaceParams()` publishes no `content.layerId`, and `applyCues` never swaps a timeline.
See [SCENE-TIMELINES.md](SCENE-TIMELINES.md) → Sending a different track to each surface.

## v0.26.5 (re-cut) — a cut that blanked every output, and half the GPU spent redrawing the same frame (2026-09-04)

Reported as two 1080p mp4s stuttering on two windowed projector outputs. The operator's own clue was
the diagnosis: selecting ONE output from the taskbar, so nothing else was on screen, played perfectly.
Nothing was being throttled — the app disables every focus/occlusion throttle Chromium has — there was
simply more GPU work than the machine had. Covering windows measured BETTER than tiling them (59.5
draws/s, p95 33.8 ms vs 55.4 and 49.6), which is the opposite of what throttling predicts.

**Three defects.**
1. *A cut blanked the output.* At a clip boundary the next decoder must open and seek; until it answers
   `layerFrame` returns null, the compositor paints black, and the pump reports `frameIdle` so every
   mirror blacks out too. 19–125 ms at every boundary, ~6 per lap, forever. The track now holds the
   outgoing frame across the gap — a COPY, since the mp4 decoder returns a live `VideoFrame` from a
   bounded ring and closes it on eviction. Forced blackouts 6–9 per 30 s per output → **0**.
2. *That fix silently did nothing the first time.* `captureCodecHold` measures the frame it keeps, and
   the probe did not know the `VideoFrame` spelling (`displayWidth`) — so an mp4 layer measured 0, the
   `w > 0` guard returned, the hold stayed empty, and every cut went black with the code present and
   looking right. Nothing thrown, nothing logged. Invariant #151 now fails the build on it.
3. *Each output redrew unchanged pictures.* A full 4×MSAA pass plus resolve blit ran on EVERY vsync;
   only the texture upload was gated. For 25 fps content on a 60 Hz output that repainted an identical
   frame ~half the time, per window. Passes 55.4 → **29.0/s** while pictures delivered went
   27.9 → **29.0/s**; pump gap p95 49.6 → **33.6 ms**.

Also: `uploadContent` used `texImage2D`, reallocating the texture every frame per window — now
`texSubImage2D` unless the size changed. The mipmap chain is deliberately KEPT: it holds an angled
projection sharp and bounds the silhouette halo on the calibrated path.

**Three measurement traps, each of which sent this the wrong way.** A CDP screencast measures the
COMPOSITOR, so an occluded window reads as stuck regardless of playback — two runs of one build
disagreed 10×, and a commit was reverted partly on that number. Byte LENGTH is not a change detector
(similar frames compress alike). And counting an event is not diagnosing it: the blackout count matched
the boundary count exactly, a real boundary fix did not move it (because of defect 2), so boundaries
were wrongly ruled out. Only logging the REASON settled it. Both hooks that did —
`window.__artluxProjStats()` and `window.__artluxNullLog()` — ship.

**Two approaches measured and abandoned.** Keying a codec decoder per (layer, clip) so a lane holds the
current clip and the next collapsed the engine (28.6 → 13.9 fps on two outputs) and left `gapMax` at
4.5 s even after latching its per-frame `preRoll`; reverted in `a12fbf2`. Note `docs/CODECS.md:123`
claims WebCodecs has no hardware-session cap — that did not survive contact with this rig, and the
collapse is still unexplained. Projector-local mp4 decode (one `setEnabled` away, and already claimed by
`docs/CALIBRATION.md`) cost draws 56.6 → 47.2/s with no benefit, because main keeps shipping regardless.

**Not verified: fullscreen on two real displays** — the shipping mode, and a lighter load than three
windows on one screen. `render_frame_p99` still spikes to ~115 ms in the tiled case.

## v0.26.6 — a texture three stopped watching, and a zone map with nowhere left to draw (2026-09-05)

**The 3D preview froze on one video frame while the same clip played on the projector and the 2D
stage.** Not the video and not our upload: `surfaceTextureCache` set `image` + `needsUpdate` on every
one of the 25 frames a second the decoder produced, `texture.version` passed 14 000 — and the GPU
texture was still the one written at **version 2**. Nothing threw and nothing logged.

three's WebGPU renderer gates every upload behind `NodeMaterialObserver.needsRefresh()`: no refresh, no
`bindings.updateForRender`, no `textures.updateTexture`, no copy — however many times you set
`needsUpdate`. The observer diffs a **snapshot of the material** built once into a module-level WeakMap
with `if (value === null || value === undefined) continue`, so **a property that was null at snapshot
time is never monitored again for the life of that material**, and `material.needsUpdate` does not
rebuild it. A venue plane is constructed mapless and handed a map a few frames later, when the decoder
answers.

It is a **race**, which is why a photo won it and an mp4 never did — and it only became permanent with
`508df9d`'s `captureCodecHold`. Before that a codec layer returned null at every cut, which released
the cache entry, disposed the texture and built a new one; that accidental churn had been papering over
the freeze at every boundary. **A fix that removes incidental churn can expose a latent cache bug
downstream** — worth carrying forward.

Fixed by giving every texturable 3D material a 1×1 opaque-white stand-in at construction
(`Simulator3D/blankMap.ts`) and never assigning null back. White × `#161616` is `#161616`, so the empty
state is pixel-identical, and `USE_MAP` is now defined from the start so arriving content no longer
forces a program rebuild. Assigning null back is worse than a missed refresh: once `map` is watched the
observer reads `mtlValue.isTexture` on it and a null **throws inside the render loop**. Guarded by
invariant #154.

**The method, because no single step was sufficient.** (1) Probe `surfaceTextureCache` — acquires,
uploads and the `VideoFrame` timestamp all advancing, so the source half and `useFrame` are fine.
(2) Hash the 3D canvas region against a **full-window control region**: 1 distinct in 8 versus 6 in 6.
A CDP screenshot measures the compositor, so the control is what makes it admissible at all.
(3) Patch `GPUQueue.prototype.copyExternalImageToTexture` from CDP — only ImageBitmap sources, never a
VideoFrame, so the upload is not failing, it is **never requested**. (4) Compare `texture.version`
against `renderer._textures.get(tex).version` — 14 597 versus 2, which is the whole diagnosis in one
pair. (5) Patch `_bindings.updateForRender` and `backend.draw` and count per `object.id`: the wall mesh
was **drawn 60×/s with zero bindings updates**, which points straight at `needsRefresh`. (6) Prove
before fixing — swap in a fresh material whose `map` is already set, 4/4 distinct frames.

⚠ **`browser.pages()[0]` is not the editor** when projector windows are open. Filtering on
`projector.html` is what stops you measuring a black "Waiting for the main window…" page and concluding
the fix failed — it did exactly that here, once.

Measured after: 3D viewport 57 distinct in 66 samples over 30 s, no repeat longer than one sample, with
the editor and two projector windows up. **Not verified:** the projected-UV materials (no projected
model in the test project) and the calibration `ProjectorScene` (on WebGL, so it never froze).

**A Trigger Zones map with no empty space had no gesture left that could add a zone.** The panel draws
a zone by dragging on space no zone occupies, so one zone large enough to cover the surface — an
entrance zone spanning a whole floor is normal — made every `pointerdown` a `move` drag and the `draw`
branch unreachable, while the hint text still advertised it. The eye toggle now takes a zone out of the
pointer's way as well as the show's, so drawing over a hidden zone is the way out; the corner-handle
test is gated the same way, because the paint loop draws handles only for a live zone and an ungated
`cornerAnchor` is four invisible 9px holes. Toggling every zone back on **dematerialises**
`activeZoneIds` again, so a routine off-and-on no longer leaves a scene carrying a set frozen against
the zones that existed when it was written. Guarded by invariant #153.

## v0.26.6 (re-cut) — a cold open that was 21 s of two things blocking each other (2026-09-05)

The owner asked to shorten the preload and to cache processed sound and images in the project folder.
The investigation found the caches would have saved **milliseconds**, and that the whole cold open was
two mutually-blocking defects. Measured on their own project (2 scenes, 4 mp4s, 8 MB of media, built
app): **21.1 s from page load to the show being ready → 6.5 s**, with the project itself now opening at
**0.5 s instead of 6.1 s**.

**1. The gate armed by TIMEOUT on every open, on any project with an mp4 in its opening scene.** A
timeline layer decoder has two drivers during a cold start: the transport, already rolling (the gate
holds the *state machine* and deliberately never writes `playing`), and the gate's `preRoll` poll,
always about the START clip. mp4 answered the poll with `frame(atSec)`, which MOVES `wantUs` — so
asking at 0 while the transport sat at 5 s read as a backward scrub, `seekSegment` threw the decoded
buffer away, and the transport refilled it before the next poll undid that too. `fedAbs` sawtoothed
21→7→3→8→3, the buffer oscillated 1↔9, `preRoll` was false forever. It also corrupted `lastFrameTs`,
which *is* `layerGeneration`, so every consumer that skips repeated frames was told the layer had
jumped back to the head of the clip ten times a second. **A pre-roll is a probe, not a seek** — it now
tops up where a driven decoder actually is. 15,012 ms (timeout) → 5,607 ms (ready).

**2. The sound card was opened twice, on main's thread.** `native.configure()` is a synchronous napi
call into JUCE; on this rig it takes **5.7 s**, during which main serves nothing — no
`artlux-media://` byte, no prefs read, no conform. It ran once at plugin activation against
DEFAULT_SETTINGS and again when the machine's real setup arrived. A main-process CPU profile put
`configure` at **11.0 s of self time out of 18 s**, with nothing else within 60 ms. The first call also
blocked the prefs read that would have said it was the wrong device. The startup open now waits for a
settings notification carrying an audio slice, with a bounded 1500 ms grace for a machine that has
none. 11.0 s → 5.9 s of blocking, one call.

**The caching plan this started as is deferred, on its own evidence.** The audio conform cache already
works (hits resolve in ~0.1 s); moving it into `.artlux-cache/` still matters for a *fresh venue
machine* and is unbuilt. mp4 demux — the item ranked first before measuring — is **1–4 ms**; the 3 s
"open()" was the whole-file `fetch` waiting on a blocked main process. Image decode and HAP never
appeared on the critical path at all. **⚠ The one real finding for that plan: `.artlux-cache` keys on
the ABSOLUTE source path, so thumbnails do NOT survive the folder move that `docs/ASSETS.md` promises
they do.** Fixing the key is the prerequisite for any of it.

**Method notes.** (a) A CDP poller measuring a busy renderer *lies by omission* — 5.5 s of samples
simply did not exist and the first row read as an 11-second plateau, which produced a wrong "11.7 s of
startup" number. The recorder has to live in the page, where it competes with the app's own poll on
equal terms. (b) Four successive "the cost is X" answers were wrong — demux, fetch, then main-side
plugin IPC — and only a **CPU profile of the main process** (Node inspector over `--inspect`) named it
in one line. Reach for the profiler earlier. (c) Two harness filters silently hid the answer they were
built to surface; a log line you cannot see reads exactly like a log line that never fired.

**Still open:** the remaining single 5.9 s device open still blocks main — it wants the JUCE call moved
off that thread, which is a native change. Whether 5.7 s is normal for this Realtek device or
particular to this machine is unmeasured. The no-audio-settings fallback path is reasoning, not a
measurement (exercising it risks the commissioned device setting).

## v0.26.7 — the app was opening a sound card nobody asked for (2026-09-06)

Sequel to v0.26.6, and the answer to the question that release left open. **Cold open on the owner's
project (10 scenes / 36 clips / 57 MB): 7,806 ms → 707 ms**, `armedBy: ready`, `bench-open` 3 runs.

**`deviceManager.initialise(0, ch, nullptr, true)` opens the platform default device** — the name says
it builds the device-type list, and it does that too, but the open is the expensive half and it happens
before the engine has said one word about the device the operator chose. Opening a sound card is a
synchronous napi call on main's JS thread, so for its whole duration main serves nothing: no byte over
`artlux-media://`, no prefs read, no conform, no metrics scrape.

| | as shipped | fixed |
|---|---|---|
| ASIO selected | initialise 5471 + switch 1817 + open 54 = **7342 ms** | 62 + 288 + 53 = **403 ms** |
| Windows Audio selected | 5409 + 0 + 344 = **5753 ms** | 64 + 0 + 5171 = **5235 ms** |

⚠ **IT IS WORST WHERE IT IS LEAST VISIBLE, AND THAT COST TWO WRONG CONCLUSIONS.** With the PLATFORM
DEFAULT device selected, `initialise` happens to open the very device we wanted, so removing it saves
~370 ms and the defect hides. That is the configuration measured first — which produced *"nothing in our
code can make the wait shorter"* and, worse, the advice to *switch the device type to ASIO*, which on the
shipped build made the cold start **slower** (7.3 s vs 5.8 s) by adding a type switch on top of the
wasted open. **A measurement in one configuration is not a measurement.**

**The `true` was `selectDefaultDeviceOnFailure`, and two behaviours relied on it silently.** Both are now
explicit and tested: a named device that will not open still leaves the DEFAULT one live (a renamed
interface must not bring a venue up silent), and — the one that would have shipped — **JUCE reporting no
error is not the same as a device existing**: asked for an empty device name, which is every machine that
has never chosen one, `setAudioDeviceSetup` returns SUCCESS and creates nothing, and the engine reported
an `OpenedCfg` over a silent machine. An empty `outputDeviceName` does not mean "the default" either;
JUCE resolves that with the **private** `insertDefaultDeviceNames()` that `initialise()` called for us, so
`defaultOutputName()` now names it explicitly. The first version of the fallback looked right and left
`deviceLive` false — the exact silence it exists to prevent — and only testing the branch found it.

**Verified per case in a fresh process, metering a test tone:** ASIO named (887 ms), WASAPI named
(5331 ms), bogus name, bogus type, empty type+name — all leave `deviceLive` true and the tone audible.
DirectSound opens but meters zero **on the pre-change build too** — pre-existing, uninvestigated, and the
reason not to recommend it as a workaround. Invariant #156 guards both halves; both negative-tested.

**What is NOT fixed, and is not ours:** opening this Realtek endpoint in WASAPI *shared* mode really does
cost ~5.2 s, every time (exclusive 1.0 s, DirectSound 0.37 s, **ASIO 0.05 s** — same speakers). With this
release in, **ASIO is the fast path** and the cold open is ~0.4 s. Unmeasured on any other machine; the
venue PC is the one that counts. Tracked in [#6](https://github.com/urbandronedesign/artlux/issues/6) and
[plans/audio-device-open.md](../plans/audio-device-open.md).

**Method notes.** Reach for a **CPU profile of the main process** early — it is a Node inspector target
over `--inspect`, `ws` is already in `node_modules`, and it named this in one line after four wrong
answers from reading code. And a CDP poller measuring a busy renderer *lies by omission*: 5.5 s of
samples did not exist and the gap read as a plateau, producing a startup number wrong by 5.9 s. The
recorder has to live in the page.

### 2026-09-06 — the releases page: permanent download links, and a retention policy

`11270bf`, `2148264`, `c2e9614`, `02fe230`, `55aeb13`, `d42411f`

The question was "can I keep only the latest build?" The answer was that deleting is a destructive
way to reach a **presentation** goal, and the two things actually wanted are separable: a download
link that never changes, and a page that is not a list of every build ever cut.

**Permanent links.** `artifactName` puts the version in every filename, so the only linkable thing was
the releases *page* — which is why the README sent people to browse. Each release now also publishes
fixed-name copies (`ArtLux-Setup-x64.exe`, `ArtLux-arm64.dmg`, `ArtLux-x86_64.AppImage`), and the
launcher gets a rolling `launcher-latest` pre-release because it cannot use `/releases/latest` (that
endpoint excludes pre-releases, and every launcher release is one). The aliases are inert to both
updaters *by construction*: each reads the installer filename from `latest.yml`'s `path`, never from
the asset list. Policy and the tag-name reasoning: [DEVELOPMENT.md → Release process](DEVELOPMENT.md#the-releases-page-permanent-links-and-what-happens-to-old-builds).

**Retention by drafting, not deleting.** CI keeps 3 app / 2 launcher visible and retires the rest to
drafts: invisible and unresolvable, assets and notes intact, `--draft=false` away from returning, and
the git tag never moves either way. It is safe because the launcher's resolver already filtered on
`!r.draft` before any of this existed. `v0.25.0`–`v0.25.6` were retired by hand the same day (18 rows
→ 11). Not a storage measure — the repo is public and release assets are unbilled.

**The bug the housekeeping question uncovered, which was the real find.** `newest_release` read the
feed with a single un-paginated request of 30. Two products share that list and the app releases ~10×
more often, so the newest `launcher-v*` sinks steadily down it — and the first time it passed row 30,
every installed launcher would have started answering *"no published launcher release was found"* on
self-update. Nothing local changes, no build fails, CI cannot see it, and it lands on the product
whose whole job is installing things. It had **twelve app releases of headroom** when it was found.
Now paged (100 × up to 5), and `cargo run --example selftest` prints how deep each product sits so the
number is watchable rather than discovered.

**Two things only running it caught.** Windows PowerShell 5.1's `ConvertFrom-Json` emits a JSON array
as **one** object, so `@(ConvertFrom-Json …)` is a one-element list *holding* the array — the walk in
`verify-download.ps1` inspected that single item, found no `tag_name`, and reported "no published
launcher release was found". A wrong answer wearing a plausible message, not a parse error; assign,
then wrap. And a URL fetched while its release is drafted can keep 404-ing **after** an undraft
(CDN negative cache) — the API served the bytes fine, so do not read that as a lost asset.

**Verification.** Live feed before and after (18 → 11 rows, app at position 1, launcher at 3);
`/releases/latest` still `v0.26.7`; all seven tags and their source tarballs still resolve; the real
launcher installer renamed to `ArtLuxLauncher-Setup-x64.exe` verifies (exit 0) while decoys under both
fixed names fail as mismatches (exit 1) and versioned names still pass; and the retention selection
dry-run against the live repo, with `echo` in place of every write.

## Open items
- **ui-ux-pro-max skill** not yet vendored: the `uipro-cli` global install was blocked by the sandbox. Plan: copy `src/ui-ux-pro-max/` from the named GitHub repo into `.claude/skills/` (needs approval). Skill is already usable in-session meanwhile.
- Deferred effects: stateful **fire2012**, **multi-segment** subdivision per fixture.
- **Parity check**: WebGPU vs WebGL pixel output verified only as "initializes + runs"; confirm visually with a loaded source against the DMX Monitor.

## Verification cheatsheet
- Build: `npm run build` (compiles main+preload+renderer).
- Native engine: `npm run build:native` (Rust → `output-engine.node`). Required once after clone.
- Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- Art-Net bytes: a UDP listener on `127.0.0.1:6454` + the transport produces a valid `Art-Net` OpOutput packet (header, `0x5000`, universe, length, payload, non-zero seq) — validated during Phase A.
