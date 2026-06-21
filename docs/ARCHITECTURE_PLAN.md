# ArtLux → WebGPU Compute + Electron + WLED Feature Port

> Architecture & implementation roadmap. This document is the source of truth for the
> planned rewrite. Each phase is designed to leave the app runnable.

## Context

**ArtLux** is a React 19 + Vite + TypeScript web SPA for addressable-LED pixel mapping.
Today it samples colors from a video/image/camera source via **WebGL 1.0**
(`services/GPUMapper.ts`), packs pixels into DMX universes in a **CPU JS loop**
(`components/Stage.tsx`), and emits Art-Net over a **WebSocket → Node UDP bridge**
(`artlux-bridge.cjs`) because browsers can't do raw UDP.

Three structural limits motivate this work:

1. **Not full GPU compute** — only sampling is on GPU; packing is CPU, and `read()` does a
   **synchronous `gl.readPixels`** (the biggest stall).
2. **No generative engine** — WLED's core (effects, palettes, segments, 2D, color
   correctness) is absent; ArtLux can only mirror media.
3. **Bridge friction** — the WebSocket bridge is an extra process and a browser workaround.

**Goal:** A **full Electron migration** where the renderer is the current React app; a
**WebGPU compute** backend that does effects, sampling, mapping, color correction, AND
universe packing on-GPU with async readback; a **WLED feature port** (effects + palettes,
segments, 2D matrix + ledmap, color correctness); and a **MadMapper-class output engine**
with **per-fixture routing** ("jump from fixture to fixture": each fixture → its own
IP/universe/channel slice, sparse changed-only output, unicast/broadcast, sync), targeting
hundreds–4096 universes at high/precise fps.

Two additions on top of that roadmap:

- **3D LED fixture editor + live simulator** — a third view (`ViewMode.SIMULATOR_3D`) using
  **react-three-fiber** where each fixture has a **true 3D transform** (`position3D`,
  `rotation3D`, `layout3D`); LEDs render as a single instanced mesh glowing with live DMX
  colors (consumed from the existing `dmxSignal` bus). Built as an **independent phase
  (Phase G)** — it depends only on the stable `dmxSignal` contract + React state, so it
  neither blocks nor is blocked by the Electron/WebGPU work.
- **ui-ux-pro-max skill** committed into the repo (`.claude/skills/`) and used to design the
  3D view + polish the app UI.

### Native-language assessment (do we need full C++/Rust?)

**No — and a *full* native rewrite would hurt.** The heavy per-pixel work goes to the
**GPU (WebGPU)**, where the host language is irrelevant. The only CPU hot path that needs
"robustness" is the **transport** (pack → per-fixture route → UDP send). A full rewrite
implies **Tauri**, whose OS-webview WebGPU is unreliable/flagged — directly undermining the
WebGPU decision; **Electron bundles Chromium so WebGPU is guaranteed**. Therefore: keep
Electron + React + WebGPU, and put **only the output engine in Rust** via a **napi-rs
native addon**. Node `dgram` is the wrong tool at MadMapper scale (no `sendmmsg` — every
packet is an individual JS→C++ syscall; event-loop/GC timing jitter; Windows per-iteration
UDP limits).

**Decision: hybrid, staged** — ship a TS Art-Net transport first for parity (Phase A),
then swap in the Rust output engine (Phase F).

## WLED references (ground truth for the port)

- Effects: `wled00/FX.cpp` (e.g. `mode_rainbow`, `mode_fire_2012` id 66, `mode_palette` id
  65), `wled00/FX.h`.
- Render/segment engine: `wled00/FX_fcn.cpp` (Segment class, `show()`); 2D:
  `wled00/FX_2Dfcn.cpp` (`XY()` serpentine).
- Palettes: `wled00/palettes.h` — `DEFINE_GRADIENT_PALETTE` `{idx,r,g,b, ...}` anchor
  arrays, linearly interpolated to 256 entries.
- Color/gamma: `wled00/colors.cpp` — `calcGammaTable` = `pow(i/255, gamma)*255` (default
  2.8); color order + RGBW auto-white in `bus_manager.cpp` / `bus_wrapper.h`.

Repo: https://github.com/wled/WLED

## Target structure (electron-vite)

