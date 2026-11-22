# A native render engine — every pixel in one Rust process, the UI as a client, any view on any screen

> **Status:** 🟦 **ADOPTED by the owner 2026-11-20 — nothing built yet.** This is the target
> architecture. Phase E5 (multi-window UI, §9a) goes first; the engine phases E0–E4 follow. Branch
> `plan/multiscreen-workspace`.
> **Supersedes:** [multiscreen-workspace.md](multiscreen-workspace.md) (rejected by the owner the same
> day: it kept every pixel inside the editor's browser, so one main thread served every window and the
> 3D view had to be rebuilt to move). **Absorbs:** [native-core.md](native-core.md) (its output-first
> staging and decode ledger survive; its "never the 3D view, never the timeline" limit does not) and
> closes [webgpu-unified-device.md](webgpu-unified-device.md). It **reopens** the 2026-07-29
> multithreading decision on purpose: a native engine is threaded by construction.
> **Placement:** Core + a new `engine/` Rust binary · **Risk:** 🔴 High, the output path, staged so that
> every phase ships and the browser engine stays the fallback until the last one · **Size:** honest
> estimate 12–18 months for one developer, see §9.

## 0. The ask, and the shape of the answer

The owner wants: **best performance with no fixed fps cap, Mac and PC, multi-screen, any part of the
editor (timeline, 3D, …) on any screen**, and an approach that holds for *all* ArtLux features, not
one panel.

The constraint behind every earlier answer is a single fact: **all of ArtLux's GPU work lives inside a
browser page, and a browser will not let two windows share a GPU device.** That is why content is
uploaded twice, why projectors are fed by copying frames over a MessagePort, why the 3D view owns a
second device, why the LEDs make a GPU→CPU→GPU round trip to be drawn in 3D, and why moving the 3D view
to another window would rebuild it. Bolting windows onto that (the superseded plan) inherits all of it.

**The answer is the architecture the class of tools ArtLux competes with uses: a native engine owns
every pixel, the UI is a client of it.**

