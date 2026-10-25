# 2026-10-24 → 25 — session record: Blender venues, projection mapping, v0.34.0 → v0.34.1

> **Status:** Record (closed session, 2026-10-25). Written for two readers: the owner, and the next Claude
> session on this machine. **Installed here: v0.34.1.**
> It follows the [2026-10-24 evening record](2026-10-24-evening-session-record.md). The test campaign that
> closes it is [battle-test-v0.34.0.md](battle-test-v0.34.0.md). Measurements are from the RTX test box
> (RTX 5090, Windows 11, Electron 42.4.1).

## How it went

1. **"Import a Blender file in the 3D viewport; a geometry named `screen` is a screen I can assign a
   layer to."** Planned first ("assess, do not code"), then built on `feat/blender-screens`: named
   screens, then cameras named `projector…` as the starting point of a Manual calibration.
2. **"Import native .blend files — Blender in the background, live update when I save."**
3. **Templates, each tested end to end:** one flat screen + one projector, a curved screen, then two
   projectors blended on a curved panorama. Restarted, played video on them, exported and re-imported
   the calibration file.
4. **"Artefacts in the projector left for the soft edge" / "can we have a bigger resolution?" / "I need
   adaptive and accelerated in the GPU."** → the exact rig blend, traced on the GPU at an overlap-sized grid.
5. **Fixes found by using it:** the blend inspector's wrong sum, a calibration-file bake that hung, a
   Blender projector you could not see move, Unload throwing away the live calibration, and — the
   important one — **black projectors with a calibration file and the venue model loaded**.
6. Merged to `main` (fast-forward), released **v0.34.0**, documentation pass.
7. **"Install the latest version and run extensive tests — show preparation starts Monday, we don't want
   hidden bugs."** Installed v0.34.0 and ran the [campaign](battle-test-v0.34.0.md). It found one show bug:
   **a Blender save turned live-calibrated projectors black for good.**
8. **"go"** → fixed, released **v0.34.1**, installed, re-tested: the fix holds, 12/12 regression.

## What shipped

| Commit | What |
|---|---|
| `5699918` | Screens named in Blender take their own content (layer, surface or Program), locked to the model, UVs from Blender |
| `3c6354a` | A camera named `projector…` starts a Manual calibration (lens + pose; `poseSeed`) |
| `7d8f57b`, `a156d09` | Fixes from the first end-to-end Manual test: save waited for the commit, content upright on glTF model-wide, sane view through a projector, honest save light |
| `bdd3d33` | **Native `.blend` import**, Blender headless in main, file watcher, live update to every window |
| `ad42b18` | Three calibration templates + their fixes (Clear points keeps the Blender start, Edges look, sRGB double-encode in the blend, projector panel above the authoring gate, 3D canvas height) |
| `be5ce4a` | **Exact rig blend on the GPU at an adaptive grid**; WebGPU readback de-pad; imported MPCDI plays its alpha; late projector window replays its state |
| `42d5bca` | Blend inspector sums through the venue; MPCDI bake moved off the viewport renderer |
| `ee883cb` | A Blender projector is drawn reaching the venue |
| `2e096d0` | Unload keeps the live calibration where the venue can be drawn; still images come back after it |
| `087b128` | **Each projector window gets what it really draws** (`renderMode`) — the black-with-a-file fix |
| `ec28bfe` **v0.34.0** | Release. CI green on all three platforms; installed here 2026-10-25 |
| `ff3cbba` | Documentation: calibration files, re-aiming a Blender projector, the rig blend |
| `b59231d` | This record and the battle-test plan |
| `544b896` | **A Blender save no longer turns live-calibrated projectors black** (+ invariant) |
| `5f16502` **v0.34.1** | Release of that fix. CI green; installed here 2026-10-25 and re-tested |
| `7b631d2` | The v0.34.1 re-test, recorded |

## Decisions the owner made (do not re-open without asking)

- **Calibration files are optional.** The owner calibrates live while building, produces a file when a
  show needs one, and loads it then. Broadcast must keep supporting **both** live calibration and files.
  Do not make broadcast file-only.
- **Some shows use no projectors**, only screens. Plain outputs must stay exactly as they were.
- **Exported PFM rows are upside down against the PFM spec.** Left as is: no other media server reads
  ArtLux's files. ArtLux reads its own files correctly (the writer and reader agree).
- **Unload** keeps the live calibration on a machine that has the venue model; it switches an output
  off only where it cannot draw the venue.

