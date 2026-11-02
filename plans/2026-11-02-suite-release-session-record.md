# 2026-11-02 — session record: the suite merged and released (v0.34.2 → v0.35.0, Launcher 0.1.4)

> **Status:** Record (closed session, 2026-10-26 and 2026-11-02). Written for two readers: the owner, and the
> next Claude session on this machine. **Installed here: ArtLux Show 0.35.0, ArtLux Calibrator 0.35.0,
> ArtLux Launcher 0.1.4.** It follows the [2026-10-25 suite record](2026-10-25-suite-session-record.md) and
> closes the plan it executed, [artlux-suite-show-calibrator.md](artlux-suite-show-calibrator.md).
> Measurements are from the RTX test box (RTX 5090, Windows 11, Electron 42.4.1).

## Where things stand

| | |
|---|---|
| **`main`** | **`c237e89` — v0.35.0.** `feat/artlux-suite` was fast-forwarded into it; the suite is merged. |
| **Releases** | **v0.35.0** is `/releases/latest`: ArtLux Show + ArtLux Calibrator on Windows, macOS, Linux, with `latest*.yml` and `calibrator*.yml`. **launcher-v0.1.4** published (pre-release by design); `launcher-latest` points at it. v0.34.2 (26 Oct) still public; rc.2 retired to a draft. |
| **This machine** | Show 0.35.0 updated **in place** from v0.34.2 (via rc.2): one Apps entry and one Start-menu entry, both "ArtLux Show"; the profile byte-identical. The owner's profile now remembers `rig-3p-2026-10-25.mpcdi` (see Open items). |

## How it went

**26 October — a crash in the owner's Calibrator, two bugs, v0.34.2.**

1. The owner opened `multi-projector.artlux` in the branch Calibrator and got *"A JavaScript error occurred in
   the main process — Render frame was disposed before WebFrameMain could be accessed"*. **The cause was not
   the open.** The machine log showed a **GPU driver reset at 09:10:47**: every output lost its WebGL context
   and reloaded, the **editor's renderer died and stayed dead** (outputs logged *producer-lost* at 09:10:54;
   28 minutes later the close guard logged *renderer did not answer*), and an output's `did-finish-load` ran
   `bridge()` against the dead editor frame. `isDestroyed()` is not enough: the window exists, its frame does not.
2. Fixed in two layers: `bridge()` catches and drops the port pair (`6ef3d93`), and **a dead editor renderer is
   logged and loaded again** — `src/main/editorRecovery.ts` (`28d2e7a`): reload on the last project, Safe Mode
   at the 3rd death in 5 min, a stop dialog at the 4th. That dialog first quit the app by itself: without
   `cancelId`, Electron maps any dismissal to button 0 (Quit).
3. The Calibrator's log was ⅓ *"No handler registered for 'plugin:audio:getSpectrum'"* (~100/s): the shader
   audio tap polls a plugin the Calibrator does not ship. It now goes silent after the first refusal (`037c5f8`).
4. **v0.34.1 reproduced the crash dialog in round 1** of the same test. The two fixes were cherry-picked to
   main and released as **v0.34.2**, installed here and re-tested.

**2 November — the merge plan, executed.** The owner asked to plan the merge and first check that the Launcher
installs both apps. Findings that shaped the plan: the Launcher's suite code was ready but its version was
still 0.1.3 (installed Launchers would never update); the release pipeline had no pre-release, so an RC tag
would have become `/releases/latest` and auto-updated every venue; three text-only merge conflicts.

1. **Step 1** — main merged INTO the branch (`03c5262`), so main stayed untouched until the end.
2. **Step 2** — hyphenated tags publish as pre-releases, `make_latest` false; retention ignores them and the
   real release retires them (`9f3fa0f`). Launcher 0.1.4 (`b72f1e8`). User docs for the split: CHANGELOG,
   README, INSTALL.md downloads + "which do you need", user guide ch. 17 (`fc8d8a8`).
3. **Step 3 — the RC.** `v0.35.0-rc.1` died on Windows only: **`ndi.link/NDIRedistV6` answered HTTP 500**. The
   owner pointed at ndi.video; the direct `downloads.ndi.tv/SDK/NDI_SDK/NDI%206%20Runtime.exe` is
   **byte-identical** to the runtime shipped so far (SHA-256, 6.3.2.0, signed Vizrt AG) and is now the fallback
   (`4be34ea`). **rc.2** built on all three platforms — the Calibrator's first CI build on macOS and Linux.
