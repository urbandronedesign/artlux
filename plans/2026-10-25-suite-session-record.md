# 2026-10-25 — session record: the ArtLux suite (Show + Calibrator), built and tested

> **Status:** Record (closed session, 2026-10-25, ~11:00 → 23:30). Written for two readers: the owner, and the
> next Claude session on this machine. **Installed here: v0.34.1** (unchanged — nothing from this session is
> installed). It follows the [2026-10-24 → 25 record](2026-10-25-session-record.md). The plan it executed is
> [artlux-suite-show-calibrator.md](artlux-suite-show-calibrator.md) (each phase has its own "Built" record
> there). Measurements are from the RTX test box (RTX 5090, Windows 11, Electron 42.4.1).

## Where things stand

| | |
|---|---|
| **`feat/artlux-suite`** | Phases 1–5 of the suite plan **built and committed**, plus the fixes found by using it. Pushed: `origin/feat/artlux-suite` at **`6bd6e9d`**. **Not merged, no PR.** |
| **`main`** | `d05ea0b` — only the new README (media server for interactive installations) + `LICENSING.md`. The suite is **not** on main. |
| **Working tree** | On `main`. Uncommitted, the owner's own: `plans/README.md` (edited), `plans/2026-10-24-evening-session-record.md` (untracked). Never commit those without asking. |
| **Installed** | v0.34.1 (`C:\Program Files\ArtLux`). The unpacked test builds in `release/show` and `release/calibrator` are **branch** builds. |

## How it went

1. **Phases 1–2** (lazy OpenCV + the calibration plugin split into `/playback` and on-demand `/authoring`).
   Owner's rule from here: *"stay on this branch, never touch main"*.
2. **Phase 3** — two build targets (`ARTLUX_APP=show|calibrator`), one shared profile and lock, a hand-off
   between the apps; the procedural **UV checker**; a **new Calibrator UI** around one big 3D venue. The owner
   asked for a UI proposal, then for it in the existing design system, and chose that version. Solo / mute,
   a signed sign-off and an audience seat were added at the owner's request. CI builds both products on a
   `v*` tag. A level-3 install test (real installers) passed and was reverted.
3. **Phase 4** — a scheduled recalibration in Show hands the machine to the Calibrator and back.
4. **Phase 5** — the Launcher installs, updates and opens both apps (Rust installed on this machine for it).
5. **Testing it with the owner's Blender rig** turned into a run of real requests:
   - *"I want the UV grid showing when the Calibrator opens"* → it opens every project on the checker, and
     Show always restores the show content (a real bug: only one hand-off route used to restore).
   - *"I rotated the projectors — update the calibration"* → recalibrated through the UI (Manual ▸ Start
     from it, 6 points each).
   - *"It works but the framerate is very bad"* → 6K HEVC video on live calibration: 3–7 fps; from a
     calibration file: 60 fps. Owner: **"we will always calibrate with the UV grid"**.
   - *"Offer to update the file before handing back"* → built.
   - *"Add a third projector, closer, maximise pixel coverage, calibrate, open the show with files"* →
     layout computed, Blender edited, three outputs calibrated, 3-region file exported, Show at 60 fps.
   - *"I can't see the placement in Blender"* → throw lines drawn as Grease Pencil (not exported).
   - *"No focal on the projector — assume short throw"* → throw 0.70 chosen by coverage, recalibrated.
   - *"How do I import a calibration per projector?"* → the per-projector region choice, built.
6. **An incident (see below):** quitting a Show the owner had been using for 4 h lost ~11 minutes of work and
   exposed the close-backstop bug, now fixed on the branch.
7. Pushed the branch; saved the UI proposal's pictures; switched to main; rewrote the README.

## What shipped

**On `feat/artlux-suite`** (oldest first):

| Commit | What |
|---|---|
| `a73495d` `174fff1` `19ba10c` | Plan §8a (local testing) · Phase 1 lazy OpenCV + authoring · Phase 2 the two barrels |
| `93c2c51` | Plan: the Calibrator UI — design-system proposal; solo/mute, signed sign-off, audience seat in |
| `758304f` `f828038` | Phase 3: two build targets, one lock, hand-off · the UV checker |
| `eb66538` `569598c` | The Calibrator UI: Rig / Blend / Test & sign-off / Recalibration contexts; Calibrate step, machine check, audience seat, user guide ch. 19 |
| `7e9daf6` `2eaf8a1` | CI builds both products · the Calibrator's own updater cache, uninstaller-path lookup |
| `319fd38` | Phase 4: scheduled recalibration as a hand-off (15 min timeout, watchdog stands down) |
| `3e1fe71` | Phase 5: the Launcher handles both apps (`calibrator.yml`, product classification, `openTarget`) |
| `7770cd3` | **The Calibrator opens on the UV checker; Show always restores the show content** (+ invariant) |
| `cd5c08c` | Picking hint on one line; the empty Calibrate step points to the Rig |
| `ae71d98` | **Hand-off offers to replace an out-of-date calibration file** (+ invariant) |
| `b180acf` | Projectors named by their surface; "blend without X" status; **focusing a projector frames it in 3D** |
| `db5c122` | **Close backstop no longer closes the window under "Save before closing?"** (+ invariant) — shared code |
| `22719e4` | **Per-projector calibration region** (Auto / None / any region of any loaded file) |
| `6bd6e9d` | Pictures of the Calibrator UI proposal (`plans/calibrator-ui-proposal/`) |

