# ArtLux as a suite — ArtLux Show and ArtLux Calibrator

> **Status:** In progress (2026-10-25) · **Phase 1 built** on `feat/artlux-suite`, not merged · owner's decisions recorded in §2a. Do not build during
> show-preparation weeks: every phase touches plugin activation in the projector windows, which is where
> the 2026-10-24 black-projector bug lived.

## 1. Where things are now (measured 2026-10-25, installed v0.34.1, RTX test box)

ArtLux already has two launch profiles, decided in `3fae795` (2026-08-04) and parsed once in
`src/main/runProfile.ts` (`CALIBRATION_ENABLED`):

| | Plain launch | `--calibrate` (and every `--broadcast` / `--headless`) |
|---|---|---|
| Calibration **playback** — a calibration file, and live render-from-projector of a calibrated output | yes (moved above the gate in `ad42b18`, because a plain launch of a calibrated project was black) | yes |
| Calibration **authoring** — the Calib rail entry, the wizards, the camera, structured light, the recalibration commands | no | yes |
| **OpenCV** (`calib.node` + the 65 MB `opencv_world4110.dll`) | **loaded anyway** — `calibManager.ts:86` loads it at import, and the main plugin always activates | loaded |
| The calibration plugin's renderer code | **bundled and evaluated anyway** (one `plugins-*.js` chunk); only its registration is skipped | evaluated |

**Measured cost of the profile today** (3 launches each, same project, `tools/profcost.mjs`): no difference
in editor fps, projector fps, memory (±15 MB of ~1.2 GB) or startup (230–290 ms) on a calibrated rig, a
show with no projectors, or plain outputs. The one visible difference: renderer CPU on the calibrated rig,
~20 % of a core plain against ~37 % with the workbench.

What limits a show's frame rate is not the profile but **how each output runs**: plain or a calibration
file → 60 fps; live calibration with two projectors and moving content in broadcast → 30 fps (Chromium's
GPU process saturated; see [battle-test-v0.34.0.md](battle-test-v0.34.0.md)).

**The friction the split causes today:** switching is a save-and-restart (`File ▸ Open Calibration
Workbench…`); a second launch drops `--calibrate` (single instance, `second-instance` routes only
`--project=`); two modes are two ways to be wrong (the plain-launch black projectors); 61 invariant
references and 9 doc pages police it.

## 2. What "done" looks like

### 2a. The owner's decisions (2026-10-25)

1. **Keep the split.** ArtLux Show must carry none of calibration authoring's cost.
2. **No minimum machine.** The machine is chosen per show (number of outputs, size of the videos). So
   "lean" is not a target on one PC: it is *Show loads nothing it does not use*, measured as a delta.
3. **ArtLux Calibrator carries only what alignment needs** — not the full editor.
4. **Unattended recalibration is a Calibrator feature.** So Show can drop OpenCV and the camera stack
   entirely (see Phase 4 for how a scheduled recalibration still works on a show machine).
5. **Two installers, one per app** (revised the same day: first "one installer with both").
6. **The names explain themselves**: **ArtLux Show** and **ArtLux Calibrator**.
7. **The Launcher exposes the new state**: both apps, and which one a project opens in.
8. **Both apps always at the same version**: one version, one tag, one release.
9. **The Calibrator plays a test source**: a test video or an image, including UV and grid test cards, on
   the screens through the fresh calibration — that is how a calibration is signed off.
10. **A scheduled recalibration may relaunch the broadcast window** around it.
11. **ArtLux Show keeps the `C:\Program Files\ArtLux` path**; the Calibrator installs beside it.
12. **Two icons derived from today's icon** (`build/icon.svg`), so both read as ArtLux and differ at a glance.
13. **The Calibrator's test source includes a procedural UV checker, in Full HD and 4K, that adapts to
    the project's configuration** (§4, Phase 3).

### 2b. The two apps

| | **ArtLux Show** | **ArtLux Calibrator** |
|---|---|---|
| Job | Build a show and run it: content, timeline, state machine, LED, audio, outputs, the 3D venue and its Blender import; broadcast and headless | Align the projectors of a venue, and keep them aligned |
| Contains | today's editor without the Calib workbench | Projection Outputs, the 3D venue (with Blender import and live update), the calibration workbench (Board, Auto-Align, Manual), the rig blend + inspector, calibration-file export and import, alignment aids, **a test source** (a video or an image on a surface, UV / grid test cards — the Media library and a surface's content picker, not the timeline), **unattended recalibration** |
| Does not contain | wizards, camera capture, structured light, OpenCV, recalibration | the timeline, LED fixtures and patching, the state machine, scenes and cues, audio, show control's tablet UI, bake |
| Plays a calibration | **Both**: a calibration file, and a calibrated project's live calibration (owner's decision, 2026-10-24) | Live, while aligning |
| Opens | the same `.artlux` | the same `.artlux` — calibrations are written into it, files exported beside it |
| Installer | `ArtLux-Show-Setup-x64.exe` — **without** `calib.node`, the OpenCV DLL and the authoring code | `ArtLux-Calibrator-Setup-x64.exe` — without the show side (LED/fixture library, audio engine, the tablet app, bake) |
| Install | `C:\Program Files\ArtLux` (unchanged) | `C:\Program Files\ArtLux Calibrator` |

