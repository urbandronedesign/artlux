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
| **E0e** | macOS (IOSurface mach port, Syphon, VideoToolbox) and Linux (dmabuf over `SCM_RIGHTS`, VA-API, Wayland window placement) | a Mac and a Linux box; CI builds only |

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
