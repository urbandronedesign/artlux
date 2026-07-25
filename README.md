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
- **Tracking sources** — the custom **OSC LiDAR blob** feed, **camera pose** (MediaPipe BlazePose, in-renderer WASM), and **Augmenta** optical tracking (OSC v2); visualize/project the blobs, and **record takes** to replay an interactive show with no tracker present.
- **Interactive show engine** — a project **state machine** (a "Show" graph over scenes): states + transitions driven by manual GO, auto-at-end, OSC, and **LiDAR trigger zones + combinations**, with hold-a-state, global `fromAny` rules, and a cold-start gate that waits for the opening content to decode. ▶ [docs/STATE-MACHINE.md](docs/STATE-MACHINE.md).
- **Show-control remote** — an embedded tablet **PWA** (scene / cue / transport / state-machine over your LAN), a **wall-clock scheduler**, live metrics, and an unattended **multi-project broadcast playlist**. ▶ [docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md).
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
> [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#the-audio-ui-is-all-there-and-nothing-plays--no-sound).

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
- [docs/PLUGINS.md](docs/PLUGINS.md) · [docs/SDK.md](docs/SDK.md) — the **plugin architecture** + the internal plugin SDK.
- [docs/WORKSPACE.md](docs/WORKSPACE.md) — the context-driven **editor shell** (workspace contexts, layout, UI scaling).
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, build, test, release, gotchas.
- [docs/FEATURES.md](docs/FEATURES.md) — feature/usage guide.
- [examples/](examples/README.md) — **openable template projects + written tutorials** (start with the [audio course](examples/audio/tuto/README.md) or the [state-machine course](examples/state-machine/tuto/README.md)).
- [docs/AUDIO.md](docs/AUDIO.md) — **spatialised, show-synchronised audio**: the bed vs a scene's own sound, two clocks, ambisonics + HRTF, insert chains, automation.
- [docs/STATE-MACHINE.md](docs/STATE-MACHINE.md) — the project **state machine** (a "Show" graph over scenes: states, triggers, actions).
- [docs/EFFECTS.md](docs/EFFECTS.md) — built-in **effects & palettes** reference (generative, media-free content).
- [docs/ASSETS.md](docs/ASSETS.md) — media library & asset management (import, usage, relink, consolidate).
- [docs/TRACKING_TAKES.md](docs/TRACKING_TAKES.md) — record & replay LiDAR blob takes from the timeline.
- [docs/SURFACES.md](docs/SURFACES.md) — surfaces engine design & roadmap.
- [docs/ROADMAP.md](docs/ROADMAP.md) — plugin-architecture record + what's next.
- [docs/PROGRESS.md](docs/PROGRESS.md) — build log / decisions.
- [docs/archive/](docs/archive/) — historical/superseded docs (the pre-Electron `ARCHITECTURE_PLAN`, the `UI_REFACTOR` notes, audio acceptance records).
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## Releases

Pushing a `v*` tag triggers a GitHub Actions matrix build that produces per-OS installers and
publishes a Release.

> ## ⚠ READ THE LICENCE BEFORE PUSHING A `v*` TAG.
> Every installer bundles `audio-engine.node`, which has **JUCE** and **libspatialaudio** linked into it
> (`extraResources`, `package.json`). The elections are now made and written down — [`LICENSE`](LICENSE),
> [`NOTICE`](NOTICE), and the `license` field — but a tag is still the moment every obligation attaches, so
> re-read **Licensing** below (and JUCE's own terms) before you publish.

## Licensing

**ArtLux is licensed for education and non-commercial use only — no commercial work is permitted.** The
operative text is **[`LICENSE`](LICENSE)** (Non-Commercial Educational Licence, © Zaki Jawhari and Bérenger
Recoules). **It is not an open-source licence**: it withholds the commercial rights every OSI-approved licence
grants. Full third-party inventory: **[`NOTICE`](NOTICE)**.

The app states this itself — the startup splash and the About dialog carry the credit and the restriction, and
that is a licence requirement (`LICENSE` §3), not decoration. The strings have one source,
[`shared/credits.ts`](shared/credits.ts).

That context matters, and it is worth being precise about *why*:

| | |
|---|---|
| **Building and running it locally** | Raises essentially nothing. Use JUCE and libspatialaudio, do research, teach with it. |
| **Publishing an installer** | Raises **everything below.** This is *distribution*, and it is what copyleft attaches to. |

**And distribution is already wired:** `extraResources` ships `audio-engine.node` — with **JUCE 8.0.14** and
**libspatialaudio 0.4.0** compiled into it — inside every installer, and pushing a **`v*` tag** runs a CI
matrix that **publishes a GitHub Release**. Nothing stands between this repo and a public binary except that
nobody has pushed a tag.

### What was decided

- **JUCE 8 → the free Starter tier, held by the two authors personally.** JUCE is dual-licensed: **AGPLv3**,
  or the JUCE 8 EULA (Starter free up to $20k revenue · Indie · Pro · Educational free for academics).
  **AGPLv3 is expressly not elected** — it is strong copyleft that would reach this whole application on
  distribution *and* would grant recipients the commercial rights `LICENSE` §2 withholds.
  **Educational was considered and rejected despite the authors qualifying for it**, because §1.2.4's last
  sentence makes it non-perpetual — it "shall only come into effect and endure for the period of time the
  Education Licence requirements are met", i.e. it ends at graduation and takes the right to keep
  distributing with it — and because it bars "promotional" use, which catches exhibitions, open days and
  showreels. **JUCE's terms change between major versions — read them at [juce.com](https://juce.com), and do
  not trust any figure quoted in this repository.**
- **`JUCE_DISPLAY_SPLASH_SCREEN=0` is reconciled** (`native/audio-engine/CMakeLists.txt`). The JUCE 8 EULA
  states no splash or attribution requirement on any tier, so the flag is consistent with Starter — and the
  addon genuinely has no window to draw one in. ArtLux's own splash names JUCE regardless.
- **libspatialaudio's LGPL static-link relinking obligation is discharged by a written offer** (`LICENSE` §5):
  object files + build instructions on request. Honouring it means keeping a reproducible audio-engine build
  per tagged release.
- **ArtLux has a `LICENSE`** — non-commercial, educational. Coherent with Starter, which imposes no copyleft.

#### The Starter revenue test, precisely

Starter is **free and perpetual**, capped at **$20,000 annual revenue** — but *whose* revenue depends on who
the licensee is, and the EULA's two definitions differ in a way that matters:

| Licensee | What §1.2.1 counts |
|---|---|
| **An individual** | "the total revenue or funding generated by that individual or entity's **use of the Framework** from all sources, including donations, sponsorship, advertising" — **JUCE-related income only.** ArtLux is free, takes no donations, and `LICENSE` §2 forbids charging for it → **zero**. |
| **A company** | "the total revenue or funding received by the entity **and all its Affiliates** … from all sources, **whether it be received in connection with the entity's use of the Framework or not**, without offsets of any kind" — **all income, JUCE-related or not.** |

So the licensee must be **the two authors as individuals** — never a company, studio or institution, whose
revenue counts in full whether it came from JUCE work or not. Also **§1.7** — "Every Framework User
contributing to or modifying source code … requires
a Licence" — so that is **two Starter seats, one each**, free but not automatic. §1.10's "keep seats active to
keep distributing" applies to *subscription* tiers only, so a perpetual Starter cannot retroactively strand a
published release. If the cap is ever exceeded, **§1.14** gives no grace period: upgrade the tier or stop
distributing.

### What is still open

- **Two Starter seats have not been registered yet**, and nobody has confirmed the reading above with JUCE.
  Both before the first tag — the full checklist is in [`NOTICE`](NOTICE) ("Before the first `v*` tag").
  Nothing in the code or build is involved: JUCE comes in via CMake `FetchContent`, there is no licence key,
  and the EULA imposes no splash or attribution requirement.
*Copyright is settled:* the two authors hold it **as individuals**; no company, studio or institution is a
party to the work or a JUCE licensee for it (`NOTICE` (g)).
- **HRTF/SOFA data terms** shipped with libspatialaudio are unreviewed.
- `appId` (`com.urbandronedesign.artlux`) and the GitHub release owner still say *urbandronedesign*. Those are
  **machine identifiers** — installer upgrade identity and release URL — and changing them would orphan every
  installed machine and its watchdog task. Authorship is `LICENSE` + [`shared/credits.ts`](shared/credits.ts).

> *Nothing here is legal advice. It is an engineer's record of what is linked, what is loaded, and what was
> decided — written down so the decisions were made on purpose. Have a lawyer read `LICENSE` before you rely
> on it, especially clause 2.*

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
different kind from NDI's. JUCE 8 is used under its free **Starter** licence; libspatialaudio is **LGPL-2.1+**
and statically linked, with the relink offer in [`LICENSE`](LICENSE) §5. See **[Licensing](#licensing)**.

ArtLux was **designed & built by Zaki Jawhari and Bérenger Recoules**.