## What to know about the code now

| Topic | The rule |
|---|---|
| **Bakes** (`projectorBake.ts`) | Both bakes (`bakeContentUv` for the file, `bakeWorld` for the blend) run on a **short-lived WebGL2 renderer of their own** (`offscreenPass`), released with `forceContextLoss`. On the viewport's WebGPU renderer they stalled with nothing logged (`compileAsync` never settled; the async readback never resolved) and timed out while the 3D view was hidden. They still need the venue **registered**: the 3D view opened once. |
| **Row order** | The uv map is **bottom row first** (GL raster order: `ProjectorGL` samples it at `vRaster`). The world map is **top row first** (OpenCV pixels). A flipped WebGL uv bake played the test card upside down; the old WebGPU code was right only by accident. Both guarded. |
| **Who decides render mode** | Main asks; the **window** decides (a loaded file supersedes render in `applyCalibMode`) and reports `renderMode`. The frame pump streams by that report. Before, a file + the venue model = black. |
| **Rig blend** | Calibrated rig → `computeBlendMapsProjected` on `bakeWorld` maps at `adaptiveBlendWidth` (≥ 32 cells across the narrowest overlap, min 160, ≤ 131,072 cells). Camera-scanned rig → the voxel path. No venue → CPU raycast fallback. |
| **`.blend`** | `main/blendImport.ts`: Blender `--background --factory-startup --python-exit-code 1`, write-then-rename. Watches the file's **directory** (Blender saves by rename). A mtime-only `touch` does **not** fire on Windows; a real save does. `SceneModel.origin = 'file'` keeps Blender coordinates. |

## For Monday — working with v0.34.1

**Which way to run an output** (the guide's
[Calibration files](../docs/user-guide/10-calibration.md#calibration-files--make-one-when-you-need-one)
section has the long version):

| You are… | Do this |
|---|---|
| Building the venue and the content | Live calibration. Keep Blender open; saving updates ArtLux in a few seconds, projectors included. |
| Re-aiming a projector you moved in Blender | **Calibrate ▸ Manual ▸ Start from it**, then **Clear points** (the old points keep solving the old aim), new points, **Apply & finish**, **Solve blend** again. |
| Running the show with heavy video, or on another machine | Export a calibration file (Verify step), give each projector surface the show's content, import it. Measured: 60 fps where live calibration dropped to 30 (two projectors, moving content) or 4 (a 5.7K clip). |
| Running a show on plain screens | Nothing changes — outputs draw their surface through their own warp. |

**Remember:**
- A loaded calibration file **stays loaded across restarts** until you press **Unload**.
- **Broadcast** plays whatever is set up: a loaded file, live calibration, or plain outputs. It does not
  watch the `.blend`; a show plays the converted model.
- An editor launch can **stop a shader surface animating** at start ("disabled after 30 frames"). It is
  the previous behaviour, and broadcast never does it; recompile the shader to re-arm it while editing.

## Already tried — do not redo

- **Running the bakes on the viewport's WebGPU renderer** (the request registry serviced by a frame
  hook). Stalled silently and timed out when the 3D view was hidden. Bakes have their own WebGL2 renderer.
- **Flipping the WebGL uv bake's rows to "top-left"** to match the old code's comment. It played upside
  down; the uv map is bottom-row-first.
- **Explaining the live-calibration 30 fps by the bitmap upload or its flip.** The upload costs 0.02 ms and
  disabling the flip changed nothing. The saturated thing is Chromium's GPU process (~108 % CPU), with
  one live projector at 60 and two at 30.
- **Chasing the one-batch `preloadScripts` Electron error.** 0 in 38 launches with every navigation and
  console line logged from the first moment; main loads the editor once.

## Where things are

