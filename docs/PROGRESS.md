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

## What works today
- Runs as a native **Electron** desktop app: `npm run dev` (electron-vite). Three-process build: main / preload / renderer.
- **Native Art-Net** over UDP from the main process (`src/main/transport/artnet.ts`), wired via IPC (`shared/protocol.ts`, `src/preload/index.ts`, `src/main/ipc.ts`). The old WebSocket bridge is gone.
- **WebGPU compute** pixel mapper (`src/renderer/gpu/WebGPUMapper.ts`) with WebGL fallback (`src/renderer/services/GPUMapper.ts`) behind a shared `IPixelMapper` interface. Stage tries WebGPU first.

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
- Still future (optimization): **SharedArrayBuffer + dedicated send thread** (the engine
  currently receives targets via napi each frame, which already removes per-packet JS work).

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

## Open items
- **Native engine optimization**: SharedArrayBuffer + dedicated send thread (and packaging
  the `.node` via electron-builder `asarUnpack` for distribution).
- **ui-ux-pro-max skill** not yet vendored: the `uipro-cli` global install was blocked by the sandbox. Plan: copy `src/ui-ux-pro-max/` from the named GitHub repo into `.claude/skills/` (needs approval). Skill is already usable in-session meanwhile.
- Deferred effects: stateful **fire2012**, **multi-segment** subdivision per fixture.
- **Parity check**: WebGPU vs WebGL pixel output verified only as "initializes + runs"; confirm visually with a loaded source against the DMX Monitor.

## Verification cheatsheet
- Build: `npm run build` (compiles main+preload+renderer).
- Native engine: `npm run build:native` (Rust → `output-engine.node`). Required once after clone.
- Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`.
- Art-Net bytes: a UDP listener on `127.0.0.1:6454` + the transport produces a valid `Art-Net` OpOutput packet (header, `0x5000`, universe, length, payload, non-zero seq) — validated during Phase A.