Measured definition of "lean": a Show **install** contains no calibration-authoring module and no OpenCV
(checked on the built `app.asar` and `resources/`), and a Show launch's startup memory is at least that
DLL lower than today's plain launch, on the same project.

Switching apps is **"open this project in the other app"**, never a restart of the one you are in.

## 3. Placement — core or plugin

- **Persisted types stay core** (`ProjectorCalibration`, `ProjectorOutput.blend`, `useCalibration`,
  the `calibrationFile` pref) — both apps read and write the same project; **no migration**.
- **The calibration plugin splits along the line that already exists in `plugin.renderer.ts`**:
  - *playback* — `CalibProjector` / `ProjectorScene` (render-from-projector), `bakedStore` +
    `ImportPanel` (calibration files), the blend apply. Ships in both apps.
  - *authoring* — the wizards, `calibManager` (OpenCV), the camera, structured light, the
    `blendController` solve, `BlendInspector`, recalibration (`calibRecal*`, the `recalibrate` /
    `calibRevert` command handlers). Calibrator only.
  - Two barrels (`@artlux/plugin-calibration/playback`, `/authoring`) under the existing **barrel-only
    import rule** — mixing paths duplicates singletons, which already caused a real bug here.
- **Which app a build is, is a BUILD fact**: a define (`ARTLUX_APP = 'show' | 'calibrator'`) set by the
  build target, so the bundler drops what the other app owns. `runProfile` reads it instead of
  `--calibrate`; every window of one install agrees by construction.
- **The Calibrator's reduced UI is a context set**, not a second app shell: the workspace already builds
  its rail from registered contexts (`contexts/index.tsx`), so Calibrator registers Projection Outputs,
  the 3D venue and Calib, and nothing else. One shell, two manifests.

## 4. Design — phases

### Phase 1 — Show stops loading what it does not use *(small, low risk, ships alone)*
- **Load OpenCV on first use**, not at import (`calibManager.ts:86`): the first `calib:*` call loads it;
  `calib:available` reports "not loaded yet" distinctly from "missing".
- **Evaluate the authoring code only under the profile**: a dynamic `import()` behind `isAuthoringLaunch()`
  so a plain launch does not parse it. Verify with a marker string per window bundle.
- Measure the delta on two machines of different weight (the RTX box and any lighter PC at hand): startup
  memory, renderer CPU, time to first frame, plain against `--calibrate`.

**Built 2026-10-25 on `feat/artlux-suite`.** How it landed, and what it measured:
- *OpenCV:* `calibManager.ts` loads `calib.node` on the first call that needs it (`native()`); the splash
  asks `addonState()` (both files on disk, nothing loaded); `cameraClose()` at quit never loads it.
- *Authoring code:* `authoring.ts` names the half; `authoringLoader.tsx` is the only door (lazy panels,
  `useCalibrationAuthoring`, `loadCalibrationAuthoring`). Moved out so playback can ask without loading
  it: `reportInterrupted` → `recalInterrupted.ts`, `isStale` / `rigOutputs` → `blendStale.ts`. The
  rig-blend strip loads the half only on Solve / Clear / Inspect. Built: `authoring-*.js` 273 KB; the
  shared `plugins-*.js` 6,010 → 5,744 KB.
- *Guards:* two invariants (the static import graph from the plugin's renderer entries never reaches an
  authoring module; the addon is not loaded at import, for the splash, or at quit), and a `chunk:` rule in
  `verify:plugins` (authoring markers live in `authoring-*.js`).
- *When the half loads* (CDP `Debugger.scriptParsed`, unpacked build, two-projector calibrated rig):
  plain launch, Projection Outputs open with the rig-blend strip on screen — **no window**; broadcast —
  **no window** until a `recalibrate` command arrives, then the editor only; `--calibrate` — the editor,
  on Inspect / Solve / the workbench; **projector windows never**. OpenCV maps into main when a wizard
  opens (its checklist asks), and not before — not even in broadcast for a recalibration that the policy
  refuses.
