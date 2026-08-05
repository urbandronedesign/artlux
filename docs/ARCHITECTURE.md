# ArtLux — Architecture (current)

The canonical reference for how ArtLux works today. For the historical pre-Electron rewrite roadmap
see [archive/ARCHITECTURE_PLAN.md](archive/ARCHITECTURE_PLAN.md); for the plugin architecture see
[PLUGINS.md](PLUGINS.md); for the surfaces design see [SURFACES.md](SURFACES.md); for usage see
[FEATURES.md](FEATURES.md); for the build log see [PROGRESS.md](PROGRESS.md).

## Overview
ArtLux is an Electron desktop app that maps content (video / image / camera / **Spout** / **NDI** /
DMX-in / generative effects / **LiDAR tracking**) onto addressable-LED fixtures **and projectors**, and
streams the result over **Art-Net** and **sACN/E1.31** (plus projector outputs with warp/blend). Pixel
work runs on the GPU (**WebGPU** compute, WebGL fallback); UDP output runs in a native **Rust** engine;
sound runs in a native **C++/JUCE** engine. It also carries a timeline NLE, a project **state machine**
over scenes/cues, OSC control, and a 3D simulator. Stack: Electron · React 19 · TypeScript · Vite
(electron-vite) · Tailwind · WebGPU · react-three-fiber · Rust (napi-rs) · JUCE.

## Why Electron — and where Tauri *is* right (assessed three times; stop re-asking, start here)

The question "should this be Tauri / a full Rust rewrite?" has now been evaluated **before the first
line was written** ([archive/ARCHITECTURE_PLAN.md](archive/ARCHITECTURE_PLAN.md) → *Native-language
assessment*), **during engine decoupling** ([plans/engine-decoupling.md](../plans/engine-decoupling.md)
§4), and **in depth on 2026-08-04** (which produced [plans/native-core.md](../plans/native-core.md)).
Same verdict each time, for reasons that are facts about this codebase, not taste:

- **On Windows, Tauri is the same graphics stack.** It ships no browser; its webview is WebView2 —
  Chromium/Blink with the same Dawn WebGPU backend and the same GPU-process architecture Electron uses.
  The measured limiters here (`CrGpuMain` pinned by the WebGL command buffer; `CrRendererMain` blocked
  in `Receive mojo reply` — see DEVELOPMENT.md → Profiling §2b) are properties of that shared
  architecture. A shell swap moves neither.
- **The multi-projector bridge has no Tauri equivalent.** Each output window is fed transferred
  `ImageBitmap`s over a `MessageChannelMain` pair (~30 fps, ~8 MB per 1080p frame — see the frame pump
  in `App.tsx` and `renderer/projector/bridge.ts`). Transfer-by-handle works because both ends are
  Chromium web contexts. Tauri has no cross-window MessagePort; every frame would serialize through
  Rust IPC, and WebView2 is its slowest platform for exactly that.
- **Pinned Electron = pinned Chromium = guaranteed WebGPU.** INSTALL.md states the stake: *WebGPU
  compute is the entire pixel-mapping pipeline.* Under Tauri, the venue PC's WebView2 runtime — updated
  by Windows, outside our control — would decide whether the product runs at all.

**Where Tauri IS the right tool — and we use it:** [the Launcher](LAUNCHER.md) is Tauri v2 + Rust
(~2.4k lines of Rust behind `#[tauri::command]`, a form-and-progress-bar UI, no GPU requirement).
The line: *Tauri is right where the webview is a form, wrong where the webview is the renderer.*

The genuine half of the idea — **a Rust core** — is already this app's architecture (`native/` is ~30k
lines of Rust/C++ against ~4.7k of Electron main) and its continuation has a staged, kill-gated plan:
[plans/native-core.md](../plans/native-core.md) — a Rust-owned `wgpu` device for eligible projector
outputs and, later, LED sampling, with the editor shell staying in Electron permanently.

