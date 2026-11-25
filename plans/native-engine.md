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
>
> **2c MP4, in three steps.** H.264 / H.265 decoding is bit-exact by the standard, so the engine is held
> to the app separately on each half: **2c-1** the conversion + stretch, on the app's own decoded frames;
> **2c-2** the engine's own decoder (Media Foundation), held byte for byte to the planes WebCodecs gives;
> **2c-3** the runtime (the host sends the frame on screen, as for HAP) in the real app.
>
> ✅ **2c-1 done 2026-11-22 (an MP4 frame converted and drawn as the app draws it).**
> - **The harness (`test:mp4-parity`).**
>   - It encodes synthetic MP4s with WebCodecs + mediabunny: H.264 and H.265; sharp, noise and smooth content.
>   - The sizes carry encoder padding: 1080 → 1088 coded, and 1002×562 → 1008×576, an odd chroma width.
>   - It decodes them with the app's REAL `mp4Decoder` and dumps each `VideoFrame`'s coded NV12 planes.
>   - The engine converts those planes (`yuv.rs`) and draws them (`compose.rs`), so the decoder is not
>     in this test.
> - **What Chromium does, measured:**
>   - BT.709 limited range, with the standard's coefficients;
>   - chroma upsampled bilinear, CENTRE-sited, and clamped at the **coded** edge. Chromium reads the
>     encoder's padding past the visible edge; with the visible edge as the clamp, the last row and an
>     odd last column were off by up to 106;
>   - rounding to nearest;
>   - the stretch also reads past the visible edge. So the engine converts the WHOLE coded frame and
>     draws its visible rect out of it (`Picture::coded_frame` + a source rect in the stretch shader).
> - **Not byte-identical, and why.** The conversion is within 1 of Chromium everywhere, with 99.7–99.8% of
>   channels identical. The rest are values within about 0.0075 of a rounding boundary, which Chromium's
>   float arithmetic rounds the other way. That residue has no structure to copy: a least-squares fit, a
>   constant or proportional offset, and 8/16-bit chroma quantisation were each tried and none fits.
> - **Gate.**
>   - The conversion: within 1, and at most 0.5% of channels differing.
>   - The LEDs, through the app's real `WebGPUMapper` with the `VideoFrame`s: within 1 (98.3–99.7%
>     identical, brightness 1 and 0.8).
>   - Two real clips with the sRGB transfer pass the same way, so that transfer is accepted.
> - **Mutation-tested:** swapped chroma weights, the visible-edge clamp, full-range luma, truncation, and
>   the crop ignored each fail the gate. Guarded in `verify:invariants`.
> - **Refused (the app keeps the surface):** BT.601, BT.2020, full range and HDR transfers. Chromium may
>   convert those colours, and that is unmeasured.
> - **Not covered:** another GPU's Chromium (the RTX PC), and 10-bit (P010) frames.
>
> ✅ **2c-2 done 2026-11-22 (the engine decodes the MP4 itself — the same pictures as the app).**
> - **A demuxer of its own, `mp4demux.rs`.** It is plain Rust, so the macOS and Linux decoders can take
>   the same samples. Each sample is timed exactly as the app times it: `(cts / timescale) × 1e6`, with
>   cts = dts + the ctts offset, truncated as an `EncodedVideoChunk`'s `long long` is. That is the
>   `VideoFrame.timestamp` the host will send.
> - **The decoder fed by hand, `mf.rs`.** Media Foundation's H.264 / H.265 decoder transform takes Annex B
>   samples (parameter sets in front of each key frame) carrying the app's timestamps, and gives NV12
>   back. A frame is asked for by timestamp; the decoder is flushed and restarted at the key frame
>   before only for a frame it has passed, or one a GOP ahead.
> - **Found: Media Foundation's source reader is wrong here** (it was tried first).
>   - Its clock names the wrong frames: on WebCodecs-encoded H.264 it labelled frames 0 and 1 both 0 µs.
>   - It blanks the encoder's padding rows, which the conversion reads.
> - **Proof (`test:mp4-parity` gates 3 and 4).**
>   - Gate 3, the decoder: on the app's timestamps in the app's order (backward and across key frames,
>     H.264 and H.265), the coded size, visible rect, timestamp and **every visible byte** are identical.
>     So are two real B-frame clips.
>   - Gate 4, the whole engine path (demux, decode, convert, stretch): the LEDs are within 1 of the
>     app's, the same figures as on the app's own frames.
> - **The padding is counted, not gated.** H.264 conformance is defined on the cropped picture, so what a
>   decoder leaves past the visible edge is its own; the app's differs from GPU to GPU. Here it differed
>   by 1–3 on most of the bytes that differ, and by 28 at worst on the noise file. It did not move the
>   LEDs past 1.
> - **Mutation-tested:**
>   - rounded timestamps, no seek back, and no parameter sets each fail the gates;
>   - ignoring ctts fails only with a real B-frame clip (WebCodecs writes no B-frames), so a source
>     guard holds that rule too.
> - **Seen once, app-side:** on one run in three, the app's own `layerFrameExact` returned nothing for the
>   last frame of the H.265 GOP file. The harness names it and moves on. Not chased yet.
> - **Not yet:**
>   - hardware decode (a D3D11 device): this is software decode in system memory, which the CPU
>     conversion reads anyway;
>   - fragmented MP4 (refused);
>   - 10-bit;
>   - the runtime (2c-3).

> **2c-3 reordered (owner, 2026-11-22: "why gpu decode is for later?").** The app decodes MP4 on the GPU
> today, so an engine that took MP4 shows with a CPU decode would be a performance drop on a venue machine,
> against the rule. So GPU work comes BEFORE the runtime: **2c-3a** the conversion on the GPU, **2c-3b** the
> hardware decoder into the engine's GPU, then **2c-4** the runtime in the real app. The CPU decoder stays
> as the fallback for a file a GPU will not decode.
>
> ✅ **2c-3a done 2026-11-22 (the conversion on the GPU — closer to the app than the CPU one).**
> - **The shader (`yuv.rs GpuConvert`).** The planes are two textures (Y: R8, UV: RG8 — what a hardware
>   decoder's NV12 texture gives as plane views). One compute pass writes the RGBA picture, with the CPU
>   conversion's arithmetic: exact integer chroma weights, centre-sited, coded-edge clamp.
> - **`Picture.tex`.** The atlas draws a GPU picture as it is, with no upload. `--frame-once` converts on
>   the GPU by default, as the runtime will; `--cpu-convert` keeps the CPU reference.
> - **Found: where 2c-1's "unstructured" residue comes from.** It is the GPU's own float→UNORM store
>   rounding Chromium's result. With no explicit rounding in the shader (the value / 255 goes to the store,
>   as in Chromium's shader on the same GPU), the conversion is within 1 of Chromium on all but
>   **0.009–0.015%** of channels; rounding half up gave 0.21–0.27%. The store's rounding is the hardware's:
>   a round-to-nearest emulation on the CPU did not reproduce it. Also tried, no better: the hardware's
>   bilinear filter for the chroma, and Skia's matrix-and-bias form. What remains is float ordering.
> - **The LEDs: most surfaces now BYTE-IDENTICAL to the app.** 5 of 7 files are identical at both
>   brightnesses, the other two 99.6–99.9% identical, within 1. That holds both from the app's frames and
>   from the engine's own decode. 2c-1 gave 98.3–99.7%.
> - **Gates tightened.** GPU vs Chromium: within 1, at most 0.05%. CPU vs Chromium: within 1, at most
>   0.5%, as before. GPU vs CPU: within 1.
> - **Mutation-tested:** explicit rounding, wrong chroma weights, a clamp one texel short, and a wrong luma
>   offset each fail. Guarded.
> - **Not yet:** the hardware decoder (2c-3b); projector windows (a different GPU device: 2c-4).

> ✅ **2c-3b done 2026-11-22 (hardware decode into the engine's GPU — the app's own pictures).**
> - **The decoder on the GPU (`mf.rs`).** The same Media Foundation transform is given a D3D11 device on
>   the engine's adapter (`MFT_MESSAGE_SET_D3D_MANAGER`). It decodes on the GPU's video block and hands
>   back D3D11 textures.
> - **Into the engine's device, GPU to GPU.** The frame shown is copied into ONE shared NV12 texture: made
>   by D3D11 with an NT handle, opened by D3D12, and wrapped as wgpu's NV12 texture (`TEXTURE_FORMAT_NV12`).
>   2c-3a's shader reads its two planes. No frame crosses to the CPU.
> - **The fallback.** A decoder that refuses the device decodes in software, with the reason
>   (`software_why`).
> - **Found: the pictures are the APP'S, byte for byte, padding included.** The hardware decode runs on the
>   same video block as Chromium's, so the padding past the visible edge matches too. The software decoder's
>   padding never did.
> - **Found: a hardware decoder's texture pool runs dry.** Collecting every ready frame (fine in software)
>   exhausted it while draining the end of a file, and `ProcessOutput` then waited FOREVER: the engine hung.
>   The decoder is now fed and emptied ONE frame at a time, each consumed before the next is asked for.
>   (This hang left a stuck test process on this machine; see the report.)
> - **Found: the shared NV12 texture must be made by D3D11.** Created in a D3D12 shared heap — how the
>   Spout slot works for BGRA — D3D11 refused to open it (E_INVALIDARG).
> - **Found: the software decoder leaves the padding UNWRITTEN on some frames.** The same frame on three
>   runs: all eight padding rows differed on one. The software path now fills the padding with the edge,
>   so it is deterministic.
> - **Proof (`test:mp4-parity`).**
>   - Gate 3b, the hardware decode: every frame identical in full, and it must say it decoded on the GPU.
>   - Gate 4a, the GPU path: the LEDs are identical on 26 of 28 surface checks, within 1 on the other two.
>   - Gate 4b, the software fallback: the same LED figures.
> - **Mutation-tested:** copying the wrong slice of the decoder's texture array, and a silent fallback to
>   software, each fail. The pool rule is guarded at source: only a timeout could catch a hang.
> - **Costs left, knowingly:**
>   - each shown frame waits on the CPU twice: for the D3D11 copy (an event query), and for the conversion
>     to read the slot before the next copy (`poll`). Two slots plus GPU fences would remove both;
>   - the converted picture is a new texture per frame.
> - **Not yet:** projector windows (another wgpu device: 2c-4), 10-bit, fragmented MP4, the RTX PC.

> ✅ **2c-4 done 2026-11-22 (MP4 at runtime in the real app — the LEDs, on the GPU path).**
> - **The host (`contentSource.mp4NativeSource`).** A surface playing an MP4 through `plugins/mp4` is
>   `{kind:'mp4', path, durUs}`. It is decided on the APP'S OWN current `VideoFrame`: only an 8-bit NV12
>   frame in BT.709 limited range with the BT.709 or sRGB transfer — what `test:mp4-parity` measured.
>   Anything else, or no frame yet, stays the app's with the reason.
> - **The tick** carries each MP4 surface's `VideoFrame.timestamp`, the codec's generation, as HAP sends
>   its index.
> - **The engine (`runtime.rs`).** It opens one decoder per surface when it checks the document, so a file
>   it cannot read leaves the show to the app with that reason. It folds the app's absolute timestamp back
>   into the file: a looping surface adds the file's duration per loop. Then it decodes and converts that
>   exact frame on the GPU (2c-3b).
> - **Proof (`test:native-takeover`, dev).** An MP4 surface (universe 6) plays `engine/testdata/
>   loop-avc-640x360.mp4`: 8 distinct frames at 4 fps, a 2-second loop, made by the parity harness's
>   encoder.
>   - It moves, so run A collects every payload the app sent.
>   - With the engine owning the wire, the engine sends **all 8 frames**, each within 1 of one of the
>     app's payloads (7 of 8 byte-identical).
>   - Every other universe stays identical, a single sender after the handover, handback 85 ms after a kill.
> - **Mutation-tested:** without the loop fold the engine froze after the first loop (6 of 8 frames), and
>   the check, first written as "it moves", let that pass. It now requires every frame.
> - **An MP4 on a PROJECTOR stays the app's**, with the reason. The picture lives on the engine's LED
>   device, and its projector windows run on another (`outputs.rs`). Sharing the converted texture across
>   the two devices is the next piece of this item.
> - **Not covered:** a packaged run with MP4, several MP4 surfaces at once, a timeline-driven (LAYER) MP4
>   (refused as before), a seek or scrub while the engine owns the wire, and the RTX PC.

> ✅ **2c-4 projectors done 2026-11-22 (an MP4 on a projector, from the engine) — and a correction.**
> - **I was wrong that the projector windows run on another GPU device.** `serve.rs` opens ONE device on the
>   windows thread, and the render thread shares it. So an MP4 frame (a texture) reaches the presenters as
>   it is: `projector.rs content_texture_from` copies its VISIBLE rect GPU to GPU, then mips it as
>   ProjectorGL does.
> - **Measured first:** the app's window gets the frame as `createImageBitmap(VideoFrame)`, and that
>   converts exactly as `drawImage` does (`test:mp4-parity` gate 1b: the same channels within 1).
> - **Fixed:** a surface that only a projector shows never had its decoder opened (the verdict opens the
>   LED surfaces'), so the engine's window was black. It is now opened on first use.
> - **Test clip:** `engine/testdata/still-avc-1280x720.mp4`, every frame a KEY frame of the same picture.
>   With P-frames each frame carries its own compression noise (up to 3 levels), and two captures caught
>   different frames.
> - **⚠ CORRECTION — the projector identity claims of E1f-3 and item 3 were measured against the wrong
>   window.** `test:native-projectors` judged the engine against a capture taken ~0.4 s after killing it,
>   meant to show the app's uncovered window. A capture takes PowerShell about a second to start, and by
>   then main had RESTARTED the engine, topmost again. So "the engine's window = the app's" compared the
>   engine with itself.
>   - Found by a mutation that still passed: a copy shifted by one pixel. The capture 3 s later was the
>     same shifted picture.
>   - Now the engine is judged against run A (the app alone). A new run A2 shows the app equals itself
>     across launches (0 pixels), so A is a sound reference.
>   - The old "the app is not bit-stable across launches" note was this same mistake.
> - **The honest numbers, on this rig, same harness:**
>   - **baked map (item 3): IDENTICAL**, 2,073,600 of 2,073,600 — the claim stands.
>   - **plain warp, a still (E1f-3): NOT identical.** 11 pixels off by 1, all in the bottom soft-edge
>     band: the soft-edge share is read off the mesh-interpolated coordinate, under 4× MSAA, while the map
>     path reads raster space without MSAA and is identical. Gate: within 1 on at most 0.01%. Not chased.
>   - **MP4: within 1 on 1,322 pixels (0.064%).** Gate: within 1 on at most 0.1%.
>   - Handback (main uncovers the app's windows) 108–217 ms after a kill. The restarted engine's window
>     matches A again.
> - **Mutation-tested (with the fixed harness):** the shifted copy now fails (649,191 pixels, max 229);
>   skipping the copy (a black window) fails. Guarded, including the harness's rule.

> ✅ **MP4 proven on the PACKAGED app 2026-11-22** (local `npm run package:dir`; the packaged
> `resources/engine/artlux-engine.exe` is the current build, same hash).
> - **`test:native-takeover --packaged`:** the MP4 surface's 8 frames come from the engine, each within 1
>   of the app's (7 identical). Universes 0–5 are identical, a single sender, handback 60 ms. No software
>   fallback was logged: the packaged engine decodes on the GPU.
>   - The hand-off rule seen working: the app first kept the wire ("an MP4 with no decoded frame yet"), and
>     the engine took over at the next document.
> - **`test:native-projectors --packaged`, re-run with the corrected reference** (the earlier packaged
>   proofs had the same flaw):
>   - MP4: within 1 on 1,322 pixels;
>   - baked map: IDENTICAL;
>   - plain warp: 11 pixels by 1 (the soft-edge band, as in dev);
>   - the app equals itself across launches every time.

> ◐ **The plain warp's 11 soft-edge pixels — located, not fixed (2026-11-22).**
> - **Reproduced OFFSCREEN:** `test:projector-parity --screen-case` (the on-screen test's case at 1920×1080)
>   gives the same 11 pixels as the screen. So it is the RENDERER, not the window or the compositor, and it
>   can be worked on without a display.
> - **Isolated by variants of that case:**
>   - without MSAA: still 11;
>   - **without the soft edge: 0**;
>   - with the edge's blend gamma at 1: 7.
>
>   So the residue lives in the soft-edge arithmetic. It is not the anti-aliasing, the picture, the warp or
>   the colour maths.
> - **Three equivalent WGSL rewrites changed nothing:** the division as a reciprocal, the colour product
>   regrouped, the lift as an fma (11 / 10 / 11). The formula is line for line ProjectorGL's (blendGlsl.ts).
>   The difference most likely lies in the shader each side generates: ANGLE's HLSL from GLSL against
>   naga's from WGSL, both probably compiled by FXC (wgpu's `Auto` without a DXC DLL). The app's shader
>   also declares `precision mediump float`.
> - **The generated code compared (owner: "1"), with `node scripts/dump-hlsl.cjs`.** It writes ANGLE's HLSL
>   for the app's ProjectorGL (through `WEBGL_debug_shaders`) and naga's for the engine
>   (`artlux-engine --dump-hlsl`). Ruled out, one by one:
>   - **the HLSL:** the same operations in the same order (only `0.100000001` vs `0.1` — the same f32 —
>     and a scalar vs `.xx`);
>   - **the compiled bytecode:** both compiled with the SDK's fxc (ANGLE's at ps_5_0; naga's at ps_5_1, as
>     wgpu does — FXC, since no `dxcompiler.dll` is on the PATH). The SAME instruction sequence: `div` for
>     the perspective divide, `div_sat` for the feathers, `log`/`mul`/`exp` for the pow, the products in
>     the same order. Two differences change no value: a `max(share, 0)` FXC dropped for ANGLE, and
>     branches against selects;
>   - **FXC's optimiser:** wgpu's DEBUG flag (skip optimisation) changes nothing — 11 again;
>   - **the vertex data:** `artlux-engine --dump-geometry` against homography.ts + ProjectorGL's push. All
>     30 floats are identical (the qs differ in the last f64 bit — libm::hypot vs Math.hypot — but agree as
>     f32);
>   - **the division:** a Newton-corrected division in the WGSL made it WORSE (668 px; 690 even without a
>     soft edge). So the engine's plain `div` already matches the app's.
> - **What is left:** Intel's D3D11 driver (ANGLE's) and D3D12 driver (wgpu's) turn the SAME bytecode into
>   GPU code their own way. That cannot be seen or controlled from WGSL, and it may differ on the RTX PC
>   (another driver). The plain warp stays held to "within 1 on at most 0.01%"; worth re-measuring on
>   NVIDIA rather than chasing further here.

> **2d CAMERA — step 1 done 2026-11-22: the engine reads cameras, and the plan changes on a measurement.**
> - **The owner's brief:** several cameras may be plugged at once. My first recommendation was that the
>   engine opens every camera itself and hands the frames to the app, assuming a webcam takes one process
>   at a time.
> - **Built (`cam.rs`, `artlux-engine --cameras / --camera-grab`):**
>   - Media Foundation's device list: each camera's name, its SYMBOLIC LINK (stable per USB port — two
>     cameras of the same model share a name) and its native formats;
>   - a reader per camera on its own thread, in a native format, no converter;
>   - a CPU preview, for looking only.
>
>   On this PC's Logitech C270: MJPEG, YUY2 and NV12 (NV12 most likely the frame server decoding MJPEG),
>   1280×720 down to 160×120, 5–30 fps. Frames arrive in all three formats. The PS3 Eye (DirectShow) and
>   the NDI virtual cameras are not listed: Media Foundation does not see them.
> - **Measured: a plain Media Foundation open IS exclusive.** A second process fails with 0xC00D3704 ("lack
>   of hardware resources"), with the same format or a different one.
> - **Measured: Windows' SharedReadOnly mode is NOT** (`camshared.rs`, `--camera-shared`, WinRT MediaCapture
>   through the Camera Frame Server). While Chromium held the camera exactly as the app does
>   (`getUserMedia`, 1280×720 MJPEG), the engine read the SAME stream: 59 frames in 4 s, against
>   Chromium's 179 in 12 s — both ~15 fps in this light, so every frame. Chromium was undisturbed. Same with
>   another engine process as the holder.
> - **So the recommendation changes (proposed to the owner): the APP KEEPS ITS CAMERAS, the engine READS
>   THEM SHARED.**
>   - Nothing in the app is rewired: camera surfaces, MediaPipe and calibration stay as they are.
>   - No hand-over, and no camera gap when the engine dies.
>   - Multi-camera works the same: one shared reader per device.
>   - The cost: the format is the app's choice (the controller's), and an MJPEG stream is decoded twice
>     (once in each process). Pictures will not be byte-identical, since JPEG decoders differ: the gate
>     becomes a tolerance, measured.
> - **Not yet:** shared reading as the runtime path, the GPU conversion (camera frames are usually BT.601;
>   yuv.rs draws BT.709 only), the camera's identity (Chromium's hashed deviceId → the engine's symbolic
>   link), several cameras at once (only one here).

