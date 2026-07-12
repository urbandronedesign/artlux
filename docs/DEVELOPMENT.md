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
npm run build:native   # 3 Rust crates → native/*/*.node (gitignored), then the audio engine (optional, warns)
npm run build:audio    # just the JUCE audio engine — REQUIRED for sound
npm run dev            # launch the Electron app (electron-vite dev)
```

### Audio engine (`native/audio-engine`) — mandatory to ship, optional to develop
JUCE + libspatialaudio, built with **cmake-js**, not cargo. `plugins/audio` **graceful-degrades**: if
`audio_engine.node` is absent the app still starts and the whole audio UI still renders — with **no
sound and no error**, only `[audio] native engine unavailable` in the console. That makes a missing
engine dangerously easy to miss, so the build system treats it this way:

| Path | Behaviour if the engine won't build |
|------|--------------------------------------|
| `npm run build:native` | **Warns loudly, continues.** A cargo-only contributor is not blocked, but is told audio is dead. |
| `npm run build:audio` | **Hard fails.** |
| `npm run package` / `package:dir` | **Hard fails** (`--check` guard) — an installer can never be cut without an engine. |
| CI (`.github/workflows/build.yml`) | **Hard fails** — a tagged release cannot ship a silent audio UI. |

Unlike `ndi.node`/`calib.node`, the addon is **not** a committed prebuilt: it is platform-specific,
so every machine and every CI runner builds its own. It is gitignored (`*.node`).

> **Close the app before rebuilding.** A running Electron holds `audio_engine.node`; the link fails
> (`LNK1104` on Windows) and **silently leaves the stale addon in place**, so you debug code that
> isn't loaded. Stop `npm run dev` and kill stray `electron` processes first.

### Scripts
| Script | What |
|--------|------|
| `npm run dev` | dev server + Electron |
| `npm run build` | build main + preload + renderer bundles |
| `npm run build:native` | cargo build the 3 Rust crates + copy to `*.node`, then the audio engine (warns, non-fatal) |
| `npm run build:audio` | cmake-js build the JUCE audio engine → `native/audio-engine/audio_engine.node` (strict) |
| `npm run gen:icon` | regenerate `build/icon.{png,ico}` + favicon from `build/icon.svg` |
| `npm run package` | full installers (electron-builder) |
| `npm run package:dir` | unpacked app (fast local smoke test) |

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
  `tasklist /FI "IMAGENAME eq electron.exe"` before `npm run build:audio`.
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