```
electron.vite.config.ts            (new; reuses current renderer Vite settings)
package.json                       (main, scripts, deps)
shared/protocol.ts                 (new; IPC channels + universe-buffer layout types)
src/
  main/index.ts                    (BrowserWindow, lifecycle)
  main/transport/{artnet,sacn,outputManager}.ts   (Phase A: TS transport, for parity)
  main/ipc.ts
  preload/index.ts                 (contextBridge API)
  renderer/                        (current app moves here verbatim, fix imports)
    index.html index.tsx App.tsx components/ hooks/ services/ types.ts
    gpu/{WebGPUMapper.ts, palettes.ts, gammaLut.ts, shaders/*.wgsl}
    services/dmxScheduler.ts       (new)
native/output-engine/             (Phase F: Rust napi-rs crate — real-time UDP)
    Cargo.toml  src/lib.rs (napi exports)  src/{artnet,sacn,router,pacer}.rs
    index.d.ts (generated)
```

## Phased plan (each phase leaves the app runnable)

### Phase A — Electron shell + native UDP (keep existing WebGL)

- Scaffold **electron-vite** + **electron-builder**. Move renderer files under
  `src/renderer/`. Keep `@types/node`; add `electron`, `electron-vite`, `electron-builder`
  (dev).
- `package.json`: `"main": "out/main/index.js"`; scripts → `electron-vite dev/build/preview`,
  `package` → `electron-vite build && electron-builder`.
- `src/main/index.ts`: BrowserWindow with `contextIsolation:true, nodeIntegration:false,
  sandbox:true`, preload.
- `src/preload/index.ts`: expose `window.artlux` = `{ sendFrame(buf), configureOutput(cfg),
  onStatus(cb), saveProject(json), loadProject() }`. Channel/payload types in
  `shared/protocol.ts`.
- `src/main/transport/artnet.ts`: port `fillPacketBuffer` from
  `services/mockSocketService.ts` (`ARTNET_HEADER`, OpOutput `0x5000`, seq, universe lo/hi,
  len hi/lo, 512 bytes) using `dgram`; unicast or `setBroadcast(true)`.
- Keep existing `GPUMapper` + CPU packing; route the packed buffer through IPC instead of
  WebSocket. **Delete `artlux-bridge.cjs`**; gut WebSocket code from `mockSocketService.ts`
  (becomes a thin `window.artlux.sendFrame` wrapper). In `App.tsx`: drop
  `useWsBridge`/`wsBridgeUrl`, subscribe to IPC status, swap blob save/load for native
  dialogs.
- **Parity checkpoint:** identical Art-Net output to current app.

### Phase B — WebGPU mapper parity

- New `src/renderer/gpu/WebGPUMapper.ts` (replaces `GPUMapper.ts`); keep a similar surface
  (`init/updateSource/updateLayout/setBrightness/tick/readAsync`) so `Stage.tsx` changes
  stay small. Add `@webgpu/types`.
- Resources: source via `importExternalTexture`/`copyExternalImageToTexture` (reuse the
  512×512 aspect-correct canvas draw in `Stage.tick`); **LED map storage buffer**
  `{uv, segIndex, flags}` built by reusing rotation/linear-distribution math from
  `GPUMapper.updateMapping`; **output storage buffer** sized `universeCount*512` laid out as
  concatenated DMX universes.
- Compute stages (WGSL): sample → color-correct (subtract-min RGBW first, for parity) →
  **pack** (compute `(universe, channel)` per LED on GPU, handling 512 overflow — replaces
  the CPU loop in `Stage.tsx`).
- **Async readback:** ring of 2–3 `MAP_READ` staging buffers + `mapAsync`; skip frame if
  still mapped (backpressure). Removes the synchronous `gl.readPixels`.
- **Decouple DMX rate:** new `services/dmxScheduler.ts` drives readback + IPC send at ~22ms
  (reuse the `now-lastSendTime<22` logic) independent of RAF render rate.
- Feature-flag fallback to WebGL `GPUMapper` when `navigator.gpu` absent. **Parity:**
  byte-for-byte match Phase A for media mode.

### Phase C — Effects + palettes + segments

- Extend `types.ts`: `Segment { start, stop, grouping, spacing, offset, reverse, mirror,
  source(MEDIA|EFFECT), effectId, paletteId, speed, intensity, custom1-3, brightness,
  colors }`; `Fixture.segments: Segment[]` (default one full-range segment). All
  JSON-serializable so `useHistory` deep-clone keeps working; keep live `colorData` out of
  history/project files.
- `gpu/palettes.ts`: copy `DEFINE_GRADIENT_PALETTE` arrays, CPU-expand to 256 texels each,
  pack into a `256×N` palette LUT texture. Segment uniform/storage buffer mirrors WLED
  Segment fields.