| What | Where |
|---|---|
| The test campaign, every phase and measurement | [battle-test-v0.34.0.md](battle-test-v0.34.0.md) |
| Operator docs changed | [10-calibration.md](../docs/user-guide/10-calibration.md), [09-3d-scene.md](../docs/user-guide/09-3d-scene.md), [17-installing.md](../docs/user-guide/17-installing.md), [TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md), [CHANGELOG.md](../CHANGELOG.md) |
| Reference docs changed | [AUTO-ALIGN.md](../docs/AUTO-ALIGN.md), [CALIBRATION.md](../docs/CALIBRATION.md), [NVWARP.md](../docs/NVWARP.md), [PROGRESS.md](../docs/PROGRESS.md) |
| Harness, logs and scratch rigs (may be wiped) | `%TEMP%\claude\battle\` — `run-installed.sh`, `tools/` (`oi.mjs`, `mpe2e.sh`, `blendinst.sh`, `projfault.sh`, `calside.mjs`, `grabstore.mjs`, `lum.cjs`, `preload.mjs`), `soak-show.sh`, `soak-proj.sh`, `out/` |
| Previous sessions | [2026-10-24 evening](2026-10-24-evening-session-record.md), [2026-10-24](2026-10-24-session-record.md), [2026-10-23](2026-10-23-session-record.md) |

## Needs the owner

| Item | What to do |
|---|---|
| **Test leftovers in your real profile** (from 2026-10-24, still there) | `%APPDATA%\artlux\showctl-devices.json` (tablets paired by old tests) and temp entries in Recent files |
| **Your test rig** | `%TEMP%\claude\battle\blendtest\` holds your re-aimed two-projector rig, its video and `rig-rotated.mpcdi`. Scratch only; copy anything you want to keep |

## Found by the v0.34.0 campaign

| Item | Status |
|---|---|
| **A Blender save turned live-calibrated projectors black for good** (the old model URL was revoked while the scene still drew it; the plugin's error boundary took the panel down) | **Fixed and released in v0.34.1** (`544b896`, `5f16502`), installed here and re-tested: projectors stay lit through saves, 0 errors. |
| Live calibration at 30 fps in broadcast with 2 projectors and animated content | Open, performance; a calibration file plays at 60 fps. Details in the campaign file. |

## Still open (none of these block the show)

| Item | Notes |
|---|---|
| **Shaders disabled at editor launch** | Every editor launch disables some shader surfaces ("disabled after 30 frames over 16 ms") — identical on the previous `main`; broadcast never does it. A disabled shader freezes on its last picture until recompiled. Not investigated. |
| **Live calibration with a huge video** | 5760×2880 HEVC on two live-calibrated projectors: 4 fps. Through a calibration file: 60 fps. Downscaling the copies to each window's raster would help live; not built (the owner chose to test the file path). |
| **PFM row order vs the spec** | See decisions. |

## Testing on this machine: new recipes (on top of the earlier records)

- **The 3D view's live camera from outside the page:** r3f's DOM pointer listeners close over its store.
  CDP `getEventListeners(canvas ancestors)` → `Runtime.getProperties` on each listener's `[[Scopes]]` →
  the object with `getState().camera` → park it on `window`. Then a world point's pane pixel is exact.
  The script is `%TEMP%\claude\battle\tools\grabstore.mjs`; `calside.mjs` uses it to click six screen
  vertices of a Blender projector's coverage and checks each pick against the predicted pixel.
- **Turn the pane camera to face the screen before picking:** from above, a screen's top and bottom
  vertices overlap and snap to the wrong one. Set `camera.position` + `controls.target` from the store.
- **Trigger a Blender re-import** with a rename-over save (`cp x.blend x.blend@ && mv x.blend@ x.blend`),
  not `touch`.
- **A remembered calibration file persists in the profile** (`artlux-prefs.json` `calibrationFile`) and
  overrides live calibration on matching surface ids. Clear it between tests.
- **Compare against `main`** in a worktree: `git worktree add`, a **junction** to the real `node_modules`,
  copy the gitignored `native/*/*.node` + DLLs, `electron-vite build`, launch with `cwd` = the worktree.
  **Delete the junction itself before `git worktree remove`** — a recursive delete follows it.
- **Brightness of a window screenshot:** `tools/lum.cjs` (mean + % lit, label strip skipped) tells black
  from playing without looking.
- **`sweep.mjs`, `soak.mjs` and `soakreport.mjs` need `BATTLE` exported** (forward-slash path); without it
  they write to `…\battle\undefined\…` and exit at once.
- **With `MSYS_NO_PATHCONV=1`, give node `E:/zaki/…` paths**, never `/e/zaki/…` (it becomes `C:\e\zaki`).
- **The installed build accepts `--inspect=9230`**, so `stubboth.mjs` (main-process dialog stubs) works on
  it too — the MPCDI export can be driven end to end on the installed app.
- **Measure live calibration in broadcast.** An editor launch freezes the test-card shader, so an
  editor-mode fps hides what moving content costs.
- **A Blender save is the regression test for the model reload:** live-calibrated projectors on, one
  rename-save, both windows must stay lit and the log must show 0 errors.
