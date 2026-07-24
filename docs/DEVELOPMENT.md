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
- **Kill test instances after each run.** There is no single-instance lock, so leftover launches
  (especially `--broadcast`, which shows a tray icon + fullscreen projector windows) accumulate and
  look exactly like a bug on next launch. `Get-Process ArtLux,electron | Stop-Process -Force` between
  tests; several instances also contend over the shared `userData` GPU cache (`Access is denied`).

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

Before tagging, smoke-test locally with `npm run package:dir` so CI won't fail on a packaging error.

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