- `gpu/shaders/effects.wgsl`: one WGSL fn per effect, switch on `effectId`. Start:
  **rainbow** (per-LED hue from index+time), **palette** (`samplePalette(idx)`),
  **fire2012** (ping-pong `heat` storage buffer: cool → blur → sparks → palette, hashed
  PRNG). Stateful effects use persistent storage buffers.
- `sample.wgsl` applies segment index transforms (grouping/spacing/mirror/reverse/offset).
  UI in `InspectorPanel.tsx`/`ScenePanel.tsx` to assign source/effect/palette/segment.

### Phase D — 2D matrix + ledmap + color correctness

- `Fixture`: `shape(LINE|MATRIX)`, `matrixWidth/Height`, `serpentine`, `ledMap?: number[]`,
  `colorOrder`, `rgbwMode`, `channelsPerPixel`. Matrix XY + serpentine in `sample.wgsl`
  (from `FX_2Dfcn.cpp`); ledmap import (WLED `ledmap.json`).
- `gpu/gammaLut.ts`: 256-entry `pow(i/255, gamma)` LUT (default 2.8). `correct.wgsl`:
  color-order permutation + WLED auto-white modes (subtract-min/dual/accurate) + gamma.
  Settings expose gamma; existing projects keep subtract-min default so output doesn't
  change unexpectedly.

### Phase E — Per-fixture routing + output targeting (TS)

- Extend `types.ts` with per-fixture routing (the "jump from fixture to fixture"
  requirement): each fixture targets its own controller, with sparse/changed-only output.

```ts
interface OutputTarget {                 // per fixture
  protocol: 'artnet' | 'sacn';
  mode: 'unicast' | 'broadcast';
  ip: string;                            // controller IP for unicast
  sparse: boolean;                       // only send used channels / changed universes
  priority?: number;                     // sACN
}
interface Fixture { /* …; */ output: OutputTarget }
```

- `outputManager.ts` builds a **routing table** grouping universes by destination, iterates
  fixture → fixture, and unicasts each controller's slice; dirty-tracking skips unchanged
  universes. UI in `InspectorPanel.tsx` to set per-fixture IP/protocol/mode. Still TS/dgram
  — proves the routing model before the native rewrite. Update `AppSettings` (defaults for
  `fps`, `gamma`, default target; remove `wsBridgeUrl`/`useWsBridge`).

### Phase F — Rust output engine (napi-rs) + sACN

- New crate `native/output-engine/` exposed via **napi-rs**, replacing the TS transport hot
  path. Owns a **dedicated real-time thread**:
  - Reads the GPU-packed buffer + routing table from the renderer over a
    **`SharedArrayBuffer`** (allocated once; `Atomics.notify` signals a new frame — no
    per-frame IPC clone).
  - `router.rs`: per-fixture/per-destination grouping + sparse changed-only diffing.
  - `artnet.rs` / `sacn.rs`: Art-Net (OpOutput) and sACN/E1.31 (Root vector `0x00000004` +
    Framing priority 100 + DMP `0x02 0x00` + 512; multicast `239.255.U_hi.U_lo:5568` or
    unicast; sync packets), per-universe sequence.
  - `pacer.rs`: high-precision pacer independent of the JS event loop; batched UDP via
    `sendmmsg` (Linux/mac) / io_uring or grouped `send` (Windows). Scales toward
    MadMapper-class 4096 universes / high fps.
- `outputManager.ts` becomes a thin loader for the addon (keep the TS path behind a flag as
  fallback). **Parity:** native output must byte-match the Phase E TS output for the same
  project.

### Phase G — 3D LED fixture editor + live simulator (independent; can run in parallel)

A new `ViewMode.SIMULATOR_3D` view: a true-3D editor where fixtures are placed/moved/rotated
in space and LEDs glow with **live DMX colors**. The 2D stage still decides *what content
each LED samples*; the 3D view describes *where each LED physically is*. Both share the one
runtime stream — the `dmxSignal` per-LED RGBW buffer (4 bytes/LED, concatenated in fixture
order) — so the 3D view is a pure **consumer** of color, with the identical cumulative-offset
indexing already used by `DMXMonitor`.

**Dependencies (react-three-fiber v9 line = React 19):** `three`, `@react-three/fiber@^9`,
`@react-three/drei@^10`, `@react-three/postprocessing@^3`, dev `@types/three`.

**Data model (`types.ts`) — additive, optional, JSON-serializable** (back-compat +
`useHistory`/save-load unaffected):

