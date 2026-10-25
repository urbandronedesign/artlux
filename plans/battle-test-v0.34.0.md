# Battle test — v0.34.0 on the RTX box, before the BIP show preparation

> **Status:** Complete (2026-10-25) · Release-scoped verification plan, run before the owner's
> show preparation starts on Monday 2026-10-26. Same method as [battle-test-v0.33.8.md](battle-test-v0.33.8.md):
> results are written into the tables below as each phase runs, failures first.

## Why, and what "pass" means

v0.34.0 is the biggest change to projection since the calibration plugin: native `.blend` import with a
file watcher in main, a new projector-window message (`renderMode`), bakes moved onto an offscreen
renderer, a new rig blend, and a projector panel that now registers in every launch. Each of those
touches a path the show runs on. So this campaign re-runs everything v0.33.8–v0.33.10 proved, on the
installed v0.34.0, and adds the new paths.

Pass signals are the ones from the v0.33.8 campaign: **the wire** (payload changes per universe, not
`render_fps`), **picture continuity** (`__artluxLayerGaps`), **frame pacing**, **decoders**,
**resources** (no slope over a soak) and **survival**. A projector's picture is judged from its own
window (screenshot brightness and change), never from the editor.

## The bench

- **Build under test:** the installed `C:\Program Files\ArtLux\ArtLux.exe` **0.34.0** (installed
  2026-10-25 from the release asset; SHA-512 checked against `latest.yml`).
- **Profile:** `--user-data-dir=%TEMP%\claude\battle\profile` (OSC on 127.0.0.1:10000, engine 60 fps,
  ArtSync on, Unattended off, **no calibration file remembered** at the start). CDP 9333.
