# ArtLux — Development & Release Guide

How to set up, run, build, test, and release ArtLux. See [ARCHITECTURE.md](ARCHITECTURE.md) for how
the system fits together and [PROGRESS.md](PROGRESS.md) for the running build log.

## Day-to-day workflow (the loop)
1. **Edit** renderer/main/shared code. The renderer hot-reloads in `npm run dev`; **main-process or
   preload changes need a full app restart** (stop dev + kill stray `electron`, relaunch).
2. **Typecheck**: `npx tsc --noEmit -p tsconfig.json` (the whole tree; there is no `include`).
3. **Build** when adding a new HTML entry / dependency / native change: `npm run build`.
4. **Run** to verify in the real app: `env -u ELECTRON_RUN_AS_NODE npm run dev` (see gotchas).
5. **Commit on `main`** (this repo commits directly to main), small and scoped; **push only when asked**.
6. **Release** = bump version + CHANGELOG, commit, **tag `vX.Y.Z`**, push the tag → CI builds + publishes
   (see Release process).

The **3D scene** lives in the main mapping window (`index.html`/`App.tsx`) as a split-view pane —
the `Simulator3D` canvas plus the `ScenePanel3D` outliner (OBJECTS / FIXTURES / transform / LIGHTING),
toggled from the Stage toolbar. It reads live LED data, the timeline engine, and tracking in-process,
so there is no separate window or bridge. Separate **projector output** windows
(`projector.html`/`projector/ProjectorApp.tsx`) still bridge over `MessageChannelMain`
(`projector/bridge.ts`) for per-display fullscreen output.

## Prerequisites
- **Node.js** (≥ 20) and npm.
- **Rust** toolchain (`rustup`, stable) for the native addons — MSVC on Windows.
  - The Spout addon (`native/spout-receiver`) builds the vendored Spout2 C++ SDK on Windows (needs
    the MSVC C++ build tools); it compiles to no-op stubs on macOS/Linux.
- **CMake ≥ 3.23 + a C++17 toolchain** — only for the JUCE **audio engine** (`native/audio-engine`,
  the one non-Rust native module). Optional for day-to-day work: without it everything builds and
  runs, you just get no sound (see below). MSVC on Windows, Xcode CLT on macOS, and on Linux the
  JUCE dev packages: `libasound2-dev libx11-dev libxext-dev libxrandr-dev libxinerama-dev
  libxcursor-dev libfreetype-dev libfontconfig1-dev`.

## Install & run
```bash
npm install
npm run build:native   # 3 Rust crates (output-engine + spout-receiver + hap) → native/*/*.node
                       # (gitignored), then the audio engine (optional, warns)
npm run build:audio    # just the JUCE audio engine — REQUIRED for sound
npm run dev            # launch the Electron app (electron-vite dev)
```

The other three native crates have their own opt-in scripts (not run by `build:native`): **`build:ndi`**
(the NDI addon; a prebuilt `native/ndi/ndi.node` is committed, so you rarely rebuild it), **`build:calib`**
(OpenCV projector calibration — needs OpenCV + LLVM in a vcvars64 env, see `scripts/build-calib.ps1`),
and **`build:nvwarp`** (NVIDIA NVAPI warp/blend — Windows + the NVAPI SDK). All degrade gracefully when
absent (see [INSTALL.md](INSTALL.md) for the packaged-resources list).

### Audio engine (`native/audio-engine`) — mandatory to ship, optional to develop
JUCE + libspatialaudio, built with **cmake-js**, not cargo. `plugins/audio` **graceful-degrades**: if
`audio_engine.node` is absent the app still starts and the whole audio UI still renders — with **no
sound and no error**, only `[audio] native engine unavailable` in the console. That makes a missing
engine dangerously easy to miss, so the build system treats it this way:

| Path | Behaviour if the engine won't build |
|------|--------------------------------------|
| `npm run build:native` | **Warns loudly, continues.** A cargo-only contributor is not blocked, but is told audio is dead. |
| `npm run build:audio` | **Hard fails.** |
| `npm run package` / `package:dir` | **Hard fails** — an installer can never be cut without an engine. ⚠ It **rebuilds** it: both run `scripts/build-audio.cjs` with **no flags**, a full strict build. It is *not* a `--check`, and the difference matters — `--check` only asserts the addon **exists** and says nothing about whether it is **current**, so a stale engine would sail straight into an installer. (This row said `--check` until 2026-07-14; commit `473d259` changed the behaviour and left both this table and the note further down describing the old contract.) |
| CI (`.github/workflows/build.yml`) | **Hard fails** — a tagged release cannot ship a silent audio UI. |