```ts
interface Vec3 { x: number; y: number; z: number }
interface Euler3 { pitch: number; yaw: number; roll: number }   // degrees
type Layout3DType = 'line' | 'matrix' | 'arc'
interface Layout3D {
  type: Layout3DType; ledSpacing: number;
  matrixRows: number; matrixCols: number; serpentine: boolean;
  arcRadius: number; arcAngle: number;
}
interface Fixture { /* …existing 2D fields untouched…; */
  position3D?: Vec3; rotation3D?: Euler3; layout3D?: Layout3D }
enum ViewMode { MAPPING, MONITORING, SIMULATOR_3D }
```

- **Pure layout fn** `services/led3dLayout.ts` → `computeLedTransforms(f): {pos: Vec3}[]` (the
  3D analog of `GPUMapper.updateMapping`). Local positions in the fixture XY plane (normal
  +Z): **line** centered on X; **matrix** rows×cols with serpentine odd-row reversal; **arc**
  sweeping `arcAngle` on `arcRadius`. Apply `reverse`, then the fixture Euler (fixed **XYZ**
  order, matching drei `TransformControls`) + translate by `position3D`. Pure/testable;
  reusable later for 3D→content projection (future work).
- **Back-compat migration at read-time** (no project mutation): when 3D fields are absent,
  derive defaults from the existing normalized 2D (`position3D` from `x,y` centered on a
  default 4×2.25 m stage, `rotation3D.roll = rotation`, `ledSpacing` from `width`) via `??`
  fallbacks inside `computeLedTransforms`.

**Rendering & performance:** ONE `THREE.InstancedMesh` for **all** LEDs (`count = Σ
ledCount`); `instanceIndex === cumulative LED index` (the buffer is already in fixture order,
so no per-fixture bookkeeping at color time). Material `MeshBasicMaterial` with
`toneMapped={false}` (self-lit LED look) + **Bloom** via `<EffectComposer><Bloom/>`. Rebuild
`instanceMatrix` only on layout/transform/ledCount change. **Points** fallback above ~50k
LEDs.

**Live color hook** `useLedColors` (ref-based, zero React re-renders): subscribe to
`dmxSignal` (same `subscribe()` as `DMXMonitor`), store latest `pixels` + a dirty flag in
refs; in `useFrame`, write RGB straight into `instanceColor.array` (Float32Array; fold W into
RGB, clamp) and set `needsUpdate`, throttled by the dirty flag.

**Editing UX (drei):** click an instance → map `e.instanceId` → fixtureId → set the shared
`selectedFixtureId`. `<TransformControls>` (translate/rotate, W/E toggle) on the selected
fixture; disable `<OrbitControls>` while dragging via `dragging-changed`. `recordHistory()`
once at drag-start; commit on drag-end through a **new** `handleCommitFixture3D` in `App` that
sets state **without** re-recording (avoids double history); Inspector numeric edits use the
existing `handleUpdateFixture` (which records). `<Grid>` ground + `<GizmoHelper>` viewcube. New
"3D Layout" section in `InspectorPanel.tsx` (reuse its `PanelSection`/`NumberInput`) for
position/rotation/layout/spacing/rows/cols.

**Components** under `components/Simulator3D/`: `Simulator3D.tsx` (Canvas + toolbar),
`Scene.tsx`, `InstancedLeds.tsx`, `FixtureGizmo.tsx`, `Lighting.tsx`, `GroundGrid.tsx`,
`hooks/useLedColors.ts`. Mount in `App.tsx` as a third absolute overlay (mirror the
MAPPING/MONITORING pattern). Add a third toggle button in `TopBar.tsx`. **Keep `Stage.tsx`
mounted** (overlays use opacity, not unmount) so its RAF keeps publishing `dmxSignal` while
the 3D view is shown.

**Isolation from the Electron/WebGPU work:** the 3D view runs Three's WebGL renderer in its
own `<Canvas>`/RAF; the WebGPU migration only concerns the engine that *fills* the dmxSignal
buffer. Decoupled by the bus. Code-split via `React.lazy` so `three` doesn't bloat startup;
use r3f `frameloop` gating when the 3D view is hidden.

## Files to modify / create