4. **Step 4** — main fast-forwarded to the branch, **v0.35.0** tagged, then **launcher-v0.1.4**. This machine
   updated to both, and the owner's calibration file was remembered for them.

## What was tested, on installed builds

| Test | Result |
|---|---|
| v0.34.2 → Show rc.2, in place | One Apps entry and one shortcut, both renamed; profile byte-identical |
| Calibrator beside Show | Own folder, own shortcut, not counted as a double install |
| Launcher 0.1.4 vs rc.2 and vs v0.35.0 | Both installs found by product; both products resolved, each `.yml` naming its own installer; machine check on Show: 0 fail |
| Hand-off round trip (Show → Calibrator → Show) | One app at a time; Show back with 3 outputs; after Show saves, every surface has its original content and no `testBackup` |
| Calibration file at start — editor, and broadcast | `restored 3 region(s)`; each of 3 projectors **received** its map (880×465), on a first start and a plain restart; a per-projector **None** honoured |
| Dead editor (`Page.crash` + outputs reloading) | Editor back on its own with its notice, outputs reconnected; ladder Safe Mode / stop dialog |
| Close dialog (`db5c122`) | Add Surface, title-bar X: "Save before closing?" still up at 11.5 s, app running |

## Decisions and facts worth keeping

- **A calibration file is remembered per MACHINE** (`Prefs.calibrationFile`, `calibrationExtraFiles`,
  `calibrationAssign`), not per project, and is restored at every start before the outputs show anything.
- **The Calibrator saves the UV checker into the file, with a `testBackup` of the show content; Show restores
  it on every open.** A file just saved by the Calibrator carrying `testBackup` is correct, not a bug.
- `--user-data-dir` wins over the suite's shared profile (`appPaths.ts`), and the hand-off carries it — so a
  scratch-profile test never touches the owner's settings.
- Installed Launchers and installed ArtLux both skip pre-releases; `ARTLUX_LAUNCHER_PRERELEASE=1` lets a test
  Launcher see one (`aceb4b5`, documented in LAUNCHER.md).

## Traps met (do not re-learn)

- **`CloseMainWindow()` / WM_CLOSE reach a projector window, not the editor.** Closing one by hand turns that
  output OFF in the project (it happened: the owner's save recorded Center disabled; fixed in the file, backup
  `multi-projector.before-reenable.artlux`). Close the editor through CDP: `window.artlux.windowCommand('close')`.
- **A CDP-injected script belongs to its session**: keep the WebSocket open until after `Page.reload`, or the
  script is dropped before the new document runs it (flaky nulls).
- **The machine log stores renderer messages without their `[prefix]`** (it is in `cat`): grep `restored 3
  region(s)`, not `[calibration] restored`.
- `ELECTRON_RUN_AS_NODE=''` (empty) still makes a plain `electron.exe` run as Node; delete the variable.
- `Browser.crashGpuProcess` ~6 times in a row → Chromium aborts the app (*GPU process isn't usable. Goodbye.*).
- The Launcher self-test used `installs.first()` — on a suite machine, the Calibrator; its preflight then
  failed the audio engine and cached that. Fixed to act on Show (`4f11a6b`); the window was always right.
- UAC prompts can open behind other windows and time out as "cancelled by the user"; ask the owner to watch.

## Test tools (scratch, `%TEMP%\claude\battle\tools\suite-1025\`)

`bridge-stress.mjs` (MODE=dead|reload|gpu|open) · `handoff-roundtrip.mjs` · `calib-restore.mjs`
(EXTRA_ARGS=--broadcast, NONE_FOR=<surfaceId>) · `close-guard.mjs` · `owner-restore-check.mjs` ·
`spectrum-count.mjs` · `pkg-caldir.cmd` · `pkg-main-dir.cmd` · `pkg-launcher.cmd`. Every app test runs on a
scratch `--user-data-dir` and a copy of the project.

## Open items

- **The remembered calibration file and the project live in `%TEMP%\claude\battle\blendtest\`**, which Windows
  or a clean-up tool may empty. If this rig matters, move the folder somewhere permanent and load the file
  again from there (Projection Outputs ▸ Calibration File).
- Releases are not code-signed (unchanged, by decision); SmartScreen warns on both installers.
- The Calibrator's live calibration with heavy video still runs at 3–7 fps; the owner's rule stands —
  calibrate on the UV grid, play heavy shows from a calibration file.
- Not exercised: a real venue recalibration hand-off on a schedule, and the real short-throw ratio of the rig.