- *Cost, RTX box* (installed v0.34.1 against the branch, plain and `--calibrate`, three projects ×2):
  OpenCV mapped in main in **12/12 v0.34.1 launches, 0/12 branch launches**; main's working set **~6 MB
  lower** (150–159 against 155–165 MB — the DLL was mapped but mostly never paged in); startup, editor and
  projector fps, renderer and GPU-process CPU and memory **unchanged within run-to-run noise**. As
  predicted in §1: on this machine the split costs and saves almost nothing; what Phase 1 buys is that
  Show *loads* nothing of calibration authoring, which is the boundary Phase 3 builds on. The lighter
  second machine is still to be measured.

### Phase 2 — split the plugin into playback and authoring *(medium, no visible change)*
- Two barrels as in §3; host imports only barrels; `verify:plugins` gains both identities.
- Every invariant that asserts "gated by the profile" is re-pointed at the barrel boundary.

### Phase 3 — two build targets, two installers *(large)*
- **Two electron-builder configurations** from one tree, each with its own `productName`, `appId`, icon,
  `extraResources` and the `ARTLUX_APP` define:
  - **ArtLux Show keeps today's `appId` (`com.urbandronedesign.artlux`)**, so every machine that has
    "ArtLux" installed today updates into ArtLux Show with no reinstall (§6).
  - **ArtLux Calibrator** gets a new `appId` (`com.urbandronedesign.artlux.calibrator`).
  - Show's `extraResources` drop `native/calib/*`; the Calibrator's drop the fixture library, the audio
    engine, the tablet PWA and the bake tool's resources.
- **The Calibrator's context set** (§3): Projection Outputs, 3D venue, Calib, plus the Media library and
  the surface content picker for the test source (video, image, the UV / grid shader test cards).
  The built-in test card the templates use (`examples/manual-calibration/make-project.cjs` `TESTCARD`)
  becomes a one-click source in the Calibrator, beside the **UV checker** below. Its File menu has open /
  save / recent and "Open in ArtLux Show"; Show's has "Open in ArtLux Calibrator" in place of
  `Open Calibration Workbench…`. Either one saves, starts the other app on the project and closes itself.
  **The other app is found through its install registry key**; when it is not installed, the menu item
  says so and links to the download, rather than failing silently.