## Processes
- **Main** (`src/main/`): app lifecycle + window, native transport (Art-Net/sACN, ArtPoll discovery,
  Spout receiver), persistence (dialogs + userData), and the native menu (kept only for keyboard
  accelerators — the editor window is **frameless** and draws its own title bar/menus in the renderer,
  `components/MenuBar.tsx`, backed by `window:command` IPC for min/maximize/close + menu roles). Owns
  all OS access (UDP, fs, `.node` addons) — the renderer is sandboxed. Media is the one path that does
  not travel as IPC messages: main serves it over the `artlux-media://` scheme (Range-streamed, from an
  allowlist) so a decoder reads windows instead of the renderer holding whole files — see
  [Media transport](#media-transport-srcmainmediaprotocolts--sharedmediaurlts).
- **Preload** (`src/preload/index.ts`): `contextBridge` exposes a typed `window.artlux` API over IPC.
- **Renderer** (`src/renderer/`): the React UI + the frame-generation loop (Stage + GPU mapper).
- **Shared** (`shared/`): the IPC contract (`protocol.ts`) and the binary frame codec (`frameCodec.ts`),
  imported by both sides.
- **Native** (`native/`): **six napi-rs Rust crates** — `output-engine` (Art-Net/sACN send thread),
  `spout-receiver` (Windows Spout), `hap` (HAP codec), `ndi` (NDI video), `calib` (OpenCV projector
  calibration), `nvwarp` (NVIDIA NVAPI warp/blend) — **plus one C++/JUCE** crate `audio-engine`. All are
  loaded in main via `process.resourcesPath` paths, packaged as `extraResources`, and **degrade
  gracefully** when absent. Only `output-engine` + `spout-receiver` + `hap` are built by `build:native`;
  the rest have their own opt-in scripts (see [DEVELOPMENT.md](DEVELOPMENT.md)). Most are now loaded *by a
  plugin* rather than core — see [Plugin architecture](#plugin-architecture) below and [PLUGINS.md](PLUGINS.md).

## Frame pipeline (renderer → hardware)
Owned by **`engine/frameEngine.ts`**, a module singleton that starts its own `requestAnimationFrame`
when it loads and holds no reference to the view. Inputs arrive as one struct (`setInputs`), pushed by
`App` — which owns the document — and the engine diffs them to decide what a change invalidates
(moving a fixture rebuilds the GPU LED buffers; changing its intensity only re-uploads params).

> **It is not part of the UI, and this is load-bearing.** The loop used to live in a `Stage` effect and
> bailed out if the container or canvas ref was empty, so Art-Net stopped whenever that component went
> away — which is why the codebase carried a "Stage must never unmount" rule and why the workspace had
> to be built around a viewport that could not move. Nothing in the loop reads the DOM now: `Stage` may
> unmount, remount or be hidden by a context switch, and the show does not notice. Verified by deleting
> the Stage's canvas and container out of a running app while output held 61 Hz.
> Guarded by `verify:invariants`; history in [plans/engine-decoupling.md](../plans/engine-decoupling.md).

Per frame:
1. **Composite** — draws every surface's content into the engine's **own** 512² canvas (z-order). On the
   WebGL fallback that canvas *is* the sampling source; on the WebGPU path it feeds only the operator's
   picture, and is skipped entirely when nothing is showing it. The visible Stage canvas is a **blit** of
   it — lent to the engine, cosmetic, never load-bearing.
2. **Per-surface GPU sampling** (WebGPU) — `WebGPUMapper.renderSurfaces()` runs one compute pass per
   surface: it uploads that surface's drawable into the source texture and dispatches only the LEDs
   linked to it (`ledMeta.w == activeSurface`), sampling at **surface-local UVs**. Output buffer is
   cleared each frame so unlinked LEDs are black. One async readback (staging ring). → strict
   per-surface sampling. (WebGL fallback samples the global composite — degraded, not overlap-strict.)
3. **Universe packing** — for each fixture, RGBW bytes are written into per-universe 512-channel
   arrays applying **color order** + **gamma LUT** + **channels-per-pixel** (RGB/RGBW), spanning the
   512 boundary as needed. Destinations are resolved per fixture from its **controller** → per-fixture
   `output` override → global settings, keyed by `${protocol}|${ip}|${broadcast}`.
4. **Publish** — `dmxSignal.publish(pixels, destinations)` for the in-app consumers (DMX monitor, the
   3D scene, the lighting recorder), then straight onto the wire:
   `window.artlux.sendArtNet(encodeFrame(targets))` → IPC `dmx:frame` → main → `outputManager`. Sending
   is the last step of a frame, not a subscriber somebody registers — it used to be a `dmxSignal`
   listener inside `App`, which made putting frames on the wire something the document opted into.

**Show modes render nothing.** `--headless` / `--broadcast` return `null` from `App` and still output:
the engine runs regardless. (They used to mount a hidden 1×1 `Stage` — a venue machine rendering a React
viewport in an invisible one-pixel box so that DMX would come out.)

## GPU mapper (`src/renderer/gpu/WebGPUMapper.ts`)
A WGSL compute shader samples a source texture per LED by normalized UV (so drawing content
stretched-to-fill the square texture is output-equivalent). `updateMapping(fixtures, surfaces)` builds
`ledData` (surface-local UV + segment index) + `ledMeta` (per-LED surface index) + `segParams`, and a
`surfaceOrder` (pass list). Effects now live on **surfaces** (see `gpu/surfaceFx.ts`, a 2D Canvas
renderer for Solid/Rainbow/Palette-Flow/Wave/Fire from the shared palette LUT in `gpu/palettes.ts`);
per-fixture effects are retired in the engine. `services/PixelMapper.ts` is the `IPixelMapper`
interface both backends implement.

## Surfaces & fixtures (the content/mapping model)
- **Surface** = a rectangle on the stage carrying one content source (`SurfaceContent`). Media
  lifecycle (per-surface `<video>`/`<img>`, single live camera/Spout/DMX-in) is owned by
  `services/surfaceMedia.ts`; `getDrawable(surface)` returns the frame each tick.
- **Fixture** = an LED layout, **linked to one surface** (`surfaceId`) which it samples strictly.
  Patch (`universe`/`startAddress`) is auto-assigned per controller by `services/addressing.ts`
  `autoPatch` (respects `patchLocked`). **FixtureTemplate** = a saved LED definition (library).
- **Controller** = a physical output device (protocol/ip/broadcast/priority/startUniverse); the
  routing spreadsheet (`components/RoutingModal.tsx`) manages controllers + per-fixture patch.

## Plugin architecture
ArtLux is being restructured into an **in-process, contribution-based plugin system** (VS Code style):
features become self-contained first-party plugins in `plugins/*`, wired through the internal SDK
(`@artlux/sdk`, `packages/sdk`, subpaths `/main` + `/renderer`). **Ten plugins ship today** —
`lidar-tracking`, `ndi`, `calibration`, `spout`, `hap`, `mp4`, `mediapipe`, `augmenta`, `audio`,
`show-control`. A plugin contributes to **eleven contribution registries** (content source, clip kind,
projector channel/panel, settings section, scene-viz, panel, context, SM trigger, video codec,
automation target — `src/renderer/host/registries.ts`) and consumes **host services** it is handed at
activation. Activation: `src/renderer/host/plugins.ts` (10 renderer plugins) + `src/main/host/plugins.ts`
(6 with a main half). Cross-process plugins talk over a **generic preload bridge** (`plugin:<ch>`
channels). Persisted project types stay in core (`shared/protocol.ts` / `renderer/types.ts`); only
*behaviour* moves into a plugin, so there is **zero project-file migration**. Canonical: [PLUGINS.md](PLUGINS.md);
API surface: [SDK.md](SDK.md).

## Editor shell — workspace contexts (`src/renderer/components/shell/`)
The editor UI is **context-driven**: exactly one **workspace context** is active at a time (chosen from
the left rail), and it declares the whole workbench — browser column, viewport, dock tabs, parameter
sections and the action bar. A context is a **manifest of panel ids**; it owns no components, so a plugin
can `contextRegistry.extend()` a context it does not own. `WorkspaceShell` imports zero panels; panels
read state via `useEditor()/useEditorActions()` (`state/EditorStore.tsx`) — **but App still owns all
state and every mutation**. Core registers **nine contexts** (Mapping, Venue & Rig, Projection,
Calibration, Scenes & Cues, Show Machine, Audio, Show, Preferences). The **timeline is not one of them**:
it is a full-width **bottom drawer** (`Ctrl+T`) that eight of the nine can pull up, because it is a tool
you want *while* working in a viewport, not a place you travel to. `Stage` and the single `TimelinePanel`
are **persistent viewport elements** hidden with CSS rather than unmounted — for the timeline that is a
hard rule (two instances double its keyboard hook and engine subscription); for the Stage it is now only
about keeping its viewport state, since the frame loop left the component and output no longer depends on
it being mounted.

**The shell is DOCKABLE by default.** What renders is not the manifest directly but a per-context
**split/tab tree compiled from it** (`services/dockTree.ts` — pure logic, imports nothing;
`shell/DockRenderer.tsx` walks it, `shell/DockDrag.tsx` drags it on pointer events). The operator can
move a panel into another group, split a pane, add, close, collapse and reset — per context,
persisted in `WorkspaceLayout.dockTrees`, surviving a restart. **No SDK or context change was needed**:
the tree is compiled from `browser[]`/`dock[]`/`inspector[]`/`viewport`, and the *absence* of a saved
tree is the migration trigger. The single-instance viewports (`Simulator3D`, `TimelinePanel`) are not
reparented — the tree renders empty slots and `PersistentLayer` positions the one real element over
the winning slot by direct style writes. The pre-docking fixed shell is still there as a fallback
(*Preferences › Appearance › Dockable workspace*, or `localStorage['artlux.docking']='0'`), and both
paths ship for one release. Canonical: [WORKSPACE.md](WORKSPACE.md).

## Show model — timeline · scenes · state machine
Above the surfaces/output engine sits the **show model**, three layers core persists in `ProjectData`:
- **Timeline** (`services/timeline.ts`) — a video-layer NLE with **one transport carrying two derived
  clocks**: the **playhead** (the bound document's time, resets on a scene recall) and the **show clock**
  (the time the global audio bed rides, which a recall does *not* reset). See [TIMELINE.md](TIMELINE.md).
- **Scenes & cues** (`services/cueBus.ts`) — look snapshots + a cue grid; **every scene owns its own
  timeline** and a recall warm-swaps the engine to it (pool-keyed by `scene.id`). See
  [SCENES.md](SCENES.md) + [SCENE-TIMELINES.md](SCENE-TIMELINES.md).
- **State machine** (`services/stateMachine.ts`) — a project-level **"Show" graph over scenes**: states,
  transitions (manual GO / auto-at-end / OSC / **LiDAR trigger zones + combinations**), global `fromAny`
  rules, hold-at-end, and a cold-start boot gate that holds the show until its opening content decodes.
  See [STATE-MACHINE.md](STATE-MACHINE.md).

## Output / transport (`src/main/transport/`)
`outputManager.ts` prefers the native `output-engine.node` (Rust send thread + pacer + keep-alive +
sparse + ArtSync) and falls back to TS `artnet.ts`/`sacn.ts`. `discovery.ts` does ArtPoll/ArtPollReply.
`input.ts` captures incoming Art-Net/sACN. `spoutManager.ts` loads `spout-receiver.node` and streams
512² frames to the renderer.

## Audio (`native/audio-engine/` + `plugins/audio/`) — the second native language
The **only non-Rust native module**: a **C++17 / JUCE 8 / libspatialaudio** N-API addon
(`audio_engine.node`, built by CMake — *not* cargo). It is **object-based and spatialised**: every source
is a point in an ambisonic field, encoded into one shared B-format bus and decoded either **binaurally**
(HRTF, headphones) or to a **speaker array**.

**Core owns the documents; the plugin owns the sound.** `ProjectData.audio` (the bed) and `Timeline.audio`
(a timeline's own audio) are core types that core persists and normalizes and *never listens to*. Everything
audible lives in `plugins/audio/`, which registers an `automationTargets` provider (see
[SDK.md](SDK.md)) so an audio lane on the timeline is **the same object** as any other automation lane.

**Two containers, two clocks** — the invariant the whole subsystem turns on: the **bed** rides the **SHOW
clock** and a scene recall does not touch it; a timeline's **own** audio rides the **playhead** and restarts
with it. See **[AUDIO.md](AUDIO.md)** for the signal path, the two insert points, the automation target
grammar, the three-layer read order (`lane ?? fade ?? authored`) and the real-time invariants — chiefly
*never block the audio thread*, because a dropout resuming mid-waveform is a step discontinuity, which is a
**click**.

**Graceful degrade:** the loader is load-or-null. With no addon the app starts, the entire audio UI renders,
and there is **perfect silence** — announced by a `no audio engine` badge, because *silence with a UI that
says everything is fine* is the failure this subsystem takes most seriously.

## IPC (`shared/protocol.ts`)
Fire-and-forget `.on`/`.send`: `dmx:configure`, `dmx:frame`, `dmx:status`, `dmx:stats`,
`input:configure`/`input:frame`, `osc:configure`/`osc:message`/`osc:send`/`osc:local-addrs`,
`tracking:save-take`, `menu:action`, `app:open-external`.
Request/response `invoke`/`handle`: `project:save`/`open`/`load-path`,
`project:new-folder`/`open-folder`/`collect-assets`, `rig:export`/`import`, `prefs:get`/`set`,
`artnet:discover`, `asset:show-in-folder`, `app:get-info`.
- **Plugin channels are namespaced** `plugin:<ch>` and go over the generic preload bridge
  (`pluginInvoke`/`pluginSend`/`pluginOn`) — Spout (`plugin:spout:*`), NDI (`plugin:ndi:*`), HAP
  (`plugin:hap:*`), calibration (`plugin:calib:*`), etc. — because contextIsolation means a plugin cannot
  add named preload methods. Show-control runs its own embedded HTTP+SSE server (not IPC) for the tablet
  remote. See [PLUGINS.md](PLUGINS.md#the-generic-plugin-ipc-bridge).
- **Projector windows** talk to the main window over a **MessagePort** bridge
  (`renderer/projector/bridge.ts`), *not* IPC.

## Media transport (`src/main/mediaProtocol.ts` · `shared/mediaUrl.ts`)
**Media does not cross IPC.** The renderer builds an `artlux-media://f/<base64url(absPath)>` URL and
hands it straight to a `<video>`, an `<img>` or `fetch` — main answers it from a read stream with full
HTTP **Range** support, so a decoder pulls the byte windows it wants and nothing holds a file in
memory. Before this, every clip was read whole into a `Uint8Array`, structure-cloned over IPC and
wrapped in a `Blob`: a 1 GB HAP `.mov` measured 2.3 s of read, main RSS 125 MB → 3.7 GB and a 1.7 s
event-loop stall, for a few megabytes of actual want.

Three things are load-bearing and guarded by `npm run verify:invariants`:
- **The scheme is privileged at module scope, before `app.whenReady()`.** Chromium fixes its scheme
  registry during startup; registered late it comes up without `standard`/`secure`/`stream` and every
  video silently fails to load.
- **Every response carries `Access-Control-Allow-Origin`.** Both `<video>` factories set
  `crossOrigin="anonymous"` — inert under `blob:`, but a custom scheme makes each load a CORS request.
  The attribute cannot simply be dropped either: it is what keeps frames **untainted** so the 2D
  composite and the WebGPU LED sampler may read them.
- **A path is served only if `mediaAccess` admits it** — the open project's folder, `userData`,
  directories the operator chose in a dialog, plus the exact set of paths the project references
  (harvested with the same visitor `resolveAssets` uses, so the two cannot drift). Anything else is a
  `403`, logged once. The allowlist is rebuilt on every project open, so closing a show revokes it.

Base64url rather than a percent-encoded path is deliberate: Chromium normalizes standard-scheme URLs
(backslashes, `..`, `%2e%2e`, unicode), and every one of those transformations is also a traversal
primitive. Base64url contains nothing the URL parser will touch.

`mediaCache`'s blob path still exists for the few consumers that genuinely need bytes in hand — audio
peak analysis, the audio conform hand-off, and GLB venue models.

## Persistence (`src/main/persistence.ts`)
All **project/preferences** file I/O is in main (the renderer is sandboxed; media is the exception
above, and it is still main that opens the file). Projects are `.artlux` JSON — `ProjectData` in
`shared/protocol.ts`: `{ version, fixtures, surfaces, controllers, globalBrightness, groups, scenes,
cueBanks, scene3D, timeline, stateMachine, schedule, audio, assets, projectorOutputs, outputSpans, … }`.
Note **`settings` was removed (P6)** — `AppSettings` is *the machine, not the show*, so it lives in
Prefs, and a project no longer carries it. Rigs are `.artrig` (fixtures' patch/wiring only). Preferences
live in `userData/artlux-prefs.json` (`appSettings`, `globalBrightness`, `recentFiles`,
`lastProjectPath`, `fixtureTemplates`) and auto-restore on launch.

## Portable projects (`src/main/projectFolder.ts`)
A project can be a **folder** — `project.artlux` + `assets/{video,models,images}/` — so it's
self-contained and shareable. The design rule: **all asset-path translation lives in main; the renderer
always sees absolute paths.** `projectFolder.ts` holds the single asset-path visitor (`mapAssetPaths`),
which is the only code that knows where asset paths live — the three fields `timeline.clips[].path`,
`scene3D.models[].path` (meshes), and `surfaces[].content.url` (VIDEO/IMAGE; `blob:`/`http:` skipped).
- **Save** — `relativizeAssets(data, dirname(file))`: paths under the project folder are stored
  folder-relative (POSIX); external paths stay absolute.
- **Load** — `resolveAssets(data, dirname(file))`: relative paths resolve to absolute against the
  project folder. Applied in `persistence.ts` for `open`/`load-path`, so recents and last-project
  restore resolve too.
- **Collect Assets** — `collectAssets(file, data)`: copies external assets into `assets/<category>/`
  (de-dupe by name + size), returns remapped data; the renderer applies it and saves (→ relativized).

Surface video/image are stored by **file path** (`webUtils.getPathForFile`), not an ephemeral blob URL,
so they persist and collect. The renderer reads a path → blob URL once via the shared
`src/renderer/services/mediaCache.ts` (`resolveMediaUrl`/`ensureBlobUrl`), used by both
`services/timeline.ts` and `services/surfaceMedia.ts`.

## Headless (`--headless --project=<path>`)
`src/main/index.ts` parses CLI args; a hidden GPU window (`backgroundThrottling:false`) loads the **full
App** entry (`index.html`) with `?headless=1`. `App` gates on that flag to suppress projector/NDI output
and editor chrome, so headless is *hidden compute + Art-Net (and audio) only* — but it runs the real
plugin host, show engine, schedule tick and media playback, exactly like broadcast. (The old minimal
`headless.html`/`headless.tsx`/`HeadlessRunner.tsx` fork was retired in P6 — it had no plugin host, which
is why it drove no audio.) Used for low-overhead runs and automated output tests.

## Key files
| Area | File |
|------|------|
| App shell / state | `src/renderer/App.tsx` |
| Frame loop + packing + canvas | `src/renderer/components/Stage.tsx` |
| GPU mappers | `src/renderer/gpu/WebGPUMapper.ts`, `src/renderer/services/GPUMapper.ts` |
| Surface content / effects | `src/renderer/services/surfaceMedia.ts`, `src/renderer/gpu/surfaceFx.ts` |
| Persistence / portable projects | `src/main/persistence.ts`, `src/main/projectFolder.ts` |
| Media path → blob cache | `src/renderer/services/mediaCache.ts` |
| Auto-patch | `src/renderer/services/addressing.ts` |
| Routing UI | `src/renderer/components/RoutingModal.tsx` |
| Main / window / CLI | `src/main/index.ts`, `src/main/menu.ts` |
| Transport | `src/main/transport/{outputManager,artnet,sacn,discovery,input,spoutManager}.ts` |
| Native | `native/{output-engine,spout-receiver,hap,ndi,calib,nvwarp,audio-engine}/` |
| Plugin host | `src/renderer/host/{registries,plugins}.ts`, `src/main/host/plugins.ts`, `packages/sdk/` |
| Editor shell | `src/renderer/components/shell/WorkspaceShell.tsx`, `contexts/index.tsx`, `state/EditorStore.tsx` |
| Show model | `src/renderer/services/{timeline,cueBus,stateMachine}.ts` |
| Plugins | `plugins/{lidar-tracking,ndi,calibration,spout,hap,mp4,mediapipe,augmenta,audio,show-control}/` |
| IPC / codec | `shared/protocol.ts`, `shared/frameCodec.ts` |
| Types | `src/renderer/types.ts` |