- **Harness:** `%TEMP%\claude\battle\` (`run-installed.sh` and the scripts it calls; see the v0.33.8 plan).
  Examples are swept from a fresh copy of the repo's `examples/` at `ff3cbba`: `%TEMP%\claude\battle\ex0340\`.
- **What this machine cannot prove:** a real projector, LED nodes, a LiDAR, a venue network → **on site**.

## Phases

| # | Phase | What |
|---|---|---|
| 0 | Static | `npm run verify`, every offline `test:*` suite |
| 1 | Regression on the installed build | `run-installed.sh`: GPU crash ×3 modes, NDI, lighting boot, output matrix, state machine, inputs, OSC out, bad media, headless/broadcast, cold-start lifecycle |
| 2 | Examples sweep | All 22 shipped example projects open and play; no uncaught exception; output where patched |
| 3 | The workshop example | `interactive-show`: the scripted visitor walks every transition, editor and broadcast |
| 4 | New in v0.34.0 | `.blend` import + live update, named screens, Blender projectors, Manual calibration on the templates, rig blend, calibration file export/import/unload, broadcast with a file, plain screens, large video |
| 5 | Faults | GPU crash with calibrated projectors and with a calibration file; Blender missing / failing; a deleted calibration file; projector window closed and reopened |
| 6 | Soak | The heaviest honest show in broadcast, sampled every 30 s |

## Results



### Phase 0 — static (HEAD `ff3cbba`)

`npm run verify` (237 invariants, 11 doc checks, colour engine, tsc) and every offline suite pass:
`test:blend`, `test:docktree`, `test:frame-exact`, `test:renderclock`, `test:recal`, `test:import`,
`test:workspace`, `test:people`, `test:matte-gl`, `verify:plugins`. Not run, need inputs: `test:zone:take`
(a take), `test:hap-exact` (a HAP clip). `verify:resources`: the NDI runtime and VC++ redistributable are
not downloaded on this machine — installer packaging, not a v0.34.0 change (CI's installer has them).

### Phase 1 — regression on the installed v0.34.0 (`run-installed.sh`): **12 / 12 PASS**

| Suite | Result |
|---|---|
| GPU crash, every consumer — editor | ALL PASS |
| GPU crash ×2 — broadcast | ALL PASS |
| GPU crash ×2 — broadcast, Unattended ON | ALL PASS |
| NDI, ArtLux started before the sender | ALL PASS |
| Lighting example boot (the 15 s gate bug of v0.33.8) | no verdict, 0 exceptions, render 59.9 fps, output 61 Hz |
| Output matrix (Art-Net spanning, sACN priority, HAP-Q, ArtSync, OSC scene recall, pause/play) | ALL PASS |
| State machine, every trigger | ALL PASS |
| Inputs (DMX-in, camera, text, NDI loop) | ALL PASS |
| OSC out (timeline OSC track) | ALL PASS |
| Bad media + an unreachable controller + corrupt/missing `.artlux` | ALL PASS |
| Headless + broadcast modes | ALL PASS |
| Packaged cold start, no CDP (splash, editor, broadcast windows) | ALL PASS |

### Phase 2 — every shipped example (22) on the installed v0.34.0

All 22 open and run with **0 uncaught exceptions** and render at 60 fps. Output on the wire at 45–61 Hz
wherever the example patches fixtures. The 9 with `output_fps 0` have no fixtures by design: LiDAR ×4,
OSC-Arduino 01, and the three calibration templates (projectors only). OSC-Arduino 02 now sends (45 Hz).

| Console errors seen | Verdict |
|---|---|
| `[fault] Shader … disabled after 30 frames over 16 ms` (multi-projector) | **Pre-existing on `main`**: identical in 3/3 launches of a `main` build and of v0.34.0, editor launch only, broadcast never. Open — see below. |
| `Electron sandboxed_renderer.bundle.js script failed to run` / `preloadScripts of binding.startupData is null` (5 examples, one batch) | **Unexplained, harmless as observed.** All five runs rendered at 60 fps with output on the wire; the machine logs show no error. Not reproduced in 38 further launches (`tools/preload.mjs`: every navigation and console error from the first moment, plus a working `window.artlux` at the end — 32/32 clean). Main loads the editor exactly once (`index.ts`); nothing reloads it but the Reload menu item. Watch item. |

### Phase 3 — the workshop example, `interactive-show`

The scripted visitor walks **attract → welcome → story A → attract → welcome → story B → attract** in
**6 / 6 runs** (3 editor, 3 broadcast), same timings each run (welcome at 10.6 s, story A at 17.9 s …).
The harness first reported FAIL: each recording now starts with `__global__` for 0.3 s — the cold-start
hold before the first state, which the recorder attaches early enough to catch. `showtest.mjs` now skips
the hold. Not an app change.

### Phase 4 — new in v0.34.0, on the installed build

| Area | Result |
|---|---|
| **Manual calibration on the two-projector template** (`tools/mpe2e.sh`) | Start from the Blender projector, 6 vertices each, every point within **0.6 px** of the prediction, RMS 0.000 px ×2 |
| Rig blend | Σα within 6 % everywhere, worst **0.8 %** |
| Save, export the calibration file | saved; 2 regions at native raster, 11 MB |
| Live calibration, editor + broadcast | both projectors lit (64 %) |
| Calibration file in broadcast | restored at boot, active in both windows, both lit, 0 errors |
| **`.blend` on the installed build** (`tools/blendinst.sh`) | Blender 5.2 found; a save reaches the editor (`updating` → `updated`, 6.6 s first, 1.8 s after); two quick saves → one update; a corrupt `.blend` fails cleanly in 1.4 s with Blender's message |

**BUG FOUND AND FIXED (not yet released) — a Blender save turns live-calibrated projectors black.**

| | |
|---|---|
| **Measured** | Installed v0.34.0, the calibrated template, projectors in live calibration: one rename-save of the `.blend` → **both projectors 64 % lit → 0 %**, still 0 % 35 s later. The projector windows log `Could not load blob:file:///… Failed to fetch`, then the calibration plugin's error boundary takes the panel down. In the editor the same save logs an uncaught error and `venue model failed to load` (the model blinks out, then returns). |
| **Cause** | On `BLEND_UPDATED`, `CalibProjector` and `useModelUrls` cleared the old model from useGLTF's cache and revoked its blob URL at once, while the mounted scene still held that URL. Its next render re-suspended, fetched the revoked blob, and threw. |
| **Fix** | Both retire an old URL only once the published `modelUrls` no longer reference it. New invariant (mutation-tested: the old code fails it in both files). |
| **Verified** | Local production build, same rig, 3D view open, two saves: projectors stay at 64 % lit, both conversions logged, **0 errors**. |

