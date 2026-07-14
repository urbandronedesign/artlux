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

It also plays the **sound**. A native **JUCE + ambisonics** engine puts every source at a *point in the
room*, decodes it to headphones (HRTF) or a real speaker array, and rides the **same transport** as the
picture — so a cue restarts the visuals without ever stuttering the house music.

It runs as a native **Electron** desktop app with a **WebGPU** compute pixel-mapper (WebGL
fallback), a **Rust** output engine (napi-rs) that owns UDP transmission on a dedicated thread, and a
**C++** audio engine (JUCE + libspatialaudio).

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
- **Spatial audio, on the show's clock** — a native **JUCE + libspatialaudio** engine: every source is a
  point in an **ambisonic** field, decoded **binaurally** (HRTF) or to a **speaker array**. Two containers on
  two clocks — a project-wide **bed** that a cue never restarts, and a Scene's **own** audio that always does.
  Insert chains (reverb / filter / delay / compressor), a mixer, and full **automation** of gain and position.
  ▶ [docs/AUDIO.md](docs/AUDIO.md) · [a six-chapter tutorial](examples/audio/tuto/README.md).
- **Headless mode** — run the compute + output engine with no UI to save resources.
- **Projects & rigs** — native save/load (`.artlux`), auto-restore on launch, recent files, and a
  reusable patch/wiring/routing **rig** export (`.artrig`).
- **Groups & scenes**, **undo/redo**, live **DMX monitor**, and a tokenized MadMapper-style UI.

See **[docs/FEATURES.md](docs/FEATURES.md)** for a usage guide.

## Run locally

**Prerequisites** — there are **two** native toolchains, because there are two native languages:

