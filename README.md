```
      _      ____    _____   _      _   _  __  __
     / \    |  _ \  |_   _| | |    | | | | \ \/ /
    / _ \   | |_) |   | |   | |    | | | |  \  /
   / ___ \  |  _ <    | |   | |___ | |_| |  /  \
  /_/   \_\ |_| \_\   |_|   |_____| \___/  /_/\_\

  GPU-accelerated addressable-LED pixel mapping for Art-Net / sACN
```

# ArtLux

ArtLux is a **professional addressable-LED pixel-mapping console** for Windows/macOS/Linux —
a MadMapper-class tool for driving RGB/RGBW LED rigs. Sample color from video, images, a live
camera, incoming DMX, or a **Spout** stream; lay fixtures out in 2D (and 3D); and stream the
result to your hardware over **Art-Net** or **sACN/E1.31** with a native, threaded output engine.

It runs as a native **Electron** desktop app with a **WebGPU** compute pixel-mapper (WebGL
fallback) and a **Rust** output engine (napi-rs) that owns UDP transmission on a dedicated thread.

## Features

- **GPU pixel mapping** — a WebGPU compute shader samples the source per-LED in real time.
- **WLED-style effects** — gradient palettes, stateful fire2012, and multi-segment fixtures.
- **Content sources** — video, image, live camera, **DMX in** (Art-Net/sACN), **Spout** (Windows), and **NDI** (network video).
- **Media library** — a managed asset library (video, image, 3D model, LiDAR take): import (copy-in), previews, usage/missing tracking, relink, and drag-to-place onto the Stage or Timeline.
- **LiDAR tracking + takes** — receive the OSC blob tracking feed, visualize/project it, and **record takes** to replay an interactive show with no tracker present.
- **Projector outputs + NDI out** — map each surface fullscreen to a projector (corner-pin / Bézier warp, soft-edge, gamma) and optionally publish each output as an **NDI source**.
- **Projection mapping & auto-align** — calibrate a real projector (structured-light Gray-code + pose, or **markerless camera auto-align** onto the venue 3D model) and render the scene from its recovered viewpoint; export/import **MPCDI**. On **Quadro / RTX-pro** GPUs, apply geometry **warp + edge-blend at the GPU scanout via NVIDIA NVAPI** (content-agnostic, persistent), with a GLSL fallback everywhere else.
- **2D + 3D** — drag/resize/rotate/snap on a 2D stage; arrange the same fixtures in a 3D simulator.
- **Per-pixel correctness** — color order, RGBW white extraction, gamma, matrix + serpentine, ledmap.
- **Per-fixture routing** — each fixture can target its own controller IP / protocol / priority.
- **Native output** — Art-Net + sACN over UDP from a Rust send thread (pacer, keep-alive, sparse,
  **ArtSync**).
- **Art-Net device discovery** — ArtPoll/ArtPollReply; pick a controller instead of typing its IP.
- **Headless mode** — run the compute + output engine with no UI to save resources.
- **Projects & rigs** — native save/load (`.artlux`), auto-restore on launch, recent files, and a
  reusable patch/wiring/routing **rig** export (`.artrig`).
- **Groups & scenes**, **undo/redo**, live **DMX monitor**, and a tokenized MadMapper-style UI.

See **[docs/FEATURES.md](docs/FEATURES.md)** for a usage guide.

## Run locally

**Prerequisites:** [Node.js](https://nodejs.org/) and the [Rust toolchain](https://rustup.rs/)
(MSVC on Windows) to build the native engine.

```bash
npm install
npm run build:native   # Rust output engine + Spout receiver + NDI (stub) -> .node addons
npm run dev            # launch the Electron app
```

**NDI (Windows):** the real NDI addon (`native/ndi/ndi.node`) is **committed as a prebuilt**, built
once against the [NDI 6 SDK](https://ndi.video/for-developers/ndi-sdk/) — so CI and end users **don't
need the SDK**. End users only install the free **NDI Runtime / NDI Tools** (the app shows an install
hint and degrades gracefully without it). To rebuild the addon after changing `native/ndi/src`, install
the NDI 6 SDK + LLVM and run `npm run build:ndi` (set `LIBCLANG_PATH` to your LLVM `bin`), then commit
the updated `ndi.node`. Full setup + usage + architecture: [docs/NDI.md](docs/NDI.md).

### Build / package

```bash
npm run build          # main + preload + renderer bundles
npm run package        # installers (electron-builder)
npm run package:dir    # unpacked app for a quick smoke test
```

### Headless

```bash
ArtLux.exe --headless --project="C:\path\to\show.artlux"
```

Runs only the Stage compute + output loop in an invisible, GPU-backed window. See
[docs/FEATURES.md](docs/FEATURES.md#headless-mode).

## Tech stack

Electron · React 19 · TypeScript · Vite · Tailwind CSS · WebGPU (WebGL fallback) ·
react-three-fiber · Rust (napi-rs) · Art-Net + sACN/E1.31

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — **end-user guide**: workflows (surfaces, fixtures, LED mapping, outputs, 3D, timeline) + full keyboard/mouse reference.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — **how the app works today** (canonical).
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, build, test, release, gotchas.
- [docs/FEATURES.md](docs/FEATURES.md) — feature/usage guide.
- [docs/ASSETS.md](docs/ASSETS.md) — media library & asset management (import, usage, relink, consolidate).
- [docs/TRACKING_TAKES.md](docs/TRACKING_TAKES.md) — record & replay LiDAR blob takes from the timeline.
- [docs/SURFACES.md](docs/SURFACES.md) — surfaces engine design & roadmap.
- [docs/UI_REFACTOR.md](docs/UI_REFACTOR.md) — design system + UI architecture.
- [docs/PROGRESS.md](docs/PROGRESS.md) — build log / decisions.
- [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md) — original pre-Electron rewrite roadmap (historical).
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## Releases

Pushing a `v*` tag triggers a GitHub Actions matrix build that produces per-OS installers and
publishes a Release.

### macOS install note

ArtLux is **ad-hoc signed but not notarized** (no Apple Developer account), so macOS Gatekeeper
flags the downloaded app. After dragging **ArtLux** to Applications, open it once via **right-click →
Open → "Open Anyway"**, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/ArtLux.app"
```

This is a one-time step per install. (Builds are Apple Silicon / arm64.)

### Acknowledgements

NDI® is a registered trademark of Vizrt NDI AB. NDI support uses the free NDI® SDK / Runtime
(<https://ndi.video>). Install the NDI Runtime / NDI Tools to enable NDI send + receive.