> **2d CAMERA — step 2 done 2026-11-22: the shared reader is the engine's camera path (owner: "the app keeps
> its cameras, the engine reads them shared").**
> - **Built:** `camshared::SharedIn` — WinRT MediaCapture, SharedReadOnly, a frame reader whose FrameArrived
>   keeps the latest frame as `cam::Raw` (as `CamIn` and the NDI reader do). `artlux-engine --camera-shared
>   <index> <seconds> [out-prefix]` reads it and writes the last frame.
> - **Measured — the format is the holder's, and it changes what Windows gives a shared reader:**
>   - a YUY2 or NV12 holder: Windows converts to NV12 for the engine (one GPU conversion path later);
>   - an MJPEG holder: Windows REFUSES every conversion (OutputFormatNotSupported, tried NV12, YUY2, BGRA8,
>     ARGB32, RGB32); only the MJPEG itself can be read. So the engine falls back to the compressed frames
>     and will decode them itself. Chromium picks NV12 on most opens of the C270 here, MJPEG on some (the
>     first open after plugging in, and one harness run) — the fallback is not a corner case.
> - **`test:camera-shared`** (holder = `engine/spikes/camera-shared`, getUserMedia exactly as contentSource.ts):
>   - A beside the holder: the engine 89 frames in 6 s, the holder 89 in the same 6 s, its rate 15.0 → 14.8 fps;
>   - B the holder stops its track: the engine KEEPS receiving (15 fps on) — the frame server keeps the device
>     streaming for the remaining reader, no error;
>   - D the engine first, then the holder: Chromium still opens in ITS format (1280×720); the engine's stream
>     dips for one second during the switch and continues;
>   - E an MJPEG holder (cam.rs's exclusive reader, forced MJPEG): MJPEG frames, every one;
>   - C alone: opens (Windows picks YUY2 640×480 → NV12).
>   - Mutation-tested: dropping every other frame fails A and E; removing the MJPEG fallback fails E (and A on a
>     run where Chromium chose MJPEG). Guarded in verify:invariants.
> - **Next (step 3):** the GPU conversion of camera frames (NV12 at BT.601, and an MJPEG decode), measured
>   against the app's own camera VideoFrames; then step 4, the camera's identity (Chromium's deviceId → the
>   symbolic link), and step 5, the takeover test with a camera surface.

> **2d CAMERA — step 3 done 2026-11-22: the engine draws a camera frame as the app does (99.99% identical, max 1).**
> - **The app's frame (measured):** Chromium's camera VideoFrame is I420, labelled BT.601 (smpte170m) LIMITED,
>   primaries BT.709. Drawn 1:1 into a 2D canvas it is the standard BT.601 limited conversion.
> - **The engine's frame of the same image is NOT the same bytes:** beside Chromium the shared reader's NV12
>   says NOMINAL_RANGE 0–255 (FULL) and YUV_MATRIX BT.601 in its attributes; alone (YUY2 → NV12) it says
>   nothing. The app's I420 is EXACTLY the full frame compressed to limited range — every one of the 256 Y
>   values: Y' = ((Y × 3517 + b) >> 12) + 16 (a 12-bit fixed-point scale; b in 2035..2054; plain
>   round(16 + Y × 219/255) misses 7 values), and C' = round(128 + (C − 128) × 224/255) for every chroma
>   sample. Which side does the compression (Windows for Chromium's request, or Chromium) is not known.
> - **Pairing trap:** Chromium stamps an image ONE FRAME LATER than Windows (~64–70 ms at 15 fps, same clock),
>   so the nearest timestamp is the wrong frame (mean |ΔY| 1.76 vs 0.25). Frames are paired by content.
> - **Built:** `cam::picture(gpu, conv, raw, app_space)` — a full-range frame for a limited-range app is
>   requantised as measured, then converted on the GPU (`yuv::GpuConvert::picture_in`, BT.601 now too);
>   `camshared` reads each frame's range and matrix from its attributes (none = BT.601 limited).
>   `--camera-dump` / `--camera-convert` for the harness.
> - **The MP4 shader did NOT move — and nearly did.** Passing the colour space as a uniform (f32 at run time,
>   or coefficients folded in f64, or in f32) changed the MP4 picture by 1–90 channels per test file against
>   the previous engine (a baseline engine built from the last commit, same harness). The colour space is now
>   written into the WGSL as literals; BT.709 limited is the former shader text exactly (unit test), and the
>   MP4 numbers are the baseline's to the channel.
> - **`test:camera-shared` gate F:** 12 frames paired, worst 99.992% of channels identical, max 1. Mutations:
>   no requantisation → max 8; BT.709 → max 11. Guarded in verify:invariants.
> - **Not measured: MJPEG.** Beside an MJPEG holder the engine decodes the JPEG itself (`image` crate); Chromium
>   picked NV12 on every run today, so there was no MJPEG app frame to hold it against. Also only this C270, in
>   one (mostly grey) scene.
> - **Next (step 4):** the camera's identity — the app's camera (Chromium's salted deviceId + label) → the
>   engine's symbolic link; then step 5, the runtime: a camera surface on the engine's LEDs and projectors
>   (the host sends the app frame's colour space, as it does for MP4), and the takeover test.

> **2d CAMERA — step 4 done 2026-11-22: WHICH camera (the app's camera → the engine's).**
> - **Measured:** Chromium's track label is "<Windows friendly name> (<vid>:<pid>)" ("Logi C270 HD WebCam
>   (046d:0825)"); its deviceId is an HMAC salted per profile (nothing Windows knows). The engine's symbolic
>   link carries the same vid/pid. The PS3 Eye is listed by Chromium ("PS3 Eye Universal", no ids) and not by
>   Media Foundation.
> - **Built:** `cam::resolve(label, app fingerprint)` (`--camera-resolve`):
>   - one camera with that name and vid:pid → it (different models: the usual case);
>   - none → REFUSED (DirectShow-only; the app keeps that surface);
>   - several (the same model twice) → by PICTURE: each candidate is read shared, its fingerprint compared
>     with the app's, and the most alike wins only when alike (correlation ≥ 0.8) and clearly more than the
>     next (by ≥ 0.2); otherwise REFUSED — never a guess. Without the app's fingerprint: REFUSED.
>   - The fingerprint is the app's own code, `src/renderer/engine/cameraFingerprint.ts` (16 × 9 mean luma of
>     the VideoFrame's Y plane); `cam::fingerprint` computes it from an engine frame (requantised to the app's
>     range). Correlation, not distance: auto exposure moved the same camera's mean distance to 1.7–4 levels
>     between the app's fingerprint and the engine's read; a correlation ignores gain and offset, and a flat
>     picture (a black stage) scores 0, so it can never decide.
> - **`test:camera-shared` gate G** (one camera here, so a TEST-ONLY decoy, `ARTLUX_CAM_TWIN`, reads the real
>   camera as a second one of the same model — its picture as is, or rotated 180°): label → the C270; twin with
>   the same picture → REFUSED (1.000 vs 1.000); twin looking elsewhere → the real one (1.000 vs −0.36); the
>   app's picture flipped → the twin; no picture → REFUSED; PS3 Eye → REFUSED. Mutations (no margin; least
>   alike first) fail it. Motion in front of the camera between the two fingerprints lowered the true
>   likeness to 0.73–0.86 on one run: refused, then right on a retry — the runtime will retry too.
> - **F made robust:** an engine frame whose twin fell outside the app's dump window was mis-paired (max 34–55,
>   a wrong frame, not a wrong conversion); only exact twins count now (mean |dY| ≤ 0.6, measured 0.24).
> - **Not tried:** two REAL cameras of one model. **Next (step 5):** the runtime — the host sends each camera
>   surface's label, fingerprint and colour space; the engine resolves, reads shared, draws; then the takeover
>   test with a camera surface.