Unlike `ndi.node`/`calib.node`, the addon is **not** a committed prebuilt: it is platform-specific,
so every machine and every CI runner builds its own. It is gitignored (`*.node`).

> **Close the app before rebuilding.** A running Electron holds `audio_engine.node`; the link fails
> (`LNK1104` on Windows) and **silently leaves the stale addon in place**, so you debug code that
> isn't loaded. Stop `npm run dev` and kill stray `electron` processes first.

### ASIO (optional)
**Off by default, and that's a decision, not an oversight.** Multichannel output on Windows is
already delivered by **WASAPI exclusive mode**, compiled into the addon unconditionally — that's
the **supported** path for discrete multichannel (see the driver-type grouping in AudioSettings'
device picker). A show bed does not need ASIO.

What ASIO would buy: lower latency than WASAPI exclusive.

What it costs: the **Steinberg ASIO SDK**, which is not redistributable, carries its own licence,
cannot be vendored into this repo, and cannot be fetched by CI — plus **zero test coverage**,
because nobody on this project has ASIO hardware to build against. Turning it on adds a **third**
licence obligation to a build that already carries JUCE's (still **unelected** — see `NOTICE`) and
libspatialaudio's LGPL.

If a venue genuinely needs it: download the SDK from [steinberg.net](https://www.steinberg.net/developers/)
(free registration required), then point CMake at its `common` directory:
```bash
cmake -DARTLUX_ENABLE_ASIO=ON -DASIO_SDK_DIR=C:/path/to/asiosdk/common
```
The configure step hard-fails with a clear message if `ASIO_SDK_DIR` doesn't contain
`iasiodrv.h`. Leave it `OFF` unless you have both the SDK and the hardware to test it against.

### "The audio UI is all there and nothing plays" — no sound?
There is no error dialog and no red UI: the loader degrades to a no-op by design, so a missing **or
stale** engine looks exactly like a bug in your code. Work the list in order.

**1. Read the log — in the terminal, not DevTools.** `audioManager` runs in the **main process**
(the addon is loaded with `createRequire`), so its lines go to the console running `npm run dev`.
The renderer DevTools console will never show them. You get exactly one of:

| Line (`plugins/audio/src/audioManager.ts`) | Means |
|---|---|
| `[audio] native engine loaded (JUCE 8.0.14)` | An addon loaded. **This does not mean it is current** — go to step 3. |
| `[audio] native engine unavailable — audio disabled` | No addon found or loaded. Step 2. |
| `[audio] native engine load failed at <path> <err>` | The file **exists** but `require()` threw — ABI/arch mismatch, missing runtime DLL. |

The `load failed` warning is only printed for a path that **exists**. A file that is simply absent
logs nothing per-path — you just get `unavailable`. So *`unavailable` with no per-path error means
the addon isn't there at all*, not that it failed to load.

**2. Does the addon exist?** The loader probes, in order (`audioManager.ts:61-65`):
```
<resourcesPath>/audio-engine.node                     # packaged (extraResources; note the HYPHEN)
native/audio-engine/build/Release/audio_engine.node   # dev — the raw cmake-js output (UNDERSCORE)
native/audio-engine/audio_engine.node                 # the copy scripts/build-audio.cjs makes
```
None present → `npm run build:audio` (needs CMake ≥ 3.23 + a C++17 toolchain; see Prerequisites).

**3. Is it NEWER than `native/audio-engine/src/engine.cpp`?** This is the one that wastes an
afternoon: a stale addon **loads fine and logs `native engine loaded`**, so success and staleness are
indistinguishable in the log. If you edited `engine.cpp` and nothing changed, compare mtimes:
```powershell
Get-Item native/audio-engine/build/Release/audio_engine.node, native/audio-engine/src/engine.cpp |
  Select-Object Name, LastWriteTime
```
Addon older than the source → **your last build never linked.** Almost always because the app was
running: MSVC fails `LNK1104`, `build:audio` exits non-zero, and the previous `.node` stays on disk.
Confirm nothing holds it (`tasklist /FI "IMAGENAME eq electron.exe"` → *No tasks*), then rebuild.

**4. Packaging DOES rebuild the engine.** `npm run package` runs `scripts/build-audio.cjs` with **no
`--check`** — the addon is compiled from source as part of every package, so you do **not** need to run
`npm run build:audio` first. (`build:native` still calls it with `--optional`, so a Rust-only build does
not hard-fail on a machine with no C++ toolchain. CI starts from a clean clone with no addon at all.)

> This entry said the exact opposite until 2026-07-14, and had done since `473d259` changed the
> behaviour and left the document describing the old one. If you are reading a stale checkout, trust
> `package.json`, not this file.

## Fresh-machine setup — the preflight, and what the installer provisions

Everything native in ArtLux **degrades gracefully**: a missing addon or runtime logs one line to the
main-process console, disables its feature, and never crashes. That is the right behaviour and it is
also the reason a bad install is nearly undiagnosable — putting ArtLux on a second machine produced an
app with **no NDI and no calibration**, with nothing on screen saying so.

Two things now exist because of that.

### `npm run preflight` — check a machine before (or after) installing

`scripts/preflight.ps1`, Windows, PowerShell 5.1, no dependencies. Exits non-zero on any FAIL.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Mode all      # dev + runtime
powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Mode runtime  # a venue PC
powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1 -Mode dev      # a build machine
#   -Json / -OutFile <path>   machine-readable report      -Fix   winget-install the two redists
#   -InstallDir <path>        audit an install electron-builder put somewhere non-standard
```

| Mode | Checks |
|---|---|
| `runtime` | VC++ 2015-2022 x64 runtime · **NDI Runtime** · an audit of the installed `resources/` against the full expected file set · a **PE import-table scan of every `.node`** (catches "file present, dependency unresolvable") · real D3D12 GPU + driver age · an enabled audio output device · firewall rules, network profile, NIC count, and whether 6454/5568/10000/8788 are free · displays · disk · elevation |
| `dev` | Node ≥ 20 · Rust stable **MSVC host** · MSVC C++ build tools (vswhere) · CMake ≥ 3.23 · optional OpenCV 4.11 + LLVM + NDI SDK · every artifact `npm run package` needs, including the three gitignored ones · MediaPipe assets · a stray `electron.exe` holding the addons |

The import scan is the one that pays for itself: it reads the PE import directory rather than trusting
`existsSync`, so `calib.node` present-but-with-no-`opencv_world4110.dll` reports as a failure instead of
looking fine. It knows about the dirs the app injects itself (`ensureNdiOnPath()` in
`plugins/ndi/src/ndiManager.ts`), so a correctly-installed NDI Runtime does not read as a false positive.

The installer runs `-Mode runtime -Json` at the end of every install and leaves the report at
`%APPDATA%\artlux\preflight.json`.

### What `npm run package` now stages automatically

Three build inputs are **gitignored** and were therefore absent on any machine that had not built them
by hand — including every CI runner. `package` / `package:dir` fetch them first (`prepack:assets`) and
then **assert** them:

| Input | Fetched by | Was silently missing from |
|---|---|---|
| `native/calib/opencv_world4110.dll` (62 MB) | `npm run fetch:opencv` | **every released installer** — CI never ran `build:calib` |
| `build/ndi/NDI-Runtime.exe`, `build/vcredist/vc_redist.x64.exe` | `npm run fetch:redist` | every installer — never bundled at all |
| `src/renderer/public/mediapipe/{wasm,models}` | `npm run assets:mediapipe` | every released installer — CI never ran it |

> **Why they went missing silently:** electron-builder resolves an `extraResources` `from` path as a
> **glob**. A literal path that matches nothing is not an error — it is a skip. The build stays green
> and the failure surfaces on the venue PC. `npm run verify:resources`
> (`scripts/verify-package-resources.cjs`) closes that hole: it re-reads the same `extraResources`
> declarations out of `package.json` and hard-fails if a declared source is absent or zero-length. It
> runs in `package`, `package:dir`, and CI, ahead of electron-builder.

### What the installer provisions (`build/installer.nsh`)

NSIS `customInstall`, which electron-builder also re-runs on every **electron-updater update**, so all
of it is idempotent and re-asserted:

1. **NDI Runtime** — installed silently when `NDI_RUNTIME_DIR_V6` / the registry key is absent.
2. **VC++ 2015-2022 x64** — installed silently when the `VC\Runtimes\x64` key says otherwise.
3. **Firewall rules** — program rules for `ArtLux.exe` plus explicit inbound rules for Art-Net 6454/UDP,
   sACN 5568/UDP, OSC 10000/UDP, show-control 8788/TCP. Removed by `customUnInstall`.
4. **Preflight report** → `%APPDATA%\artlux\preflight.json`.

`customUnInstall` also removes the watchdog Scheduled Task, which would otherwise keep relaunching a
deleted binary once a minute forever.

> **`nsis.perMachine` is `true`** — and it must stay that way. All of the above needs elevation; a
> per-user one-click install never prompts for UAC, so `netsh` and both redistributables would fail
> **silently**, which is the exact failure mode this work exists to remove.

Not automatable, so the preflight reports them instead: GPU driver updates, the ASIO SDK (see above),
the PS3 Eye camera driver, and physical NIC/multicast configuration.

### Scripts
| Script | What |
|--------|------|
| `npm run dev` | dev server + Electron |
| `npm run build` | build main + preload + renderer bundles |
| `npm run build:native` | cargo build the 3 Rust crates + copy to `*.node`, then the audio engine (warns, non-fatal) |
| `npm run build:audio` | cmake-js build the JUCE audio engine → `native/audio-engine/audio_engine.node` (strict) |
| `npm run preflight` | dependency check, dev + runtime (`scripts/preflight.ps1`) |
| `npm run fetch:redist` | download the NDI Runtime + VC++ redistributable into `build/` (gitignored) |
| `npm run fetch:opencv` | download `opencv_world4110.dll` into `native/calib/` (gitignored) — no OpenCV toolchain needed |
| `npm run verify:resources` | assert every declared `extraResources` file exists (runs in `package` + CI) |
| `npm run gen:icon` | regenerate `build/icon.{png,ico}` + favicon from `build/icon.svg` |
| `npm run package` | full installers: stage assets → build audio → bundle → verify → electron-builder |
| `npm run package:dir` | unpacked app (fast local smoke test), same staging + verification |

## Headless
```bash
ArtLux.exe --headless --project="C:\path\to\show.artlux"
```
Runs only the Stage compute + output loop in a hidden GPU window (no UI). Omit `--project` to use the
last-opened project.

## Testing
There is no unit-test runner wired; verification is done ad-hoc with tsc + targeted scripts:
- **Typecheck/build:** `npx tsc --noEmit` then `npm run build`.
- **Pure logic** (e.g. `addressing.autoPatch`, `frameCodec`): run a throwaway `node
  --experimental-strip-types test/x.ts` importing the module (use `import type` for type-only deps so
  it resolves standalone), then delete it.
- **Output (end-to-end):** launch `--headless --project=<crafted project>` and capture the real UDP
  with a `dgram` listener — parse ArtDmx (`0x5000`) / ArtSync (`0x5200`) / sACN (`ASC-E1.17`), assert
  per-universe channel counts, per-IP routing, priority, etc. This is how the surfaces engine,
  multi-controller routing, sACN, ArtSync, and universe spanning were validated.
- **The engine is independent of the UI:** `node scripts/test-engine-output.cjs`. Writes its own
  project, points Art-Net at loopback, and asserts on the wire that output survives (1) running at
  all, (2) **the Stage's canvas and container being deleted out of the live DOM**, (3) a full
  workspace-context tour, (4) `--headless`, which mounts no view whatsoever. `npm run verify` reads
  source and can only prove the code still *looks* decoupled; this proves DMX still comes out.
  ⚠ Two traps it encodes, both of which cost real time: the Art-Net ID is `'Art-Net\0'` (a trailing
  **space** silently matches nothing and reports a healthy app as dead), and it must not bind **6454** —
  the app's own Art-Net *input* socket owns that port, so a listener there sees nothing.
- **Packaged window visibility — test WITHOUT the CDP port (this cost a day, v0.19.2).** The editor
  `BrowserWindow` is created `show:false` and revealed on events; if reveal is only wired to
  **`ready-to-show`**, some packaged builds/GPU configs never fire it and the app launches with a
  running process but **no window at all** (looks headless — not broadcast). Two traps that hid it:
  (1) `npm run dev` always works (the http dev-server load triggers `ready-to-show`), so dev is not a
  valid test for this; (2) **enabling the remote-debugging port (`ARTLUX_CDP_PORT`) forces a paint,
  which makes the window appear** — so any CDP-based check (`document.visibilityState`, geometry via
  the DevTools protocol) *falsely passes*. To verify packaged window visibility, launch the packaged
  `ArtLux.exe` with **no `ARTLUX_CDP_PORT`** and confirm a real top-level window via Win32
  `EnumWindows`+`IsWindowVisible` (filter to the ArtLux PIDs) or a screenshot — never via CDP. The fix
  is to reveal on `did-finish-load` (always fires once the page loads) + a backstop timer, not only
  `ready-to-show` (see `createWindow` in `src/main/index.ts`).
  > **IT HAPPENED AGAIN in v0.25.0 — to the startup splash, which is a second window nobody thought to
  > apply this to.** `splashWindow.ts` shipped with a lone `once('ready-to-show')`; in the packaged
  > installer the event never fired, so the window was created and never shown. It then *deleted itself
  > silently*, because its close deadlines are measured from the show timestamp and `Date.now() - 0`
  > reads as "every deadline long past" — the log said `closing after 1784993242235ms`. Two lessons on
  > top of the v0.19.2 ones: **(a)** this rule applies to EVERY window the app must show, not just the
  > editor — `npm run verify:invariants` now fails any main-process reveal wired to `ready-to-show`
  > without both a `did-finish-load` path and a backstop timer; **(b)** if a window's lifetime is
  > computed from when it appeared, guard the not-yet-shown case explicitly, or a zero timestamp turns
  > "wait" into "destroy immediately". A `[splash] closing after <huge>ms` line is the fingerprint.
- **Kill test instances after each run.** There is no single-instance lock, so leftover launches
  (especially `--broadcast`, which shows a tray icon + fullscreen projector windows) accumulate and
  look exactly like a bug on next launch. `Get-Process ArtLux,electron | Stop-Process -Force` between
  tests; several instances also contend over the shared `userData` GPU cache (`Access is denied`).

## Profiling — finding a bottleneck from OUTSIDE the app
The app measures itself in two places: `services/perfMonitor` (frame interval + in-frame work, always
on) and `services/uiPerfMonitor` (long tasks always on, React commits opt-in), both surfaced in the
Performance panel and pushed to `/metrics`. **Neither can say what a frame was blocked BY**, because
both measure the frame from inside it — and neither sees the GPU at all. For that, use external tools.
Nothing below requires a build mode or a code change; profiling that alters the app measures the
instrument. A visual map of what runs where is
[plans/engine-decoupling-execution-map.html](../plans/engine-decoupling-execution-map.html).

**Three questions, three tools. Do them in that order — the first one is five minutes and often ends
the investigation.**

### 1. Is the GPU saturated, or starving? → Intel PresentMon
Open source (Intel), no instrumentation, real-time overlay. Its **GPU Busy** counter is the time the
GPU actually spent executing the commands for a frame; put it beside CPU frame time and the balance
reads directly. GPU Busy well under frame time means the GPU is *starving* and the bottleneck is on
the CPU — which, given the frame pipeline is one thread, is the expected answer and worth confirming
before spending an afternoon anywhere else. Works on NVIDIA and AMD despite the name.

The app itself cannot answer this: it requests no `timestamp-query` feature, so there is **no GPU
timing anywhere in `src/`**. Until that changes, PresentMon is the only source for it.

### 2. What is the renderer main thread doing? → Chromium tracing + Perfetto
```bash
# 1. launch with the debugging port open — dev OR packaged, editor OR headless
$env:ARTLUX_CDP_PORT=9333; npm run dev     # in the sandbox: env -u ELECTRON_RUN_AS_NODE (see gotchas)
# 2. capture (a separate terminal); exercise the app during the countdown
npm run profile:trace -- --duration 15 --label context-switch
# 3. drag the written .traces/*.json onto https://ui.perfetto.dev  (stays on your machine)
```
**Budget the disk and the wait.** Measured at the default categories: **~11 MB and ~60k events per
second** of recording (8 s of an *idle* editor → 483,680 events, 86 MB), and the buffer drain after
`Tracing.end` takes roughly as long again as the recording did. 15 s is a big capture; 30 s is a very
big one. `.traces/` is gitignored — a trace is one machine on one day, never a fact about the tree.
`scripts/trace-cdp.cjs` attaches over the DevTools protocol and drives the **browser-level** `Tracing`
domain, so the capture spans every Chromium process. You get one timeline with `CrRendererMain`,
`CrGpuMain`, `Compositor` and the raster pool as separate tracks — which is how you *see* rather than
infer that `frameEngine.tick`, the timeline transport, the projector pump, the 3D scene and React are
five `requestAnimationFrame` loops queued end-to-end on one thread.

- Look first at **`CrRendererMain` → the `FireAnimationFrame` slices**, back to back. Their widths are
  the real version of the execution map's estimates.
- Anything marked **`Forced reflow`** is a synchronous layout — the cost WP-0.M measured at a context
  switch (~70–105 ms, ~40 of them) but could not attribute.
- `--js` adds the V8 sampling profiler (a real JS flame chart, heavier); `--heavy` adds task-queue and
  V8 execute detail — keep those captures short or the buffer overflows.
- The script **refuses to write a trace with zero events** and prints the threads it captured, warning
  loudly if `CrRendererMain` is missing. That is deliberate: see the traps below.

**What a healthy idle capture looks like**, so you can tell a boring trace from a broken one: 44
threads, `CrGpuMain` and `CrRendererMain` the two busiest, and **3,401 `FireAnimationFrame` slices in
8 s — p50 0.09 ms, p99 2.06 ms, max 15.18 ms**. Two `CrRendererMain` tracks is normal (the editor plus
a second renderer); the rAF count is well above 8 × 60 because several loops share the thread. If your
capture is missing the rAF slices entirely, `devtools.timeline` was rejected — check the spelling
before reading anything into the result.

### 2b. "Everything is slow and the profiler blames `(program)`" → you are GPU-bound

A V8 CPU profile that attributes 70–80% of the renderer to **`(program)`** with almost no idle is not
telling you the JS is slow. `(program)` is V8's bucket for time the thread spent outside JavaScript,
and the usual cause here is that it was **parked in a blocking IPC wait for the GPU process**. The
Chromium trace names it where the CPU profile cannot:

| Where | What you see when the GPU is the wall |
|---|---|
| `CrRendererMain` | **`Receive mojo reply`** dominating (measured: 58% of a 10 s window) |
| `CrGpuMain` | occupancy at or near **100%**, with `WebGL`, `CommandBuffer::Flush`, `SwapBuffers` and `DXGISwapChainImageBacking::Present` as the top slices |

When those two line up, stop optimising the renderer — it is idle-blocked, not busy. Confirmed on an
**Intel Iris Xe** driving the editor's 3D scene *and* a calibrated projector window (two independent
3D scenes, a distortion+blend composer, WebGPU sampling and two 1080p presents): GPU process 99.3%,
renderer 58% in `Receive mojo reply`, ~22 fps. **The same measurement with a whole feature branch
stashed was also ~22 fps** — which is the point of taking it: a stash-and-remeasure separates "my diff
regressed this" from "this configuration costs this much", and here it was entirely the latter.

Two amplifiers worth ruling out before blaming the app:
- **Remote desktop.** A `Parsec Virtual Display Adapter` (or similar) in `Get-CimInstance
  Win32_VideoController` means the screen is being **encoded on the same GPU** the app is competing
  for. Benchmark locally, or you are measuring the encoder.
- **Integrated graphics.** `[nvwarp] NVAPI unavailable (stub build / non-pro GPU)` in the boot log is
  a reliable tell that this is not the target hardware — and it also means the scanout warp/blend path
  is inert, so the GPU is doing work it would not have to on a workstation card.

### 3. Which GPU dispatch? → RenderDoc
Only when you need per-dispatch detail. It captures WebGPU through Dawn, with sharp edges: **D3D12
only** on Windows (press **F11** to switch the capture API from D3D11), and it captures *every* WebGPU
frame rather than on demand. Launch with
`--enable-dawn-features=use_user_defined_labels_in_backend,emit_hlsl_debug_symbols,disable_symbol_renaming`
or the shaders arrive unlabelled. Right tool for a fill-rate question; wrong tool for daily use.

### What none of them see
Chromium tracing captures **Chromium** threads. The Rust Art-Net pacer, the ENTTEC serial writers and
the JUCE audio callback emit no trace events and will never appear. They are also the threads that
have never been the problem — and they are already covered by `artlux_output_fps/pps/universes` on
`/metrics`. Two gauges there are worth a Grafana panel and cost nothing today:
**`artlux_nodejs_eventloop_lag_p99`** (already exported by `collectDefaultMetrics`) is the direct
signal for Spout/NDI/OSC/tablet contention on the main-process loop, and nobody is watching it.
For one timeline spanning native *and* Chromium threads you would need ETW (WPR/WPA) — free, but not
open source.

### ⚠ The traps — every one of these produced a confident lie before it was caught
- **`ARTLUX_CDP_PORT` forces a paint.** Harmless for profiling, fatal for anything else: a profiling
  run can *never* double as a window-visibility check (see Testing above).
- **A profiler that is off reports `0`, and `0` is indistinguishable from "free".** Assert the
  instrument is live before believing a number. `?uiperf=1` does **not** survive the app's startup
  navigation — use `localStorage['artlux.uiPerf']='1'` and reload.
- **`artlux_ui_blocked_ms` under-reports and lags** — it showed **101 ms for a 900 ms freeze**, in the
  sample 1.4 s later. Read it as *evidence of blocking*, never as proof of a quiet thread. Prefer
  `frameMax` / `longFrames` from `perfMonitor` as the primary signal.
- **A page-context `import()` of `uiPerfMonitor` gives a SECOND instance** that reports zero forever.
  Read `/metrics` or the Performance panel's own rows.
- **Measuring commit *counts* misses cost.** The Profiler reports its whole subtree and App rebuilds
  its wrapper every render, so a count can sit at 1 → 1 while the time goes 1.2 ms → 0.
- **A reload can restore a full-page route** (Preferences) that unmounts the whole shell, so nothing
  is profiled.
- **This dev machine routes to an ENTTEC USB widget**, so no Art-Net appears on the wire on *any*
  build — use `artlux_output_*` rather than a `dgram` listener when checking output here.

## Release process
A `v*` tag drives `.github/workflows/build.yml` (matrix: windows/macos/ubuntu) → per-OS installers +
`latest*.yml` auto-update metadata → a published GitHub Release (`softprops/action-gh-release`).
```bash
# bump "version" in package.json + update CHANGELOG.md (+ docs/PROGRESS.md), commit on main, then:
git push origin main
git tag -a v0.4.0 -m "ArtLux v0.4.0 — …" && git push origin v0.4.0
gh run watch <id> --exit-status        # wait for the build
gh release view v0.4.0                  # confirm draft:false + assets incl. latest.yml
```
If a release re-run is needed, clear the broken one first:
`gh release delete vX.Y.Z --yes --cleanup-tag`, then re-tag + push.

**Gotchas that have bitten the release:**
- **`package-lock.json` must be in sync with the workspaces.** CI installs with `npm ci`, which fails
  hard when the lockfile is out of sync with `package.json` — and electron-builder also needs it to
  detect the workspace root. Adding a `packages/*` or `plugins/*` package (or changing `"workspaces"`)
  **requires `npm install`** to regenerate the lockfile; commit it. This broke the v0.18.0 build on all
  three runners (the lockfile predated the plugin workspaces). See [PLUGINS.md](PLUGINS.md).
- **Artifact filenames must be space-free.** electron-builder's default names ("ArtLux Setup x.y.z.exe")
  make `softprops` 404 on the asset-rename step → publish fails. Fixed by `build.artifactName:
  "${productName}-${version}-${arch}.${ext}"` and dropping the Windows `portable` target (NSIS is the
  auto-update target). Don't reintroduce spaces.
- **No duplicate asset names across OS runners.** electron-builder emits a `builder-debug.yml` on every
  runner; uploading all three to one release collides on that name and `softprops` fails refreshing the
  duplicate (`update-a-release-asset` → Not Found), turning CI red — this bit v0.4.1. Fixed in v0.5.0 by
  excluding it from the upload glob (`!release/builder-debug.yml` in `build.yml`). The auto-update
  manifests (`latest.yml`/`latest-mac.yml`/`latest-linux.yml`) are uniquely named per platform, so they're
  fine. Keep release asset names unique per platform.
- **Auto-update** (`electron-updater`) only works once **two** releases both carry `latest.yml`. v0.3.1's
  release failed to publish, so **v0.4.0 is the first with working metadata** — updates apply for installs
  from v0.4.0 onward (Windows/Linux; macOS links to the Releases page, no Developer ID). See
  `src/main/updater.ts`.

- **A changed app icon does not appear on upgraded machines, and that is expected.** Windows caches
  shell icons per executable path and does not re-read the `.exe` when it changes; ArtLux installs to
  the same path every time, so upgrades keep showing the previous icon while *clean* installs show the
  new one immediately. Don't chase it as a packaging bug — verify the build instead by opening the app
  and checking the title bar / **Help ▸ About ARTLux**, which draw the mark from the renderer rather
  than the shell cache. Recovery steps for a venue PC:
  [INSTALL.md → The app icon lags behind an upgrade](INSTALL.md#the-app-icon-lags-behind-an-upgrade-windows-icon-cache).

Before tagging, smoke-test locally with `npm run package:dir` so CI won't fail on a packaging error.

**Verifying an icon change before you ship it.** `npm run gen:brand` regenerates the marks, but the
raster the OS actually shows is only proven by looking inside the built binary — extract it from the
packaged `.exe` rather than trusting `build/icon.ico` or an Explorer thumbnail (both can be stale):

```powershell
npm run package:dir
Add-Type -AssemblyName System.Drawing
$exe = (Get-ChildItem 'release/win-unpacked/*.exe' | Select-Object -First 1).FullName
[System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap().Save("$PWD\icon-check.png")
```

Check it at **16px** too, not just at full size — the `.ico` carries 7 sizes and a mark that reads
well at 256px can be an illegible smudge in the taskbar. See
[DESIGN-SYSTEM.md § 7](DESIGN-SYSTEM.md#7-brand-marks--one-source-never-hand-drawn) for the pipeline.

### macOS signing
No Apple Developer account → the app is **ad-hoc signed** in `scripts/mac-adhoc-sign.cjs`
(electron-builder `afterPack`) so it runs on Apple Silicon, but it is **not notarized**. Downloaded
dmgs need a one-time Gatekeeper bypass: right-click → Open → "Open Anyway", or
`xattr -dr com.apple.quarantine "/Applications/ArtLux.app"`. Builds are arm64-only. A no-warning dmg
(and Intel/universal) would require a paid Developer ID + notarization + hardened runtime/entitlements
(outlined in SURFACES/PROGRESS notes).

## Environment gotchas (this dev machine)
- The sandbox sets `ELECTRON_RUN_AS_NODE=1` → launch dev with `env -u ELECTRON_RUN_AS_NODE npm run dev`.
  The **packaged** app is protected from this: the electron-builder `electronFuses: { runAsNode: false }`
  (package.json `build`) makes the shipped binary ignore `ELECTRON_RUN_AS_NODE` and always start as the
  app — don't remove it (a packaged binary that inherits the var would otherwise run as bare Node with
  no window). Added v0.19.1.
- `cargo` is not on PATH by default → prepend `~/.cargo/bin` before `npm run build:native`.
- A separate **Artnetominator** app may hold UDP **6454** and intercept loopback Art-Net during output
  tests — stop it first (`Get-NetUDPEndpoint -LocalPort 6454`).
- Commit messages via PowerShell here-strings break on embedded `"` — keep commit bodies quote-free.
- **Rebuilding a native addon while the app runs fails `EBUSY`** (Electron holds `*.node`). Stop dev +
  kill stray `electron` first, then `npm run build:native` (or build the one crate +
  `node scripts/copy-native.cjs`). For the **audio engine** the same lock surfaces as MSVC `LNK1104`,
  and the failed link **leaves the previous `audio_engine.node` in place** — so the app keeps loading
  the STALE engine and your change appears to do nothing. Confirm with
  `tasklist /FI "IMAGENAME eq electron.exe"` before `npm run build:audio`. If audio is dead or acting
  stale, work the checklist in [No sound?](#the-audio-ui-is-all-there-and-nothing-plays--no-sound).
- **Camera / mic surfaces** need the main process to grant the `'media'` permission
  (`session.setPermissionRequestHandler` + `setPermissionCheckHandler` in `src/main/index.ts`); without
  it `getUserMedia` is denied and the live source stays blank. The renderer logs the exact failure as
  `[surfaceMedia] camera failed: <DOMException name> — <message>` (e.g. `NotReadableError` = the device
  is held by another app — close the OS camera app). On macOS the OS also gates it via
  `systemPreferences.askForMediaAccess`; on Windows, enable Settings → Privacy → Camera for desktop apps.

## CI notes
`.github/workflows/build.yml` installs Rust, runs `build:native` (the Rust crates; Windows builds the
real Spout addon, others stub), then `build:audio` (the JUCE engine — **strict**, so a release can
never ship the audio UI without sound), `build`, then `electron-builder`. The cargo cache covers the
crate `target/` dirs; the audio engine is not cached (it FetchContent-clones JUCE + libspatialaudio,
costing a few minutes per runner on a tagged release — correctness over speed).

Runner toolchains: **windows-latest** (CMake + MSVC v143) and **macos-latest** (CMake + Apple Clang)
already have everything. **ubuntu-latest** has CMake + GCC but needs the JUCE dev packages, installed
by the `Install JUCE Linux dependencies` step (ALSA for `juce_audio_devices` + X11/freetype headers).
`npm ci` at the root does **not** install `native/audio-engine`'s deps (it is not an npm workspace) —
`scripts/build-audio.cjs` installs them itself. Pinned actions currently emit Node-20 deprecation
warnings (non-blocking; bump majors when convenient).
