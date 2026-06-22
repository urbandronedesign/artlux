# ArtLux — Architecture (current)

The canonical reference for how ArtLux works today. For the historical pre-Electron rewrite roadmap
see [ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md); for the surfaces design see [SURFACES.md](SURFACES.md);
for usage see [FEATURES.md](FEATURES.md); for the build log see [PROGRESS.md](PROGRESS.md).

## Overview
ArtLux is an Electron desktop app that maps content (video / image / camera / Spout / DMX-in /
generative effects) onto addressable-LED fixtures and streams the result over **Art-Net** and
**sACN/E1.31**. Pixel work runs on the GPU (**WebGPU** compute, WebGL fallback); UDP output runs in a
native **Rust** engine. Stack: Electron · React 19 · TypeScript · Vite (electron-vite) · Tailwind ·
WebGPU · react-three-fiber · Rust (napi-rs).

## Processes
- **Main** (`src/main/`): app lifecycle + window, native transport (Art-Net/sACN, ArtPoll discovery,
  Spout receiver), persistence (dialogs + userData), the native menu. Owns all OS access (UDP, fs,
  `.node` addons) — the renderer is sandboxed.
- **Preload** (`src/preload/index.ts`): `contextBridge` exposes a typed `window.artlux` API over IPC.
- **Renderer** (`src/renderer/`): the React UI + the frame-generation loop (Stage + GPU mapper).
- **Shared** (`shared/`): the IPC contract (`protocol.ts`) and the binary frame codec (`frameCodec.ts`),
  imported by both sides.
- **Native** (`native/`): two napi-rs Rust crates — `output-engine` (Art-Net/sACN send thread) and
  `spout-receiver` (Windows Spout, stubbed elsewhere), built to `*.node`.

## Frame pipeline (renderer → hardware)
Per animation frame, `components/Stage.tsx` `tick()`:
1. **Composite preview** — draws every surface's content into the 512² preview canvas (z-order), for
   the on-screen preview (and the WebGL fallback's sampling source).
2. **Per-surface GPU sampling** (WebGPU) — `WebGPUMapper.renderSurfaces()` runs one compute pass per
   surface: it uploads that surface's drawable into the source texture and dispatches only the LEDs
   linked to it (`ledMeta.w == activeSurface`), sampling at **surface-local UVs**. Output buffer is
   cleared each frame so unlinked LEDs are black. One async readback (staging ring). → strict
   per-surface sampling. (WebGL fallback samples the global composite — degraded, not overlap-strict.)
3. **Universe packing** — for each fixture, RGBW bytes are written into per-universe 512-channel
   arrays applying **color order** + **gamma LUT** + **channels-per-pixel** (RGB/RGBW), spanning the
   512 boundary as needed. Destinations are resolved per fixture from its **controller** → per-fixture
   `output` override → global settings, keyed by `${protocol}|${ip}|${broadcast}`.
4. **Publish** — `dmxSignal.publish(pixels, destinations)`; `App`/`HeadlessRunner` subscribe and call
   `window.artlux.sendArtNet(encodeFrame(targets))` → IPC `dmx:frame` → main → `outputManager`.

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

## Output / transport (`src/main/transport/`)
`outputManager.ts` prefers the native `output-engine.node` (Rust send thread + pacer + keep-alive +
sparse + ArtSync) and falls back to TS `artnet.ts`/`sacn.ts`. `discovery.ts` does ArtPoll/ArtPollReply.
`input.ts` captures incoming Art-Net/sACN. `spoutManager.ts` loads `spout-receiver.node` and streams
512² frames to the renderer.

## IPC (`shared/protocol.ts`)
Fire-and-forget `.on`/`.send`: `dmx:configure`, `dmx:frame`, `dmx:status`, `dmx:stats`,
`input:configure`/`input:frame`, `spout:configure`/`spout:frame`, `menu:action`, `app:open-external`.
Request/response `invoke`/`handle`: `project:save`/`open`/`load-path`, `rig:export`/`import`,
`prefs:get`/`set`, `artnet:discover`, `spout:list`, `app:get-info`.

## Persistence (`src/main/persistence.ts`)
All file I/O is in main (renderer is sandboxed). Projects are `.artlux` JSON
(`{ version, surfaces, fixtures, controllers, settings, globalBrightness, groups, scenes }`); rigs are
`.artrig` (fixtures' patch/wiring only). Preferences live in `userData/artlux-prefs.json`
(`appSettings`, `globalBrightness`, `recentFiles`, `lastProjectPath`, `fixtureTemplates`) and
auto-restore on launch.

## Headless (`--headless --project=<path>`)
`src/main/index.ts` parses CLI args; a hidden GPU window (`backgroundThrottling:false`) loads a second
renderer entry (`headless.html`/`headless.tsx`/`HeadlessRunner.tsx`) that mounts only the Stage
compute + output loop — no UI/3D/monitor. Used for low-overhead runs and automated output tests.

## Key files
| Area | File |
|------|------|
| App shell / state | `src/renderer/App.tsx` |
| Frame loop + packing + canvas | `src/renderer/components/Stage.tsx` |
| GPU mappers | `src/renderer/gpu/WebGPUMapper.ts`, `src/renderer/services/GPUMapper.ts` |
| Surface content / effects | `src/renderer/services/surfaceMedia.ts`, `src/renderer/gpu/surfaceFx.ts` |
| Auto-patch | `src/renderer/services/addressing.ts` |
| Routing UI | `src/renderer/components/RoutingModal.tsx` |
| Main / window / CLI | `src/main/index.ts`, `src/main/menu.ts` |
| Transport | `src/main/transport/{outputManager,artnet,sacn,discovery,input,spoutManager}.ts` |
| Native | `native/output-engine/`, `native/spout-receiver/` |
| IPC / codec | `shared/protocol.ts`, `shared/frameCodec.ts` |
| Types | `src/renderer/types.ts` |
