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

The app runs **two windows**: the main mapping window (`index.html`/`App.tsx`) and the **3D Scene**
window (`scene.html`/`scene/SceneApp.tsx`, opened from the top-bar Scene button). They talk over a
`MessageChannelMain` bridge (`scene/bridge.ts`); the timeline + LED data flow main → scene. Both windows
disable background throttling so nothing stalls when the other has focus.

## Prerequisites
- **Node.js** (≥ 20) and npm.
- **Rust** toolchain (`rustup`, stable) for the native addons — MSVC on Windows.
  - The Spout addon (`native/spout-receiver`) builds the vendored Spout2 C++ SDK on Windows (needs
    the MSVC C++ build tools); it compiles to no-op stubs on macOS/Linux.

## Install & run
```bash
npm install
npm run build:native   # builds both Rust crates → native/*/*.node (gitignored)
npm run dev            # launch the Electron app (electron-vite dev)
```

### Scripts
| Script | What |
|--------|------|
| `npm run dev` | dev server + Electron |
| `npm run build` | build main + preload + renderer bundles |
| `npm run build:native` | cargo build both crates + copy to `*.node` |
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
- **Artifact filenames must be space-free.** electron-builder's default names ("ArtLux Setup x.y.z.exe")
  make `softprops` 404 on the asset-rename step → publish fails. Fixed by `build.artifactName:
  "${productName}-${version}-${arch}.${ext}"` and dropping the Windows `portable` target (NSIS is the
  auto-update target). Don't reintroduce spaces.
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
- `cargo` is not on PATH by default → prepend `~/.cargo/bin` before `npm run build:native`.
- A separate **Artnetominator** app may hold UDP **6454** and intercept loopback Art-Net during output
  tests — stop it first (`Get-NetUDPEndpoint -LocalPort 6454`).
- Commit messages via PowerShell here-strings break on embedded `"` — keep commit bodies quote-free.
- **Rebuilding a native addon while the app runs fails `EBUSY`** (Electron holds `*.node`). Stop dev +
  kill stray `electron` first, then `npm run build:native` (or build the one crate +
  `node scripts/copy-native.cjs`).
- **Camera / mic surfaces** need the main process to grant the `'media'` permission
  (`session.setPermissionRequestHandler` + `setPermissionCheckHandler` in `src/main/index.ts`); without
  it `getUserMedia` is denied and the live source stays blank. The renderer logs the exact failure as
  `[surfaceMedia] camera failed: <DOMException name> — <message>` (e.g. `NotReadableError` = the device
  is held by another app — close the OS camera app). On macOS the OS also gates it via
  `systemPreferences.askForMediaAccess`; on Windows, enable Settings → Privacy → Camera for desktop apps.

## CI notes
`.github/workflows/build.yml` installs Rust, runs `build:native` (both crates; Windows builds the real
Spout addon, others stub), `build`, then `electron-builder`. The cargo cache covers both crate
`target/` dirs. Pinned actions currently emit Node-20 deprecation warnings (non-blocking; bump majors
when convenient).
