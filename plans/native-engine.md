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
> Next: **W2** (panels read their slice directly).

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