```
 ┌──────────────── artlux-engine (Rust, its own process, owns its main thread) ─────────────────┐
 │ ONE wgpu device (D3D12 on Windows · Metal on macOS · Vulkan on Linux)                         │
 │  decode ─► content textures ─► render graph (surfaces, timeline layers, blends, shaders,      │
 │  (HAP, MF/VideoToolbox,         effects, text, tracking)                                       │
 │   camera, NDI, Spout, Syphon)        │                                                         │
 │                                      ├─► LED sampling ─► packing ─► Art-Net / sACN / USB-DMX   │
 │                                      ├─► projector outputs: warp / blend / calibrated scene    │
 │                                      │     → native fullscreen windows, one swapchain each     │
 │                                      ├─► 3D scene (one scene, N cameras) ─┐                    │
 │                                      └─► 2D stage preview, output previews ┴─► views           │
 │  audio (JUCE, same process: ONE clock for picture, sound and DMX)                              │
 └──────────▲───────────────────────────────────────────────┬────────────────────────────────────┘
            │ commands + document diffs (small)             │ views: native windows, or shared
            │                                               │ GPU textures (no CPU copy)
 ┌──────────┴──────────── Show Host (Node, Electron utilityProcess) ──────────┐   │
 │ the document (lifted out of App.tsx) · undo · state machine · cues ·       │   │
 │ OSC · show-control server · scheduler · persistence · fixture library      │   │
 └──────────▲──────────────────────────────────────────────────────────────────┘   │
            │ store subscription + actions                                         ▼
 ┌──────────┴──────── UI windows (Electron BrowserWindows, one process each) ─────────────────┐
 │ editor · detached timeline · detached inspector · … React, the existing 120k lines of UI   │
 │ viewports = a <canvas> showing the engine's shared texture, with React overlays on top     │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

What this buys, in the owner's terms:

| Goal | How |
|---|---|
| **Best performance, no cap** | Nothing in the pixel path runs in JavaScript, React, layout or GC. Content is decoded and uploaded **once** and shared by LEDs, 3D, projectors and previews. Work is change-driven (no new frame → no work), and each window presents at **its own display's full refresh**. A UI hitch cannot touch an output: different process. |
| **Multi-screen** | Every UI window is its own process (a hitch in one does not freeze another), all clients of one document. Every *view* (3D, stage, output preview) is an engine camera, so it can be on any screen, in any number, **without rebuilding anything**. Moving the 3D view becomes "present this camera to that window". |
| **Mac, PC and Linux** | wgpu runs on Metal, D3D12 and Vulkan natively. VideoToolbox / Media Foundation hardware decode and Syphon / Spout land as GPU textures **without a CPU copy**. Output no longer depends on which WebGPU a given Chromium ships. |
| **All features** | §2 places every feature, row by row. |

## 1. Why this, and not the alternatives

| Approach | Verdict |
|---|---|
| Stay all-browser and add windows (superseded plan) | ❌ One renderer thread for all windows, 3D rebuilt on every move, two GPU devices, the projector copy pump. It can never beat the browser's ceiling. |
| Tauri / Qt / Slint / egui, a full UI rewrite | ❌ for the UI. The UI is not the performance problem; the pixels are. Rewriting ~120k lines of working React (docking shell, NLE, node editor, state graph, inspectors, help, design system) costs years and buys nothing at the wire. *Revisit only after Phase E5*: once no GPU work is in the webview, the old reason for pinned Chromium is gone and Tauri becomes a legitimate option for the shell. |
| A game engine (Unreal, Unity, Godot, Bevy) as the engine | ❌ Their frame loop, asset pipeline and release cadence are built for games. ArtLux needs a deterministic render graph clocked by the show, exact frame delivery for media, a DMX/Art-Net sink, and zero-copy imports of Spout, Syphon, NDI and hardware decode. wgpu gives exactly the device and nothing to fight. Small focused crates are still used: `gltf`, `image`, `cosmic-text`/`glyphon`, `naga`. |
| Engine as a napi addon inside a Node process (native-core's first idea) | ❌ for the engine. **macOS requires windows to be created on a process's main thread**, and in a Node process that thread is Node's event loop. A standalone binary owns its main thread on both OSes. It also isolates a GPU driver crash, which the watchdog then restarts. (It also answers native-core §10 q1, "can winit and Electron's loop coexist?": they don't have to.) |
| **Native engine process + Electron UI as a client** | ✅ This plan. |

**The fact that makes the UI side cheap:** Electron 42.4.1 (the version shipped today) has the
`sharedTexture` module: `importSharedTexture` takes a **Windows NT handle, a macOS IOSurface or a
Linux dmabuf** and yields a `VideoFrame` inside a page, with `sendSharedTexture` /
`setSharedTextureReceiver` to deliver it to a renderer (checked in `node_modules/electron/electron.d.ts`
2026-11-20; marked **experimental** upstream). So an engine-rendered viewport is a `<canvas>` in React
with real DOM overlays on top (menus, tooltips, the fixture handles), **without** a CPU readback and
**without** the native-child-window "airspace" problem where popovers cannot draw over a native view.

## 2. The feature ledger — where every feature lives

Legend: **E** engine (Rust) · **H** Show Host (TypeScript, Node) · **U** UI window (React) ·
*phase* = when it moves (§9). "Seed" = Rust/C++ that already exists.

### Content sources (`SourceType`, `renderer/types.ts:264`)

| Feature | Today | New home | How | Phase |
|---|---|---|---|---|
| VIDEO — HAP | `plugins/hap` WebGL + native demux | **E** | `native/hap` already decodes in Rust; upload DXT blocks straight to a BC texture (no RGBA expansion) | E1 |
| VIDEO — MP4/H.264/HEVC | `plugins/mp4` WebCodecs `VideoFrame` | **E** | Media Foundation D3D11VA (Win) / VideoToolbox (mac), decoded surface imported into wgpu, zero-copy. Ends the "WebCodecs is a renderer API" blocker and the session-limit juggling | E2 |
| IMAGE | `ImageBitmap` in renderer | **E** | `image` crate / WIC / ImageIO | E1 |
| CAMERA | `getUserMedia` in renderer | **E** | Media Foundation / AVFoundation capture; `native/calib/src/dshow.rs` is a seed | E2 |
| SPOUT | native receive → RGBA copy → renderer | **E** | import the D3D11 shared handle into D3D12 directly: **removes two copies** | E1 |
| SYPHON | native receive → renderer | **E** | IOSurface → Metal texture | E1 |
| NDI | native receive → RGBA → renderer | **E** | already Rust; upload once in the engine | E1 |
| DMX_IN | main → renderer canvas | **E** | universes → small texture in the engine | E1 |
| LAYER / PROGRAM (timeline composite) | `services/timeline.ts` 2.2k lines, canvas 2D `globalCompositeOperation` | **E** render graph; timeline *model* stays **H** | blend modes as shader passes (faster and exact). See §4 for the clock | E3 |
| SLICE | 2D-canvas crop | **E** | a UV rect: free | E1 |
| EFFECT | CPU TypeScript loop `gpu/surfaceFx.ts` | **E** | compute shader; parity test against the TS output | E1 |
| TEXT | `plugins/text` canvas raster | **E** (phase 1: **U** rasterises, engine receives an image on change) | text changes rarely, so shipping the raster on edit is fine first; `glyphon` later | E2 |
| SHADER (node editor) | `plugins/shader` emits GLSL into WebGL | **E** | the editor stays **U**; its GLSL goes through `naga`'s GLSL front end to WGSL, or the emitter gets a WGSL target. Generated node reference unchanged | E2 |
| TRACKING / AUGMENTA | OSC in main → renderer `blobPass` GLSL | data **H**, drawing **E** | blob data is small; port the two `blobPass` shaders | E2 |
| MEDIAPIPE | WASM BlazePose in renderer | stays a **U/worker** data producer | it needs camera pixels, which the engine sends it as a `sharedTexture` `VideoFrame`; it returns pose points only | E2 |

### Output, mapping, lighting

| Feature | Today | New home | Phase |
|---|---|---|---|
| Surface composite + masks (`matteGL`), colour engine, transitions, scene look | renderer | **E** | E1–E3 |
| LED sampling, strict per-surface UVs (`WebGPUMapper` WGSL) | renderer WebGPU | **E**. Same language (WGSL), so it moves rather than being rewritten. The WebGL fallback's *wrong-pixels* problem disappears: wgpu's backends all do it the strict way | E1 |
| Universe packing, gamma, colour order → Art-Net / sACN | renderer packs → IPC → `output-engine` | **E**, in-process: `output-engine` becomes a library of the engine, so **DMX never crosses a process** | E1 |
| ENTTEC USB-DMX | main | **E** (same writer threads) | E1 |
| Light fixtures (role values → DMX), lighting takes, phase spread, precedence | renderer TS | evaluation **E** (time-continuous, see §4), authoring **U**, model **H** | E3 |
| Projector outputs: corner-pin, Bézier warp, soft-edge blend, gamma (`ProjectorGL` 352 lines) | one Electron window per display, fed by the bitmap pump | **E native fullscreen window per display**, one swapchain each, presenting at that display's refresh. Bitmap pump deleted | E1 |
| Calibrated projector render (`ProjectorScene`, `projectorDepth`, `projectedMapping`) | per-window three.js scene | **E**: the *same* scene as the 3D view, rendered from the projector's camera. The duplicate scene render disappears | E4 |
| NVAPI warp/blend (`nvwarp`) | main | **E** | E4 |
| Projector auto-calibration (OpenCV `calib`) | main + `plugins/calibration` | compute stays native; camera frames come from **E**; wizards stay **U** | E4 |
| Bake (offline render → MP4 + AAC) | renderer drives sources frame by frame | **E**: render non-realtime, encode with Media Foundation / AVFoundation hardware encoders | E6 |

### Views

| Feature | Today | New home | Phase |
|---|---|---|---|
| **3D scene** (`Simulator3D`, 7.3k lines of r3f): venue GLB, content planes, instanced LEDs, fixture bodies, movers, beams, frustums, grid, labels | r3f on its own WebGPU device | **E**: one scene, any number of cameras. Shown in the editor via `sharedTexture`, or as a **native window** on another screen at full refresh. **Moving it rebuilds nothing.** Picking via a GPU id buffer (body before LEDs, the `pickPriority` rule, reimplemented once); gizmo drawn by the engine, pointer events forwarded from **U**. See §5 | E4 |
| 2D Stage | DOM overlays + blitted engine canvas | picture **E** (shared texture), fixture handles / rects stay **U** DOM over it | E4 |
| Output previews, preview panel, thumbnails, filmstrips | renderer canvases | **E** renders them (thumbnails as small images back to **U**) | E2–E4 |
| DMX monitor, metrics panel, sparklines | 2D canvas | **U** (UI drawing, not show pixels) | — |

### Audio, control, show logic, everything else

| Feature | New home | Note |
|---|---|---|
| Audio engine (JUCE: bed, scene sound, ambisonics + HRTF, inserts, automation) | **E process** (linked C++) | the engine clock and the audio clock become **one clock**. That ends the "two clocks" problem in `docs/AUDIO.md` at the root |
| Timeline NLE (editing), state machine graph, cue grid, inspectors, node editor, docking shell, help, shortcuts, wizards, preferences | **U** | unchanged React. Reads the document through the store instead of `App` props |
| State machine, scenes, cues, `cueBus`, trigger zones, global rules, scheduler, playlist | **H** | discrete, event-rate logic; sends the engine *what is active* |
| OSC in/out, OSC tracks, LiDAR protocol, Augmenta, show-control HTTP + SSE + tablet PWA | **H** (main today) | unchanged code, new host process |
| Persistence, portable projects, assets, project import, fixture library (OFL/GDTF), undo/redo | **H** | the document store's natural home. **No project-file migration** (CLAUDE.md doctrine: persisted types do not change) |
| Watchdog, machine logging, Prometheus metrics, boot report/splash, launcher contracts | main + **H**, engine reports in | the watchdog gains an engine-restart rung |
| Headless / `--broadcast` | **H + E, no UI process at all** | the show runs with no web page in the loop: the end state engine-decoupling approximated |

### Plugins

The plugin architecture survives, but its **render-side contributions change**. `contentSourceRegistry`
drawables, `VideoCodec`, projector `renderSource(gl: WebGLRenderingContext)` and scene-viz are
WebGL/canvas-typed today, and they become **engine-side Rust modules + data contributions in TS**.
The SDK is internal and unstable by policy (no third-party loading), so this is an internal break,
not a public one. The shader plugin becomes the generic GPU extension point (WGSL).

## 3. The engine inside

- **Threads:** a render thread (one queue submit per tick); decode threads per source; the output
  pacer thread (today's `output-engine`); the audio thread (JUCE); an IPC thread. JS is nowhere on
  this path.
- **The render graph** is built from the document (surfaces, layers, masks, effects, fixtures,
  outputs, views) and rebuilt only on edits. Each tick evaluates time-varying parameters, runs only
  the passes whose inputs changed, then samples LEDs and presents every view.
- **Change-driven ticks** (the superseded plan's §5b, now native): every source has a generation
  counter; no new frame, no animation, no edit → no GPU work. The wire still repeats the last frame
  at its rate.
- **Per-display presentation, no cap:** each window has its own swapchain and presents the newest
  frame at **its display's refresh** (DXGI flip model + waitable swapchain on Windows;
  `CAMetalLayer` + display link on macOS, ProMotion-aware). The engine ticks at the fastest refresh
  any visible output needs, so a 144 Hz projector gets 144 and a 60 Hz one is not slowed by it.
- **LED readback:** one async buffer map per tick into the packer. No IPC, no `Float32Array` rebuild,
  and the 3D view reads the **same GPU buffer** for LED colours (the win webgpu-unified-device could
  not reach).
- **Zero-copy imports:** wgpu's `create_texture_from_hal` wraps a native D3D12 / Metal texture.
  Third-party crates already use it for D3D11 shared handles and IOSurfaces (`vtsampler`,
  `wgpu-native-texture-interop`), but **it is not an official stable wgpu API**, so pin the wgpu
  version and keep a CPU-upload fallback per source.

## 4. The clock — where time is evaluated

Today the timeline, automation, keyframes and lighting playback are evaluated in TypeScript at frame
time. Splitting processes forces a choice:

- **E1–E2: the host evaluates, the engine draws.** The Show Host evaluates at tick time and sends a
  small per-tick parameter block (playhead, layer opacities, automation values; kilobytes). It costs
  one frame of latency and keeps every evaluator in TS. It is good enough to ship the output path.
- **E3: the engine evaluates anything time-continuous.** Playhead → clip/frame mapping, automation
  curves, keyframe easing (`components/timeline/ease.ts`), lighting takes and phase spread are ported
  to Rust and run at the engine's tick, on the **audio clock**. That gives frame-exact media and
  sample-locked picture and sound. The host keeps discrete logic only (state transitions, cues, OSC,
  rules) and sends events. A parity harness compares TS and Rust evaluators on recorded shows before
  the TS path is deleted.

## 5. Multi-screen, concretely

- **UI panels:** with the document in the Show Host, *any* dock panel can open in its own
  `BrowserWindow`, i.e. its own process and thread. Timeline on screen 2, inspector on screen 3. A
  heavy edit in one window no longer stutters another. The dock tree stores detached windows per
  machine, re-attaches when a display is missing, and never opens off-screen (the superseded plan's
  §2 and §7 regressions list still apply).
- **Views (3D, stage, output previews):** an engine camera with a presentation target. Two targets:
  - *embedded* in a UI window: a `sharedTexture` frame on a `<canvas>`, with React overlays on top.
    That adds one to two frames of latency to editor views only, never to outputs;
  - *native window*: an engine window on any screen, fullscreen or not, at that screen's full
    refresh with no webview latency. The right choice for "3D view on the big screen", a previs
    monitor, or a multiview of all outputs.
  Switching between them, or adding a second camera of the same scene, **costs nothing**: the scene
  and its textures are shared on one device.
- **Projector outputs:** engine windows, as today in concept, but presenting directly instead of
  being fed copied frames.

## 6. Windows, macOS and Linux — all three are first-class (owner, 2026-11-20)

**Linux is in scope.** ArtLux is built and distributed by CI on all three OSes
(`.github/workflows/build.yml`: `windows-latest`, `macos-latest`, `ubuntu-latest` → NSIS, DMG,
x86_64 AppImage), so the engine is too, from its first commit.

| | Windows | macOS | Linux |
|---|---|---|---|
| GPU backend | D3D12 (Vulkan as an alternative) | Metal | **Vulkan** (Mesa ANV / RADV, NVIDIA proprietary) |
| Hardware decode | Media Foundation D3D11VA → shared to D3D12 (nv12 handles carry a keyed mutex; Electron's typings note the same) | VideoToolbox → `CVPixelBuffer` IOSurface → Metal | **VA-API** → dmabuf → Vulkan (`VK_EXT_external_memory_dma_buf` + DRM format modifiers); NVIDIA via NVDEC. CPU decode as the fallback |
| Texture input | Spout (D3D11 shared handle) | Syphon (IOSurface) | none standard. NDI covers network video; a PipeWire video source is a later option, not in scope |
| Camera | Media Foundation | AVFoundation | V4L2 |
| NDI | committed prebuilt today | built in CI | the NDI Linux SDK fetched in CI (check the runtime's redistribution terms before shipping it) |
| Views in UI | `sharedTexture` NT handle. It is *process-local*, so the engine duplicates it into Electron main (`DuplicateHandle`) | IOSurface is process-local too; transfer via a mach port (`IOSurfaceCreateMachPort`). Needs a small native helper in main | `sharedTexture` takes **dmabuf planes** (in the typings); the engine exports its view images as dmabuf fds, passed over a Unix socket (`SCM_RIGHTS`) |
| Windows | engine owns its main thread: winit | same; AppKit's main-thread rule is why the engine is its own binary | winit on X11 and Wayland |
| Fullscreen outputs | borderless on the display, flip-model swapchain | borderless window at the display frame; avoid native fullscreen Spaces | Wayland: `set_fullscreen(output)` per projector (supported); X11: borderless at the output's geometry |
| Placing UI windows | exact position per display | exact | ⚠ **Wayland does not let an app position its windows**, so "restore the timeline on screen 2" cannot be exact there. Either run Electron under XWayland (`--ozone-platform=x11`) for exact placement, or accept fullscreen-on-output plus compositor placement. E0 decides |
| Refresh | 60 / 144 / 165 mixed, per-window present | ProMotion 120 + 60, display link per window | per-output present (Wayland presentation-time; X11 per-window vsync is weaker) |
| Audio | JUCE (WASAPI / ASIO) | JUCE (CoreAudio) | JUCE (ALSA; already built strictly in CI) |
| Packaging | engine `.exe` in `extraResources` | engine inside the `.app` bundle, ad-hoc signed like the rest (unsigned decision stands) | engine binary inside the AppImage; x86_64 only, as today |

**The venue GPU policy simplifies, and improves most on Linux.** "WebGPU required" becomes "D3D12,
Metal or Vulkan required". Today Chromium's WebGPU on Linux is default-on only for Intel Gen12+ and
NVIDIA on Wayland; **AMD iGPUs land on the wrong-pixels WebGL fallback**. Native Vulkan works on
Intel, AMD and NVIDIA alike, so the engine removes that inversion. The floor is a Vulkan 1.2 driver:
Kepler/Fermi, pre-Gen8 Intel and the Raspberry Pi (ARM, plus no AppImage) stay out. The
lavapipe/software-adapter trap becomes a hard check in the engine from adapter info: a software
adapter refuses to start a show unless it is explicitly allowed (CI only, below).

### 6b. CI — the engine builds, tests and ships on all three runners

The engine joins `build.yml`, under the same rules as the existing native crates (built strictly,
staged into `extraResources`, `fail-fast: false` across the matrix):

1. **A Cargo workspace** at `engine/`, so one `cargo build --release -p artlux-engine` per runner,
   cached like today's cargo cache key.
2. **Linux runner packages:** `libvulkan-dev`, `libva-dev`, `libxkbcommon-dev`, `libwayland-dev`,
   plus the ALSA / X11 / `libudev-dev` set already installed for JUCE; `mesa-vulkan-drivers` for the
   test step.
3. **A headless correctness test on every runner, without a GPU.** GitHub runners have no real GPU,
   so the engine runs on the software adapter that exists on each: **lavapipe** (Linux), **WARP**
   (Windows D3D12), and the macOS runner's Metal device (**verify in E0** whether the hosted arm64
   runners expose a usable Metal device; if not, the macOS job builds only). The test renders fixture
   projects offscreen and **byte-compares the Art-Net / sACN output and output-window frames against
   committed goldens**. That is the same parity harness that gates every migration step (§8 risk 2),
   so a regression on any OS fails CI. Performance is never judged on CI; that stays on the RTX PC
   and a real Mac.
4. **Packaging:** electron-builder `extraResources` gains the engine binary per platform; the
   AppImage, DMG and NSIS jobs fail if it is missing (the same strictness the audio engine has, and
   for the same reason: a graceful-degrade that ships silently broken).
5. **Launcher contracts** (`docs/LAUNCHER.md`): the launcher must know about one more binary to
   install, update and verify. That is a launcher release, sequenced with E1.
6. **Release assets** keep their fixed names (the release-hygiene rule), and no new download appears:
   the engine ships inside each existing package.

## 7. What breaks

- **`App.tsx` stops owning state** (E5). This is the largest refactor in the UI: every mutation
  becomes a store action. It is mechanical but wide, and it is what makes separate UI windows
  possible.
- **The plugin SDK's render contributions** (§2 Plugins), across first-party plugins: hap, mp4, ndi,
  spout, syphon, text, shader, lidar-tracking, augmenta, mediapipe, calibration, bake.
- **Invariants that become meaningless** are retired with the code they guard (Stage persistence,
  one 3D canvas, the `frameEngine` rAF rules, the WebGPU listeners). New ones replace them: no pixel
  work in TS, DMX never crosses a process, every engine window reveals without depending on
  `ready-to-show`.
- **No project-file migration**: the persisted types do not change.

## 8. Risks

1. **Scope.** This ports the 3D view, the timeline composite and every decoder to Rust. Mitigation:
   every phase ships, and the browser engine stays as a per-surface fallback (the native-core
   "eligibility" rule, badged in the UI) until E6 deletes it.
2. **Pixel parity during migration.** Two engines must agree. A wire-capture harness (extending
   `scripts/test-engine-output.cjs`) diffs Art-Net bytes from both engines on recorded projects; any
   difference blocks a source from flipping.
3. **`sharedTexture` is experimental**, and the macOS cross-process IOSurface path needs a helper.
   Fallback: engine-owned child windows over the UI slot (popovers cannot cover them, so overlay
   menus near a view would be drawn by the engine or open beside it). E0 spikes both.
4. **wgpu interop APIs are unstable.** Pin the version; a CPU-upload path per source exists from day one.
5. **Crash isolation cuts both ways.** An engine crash must not lose the document (it lives in the
   host) and must restart within a second. The watchdog's new rung is tested in E1.

## 9. Phases — each one ships

| Phase | Delivers | Deletes | Size |
|---|---|---|---|
| **E0 Spikes** | Feasibility prototypes (throwaway), **on Windows, macOS and Linux (X11 + Wayland)**: engine binary presenting on 3 displays at their own refresh rates; engine → `sharedTexture` → page latency (NT handle dup, IOSurface mach port, dmabuf over `SCM_RIGHTS`); zero-copy import of Spout, Syphon, HAP BC, MF, VideoToolbox and VA-API frames; the engine skeleton building and passing its headless test on all three CI runners (§6b) | — | 3–4 wk |
| **E1 Output path** | Engine process + watchdog rung; LED sampling + Art-Net/sACN/USB-DMX in-engine; sources image, HAP, NDI, Spout, Syphon, DMX-in, effect, slice; native projector windows (warp/blend, uncalibrated). Fed by today's `App` through main. Per-surface fallback to the browser engine | bitmap pump + web projector windows for eligible outputs | 2–3 mo |
| **E2 Decode + generative** | MP4 HW decode, camera, text, shaders (WGSL), tracking blobs, mediapipe via shared frames, thumbnails | WebCodecs path, renderer `<video>` pools | 2–3 mo |
| **E3 Timeline + clock** | Timeline composite and blend modes in-engine; time evaluation in Rust on the audio clock; JUCE in the engine process; lighting evaluation | `services/timeline.ts` composite, canvas blends | 2–3 mo |
| **E4 Views** | 3D scene in the engine (glTF, instanced LEDs, beams, bodies, frustums, picking, gizmo); stage preview; calibrated projector render; nvwarp; views embedded or as native windows | r3f `Simulator3D`, `ProjectorScene`, second GPU device | 3–4 mo |
| **E5 State lift + multi-window UI — FIRST (owner, 2026-11-20)** | Document store in the Show Host; `App.tsx` becomes a client; any panel in its own window with no performance drop. Detail in §9a | `App` state ownership | **4–5 mo** (re-estimated in §9a) |
| **E6 Finish** | Bake via the engine; SDK v2 for render contributions; delete the browser engine and the WebGL fallback | `frameEngine.ts`, `WebGPUMapper.ts`, `GPUMapper.ts` | ~1 mo |

**Order (decided 2026-11-20): E5 first** (§9a), then E0's engine spikes and E1–E4. Total stays 12–18 months; the multi-window goal lands at about
month 4.

## 9a. Phase E5 first, in detail — any panel in its own window, with no drop in performance

**Owner's decision (2026-11-20): separate windows for any panel is the goal, and performance must not
drop.** E5 is therefore the first phase. The engine phases (E1–E4) follow and add performance on top.

### The one rule that makes "no drop" possible

**Every piece of data has exactly one producer, and windows receive results, never redo work.**
A detached window that decoded its own thumbnails, ran its own timeline playback or built its own 3D
scene would duplicate GPU and decode work, and *that* is where performance would drop. So E5 sorts
everything a panel touches into five classes, each with its own channel:

| Class | Examples | Producer (E5) | Channel to a window | Rate |
|---|---|---|---|---|
| **1. Document**: persisted, undoable | fixtures, surfaces, controllers, scenes, cues, timeline clips, state machine, settings | **Show Host** (authority) | action → host → patch (with a revision number) to every window's replica | human edits |
| **2. Session state**: shared, not persisted, not undoable | selection, transport (playing, rate), active state, recording flags, solo/mute, open project path | Show Host | same store, separate slice | human / event rate |
| **3. Live streams** | meters, audio levels, DMX monitor, LED preview colours, tracking blobs, perf metrics, a slider being dragged | the **engine owner** (the editor renderer until E1, the engine after) | **direct `MessagePort` pair** window ↔ engine owner (the projector-bridge pattern, no host hop), **pull-based**: flows only while a visible panel subscribes, at that window's refresh, transferable buffers | display rate, only when watched |
| **4. Clock** | playhead, show clock, time codes | engine owner | **not streamed**: an *anchor* (position, rate, wall time) sent on every change; each window extrapolates from the shared wall clock. Zero per-frame traffic, sub-frame agreement | on change |
| **5. Panel pixels** | thumbnails, filmstrips, audio peaks, clip previews | produced **once** by the engine owner (peaks in main), cached by content key | `ImageBitmap` over the same `MessagePort` (already proven by the projector pump) | on demand, cached |

Two consequences, both guarded by `verify:invariants`:
- **Runtime services run once.** Timeline playback and its `<video>` pools, the state machine
  runtime, `cueBus`, take and lighting recorders, OSC and audio exist only in the engine owner / host.
  A panel window gets a **proxy** (commands out, class-2/4 state in). Check: the unique-marker count
  for each service is 1 across all bundles, like the plugin single-identity check.
- **No decode in a panel window.** This also protects the hardware decode session limit and the
  "one decode" invariant that five files call load-bearing.

### Why it should be *faster*, not just equal

Today all state sits at the root of `App.tsx` and nothing is memoised, so any change re-renders the
whole tree (recorded in the perf notes; it is why sliders commit on release). The store replaces
"`App` passes everything down" with **selector subscriptions** (`useSyncExternalStore`), so a panel
re-renders only when *its* slice changes. Moving a fixture stops re-rendering the timeline. That is the
first gain of E5, before any window is detached.

### What each kind of panel needs

| Panel kind | Examples | Detached window |
|---|---|---|
| **DOM panels** | timeline NLE, inspectors, cue grid, state graph, node editor, browsers, fixture library, help, preferences, show metrics | its own `BrowserWindow`, so its own process and its own main thread. A heavy edit there cannot stutter the editor, and vice versa |
| **Panels with live data** | DMX monitor, perf panel, audio lanes / meters, colour rows, blob sparklines | the same, plus a class-3 stream subscription |
| **GPU viewports** | 3D scene, 2D Stage, preview panel, output previews, calibration camera | **Stay docked in the editor window until E4 (owner, 2026-11-20).** Another process would duplicate the scene and every texture upload, a performance drop, and a same-process window would still rebuild them on every move. From E4 they are engine views: any screen, any number, nothing rebuilt |

Detaching a viewport tab is simply not offered before E4; its tab menu says why.

### Work packages

> **Progress (branch `feat/e5-store`):** ✅ **W1 done 2026-11-20.** `shared/docStore.ts` (core, imports
> nothing) + `src/renderer/state/docStore.ts` hold the whole project document (20 slices: the 10
> undoable + 10 persisted-only) and a separate `sessionStore` (selection, active scene, transport). App
> keeps its local names, so no call site changed; undo is still App's `useHistory` (it moves with the
> authority in W3). Guarded by verify:invariants. Real-app harnesses green: engine-output, copy-paste,
> scene-timelines 10/10, hold-at-end 13/13, zone-fsm 9/9, lighting-take, show-control,
> project-import-live, and **undo/redo** (`scripts/test-undo.cjs`, 18/18, mutation-tested: fixture
> delete, a selection click is not history, a timeline clip, a scene + machine state in one step).
>
> ✅ **W2 (registry panels) done 2026-11-20.** `useEditorPick(...)` (EditorData published to a small
> external store) + the `PanelBody` memo boundary around every registry panel; all 39 panel reads
> migrated; lidar ZonePanel now subscribes to zones (the one render-time read the audit found).
> `scripts/test-panel-renders.cjs`, one fixture edit: unrelated panels **2 renders → 0**, fixtures panel
> 2 → 1. Guarded by verify:invariants.
>
> ✅ **W2 (persistent viewports) done 2026-11-20 — W2 complete.** `Timeline` and `Simulator3D` are
> React.memo'd; App hands them handlers through `useStableHandlers` and derived lists (`cues`, the
> author bundle, calibration picks) through `useMemo`. Step 2 of `test-panel-renders.cjs` (a master
> brightness edit, App state neither viewport reads): timeline **3 → 0** renders, 3D view **1 → 0**.
> It also found a second cause on the timeline. The automation-target poll used each target's `def`,
> which is the parameter's *current value*, in its change signature, so any value edit anywhere
> re-rendered the whole timeline within the second. `def` is out of the signature now, and a keyless
> lane reads its value live from the provider. Guarded by verify:invariants (mutation-tested).
>
> ✅ **W3a (Show Host + replication) done 2026-11-20.** `src/showhost/index.ts` is a `utilityProcess`
> (forked and restarted by `main/showHost.ts`) holding the authoritative `doc` and `session` stores;
> the editor is a full replica (`state/hostLink.ts`). Every App setter is unchanged: a write applies
> locally at once and reaches the host at most once per slice per task. The wire and its ordering
> rule (last writer wins, identically on both sides) are in `shared/showHostProtocol.ts`.
> `scripts/test-show-host.cjs` proves the following:
> - all 26 slices digest identically on both sides, before and after an edit;
> - 3 s of a running editor sent the document **0** times;
> - a host killed with `taskkill /F` is replaced about 500 ms later, an edit made during the outage
>   still lands, and the fresh host agrees.
>
> Guarded by verify:invariants (mutation-tested): the host imports only the store core and its wire.
>
> ✅ **W3b (undo in the host) done 2026-11-20.** The undo and redo stacks live in the Show Host. App's
> record, undo, redo and reset are host ops (`hostLink.historyOp`). Each op carries only the slices
> whose last-rendered value differs from the store, so "record captures the document as last
> rendered" is unchanged. `shared/shareEqual.ts` gives structural sharing on both sides:
> - the host folds every write into the previous value, so its 100-deep stack shares structure;
> - the replica merges restored slices, so items an undo did not touch keep their identity, as with
>   the old reference-based undo.
>
> `UNDOABLE_SLICES` names the undoable list once, and `DocSnapshot` is its type. App's `useHistory`
> remains only as the fallback for a window with no host. `ARTLUX_NO_SHOW_HOST=1` runs standalone on
> purpose.
>
> Proof:
> - `test-show-host` step 5: Ctrl+Z and Ctrl+Y are host ops, both sides agree, and the untouched
>   fixture keeps its object identity. A negative control without `shareEqual` fails it.
> - `test-undo` 18/18 on the host, and 18/18 again with `ARTLUX_NO_SHOW_HOST=1` (the fallback).
> - verify:invariants, mutation-tested with 7 mutations.
>
> ✅ **W3c done 2026-11-20 — W3 complete.** Following the owner's decisions ("autosave, and follow your
> recommendations"):
> - **Unsaved changes** are the host's answer: per-slice digests of `PROJECT_FILE_SLICES` against
>   the last baseline, so the 1 Hz stringify of the whole project left the UI thread. Every save
>   rebases both baselines (`markDocSaved`). `projectorFpsCap` and `projectorBrightness` moved into
>   the store; W1 had missed them.
> - **Autosave** is new. The host writes a recovery file per project in `<userData>/autosave`, never
>   over the `.artlux`. It writes every 30 s while unsaved, and at once when an editor page replaces
>   one that held unsaved work (a renderer crash). It never writes in show modes. The editor offers
>   the copy back when the project is next opened: Restore (one undoable step, the project stays
>   unsaved), Discard, or Not now. A save or "Close without saving" retires the copy. Usage:
>   `docs/user-guide/11` § Autosave.
> - **Building and loading the project file stay in the editor, by recommendation.** They're
>   entangled with the profile library, engine resets and normalizers, and a panel window only needs
>   "is it saved" and "save", which W5 can route to the editor through the host. The close guard
>   keeps asking the editor, which now reads the host's answer.
>
> Proof:
> - `test-show-host` steps 6 and 8: the dirty-flag states; an autosave in seconds with the file
>   untouched; a **renderer crash** (CDP `Page.crash`), after which recovery reloads the editor and it
>   offers the work back; Restore, one undo step, then save, which retires the copy.
> - Step 8 caught a real bug, now fixed: Restore answered before the first settling tick left the
>   host with no baseline.
> - Two verify:invariants checks, mutation-tested with 6 and 7 mutations.
> - Harness runs (`ARTLUX_CDP_PORT`) autosave to a temp folder.
>
> ✅ **W4 done 2026-11-20 (live channels).** The editor is the engine owner
> (`src/renderer/live/broker.ts`); a client window uses `live/client.ts`; main only pairs the two
> (`src/main/liveHub.ts`). The wire is `shared/liveProtocol.ts`. What was built:
> - **Stream broker, pull-based.** A sample is sent only to a subscription that is waiting. The client
>   pulls from its rAF, so traffic runs at its refresh and stops while it is hidden. Producer hooks
>   attach with the first subscriber and detach with the last. Core streams are `dmx.pixels` (the
>   canonical RGBW buffer, by byte range) and `perf`; plugins add theirs with `registerLiveStream`.
> - **Clock anchor.** Each clock carries its own rate, because a playing transport can park while the
>   show clock runs on. The anchor is stamped with the frame time, and re-sent only on more than 1 ms
>   of disagreement, or when the play state or a rate changes. A bake sends at most one anchor every
>   100 ms. `timeline.getFrameTimeMs()` was added for this.
> - **Thumbnails and peaks** are served from `thumbnailCache` and `audioPeaks` in the editor, as copies.
>   `hasExactThumb` and `peaksFailed` were added. Audio peaks stay in the renderer rather than main for
>   now; the owner can move later without changing the wire.
> - **Live drag.** The drag targets are `ledBrightness`, `fixtureChannel` and `projectorBrightness`
>   (the last one is App's, because it needs the projector ports). A client that main reports gone
>   has every drag it held abandoned back to the committed value.
>
> Proof:
> - `test-live-channel`, 7 claims, all green:
>   - DMX samples arrive at ~30/s, and **0 in 3 s** once the client stops pulling;
>   - **2 anchors over 2.5 s** of playback, with a 0.00 ms extrapolation error;
>   - 0 anchors at rest; seek and end-stop agree;
>   - a 160×90 thumbnail in 95 ms, and the cache intact after a second ask;
>   - 64-bucket peaks;
>   - drags applied, and abandoned on drop.
> - Negative control: with the pull gate and the anchor gate removed, the harness reports 91 samples
>   while held, and 155 anchors in 2.5 s.
> - Three verify:invariants checks, mutation-tested 17/17.
> - Regressions green: `test-show-host`, `test-engine-output`, `test-panel-renders`, `test-undo`.
> - Not proven yet: main's "client gone" notice from a real second window. The harness simulates the
>   notice, because its client is the editor itself; W5's panel windows exercise the real path.
>
> ✅ **W5a done 2026-11-21 (a panel in its own window).** What was built:
> - **`panel.html` + `renderer/panel.tsx`** mount one panel from `contexts/detachable.tsx`. That is the
>   single list of detachable panels; the editor registers the same entries.
> - **The import graph decides what may detach.** `verify:invariants` bundles `panel.tsx` with esbuild
>   and fails if the graph reaches the transport, the frame engine, a runtime service, GPU code, the 3D
>   view, three.js, the peaks decoder, the live broker, App, plugin activation or a plugin. Of the
>   seven core panel files, only `contexts/panels/browser.tsx` is clean today, so four panels detach:
>   Surfaces, Fixtures, Groups and Global Params.
> - **Document:** a read-only Show Host replica (`hostLink` role `'panel'`). It sends nothing; the host
>   sends it the whole document, then `historyState` to mark the end of the snapshot, and refuses a raw
>   `set` from it. The panel renders only after that mark, so it never shows the built-in defaults.
> - **Everything else App holds** comes as the `editor.extras` live stream: resolved fixture profiles,
>   settings, displays, model sizes, the scene-saved flag, the project path and the selection's fixture
>   kinds. The bound timeline, selection and project references are derived from the replica, the way
>   App derives them.
> - **Edits** are editor actions run in the editor (a live-channel `action` message), with arguments
>   that can't be cloned (a click event) dropped. The render-free drags became actions
>   (`pushMasterBrightness`) so that a window drives the editor's channel.
> - **Windows:** `main/panelWindows.ts` keeps positions per machine in the prefs and matches the screen
>   by id, then by label and size. Every placement is clamped on-screen. Windows close on the editor's
>   `closed` and reopen with it, and only in the editor (never headless or broadcast). Bounds are
>   tracked as they change, because a page-closed window never emits `close` (found by the harness).
> - **Ways in:** an "Open in new window" button in a detachable panel's section header (stacked
>   sections have no tabs), and the dock tab menu. The menu shows a disabled entry, with the reason,
>   for viewports and other panels. The docked copy stays.
> - **Usage docs:** `user-guide/01` § A panel in its own window.
>
> Proof:
> - `test-panel-window`, 7 claims, all green, and the first real-window proof of W4's "client gone"
>   path:
>   - the project is shown, not the defaults;
>   - none of the producer fingerprints are present, with the editor as the control;
>   - nothing is sent from the replica;
>   - Add Fixture in the window adds the fixture in the editor, and the replicas agree;
>   - selection works both ways;
>   - a live LED-brightness drag commits on release;
>   - **a window crashed mid-drag** has its drag released by the editor;
>   - on a second launch both windows reopen with the editor, one at its remembered bounds and one
>     that was remembered off-screen pulled back onto a screen.
> - The **packaged** build: `panel.html` loads from the asar, shows the project, an edit reaches the
>   editor, and no producer is present.
> - Three checks, mutation-tested 18/18.
> - Regressions green: live-channel, show-host, panel-renders, undo, engine-output.
>
> ✅ **W5b-1 done 2026-11-21 (parameter sections, keys, no-host).**
> - **The parameter sections detach.** The surface Transform section and all nine fixture sections in
>   `inspector.tsx` (DMX Profile, Channels, Patch, Mapping, Segments, 2D / Output, Routing, 3D Layout,
>   Position). The taint was one panel: surface **Content** (`ContentEditor` → `CameraSettings` →
>   `contentSource`, plus the plugin content-source registry). It moved to `panels/surfaceContent.tsx`
>   and stays docked until plugins activate in panel windows.
> - **Fader and arm paths are editor actions.** The channel strip's live layer and the auto-key arm
>   became `pushFixtureChannels`, `releaseFixtureChannels`, `setAutoKeyArmed` and the
>   `EditorData.autoKeyArmed` field. `livePreview` and `autoKey` are now **banned from the panel
>   graph**, so a detachable panel that called them directly (and drove its own idle copy) fails
>   verify, with the module named.
> - **A section that doesn't apply** to the selection says what to select.
> - **Keys:** a panel window has **no application menu** (`removeMenu`), so Ctrl+R can't reload it and
>   Ctrl+S has one owner. It forwards Undo, Redo, Play / pause (the new `togglePlay` action, decided
>   against the editor's state) and Save to the editor's own actions, and honours rebindings.
> - **No Show Host:** after 8 s the window says it cannot show the project, and why.
> - **A real bug found by the harness:** App's `editorData` memo didn't list `autoKeyArmed`, so the arm
>   froze in the editor only (`test-auto-key` failed 3 claims). Fixed, and a new check requires every
>   `editorData` value in the memo's deps.
>
> Proof:
> - `test-panel-window` steps 8–9:
>   - a light's Channels fader in a window holds the channel live in the editor, then commits;
>   - auto-key armed from the window keys the editor's timeline;
>   - Ctrl+Z, Ctrl+Shift+Z, Space and Ctrl+S from the window, the save checked on disk;
>   - the "select a surface" message.
> - The `ARTLUX_NO_SHOW_HOST=1` mode shows the explanation.
> - Checks mutation-tested 11/11, plus 1/1 for the memo-deps check.
> - Regressions green: lighting-take, auto-key, panel-renders, undo, live-channel, show-host,
>   engine-output.
>
> ✅ **W5b-2 done 2026-11-21 (a window is a workbench; dock back; host restart).**
> - **A panel window is a dock tree of its own**, rendered by the editor's `DockRenderer` through three
>   opt-in hooks: `keepInapplicable`, `renderTabBody` and `onDockBack`.
>   - Windows open as tabs, because a stack has no "+" or tab menu. A tab body carries the panel's
>     header buttons and "Back to the editor".
>   - "+" adds any detachable panel, and the tab menu splits.
>   - The tree is saved per window anchor in the prefs (`panelWindowTrees`), and main tracks each
>     window's members. Asking for a panel that is already out focuses its window on that tab
>     (`PANEL_WINDOW_REVEAL`) instead of opening a second one.
> - **"Back to the editor"** is the `dockPanel` editor action (`services/dockBack.ts`). It adds the
>   panel to the active workbench, in the group of its kind, through `ensureTree`.
> - **Restarting host:** the editor sends `synced` after its handover. Until then the host queues a
>   joining panel instead of serving it a partial document.
> - **A real main-process freeze, found by the harness and fixed:**
>   - `webContents.postMessage` to a **crashed** page blocks main for good. A crashed panel page plus
>     a host restart froze CDP, IPC and every window.
>   - Reproduced with a control (`repro-hang`: crash → frozen, no crash → responsive).
>   - Fixed with `src/main/postToPage.ts`, which skips crashed and destroyed pages. It is now used
>     for every port main hands out (Show Host, live channel, engine port, projector bridge), and a
>     check forbids a raw page `postMessage` in `src/main`.
>
> Proof:
> - `test-panel-window` step 10:
>   - "+" adds a tab;
>   - an editor request for a panel that is already out focuses that window, opening nothing;
>   - "Split right";
>   - the tree is saved;
>   - "Back to the editor" lands the panel in Proj's tree and takes it out of the window.
> - Step 11:
>   - the host is killed with a panel window open;
>   - the panel reconnects, and never shows an empty or default document (sampled at 50 Hz);
>   - an edit afterwards lands, and the new host agrees on 28 slices.
> - Step 7: the reopened window comes back with its own tabs and split.
> - Checks mutation-tested 7/7.
>
> ✅ **W5c done 2026-11-21 (plugin UI halves; Content in its own window).**
> - **A plugin's UI half** is a second renderer entry, `@artlux/plugin-x/ui` (`src/ui.ts`, in the
>   package's `exports`). Its `RendererPluginUi.activateUi(ctx)` registers only what draws:
>   `ctx.contentSourceUi` (`ContentSourceUi { type, editor?, pickerButton? }`).
>   - `host/pluginUi.ts` is the one list (Augmenta, MediaPipe, LiDAR, NDI).
>   - The editor runs it first in `activateRendererPlugins`; a panel window runs only it.
>   - NDI discovery left the receiver (`ndiDiscovery.ts`), so its picker needs no receiver.
> - **Content detaches.** `ContentEditor` reads the UI registry, then the transitional `editor` on a
>   runtime provider. In a panel window, a plugin type with no UI half says it is set up in the editor
>   (Spout, Syphon, Text, Shader: each needs state that only the editor's runtime holds).
> - **Editor-only services through a seam.** The camera inspector asks `services/cameraAccess.ts`:
>   - in the editor, `contentSource` installs itself there;
>   - a panel window installs `live/cameraRemote.ts`, which uses a `camera.info` stream (polled only
>     while subscribed, announced only on change) and **owner calls**, a new broker facility
>     (`registerLiveCall('camera.list' | 'camera.retry' | 'camera.preview')`, named `<area>.<verb>`,
>     looked up before App's editor actions).
>   - The list is the editor's, because Chromium withholds device labels in a page that never
>     captured.
> - **Guard:**
>   - The panel graph lets the two pure catalogs (`gpu/effects`, `gpu/palettes`) in only while they
>     import nothing.
>   - Plugin code may enter only through `host/pluginUi.ts`, and only as a plugin's `ui.ts`. Never an
>     activation file, a barrel, or a module named for runtime work.
>   - A second check holds the single registration site, the editor's activation of the same list,
>     the `./ui` export and both camera installs.
>
> Proof:
> - `test-panel-window` step 12:
>   - picking NDI in the window sets the editor's surface, and the window draws NDI's own picker;
>   - Spout shows "set up in the editor window" there, while the editor still draws its picker;
>   - the camera inspector shows the editor's state;
>   - the device list matches the editor's;
>   - the window still has no producer fingerprints;
>   - closing it detaches the editor's camera poll.
>   - Caveat: on the dev PC the camera failed to open, so the state agreement was on `error`. A panel
>     answering for itself would have said "Opening the camera…".
> - Checks mutation-tested 12/12.
>
> ✅ **W5d done 2026-11-21 (every content source has a UI half; plugin live state).**
> - **`ctx.live`, both halves.** The runtime publishes what only it knows:
>   `PluginLiveOwner.stream / call`, registered on the editor's broker and inert in a projector
>   window. The UI half reads it: `PluginLiveView.subscribe / call / peek`, or the SDK's `useLiveValue`
>   hook.
>   - In the editor that is a **local** subscription to the same stream (`subscribeLiveLocal`, which
>     waits for a stream that is not registered yet, because effects run child-first). In a panel
>     window it is the live channel.
>   - The fragment has one code path. Names are `<plugin id>.<name>`, enforced per plugin.
> - **Spout and Syphon:** discovery left the receivers; `spout.status` / `syphon.status` carry the
>   receiver's verdict.
> - **Text:** constants moved to `textDefaults.ts`; `text.fontState` reports an imported face's load
>   state (`fontAssets` gained a change listener).
> - **Shader:** constants moved to `shaderDefaults.ts`; `shader.compile` (the editor's cached compile)
>   and `shader.gpu` (the GL context's name and ceiling, polled only while watched).
> - **A real bug, found by the harness:** panel windows had no `<FeedbackProvider>`, so the first
>   panel to call `useConfirm()` (the Shader settings) threw and the whole window fell to its error
>   boundary. Fixed, and guarded.
>
> Proof:
> - `test-panel-window` step 12 now checks:
>   - Spout's picker and the editor receiver's verdict;
>   - the Shader settings, showing **the editor's GPU name** (a window answering for itself says "no
>     name");
>   - the Text settings;
>   - no source falling back to "set up in the editor";
>   - plus the camera and NDI claims from W5c.
> - Checks mutation-tested 11/11.
>
> ✅ **W5e done 2026-11-21 (plugin dock panels: the four tracking monitors).**
> - **`ctx.panels` and `ctx.host` in the UI context.** `PluginUiHost` (settings, scene3D read/patch,
>   menuAction): the host's own services in the editor (`uiHostOf`), the replica plus editor-side writes
>   in a panel window (`live/uiHostRemote.ts` → `host.scene3DPatch` / `host.menuAction`). `panel.tsx`
>   resolves its panel from the registry after the UI halves register.
> - **Trigger Zones**: zones are project data through the UI host; occupancy, blobs and people are one
>   `lidar-tracking.zoneView` frame per editor frame (`zoneViewSource.ts`), subscribed only while the
>   map has a size.
> - **OSC / Augmenta monitors**: main sends OSC to the editor and to any window that taps it
>   (`IPC.OSC_TAP`, per listener, dropped with the window) — the window sees the wire itself.
> - **Pose Monitor**: `mediapipe.monitor` for the numbers; the camera picture is a same-window handle the
>   runtime hands its UI half, so a window says the picture is in the editor (no second capture).
> - **Two real bugs, found by the harness:** a panel window's `Body` gave dock panels no height (the zone
>   map drew at 0 tall), and a dock tab behind the front one kept the editor producing zone frames for
>   nobody (test-live-channel). Both fixed and guarded.
>
> Proof: `test-panel-window` step 13 (zones occupied and emptied live in a window, the window's tally
> equal to the editor's own docked map, a zone added in the window landing in the editor, the OSC and
> Augmenta monitors seeing UDP sent to the port, the Pose Monitor's status from the editor with no video
> element, each stream detaching on close); checks mutation-tested 17/17.
>
> ✅ **W5f done 2026-11-21 (the shader panels: Shader, Shader Nodes, Effects detach).**
> - The compile is a live CALL (`shader.check` → `{ok, log}`; the program stays on the editor's GL
>   context). Both panels' commits became async: the graph/text updates at once, the write waits for the
>   verdict, uses the surface as it is then, and an older verdict never lands after a newer one.
> - The libraries are the editor's one store, streamed (`shader.library`, `shader.subpatches`); a save
>   names the SURFACE (`shader.librarySave`) and the editor reads its content and live parameter values,
>   so the thumbnail is rendered on the editor's GPU. Pure parts split out: `libraryTypes.ts`,
>   `shaderInputs.ts` (the Content editor had been importing `shaderParams.ts`, which holds the live
>   overrides — found by the new by-path ban, harmless today, banned now).
> - New check: every live name a UI half asks for is one its runtime publishes.
>
> Proof: `test-panel-window` step 14 (a broken shader typed in a window shows the editor GL context's
> error and writes nothing; a good one is written; a help patch opened in Shader Nodes compiles and
> lands; Effects saves with a PNG thumbnail, lists it and deletes it by its exact name; the window's
> subscriptions go with it); checks mutation-tested 11/11.
>
> ✅ **W5g done 2026-11-21 (the monitors: Timing, DMX Monitor, Performance detach).**
> - Seams, the camera's pattern: `services/dmxFeed` and `services/editorHealth`. The editor installs the
>   services (`live/editorAccess.ts`, from installCoreLiveStreams): the docked DMX Monitor still reads
>   the bus with zero copies. A window installs one shared subscription per kind: `dmx.pixels`, the new
>   `dmx.universes` (a light's channel table), `perf` (now with the editor's UI thread), the clock anchor
>   (extrapolated), the new `sm.state` (sent on a change of state or of the displayed second).
> - `MonitorDock` / `PerfDock` moved to `panels/monitors.tsx`: `adapters.tsx` carries the media library
>   and the state graph, whose graph reaches the transport (the guard said so the first time).
> - `dmxSignal`, `perfMonitor`, `uiPerfMonitor` banned from the panel window by path.
>
> Proof: `test-panel-window` step 15 (strips lit from the editor's output; the Wash's channel table
> shows the byte its document value makes; Performance at the editor's fps; Timing following the
> editor's show clock while playing and holding when stopped; each stream detaching); checks
> mutation-tested 11/11.
>
> ✅ **W5h done 2026-11-21 (the patching docks + the 3D scene's side panels detach — nine panels).**
> - Routing, the fixture Library and Wiring & Ledmap: clean once out of `adapters.tsx` (own files).
> - Objects, the 3D Fixtures list, Model, Arrange, Lighting, Tracking (`scene3d.tsx`): the 3D view's
>   part through seams — `services/modelScreenNames` (store moved out of Simulator3D; a window mirrors
>   `scene3d.screens`, clicks go back as `scene3d.focusScreen`) and `services/viewerView`
>   (`scene3d.captureView`). `PROGRAM_LAYER_ID` and `DEFAULT_BIAS_M` moved to pure modules.
>
> Proof: `test-panel-window` step 16 (a controller added in a window's Routing lands in the editor; the
> Library lists main's profiles; Wiring follows the editor's selection; a Lighting toggle writes the
> editor's scene; the viewer camera asked from a window is the editor's 4×4); checks mutation-tested 10/10.
>
> ✅ **W5i done 2026-11-21 (the Show Machine — the state graph, a non-GPU viewport — detaches).**
> - `services/showMachineLive` (current state, fired edges, Ctrl+click / double-click), the OSC learn
>   armed in the editor (`osc.learn`), the senders from the editor's settings, the control prefix by one
>   rule (`services/oscPrefix`), and the editor's timeline drawer (`services/editorShell`).
> - Found by bundling the panel alone: the graph imported the transport directly, besides the OSC
>   controller the first probe showed.
>
> Proof: `test-panel-window` step 17 (a state added in the window lands in the editor; a double-click
> there enters it in the editor's machine and the window's ring is the editor's; an OSC learn armed from
> the window is answered by a UDP packet at the editor, and disarmed on release); checks
> mutation-tested 10/10.
>
> ✅ **W5j done 2026-11-21 (the takes docks and the Media Library detach).**
> - Seams `services/takesAccess` (the recorder: `takes.state`, `takes.*`), `services/takeDensity`
>   (`takes.density` — BlobSparkline no longer imports the LiDAR barrel), `services/thumbView` (W4's
>   thumbnail service). `mediaCache` is pure URL helpers now: let in by an "imports only the URL table"
>   rule rather than banned by name.
> - **Two bugs found, both fixed and guarded:**
>   - a panel window's `layoutStore` would have written the DEFAULT layout over the editor's saved
>     workbench at its first `set()` (the Media Library's view toggle) — persistence is off in a window;
>   - **the first tracking take on the global timeline was lost, docked as well**: `stopTracking` commits
>     the take to the library, then a lane to the bound document — the same document when no scene is
>     bound — and the lane commit read it from a render ref, from before the take. App's take host reads
>     the store. (Pre-existing; for the release notes.)
> - Four browser panels were registered twice (warned in the console); removed.
>
> Proof: `test-panel-window` step 18 (Record in a window starts the editor's recorder and its clock runs
> there; the first take lands with its lane; its sparkline is drawn; a media view toggle leaves the prefs'
> layout byte-identical; no panel is registered twice); checks mutation-tested 10/10 + 2/2;
> `test-lighting-take` green.
>
> ✅ **W5k done 2026-11-21 (Preferences detaches; every plugin Preferences section is a UI half's).**
> - UI context gains `ctx.settings` and `ctx.ipc`. New UI halves: Audio, MP4, Show Control. Sections
>   moved from runtimes to UI halves: Audio, Augmenta, MediaPipe (its camera list asked of the editor,
>   `mediapipe.cameras`), MP4 (Video), Shader (constants to `shaderDefaults`), Show Control (DEFAULTS to
>   `showControlDefaults`, IPC via `uiLink`). Calibration's Recalibration stays a runtime (authoring)
>   section; a window names what it lacks from `prefs.sections`.
> - The editor window's own settings (Dockable workspace, named Workspaces, 3D quality) are `EditorOnly`:
>   disabled in a window, with the pointer.
> - Checks: a plugin with a UI half may not register a section from its runtime; every UI half is in the
>   list (mutation-found: a half left out vanishes from every window, the editor too); the UI-half
>   regexes did not match a digit in a plugin name (`mp4` was skipped by every UI-half check).
>
> Proof: `test-panel-window` step 19 (all six plugin sections in a window; an app setting changed there
> is the editor's and is saved; the three editor-window blocks disabled with the pointer; Show Control's
> section reaches main); checks mutation-tested 11/11 + 1.
>
> ✅ **W5l done 2026-11-21 (a tab dragged between windows).** The source captures the pointer and, once
> outside, reports to main; main reads the real cursor, picks the window under it TOPMOST FIRST (focus
> order — the first version tried windows in creation order and dropped into a window beneath the one
> on screen), converts with that window's zoom factor and asks it to take the panel; the source lets go
> on yes. **A bug found, older than this step:** a panel window never closed when its LAST tab went (its
> close button, Back to the editor, or a drag) — `closePanel` keeps a tree's last panel — fixed in the
> window's commit.
>
> Proof: `test-panel-window` step 20 moves the REAL cursor (Windows) and drives the drag by CDP: window
> → editor (lands, the window closes), editor → window (lands, the editor lets go, then back), a
> non-detachable tab dragged out goes nowhere; checks mutation-tested 6/6. Two full runs green.
>
> **W5 is done** except what was always out of scope: `preview` (program monitor, output previews) are
> GPU viewports, docked until the engine. **Before E5 can be called shipped:** verify panel windows in the
> PACKAGED `ArtLux.exe` (a window that must appear is not verifiable in dev — CLAUDE.md), on the RTX venue
> machine, and on macOS / Linux (CI builds them; nothing here has run there).
>
> ✅ **Packaged check done 2026-11-22 (Windows, dev PC).** `npm run package:dir`, then `ArtLux.exe` launched
> with NO CDP port and four panel windows on the reopen list (Surfaces, DMX Monitor, Trigger Zones,
> Preferences): all four came up visible with the editor, titled after their panel, and drew their
> content — read from the real screen (Win32: each window raised, copied from the desktop), not from a
> page. Three launches, two of them a fresh exe's first. Once, on the very first launch, Preferences was
> still black 13 s in; it did not happen again in two later runs (one a fresh exe's first launch) and is
> noted, not explained. **Found by eye: panels did not fit a narrow window** (Trigger Zones printed its
> header over its zone list at the window's default 380 px). The owner asked for responsive panels, so:
> `scripts/test-panel-narrow.cjs` opens EVERY detachable panel in a window at 380 and 280 px and flags a
> leaf that spills past what clips it or text printed over text. It found the Show Machine (graph ~90 px
> wide, toolbar cut off), the OSC / Augmenta monitors (filter off the edge) and Routing (fields crushed to
> slivers). Fixed: a side column goes under below a width, toolbars wrap, data grids get a floor width and
> scroll. All 40 panels fit at both widths; a check holds the fixes (mutation-tested 7/7). Still open
> for "shipped": the RTX venue machine, and macOS / Linux.
>
> ⚠ **Intermittent, not explained:** one `test-panel-window` run of two failed step 7's first claim — the
> reopen list held fixtures + groups but NOT globals, the window step 6 deliberately CRASHES. The rerun
> passed 104/104. Nothing in this change touches that path. Worth a look: can a crashed panel window fall
> off the reopen list (its 'closed' would run with `editorClosing` false)?
>
> ⚠ **Pre-existing, not E5:** `test-show-control` fails its quit checks once `out/renderer` is fresh.
> Its project leaves the active scene's look "not stored", so the editor-mode close guard waits on
> "Save before closing?" and the remote `/shutdown` never completes. It fails identically when built
> from `5e49680` (pre-E5); it used to pass only against a stale `out/renderer`. The harness, or the
> remote-shutdown policy, needs a decision on `main`.

| WP | What | Size |
|---|---|---|
| **W1 The store, in-process** | `shared/store`: the action vocabulary, Immer patches, revisions, undo moved into the store (today's snapshot undo is already document-wide, so it maps directly). Migrate `App.tsx` **slice by slice** (fixtures → surfaces → controllers → scenes/cues → timeline → state machine → lighting → settings → …), each slice shipped and verified alone. `App` stops owning state; it becomes the composition root | 5–7 wk |
| **W2 Selectors** | Panels move from `useEditor()` (the whole object) to `useStore(selector)` | 2 wk |
| **W3 Show Host** | Move store authority, undo, persistence, autosave and the close guard into an Electron `utilityProcess`. The editor renderer becomes a replica, and the frame engine reads that replica. Host-authoritative: an edit goes to the host and comes back as a patch (local IPC, well under a frame). **Optimistic local apply is added only if an edit visibly lags** | 2–3 wk |
| **W4 Live channels** | Stream broker (pull-based `MessagePort` pairs), the clock anchor, the thumbnail / filmstrip / peaks service, the live-drag channel (a detached slider drives `livePreview` in the engine owner directly) | 2–3 wk |
| **W5 Panel windows** | A new `panel.html` entry that mounts any registered panel by id. A window is **a dock tree of its own**, so it can hold several tabs and be split. Main gets a window manager: create, restore per machine, match displays by id then label + bounds, re-attach when a display is missing, never off-screen. Plugins get a **UI-only activation** (contribute panels without starting their runtime). Shortcuts: transport keys (Space, J/K/L) work in every window; undo routes to the host | 3–4 wk |
| **W7 Docs + invariants** | Usage page in `docs/WORKSPACE.md` (detach, re-attach, multi-screen), the new invariant checks (services run once, no decode in panel windows, no bare `App` state) | ongoing |

**Total: about 4 months** (more than the 2–3 months first estimated for E5 in §9: W1 alone touches
60 `useState`, 69 `useRef` and 81 `useEffect` in `App.tsx`, and 38 registered panels).

### The "no drop" guarantee — by construction, not by a measurement phase

**No measurement phase (owner, 2026-11-20).** There is no baseline step and no benchmark gate. "No
drop" is held by **structure**, and each rule is a `verify:invariants` check, so it is enforced on
every `npm run verify` and in CI, not remembered:

1. **One producer per datum** (the five classes above): no runtime service is instantiated in a
   panel window (unique-marker count = 1 per service across bundles), and no decoder, `<video>`,
   WebGL or WebGPU context is created in `panel.html`'s bundle.
2. **The frame engine stays where it is.** It keeps running in the editor renderer with the same
   inputs; W1–W3 change where those inputs come *from*, never the engine's loop.
3. **Live streams are pull-based.** A stream with no visible subscriber sends nothing, so an open
   window costs nothing it is not showing.
4. **No per-frame traffic for time.** The playhead travels as an anchor on change, never per frame.
5. **Selectors, not the whole object.** A panel subscribes to its slice; `useEditor()` wholesale is
   forbidden in migrated panels, so a store change cannot re-render the tree.
6. **GPU viewports never leave the editor process before E4.**

What remains is the owner's hands-on check on the venue machines, as with every release, plus the
correctness tests that already exist or are planned (the CI byte-compare of the wire output in §6b,
and the TS-vs-Rust evaluator parity in §4). Those are **correctness** tests, not performance
measurements. The one known cost is RAM: each extra window is a Chromium process (roughly 100–200 MB).

## 9b. Phase E0 in detail — the spikes (started 2026-11-22, branch `feat/e0-engine`)

E0 proves each risky mechanism once, on the real APIs, before E1 builds on it. "No measurements" stands
(owner): a spike answers *does it work, and how*, never *how fast*. Each step ships with a check that
fails if the mechanism breaks.

What THIS PC can prove is limited — one 1920×1080 60 Hz display, an Intel Iris Xe, Windows only — so
every step says where it is proven:

| Step | What | Proven where |
|---|---|---|
| **E0a** ✅ | Engine skeleton: Cargo workspace `engine/`, one wgpu device on the native API (D3D12 / Metal / Vulkan), the software-adapter rule, an offscreen render and LED sampling byte-compared to goldens | here (D3D12 hardware, WARP, Vulkan); CI on all three runners (`.github/workflows/engine.yml`) once pushed |
| **E0b** ✅ | Engine windows: one winit window per display, borderless/fullscreen, presenting at that display's refresh; the reveal never depends on a "ready" event | here for one display + windowed; multi-display/mixed refresh on the RTX PC |
| **E0c** ✅ | Engine → Electron page: the engine renders into a shared texture, main imports it with `sharedTexture` (Electron 42 has it), a page draws it — Windows NT-handle path | here |
| **E0d** ✅ | Zero-copy imports: Spout (D3D11 shared handle) and HAP BC upload, via `create_texture_from_hal` on the pinned wgpu, with the CPU-upload fallback | here (Spout sender needed) |
| **E0e** ⏸ | macOS (IOSurface mach port, Syphon, VideoToolbox) and Linux (dmabuf over `SCM_RIGHTS`, VA-API, Wayland window placement) | a Mac and a Linux box; CI builds only — **deferred: Windows first (owner, 2026-11-22)** |

> ✅ **E0a done 2026-11-22.** `engine/artlux-engine` (wgpu **=30.0.2**, pinned). `artlux-engine --info` lists
> the adapters best first; `--selftest` opens the best HARDWARE adapter and refuses a software one (exit
> 2) unless `--allow-software`; `--software` forces it. Two GPU jobs, each integer-exact by construction
> so ONE set of goldens holds on every adapter: a 64×64 offscreen render read back (fragment colour is a
> function of the integer pixel position, in 1/255 steps), and LED sampling by compute (96 pixel-centre
> UVs on a 32×32 texture → packed RGB, the wire's byte order). The goldens are the CPU references
> (`--write-goldens`), and `cargo test` checks they still are.
>
> Proof here: byte-identical on the Iris Xe through **D3D12** and through **Vulkan**, and on **WARP**
> (D3D12's software rasterizer — the Windows runner's adapter); a golden with one flipped bit fails both
> tests. NOT yet proven: the three CI runners (the workflow exists; it runs when the branch is pushed,
> which is the owner's call), lavapipe, and whether the hosted macOS runner exposes a usable Metal device
> (§6b asks E0 to find out — the workflow's macOS job will say).
>
> ✅ **E0b done 2026-11-22 (engine windows).** `artlux-engine --windows [--fullscreen] [--seconds N]`: winit
> 0.30.13 owns the main thread; one window per display (windowed on it, or borderless fullscreen ON it);
> **each window presents on its own thread with a FIFO swapchain**, so a display's vblank blocks only its
> own presenter — the code shape of "each output at its own refresh, no cap". **The reveal is gated on
> nothing**: created visible, drawn by its thread as soon as its surface exists. The main thread never
> waits on a GPU and never joins a presenter (it hides the window, signals stop, keeps pumping, reaps the
> finished thread) — a precaution against DXGI's documented present/window-thread deadlock, NOT a bug seen:
> the joining version exited 4/4 too. The first close test said otherwise only because it posted WM_CLOSE
> to `Process.MainWindowHandle`, which can be winit's hidden helper window; the probe now finds the window
> by title.
>
> Proof: `engine/scripts/probe-windows.ps1`, which reads the SCREEN, not the engine — window visible, the
> four test-card quadrants exact (255,0,0 / 0,255,0 / 0,0,255 / 255,255,255), the live bar moved between
> two captures, exit at the deadline, a WM_CLOSE ends it — green on **D3D12 windowed, D3D12 borderless
> fullscreen, and Vulkan**. **Not proven here (one 60 Hz display):** two or more displays, and mixed
> refresh rates presenting independently. That needs the RTX PC with its outputs; the code path is the
> one it will run.
>
> ✅ **E0c done 2026-11-22 (engine → Electron page, Windows).** `artlux-engine --share <pid>`
> (`src/share.rs`): three BGRA8 D3D12 textures created SHARED (`D3D12_HEAP_FLAG_SHARED` +
> `ALLOW_SIMULTANEOUS_ACCESS`, so they decay to COMMON after each command list — the state Chromium's D3D11
> opens them in), wrapped for wgpu with `texture_from_raw` + `create_texture_from_hal` (the unstable API the
> pin is for). An NT handle is process-local and Node has no DuplicateHandle, so **the engine duplicates each
> handle INTO Electron main** (main passes its pid). Protocol: JSON lines — `slots` (handles), `frame` (slot,
> GPU work complete) out; `free` (the page has drawn it) in. A slot is rendered again only once free: **the
> ordering is the synchronisation** (no keyed mutex on a `bgra` import). Main imports each slot ONCE
> (`importSharedTexture`) and sends it per frame (`sendSharedTexture`); the page draws the `VideoFrame`.
>
> Proof: `engine/spikes/shared-texture/check.cjs` (a throwaway Electron 42 app). Every announced frame
> reached the page and was drawn (351/351, no send error, three runs); the four quadrants exact; and in
> every report the live bar sits where THAT frame's number puts it — the page shows exactly the frame
> announced, never a slot's stale contents. **Also with the page sandboxed + context-isolated like
> ArtLux's** (`SPIKE_ISOLATED=1`): `sharedTexture` works in a sandboxed preload and the `VideoFrame` crosses
> `contextBridge`. Electron killed mid-stream → the engine stops on its own (stdin EOF).
> **Not covered:** latency (no measurements, owner); a WARP engine (a software adapter cannot share with
> Chromium's hardware device — irrelevant on a venue PC); macOS IOSurface + Linux dmabuf (E0e); the page
> drawing via 2D canvas here — a real view would use WebGPU `importExternalTexture` (E4).
>
> ✅ **E0d done 2026-11-22 (HAP and Spout into the engine).**
>
> **HAP** (`src/hapimport.rs`): a frame goes container → bytes → un-Snappy → its BC blocks, **uploaded as a
> BC texture** — the GPU decodes the blocks as it samples, no RGBA frame on the CPU (today's app decodes HAP
> to RGBA on the CPU). The parsers are **the app's own** `native/hap/src/{mov,hap}.rs`, compiled in by
> `#[path]` — one parser, not two. The device asks for `TEXTURE_COMPRESSION_BC` where the adapter has it;
> where not, the **CPU-decode fallback** uploads RGBA (plan risk 4). Proof: a real **Hap1 1920×1080 clip**
> (`--hap <file> --frame N`, 1296 points per frame): GPU BC sampling within **1 level** of the CPU decode at
> every point on the Iris Xe D3D12, Vulkan and WARP (BC1 interpolation may round differently in hardware —
> the spec allows it); the fallback **identical** to the CPU decode. The self-test gained a synthetic HAP
> frame (four solid BC1 blocks through `hap.rs`) with an exact golden, so CI covers it on every runner.
> Not covered: Hap5/HapY/HapM/Hap7 files (none on this PC; same code path, other BC formats); HapQ's YCoCg
> transform (a shader's job, as today).
>
> **Spout** (`src/spout.rs`): the answer to "zero-copy?" is **yes, on this PC**. A REAL Spout sender
> (Spout's own library via `spout2-rs`, `--spout-send`) publishes the test card with the frame number in the
> bar; `--spout-receive` found that **D3D12 `OpenSharedHandle` ACCEPTS the sender's legacy (non-NT)
> handle**, and the engine sampled **the sender's own texture, wrapped for wgpu, with no copy** — quadrants
> exact and the bar moving in every read (182/182, 188/188, 190/190 over three runs). The fallback, **one
> GPU→GPU copy** (a D3D11 device on the engine's adapter by LUID → the engine's E0c shared texture, an
> event query before the engine reads), matched on every read too. **Not proven:** that NVIDIA's D3D12
> driver accepts a legacy handle the same way (the RTX PC decides; the copy path stays for that); reading
> under Spout's own frame lock (neither path waits on the sender's access mutex yet — the app's receiver
> does not either; E2 should); formats other than BGRA8/RGBA8.

## 9c. Windows first (owner, 2026-11-22)

**The engine is built on Windows first, to the point where it runs a show there; macOS and Linux follow.**
Linux stays IN scope (§6) — this is an order, not a cut. What it means in practice:

- **E0e (macOS / Linux spikes) waits** until the Windows engine runs the output path end to end. Its
  questions (IOSurface, dmabuf, Wayland placement, VideoToolbox / VA-API) do not block anything on Windows.
- **The engine keeps compiling everywhere.** Platform code stays behind `cfg(windows)` (as `share.rs`,
  `spout.rs` already are) and the portable core (device, sampling, HAP-as-BC, windows) stays portable, so
  picking macOS / Linux up later is adding back-ends, not untangling Windows assumptions.
  `.github/workflows/engine.yml` stays as it is; it runs only when the branch is pushed.
- **Windows open questions still needing the RTX PC:** several displays at mixed refresh (E0b), NVIDIA's
  D3D12 accepting a Spout legacy handle (E0d), NVIDIA under the shared-texture path (E0c).

**E1 on Windows, in steps** (each ships behind a flag, the browser engine stays the default and the
fallback until a source/output is proven byte-identical — risk 2):

| Step | What | Proven by |
|---|---|---|
| **E1a** ✅ | The engine as ArtLux's child process: main spawns it, a handshake, a watchdog rung (crash → restart within a second, the document untouched because it lives in the Show Host), packaged in `extraResources` | a packaged-exe run: engine killed → back, logged |
| **E1b** | The document → the engine: the surfaces / fixtures / controllers it needs, and LED sampling + universe packing ported from TS | byte parity with today's packing on recorded projects (extends `test-engine-output.cjs`) |
| **E1c** ✅ | Art-Net / sACN sent BY the engine, reusing `native/output-engine`'s Rust as a library | wire capture: the same bytes as today's path, per universe |
| **E1d** | Sources in the engine: image, HAP (BC), Spout (zero-copy, one-copy fallback), effect | per source, parity vs the browser engine, then flip its default |
| **E1e** | Native projector windows (uncalibrated), on their display, at its refresh | the E0b screen probe on a real output |

> ✅ **E1a done 2026-11-22 (the engine as ArtLux's child).** `src/main/engineHost.ts` + `artlux-engine
> --serve` (`src/serve.rs`), behind `--native-engine` / `ARTLUX_NATIVE_ENGINE=1`. JSON lines: `hello` (with the
> adapter), `ping`/`pong` every second, `quit`; stdin closing ends the engine, so it never outlives the app.
> The watchdog rung: restart 200 ms after a crash or a kill; **a HUNG engine (no pong for 3 s) is killed and
> restarted**; an engine that **REFUSES** (exit 2, no usable adapter) is logged once and left stopped; five
> deaths in a minute → give up. Every transition is in the machine log (category `engine`). Packaged:
> `build.win.extraResources` → `resources/engine/artlux-engine.exe`; `npm run build:engine`; CI's Windows
> package job builds it, and `verify:resources` fails a Windows package without it.
>
> **A bug the probe found, fixed:** main's event loop is busy for SECONDS at boot, so the ping timer fired
> ~3 s late while the engine's pongs sat unread in the pipe — the first version judged that silence and
> would have killed a healthy engine after any main-thread stall. A tick more than two periods late now
> restarts the clock instead of judging (guarded). After the fix the test hang is caught at 3.0 s silence.
>
> Proof, on the PACKAGED `ArtLux.exe`, no CDP (`engine/scripts/probe-engine-host.ps1`, processes + machine
> log only), two runs green: no engine without the flag; with it, the engine is the main process's child; a
> hung engine (one-shot test hook) is killed and replaced; the replacement stays up; a killed engine is back
> (~0.5 s until the new process is seen); closing ArtLux takes it along; the log records enabled / up ×3 /
> hung / exited. And a forced refusal (`ARTLUX_ENGINE_BACKEND=metal` on Windows): `refused` logged once, no
> restart. `verify:invariants` holds the supervisor's rules (mutation-tested 9/9).
>
> **E1b is two steps:** **E1b-1 packing** (the canonical LED buffer + the patch → universes) and **E1b-2
> sampling** (LED geometry → UVs, effects, white extraction, brightness: today's `WebGPUMapper`). Packing
> first: it is pure logic with a clean seam, and it is what puts bytes on the wire.
>
> ✅ **E1b-1 done 2026-11-22 (universe packing, byte parity).** The pixel half of
> `frameEngine.packAndPublish` moved VERBATIM into `src/renderer/engine/packUniverses.ts`, a pure function
> the frame engine now calls (the light fixtures' precedence stack stays in the frame engine, handed in as
> `packLight`). Its Rust port, `engine/artlux-engine/src/pack.rs`, takes light fixtures' channels as bytes
> the host computed — "the host evaluates, the engine draws". **Project files hold what the app tolerated,
> not what its types say** (a generated rig stores a controller protocol as the number 0), so the port reads
> the routing fields as raw JSON with JavaScript's `||` / `??` / truthiness rules.
>
> Proof: `npm run test:pack-parity` bundles the REAL TypeScript module (esbuild) and runs the Rust one
> (`artlux-engine --pack-batch`) on every example project + any rig named on the command line + 400
> synthetic rigs (spill past 512, 3/4 channels, all colour orders, Art-Net / sACN / USB, overrides with "",
> loose types, lights, short and ragged buffers): **472 cases, 1,851,392 DMX bytes identical**, including
> this PC's `venue-rig.artlux` (1296 LEDs) and `gallery-night.artlux`; **the gamma LUT identical for 394
> gammas** (JavaScript's `Math.pow` and Rust's `powf` agree to the rounding). The harness was mutation-tested
> 8/8 against the Rust port (two of the eight were first MISSED — the fuzzer generated no loose `sparse`
> values and no buffer whose length is not a multiple of 4; both added). A stale benchmark rig with a
> numeric `colorOrder` makes the TypeScript packer THROW (the generator was fixed long ago); reported and
> excluded, and the Rust port reads it as RGB. `test-engine-output` unchanged (and "0 lit" was the same
> before the move). `verify:invariants`: one TypeScript packer, called by the frame engine (4/4).
>
> ✅ **E1b-2 done 2026-11-22 (LED sampling, parity at both halves).**
> **Effects are not in the sampler any more.** `buildSegParams` has emitted only "media" or "off" since
> effects moved to surfaces (S3), so WebGPUMapper's effect / palette / fire branches are unreachable and
> were NOT ported; the live path is: read the LED's surface cell in the atlas (linear, clamp), RGB → RGBW
> (or not, RGBW NONE), brightness, pack.
> - **The CPU half** — per-LED UV / t / segment / surface, segment params, the atlas plan (cell sizes from
>   LED density, the shelf packer, the oversample fallbacks) and the half-texel-inset rect UVs — moved
>   VERBATIM from WebGPUMapper into `src/renderer/gpu/ledLayout.ts`; Rust port `src/layout.rs` (f64 math
>   rounded to f32 where the TS stores, fdlibm cos/sin/log2 via `libm` — a precaution: Rust's own gave the
>   same f32 on every case). **Bit for bit identical**: 336 cases (every example rig, venue-rig,
>   gallery-night, 300 synthetic rigs: matrices + serpentine, LED maps with nulls, reverse, segments with gaps
>   and off, rotated fixtures and surfaces, unlinked fixtures, texture limits down to 64 forcing the atlas to
>   degrade) — **583,036 f32 values** compared as bit patterns. Mutation-tested 6/6 (+ the libm experiment).
> - **The GPU half** — `src/sample.rs`, the live kernel in wgpu. `npm run test:sampling-parity` runs the
>   app's REAL WebGPUMapper in an Electron 42 page (Chromium WebGPU, D3D12) on synthetic surfaces (odd sizes,
>   gradients, one at 60% opacity, three brightnesses), takes the EXACT atlas it uploaded and the bytes it
>   read back, and has the engine sample that atlas with that layout: **60 cases, 47,312 bytes identical**
>   (255 distinct values, 7,326 lit LEDs — not a black screen agreeing with itself). Mutation-tested 5/5
>   (nearest filtering, rounding, white extraction, brightness, the cell clamp).
> - Not covered, deliberately: building the ATLAS (each surface scaled into its cell) — Canvas2D's scaler is
>   not reproducible bit for bit; the engine's own atlas comes with the sources (E1d) and is judged there.
>   And only Intel here: another GPU's sampler may filter differently — the RTX PC runs the same harness.
> `test-engine-output` unchanged. `verify:invariants`: one TypeScript layout, called by WebGPUMapper (2/2).
>
> ✅ **E1c done 2026-11-22 (Art-Net / sACN from the engine — the same sender, the same packets).**
> - **One sender, two front doors.** `native/output-engine` split VERBATIM into `src/core.rs` (send thread,
>   frame decode, Art-Net / sACN / ArtSync builders, USB writers, plus an `OutputEngine` handle) and `lib.rs`,
>   the Node addon behind the default `napi` feature (exports unchanged: close, configure, getStats, isReady,
>   listSerialDevices, pushFrame). The engine links the core with `default-features = false` — no Node.
> - **The frame.** `src/wire.rs` ports `encodeFrame` + mockSocketService's targets, with JavaScript's coercions
>   (`for…in` universe order, `priority ?? 100` clamped into a Uint8Array, u16 wrap, stringified ip).
> - **Proof.** `test:pack-parity` now also compares every case's encoded frame: **2,040,946 frame bytes
>   identical** (odd priorities, universes -1 / 65535 / 70000 included). `npm run test:wire-parity` sends 48
>   frames (colours changing, every third repeated so sparse decides, ArtSync off and on, Art-Net + two sACN
>   streams incl. a default priority) through **the shipped addon, the addon rebuilt from the split code, and
>   the engine**, captured on loopback: **identical packets, in order** (140 + 76 + 36 without ArtSync, 188 +
>   76 + 36 with). Mutation-tested: the frame encoder 4/4 (the wire test alone 2/4 — a broadcast flag on
>   Art-Net is a socket option, not a byte; the frame comparison holds it); the guards 5/5.
> - **Harness bugs found on the way, not engine bugs:** a synchronous `execFileSync` blocked the listener's
>   event loop, the receive buffer filled and the tail of the run was "missing" — the first run blamed the
>   engine; and two controllers on one address MERGE into one destination, so the default-priority stream
>   needed its own loopback address (127.0.0.2) before the default could reach the wire at all.
> - **Not yet: the engine on the venue wire at runtime.** It needs the engine to own the whole frame (its own
>   atlas from the sources, E1d); until then the app's addon keeps the wire. USB widgets: covered at frame
>   level, never on hardware (as before). `verify:invariants`: one sender, napi the default (5/5); the USB
>   health check now reads the core, where the code moved.
>
> **E1d is per source.** Each one: the engine draws it into its OWN atlas (no Canvas2D), then the proven
> sampling and packing. First the still image, because it is what every other source needs too: a decoded
> picture → the engine's atlas cell → LEDs. (`artlux-engine --frame-once <project>` renders one whole frame.)
>
> ✅ **E1d-1 done 2026-11-22 (IMAGE in the engine — and what "parity" means for a picture).**
> `src/compose.rs`: PNG / JPEG decoded by the `image` crate; each surface's picture drawn into its cell by a
> render pass that does what `drawImage` does (pixel-centre mapping, clamp, source-over onto black with
> `globalAlpha`, non-linear 8-bit blending), plus two things found by measurement:
> - **Premultiply at decode** (Skia's 8-bit rounding), as Chromium's ImageBitmap holds pixels — the alpha
>   picture went from ±2 to identical.
> - **Mip levels.** Plain bilinear from full resolution aliased: a 1-px line landed on an LED or missed it,
>   up to 60 levels off on an 8× downscale. A Skia-style mip chain fixed it — but WHICH level Skia reads
>   could not be reproduced at every size (5 rules tried; each matched some sizes and not others; the
>   decoders were ruled out: Chromium's JPEG and the engine's agree within ±3 per pixel, and feeding the
>   engine Chromium's own decoded pixels left the same gap).
>
> **So the gate is FAITHFULNESS, not identity** (`npm run test:image-parity`): per picture, the engine's LEDs
> must be byte-identical to the browser's, OR at least as close as the browser's to an ALIAS-FREE reference
> (the picture area-averaged exactly into its cell, read at the LEDs as the shader reads). Result: identical
> on 5 pictures (sharp lines 1920, noise, photo at 60% opacity, upscale, alpha); on the 4 where they differ
> (the sharp pattern at 2048 and 4096, two real 3840×2400 JPEGs) the engine is MORE faithful (2.76 → 1.16,
> 4.28 → 1.25, 0.51 → 0.41, 0.41 → 0.33 mean levels from the reference). The level rule chosen — floor of the
> least-shrunk axis — is the one that was never worse than the browser. Mutation-tested 3/3 (no premultiply,
> no mips, opacity ignored); the first version MISSED "no premultiply" because the reference decoded with the
> engine's own decoder — PNG references are now decoded independently (pngjs).
>
> ⚠ **For the owner:** when the engine owns the output, a heavily downscaled image will put slightly
> different values on some LEDs than today — closer to the picture, not further. The gate guarantees "never
> less faithful", not "identical". Not handled yet: ICC profiles and EXIF orientation (Chromium applies both),
> formats beyond PNG / JPEG.
>
> ✅ **E1d-2 done 2026-11-22 (HAP in the engine — byte-identical, and an app bug found on the way).**
> `compose.rs hap_picture`: the frame's blocks (the app's own mov.rs + hap.rs) → a BC texture (CPU decode
> where the adapter has no BC) → one pass doing what `plugins/hap/src/hapGL.ts` does per texel (HapQ's float
> YCoCg line for line; DXT1 opaque, as the app's RGB DXT1) → the stretch. Measured, not assumed: **`drawImage`
> treats a canvas differently from an ImageBitmap** — premultiplied the same way, but NO mips. With mips the
> real clips were 9–97% exact; without, identical. So a `Picture` now says which kind it is (`still` /
> `canvas`). The frame is read back to the CPU in this step (the live engine keeps it on the GPU).
> - **Proof** (`npm run test:image-parity [clips.mov…]`, the app's REAL `hapGL.uploadFrame` + WebGPUMapper vs
>   `--frame-once --video-frame N`): **4 real clips (Hap1 ×2, Hap5 alpha, a mostly-black Hap5) and synthetic
>   DXT1 (with punch-through blocks, 1002×562) and HapQ (960×541) byte-identical**; synthetic DXT5 at 60%
>   opacity identical but 3 of 692 LEDs off by 1 (four premultiply roundings tried; Skia's is the closest).
>   HAP is gated TIGHTER than stills: max 1 where not identical — the faithfulness rule alone would pass a
>   browser drawing black. Mutation-tested: 4/6 caught (no YCoCg, mips on a canvas, no premultiply, the app
>   fix reverted); the 2 survivors do not reach an LED byte (31.875 → 32 in the YCoCg scale moves colour by
>   < 0.1 level at the scale codes encoders write; DXT1's forced alpha — a punch-through texel is black
>   premultiplied either way). The previous pictures are unchanged.
> - **The app bug: a HAP clip whose width or height is not a multiple of 4 showed BLACK** (WebGL rejects such
>   an S3TC upload, INVALID_OPERATION, no exception — a 1080×1350 portrait would do it). Fixed in `hapGL.ts`
>   (texture at the block-padded size, the canvas reads its share; whole-block sizes draw exactly as before),
>   guarded by `verify:invariants` (2/2), CHANGELOG + CODECS.md.
> - Not covered: HapA / Hap7 (the app shows them wrongly — the engine refuses them rather than copy that),
>   HapM (refused by the app), other video codecs (MP4 via WebCodecs — next to the camera/NDI kind of
>   source), and the NVIDIA PC. Next: **E1d-3 Spout**, then effects.
>
> ✅ **E1d-3 done 2026-11-22 (Spout in the engine — byte-identical on both paths).** `spout.rs grab`: the
> sender's own texture opened in D3D12 (**zero copy** — accepted by this Intel driver) or, where a driver
> refuses that, the one GPU→GPU copy (D3D11 on the engine's adapter); then the same per-texel pass as HAP
> and the stretch. Two measured facts about today's app, both now copied:
> - **The app IGNORES a Spout sender's alpha** — a transparent picture reaches the LEDs as if alpha were 1
>   (18.7 levels apart while the engine honoured it; identical once it did not). Kept: senders that leave
>   alpha at 0 are common, and honouring it would black them out. Now said in docs/SPOUT.md.
> - **A VideoFrame is drawn without mips**, like a canvas (`Picture::video_frame`).
> - **Proof** (`npm run test:image-parity`, Spout phase, Windows): `artlux-engine --spout-send <name> --image
>   <png>` is a REAL sender (Spout's library); the app side is the real path — the spout-receiver addon, the
>   plugin's own `deliver` (sharedTexture.main.ts, bundled), the preload's VideoFrame relay (mirrored in
>   `engine/spikes/spout-parity/preload.js` — it is inline in the app's preload), WebGPUMapper. Four pictures
>   (sharp 1920×1080 downscaled, alpha, noise, a 48×27 upscaled), each on two surfaces (one at 60% opacity),
>   two brightnesses, the engine's **zero-copy AND forced copy path** (`ARTLUX_SPOUT_COPY=1`): **all
>   byte-identical**. Mutation-tested 4/4 (alpha honoured, mips, BGRA read as RGBA, the fallback reading a
>   blank slot); the guard 2/2. One run in ~40 saw no frame reach the app side (a sender not yet published):
>   retried once, never on a wrong picture.
> - Not covered: senders in formats other than BGRA8 / RGBA8 (the app refuses them too), a sender on ANOTHER
>   GPU (the app shows "not compatible"; the engine's copy path needs the same adapter too), the NVIDIA PC,
>   and a moving picture (a still is what makes the two sides comparable). Next: **E1d-4 effects**.
>
> ✅ **E1d-4 done 2026-11-22 (EFFECT surfaces — byte-identical, every effect).** The app renders an effect on
> the CPU into a 96×96 canvas (`gpu/surfaceFx.ts`), so the engine's `src/effects.rs` is a line-for-line
> port with JavaScript's arithmetic: f64 in the TS's order, fdlibm `sin`, the LUT's `Math.round`, the
> Uint8ClampedArray store (clamp, round half to even), Fire's Float32Array heat, the `??` defaults, the
> same-time cache (which is what keeps Fire from stepping twice). Fire's `Math.random` is a mulberry32
> stream in the engine; the test feeds the page's `Math.random` the same stream, only around the effect
> calls. Then `Picture::canvas` and the proven stretch.
> - **Proof** (`npm run test:image-parity`, EFFECT phase): the app's REAL `SurfaceEffect` vs the port, 24
>   surfaces — Solid / Rainbow / Palette Flow / Wave over three palettes each, Fire over all seven, a
>   fractional effect id (falls to Solid), palette ids that wrap negative and past the end, all fields
>   missing, Fire and Wave at 60% opacity — rendered at five times in order, two brightnesses: **16,608 LEDs
>   × 2, all byte-identical**. Mutation-tested 6/8: caught truncation, Wave's phase, Fire's cooling and
>   ignition, the cache, the LUT's rounding; survived: half-up vs half-even in the field store (a tie needs
>   Wave's w = 0.5 exactly — one column at t = 0, read by no LED here; the port keeps the right rule) and
>   std `sin` vs fdlibm (equal here, as in E1b-2; a precaution).
> - **A port is a copy**, so `verify:invariants` holds a fingerprint of `surfaceFx.ts` + `palettes.ts` in
>   effects.rs and fails the moment either changes (tested). Re-port, re-run the test, then update it.
> - Not covered: the engine's effect clock (the host's show time will arrive over the document channel —
>   not built), and the RTX PC.
>
> **E1d status: image (faithful), HAP, Spout, effects (identical) — every source the engine can own today.**
> The rest — `<video>` / MP4 (WebCodecs), camera, NDI, DMX-in, text, shaders, plugin sources — are
> browser-side decoders or renderers; each comes when the engine has its own decoder or the host streams
> the source's texture in. Next: **E1e native projector windows**.
>
> **E1e is two steps:** **E1e-1** the projector RENDERER (what a projector shows, offscreen, held to the app's
> pixels) and **E1e-2** the WINDOWS (on their display, at its refresh, proven on a real output).
>
> ✅ **E1e-1 done 2026-11-22 (the projector renderer — IDENTICAL, pixel for pixel).** `src/projector.rs` ports
> ProjectorGL's uncalibrated 2D warp path: the corner-pin quad with Heckbert's (u·q, v·q, q) or the Bézier
> patch tessellated 24×24 (homography.ts / warp.ts, f64 → f32), trilinear + 8× anisotropic with the chain
> capped at level 4, the shader line for line (blendGlsl.ts soft edge with its 1/g signal, colour gain,
> black lift, brightness, output gamma), 4× MSAA resolved.
> - **The finding: the app's canvas is rasterised BOTTOM-UP** (a GL framebuffer; ANGLE draws it that way and
>   the compositor shows it upright). Top-down, the engine was already ≥ 99.85% within 1 — but one MSAA
>   sample of four flipped on the warped picture's outline (64 levels, ~0.05% of pixels), and inside a strong
>   perspective the anisotropic footprint differed (±4 on up to 8%). Rasterised mirrored and flipped back:
>   **every pixel identical.** The window step flips with a copy pass.
> - **Proof** (`npm run test:projector-parity`): the app's REAL ProjectorGL (captureRGBA) vs `artlux-engine
>   --project-once`, three pictures (sharp 1920×1080, a photo, noise) × ten settings (identity with and
>   without MSAA, keystone, strong perspective, shrunk 1/5 into the mips, shrunk 1/80 past the level cap, a
>   curved Bézier, soft edges, gamma 2.2 + brightness 0.7, gain + black lift + an edge) on a 960×540 raster:
>   **30 cases × 518,400 pixels, all identical**; the gate is identity. Mutation-tested 9/9 (no flip, the
>   soft-edge exponent, no anisotropy, the level cap, an affine pin, tessellation 16, no MSAA, no black lift,
>   point-sampled mips). `verify:invariants` fingerprints the three ported files and holds the sampling
>   constants on both sides + the bottom-up raster (tested).
> - Not covered: calibrated outputs (the baked `.mpcdi` map, render-from-projector), masks, hwWarp (NVAPI),
>   the alignment-aid overlay, NDI send; another GPU's MSAA / anisotropy (the RTX PC runs the same test).
>
> ✅ **E1e-2 done 2026-11-22 (native projector WINDOWS — the screen shows exactly the raster).**
> `artlux-engine --project-windows`: one window per output (`windows.rs` projection mode), E0b's shape kept —
> a presenter thread per window, FIFO on its own display, visible from creation and gated on nothing,
> closing never joins from the window thread. The raster is drawn through projector.rs (bottom-up) and a
> flip pass copies it to a NON-sRGB swapchain at every vblank. **Placement: exact physical bounds, then an
> index — and an output whose display is not there is REFUSED and said, never put on another screen.**
> - **Proof, from the SCREEN** (`npm run test:projector-windows [--fullscreen]`, a PowerShell GDI capture,
>   no hook into the engine): the window appears where and as large as asked (960×540 at (80, 80)); **the
>   pixels on screen are byte-identical to `--project-once`** (518,400 of 518,400), still 1.5 s later; a
>   display that does not exist opens nothing and is named in the log; every output refused → exit 1;
>   ~400 frames presented over a 7 s run; exit at the deadline. **Borderless fullscreen on display 0:
>   1920×1080 at (0, 0), 2,073,600 of 2,073,600 pixels identical.** Mutation-tested 4/4 (no flip, an sRGB
>   swapchain, a missing display falling back to display 0, the position ignored); the guard 1/1.
> - This PC has ONE display, so "the output's own display" was the primary, windowed for the main proof;
>   a second output (HDMI monitor / projector) runs the same test with `display: {index: 1}`. Matching
>   Electron's `display.id` to bounds (DIP × scale factor) is the host's job, with the document channel.
> - Not covered: a second physical display, a refresh other than 60 Hz, mixed DPI, a display unplugged
>   while showing (winit reports it; the output's recovery is the watchdog's, later), the RTX PC.
>
> **E1 status (Windows): the engine can do everything the app's output does today — packing, sampling, the
> wire, image / HAP / Spout / effect sources, the projector renderer and its windows — each proven against
> the app's real code. What it cannot do yet is RUN A SHOW: nothing feeds it the live document.** Next:
> **E1f, the document channel** — the host sends the engine the surfaces, fixtures, controllers, outputs,
> the show clock and the sources' state over the E1a stdio link; the engine renders and outputs at runtime
> behind `--native-engine`, the app's path the fallback.
>
> **E1f is per output kind:** **E1f-1 the LED wire** (pixel fixtures; this step), **E1f-2 light fixtures**
> (the host's precedence stack sends each light's channel bytes — pack.rs already takes them), **E1f-3
> projectors** (the engine's windows from E1e fed by the same link), then the remaining sources.
>
> ✅ **E1f-1 done 2026-11-22 (the engine DRIVES THE LED WIRE in the real app).**
> - **The link.** "The host evaluates, the engine draws": `renderer/engine/nativeLink.ts` sends the frame
>   engine's EFFECTIVE surfaces and fixtures (after automation and fades) whenever they or a surface's
>   resolved source change, plus one tick per frame — show time, brightness, and for each HAP surface the
>   frame INDEX the app is showing, so both draw the same frame. The source per surface is decided beside
>   `getDrawable` (`surfaceMedia.nativeSource` / `contentSource.nativeSource`: bakes, slices, layers, the
>   codec). Main relays (`engineHost.ts`, re-sending output settings + the document to a restarted engine);
>   the engine's `runtime.rs` keeps the pictures' GPU textures between frames (a still is mipped once) and
>   composes → samples → packs → sends through the shared output core.
> - **Ownership is all or nothing**, per document: a light fixture, a source it cannot draw, or output off →
>   `owns: false` with the reason, logged (`app-has-wire`), the engine silent. While it owns, main RECORDS
>   the app's frames (blackout needs their shape) but does not send them.
> - **Proof in the real app** (`npm run test:native-takeover`; who sent each packet = its UDP source port's
>   process): without the flag the app sends; with it **only artlux-engine sends after the handover, and
>   both universes are BYTE-IDENTICAL to the app's own**; killing the engine puts the app's frames back on the
>   wire **38 ms** later (main sees the exit at 23 ms), the restarted engine owns it again at 466 ms; longest
>   silence 38 ms; main logs both. `npm run test:engine-runtime` (the engine alone over stdio): every universe
>   = `--frame-once` + the app's packer, the three refusals silent with keep-alive on, a cached still not
>   frozen, pings answered during frames, ticks for an old document ignored.
> - **Found and fixed on the way:**
>   1. **An app bug — LEDs sampled a surface's PRE-FIT outline.** When media loads onto a surface of another
>      shape the frame engine fits the surface itself; App then commits the same array and the mapping diff
>      saw "no change", so the LEDs kept sampling the old rectangle until something else moved (389 of 512
>      channels off here). An auto-fit is now a geometry change (guarded; CHANGELOG).
>   2. **Two senders:** muting the app's pushes left its send thread's KEEP-ALIVE repeating the last frame
>      beside the engine's. Muting now hands it an empty frame (the engine does the same on handback).
>   3. **Liveness is "it is sending"**, per frame from the render thread: a render thread that stalls while
>      the reader answers pings would otherwise hold the wire dark forever.
>   4. **The engine quit on the WORD "quit"** anywhere in a line — a surface named so would have stopped it.
>   5. **Measurement traps, not product bugs:** a synchronous lookup in the harness delayed packet timestamps;
>      in dev, ArtLux's stdout is piped to the harness and a blocked harness BLOCKS main (Windows pipes); and
>      the first "2.5 s handback" was **main blocked ~7 s by the audio engine's synchronous start-up** (its
>      "Getting first order cube"). That last one was real and pre-existing — **for several seconds after
>      start-up main forwarded no frame to the wire** — and is FIXED (2026-11-22, on the owner's ask): the
>      audio addon runs every engine call on its own control thread (also JUCE's message thread), answering
>      with promises. The device open (5.5 s, WASAPI shared, Realtek) no longer touches main: main's worst
>      start-up gap 7.4 s → 397 ms; a kill moments after start-up is handed back in 59 ms; all seven addon
>      tests pass on the real device (ASIO, DirectSound, WASAPI shared and exclusive all open); guarded.
> - Heavily shrunk stills are where the engine is not byte-identical by design (E1d-1, the pending owner
>   decision); the takeover test uses enlarged stills, where it is.
> - `test-engine-output` (the no-flag path): 2 of 2 clean runs pass with these changes and 2 of 2 without;
>   2 earlier runs WITH them each failed a different check while a cargo build or another app run was
>   competing — recorded as flaky under load, not proven either way.
> - Not covered: lights, projectors, Spout at runtime (the engine's grab opens a receiver per frame — fine
>   for a test, not for a show), the packaged exe (`--packaged` is ready), sACN handover (both senders share
>   no sequence), the RTX PC.
>
> ✅ **E1f-2 done 2026-11-22 (LIGHT fixtures on the engine's wire — the host's bytes, placed identically).**
> A light is still evaluated where it always was: `frameEngine.packAndPublish`'s precedence stack (profile
> default < authored < lighting clip < pose cue < automation < live override), which now also RECORDS every
> value it writes per light. The tick moved to AFTER packing, so it carries THIS frame's values (as ToUint8
> bytes, what the frame codec stores); the document lists the lights by `services/fixtureKind`; the engine
> sets them as `light_channels` and `pack.rs` places them (already byte-identical in `test:pack-parity`). The
> "a light → the app keeps the wire" refusal is gone.
> - **Proof.** `test:engine-runtime`: lights mid-universe, one SPILLING into the next universe, one the host
>   could not describe (no bytes → writes nothing), two different byte sets per tick — every universe equal
>   to the app's packer, the pixel universe untouched. `test:native-takeover` in the real app: two
>   `generic/rgbw-fader` washes (one across the 512 boundary) and a `generic/dimmer-1ch`, authored values →
>   **universes 2 and 3 byte-identical** with the engine owning the wire, pixels still identical, handback
>   55 ms. Mutation: the engine ignoring the tick's bytes, or treating lights as pixels — each 4 checks
>   fail; guarded (`verify:invariants`).
> - Not covered: a lighting CLIP, pose cue or live fader moving a light while the engine owns the wire (the
>   same recorded path, but no test drives one yet), USB-DMX (enttec) targets on hardware, the RTX PC.
>   Next: **E1f-3 projectors** over the link.
>
> ✅ **E1f-3 done 2026-11-22 (the PROJECTOR OUTPUTS from the engine's own windows — identical on screen).**
> - **Engine.** `--serve` runs a winit event loop on a WINDOWS THREAD (`outputs.rs`) which also opens the GPU.
>   It keeps one borderless fullscreen window per output on the display the document names, each with its
>   own FIFO presenter. The presenter redraws through `projector.rs` when the surface's picture (published
>   by the render thread with a generation) or the settings (`projectorBrightness` × the surface's opacity,
>   per tick) move, then flips. The cold-start hold shows black, as the app's does.
> - **All or nothing, like the wire.** The renderer lists every enabled output with a reason when it is not
>   the plain warp path the engine draws: calibrated, mask, NVIDIA hardware warp, NDI send, blend map,
>   windowed, or a source the engine lacks. Main adds each display's PHYSICAL bounds (or "not
>   connected"). The engine answers `projOwns`.
> - **The fallback is a window already there.** While the engine owns the outputs, its windows are
>   TOPMOST and the app's stay open underneath, COVERED: they stop drawing, so the GPU does not render a
>   hidden picture. When the engine exits or hangs, main uncovers them first, and they draw on their next
>   frame.
> - **Proof, from the SCREEN, in the real app** (`npm run test:native-projectors`, broadcast mode: a still on
>   a keystone with a soft edge, gamma, gain and lift at projector brightness 0.9 on display 0):
>   - **the engine's window = the app's window in the same session: 2,073,600 of 2,073,600 pixels identical**,
>     and again after an engine restart;
>   - a kill uncovers the app's window in **~55 ms**, and it is drawing 0.4 s later (it had been covered since
>     it opened);
>   - the restarted engine takes the outputs back.
>   - Regressions re-run green: `test:engine-runtime`, `test:native-takeover` (53 ms handback), and E1a's
>     refusal (exit 2).
> - **Found on the way:**
>   1. **A window created ALWAYS-ON-TOP and borderless-fullscreen cannot configure its swapchain** ("Invalid
>      surface"; the presenter panicked and took the engine — LEDs included — down). Ruled out first: the
>      display handle and the thread that opened the device. The level is now raised after the first
>      configure (guarded).
>   2. **The app is not bit-stable across LAUNCHES**: two runs of its own projector window differed on 11
>      pixels by 1 level, all inside the soft-edge band. So identity is judged within one session.
> - Not covered: a covered window not drawing is enforced by code, not measured; more than one display; a
>   calibrated / masked / hw-warped / NDI-sent output (refused by design); video sources on a projector
>   (HAP works through the same path, untested on a projector); a presenter that stalls while the engine
>   lives (an exit is caught, a stall is not yet); a presenter panic still ends the whole engine; the RTX
>   PC.
>
> ✅ **E1f proven on the PACKAGED app 2026-11-22** (a local `npm run package:dir` — nothing pushed, no CI;
> `release/win-unpacked/ArtLux.exe`, engine at `resources/engine/`, the rebuilt audio engine beside it):
> - `test:native-takeover --packaged`: the engine takes the LED wire — four universes (pixels, two washes,
>   a dimmer) byte-identical to the app's own; a kill moments after start-up is handed back in **49 ms**;
>   the restarted engine owns it again in 487 ms.
> - `test:native-projectors --packaged`: the engine's projector window = the app's, **2,073,600 of
>   2,073,600** pixels, before and after a restart; the app's window is uncovered 138 ms after a kill.
> - `engine/scripts/probe-engine-host.ps1` (E1a, processes + machine log, no CDP): child of main, a hang
>   killed and replaced, a kill restarted (~440 ms), quitting takes it along, all logged.
> - A forced refusal (`ARTLUX_ENGINE_BACKEND=metal`): logged once, not restarted, no engine left.
> - The audio engine loads and configures its device in the packaged app, and the 49 ms handback at
>   start-up is itself the proof that main is no longer stalled by it.
>
> **The owner's next ask (2026-11-22): "2 and 3"** — the remaining SOURCES, and CALIBRATED outputs. Order,
> smallest and safest first: **2a Spout at runtime**, **3 the baked `.mpcdi` map path**, **2b NDI**, **2c MP4**
> (an engine-side decoder), **2d camera** (one process can hold most webcams — a design question first).
> Render-from-projector (the live 3D venue) stays the app's.
>
> ✅ **2a done 2026-11-22 (Spout at runtime).** `spout.rs SpoutIn`: ONE receiver per surface, the sender's
> texture reopened only when its share handle changes, read every frame on the proven paths (zero copy, or
> the one GPU copy). `grab` is now a SpoutIn, so `test:image-parity` keeps proving the runtime's code (both
> paths still identical). An empty name follows the active sender, as the app does. **Copied, not "fixed":**
> the app has ONE Spout receiver for every Spout surface, so two surfaces naming different senders both show
> one of them today — that show stays the app's, with the reason. Proof in the real app
> (`test:native-takeover`): a real sender (Spout's library) on a Spout surface — **universe 4 byte-identical**
> with the engine owning the wire, beside pixels and lights; handback 49 ms. Not covered: a MOVING sender
> (the same per-frame path; a still is what makes the two sides comparable), a sender on another GPU.
>
> ✅ **3 done 2026-11-22 (CALIBRATED outputs that play an imported .mpcdi — identical).**
> - **A gap in E1f-3, closed first.** The imported map lives in the calibration plugin's `bakedStore` and
>   reaches each window directly. It is not `ProjectorOutput.calibration`, so the engine's eligibility could
>   not see it: an output playing a map would have been taken and drawn as a plain warp. Now App records the
>   map at THE ONE DOOR it reaches a window through (`sendToProjector`).
> - **The engine.** `projector.rs` gains ProjectorGL's baked path line for line: `pack_baked` (setBakedMap's
>   repack and dilation, f32 stores of JS doubles), `baked_upload` (RGBA32F map, optional R8 rig blend), and
>   `draw_baked` (FRAG_BAKED: coverage or the 3×3 tent, content at (u, 1−v), soft edge × rig blend in raster
>   space, gain / lift / brightness / gamma, coverage last; no MSAA; bottom-up). The map goes renderer →
>   main ONCE per map (main writes it to a file); the document names it by key; the presenter uploads it
>   once and draws through it. A map supersedes the venue render (as in the window); calibration WITHOUT a
>   map — the live render-from-projector — stays the app's, with its reason.
> - **Found:** the map must be read through the HARDWARE POINT SAMPLER, not `floor(uv × size)`. On a map
>   smaller than the raster, texel boundaries land on pixel centres and the exact floor picked the other
>   texel on 2–5% of pixels; the point sampler picks the app's (an explicit bind group layout: unfilterable
>   float + a non-filtering sampler — wgpu's automatic one cannot say it). Interpolating vRaster as GL's
>   varying was tried first and changed nothing (kept: it matches by construction).
> - **Proof.**
>   - `test:projector-parity`, against the app's real `setBakedMap` → `setBakedAlpha` → `drawBaked`: a curved
>     map with coverage, the tent fallback, a rig blend, a 640×360 map on a 960×540 raster, and a keystone
>     with soft edge, gain, lift and gamma — **15 cases (3 pictures), every pixel identical**. The mesh path
>     is unchanged.
>   - `test:native-projectors --baked` in the real app: a REAL `.mpcdi` written by the app's own
>     `buildMpcdi` (1920×1080 region with holes, partial coverage and a rig alpha), loaded as a show machine
>     loads one (`Prefs.calibrationFile`) — **the engine's window = the app's, 2,073,600 of 2,073,600**,
>     before and after a restart; uncovered 155 ms after a kill. Guarded.
> - Not covered: `world`-profile (3D) maps (the app cannot replay them either), several regions on several
>   displays, a map hot-swapped mid-show (the window reopens — a blink), the RTX PC.
>
> ✅ **2b done 2026-11-22 (NDI at runtime).**
> - **The engine receives NDI itself** (`ndi.rs NdiIn`). It uses the app's NDI crate, options and capture
>   call, on its own thread per source, so discovery never stalls the render thread.
> - **Same arithmetic as the app.** The frame is scaled to the size of the app's own NDI canvas (the host
>   sends it) with a VERBATIM copy of the addon's `fit` + `downscale_rgba`. The addon ships prebuilt, so
>   the two copies cannot be shared; `verify:invariants` holds them equal.
> - **Copied, not "fixed":** the app has ONE NDI receiver for every NDI surface, exactly as with Spout. Two
>   NDI sources stay the app's, with the reason.
> - **A build-time feature.** NDI is the cargo feature `ndi`, and `build:engine` (`scripts/build-engine.cjs`)
>   turns it on where `NDI_SDK_DIR` exists. An engine built without it refuses an NDI show.
> - **Found:** linked normally, the NDI build does not START (0xC0000135) on a machine without the NDI
>   runtime on its PATH. That would take the LED wire and the projectors down with it. The fix:
>   - the DLL is **delay-loaded** (`build.rs`);
>   - `ndi::runtime()` loads it by full path from the places the app's plugin uses;
>   - without a runtime, the show stays the app's with that reason.
>
>   Checked: the NDI build starts with a bare `System32` PATH.
> - **Proof.** `test:native-takeover` puts a real NDI sender (the app's own `ndi.node`) on an NDI surface.
>   **Universe 5 is byte-identical** with the engine owning the wire, beside Spout, pixels and lights. After
>   the handover only the engine sends; the handback took 64 ms.
> - **A main fix on the way (`answeredRev`): a new document is not a handback.** An NDI frame arriving
>   auto-fits its surface, which makes a new document. Main used to unmute the app the moment the revision
>   changed, while the engine was still sending, so both sent for a moment. Now the engine that owned the
>   previous revision keeps the wire until it answers the new one. "Sent" freshness still guards it, and a
>   refusal hands the wire back at once.
> - **Not covered:** a MOVING NDI picture, a source on another machine (network loss and reconnect), and a
>   machine with no NDI runtime at all (the refusal is guarded, not run).

## 10. Open questions

1. ~~Which first?~~ **Decided: E5** (multi-window UI, no performance drop).
2. **UI shell after E5:** keep Electron (Node host, `sharedTexture`, one Chromium on every OS), or
   reassess Tauri once no GPU work remains in the webview? The proposal is to keep Electron and
   reassess only if a concrete reason appears.
3. **One developer or more?** The 12–18 month estimate assumes one; E5 and E1–E4 parallelise cleanly
   across two.
4. ~~Linux?~~ **Decided: in scope**, built and shipped by CI on all three OSes (§6, §6b).
5. ~~GPU viewports before E4?~~ **Decided: docked until the engine exists** (§9a).
6. **Wayland window placement:** XWayland for exact placement of UI windows, or native Wayland with
   compositor placement? E0's spike tries both.