- **Modify:** `components/Stage.tsx` (swap mapper, remove CPU packing, route via
  dmxScheduler), `App.tsx` (IPC status, native save/load, drop bridge wiring; Phase G: 3D
  overlay + `handleCommitFixture3D`), `types.ts`
  (segments/2D/ledmap/colorOrder/RGBWMode/effects; Phase G: Vec3/Euler3/Layout3D +
  `SIMULATOR_3D`), `components/TopBar.tsx` (Phase G: 3D view toggle), `components/InspectorPanel.tsx`
  (Phase E: per-fixture routing UI; Phase G: 3D Layout section), `services/mockSocketService.ts`
  (gut WS → IPC wrapper), `package.json`.
- **Create:** `electron.vite.config.ts`, `shared/protocol.ts`, `src/main/index.ts`,
  `src/main/ipc.ts`, `src/main/transport/{artnet,sacn,outputManager}.ts`,
  `src/preload/index.ts`, `src/renderer/gpu/{WebGPUMapper.ts, palettes.ts, gammaLut.ts,
  shaders/*.wgsl}`, `src/renderer/services/dmxScheduler.ts`, (Phase F) the Rust crate
  `native/output-engine/` (`Cargo.toml`, `src/{lib,artnet,sacn,router,pacer}.rs`), and
  (Phase G) `services/led3dLayout.ts` +
  `components/Simulator3D/{Simulator3D,Scene,InstancedLeds,FixtureGizmo,Lighting,GroundGrid}.tsx`
  + `components/Simulator3D/hooks/useLedColors.ts`.
- **Delete:** `artlux-bridge.cjs`.

## Risks

- **WebGPU on Windows drivers:** may need
  `app.commandLine.appendSwitch('enable-unsafe-webgpu')`/Dawn flags; detect `navigator.gpu`,
  keep WebGL fallback (Phase B flag).
- **Readback latency:** `mapAsync` adds ~1 frame; mitigated by staging-buffer ring +
  decoupled 44Hz scheduler (acceptable for lighting).
- **Scale:** TS transport (Phases A–E) is interim and scale-capped; the Phase F Rust engine
  + `SharedArrayBuffer` handoff is what reaches MadMapper-class counts. Don't over-invest in
  optimizing the TS dgram path.
- **Native build complexity:** napi-rs adds a Rust toolchain + per-platform prebuilds to
  CI/packaging; keep the TS transport behind a flag so the app still runs if the addon fails
  to load.
- **Phase G (3D):** `three` bundle size → `React.lazy` code-split, load only on first 3D
  entry; perf at 10k+ LEDs → single InstancedMesh + direct Float32Array color writes +
  dirty-flag throttle, Points fallback above ~50k; gizmo↔orbit conflict → toggle orbit on
  `dragging-changed`; double history → record at drag-start, commit without re-record; **must
  keep `Stage` mounted** (opacity, not unmount) or the `dmxSignal` stream stops in 3D mode;
  fix Euler order (XYZ) consistently in the layout fn + gizmo commit.

## Verification

- **Per-phase parity:** capture the packed universe buffer at Phase A as a golden reference;
  assert Phase B/C produce identical bytes for the same fixtures + a static source.
- **Packet correctness:** unit-test the TS `artnet.ts`/`sacn.ts` and the Rust
  `artnet.rs`/`sacn.rs` byte layout against the known-good `ARTNET_HEADER` and E1.31 spec;
  assert the Rust engine byte-matches the Phase E TS output for the same project.
- **End-to-end:** point output at a receiver — Art-Net via DMX-Workshop / a WLED device in
  Art-Net mode; sACN via sACNView — and confirm live pixels track the source/effect. For
  per-fixture routing, verify two controllers on different IPs each get only their slice.
  Keep a debug per-packet log (mirrors the old bridge).
- **Scale test:** drive a synthetic project (hundreds of universes, multiple unicast
  targets) and measure send cadence/jitter to confirm the Rust engine holds frame rate.
- **Phase G (3D) end-to-end:** add 2–3 fixtures + a video source → switch to the 3D view →
  LEDs appear at migrated positions glowing with live colors that track the source and match
  the DMXMonitor strips; click an LED selects its fixture; drag the gizmo to move/rotate,
  release → Inspector `position3D` updates and one Ctrl+Z undoes it; change layout
  (line→matrix, rows/cols, serpentine, arc angle) updates live; save → reopen JSON shows
  `position3D/rotation3D/layout3D`; load an OLD project (no 3D fields) still renders via
  migration; ~10k LEDs holds frame rate.
- **Run:** `npm run dev` (electron-vite) launches the desktop app each phase; the Rust addon
  builds via napi-rs (`napi build`); package with `npm run package` (electron-builder +
  per-platform native prebuilds).