**On `main`:** `d05ea0b` — README rewritten (media server for interactive installations, principal features,
links out); licensing record moved to `LICENSING.md`; two macOS notes moved into `docs/INSTALL.md`; the
licence-before-tagging warning moved into `docs/DEVELOPMENT.md`.

`npm run verify` passes on every commit (invariants **247** checks in suite / calibrator / show builds).

## Decisions the owner made (do not re-open without asking)

- **The suite:** two apps, two installers, the Launcher exposes both, always the same version. (Earlier
  decisions: the plan's §2a.)
- **The Calibrator UI is the token-only design-system version** (canvas `4dK14u94Gk55XtKop56Qyw`).
- **"We will always calibrate with the UV grid."** The Calibrator opens on it; heavy-media shows play from a
  calibration file. Live calibration must still work in Show.
- **Short-throw assumption: throw ratio 0.70** for the test rig (no real lens known) — redo with the real
  ratio when the projector model is known.
- **The UI proposal in the repo is pictures only** — the canvas runtime (`support.js`, React) stays out of the
  public repo; sources stay on the canvas (and locally, excluded via `.git/info/exclude`).
- **The README positions ArtLux as a media server for interactive installations.**

## What to know about the code now (branch)

- **Which app** is a build define, `__ARTLUX_APP__` (`suite` | `show` | `calibrator`), set by `ARTLUX_APP` in
  `electron.vite.config.ts`. `scripts/package-app.cjs <show|calibrator> [--dir]` packages one.
- **One profile, one lock:** the Calibrator pins userData to `%APPDATA%\ArtLux` (`src/main/appPaths.ts`), so
  Electron's single-instance lock covers both apps. Hand-off = `app.relaunch({execPath})` + `--handoff-from`.
- **The test source on open** — `src/renderer/services/testSource.ts`, applied inside `applyProjectData`:
  Calibrator → `withTestSource` (checker on, show content in `calibRig.testBackup`); every other build →
  `withShowContent`. Pure transforms, so an opened project is not dirty.
- **Hand-off checks** — `services/handOffChecks.ts`; both doors (File ▸ Open in ArtLux Show, the sign-off
  button) run them. The Calibrator registers `plugins/calibration/src/fileFreshness.ts` (file older than the
  newest `calibratedAt` / `blend.solvedAt` → Export and replace / hand over anyway / cancel). The replace
  writes only `Prefs.calibrationFile` (path taken in main).
- **Calibration files per projector** — `bakedStore.sourceFor(surfaceId)` is the one door every window's map
  goes through: `Prefs.calibrationAssign[surfaceId]` (`{file, region}` | `{none:true}` | absent = Auto by id),
  `Prefs.calibrationExtraFiles`. Unload clears all three prefs.
- **Focus frames the view** — `plugins/calibration/src/focusView.ts` from `rigUi.setFocus`.
- **Close guard** — `src/main/closeGuard.ts`: the renderer sends `close-asking` before the dialog; the 4 s
  backstop stands down for an asking window; `render-process-gone` still lets a close through.

## Measured

| What | Result |
|---|---|
| Hand-off Show → Calibrator → Show (Phase 4, unpacked) | 1.6 s there, 5.6 s back |
| 6K HEVC 360 video (5760×2880, ~76 Mbit/s), 2 projectors, **live calibration** | **3–7 fps** in every window; GPU process ~92 % of a core, 3D engine 19 % |
| Same, **from a calibration file** | **60 fps** |
| Calibrator on the UV checker, same rig | 23–60 fps |
| 3 projectors, throw 2.1, 5.55 m back (computed layout) | 85 % of each raster on the screen, 100 % coverage |
| 3 projectors at the owner's placement, **throw 0.70** | 68 / 81 / 61 % on the screen (L / C / R); blend worst 1.3 % |

## The incident — read this before closing anything

To rebuild Show, Claude quit an ArtLux Show it had launched hours earlier. The owner had been working in it for
~4 h; the title said "Unsaved changes"; the quit discarded 22:41 → 22:52. The log showed why it did not ask:
**"renderer did not answer in time — closing anyway"** — the 4 s backstop closed the window under its own
"Save before closing?" dialog. Fixed in `db5c122` **on the branch only. `main` and the installed v0.34.1 still
have it** — cherry-pick `db5c122` to main if the merge waits.

**Rule (also in memory):** before quitting, closing, killing or rebuilding over any running ArtLux or Blender,
read its session uptime (machine log `session.start`) and its dirty state, and ask if the owner may have used
it. Test on a copy of the owner's project (`blendtest\test-copy.artlux`), never on the file they work in.

## Needs the owner

- **Merge timing** for `feat/artlux-suite` (the owner's earlier rule: not in show-prep weeks), or a PR.
- **`db5c122` to main** (data-loss fix) — independently of the merge.
- **First suite release** (`v*` tag → both installers + `calibrator.yml`) and a **Launcher release**
  (`launcher-v*`, five version files — LAUNCHER.md ▸ Releasing).
- Not yet exercised: the Launcher against a published suite release; a real recalibration hand-off on a
  commissioned venue with a camera; the real short-throw ratio of the projectors.
- The owner's own pending files (`plans/README.md`, the 10-24 evening record) — and, from earlier sessions,
  the test tablets + temp recents in the owner's real profile.

## Already tried — do not redo

- **Synthetic Ctrl+S over CDP does not reach the shortcut handler.** Use File ▸ Save through the menu.
- **`Process.CloseMainWindow()` on ArtLux closes a projector window**, not the editor (Windows reports a
  projector as the main window). Quit through the app menu over CDP instead.
- **A Rig card toggles focus** — clicking a focused card un-focuses it (and the Recalibrate button goes).
- **Focusing an uncalibrated projector used to frame nothing** — fixed in `b180acf`; framing now also resets
  any zoom, so zoom after starting a session, not before.
- **The 3D gizmo of the focused projector sits over the screen** — keep pick clicks away from it.
- **A pick outside the projector's raster lands at the crosshair** with a huge error (e.g. 489 px): delete it.
  A pick that misses the mesh adds nothing — click a few px inside the edge.
- **Native dialogs** (export/import MPCDI) need the app launched with `--inspect=9230` and `stubboth.mjs`;
  an app started by a hand-off does not carry `--inspect`.
- **Shell escaping** mangled paths and code three times: backslashes in double quotes, backticks in
  heredocs, `node -e` with template literals. Use the Edit/Write tools, or single-quoted paths.
- **Blender:** never write meshes to visualise anything — ArtLux exports *every* object of the `.blend`;
  Grease Pencil is not exported. A path guess or helper object named `projector…` is ignored by ArtLux only
  if it is not a camera (`findProjectors` requires a perspective camera).
- **Harmless noise in unpacked-build logs:** `app-update.yml` ENOENT (and its toast), `plugin:audio`
  "No handler registered".

## Where things are

| Thing | Where |
|---|---|
| The test rig (scratch, not the owner's shows) | `%TEMP%\claude\battle\blendtest\` — `multi-projector.artlux` (the owner's working copy, last saved 22:41), `test-copy.artlux` (Claude's test copy), `assets\models\panorama-venue.blend` (3 projectors, throw 0.70, `throw_lines` Grease Pencil) |
| Calibration files | `rig-3p-2026-10-25.mpcdi` (current, loaded) · `rig-2026-10-25.mpcdi` (old two-projector aim) · `rig-rotated.mpcdi` (10-24) |
| Scratch profile | `%TEMP%\claude\battle\profile` — `calibrationFile` = rig-3p; no per-projector choices |
| Test tools from this session | `%TEMP%\claude\battle\tools\suite-1025\` — `cdp.mjs` (shot/eval/click/text on index/left/right), `cdpc.mjs` (Projector Center shot), `startcal3.sh` + `lastpick.sh` (drive a Manual calibration), `wheel.mjs` / `rdrag2.mjs` (zoom / pan the 3D), `stubboth.mjs` (answer native dialogs), `prof.mjs` (JS CPU profile), `design3m.cjs` / `throwcheck.cjs` (projector layout + throw coverage), Blender scripts (`read_venue.py`, `three_projectors.py`, `short_throw.py`, `draw_throws.py`, `cam_look.py`), `pkg-*.cmd` (package inside vcvars64) |
| The UI proposal | canvas `https://claude.ai/artifact/4dK14u94Gk55XtKop56Qyw`; pictures in `plans/calibrator-ui-proposal/` (branch) |

## Testing on this machine: recipes added

- **Build:** `pkg-dir.cmd` (both unpacked) / `pkg-caldir.cmd` (Calibrator only) — they run vcvars64 and
  Visual Studio's CMake, which the audio engine needs. Close the app first if it runs from `release/<app>`.
- **Launch for CDP:** `$env:ARTLUX_CDP_PORT='9333'` then the exe with `--user-data-dir=<scratch profile>`
  `--project=<copy>` (add `--inspect=9230` for dialog stubs). The port carries across a hand-off.
- **Frame rate in every window at once:** a 3–4 s `requestAnimationFrame` count per page over CDP, run in
  parallel (see the record's `Measured` numbers).
- **Projector windows hidden behind other apps:** capture them with `PrintWindow` (PW_RENDERFULLCONTENT = 2),
  or a CDP `Page.captureScreenshot`.
- **Manual calibration without a wall:** Start from the Blender projector, click vertices; each pick sits at
  the seed's reprojection, so the solve reproduces the Blender pose (fit ≈ 0.000 px). Compute which columns
  each projector covers first (`throwcheck.cjs` / the column table in `design3m.cjs`).