| For | You need |
|---|---|
| **Node / Electron** | [Node.js](https://nodejs.org/) **20+** |
| The **Rust** addons (output engine, Spout, HAP) | the [Rust toolchain](https://rustup.rs/) — **MSVC** on Windows |
| The **C++ audio engine** (JUCE + libspatialaudio) | **CMake ≥ 3.23** and a **C++17** compiler (MSVC on Windows / clang / gcc). CMake fetches JUCE 8.0.14 and libspatialaudio 0.4.0 at configure time — the first build downloads them. On Linux, JUCE also wants the usual ALSA/X11 dev packages. |

```bash
npm install
npm run build:native   # 3 Rust addons (output-engine, spout-receiver, hap) + the audio engine (optional)
npm run build:audio    # the JUCE audio engine on its own — STRICT (fails loudly)
npm run dev            # launch the Electron app
```

> ### ⚠ Two traps, and both of them look like "it just doesn't work".
>
> **1. No audio engine ⇒ a silent app that reports nothing is wrong.** `build:native` calls the audio build
> with `--optional`, so on a machine with no C++ toolchain it **warns and carries on** — deliberately, so a
> Rust-only contributor is not blocked. The app then starts, **the entire audio UI renders**, and there is no
> sound. It is not silent about it (a **`no audio engine`** badge and a startup notice), but if you skipped
> the warning you will not connect the two. **`npm run build:audio` is the strict build** — run it and read
> what it says.
>
> **2. A running app LOCKS the addon, and a failed link leaves the STALE one on disk.** If ArtLux is open,
> MSVC cannot overwrite `audio_engine.node`: the link fails with **`LNK1104`**, the build exits non-zero —
> **and the previous `.node` is still sitting there.** So a build you *think* succeeded silently ships the old
> engine, and a correct fix looks broken. **Close the app before any native rebuild.** If you edited
> `engine.cpp` and nothing changed, compare mtimes — see
> [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#no-sound).

**NDI (Windows):** the real NDI addon (`native/ndi/ndi.node`) is **committed as a prebuilt**, built
once against the [NDI 6 SDK](https://ndi.video/for-developers/ndi-sdk/) — so CI and end users **don't
need the SDK**. End users only install the free **NDI Runtime / NDI Tools** (the app shows an install
hint and degrades gracefully without it). To rebuild the addon after changing `native/ndi/src`, install
the NDI 6 SDK + LLVM and run `npm run build:ndi` (set `LIBCLANG_PATH` to your LLVM `bin`), then commit
the updated `ndi.node`. Full setup + usage + architecture: [docs/NDI.md](docs/NDI.md).

### Build / package

```bash
npm run build          # main + preload + renderer bundles
npm run package        # installers — REBUILDS the audio engine first (strict), then electron-builder
npm run package:dir    # the same, unpacked, for a quick smoke test
```

**Packaging rebuilds the C++ audio engine and hard-fails without it** — `package` runs
`scripts/build-audio.cjs` with no flags. That is on purpose: the loader graceful-degrades to *silence*, so an
installer cut without an engine would ship a complete, working-looking audio UI that makes no sound. It must
be impossible to cut one by accident. (The **Rust** addons are *not* rebuilt by `package` — run
`npm run build:native` yourself if you changed them.)

### Headless

```bash
ArtLux.exe --headless --project="C:\path\to\show.artlux"
```

Runs only the Stage compute + output loop in an invisible, GPU-backed window. See
[docs/FEATURES.md](docs/FEATURES.md#headless-mode).

## Tech stack

Electron · React 19 · TypeScript · Vite · Tailwind CSS · WebGPU (WebGL fallback) ·
react-three-fiber · Rust (napi-rs) · **C++17 (CMake / cmake-js) · JUCE 8 · libspatialaudio** ·
Art-Net + sACN/E1.31

## Documentation

- [docs/user-guide/](docs/user-guide/README.md) — **illustrated end-user guide**: a screenshot‑driven, task‑oriented page for every screen of the app (interface, surfaces/content, fixtures, routing, effects, timeline, outputs, 3D, calibration, projects/media, preferences) + keyboard reference.
- [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — the same end-user guide as a single text page (no screenshots).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — **how the app works today** (canonical).
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, build, test, release, gotchas.
- [docs/FEATURES.md](docs/FEATURES.md) — feature/usage guide.
- [examples/](examples/README.md) — **openable template projects + written tutorials** (start with the [audio course](examples/audio/tuto/README.md) or the [state-machine course](examples/state-machine/tuto/README.md)).
- [docs/AUDIO.md](docs/AUDIO.md) — **spatialised, show-synchronised audio**: the bed vs a scene's own sound, two clocks, ambisonics + HRTF, insert chains, automation.
- [docs/STATE-MACHINE.md](docs/STATE-MACHINE.md) — the project **state machine** (a "Show" graph over scenes: states, triggers, actions).
- [docs/EFFECTS.md](docs/EFFECTS.md) — built-in **effects & palettes** reference (generative, media-free content).
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

> ## 🛑 DO NOT PUSH A `v*` TAG UNTIL THE LICENSING BELOW IS SETTLED.
> Every installer bundles `audio-engine.node`, which has **JUCE** and **libspatialaudio** linked into it
> (`extraResources`, `package.json`). This repo currently has **no `LICENSE`, no `NOTICE`, and no `license`
> field in `package.json`** — so the tag workflow is the only thing standing between here and a **publicly
> distributed binary carrying two copyleft dependencies with no notice.** See **Licensing** below.

## Licensing

> ### ⚠ UNRESOLVED — and it gates the first release, not the next commit.

ArtLux links two third-party libraries into the audio engine, and **the licence election has not been made:**

| Dependency | Version | Terms |
|---|---|---|
| **JUCE** | 8.0.14 | Free while revenue is under **US$20k/yr**. Above that: **US$800 perpetual Indie**. **Otherwise it is AGPL-3.0 — which is viral**, and would reach the whole application. |
| **libspatialaudio** | 0.4.0 | **LGPL-2.1** — dynamic-link, or comply. |

**What exists today: nothing.** No `LICENSE` file. No `NOTICE`. No `license` field in `package.json`. The
only record of the obligation anywhere in the repo is one row in
[`plans/SEQUENCING.md`](plans/SEQUENCING.md) (merge gate 4), still marked *pending*.

**This does not block development and it does not block the merge.** It blocks **distribution** — and
distribution is one `git push --tags` away, which is why it is written here and not filed quietly.

**Three things have to happen, in this order, and the first is a decision only the project owner can make:**

1. **Elect a JUCE path** — stay under the revenue threshold, buy the Indie licence, or accept AGPL and open
   the whole application under it. *This is a business decision, not an engineering one.*
2. **Add a `LICENSE`** for ArtLux itself (constrained by 1 — AGPL is not a free choice if it is elected).
3. **Add a `NOTICE`** recording JUCE, libspatialaudio, and NDI, and add a `license` field to `package.json`.

### macOS install note

ArtLux is **ad-hoc signed but not notarized** (no Apple Developer account), so macOS Gatekeeper
flags the downloaded app. After dragging **ArtLux** to Applications, open it once via **right-click →
Open → "Open Anyway"**, or run:

```bash
xattr -dr com.apple.quarantine "/Applications/ArtLux.app"
```

This is a one-time step per install. (Builds are Apple Silicon / arm64.)

### Acknowledgements

**NDI®** is a registered trademark of Vizrt NDI AB. NDI support uses the free NDI® SDK / Runtime
(<https://ndi.video>). Install the NDI Runtime / NDI Tools to enable NDI send + receive.
*NDI is loaded at runtime and is not linked into any binary here.*

**JUCE** (<https://juce.com>) and **libspatialaudio** (<https://github.com/videolabs/libspatialaudio>) are
**compiled and linked into `audio-engine.node`**, which ships inside every installer — an obligation of a
different kind from NDI's, and one this repo has not yet discharged. See **[Licensing](#licensing)**.