- **Never both at once — across two apps now.** `requestSingleInstanceLock` is per app, so it no longer
  covers this: two apps would drive the same displays and universes. A **machine-wide lock** (a named
  mutex, or a lock file in the shared `userData` holding the owner's pid) is taken by whichever app owns
  the outputs; the other one offers to hand over or refuses, naming the app that holds them.
- **The UV checker** — a procedural test source (a shader surface, the same content type as the
  templates' `TESTCARD`, so it needs no media file and renders at any size):
  - **Two sizes, Full HD (1920×1080) and 4K (3840×2160)**, chosen when it is added; the surface renders at
    that size.
  - **It adapts to the project**, read when it is added and again when the project changes:
    - the **surface's aspect** — cells stay square in pixels, so a 10:3 panorama gets more columns than
      rows instead of stretched squares;
    - the **screens it lands on** — each screen named in the venue file (`screen…`) gets its name and its
      UV extent drawn in, so a mapping error points at the screen it belongs to;
    - the **projectors** — the rig's overlap regions, from the calibrations, can be tinted, so a blend is
      judged against the checker;
    - **labels** — every cell carries its row/column and U/V, readable at the chosen size, and the
      corners are colour-coded (the templates' red / green / blue / yellow convention) so orientation
      and mirroring read at a glance.
  - It stays a normal surface content: it plays through live calibration and through a calibration file
    alike, and can be exported to an image for media servers that need one.
- **Icons:** both derive from `build/icon.svg` — the same mark, told apart by a badge or a colour shift
  (a play / stage mark for Show, a crosshair for the Calibrator). Each build target writes its own
  `.ico` / `.png` from its SVG, so the Launcher, the taskbar and the installers all match.
- **One `userData` for both**, pinned explicitly (`%APPDATA%\artlux`): prefs, recents and the remembered
  calibration file are facts about the machine, and today's installs already live there. Each app keeps
  its own logs subfolder so a machine log names the app.
- **One version, one tag, one release.** The CI matrix builds both targets; electron-builder publishes
  Show's update metadata as `latest.yml` (unchanged — the Launcher and electron-updater already read it)
  and the Calibrator's on its own channel (`calibrator.yml`). The fixed-name download link
  (`ArtLux-Setup-x64.exe`) keeps pointing at Show; the Calibrator gets its own
  (`ArtLux-Calibrator-Setup-x64.exe`).

### Phase 4 — unattended recalibration through a hand-off *(medium)*

A recalibration projects markers on the wall, so the show is interrupted while it runs whichever app does
it. That makes a hand-off the natural shape: show control's scheduler keeps its `recalibrate` action
(`plugins/show-control/src/types.ts:22`), but in Show it means **"hand the machine to the Calibrator for
this job"**:
1. Show saves its state, blacks its outputs, releases the machine-wide lock, and launches **ArtLux
   Calibrator** with `--recalibrate=check|full --then=show` on the same project. If the Calibrator is not
   installed, the scheduled action is skipped with a logged reason and the show keeps running.
2. Calibrator runs the existing unattended path (marker registration, the validate-better gate, rollback),
   writes the result into the project, and relaunches Show in broadcast on it.
3. Show reloads the project and resumes the schedule.
- The watchdog must treat the hand-off as planned, not a crash (the deliberate-shutdown marker it
  already has).
- `calibRevert` follows the same path.

### Phase 5 — the Launcher installs, updates and opens both apps *(medium)*
- Two app tiles, **ArtLux Show** and **ArtLux Calibrator**, each with its installed version, an install /
  update button, and "open the selected project in it". "Open projects in: Normal / Calibration" goes away.
- The Launcher resolves Show from `latest.yml` (as today) and the Calibrator from `calibrator.yml`, with
  the same sha512 check before running either installer.
- An ArtLux from before the split, behind the new Launcher, is shown as "ArtLux (before the split)" and is
  still launched with `--calibrate` for calibration.

## 5. ⚠️ Breaking changes

- **Calibrating needs the second install.** A machine with only ArtLux Show cannot calibrate at all; one
  that does both needs both installers.
- **`--calibrate` stops meaning anything to ArtLux Show** (its build has no authoring code). The Launcher
  stops sending it to a split-era Show; a script that passes it gets a logged notice, not an error.
- **`File ▸ Open Calibration Workbench…`** becomes "Open in ArtLux Calibrator"; the docs change.
- **The Calibrator no longer has the full editor.** Anyone who calibrated and edited the show in one
  session today switches apps for the editing.
- **A scheduled recalibration becomes a hand-off between two apps** (Phase 4): the show's broadcast window
  closes and reopens around it, where today it recalibrates in place; and it needs the Calibrator
  installed on the show machine.
- **Two products in one release** — the release page, the fixed-name links and the Launcher's resolver all
  change (LAUNCHER.md §3).

## 6. Migration & back-compat

- **An installed "ArtLux" becomes "ArtLux Show" on its next update**, in place: Show keeps the app id
  **and the `C:\Program Files\ArtLux` folder**, so paths, the profile and existing scripts survive. Only
  the product name, the Start-menu shortcut and the window titles change.
- Project files: unchanged. Calibrations made in either app play in Show.
- An older Launcher sees Show as "ArtLux" through `latest.yml` and keeps working; it cannot see the
  Calibrator until it is updated.
- An installed Show plays a calibration file and live calibration exactly as v0.34.1 does.
- Existing schedules with a `recalibrate` entry keep their meaning through the hand-off.

## 7. Risk evaluation

| Risk | Why it is real | Guard |
|---|---|---|
| A projector window loads the wrong half | Plugin activation runs once per window; the 2026-10-24 black projectors came from playback being on the wrong side of this gate | Re-test below; an invariant that playback is registered in both apps |
| Duplicated singletons after the barrel split | Mixing a package alias and relative imports duplicated a singleton before | `verify:plugins` markers for both barrels |
| Lazy OpenCV hides a missing DLL until the operator calibrates | Today a missing DLL shows at boot ("degraded") | Calibrator checks at start; Show does not need it |
| The recalibration hand-off leaves a show machine dark | Two processes, a relaunch, a project reload, at 04:00 with nobody there | The watchdog's deliberate-shutdown marker; a timeout that relaunches Show if Calibrator does not hand back; an unattended test of the round trip |
| **Both apps running at once** | Two app ids mean two single-instance locks: both could drive the same displays and universes | The machine-wide lock (Phase 3); a test that starting the second app while the first holds the outputs is refused or handed over |
| The first Show update leaves a stale "ArtLux" shortcut, or loses its profile | A product rename in place | An upgrade test from v0.34.1: one Start-menu entry named ArtLux Show, `%APPDATA%\artlux` untouched |
| A build drops something the other app still needs | Resource lists are now per product | The installed-build suite on **each** install; `verify:resources` gains a target |
| Release feed confusion | Three products (Show, Calibrator, Launcher) in one release list | Tag and metadata rules extended from the Launcher's; an update test from each product |

## 8. Test / verification plan

### 8a. How the two apps are built and run for testing (agreed 2026-10-25)

Both apps are built **locally** and tested at three levels, cheapest first. Nothing touches the owner's
own install or profile until level 3, and level 3 only on the owner's go.

| Level | How | What it proves |
|---|---|---|
| **1 · Dev loop** | `npm run dev` with `ARTLUX_APP=show` or `ARTLUX_APP=calibrator` (the build define, read at dev time too) | Each app registers the right contexts and loads the right code. Seconds per restart, nothing installed. |
| **2 · Unpacked builds** | `npm run package:show:dir` and `npm run package:calibrator:dir` (new, beside today's `package:dir`): one folder and one `.exe` per app, run in place on the scratch profile (`--user-data-dir=%TEMP%\claude\battle\profile`) | That each build leaves out the other app's parts — no OpenCV and no authoring chunk in Show's `resources/` and `app.asar`; startup memory against today's plain launch; the installed-build suite, the projection flow and the hand-off between the two `.exe`s. No UAC prompt. |
| **3 · The two installers, installed** | `npm run package:show` and `npm run package:calibrator` (NSIS), then installed **with the owner's approval** (one UAC prompt each) | Only a real install shows these: the upgrade from v0.34.1 into ArtLux Show in `C:\Program Files\ArtLux` with `%APPDATA%\artlux` kept; the Calibrator beside it; two Start-menu entries and taskbar icons; each app finding the other through its install key; the machine-wide lock refusing a second app. |

**Prerequisites on the test machine:** `npm run fetch:redist` (the NDI runtime and the VC++ redistributable —
missing on the RTX box, so a full installer cannot be built there yet) and the OpenCV DLL already staged by
`npm run fetch:opencv`. Levels 1 and 2 need neither redistributable.

**What local builds cannot test, and how it is covered:**
- **Auto-update and the Launcher's download path** need published releases: publish a **pre-release** of
  both products first (the Launcher already keeps pre-releases apart from `/releases/latest`), update a
  machine from it, then cut the real release.
- **The new Launcher against unreleased builds:** point it at the level-2 folders or at the pre-release,
  never at the public feed.

### 8b. What each phase must pass

- **Every phase:** `npm run verify`, `verify:plugins`, the installed-build suite (`run-installed.sh`,
  12 suites), the projection flow (`tools/mpe2e.sh`), the projection faults (`tools/projfault.sh`), and the
  Blender-save check (live-calibrated projectors stay lit through a save).
- **Phase 1:** the delta on two machines; a marker test that no authoring module is evaluated in a plain
  launch; OpenCV not mapped (process module list).
- **Phase 3:** install each product alone on a clean machine, then both; upgrade an existing v0.34.1
  "ArtLux" install into Show (profile kept, old install gone); open a project in Show, hand it to the
  Calibrator, calibrate, hand back, broadcast: projectors lit; start the second app while the first holds
  the outputs; check each `app.asar` and `resources/` for what must not be there.
- **Phase 4:** a scheduled `recalibrate` in broadcast at a near time, nobody touching the machine: the show
  stops, markers project, the result is written, the show resumes; and the same with Calibrator killed
  mid-job (Show must come back on its own).
- **Phase 5:** each tile opens the right app; an old ArtLux behind the new Launcher gets `--calibrate`.

## 9. Effort & phasing

| Phase | Size | Ships alone? |
|---|---|---|
| 1 — lazy OpenCV, lazy authoring code | 1 day | **yes** — most of the "Show pays nothing" goal |
| 2 — plugin split | 1–2 days | yes (no visible change) |
| 3 — two build targets, two installers, the machine-wide lock, the hand-off menus, the icons, the UV checker | 5–7 days + CI | yes |
| 4 — recalibration hand-off | 1–2 days | with or after 3 |
| 5 — the Launcher installs, updates and opens both | 2–3 days | after 3 |

## 10. Open questions

Resolved by the owner on 2026-10-25 — see §2a, decisions 8 to 11 (version lockstep, a test source in the
Calibrator, the relaunch around a scheduled recalibration, `C:\Program Files\ArtLux` kept).

Also resolved: the icons (decision 12) and the UV checker (decision 13).

Still open, none blocking Phase 1:

1. **The icons' exact treatment** (badge or colour shift) — a design pass on `build/icon.svg`, judged at
   16 px in the taskbar, where the difference has to survive.
2. **What "adapts to the configuration" re-reads live:** a screen renamed in Blender and saved, or a
   projector recalibrated — should the checker redraw at once (proposed), or only when re-added?