**Performance finding (not fixed) — live calibration halves in broadcast with animated content.** Two
live-calibrated projectors showing an animated surface run at **30 fps** in broadcast (one projector: 60;
the same rig through a calibration file: 60; an editor launch: 60, because the editor disables the shader
at start). Chromium's GPU process is saturated (~108 % CPU) while the GPU itself sits at 16 % and the
projector pages are idle (23 ms of work per second). The bitmap upload is not it (0.02 ms; disabling the
flip changed nothing). Not proven a regression: v0.33.13 cannot run this template (no named screens).
**For a show: play a calibration file**, or keep live calibration for building.

### Phase 5 — faults on the projection path (installed build)

| Fault | Result |
|---|---|
| GPU-process crash, broadcast, calibration file + 5.7K video | both projectors lit before and after, video still moving; the log shows the planned recovery (`WebGPU DEVICE LOST … rebuilding`, `WebGL context lost … reloading this output`) |
| GPU-process crash, broadcast, live calibration | both lit before and after |
| The remembered calibration file deleted | starts, warns once, falls back to live calibration, both lit, 0 errors |
| An output switched off and on | the window closes and reopens, lit again |

### Phase 6 — soak (installed build, broadcast, sampled every 30 s)

| Run | Duration | What changed | Gaps inside a state | Deaths | Render (min) | Wire (min) | Frame p99 | Drift per hour |
|---|---|---|---|---|---|---|---|---|
| `interactive-show`, the visitor looping (337 walks) | **2 h** | **671 state changes** | **0** (5 at cuts in 671) | 0 | 59.88 | 59.5 Hz | median 18.3, max 18.8 ms | RSS +0.2 MB, adapter +0.9 MB, handles +1.4 |
| Projection: calibration file + 5760×2880 HEVC on 2 projectors | **1.5 h** | — | — | 0 | 59.88 | (no fixtures) | median 18.2, max 18.9 ms | RSS −2.2 MB, adapter −0.2 MB, handles +4.1, renderer RSS +0.7 MB |

The projection soak also screenshotted both projector windows every 60 s: **88 / 88 samples both lit, the
video moving, both windows at 60–60.2 fps**. MP4 decoder errors 0 in both runs. **Pass: flat memory, no
deaths, no picture loss.**

## Verdict

**v0.34.0 is ready for the show preparation, with one fix to ship first** — a Blender save while projectors
run on live calibration turns them black (fixed in the working tree, not yet released). Everything else
held: 12/12 regression suites, 22/22 examples, the workshop show 6/6 plus a 2 h soak, the full
projection-mapping flow, the projection faults, and a 1.5 h projection soak.

## Coverage

| Area | Status |
|---|---|
| LED output (Art-Net, sACN, ArtSync, routing), content types, timeline, state machine, OSC in/out, DMX-in, camera, NDI, Spout, text, bad media, GPU crash ×3 modes, headless/broadcast, packaged cold start | **tested** (Phase 1) |
| Every shipped example | **tested** (Phase 2) |
| The workshop example with a moving visitor | **tested** (Phase 3 + 2 h soak) |
| `.blend` import, live update, a corrupt file; Manual calibration from Blender projectors; rig blend; calibration file export, import, broadcast, missing file; plain screens | **tested** (Phase 4/5) |
| Projection under a GPU crash, output close/reopen | **tested** (Phase 5) |
| Long-run projection with a heavy clip | **tested** (1.5 h) |
| Live calibration in broadcast with animated content | **partly**: works, but 30 fps with two projectors (finding above) |
| Undo/redo under load, keyboard rebinding, the Launcher app itself, auto-update to v0.34.0 | **not tested** this time (same gaps as the v0.33.8 coverage table) |
| A real projector and camera (Board / Auto-Align), real LiDAR, LED nodes, a venue network, sound on a device | **on site** |

## Needs the owner

1. **Ship the Blender-save fix** — go to commit, release v0.34.1, and approve the installer's UAC prompt.
2. Until then, **do not save the `.blend` while live-calibrated projectors are switched on** — editor or
   broadcast, they go black until the app is restarted. Saving is safe with those outputs off, or while they play
   a calibration file (the 3D view still blinks and logs an error on each save; harmless).
3. Optional cleanup, unchanged from 2026-10-24: `%APPDATA%\artlux\showctl-devices.json` and temp entries
   in Recent files in your real profile.