> **2d CAMERA — step 5 (runtime) built 2026-11-22; the engine takes a camera only in the measured case.**
> - **Built:** the host describes a camera surface from the app's OWN live VideoFrame (`contentSource.ts
>   cameraNativeSource`): its track label, the frame's colour space, and `twins` (another video input with the
>   same label). Only I420/NV12 BT.601 limited goes; anything else stays the app's with the reason. For twins the
>   tick carries the app's fingerprint (`camfp`, refreshed ~1 s). The engine (`runtime.rs` Source::Camera)
>   resolves the camera (cam::resolve), reads it SHARED, draws the newest frame through cam::picture; twins wait
>   for the picture, and once resolved the engine answers the SAME document again (serve.rs `redo`; main takes
>   a later answer for the current revision).
> - **Measured — the real app opens the C270 as MJPEG** (1280×720 at 30, 3 launches of 3), while a bare Electron
>   page with the same request gets NV12 every time (sandboxed or not, with or without the app's switches — the
>   cause is not found). The engine REFUSES a holder streaming MJPEG: its MJPEG decode is not measured against
>   Chromium's. So in the real app today the camera surface stays the app's, with that reason, and the engine
>   keeps nothing else from it (all or nothing: the whole wire stays the app's while a sampled camera is refused).
>   A first attempt to dump the app's own MJPEG-derived frames over CDP (a second getUserMedia in its page) hung.
> - **`test:native-takeover --camera`** adds a camera surface (universe 7): run A the app lights it; run B the
>   engine refuses it (MJPEG) — the test FAILS honestly until MJPEG is measured. Without `--camera` the test is
>   unchanged and passes (stills/lights/Spout/NDI identical, MP4 within 1, handback 56 ms).
> - **Not tried:** a camera when the app captures through DirectShow (`ARTLUX_DSHOW_CAPTURE=1`).
> - **Next:** a dev-only hook in the app that writes its own camera frames, to measure the engine's MJPEG decode
>   against them; then the camera takeover.

## 9e. E2 — shaders in the engine (owner, 2026-11-24: "make sure we can draw shaders" → "the remaining plan")

> ✅ **E2 shaders done 2026-11-24.** `engine/artlux-engine/src/shader.rs`:
> - **The author's text is never edited.** The engine wraps it the way `plugins/shader/src/wrapper.ts` does,
>   for naga's GLSL front end instead of WebGL: the uniforms live in ONE std140 block (naga takes no loose
>   uniforms) and the names the author reads are private globals filled at the top of `main` (a real
>   `float iAudio[16]`, not a vec4[4]); `palette()` and `lastFrame` are a texture + a sampler
>   (`lastFrame` a macro for `sampler2D(tex, samp)`); `iPeople`/`iPeopleMotion` are macros onto the block (no
>   96-vec4 copy per pixel). naga → WGSL → wgpu. WebGL's BOTTOM-left window origin is kept where an author
>   can see it: `gl_FragCoord` is turned back, `dFdy` keeps GL's sign, the feedback history is stored in GL's
>   row order (one flip pass per frame), and vUv is built bottom-up as the app's.
> - **"The host evaluates, the engine draws."** The SDK's `ContentSourceProvider` gained optional
>   `nativeSource` / `nativeTick`; core `contentSource.nativeSource` asks a plugin type's provider. The shader
>   plugin answers with the text the app is RUNNING (the last that compiled, if an edit is broken), its header
>   inputs and their GLSL types, and the main window's raster (`sizeFor`); each tick `nativeUniforms` sends
>   what `renderToBitmap` uploads, from the same taps: wall time and frame, the enveloped sound, the beat with
>   the shader's own damper, the people (only for a shader that reads them), each input as one vec4.
> - **One runner per surface** (its program, its feedback history). A surface on an ENGINE projector output is
>   drawn AGAIN by a second runner at that display's CSS size (main sends `css`) — as the app's projector
>   window runs its own copy at its own size. A surface the app's guard DISABLED is sent with `hold`: the
>   engine keeps its last picture (it first answered "unsupported" and the engine's picture went BLACK where
>   the app's froze — found with the 3D view and the engine window open). A text naga refuses leaves the show
>   to the app with naga's log (`verdict`).
> - **Proof** (packaged Show, scratch profiles):
>   - `test:shader-parity` — every shader ArtLux ships (12 starters, the cookbook, the node editor's 8
>     examples, every SHADER surface in examples/ — 28 unique) compiles, and renders within 1 of 255 of the
>     app's own WebGL program in ArtLux's Chromium, over three show times (feedback carried), EXCEPT the 3
>     built on the `fract(sin(x)*43758)` hash: ANGLE's HLSL and naga's are the same expression (dumped and
>     compared), but the app compiles through D3D11 and the engine through D3D12, and one ulp of `sin`
>     amplified 43 758× moves the grain (2–9 % of channels). Reported, not gated; the app's own picture
>     already differs that way between GPUs; SHADERS.md tells the operator.
>   - `test:shader-wire` — the engine owns the wire; two still shaders (one reading a palette input) give
>     IDENTICAL Art-Net on strips and serpentine matrices (4 universes); the moving plasma moves and every
>     engine payload equals one the app sent (median 0.00 levels).
>   - `test:shader-projector` — a still shader on a keystoned, soft-edged, colour-corrected projector output:
>     the engine's screen = the app's, 0 of 2 073 600 pixels apart by more than 1 (it was 10 % apart while the
>     engine drew at the editor's raster — the second runner fixed it).
>   - The engine's 3D view window shows shader screens (multi-projector example), matching the editor.
>   - `verify:invariants`: every uniform in wrapper.ts UNIFORMS exists in shader.rs; a disabled shader is
>     sent as `hold` and held (mutation-tested both). `test:engine-runtime` unchanged.
> - **Not covered:** a shader on a LAYER / timeline clip (layers stay the app's — E3), the offline bake (E6),
>   shaders reading sound/people verified only through the live wire test's plasma (no sound/people in it).

> ✅ **E2 text done 2026-11-24 — a RASTER source (§2 "phase 1: the app rasterises, the engine receives an image
> on change").** Generic, so other app-drawn sources can use it: the SDK's `nativeRaster(key, content, budget?)`
> hands the host a bitmap and a generation; `nativeLink.shipRasters` ships a surface's pixels when its BITMAP
> changes (identity — the plugin's generation restarts at 1 after a release), BEFORE the document naming the
> source; main writes the file and sends `{"type":"raster"}` (`engineHost.noteRaster`), replaying every raster
> before the document to a restarted engine; the engine holds it as a canvas picture (`runtime.raster`). A
> surface on an enabled projector output gets a second raster at that display's CSS size (`<id>@proj`; main
> answers `nativeEngineDisplays`), which the engine's projector shows — as the app's projector window draws
> type at its own size.
> - **Proof:** `test:text-wire` — a bold word, a wrapped stroked paragraph, a turned and scaled white word on
>   strips and serpentine matrices: IDENTICAL Art-Net on all 5 universes, every one lit;
>   `test:shader-projector --text` — type on a keystoned, soft-edged output: 0 of 2 073 600 screen pixels apart
>   by more than 1. `verify:invariants`: rasters before the document, on first send and on restart
>   (mutation-tested).
> - **Found on the way — an APP bug, fixed in both samplers:** an RGB (3-channel) fixture whose RGBW mode was
>   never set kept the hidden default SUBTRACT (W = min(r,g,b) taken out of r, g, b) and the packer dropped
>   that W: white and grey went BLACK on the wire, and the inspector shows the White control only on
>   4-channel fixtures. The test's white word was black in BOTH runs — identically, which is why parity alone
>   did not catch it; the "every universe lit" gate did. `ledLayout.buildSegParams` and the engine's
>   `build_seg_params` now keep full RGB for 3 channels (no project in examples/ or the owner's recent list
>   was affected); `test:sampling-parity` (60 cases) and `test:pack-parity` still identical; guarded.
> - **Limit:** MOVING text (keyframed position / rotation / scale) is re-shipped on every frame it moves —
>   ~3.7 MB per frame at 720p. Fine for a caption, wasteful for a constantly animated title; `glyphon` in the
>   engine is the later answer (§2).

> ✅ **E2 tracking done 2026-11-24 — TRACKING, AUGMENTA and MEDIAPIPE markers drawn by the engine** (§2 "data H,
> drawing E"). `engine/artlux-engine/src/blobs.rs` ports blobPass (posePass's markers are the same shader and
> geometry): the trail ribbons then the markers, ONE / ONE_MINUS_SRC_ALPHA, premultiplied, 4× MSAA as the
> app's `antialias: true` canvas, geometry built on the CPU exactly as `drawBlobs` / `drawSolid`. The app
> keeps the MATHS — motion filter, prediction, calibration transform, colours, trails — and each drawable now
> keeps what its own draw drew this frame; `nativeTick` hands that over as it is (no second evaluation at
> another `now`). The app keeps a surface with a background timeline layer or its 2D overlay (calibration /
> id labels; MediaPipe's skeleton / id labels), with the reason.
> - **Proof:** `test:tracking-wire` — the repo's LiDAR emitter through both runs, a SOL surface with trails on a
>   strip and a full-floor serpentine matrix: the engine owns the wire, the picture moves (46 / 121 distinct
>   payloads), the LEDs are lit, and each engine payload is as close to some app payload as the app's own
>   consecutive frames are to each other (strip median 0.00, matrix 0.15 vs the app's step 0.32 / 0.48).
>   `verify:invariants`: the four copies of the marker shader carry the same numbers (mutation-tested).
> - **Not covered:** Augmenta and MediaPipe were not driven live (no Augmenta sender or camera pose in the
>   harness) — they share the drawing code and the hook shape with the tested LiDAR path; a tracking surface
>   on an engine projector output was not measured on screen (moving content: the projector windows run
>   their own clock — a screen comparison needs a frozen take).

## 9f. E3 — the timeline in the engine (owner, 2026-11-24: "the remaining plan")

> ✅ **E3a done 2026-11-24 — the timeline COMPOSITE in the engine, for content clips.** The composite is far
> smaller than the 2.2k-line timeline: `compositeLayers` stretches each contributing track's picture over a
> transparent Canvas2D canvas, back-most first, with the clip alpha (content opacity × linear fades) baked in and
> the track's opacity and blend (normal / add→lighter / screen / multiply) applied; no clip transitions,
> transforms or filters exist. So, "the host evaluates, the engine draws":
> - **App:** `contributingLayers` is now the ONE list of what muted / solo / enabled / a non-picture lane mean;
>   `compositeLayers` draws it and `timeline.nativeLayers` reports it with each track's active clip, its clip
>   alpha, its clip-local time, the track's opacity and blend. `surfaceMedia.compositeNativeSource` turns a
>   LAYER / stack / PROGRAM surface into `{kind:'comp'}` with each track's clip as a hidden source `layer:<id>`
>   (the existing image / shader / text-raster / effect sources); the per-frame alpha and clip time ride the
>   tick, so a fade does not re-send the document.
> - **Engine:** hidden `layer:` sources are drawn like surfaces' (a clip's shader and effect at its clip-local
>   time); `comp.rs` composites them — premultiplied, a ping-pong pair of 8-bit targets (each Canvas2D draw
>   lands in 8 bits), bilinear stretch with no mips (drawImage, quality 'low'), the W3C formulas for the four
>   operations. A single LAYER surface is its track's picture, its clip alpha baked in under 0.999, as
>   `layerDrawable`. The canvas is the app's own (program / stack size, sent with the document).
> - **Proof:** `test:timeline-wire` — a text clip at content opacity 0.5 (the baked-fade path), a still shader
>   track at 0.6 SCREEN, an image track; the PROGRAM, the single faded track and a 2-track STACK on strips and
>   matrices: the engine owns the wire, every universe lit, every channel within 1 of the app's (the app keeps
>   8-bit intermediates — the fade scratch, the composite canvas — that the engine does not; ±1 rounding).
>   `verify:invariants`: nativeLayers and compositeLayers read the one list; comp.rs maps the blend modes as
>   blendOp does (mutation-tested). Shader / text / tracking / runtime tests unchanged.
> - **Measured on the way — Chromium rounds the MODULATED source to 8 bits before it blends.** With the source ×
>   globalAlpha kept in float, an Add at 0.5 was 288 channels apart (up to 2); rounding it first (comp.rs) took
>   that to 12–22 within 1, and the E3a test from 146 / 177 / 243 / 201 / 283 channels apart to 8 / 15 / 9 / 0 / 3.
>
> ✅ **E3b done 2026-11-24 — VIDEO clips on tracks**, through the codec playing them. `timeline.nativeLayers`
> reports a track's codec (HAP / MP4), file, the frame it shows and the codec's own `layerGeneration` (HAP: the
> frame index; MP4: the VideoFrame timestamp of the track's own decoder) — the same identities a surface's
> HAP / MP4 already ride the tick with (2c-4), so a track is a hidden `layer:<id>` HAP / MP4 source and the
> engine shows the frame the app shows. An MP4 track's frame is judged as a surface's (8-bit NV12, BT.709
> limited); the engine opens an MP4 decoder per TRACK. A track playing through a `<video>` element (no codec
> plugin claims the file) has no exact frame to hand over and stays the app's, with the reason.
> - **Proof:** `test:timeline-video-wire --hap <clip.mov>` — the still MP4 test clip alone on a track, a HAP clip
>   alone on a track, and the PROGRAM with the HAP track ADDed at 0.5 over the MP4 track (the MP4 stretched to the
>   app's 1920-wide program canvas): identical on both single tracks (one matrix channel within 1), the program
>   within 1 (22 of 512 channels), every universe lit, the engine owning the wire. Muting the HAP track makes the
>   program identical — the stretch is exact; the residue is the blend's rounding.
> - **Not covered:** a MOVING video track measured on the wire (the tests rest the playhead so the bytes can be
>   compared; a surface's MP4 was proven moving in 2c-4 with the same frame identity), crossing a clip boundary.
> - **Next:** the CLOCK (§4: time evaluated in Rust on the audio clock), JUCE in the engine process, and
>   lighting evaluation — each needs the parity harness §4 asks for before the TypeScript path goes.
>
> ✅ **E3c done 2026-11-24 — the time evaluators in Rust, and the PARITY HARNESS §4 asks for.** `eval.rs` ports,
> line for line, `segmentEase` (every EASE_FN ease, bezier, linear / unknown), `bezierEase`, `sampleLane` (hold
> before / after, coincident keys step, `hold`, log targets), `clipFadeAlpha`, `layerAlpha` and the clip-local
> time. Two harnesses, as §4 asks — offline AND on the show:
> - **`test:eval-parity`** bundles the app's OWN evaluators from source (esbuild — nothing copied) and runs them
>   and the engine's (`--eval-cases`) on one list: every curve kind on a dense grid, 300 random beziers (degenerate
>   handles, overshoot), 200 random lanes (coincident keys, log targets) before / across / after their keys, 200
>   clips with fades, and every automation lane and clip of every example project (the "recorded shows") across
>   its span — 79k cases, worst |TS − Rust| 2.7e-10 (V8 pow / sin against the C runtime's), and the app's
>   frame-to-frame cursor gives the searched answer. Mutation: 0.9375 → 0.9376 in one bounce arm fails 395 cases.
> - **On the show:** the tick now carries the PLAYHEAD and the document each track's clip timing; the engine
>   evaluates every composited track's clip alpha and clip-local time ITSELF and draws its own values
>   (runtime `evaluate_clock`). The app still sends its values, and each is CHECKED — a difference is logged
>   (`clock: differs`). `test:clock-parity`: a looping 6 s show plays itself for 24 s (overlapping fades, a gap, a
>   trimmed clip, content opacity, ADD at 0.7) — 12 clip-boundary documents, **0 differences**, the fades on the
>   wire; a clip time off by 1 ms is caught on the first frame (mutation). The timeline / video wire tests still
>   pass on the engine's values.
> - `verify:invariants`: every EASE_FN name has an arm in eval.rs, the bezier default matches, layerAlpha and
>   the clip-time formula are the ported ones, the tick carries the playhead (mutation-tested).
> - **Not yet:** automation lanes and colour / lighting keys evaluated BY the engine on the show (the sampler is
>   ported and proven; the app's automation writes surface params the engine reads through the document —
>   moving that to a per-tick evaluation is the next step), and the playhead itself from the audio clock (JUCE
>   in the engine process).
>
> ✅ **E3d done 2026-11-24 — AUTOMATION LANES SAMPLED BY THE ENGINE.** Before, an automated opacity changed the
> app's effective surfaces every frame, so nativeLink RE-SENT THE WHOLE DOCUMENT every frame of a curve. Now:
> - **App:** `nativeLink.engineLane` names the lanes the engine owns — `surfaces.<id>.content.{opacity, speed,
>   intensity}`, the leaves the engine reads off the surface (compose.rs opacity, effects.rs Params). The
>   document carries the surfaces WITHOUT those values (`automationOverlay.applyExcept` — the same arrays when
>   only engine lanes run, so nothing is re-sent) plus the compiled lanes (`timeline.nativeLanes`: keys clamped
>   and sorted as sampled, log, eps, which clock). The tick carries the app's value per lane (`auto`). While a
>   scene FADE runs (it lands on the curve, after it) the engine gets the fully resolved surfaces, as before.
>   Text, fixture, global and audio lanes stay the app's (text shapes a raster the app draws; lights and the
>   master reach the engine resolved).
> - **Engine:** `evaluate_lanes` samples each lane at its clock (show time or playhead) with eval.rs and lays it
>   over the authored opacity / effect params — EXACTLY. Found on the way: the app pushes a lane only once it
>   moved by eps (half a UI step — a guard for the audio lock), so a slow ramp advances there every few frames
>   in a phase set by when sampling began; a copy of that hysteresis cannot follow the phase (the first run
>   differed on every lane by up to eps). By construction the app's held value is within eps of the exact
>   sample, so THAT is the check: further apart logs `automation: differs`.
> - **Proof:** `test:automation-parity` — a looping show plays itself for 24 s with an image's opacity on
>   eased / bezier / hold / bounce keys and an effect's speed and intensity: 0 differences over 600+ ticks, the
>   DOCUMENT SENT ONCE for the whole run, the curve on the wire; a 50 ms clock skew is caught (mutation).
>   `verify:invariants`: every leaf engineLane names is applied by runtime.rs, the lanes are withheld under a
>   fade. Clock / timeline / video / shader / text wire, eval parity and the runtime test unchanged.
> - **Not yet:** a scene-fade-over-a-lane run on the wire, colour lanes and lighting takes in the engine, and
>   the playhead from the audio clock.
>
> ✅ **E3e done 2026-11-24 — THE LIGHT SHOW EVALUATED BY THE ENGINE, and checked on the show.** `light.rs` ports
> lightingTake (`sampleRole` — take / generated effect / pose sequence, phase spread in all four modes, scale,
> offset, mirror, wrap; `rolesOf`; `centreOf`), lightingSequence (`compile` — inline slots, `poseRef`,
> `roleCurves`), the lightingPlayback loop (active clips in timeline order, a group's fixtures in the group's
> order, **HTP** for intensity / colour roles and LTP for the rest — lightingOverlay), colorSample + colorEngine
> (`sampleColorLane`, rgb / hsv / oklab paths, temperature colour, palette refs that resolve to NOTHING when
> missing) and the colorPlayback loop.
> - **Found on the way:** the `random` spread mode hashes through `sin(n·127.1)·43758.5453`, which multiplies a
>   one-ulp difference between V8's sin and the C runtime's by 43758 — 15 cases apart by ~1.5e-9. The engine
>   already carries fdlibm (`libm`, added in E1b for the LED layout's cos/sin); with it the worst case is 7.9e-12.
>   eval.rs now uses it for its pow / sin / cos / log / exp too.
> - **Offline:** `test:light-eval-parity` — the app's own lightingTake / lightingSequence / colorSample /
>   colorEngine bundled from source against `--light-cases`: 79k cases (every spread mode over totals 1–24, 160
>   random take / effect / sequence clips per fixture across and past the take, 160 random colour lanes with refs
>   and every path, 2000 mixes, the example projects' lighting clip) — identical role sets, worst 7.9e-12.
> - **On the show:** the document carries what the two players read (`lightingDoc`: lighting clips, the takes and
>   sequences they name, poses, groups, the rig's ids, colour lanes, palette) and the tick the overlays' values
>   (`lroles`, `lcolors`); the engine evaluates at the playhead and CHECKS — same fixtures, same roles, every value
>   within 1e-9, or `lighting: differs`. `test:light-show-parity`: the recorded-busk example plus a wing-spread
>   sine on the washes, a pose sequence (block spread, scale, offset, mirror) over the take's movers and a square
>   strobe on the same dimmers, two colour lanes (block-spread rgb → cct → palette → rgb; a fixture lane in hsv):
>   721 ticks, up to 18 role values and 3 colours a tick, **0 differing**. Mutation: dimmer taken out of HTP →
>   caught at 5.0 s, where the strobe meets the sequence.
> - `verify:invariants`: the HTP role list and the warm / cold white match the app's (mutation-tested).
> - **Still the app's:** the light BYTES — the packer solves roles and colours into DMX per profile and mode,
>   under the precedence stack (profile default < authored < lighting clip < pose cue < automation < live). That
>   solve (colorEngine `realiseColor` / `solveEmitters`, frameEngine `packLight`) is the next port, checked
>   byte-for-byte against the `lights` the tick already carries. → **done in E3f, below.**
>
> ✅ **E3f done 2026-11-24 — EVERY LIGHT'S DMX SOLVED BY THE ENGINE, and the engine's bytes on the wire.**
> `lightpack.rs` ports profilePack (`modeOf` — a repeated mode key resolves to the first; `modePlan` — a slot per
> offset, a 16/24-bit channel split over the bytes THIS MODE emits, an undefined channel still occupying its slot,
> a repeated channel key resolving to the LAST channel as `new Map` does; `channelValue`; `packProfiled`),
> colorEngine (`colorCapability`, the bounded least-squares `fit`, `solveEmitters`, `flagsForColor`,
> `solveTemperature`, `temperatureOf`, `nearestSlot`, `realiseColor`), fixtureSignal (`EMITTERS`, `colorModel`)
> and frameEngine's precedence stack (live fader > lane-owned channel > colour lane > pose cue > lighting clip >
> RGB→CMY bridge on a subtractive head > authored > profile default). JavaScript semantics kept: Math.round half
> up, Math.max / min with NaN, `>>` on Int32 with the count mod 32, NaN → 0 on the wire.
> - **Found on the way — the wire depended on HISTORY.** `solveCached` keyed its memo on the colour quantised to
>   1/255 but solved the colour that FIRST reached the bucket, so a colour lane fading through a bucket wrote the
>   bytes of whichever frame opened it, and the same playhead could put different bytes on the wire depending on
>   what had played before. No evaluator from the playhead can follow that. The app now solves the bucket's own
>   (quantised) colour — the precision the key always promised — and the engine does the same.
> - **Offline:** `test:light-pack-parity` — the app's packProfiled / realiseColor / colorModel bundled from source
>   against `--pack-cases`, on EVERY MODE of the shipped library (1683 modes of 519 profiles): 4 packs per mode
>   with random authored values (and junk), clip roles in physical units, cues, colours, owned channels and live
>   faders, plus 9 colour realisations per mode — 21879 cases, 53079 bytes, **all identical**, realised roles
>   exactly equal. Mutation: the fit's stop loosened 1e-7 → 1e-6 → 11765 cases fail.
> - **On the show:** the document carries the lights' profiles (`profiles`: channels + the modes the rig can
>   resolve to); the tick carries what are events, not time — the fired pose cue (`lcue`, lightingCue snapshot),
>   the faders under a hand (`llive`, recorded by frameEngine as the live layer is read) and the lane-owned light
>   channels (`lown`). The engine packs every light from the document's fixture and ITS OWN light-show
>   evaluation (the app's `lroles` / `lcolors` when it does not evaluate the show), checks against `lights`
>   (`light bytes: differs`), and **places its own bytes**; the app's stand in for a tick it did not solve (no
>   document yet, an older host). `test:light-bytes`: the light-show-parity show plus a CMY spot (ayrton diablo-s,
>   driven through the RGB→CMY bridge), a tuneable-white key (aputure ls-600x-pro, a colour lane solved as a
>   temperature) and an automation lane on a wash's dimmer — 8 lights, 120 bytes a tick, 841 ticks, **0
>   differing**. Mutations: lane ownership ignored → wash 1's dimmer caught at 0.01 s; the CMY bridge inverted →
>   the spot's cyan caught at 0.06 s. Wire proof: the engine's first byte of every light forced to 77 → 77 on the
>   wire on 1936 of 1938 ArtDmx frames (the other two precede the document).
> - `verify:invariants`: the emitter table, the RGB→CMY bridge, the fit's 6000-pass cap and 1e-7 stop and the
>   quantised solve match the app's (mutation-tested).
> - **Still the app's:** the pose cue, live faders and automation on light channels (events; sent per tick), the
>   3D beams' resolved state (fixtureSignal.resolveFixture). Next in E3: the playhead from the audio clock, and a
>   scene-fade-over-lane wire test. → **the wire test is done, below.**
>
> ✅ **E3d follow-up done 2026-11-24 — A SCENE FADE OVER A RUNNING LANE, on the wire; and the app bug it found.**
> `test:fade-over-lane-wire`: two states bound to two scenes, each scene's own timeline running an opacity curve
> on one white surface, the state machine crossfading A ↔ B over 3 s every few seconds — so every fade hands the
> lane from the engine to the app (frameEngine withholds the lanes while a fade runs) and back. Run A (the app)
> and run B (the engine owning the wire) each record the strip's level per ArtDmx frame; a flash is a step
> between consecutive frames.
> - **First run: both runs stepped 98 of 255 at every GO — identically.** The engine was faithful; the APP
>   snapped. A recall (and a cue) faded FROM the committed look, so over a running lane the stage jumped from
>   the curve (0.78) to the outgoing scene's authored value (0.6) and only then glided onto the incoming curve;
>   a GO landing mid-fade restarted from the committed value too. Traced with per-frame logs in a packaged build.
> - **Fix:** `frameEngine.onStage()` — the last frame's look with lanes and fades applied, recorded after the
>   fade — is what both GO paths (handleRecallScene, applyCues) fade from. docs/SCENES.md says so;
>   `verify:invariants` guards it ("a GO fades from the look as it is on stage").
> - **After:** largest step 3 in both runs (the curves themselves); the engine handed the lane over on all 7
>   fades, never `automation: differs`.
> - The repo's scene / state-machine CDP tests (test-scene-timelines, test-zone-fsm, test-hold-at-end, …) still
>   launch on the owner's profile and were NOT run; they need moving to a scratch `--user-data-dir` first.
>
> ✅ **E3g done 2026-11-24 — THE ENGINE RUNS ITS OWN TRANSPORT CLOCK (stage 1 of §4's audio clock).** Until now
> the engine was TOLD the playhead every frame (`ph`). The app's two clocks (runFrame) are `(now − origin) / 1000`
> clamped to the in-point, wrapped over `[a, b)` when looping, parked one frame short of `b` when not — rules that
> re-anchor the origin only to values the same rules reproduce, so they are a function of (now, origin, region).
> What cannot be derived are the EVENTS, and those are now recorded:
> - **App:** `timeline.ts markAnchor()` records a `TransportAnchor` (both origins, positions, regions, loop flags,
>   frame lengths, the renderClock time it became true, `performance.timeOrigin`) at every event and nowhere else:
>   `mainSeek`, `showSeekInternal`, `setPlaying` (play AND pause), `setData`, `swap`, `setGlobalDoc`, `start`, the
>   two underrun clamps (at the frame time) and the render-clock flip. The tick carries `fm` (the frame time the
>   playhead was computed for) and `tp` (the anchor, when it changes and once a second).
> - **Engine:** `transport.rs` runs runFrame's rules (`step_one` — the same IEEE operations, re-anchoring where the
>   app does) from the latest anchor, and CHECKS both clocks against the app's at `fm` — the same instant, so they
>   must agree to 1 µs; a frame computed before its anchor (`fm < at`: an event landed between two frames) is not
>   checked. It also reads its OWN wall clock when the tick arrives (SystemTime − the anchor's `w0`) — how far the
>   app's frame trails the engine's clock. A bake (`off`) is not checked: the render owns time.
> - **Proof:** `test:transport-clock` — a looping show plays itself and is then driven over OSC: pause, play, a seek
>   while playing, a seek just short of the wrap, pause, a seek while paused, play, loop OFF (it runs out, parks on
>   5.9667 s and pauses), play from the parked end (the restart), stop, play: 900 frames run by the engine's clock,
>   **0 differing**, every event an anchor in the engine's log; the engine's own clock leads the app's frames by
>   0.57 ms on average (21 ms at worst — a frame's trip through main). Mutation: the engine's clock skewed by 1 ms
>   (`ARTLUX_TRANSPORT_SKEW_MS`) → caught on the first frame. test:clock-parity and test:automation-parity unchanged.
> - `verify:invariants`: every event function records an anchor, the two underrun clamps do, the number of origin
>   assignments in timeline.ts is pinned (a new one must be classified: an event → markAnchor, a rule → ported),
>   the wrap and the park are the same formula on both sides (mutation-tested: setPlaying without its anchor).
> - **Next (stage 2):** the evaluators driven from the engine's own clock (read at its tick, not at `fm`) — the
>   engine then needs `ph` only as the check — and then JUCE in the engine process, so that clock IS the audio
>   clock and picture, sound and DMX share it. → **lanes and lights done in E3h, below.**
>
> ✅ **E3h done 2026-11-24 — LANES AND LIGHTS DRAWN AT THE ENGINE'S OWN CLOCK (stage 2, part 1).** runtime
> `draw_clock` reads the transport off the engine's wall clock as the tick is handled (transport.rs `own`), and
> that is what the automation lanes are sampled at and the light show is evaluated and SOLVED at — the bytes on
> the wire. Every CHECK stays at the app's instant (`ph` / `t`), where the app's values are true: lanes against
> `auto`, the show against `lroles` / `lcolors`, the bytes against `lights` — the light solve runs twice when the
> clocks differ (once to check, once to place). The app's numbers are drawn instead when the engine has no clock
> (no anchor yet, a bake) or it is more than 0.25 s from the app's frame (an event the app has not drawn yet, a
> loop wrap between the two).
> - **Proof:** `test:light-bytes` — 8 lights, 0 ticks differing at the app's instant; 600 of 601 ticks drawn at the
>   engine's clock, every one placing bytes the clock had moved on from the app's frame (16-bit fine channels move
>   within a millisecond; the largest step, 247, is the square strobe's edge or a fine byte rolling over). The
>   engine's clock led the app's frames by 2 ms on average and 74 ms once — a stalled app frame, which the engine
>   no longer draws late. test:automation-parity (0 differences, the curves on the wire), test:fade-over-lane-wire
>   (largest step 4, 7 hand-overs) and test:transport-clock unchanged.
> - `verify:invariants` (in the transport check): draw_clock reads the engine's clock, the lane and show checks
>   stay at the app's instant, the composite does NOT use the drawn clock (mutation-tested).
> - **Not yet — the composite.** The document carries each track's ACTIVE clip at the app's playhead and the app
>   decodes the video frames, so a track drawn later than the app's frame could cross a clip boundary the
>   document does not describe yet. It needs every clip of a track in the document (as the lighting clips
>   already are) and the engine's own decode (HAP / MP4 are already in the engine, E1d / E3b); then JUCE.
>   → **the composite's time done in E3i, below; the picture across a boundary still needs the engine's decode.**
>
> ✅ **E3i done 2026-11-24 — THE COMPOSITE AT THE ENGINE'S OWN CLOCK, and the engine CHOOSES each track's clip.**
> The composite document now carries each track's clip SPANS (id, start, duration — every clip of the track in
> `data.clips` order) and the described clip's id; eval.rs `active_clip` ports timeline.ts `activeClip` (half-open
> spans, the later clip wins an overlap). runtime `evaluate_clock`:
> - **Checks** at the app's playhead, as before (clip alpha and clip-local time), and now the CHOICE too: the clip
>   under the playhead must be the one the document describes (`clock: differs — … clip`).
> - **Draws** each track's alpha and clip time (which an effect or a shader on the track runs at) at the engine's
>   own clock — while the clip under that clock is still the described one. Across a boundary the app has not
>   reached yet (the document still holds the outgoing clip's picture and timing) the track is drawn at the app's
>   playhead for that tick: never a clip the document does not describe.
> - **Proof:** `test:clock-parity` — 10 documents over two loops, **0 differences** (choice included), tracks drawn at
>   the engine's clock 1818 times, held 0 times (the clocks are ~2 ms apart); and a second run with the engine's clock
>   pushed 100 ms AHEAD: 1767 drawn at its clock, **24 held** at a boundary, still 0 differences. test:timeline-wire,
>   test:timeline-video-wire (HAP + MP4 tracks), test:transport-clock, test:automation-parity unchanged.
> - `verify:invariants`: the boundary rule guards the drawn clock, `active_clip` is activeClip's port, the spans are
>   in activeClip's order (mutation-tested: the rule removed).
> - **Not yet:** the picture itself across a boundary (the next clip's source and, for video, its frame) — that is
>   the engine owning the decode of every clip, not only the active one; then JUCE in the engine process.
>
> ✅ **E3j done 2026-11-24 — THE ENGINE CHOOSES A VIDEO TRACK'S FRAME.** Until now the frame a HAP / MP4 track drew
> was the app's (its decoded index / VideoFrame timestamp on the tick). eval.rs `VidTable` ports the app's two rules
> — hapCodec.layerFrame `clamp(Math.round(t · fps), 0, frames − 1)` and mp4Decoder `frame(t, loop = false)`: the
> last presentation time at or before the clamped time + PRESENT_EPS_US (1 ms), else the first — over each file's
> frame table, read once (the HAP container parser is the app's own mov.rs; the MP4 one is mp4demux). The engine
> chooses the frame at the clip time it DRAWS (its own clock, E3i) and checks its choice at the app's instant against
> the frame the app showed.
> - **Found on the way — the engine's MP4 demux dropped two frames of every three on a real film.** A version-0
>   `ctts` is unsigned on paper, but encoders write negative offsets into it (B-frames presented before they decode,
>   no edit list); mp4box reads them signed, the engine read them as ~4 × 10⁹ ticks. Measured on a 1080p25 H.264
>   film: the engine's table held every third frame. Fixed (signed in both versions); `test:mp4-parity` and
>   `test:native-takeover` unchanged by it (the former's colour failures — at most 1 level, every file — predate it:
>   the same run on the old demux fails identically).
> - **Also found — an anchor can be lost.** Main drops a tick the engine is too busy for, and a transport anchor sent
>   only on the tick that changed it went with it: the engine ran 0.3 s off for two seconds at a show's start. The
>   anchor now rides every tick (the engine re-anchors only on a new revision); guarded. And the engine now logs an
>   anchor it cannot read instead of dropping it.
> - **Proof:** `test:video-frame-clock` (`--hap <mov> --mp4 <film>`; run on the owner's choice of a real film —
>   "use a film already on the computer in full HD or 4K" — `venice_alley.mp4`, 1920×1080 H.264 25 fps with
>   B-frames, cut in two on its track so a video clip boundary is crossed): a looping 10 s show for ~24 s, the engine
>   owning the wire — **0 clock differences, the engine's frame the app's on 1204 of 1206 ticks** (the two: the loop
>   wrap, where the app still showed the film's last frame while its decoder sought back), the film on the wire (229
>   distinct levels, 298 changes). The only 4K film on the machine is HEVC BT.2020 HLG, which the engine does not draw
>   (BT.709 only), so the 4K case is not covered. test:timeline-video-wire, clock-parity, light-bytes,
>   transport-clock, automation-parity and native-takeover unchanged.
> - `verify:invariants`: the HAP rule, the MP4 tolerance and present rule, and signed ctts (mutation-tested: the HAP
>   round changed to floor).
> - **Next:** the picture across a boundary — every clip of a track in the document with its source, decoded by the
>   engine ahead of the cut — then JUCE in the engine process. → **done in E3k, below.**
>
> ✅ **E3k done 2026-11-24 — THE PICTURE ACROSS A CUT.** Each composite layer now carries the clip its track CUTS
> TO (`next`: activeClip at the current clip's end — none across a gap) as a hidden source `clip:<id>`, when the
> engine can draw it on its own: a still, an effect, a HAP or an MP4 (contentSource `nextClipNativeSource`). The
> engine decodes it AHEAD (its first frame, every tick until the cut) and, when its own clock crosses the cut before
> the app's document does, draws the track FROM THAT CLIP (`comp_sub`: the track's picture key for the tick) at
> the next clip's alpha and time — instead of holding the outgoing clip. When the app crosses and names the new
> file under the track, the decoder that decoded it ahead is HANDED to the track (with its picture), before the
> retain would have closed it. A next clip the engine cannot draw (an MP4 not in BT.709 limited range, judged from
> the engine's own decoder since the app has decoded no frame of it; an unreadable file) is logged once and holds
> its track — it never fails the tick. A key whose file changes drops its cached frame (a generation is a frame
> number, which two files share).
> - **Found on the way — the wire went back to the app at every cut on an MP4 track.** The app's per-track decoder
>   had not decoded the new file yet, so its document said "an MP4 with no decoded frame yet", the engine refused
>   it and the app took the wire for a moment — at every cut, in every show with two films on a track. Since E3j
>   the engine chooses frames itself and only needed the app's frame to judge the colour space, which it now judges
>   from its own decoder for such a source (`judge: "engine"`); the app describes a probed HAP / MP4 by its file
>   when its decoder has not caught up. Guarded.
> - **Proof:** `test:video-frame-clock --mp4b` — the MP4 track cuts from one film (venice_alley, 1080p25) to another
>   (src_4437, 1080p25) at 5 s. Run A: 0 clock differences, 894 of 895 frames the app's, **0 hand-backs of the
>   wire** (there was one at every cut before). Run B, the engine's clock 100 ms ahead: the next film drawn across
>   the cuts, **2 decoder hand-overs** (one per cut), nothing held, 0 clock differences. test:timeline-video-wire,
>   timeline-wire, clock-parity, light-bytes, transport-clock, automation-parity, native-takeover unchanged.
> - `verify:invariants`: the hand-over comes before the retain, the composite reads the substituted picture, the
>   app falls back to the file at an uncaught cut (mutation-tested: the fallback removed).
> - **Not covered:** a shader / text / live source as the next clip (held until the app's document arrives), and a
>   4K film (none on this machine in BT.709). **Next: JUCE in the engine process** — the clock it runs is then the
>   audio clock.
>
> ✅ **E3l done 2026-11-24 — JUCE IN THE ENGINE PROCESS (stage 1: the library, and the audio clock measured).**
> native/audio-engine had one file doing two jobs: the engine (bus, clips, device, metering) and its N-API
> surface. It is now ONE CORE BEHIND TWO FRONT DOORS: `core.h` (the engine, moved verbatim, plus the control thread),
> `engine.cpp` (the N-API addon the app plays through — unchanged behaviour) and `capi.cpp` (the same core as a C
> library, `artlux_audio.dll`: configure, load / play / stop a clip, gains, meters, close — answering calls block on
> the control thread, the rest queue in order). One `npm run build:audio` builds both; the package ships the library
> next to the engine. The engine loads it at run time (`audio.rs`, libloading — absent, the engine runs silent as
> before).
> - **The audio clock:** `MeteringAudioSource` — where the device pulls samples — now counts them, and
>   `artlux_audio_clock` reads the count and the open rate from any thread (two atomics, no control-thread trip).
> - **Measured** (`test:engine-audio`, the packaged layout): JUCE 8.0.14 inside the engine, the default output
>   opened (48 kHz, 480-sample buffer), the test tone on the output meter, 480 000 samples in 10 s exactly, and the
>   sound card's clock **−8 to −10 ppm** from the wall over ~1900 readings — ~35 ms an hour. That is the drift the
>   app's driver corrects today by re-seeking a sounding clip whenever it parts 50 ms from the show clock.
> - The addon is unchanged by the split: test-audio-offline (Node and Electron) and the effects suite (16/16) pass
>   on the rebuilt addon. `verify:invariants`: one core behind both doors (no engine class in either front door, no
>   N-API in the core), the clock counted at the device pull, the ABI matched, the library packaged (mutation-
>   tested); the two older audio checks now read the core where the code moved.
> - **Found on the way:** cmake-js's own Visual Studio detection fails in this shell although the configured build
>   works — documented in DEVELOPMENT.md with the direct `cmake --build` route.
> - **Next (stage 2):** the engine's transport takes its time from the audio clock while a device is open (the
>   anchor's origin re-based on audio samples, not the wall), and the driver's clip plays move into the engine
>   (`plugins/audio` sends the bed and clips as document, not as per-frame play / re-seek calls) — then the app's
>   re-seek loop has nothing left to correct.
>
> ✅ **E3m done 2026-11-25 — A SHOW'S SOUND FROM THE ENGINE (stage 2, part 1: the relay; opt-in).** Started with
> `--native-engine --engine-audio` (or the two env variables), the audio plugin relays EVERY call of its engine —
> configure, devices, clips, gains, spatial, effect chains, test tone, meters, spectrum, and the offline render a
> bake uses — to the JUCE inside the engine process, and never opens the addon's device:
> - **App:** the SDK's main context gains `engineAudio` (core main: `engineHost.audioCall`), present only under the
>   flag; `audioManager.useEngineAudio` swaps the addon for a relay with the addon's own method names. engineHost
>   queues calls made before the engine's hello (the driver configures at boot), settles answers by request id, and
>   rejects them if the engine dies.
> - **Engine:** an `audio` thread (`audio.rs serve`; a device open takes seconds, no frame waits for it) loads the
>   library on the first call and forwards each through ONE door, `artlux_audio_call({op, args})` (ABI 2) — every
>   live method of the addon plus offlineBegin / offlinePull (base64 of the raw float32s: exact) / offlineEnd. While
>   a device is open it logs the audio clock and the output level every 2 s (read without clearing the clip latch
>   the app's own poll reports).
> - **Proof:** `test:engine-audio-show` — a looping show playing a bed on a scratch profile: the plugin plays through
>   the engine, the engine loads its library and OPENS THE DEVICE ITSELF, its audio clock advances exactly at the
>   device rate (12.02 s of audio between the first and last report), the bed on its output (peak 0.05 = the bed's
>   gain × the tone), no relayed call fails; the same show WITHOUT the flag keeps the addon and the engine opens no
>   device. `test:engine-audio` adds the offline render through the relay's door: 95 852 of 96 256 samples sound,
>   two renders byte-identical.
> - `verify:invariants`: every op the relay sends has its case in artlux_audio_call (mutation-tested), the plugin
>   switches on the context's `engineAudio`, a pending call is failed when the engine exits.
> - **Not yet:** an engine RESTART does not replay the loaded clips (the driver believes them loaded — the show is
>   silent until its next reload) → **done in E3n, below**; the transport on the audio clock; the plays themselves
>   as document (the driver still decides every play and re-seek per frame).
>
> ✅ **E3n done 2026-11-25 — A RESTARTED ENGINE GETS ITS SOUND BACK.** The audio driver keeps its own view of what it
> loaded and what is sounding, and never re-sends what it believes done — so a restarted engine (a crash, a hang the
> watchdog killed) left the show SILENT until the driver's next reload. Main now keeps the audio STATE the relayed
> calls describe (`engineHost.trackAudio`: the device, the master gain / chain / test tone, each loaded clip with its
> gain, position, chain and — when sounding — its seek and when it was given) and hands it to every restarted engine
> before anything else, as it re-sends the document (`replayAudio`): the calls still awaiting an answer first (the
> latest intents), then the state minus what those already do; queued fire-and-forget calls are dropped (the state
> holds their effect — replaying an old play after it would move a resumed clip back). A sounding clip resumes where
> it would be NOW (seek + the time since); the driver's 50 ms drift lock holds it from there.
> - **Proof:** `test:engine-audio-show` now KILLS THE ENGINE mid-show (its own run's child, by the pid main logged):
>   main restarts it, the state is replayed ("the device, 1 clip(s), 1 sounding"), the new engine opens the device
>   again and the bed is on its output again (peak 0.05 after the restart). The earlier gates are unchanged.
> - `verify:invariants`: audioCall records the state, every state-changing op the relay sends is tracked for the
>   replay, a restarted engine is given it (mutation-tested: setClipEffects untracked).
> - **Still opt-in** (`--engine-audio`), like the native engine itself. **Next:** the transport on the audio clock,
>   and the plays as document. → **the transport on the audio clock: E3o, below.**
>
> ✅ **E3o done 2026-11-25 — THE ENGINE'S CLOCK ON THE AUDIO CLOCK.** Found first, reading the driver: its drift
> lock compares `sentOffset + wall elapsed` with the show clock — BOTH on the wall — so it never sees the card's real
> position, and the card's crystal drift (≈9 ppm here, ~30 ms an hour) is never corrected: between seeks and loops the
> sound slowly parts from the picture. So the picture goes to the sound:
> - **The stamp:** the device callback (`MeteringAudioSource`) writes the sample index it starts at and the WALL time it
>   ran (epoch seconds) as one pair under a sequence counter; `artlux_audio_clock_stamp` reads a matching pair from any
>   thread. A plain sample count is a whole buffer coarse (10 ms at 480 / 48 kHz) — a fit on it was measured off by
>   tens of ppm over 10 s, WORSE than the drift it corrects; the stamps are exact to the callback's jitter.
> - **The rate:** each render tick feeds the latest stamp to `transport.rs AudioRate` (least squares over the last 300
>   s, readings of one callback counted once, reset on a reopened device); the rate is APPLIED only once the fit's
>   standard error is under 2 ppm. From each anchor the engine's own clock then advances at it —
>   `a.at + (now − a.at) × ratio` — so what the engine DRAWS (lanes, lights, the composite: E3h / E3i) follows what is
>   heard between events. The checks stay at the app's instant and its clock.
> - **Measured:** `test:engine-audio-show` — "the engine's clock follows the audio clock — +12.36 ppm ±0.29 against
>   system time, fitted over 9.6 s of device callbacks", the transport checks 0 differing. Three runs gave +7.3, +10.4
>   and +12.4 ppm: the run-to-run spread is larger than each fit's ±0.3 — the reference is SYSTEM time, which Windows'
>   time sync slews (test:engine-audio, against the monotonic timer, reads −8 to −10 ppm: the two references are
>   ~16 ppm apart here). The engine uses system time on both sides of its ratio, so it is consistent.
> - **Found on the way:** engineHost split each stderr CHUNK into lines without keeping the unfinished tail, so an
>   engine log line crossing a pipe boundary was logged as two halves (seen before as a truncated anchor line). Fixed.
> - `verify:invariants`: the stamp written as a matched pair, the clock advancing at the ratio, the 2 ppm gate, the
>   render thread feeding stamps (mutation-tested: the wall-only clock). Unit test: a card 10 ppm slow read in 10 ms
>   steps at jittered 60 Hz ticks for 300 s — the fit within 1 ppm, the clock 10 ms behind the wall after 1000 s.
> - **Not yet:** the plays as document (the driver still decides every play and re-seek per frame, against the
>   wall) — the step that lets the ENGINE re-seek sound against its own clock instead of the picture following it.
>   → **the re-seek half: E3p, below.**
>
> ✅ **E3p done 2026-11-25 — THE SOUND HELD TO THE ENGINE'S CLOCK.** The driver's drift lock compares two wall
> estimates of its OWN (where it sent the clip + the wall since, against its clock) and never reads where a clip
> really is — so a play lands as late as the trip renderer → main → engine → audio thread → control thread made it,
> and stays there. The split, as everywhere else: the app still DECIDES which clips sound (windows, mute / solo,
> fades, scenes, holds — the whole driver); it now also DESCRIBES what each sounding clip is locked to, and the
> engine keeps it there:
> - **App:** `lockClip(id, {clock, start, inPoint, duration})` — the bed on the SHOW clock, the bound timeline's audio
>   and video soundtracks on the SCENE clock (the container's clock travels with it in `reconcileContainer`) — sent
>   when a clip starts and when a retime moves it. The addon ignores it; engineHost records it and a restarted engine
>   gets it back after the resumed play.
> - **Core:** the bus counts the samples it MIXES (and the wall time the next one plays) under its lock;
>   `clipPositions` reads each clip's source position and that count under the same lock — one instant, exact to the
>   sample; `seekClipAt(id, pos, at)` lands the clip at `pos + (mixed − at) / rate`, so the time a call waits in the
>   queue costs nothing.
> - **Engine:** the render thread publishes its clock each tick (`transport::publish` → `clocks_at_wall`: the same
>   advance as `own()`, at the audio rate from the anchor); the audio thread reads every locked clip each 100 ms, asks
>   that clock where the clip should be at the wall time of the mix sample it was read at, and re-seeks one more than
>   HOLD (2 ms) off. A clip off its window or past its source is left to the driver (a wrap it has not answered yet).
>   The engine answers `lockClip` itself (`ENGINE_OPS`) — it never reaches the library.
> - **Measured** (`test:engine-audio-show`): a play lands −9 to −10 ms from the engine's clock (the relay's trip); it is
>   re-seeked once and the bed then stays within **0.58 ms** over the run. The restarted engine's resumed clip (a wall
>   estimate) landed −447 ms off — re-seeked, then held. Mutation (`ARTLUX_AUDIO_LOCK_SKEW_MS=40`): each play found
>   −47 ms off, re-seeked, held within 0.07 ms after, 3 re-seeks in 20 s (one per driver start / wrap). With a 10 ms
>   hold the landings stayed where they fell — readings exact to 0.1 ms made 2 ms the right bound.
> - `verify:invariants`: the driver locks every clip it starts, the bed on the show clock and the two playhead
>   containers on the scene clock, the engine holds at the mix sample it read, seekClipAt lands at that sample, the
>   render thread publishes, a restart gets the locks back; ops the engine answers itself are exempt from the "case in
>   artlux_audio_call" check and must be answered by serve(). transport-clock, light-bytes, native-takeover,
>   test:engine-audio and the addon's offline + effects tests pass.
> - **Not yet:** the driver still decides the plays (start / stop / wrap) per frame against its own clock — so at a
>   loop wrap or a seek the sound restarts where the APP's clock says and the engine corrects it a check later
>   (≤100 ms, as measured above). Moving the decisions themselves into the engine (the clips as document) is the last
>   audio step; it needs the driver's mute / solo / fade / scene-container rules ported, as E3d–E3f ported the lanes.
>   → **E3q, below** — without porting those rules: the app keeps them and sends their RESULT.
>
> ✅ **E3q done 2026-11-25 — THE ENGINE DECIDES THE PLAYS.** With the sound in the engine (`--engine-audio`), the
> driver no longer starts, stops or re-seeks a single clip. The split is the one the lanes have: the app keeps the
> RULES (which clips may sound — mute, solo, loaded, scene membership, fades and automation into a gain) and sends
> their result as document; the engine keeps TIME (when a clip sounds, from where):
> - **App:** in engine mode `reconcileContainer` describes and never acts — every clip of both containers gets its
>   lock with `audible` and `decide: true`, its gain while it is in its window; `stopSounding` / `stopAllSounding`
>   drop only the driver's bookkeeping (a stop is the engine's); a clip leaving both containers gets a null lock. The
>   mode is asked once (`audio:engineDecides`) and dropped during an offline render (`audioClient.isOffline`, set by
>   offlineBegin / offlineEnd): the engine's clock does not run during a bake, so the driver decides the render's
>   plays as before. Switching who decides stops everything and starts the new decider from nothing.
> - **Engine** (`audio.rs hold`, every 20 ms): a decided clip SHOULD sound when it may, its clock is running and
>   MOVING (a parked clock — the show ended with its loop off, a held state's end — is told from a running one by
>   reading the clock 50 ms on), and the clock is in the window with source left. Should and not sounding → started at
>   the mix sample it was read at (`playClipAt`); sounding and should not → stopped (with the reason in the log); a
>   lock dropped → stopped. A start the clock is about to REACH — approaching the window, or through a loop's wrap —
>   is CUED: the entry instant is found by bisection on the engine's clock (which knows the wraps and parks), the
>   clip primed at its source position now and started by the MIX LOOP at the block nearest that sample
>   (`cueClipAt` → `Clip.startAt`), so it begins on time rather than at the next check; a cue whose window is gone
>   (paused, parked, sought away, muted, retimed) is withdrawn.
> - **Measured** (`test:engine-audio-show`, the bed — a 3 s tone in a 6 s window of a 6 s loop): the driver sent
>   **0 plays**; every pass of the window was cued 71–98 ms ahead through the wrap and landed **0.0–0.1 ms** from the
>   engine's clock (once 1.3 ms: within the half block the mix loop starts at); held within 0.08–0.12 ms with **0
>   re-seeks**; stopped where the source runs out; the restarted engine is handed the lock alone ("1 held by the
>   engine") and starts the bed itself. The E3p mutation still bites (starts use the true place; only the hold's
>   comparison is skewed). Before cueing, starts at the window were 16–29 ms late (the 20 ms check).
> - **Found on the way:** `SpatialBus::stopAll` during an offline render called JUCE's `stop()` on each playing clip —
>   which spins up to a second with no callback to answer it. Unreachable before (the driver stopped clips one by one,
>   which takes the offline flag); E3q's hand-back to the driver at a bake's first frame reaches it with the bed
>   playing. Now the same flag as stopClip: `test:engine-audio` measured **1199 ms and the clip still loud → 0.3 ms,
>   silent**.
> - `verify:invariants`: the driver hands the plays over only off a bake, describes and continues, never stops a clip
>   itself in engine mode, drops the lock of a clip leaving both containers; the engine starts and cues, tells a parked
>   clock, stops a decided clip whose lock goes; the mix loop fires a cue at its sample (mutation-tested: the bake
>   gate, the parked-clock test). transport-clock, light-bytes, native-takeover, test:engine-audio and the addon's
>   offline + effects tests pass on the rebuilt core.
> - **Not yet:** a scene recall's cross-container hand-over is still the driver's decision a frame at a time (the
>   lock change arrives with the app's frame, not at the engine's instant); a clip's FADE envelope is still sampled
>   by the app per frame into the gain. **Still opt-in** (`--engine-audio`). Next: E6.

> ✅ **E6a done 2026-11-25 — A BAKE DRAWN AND ENCODED BY THE ENGINE.** With `--native-engine`, a bake of content the
> engine draws is drawn and encoded in the engine: H.264 + AAC through Media Foundation's sink writer (`encode.rs`),
> the GPU's own encoder where it has one (here NVIDIA's MFT), the picture never crossing a process.
> - **The split:** the app keeps the ORCHESTRATION (bakeRunner steps renderClock, runs the show — state machine,
>   scenes, automation — at each step, settles its decoders, pulls the sound) and sends each frame as a `bakeFrame`
>   request: the frame's tick (`frameEngine.bakeTick` → `nativeLink.bakeTick`, the live tick returned instead of
>   sent, at the frame's EXACT time) + its PCM. The engine draws the surface at that stepped clock (`draw_at` the
>   app's — its own clock does not run in a bake), scales it (`bakescale.rs`: one pipeline, target and readback
>   buffer per bake), encodes. Answered per frame, never coalesced (`engineHost.engineBake`). Kept by the app:
>   transparency (the matte file), content the engine does not draw, the engine off.
> - **Measured** (`test:engine-bake`, venice_alley 1080p25): every frame the film's own at its time — luma 0.81 mean
>   / 1.10 worst (the app's own bake 0.79 / 1.05), 0 early or late; an effect frame for frame the app's (0.03); the
>   sound 96 000 of 96 000 samples, audible; a re-bake of a bound surface draws the content. Encoder self-test
>   (`--encode-selftest`): 4K 29.97 on NVENC 5.5 ms a frame, and the software encoder, both frame-exact, no B-frames.
>   Per frame: draw 3.3 ms, read back 1.4 ms (18.7 through the projector's offscreen path), encode 2.6 ms — but
>   100 frames took **1.4 s against the app's 0.5 s**: a round trip through main per frame.
> - **Found on the way:** (1) a texture without COPY_SRC made wgpu PANIC the render thread while the stdin thread
>   kept answering pings — the app waited forever; a panicking render thread now ends the engine (exit 70, main
>   restarts it), and an abandon is bounded. (2) The software encoder kept B-frames set through ICodecAPI (a frame
>   off at each key frame) — the settings now go in as encoding parameters. (3) A re-bake rendered the surface's
>   OWN previous file (in the app too: a copy of a copy) and the engine, which does not play bakes, wrote black —
>   the surface being rendered now never plays its bake. (4) The timeline's reading of a stepped clock is a float
>   a hair off: an effect stepping on a frame boundary drew the previous step once in 100 — frames carry their exact time.
> - `verify:invariants` (mutation-tested): drawn at the stepped clock, answered not coalesced, a panicking render
>   thread exits, content textures are copy sources, the encoder's settings at configure time, frame time a function
>   of the index, pending bakes fail on exit, a bounded abandon, transparency kept by the app, bakeTick builds only,
>   the rendered surface never plays its own bake, the engine refuses a surface it no longer draws, the exact time.
> - **Not yet:** frames pipelined (the round trip dominates); the app's decoders still settle each frame of an
>   engine-drawn bake (the engine decodes its own); the matte in the engine; macOS (AVFoundation). Next in E6: SDK
>   v2 for render contributions, then deleting the browser engine.

> ✅ **E6b done 2026-11-25 — THE ENGINE BAKE AT THE APP'S PACE.** (1) Frames PIPELINED: up to 4 `bakeFrame`s in
> flight (`ENGINE_WINDOW`), all drained before the file closes. (2) The encode on its own thread (`Mp4Writer`, a
> queue of 3 — the render thread hands over the pixels and draws the next frame); a cancel stops it WITHOUT closing
> the file (a flag, so a full queue is dropped, not encoded), then the file is deleted. (3) A timeline surface's
> frames are not settled by the app for an engine bake — the engine chooses and decodes them (E3j).
> - **Measured** (`test:engine-bake`, all gates as E6a + a cancel a second into a 10 s bake: refused, no file): the
>   engine's part of 100 frames 2.6 s → **0.5 s** (draw 3.3 + read 1.7 on the render thread, encode 3.1 beside it);
>   the whole render 1.38 s → **0.94 s** against the app's 0.46 s, of which ~0.4 s is opening NVENC once — steady
>   state ~5 ms a frame against the app's 4.6. Every frame still the film's (0 off, luma 0.81).
> - `verify:invariants` (mutation-tested): drained before the file closes, the settle skipped only for an engine
>   bake, a cancelled encoder never closes its file.
> - **Not yet:** RGB → NV12 on the GPU (the encode thread's CPU conversion now matches the draw); the matte; macOS.
>   → NV12: **E6c**.
>
> ✅ **E6c done 2026-11-25 — RGB → NV12 ON THE GPU for the bake.** A compute pass (`bakescale.rs NV12_WGSL`, one
> invocation per 4×2 block, words written whole) converts the drawn frame with `encode::to_nv12`'s arithmetic (BT.709
> limited, 2×2 chroma mean); both round half UP (WGSL `round()` is half-to-even, so the CPU's `.round()` became
> `floor(x + 0.5)` — the same bytes for these positive values). The encoder gets NV12 (`Mp4Writer::frame_nv12`); a
> width not a multiple of 4 goes the CPU way. `--bake-nv12-check` (in test:engine-bake): 1080p 2 of 3 110 400 bytes
> differ, 4K 2 of 12 441 600, by 1; 360p none. Per frame: read back 1.67 → **0.67 ms**, encode 3.07 → **0.55 ms**;
> the engine's part of 100 frames **0.4 s**. 250 frames: **1.18 s vs the app's 0.82 s** — ~3 ms a frame each once
> running; the rest is NVENC opening (~0.4 s). Every frame still the film's (0 off, luma 0.82).
> - **Not yet:** opening the encoder ahead (at the panel, not the press); the matte; macOS (AVFoundation). Next:
>   SDK v2 for render contributions.

> ✅ **E6d done 2026-11-25 — SDK v2: render contributions DESCRIBE, the engine draws.** (1) The contract moved into
> the SDK: `NativeSource` (`@artlux/sdk/renderer`) — one typed variant per kind the engine's document parser knows,
> `unsupported` the app's own "no"; `ContentSourceProvider.nativeSource` returns it (it was `{ kind: string, … }`:
> the typing found four plugins — shader, lidar-tracking, augmenta, mediapipe — returning untyped objects). (2) A
> codec answers for its own files: `VideoCodecContribution.nativeSource(path, frame?)` / `nativeSourceAhead(path)`;
> the HAP rule moved to plugins/hap, the MP4 colour judgement on the app's own VideoFrame to plugins/mp4 — core no
> longer names a codec id (`contentSource.codecNative`, the host turning the played path into the file path).
> (3) docs/SDK.md "SDK v2". `verify:invariants` (mutation-tested): the SDK's kinds and runtime.rs's parser equal
> both ways, no codec id in core, both codecs answer; the 2c-4 MP4 guard now reads the mp4 codec.
> - **Not yet:** `ProjectorChannel.renderSource(gl)` (calibration, lidar) and scene-viz (lidar's 3D) are still
>   WebGL-typed — their engine halves (the calibrated projector render is E4's; lidar's 3D view is the engine's
>   own) come with deleting the browser engine.

> **E6 — what still needs the browser engine (inventory, 2026-11-25).** Deleting `frameEngine` / `WebGPUMapper` /
> `GPUMapper` today would break shipped behaviour. What stands in the way, from the code (every refusal the host
> sends with a reason, every WebGL-typed hook, every `cfg(windows)` in the engine):
> - **A. The engine is OFF by default** (`--native-engine` / `ARTLUX_NATIVE_ENGINE=1`; sound `--engine-audio`).
>   Every installed show runs on the browser engine. Nothing has run default-on at a venue yet.
> - **B. Platforms.** The engine decodes MP4 (mf.rs), reads cameras (cam.rs / camshared.rs), receives Spout and
>   ENCODES A BAKE (encode.rs, Media Foundation) on **Windows only**; Syphon is not drawn at all. macOS ships
>   (v0.35.1: NDI + Syphon), so deleting the browser engine would take MP4, cameras, Syphon and baking away from it.
> - **C. Content the engine refuses** (per surface — the app keeps that output, with the reason): a SLICE surface;
>   a surface playing its BAKE (the bake's MP4 is played in the browser); a video no codec plugin plays (a
>   `<video>` element — no exact frame); an MP4 that is not 8-bit BT.709 limited (10-bit, HDR, BT.601, full range);
>   a camera streaming MJPEG or not I420 / NV12; tracking / Augmenta / MediaPipe drawn over a timeline layer or
>   showing a calibration grid, id labels or a skeleton; two Spout senders or two NDI sources at once (the APP's
>   one-receiver limit — the engine would show both correctly, so this is a parity choice, not a gap).
> - **D. Projector outputs the engine refuses:** a windowed output; live calibration (render-from-projector — a
>   baked map IS drawn); NVIDIA hardware warp (nvwarp); a projection mask; an NDI send; a blend map.
> - **E. WebGL-typed SDK hooks with no engine half:** `ProjectorChannel.renderSource(gl)` (lidar-tracking, augmenta,
>   mediapipe overlays on a projector), `SceneVizContribution` (lidar's 3D), calibration authoring's patterns.
> - **F. The crash fallback.** Today an engine death hands the wire back to the app in ~25 ms (engineHost setOwns);
>   with no browser engine the wire would go dark until the restart (`RESTART_DELAY_MS`) — a hold-last-frame in
>   main, or a faster restart, has to replace it.
> - Not in scope: the editor's own views (the Stage preview, the r3f 3D view) are UI, not the output engine.
>
> **Order:** E6e default-ON on Windows with the per-surface fallback kept (a flag to turn it off), run on real
> shows; E6f close C and D on Windows (a bake's playback is an MP4 the engine already decodes — the first and
> smallest); E6g the macOS engine (VideoToolbox decode, AVFoundation encode, Syphon, AVCapture); E6h replace F; only
> then E6i deletes the browser engine, when every refusal list is empty on every shipped platform.

> ✅ **E6f (first) done 2026-11-25 — A SURFACE PLAYING ITS BAKE IS DRAWN BY THE ENGINE.** Inventory item C's "a surface
> playing its BAKE": the bake is an MP4 the engine decodes, so `bakeStore.nativeFor` describes it through its codec
> (`codecClipNativeSource` → the mp4 codec's judgement on the bake decoder's own frame) and `surfaceMedia.nativeGeneration`
> puts that decoder's frame timestamp on the tick — the MP4 surface path (E1f 2c-4) unchanged. A transparent bake
> (colour + matte, recombined by matteGL) stays the app's, with the reason. `test:engine-bake` (now with a strip on
> each surface, Art-Net to 127.0.0.1): after the bakes the engine's document has the film surface as
> `film-rebake.mp4` and the effect surface as `fx-app.mp4` (the APP's own bake passes the colour judgement too), and
> the engine owns the wire. `verify:invariants`: the description, the tick's frame, the matte refusal.

> ✅ **E6f (slices) done 2026-11-25 — A SLICE SURFACE IS CUT BY THE ENGINE.** `{ kind: 'slice', of, rect }` (SDK
> `NativeSource`, runtime.rs parser — the SDK v2 guard holds both): the rectangle of the source surface's shown picture
> at the app's size round(w·r.w) × round(h·r.h), sampled as the app's canvas `drawImage` does — Skia's default
> smoothing: bilinear from the full-size level (`crop.rs`, `textureSampleLevel` 0); re-cut only when the source's
> generation, the rectangle or the size changes. The source passes the verdict like a sampled surface; a source the
> engine refuses leaves the slice to the app with its reason; no source / itself / a slice of a slice = nothing, as
> the app. `test:native-takeover` + two slices of the noise still: whole pixels universe 8 **identical**, fractional
> (0.13, 0.21, 0.37 × 0.44) universe 9 **identical** too (held within 1 for other GPUs); the rest unchanged.

> ✅ **E6f (masks, blend maps) done 2026-11-25 — TWO REFUSALS THAT REFUSED NOTHING.** Inventory item D listed "a
> projection mask" and "a blend map". Read in the code: the app's projector window applies NEITHER — `projMask` is
> the NVIDIA scanout path's (nvwarpApply, docs/CALIB-OPTIMIZATIONS.md: "GLSL-fallback honoring is a follow-up"), the
> blend map render-from-projector's (CalibProjector `render` mode / ProjectorScene) — and both of those paths are
> refused on their own. So such an output was the app's for nothing; the engine now takes it and shows the same plain
> warp. `test:native-projectors` with both set on its output: the engine's window **= the app's, 2 073 600 of
> 2 073 600 pixels**, also after a kill and restart. `verify:invariants` fails the day ProjectorGL / ProjectorApp
> reads either (the engine would then have to, or refuse again).
> - **The test was made safe on the way:** it rewrote the OPERATOR's prefs in %APPDATA% (backup / restore) and
>   `taskkill /IM`'d every electron.exe, ArtLux.exe and artlux-engine.exe on the machine, and C. killed "the first
>   artlux-engine" — now a scratch `--user-data-dir`, this run's own trees by pid, the engine pid from its own log
>   (guarded). And a capture is retaken while it differs: the NVIDIA app draws its "Alt+Z" toast over a new
>   fullscreen D3D window for a few seconds (23 662 pixels by up to 231 — exactly that box), which is not ours.

> ✅ **E6f (windowed outputs) done 2026-11-25 — ONE WINDOW, WHERE THE OPERATOR LEFT IT.** Inventory item D's "a
> windowed output". A topmost cover cannot work here — the app's windowed output is an ordinary window the operator
> drags — so the engine opens its OWN ordinary window (decorated, not topmost, shown inactive, titled as the app's)
> at the app window's CONTENT rect, and main HIDES the app's while covered and shows it again, where the engine's last
> was, when uncovered. Pieces, each measured:
> - **Place.** main sends the content rect in physical pixels (`window`, plus `css` and `title`); the engine reports
>   its window's rect once a move / resize settles (`outputPlace`), main moves the hidden window there and rebuilds
>   the document from the ENGINE's report — read back from the hidden window, a move of (90, 50) came back as
>   (58, 18) and the engine was put there. main's own layout of windowed outputs clears the report and moves the
>   engine's window (`placed by the host`). Closing it from its title bar (`outputClosed`) closes the app's as the
>   operator would — in broadcast, closing the last output ends the show, as before.
> - **The badge.** A windowed output shows the app mark + wordmark + name, top-left. Drawn twice (DOM + canvas) it
>   would never agree, so it is ONE bitmap (`components/brand/badge.ts`): the app's window draws it, nativeLink ships
>   it as raster `badge:<surface>`, the engine composites it (outputs.rs). Two traps, both measured: the window's
>   raster is BOTTOM-UP (first drawn: upside down at the bottom), and Chromium quantises a layer's opacity to 8
>   bits — 0.85 is 217/255 (at 0.85 exactly, 674 pixels were the app's minus 1).
> - **A main bug found on the way:** a re-sent document was rebuilt from the copy main had already ANNOTATED, so a
>   reason main had added ("its calibration map is still being handed over") stuck and the engine refused for good.
>   Now rebuilt from the renderer's own JSON (`lastDocRaw`).
> - `test:native-projectors --windowed`: the engine's window **= the app's, 860 784 of 860 784 pixels** (content
>   rect; the two bottom 8×8 corners are DWM's rounding, blended with the desktop, masked on both sides); one visible
>   window carries the output and it is the engine's; a move is reported and the hidden window follows; after a
>   kill the restarted engine opens at the moved place and is identical again; a title-bar close ends the show.
>   Fullscreen unchanged (2 073 600 / 2 073 600). Guarded (verify:invariants; four mutations caught).
> - **Limit, unchanged from fullscreen outputs:** dragging corner pins ON the output window is the app window's
>   input — with the engine showing the output, align from the editor.
> - **Open, NOT from this step:** `--baked` shows 6 scattered dark pixels off by 1 (bar: exact) — the same with the
>   committed engine (38b7c4b), so older than this; not chased yet.

> ✅ **E6f (NDI send) done 2026-11-25 — THE ENGINE SENDS IT, UNDER THE APP'S NAME.** Inventory item D's "an NDI send".
> With the engine showing the outputs the app's windows are covered and stop drawing — so they stop capturing too,
> and the send would freeze. So the ENGINE sends it (ndi.rs `NdiSend`): its own window raster captured as the app's
> window captures (ProjectorGL.captureRGBA — fitted within the same cap, now ONE constant in `projector/ndiCap.ts`:
> 720p, 1080p in broadcast; crop.rs samples bilinearly at pixel centres, upside down), on its own thread, through
> the same crate with the same options (`clock_video(true)`, RGBA, 60/1), under the SAME name. The app's sender of
> that name stands down while the engine owns the outputs — a new main-plugin hook, `ctx.nativeEngine
> .onProjectorsOwned` (SDK), used by plugins/ndi (`setSendersSuspended`) — and is re-created when it stops.
> - **NDI refuses a second sender of a name**, and the engine's starts as its window opens, BEFORE main hears it
>   owns the outputs and stands the app's down: the first start was refused every time. It retries every 250 ms
>   (up in 10–261 ms measured).
> - **The windowed badge was moved out of the output.** It was composited into the raster, so the engine's NDI frame
>   carried it (2 659 pixels) while the app's — read from its GL canvas, under the DOM badge — does not. It is
>   window chrome: now drawn on the swapchain after the flip, top-down (no bottom-up arithmetic any more).
> - `test:native-projectors --ndi`, the frames RECEIVED through the app's own addon in a child process, uncapped:
>   the engine's NDI frame **= the app's, 2 073 600 / 2 073 600** (broadcast, 1:1); `--ndi --editor` (the 720p
>   DOWNSCALE): **921 600 / 921 600**; `--windowed --ndi`: **859 520 / 859 520** and the window still identical;
>   exactly one source of the name while the engine sends; after a kill the app's sender comes back, and the
>   restarted engine's frame is identical again. Guarded (verify:invariants; four mutations caught).
> - **Remaining D refusals on Windows: live calibration (render-from-projector) and NVIDIA hardware warp.**

> ✅ **E6f (NVIDIA hardware warp) done 2026-11-25 — THE SCANOUT WARPS WHICHEVER WINDOW IS THERE.** Inventory item D's
> "NVIDIA hardware warp". NVAPI warps + blends a DISPLAY at scanout, so it applies to the engine's topmost window as
> it does to the app's; what differs is only what each draws. With NVAPI owning an output, App's pushProjectorState
> hands its window a FLAT output (identity corner-pin, no warp, no soft edge, unit gain, no lift; gamma kept) — the
> double-warp guard. nativeLink now hands the engine the same flat output for the same outputs: App passes the set
> from its ONE predicate (`hwOwnsGeometry` — NVAPI's answer, not the built-in panel, not a window) to
> `setProjectors`; hwWarp on an output NVAPI does not own is ignored by both. No engine change. The scanout apply
> itself (App → main nvwarpApply) is untouched: it never depended on which window draws.
> - **A GeForce has NVAPI scanout warp.** NVWARP.md said Quadro/RTX-pro only; an **RTX 5090, driver 621**
>   answers `available()` true. Found the hard way: the first `--hwwarp` run without a pretend put the test's
>   keystone on the owner's primary display AT SCANOUT — invisible to every capture (they read the framebuffer) —
>   and the forced kill skipped `clearAll`; cleared by hand (the addon's `clear`, NVAPI_OK). So
>   `ARTLUX_NVWARP_PRETEND` (main/nvwarpManager.ts, test only): `1` reports available, `0` absent, and both skip
>   every scanout call; test-native-projectors sets it on EVERY launch. Guarded.
> - **The taskbar over the app's fullscreen output.** From this afternoon Windows drew the taskbar over the app's
>   fullscreen (not topmost) projector window on the primary display — every run, plain ones too; the engine's
>   topmost window covers it (92 160 px = 1920×48). Not the output's pixels: the test asks Windows whether the
>   taskbar is the top window at its centre and, if so, leaves its rect out of every comparison and says so.
>   (A venue output is a secondary display; noted, not chased.)
> - `test:native-projectors --hwwarp` (pretend available): the app's window draws flat (100% lit vs 82% keystoned),
>   **the engine's window = the app's, 2 073 600 / 2 073 600**, restart identical, A2 identical; `--hwwarp
>   --no-nvapi`: keystoned, identical; plain and `--windowed` still identical (the plain run's old 11-pixel soft-edge
>   by-1 is 0 today). Guarded (verify:invariants; four mutations caught).
> - **Remaining D refusal on Windows: live calibration (render-from-projector).**

> ✅ **E6f (render-from-projector, first step) done 2026-11-25 — THE CALIBRATED VENUE, DRAWN AS THREE.JS DRAWS IT.**
> Inventory item D's last refusal, "live calibration". A calibrated output in render mode shows the venue drawn from
> the solved projector (ProjectorScene, three.js in the projector window). The engine now draws it — `calib3d.rs` —
> where it draws the SAME picture, held to the window pixel for pixel:
> - **The description (`src/renderer/engine/venueLink.ts`).** Needs no editor 3D view (broadcast has none — the
>   calibration plugin's venueRegistrar had the same reason): the GLBs are loaded with three's own GLTFLoader and
>   placed with the editor's recenterClone + applyModelTransform; the camera is CalibCamera's (cameraPose +
>   glProjectionMatrix through a three camera, so the view is three's matrixWorldInverse); EVERY MESH'S MODEL-VIEW is
>   computed there in f64 as three's renderer computes `modelViewMatrix` — the engine never composes a matrix. What
>   each mesh wears is engineContent (E4a+), now with an `exact` mode (the view's 1e-4 rounding is ~0.06 texel at
>   1280). App hands nativeLink the outputs it tells to draw the venue (its `rendersVenue`), the scene it sends them
>   (resolveProjectedScene) and the output a calibration session owns (`setVenue`).
> - **The draw (`calib3d.rs`), three's MeshBasicMaterial written out:** P × (MV × p), then ANGLE's GL→D3D step (y
>   negated — the projector raster is bottom-up, as a GL framebuffer — z to [0, w]); front face clockwise for the
>   same reason; the streamed-bitmap UV transform (bitmapFlip: v' = −v + 1 in the vertex stage) and, on a GLB wearing
>   content, flippedUv's 1 − v in f32 first; the surface as a LinearFilter, no-mip, clamp texture decoded by an sRGB
>   VIEW; three's sRGBTransferOETF (pow 0.41666); depth LessEqual; 4× MSAA; the projected material FRONT-sided
>   (projectedMapping BODY_VERT / BODY_FRAG, without occlusion). Path C's dim — projectorBrightness × the surface's
>   opacity, which the window applies as the scene canvas ELEMENT's opacity — is its own pass over the resolved
>   picture, 8-bit quantised (in the shader, one rounding instead of the compositor's two: 289 648 pixels one level
>   off). The venue's surfaces are published to the presenters as `venue:<sid>` at the MAIN picture's size (the
>   app streams `createImageBitmap(getDrawable(surface))`, not the display-size raster).
> - **Refused with a reason** (the app keeps every output): a lens distortion, a soft edge / colour match / rig blend
>   (`needsBlendPass`, now in the pure `renderLook.ts` both sides read), a residual warp (`hasResidualWarp`), an NDI
>   send of a calibrated output (without a residual warp the app's window sends NOTHING — it returns before the
>   capture), a mesh in its own lit material, an unbound screen, a timeline layer on the venue, projected occlusion,
>   an open calibration session. A calibration that is NOT in render mode (no pose, opted out, no visible venue) was
>   refused too and was never more than the plain warp in the app's window — now the engine's.
> - **It found two app bugs, both fixed:** (1) a PROJECTED mesh drew its content UPSIDE DOWN on the real projector —
>   useStreamedSurfaceTexture handed the material its texture before matchBitmapOrientation, and the projected material
>   copies repeat/offset only when handed one (useLayerTexture had the same order); (2) a calibrated output with no
>   residual warp ignored projector brightness and the surface's opacity — CalibProjector handed its canvas element to
>   ProjectorApp only with a warp, so path C's dim had nothing to dim (now always handed over; `readPixels` keeps
>   preserveDrawingBuffer for the warp alone).
> - `test:native-projectors --calibrated` (a screen through its UVs + one projected from the projector, brightness 0.9):
>   **2 073 599 / 2 073 600** (one pixel by 1); `--calibrated --glb` (+ the multi-projector example's curved venue GLB):
>   **2 073 600 / 2 073 600**; restart identical; `--calib-soft`: refused with its reason, the screen still the app's.
>   The app's own three.js render is not bit-stable across launches at an MSAA edge (0 one run, 1 pixel by 1 the next),
>   so A2 holds it to the engine's bar there. Plain, `--hwwarp` identical; `--baked` the old 6 pixels. Guarded
>   (verify:invariants, six mutations caught).
> - **Next for D:** the passes refused above — lens distortion, the blend pass, the residual warp — then occlusion,
>   a mesh's own lit material and timeline layers on the venue.
>
> ✅ **E6f (render-from-projector, step 2) done 2026-11-25 — THE POST PASS: LENS DISTORTION AND THE BLEND.**
> ProjectorScene mounts an EffectComposer when the calibration carries a lens distortion or the output a blend look
> (soft edge, colour gain, black lift, a solved rig blend). The engine draws it (`calib3d.rs` POST):
> - **What the composer does, written out:** @react-three/postprocessing's defaults are `multisampling: 8` and
>   `HalfFloatType`, and three applies no OETF into a linear render target — so the scene renders LINEAR into an 8×
>   MSAA Rgba16Float buffer (`fs_lin`), resolved; the two effects MERGE into one EffectPass: postprocessing's
>   fullscreen triangle (vUv = position × ½ + ½, through ANGLE's y negate), DistortionEffect's `mainUv` bends the
>   lookup, the input is read there (LinearFilter, clamp), BlendEffect's `mainImage` applies blendGlsl's ramp and the
>   grids in physical raster space (gl_FragCoord, v = 0 at the top), the NORMAL blend at opacity 1 keeps it, then
>   three's OETF into the 8-bit canvas. Path C's dim still follows. The device asks the adapter-specific format
>   features for 8× (logged and 4× where an adapter cannot).
> - **One definition of the values:** `renderLook.ts` `distortionValues` (OpenCV's k1 k2 p1 p2 k3 → the effect's
>   order) and `blendValues` (defaults, gamma floor, the grids as the 8-bit texels the texture holds). ProjectorScene's
>   effects are now built from them, and nativeLink hands the engine the same — it decides the pass with
>   ProjectorScene's own tests (hasDistortion / needsBlendPass).
> - `test:native-projectors --calibrated --distort`: **2 073 600 / 2 073 600**; `--calib-blend` (soft edge on two
>   sides, gain, lift, a 5×3 rig blend with its black grid): **13 pixels by 1**; both `+ --glb`: **5 pixels by 1**;
>   restarts the same. `--calib-warp` (replaces `--calib-soft`): a residual warp still refused with its reason, the
>   screen the app's. Plain, `--calibrated --glb` unchanged. Guarded (verify:invariants, five mutations caught).
> - **Next for D:** the residual warp on a calibrated output (the base stage warps the scene's canvas — ProjectorApp
>   path B), then occlusion, a mesh's own lit material and timeline layers on the venue.
>
> ✅ **E6f (render-from-projector, step 3) done 2026-11-25 — A RESIDUAL WARP ON A CALIBRATED OUTPUT.** ProjectorApp's
> path B: with a nudged corner pin / Bézier the scene's canvas stops being the picture and becomes the SOURCE of the
> window's ordinary warp stage. The engine now does the same (`outputs.rs`, `view.warped` — nativeLink decides it with
> ProjectorApp's own `hasResidualWarp`): the venue drawn UNDIMMED into its own canvas; uploaded as `texImage2D(canvas)`
> + generateMipmap (`projector::CanvasContent` — the GL raster turned top-first texel for texel, then the
> same mip chain as every content texture); warped with GEOMETRY ONLY (no feather, gamma 1, unit gain, no lift — the
> post pass already applied the look, twice would square the blend), brightness × opacity in the warp, aa 1. The warp
> pass is now a `projector::Warp` keeping its pipelines (path B warps every frame; a plain output redraws on change).
> An NDI send of a WARPED calibrated output is the engine's as well (path B captures after warping).
> `test:native-projectors --calibrated --calib-warp`: **2 073 600 / 2 073 600**; `+ --ndi`: window and NDI frame
> identical, the app's sender stood down and came back on a kill; with `--distort --calib-blend --glb`: **4 pixels by
> 1**. `--calib-refused` (projected occlusion) replaces the refusal check. Plain, `--windowed`, `--calibrated
> --distort` identical. Guarded.
> - **Next for D:** occlusion (the projected-depth pass), a mesh's own lit material, timeline layers on the venue.
>
> ✅ **E6f (render-from-projector, step 4) done 2026-11-25 — PROJECTED OCCLUSION.** `projectorDepth.ts` is a shadow
> map with the projector as the light; the engine draws the same (`calib3d.rs` DEPTH): per occluding projector, EVERY
> venue mesh (the app's casters are every visible model, contentless meshes included) rendered with the projector's
> world→clip as the projection and the mesh's world as the model-view, both faces, into a 1024² RGBA8 map of
> DEPTH_PACK_GLSL's packed clip.w / 250, cleared white, depth LessEqual; read NEAREST, and BODY_FRAG's test
> (`w > seen + bias × (1 + 4 (1 − |n·l|))`) in both the 8-bit and the post pass's linear stage. The host already
> sent `occlude` / `bias` (engineContent); venueLink stops refusing. `test:native-projectors --calibrated
> --calib-occlude` projects from a SECOND, disabled, calibrated output past a blocker screen — from the projecting
> projector itself occlusion is invisible (its own depth buffer hides the same), so the shadow is only seen from
> another one. The shadow is drawn; **16 pixels by ≤ 2**, and the same scene with occlusion OFF is 22 by ≤ 2 — the
> occlusion adds nothing; the rest is oblique PROJECTED sampling (a texture coordinate a float step apart flips a
> quantised bilinear weight), unchanged by rewriting the engine's matrix product or its divide (FXC compiles the
> two HLSL sources differently). That case's bar is within 2 (A2: the app equals itself exactly). `+ --glb` (the
> venue projected from the second projector, self-shadowing): the same. `--calib-refused` is now an NDI send without
> a residual warp. Guarded.
> - **Next for D:** a mesh in its own lit material, timeline layers on the venue — then E6e (default-on).
>
> ✅ **E6f (render-from-projector, step 5) done 2026-11-25 — A MESH IN ITS OWN MATERIAL.** The window lights a venue
> file's own materials with `<ambientLight 0.8>` + `<hemisphereLight 0.7, ground #101010>` and NO environment map.
> There three's MeshStandardMaterial reduces exactly: RE_IndirectSpecular gets zero radiance and zero IBL irradiance
> (adds 0), there is no direct light, so outgoing = (ambient + mix(ground, sky, ½ n·dir + ½)) × diffuse ×
> (1 − metalness) / π + emissive; opaque; then r3f's ACESFilmic (exposure 1) and the OETF — and under the post pass's
> composer no tone mapping at all (it sets NoToneMapping and renders to a target). `calib3d.rs` OWN writes that out
> (the Obj slot read as `Own`, the venue's own pipeline layout, so the depth pass and the post pass take the meshes
> unchanged; a pipeline per three side: FrontSide culls back faces, BackSide front ones and negates the normal,
> DoubleSide flips it by gl_FrontFacing). The host (`venueLink.ownMaterial`) reads each material with three itself
> (colour, metalness, emissive × emissiveIntensity, side), three's normalMatrix in f64, and the two lights as
> WebGLLights uploads them (`renderLook.VENUE_LIGHTS` — ProjectorScene's JSX reads the same); it refuses with a reason
> what the reduction does not cover — any texture, vertex colours, transparency / alpha test, flat shading, a
> wireframe, several materials on one mesh, any other material type. A model with NO binding is all own materials.
> `test:native-projectors --calibrated --calib-own` (the blender-screens example room — walls and floor in their own
> materials, `screen_main` bound): **2 073 600 / 2 073 600**; `+ --distort --calib-blend` (no tone mapping): **5 by
> 1**; `+ --calib-warp`: identical; `+ --calib-occlude --glb` (own meshes cast): the projected-sampling 16 by ≤ 2.
> Guarded.
> - **Next for D:** a timeline layer on the venue — then E6e (default-on, the owner's OK).
>
> ✅ **E6f (render-from-projector, step 6) done 2026-11-25 — A TIMELINE LAYER ON THE VENUE. ITEM D IS CLOSED.** The
> window textures a mesh bound to a layer from `getLayerDrawable(layerId)` (the program composite for the program
> sentinel), streamed by App as a `layerFrame` — and a single-track LAYER surface draws exactly that
> (surfaceMedia). So the engine needs nothing new: nativeLink (`withVenueLayers`) appends one HIDDEN surface per
> bound layer — `venuelayer:<id>`, content LAYER (PROGRAM for the sentinel) — to the frame's surfaces, memoised so the
> document is not re-sent every frame; the engine composites it as any timeline surface (its tracks' sources, the
> tick's clip alpha and time) and publishes it to the presenters as it does every venue surface; venueLink names it as
> the mesh's source (a plane's `layerId`, a GLB's model or named-screen binding — engineContent now carries the
> layer id). What a timeline surface cannot hand the engine stays refused with that reason (a clip playing through a
> `<video>` element — met in the test: a PNG given as a clip PATH plays that way; a still is a content clip).
> `test:native-projectors --calibrated --calib-layer` (the tilted screen showing a track's still, colour-inverted):
> **2 073 600 / 2 073 600**; `+ --calib-own` (the room's named screen on the layer): identical; `+ --calib-warp
> --distort`: identical. Guarded.
> - **What is left of D on Windows:** an NDI send of an UNWARPED calibrated output (the app sends nothing there —
>   both are silent, by design) and an open calibration SESSION (authoring: patterns, crosshair, verify looks). Next:
>   E6e (default-on — the owner's OK), E6g (macOS), E6h (crash fallback), E6i (delete the browser engine).
>
> ✅ **E6e done 2026-11-25 (the owner's OK) — THE ENGINE IS ON BY DEFAULT ON WINDOWS.** Inventory item A.
> `engineHost.decide()`, once per run (after app ready, so the prefs are readable; a change takes effect at the next
> start, never mid-show), the first switch that speaks wins: `--no-native-engine` / `ARTLUX_NATIVE_ENGINE=0` (off),
> `--native-engine` / `=1` (on, any platform), not Windows (off — E6g), *Preferences ▸ Engine ▸ Native output
> engine* off (`Prefs.nativeEngineOff`, per machine, named for the polarity so absence means on), else ON. The
> machine log says which (`engine enabled|off {why}`). The per-surface / per-output fallback is unchanged: whatever
> the engine refuses, it refuses with a reason and the app keeps it. Every parity test's APP-side run now passes
> `--no-native-engine` (11 scripts) — with the engine on by default, an app run that merely omitted the flag would
> have compared the engine with itself; guarded. Usage: user guide ch. 12 (the switch), ch. 9 and the topic pages
> that said "`--native-engine`"; CHANGELOG.
> - **Still to prove:** a real show at a venue on default-on (the plan's "run on real shows"). Next: E6g (macOS),
>   E6h (the crash fallback), E6i.

## 9d. E4 started early — the 3D view in the engine (owner, 2026-11-24)

> **Owner, 2026-11-24: "start E4's 3D now"** — for the detachable 3D view (plans/3d-workbench.md §5/Phase 4),
> ahead of E1's remaining items and E2–E3.
>
> ✅ **E4a done 2026-11-24 — the 3D view in its own ENGINE window.** `engine/artlux-engine/src/view3d.rs`:
> - **The split, as everywhere else.** The HOST describes (`Simulator3D/engineView.tsx` → `scene3d`): each
>   venue GLB's file and the world matrix of its recentred root (ModelObject tags it `enginePath`), each
>   screen's quad and surface (PlaneObject `enginePlane`), every pixel fixture's LED world positions
>   (`computeLedPositions`, in texel order), each light's position — read off the editor's own three.js
>   scene, so no transform is re-derived; at most 4 Hz and only on change. The RENDER THREAD publishes the
>   live state into `view3d::Shared`: every surface's picture (as for the projectors) and the composed LED
>   buffer with each pixel fixture's offset (the packer's walk). It now composes while a view is open EVEN
>   WHEN THE ENGINE DOES NOT OWN THE WIRE (guarded) — otherwise the view would go dark on any show with a
>   source the engine cannot draw. ONE PRESENTER thread draws: glTF (the `gltf` crate, loaded off the
>   presenter; base colour + texture, sRGB-decoded), screens unlit with their live pictures, LEDs as
>   camera-facing discs (12 mm, never under ~3 px), lights as housings, a distance-faded grid and the axes;
>   4× MSAA, depth, FIFO at the display's refresh.
> - **The window** is an ordinary decorated winit window on the existing windows thread (outputs.rs
>   `Cmd::View3d`), opened at the editor's camera (`view3d` message: position, target, fov). Its mouse
>   drives an orbit camera there (left orbit, right/middle pan, wheel dolly). Closing it from its title bar
>   comes back to main (`{"type":"view3d","open":false}`) and to the editor's button. Main keeps the scene
>   and the open state, so a restarted engine reopens it.
> - **Proof** (packaged Show, scratch profile, `--native-engine`; the engine window captured from the
>   screen): opened at exactly the editor's camera (eye/target logged on both sides); vik-voice's two strips
>   in their LIVE effect colours (120 of 120 LEDs lit); a still on both screens of a test copy of the
>   interactive show, the right way round; its venue GLB loaded and placed 7 m behind; the lighting
>   example's six lights where they hang; orbit and wheel change the picture; title-bar close → the
>   editor's button follows; reopen; close from the editor → the window is gone. `test:engine-runtime`
>   still OK.
> - **Found on the way:** `test:native-projectors` fails here with 25 406 pixels differing — it is the
>   **NVIDIA overlay's "Alt+Z" toast** drawn over the engine's fullscreen window during the capture (the
>   same with the committed engine and with the pre-E4 build): this PC's environment, not a regression.
>   Turn the NVIDIA app's in-game overlay notifications off on a test box.
> - ✅ **E4a+ 2026-11-24 — the projection preview** (owner: "the preview of the projectors is missing in
>   the detached 3D view"). A venue GLB now wears what the editor puts on it: `engineContent` sends a source
>   list and, per three.js MESH in traversal order, the source it shows (−1 = the file's material) — mesh
>   ORDER, not names, because three sanitises/de-duplicates node names and both loaders agree on the
>   (node, triangle primitive) order (strips and fans count; `load_glb` converts them). Named screens show
>   their bound surface; a whole model its surface through its UVs or PROJECTED (projectedMapping.ts line
>   for line: edge ramp, optional back-face test, and OCCLUSION from a 1024² linear-depth map the presenter
>   renders from each projector, re-rendered only when the scene or a file changes). Projector frustums
>   (anything tagged `userData.engineLine`) are drawn as overlay lines. Per-PLACEMENT uniforms now — two
>   placements of one file used to share a uniform buffer and draw at the last one's matrix.
>   **It found two editor bugs, both fixed in the same change:** the editor painted both projected modes
>   UPSIDE DOWN (since a156d09 turned the authored path upright and left the projected V flip behind; the
>   bake was always right), and on WebGPU it read its projector depth map upside down (mirrored shadows; a
>   curved screen shadowing its own lower band). Proven with a TL/TR/BL/BR test card on the multi-projector
>   example: named screen; projected from a frozen view; a panel between projector and screen — engine,
>   editor WebGPU and editor WebGL (forced) all identical. Guarded in verify:invariants.
> - ✅ **E4b-1 2026-11-24 — the BEAMS.** Every lit head throws its beam in the engine window, as the editor's
>   Beams.tsx draws it: the additive haze cone (Shaded, or Rendered's solid shaft to the floor), the 48 brightest
>   only (the fill-rate budget), and the cone diagram — every lit head's floor boundary (an ellipse on a tilted
>   beam, each rim ray intersected on its own), plus the axis and eight edge rays for the heads SELECTED in the
>   editor. **The split:** the editor sends each light's FIXED half in the scene (engineView.tsx: lens apex in
>   world space, base rotation, pan / tilt mid-points, lens half-angle — Beams.tsx's own maths) and the look
>   (haze, cones, Rendered, selection); the ENGINE resolves the MOVING half every tick — lightpack.rs
>   `Head::resolve`, the port of fixtureSignal.resolveFixture (intensity × shutter band, emitters summed or a
>   wheel slot's colour, CMY flags on a subtractive head, pan / tilt / zoom through the physical range), run on
>   the same stack the light's bytes are packed with, only while a view is open. `beams.rs` turns the two into
>   instance and line data (pure; two unit tests). **Proof:** `test:light-pack-parity` now also resolves every
>   case — 6 732 states identical to the app's (28 611 cases); `test:engine-beams` (packaged, scratch profile):
>   six heads, one dark → 5 volumes and 169 diagram segments logged, light bytes never differing, the captured
>   window holding the red and blue beams, side by side with the editor's view of the same rig (identical
>   diagram); then the editor's Rendered button → the engine logs `5 volume(s), 0 diagram segment(s) … Rendered`
>   and its window shows the solid shafts. A guard compares Beams.tsx's constants with beams.rs's. **Trap found on
>   the way:** a plain `cargo build` drops the `ndi` feature, and `test:native-takeover` (an NDI surface) then fails
>   6 checks with "this engine build has no NDI" — build with `npm run build:engine`, which turns it on.
> - ✅ **E4b-2 2026-11-24 — PICKING.** A click in the engine window selects IN THE EDITOR: the window thread
>   tells a click from an orbit (≤ 4 px of travel), casts the window camera's ray (`Cam::ray`) and takes the
>   NEAREST body it meets (`view3d::pick`) — a light's housing box, a pixel fixture's whole strip (a tube along
>   its LED line, 3 cm or six pixels wide, whichever is wider at that distance); it writes
>   `{"type":"view3dPick","id","add"}` (Shift / Ctrl → add), main relays it (`native-engine:view3d-pick`) and
>   Simulator3D applies it with the editor's own rules (replace; toggle on add; empty space clears fixtures and
>   the model). The selection comes back with the scene, so the engine draws picked housings / strips in the
>   accent and gives picked heads the full beam diagram. A CPU ray, not the GPU id buffer this plan named: a pick
>   is one per click over tens to hundreds of fixtures — microseconds, no extra pass. **Proof:** two unit tests
>   (the nearest body wins — a housing in front of a strip; the centre ray is the view axis); `test:engine-beams`
>   now CLICKS the engine window (real OS mouse events at the housings' projected pixels): Mover 3 → engine log
>   and the editor's 3D list both say Mover 3, the diagram follows (169 segments); empty sky → nothing selected
>   (160); Shift-click Mover 2 → both (178). A pixel strip's pick is covered by the unit test only.
> - ✅ **E4b-3 2026-11-24 — the window comes back where it was.** The engine reports the window's place
>   (outer position, inner size, maximised — with the rect under a maximise) 500 ms after a move / resize
>   settles, and on close: `{"type":"view3dPlace"}`; main saves it in the machine's prefs (`engineView3dPlace`)
>   and puts it on every open message, built at send time so a restarted engine reopens where the window was
>   LAST. In the engine's physical pixels end to end — main never reads it — because Electron's DIPs and winit's
>   physical pixels disagree on a mixed-DPI rig. The engine checks a saved place against the monitors that exist
>   when it opens (`Place::on_screen`: the middle of its title strip must be on one) and otherwise opens at the
>   default and says so. **Proof:** a unit test (unplugged screen, half off an edge, title above every screen,
>   round trip); `test:engine-view-place` (packaged, scratch profile, the window moved from outside with
>   SetWindowPos): saved once settled; close / reopen → the exact rect; maximised saved over its rect and
>   reopened maximised; a restarted app opens it there; a place far off every screen → the default, with the
>   reason logged.
> - ✅ **E4b-4 2026-11-24 — the floor numbers.** `labels.rs` ports GridLabels.tsx + gridScale.ts's
>   solveGridFrame / labelFamilies: whole metres flat on the floor along an X run and a Z run through the lines
>   nearest where the view meets the floor (sticky, so orbiting never jumps a row), counted in the decades the
>   density allows, each number fading with its distance, the X / Z letters in the axis colours, text facing away
>   from the viewer (a dead band against blinking), LABEL_PX tall at the reference divided by the floor's tilt.
>   Glyphs rasterised ONCE with `ab_glyph` (already in the lock via winit) from the system monospace font —
>   Consolas first, as the editor asks; no font → no numbers, logged. Depth-tested, so a screen hides them. The
>   editor's grid toggles now reach the engine (`grid: {visible, labels}`). The editor's grid itself is adaptive
>   (1·2·5 sections) and the engine's is still a fixed metre grid — the numbers are the editor's either way.
>   **Proof:** two unit tests (families by density; a downward view numbers both runs, all on the floor);
>   `test:engine-beams` captures a downward view (273 glyphs: −6…6 along X, the Z run, both letters) beside the
>   editor's. A guard compares the copied constants. The run also caught an injected Shift-click that Windows
>   dropped (1 run in 3, no pick logged at all); that step now retries once, out loud.
> - ✅ **E4b-5 2026-11-24 — the MOVE gizmo.** With the Move tool and a selection, the engine window draws the
>   handles where FixtureGizmo parks its anchor (engineView.gizmoAnchor: the centroid; room axes, or the active
>   fixture's with Object axes; the move snap), a fixed 90 px on screen and over everything. `gizmo.rs`: hover and
>   grab in screen space (within 10 px of a shaft, end-on axes refused), the pull read as the closest approach of
>   the cursor's ray to the axis line, snapped as three snaps (a room axis lands the anchor's coordinate on the
>   step; an object axis snaps the distance). The window streams `view3dGizmo` start / move (≤ 60 Hz) / end with
>   the OFFSET; main relays it; `applyEngineGizmo` turns it into the move with the SAME `gizmoDelta` the editor's
>   handles use, previews through fixturePreview, records undo on the first movement and commits once. The window
>   draws the selection moved by the offset itself (LEDs, housings, beams, the handles) until a scene with the
>   committed positions arrives. **Proof:** three unit tests (a pull reads as the distance; snapping on room and
>   object axes; the handle under the cursor); `test:engine-beams` DRAGS the X handle with OS mouse events on two
>   selected heads: grabbed, released at +1.92 m on X only, the saved project has both heads moved by exactly
>   that and nothing else, one Undo (Edit menu) puts them back. Rotate / Scale stay in the editor's view.
> - ✅ **E4b-6 2026-11-24 — Rotate and Scale.** The gizmo now draws the editor's current tool: rings (Rotate) and
>   square-ended shafts (Scale, always in the anchor's frame — three refuses to world-align scale handles). A ring's
>   turn is the angle swept where the cursor's ray meets its plane, UNWRAPPED across ±π; a scale is the ratio along
>   the axis now over at the grab; each snaps as three snaps (degrees, factor steps). The message grew from an offset
>   to a GESTURE (offset, world rotation about the anchor, per-axis scale); `applyEngineGizmo` composes it onto the
>   anchor exactly as TransformControls moves its object (position + offset, rotation · anchor quaternion, scale ×
>   factor) and hands it to the same `gizmoDelta` in the tool held at the grab. The window previews with
>   `Drag::apply` (scale in the handle frame about the anchor, turn, move) and turns the beams' bases with it.
>   **Proof:** five unit tests (+ a quarter turn about Y and its snap; scale is the ratio and spreads about the
>   anchor); `test:engine-beams` now also SCALES the two heads apart along X (×2.99 → saved at ∓2.99, undone) and
>   TURNS one head on its Y ring (46.15° in the engine → saved yaw −46.15°, position unchanged, undone). It found the
>   editor's own rule that a plain click on a group member keeps the group — the engine window follows it.
> - ✅ **E4b-7 2026-11-24 — picking venue models and screens.** The presenter keeps each loaded file's triangles
>   (positions + indices, `Shared::meshes`); a click that meets no fixture takes the NEAREST model triangle
>   (Möller–Trumbore in world space; a screen is its quad) — fixtures first wherever they are in the ray, the editor's
>   pickPriority rule. `view3dPick` carries `model`; the editor applies it as its own model click (onSelectModel, which
>   clears the fixtures). The selected model's world bounds are outlined in the accent. A brute-force ray: per click
>   only, microseconds for a venue of tens of thousands of triangles. **Proof:** a unit test (a strip on a screen wins;
>   the screen above it is the model; past its edge nothing; its bounds); `test:engine-beams` clicks the screen
>   behind the rig → `pick: model scr` and the editor's objects list shows Back screen selected, no fixture.
> - ✅ **E4b-8 2026-11-24 — a venue model's own handles.** With a model or screen selected, the engine draws ITS
>   handles (ModelObject / PlaneObject's TransformControls: at its position, world axes for Move / Rotate, its own
>   for Scale, no snap, Move even in Box select). The drag moves the model's drawing in the window (`Drag::matrix`
>   on its world matrix, its outline too); `applyEngineModelGizmo` composes the gesture onto the model as its
>   group would move (position + offset, rotation · quaternion, scale × factor) and commits once through
>   onCommitModel, one undo step. The editor's own view of the model follows on release (its models have no
>   pointer-rate preview channel). **Proof:** a unit test (the gesture as a matrix = the gesture on points);
>   `test:engine-beams` raises the selected screen with its Y handle (+1.66 m in the engine → saved y = 4.66, x / z
>   unchanged; undone). The test now waits for every engine log line it judges (`settle`, and each grab paired
>   with its release) — two runs had read a line that landed a moment late.
> - ✅ **E4b-9 2026-11-24 — the adaptive floor grid.** `grid.rs` ports GroundGrid + gridScale.gridFamilies +
>   OriginGnomon: three decades of lines faded in by the pixels a cell covers at the reference point (labels.rs
>   `reference`, now shared, so the grid and the numbers solve one frame), each lattice centred on the reference
>   snapped to its spacing and fading with distance in its own units, rebuilt only when the density (1/32 octave)
>   or the reference (¼ of the finest spacing) moves; the origin marked by the editor's 28 px gnomon over everything,
>   replacing the fixed 100 m metre grid and its long axis lines. **Proof:** two unit tests (the decades by density;
>   the lattice centred and faded, the gnomon's arms); `test:engine-beams`' downward capture shows the metre lattice,
>   the decimetre patch fading in around the reference and the gnomon; a guard compares the copied constants.
> - ✅ **E4b-10 2026-11-24 — the Rendered look's lit room.** The window now draws its scene LINEAR into an HDR
>   target (Rgba16Float, 4× MSAA resolved) and finishes it in `post.rs`: a straight copy in Shaded (unchanged to
>   the eye), and in Rendered three's BloomNode(0.8, 0.4, 0.6) (a bright-pass and five half-size levels down / up,
>   UnrealBloom's radius weighting) then AgX at exposure 1.1 — three.js's AgXToneMapping line for line, over the
>   whole frame as the editor's render pipeline does. The heads light the room: `beams.rs spots` = MoverLights (the
>   eight brightest; penumbra 0.4, range 30 m, decay 1.2, dimmer × gain × 14; gain = the editor's lightGain, now
>   sent) as three's physical SpotLight falloff and cone in the mesh shader (Lambert), in both looks; Rendered adds
>   RenderedMode's matte #1c1c1c floor and drops the studio fill to a trace. **Proof:** a unit test for the spots
>   (ranking, packing, the cone cosines, no gain → none); `test:engine-beams`' Rendered step beside an editor
>   capture in Rendered; a guard compares the copied numbers. **Not yet:** shadows (the editor's PCF-soft shadow maps
>   per spot), GTAO and SMAA. The test's drags now wait for their own grab and release line (a late grab line had
>   let a previous release look current).
> - ✅ **E4b-11 2026-11-24 — Rendered's shadows.** Each spot in use renders a 1024² depth map (one layer of a
>   depth array) from three's SpotLightShadow camera (fov twice its cone, square, near 0.5, far its range) every
>   frame in Rendered; casters as the editor's: venue meshes wearing their own lit material (a screen with a picture
>   is MeshBasic there: none) and the housings. The mesh shader takes each spot through its map: the point pushed
>   0.02 m along its normal, bias −0.0005, a 3 × 3 comparison average (PCFSoft). **Proof:** `test:engine-shadows`
>   (packaged, scratch profile): a wash straight down over a box written as a tiny glTF, the engine window looking
>   down in Rendered; the ring of floor around the box's foot brightens 131.6 → 137.3 when the editor hides the box,
>   and the order of that ring against a lit ring further out flips (darker only while the box is there) — judged as a
>   difference because Rendered's solid shaft lies over the whole pool. A guard compares the copied shadow numbers.
> - ✅ **E4b-12 2026-11-24 — Rendered's ambient occlusion.** `ao.rs`: screen-space occlusion from the main pass's
>   own MSAA depth (sample 0; the depth target is now kept and bindable — no second geometry pass), at half
>   resolution as the editor's GTAO is, 16 hemisphere samples (golden-angle azimuth, golden-ratio heights, reach
>   growing with k; radius 0.35 m, power 3), a 4 × 4 blur, laid into the frame BEFORE bloom (`lit = color · ao`, the
>   editor's order) — post.rs blooms and tone-maps from that. NOT three's GTAO line for line (a horizon search): the
>   same idea in the same place, its strength tuned by eye. Two artifacts found and fixed on the way: false
>   occlusion in horizontal BANDS on a grazing floor (x / y rebuilt from the raw uv while z came from the whole pixel
>   → rebuilt at the pixel centre; and a bias growing with distance), and a too-weak term (heights had grown with the
>   reach, so every long sample pointed straight up). `ARTLUX_VIEW3D_AO_ONLY=1` shows the term alone,
>   `ARTLUX_VIEW3D_AO_RADIUS` overrides the radius. **Proof:** `test:engine-ao` (= test:engine-shadows --ao):
>   a box resting on the floor, the term alone — 222.9 along its base against 234.0 on open floor at the same
>   distance; the beams test's Rendered capture is clean of bands. SMAA is not ported: the window is 4× MSAA.
> - **Not yet (E4b…):** sources the engine does not draw (timeline video clips, a tracking overlay…) on screens
>   and venue meshes, the four-view layout, saving the window's place, macOS / Linux.

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
