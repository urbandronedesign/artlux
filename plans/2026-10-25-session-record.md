# 2026-10-24 → 25 — session record: Blender venues, projection mapping, v0.34.0

> **Status:** Record. Written for two readers: the owner, and the next Claude session on this machine.
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
6. Merged to `main` (fast-forward), released **v0.34.0**, documentation pass, then this campaign.

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

## Needs the owner

| Item | What to do |
|---|---|
| **Test leftovers in your real profile** (from 2026-10-24, still there) | `%APPDATA%\artlux\showctl-devices.json` (tablets paired by old tests) and temp entries in Recent files |
| **Your test rig** | `%TEMP%\claude\battle\blendtest\` holds your re-aimed two-projector rig, its video and `rig-rotated.mpcdi`. Scratch only; copy anything you want to keep |

## Found by the v0.34.0 campaign

| Item | Status |
|---|---|
| **A Blender save turned live-calibrated projectors black for good** (the old model URL was revoked while the scene still drew it; the plugin's error boundary took the panel down) | **Fixed in the working tree** (`CalibProjector.tsx`, `useModelUrls.ts`, + an invariant), verified on a production build. **Not committed or released yet** — the installed v0.34.0 still has it. Until then: do not save the `.blend` while live-calibrated projectors are switched on (editor or broadcast). |
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
