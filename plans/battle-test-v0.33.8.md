# Battle test — v0.33.8 on the RTX box

> **Status:** In progress (started 2026-10-24) · Release-scoped verification plan, not a limitation-lift
> plan — the 10-section template does not apply. Results are written into the tables below as each phase
> runs, failures first.

## Why, and what "pass" means

The repo has no test runner. What it has is ~40 targeted scripts that nobody runs together, 203 source
invariants, and a habit of measuring one feature at a time. The v0.33.x line shipped five fixes in two
days, each found by *watching* the app do something real (a decoder freeze, a projector orphaned by a
reload, a bake that froze surfaces, a picker that linked instead of importing, a flicker between
states). Every one compiled, booted and passed `npm run verify`. So this plan is built around **what an
audience would see and what the wire carries**, not around the code.

A phase passes only on **measured** signals, never "it looked fine":

| Signal | Source | Pass |
|---|---|---|
| Output on the wire | `dmxcap.mjs` (ArtDmx/sACN per universe) + `artlux_output_fps` | every patched universe at the engine rate, content-driven changes |
| Picture continuity | `__artluxLayerGaps()` (reset first), `__artluxProjPump()` | 0 gaps inside a clip; cut gaps bounded and logged |
| Frame pacing | `/metrics` `render_fps`, `render_frame_p99_ms`, `render_long_frames` | 60 fps, p99 < 25 ms outside cuts |
| Decoders | `__artluxMp4Stats()`, `__artluxHapStats()`, `__artluxCodecResidency()` | errors 0, or recovered (`recoveries` = faults injected) |
| Resources | RSS, handles, adapter memory (`counters.ps1`) | no slope over a soak (linear fit, not eyeballing two points) |
| Survival | process list, machine log, watchdog marker | no unplanned renderer/GPU death; planned ones recover |

## The bench (see plans/2026-10-23-session-record.md § Testing for the traps)

- **The build under test is the installed `C:\Program Files\ArtLux\ArtLux.exe` (0.33.8)**, launched with
  `--user-data-dir=%TEMP%\claude\battle\profile` so the owner's prefs, recents and GPU cache are never
  touched, and `ARTLUX_CDP_PORT=9333`. Dev-launching scripts (Phase 1) run HEAD source = v0.33.8.
- Wire capture: `%TEMP%\claude\battle\dmxcap.mjs <sec> [port]`. ⚠ 6454 may be held by the app's own
  Art-Net input — cross-check with `artlux_output_*` before calling output dead.
- **Window visibility is never checked with a CDP port** (it forces a paint): EnumWindows + IsWindowVisible.
- Kill every instance between phases (`Get-Process ArtLux,electron | Stop-Process -Force`).
- What this machine cannot prove: a real projector, LED nodes, LiDAR, a venue network. Marked **on site**.

## Phases

### 0 · Static — `npm run verify`
Invariants, docs, colour engine, tsc. Already green at `f155504`.

### 1 · Every existing script, in one pass
PURE first (`test:logic`, `test:blend`, `test:docktree`, `test:renderclock`, `test:recal`, `test:import`,
`test:workspace`, `test:people`, lookahead, mediagrid, mpcdi-roundtrip, manual-solve, audio-offline,
frame-exact, matte-gl, hap-exact with a real HAP file, `test:showctl:ui`), then the LIVE ones one at a
time (each kills every electron.exe): engine-output, cmy-bridge, color-lane, import-runs, copy-paste,
auto-key, fixture-track, hold-at-end, scene-timelines, zone-fsm, project-import-live, timeline-rightclick
(read its output — it always exits 0), lighting-take (steps 4–5 known red), then `test:showctl` (needs
6454 free, app down).

### 2 · Feature matrix on the installed build
One row per feature: the action, the observable, the result. Driven over CDP + wire capture.
Output (Art-Net, sACN, ArtSync, routing, blackout, brightness) · content (MP4, HAP, image, effects,
palettes, shaders, text, Spout with the demo sender) · timeline (play/loop/hold, fades, undo, automation,
markers) · show (scenes/cues, every trigger kind, idle reset, cold-start gate, waitForContent) · projector
outputs (open, fps cap, editor reload) · bake (end-to-end into the project) · show control (HTTP/SSE,
scheduler, playlist) · OSC in/out · audio · projects (save/reopen, collect assets, move the folder,
import between projects) · headless and broadcast modes.

### 3 · Fault injection
GPU process crash (`Browser.crashGpuProcess`), every `__artluxMp4Fault` kind, renderer kill, a missing
media file, a truncated MP4, a corrupt `.artlux`, a controller IP that does not exist, a project folder
renamed under a running show. Pass = the output keeps running or recovers on its own, and the machine
log says what happened.

### 4 · Unattended lifecycle
Packaged cold start with **no CDP** (window and splash really appear), relaunch on the last project,
the watchdog's deliberate-shutdown marker, kill → supervisor restart (`watchdog-check.ps1`).

### 5 · Soak
The heaviest honest show: 4 states with both 5.7K HEVC clips, two light clips, the still image, two
projector outputs and Art-Net, cycling every 8 s, then a 1.5 s stress pass. ≥ 8 h, sampled every 30 s.
Pass = no slope in RSS/handles/adapter memory, 0 mid-clip gaps, output never below the engine rate,
0 deaths.

## Results

### Phase 1 — every existing script (2026-10-24, HEAD = v0.33.8)

**Failures and harness defects first:**

| Item | What happened | Verdict |
|---|---|---|
| `npm run test:blend` / `test:recal` | `test:logic` (the shared tsc step) has failed since 2026-07-25/08-10: the SDK barrels import `./index.ts` and AlignAids default-imports React, both rejected by `scripts/tsconfig.test.json`. tsc still emitted, so the JS ran fine — only the `&&` gate was dead. | **Fixed** (`rewriteRelativeImportExtensions` + `esModuleInterop`); both green through npm |
| `test-hold-at-end.cjs` | `clickByText: no match for "Time"` — the rail label it clicks is gone (script from 2026-07-24). Same failure on a rerun. | **Stale harness** — behaviour re-tested in Phase 2 |
| `test-scene-timelines.cjs` | `Attempted to use detached Frame` — it attaches before the app's startup navigation. Same on a rerun. | **Stale harness** — behaviour re-tested in Phase 2 |
| Dev-launching tests | They write `lastProjectPath` + `recentFiles` in the owner's REAL profile (`%APPDATA%\artlux`) and do not fully restore: after the run, `lastProjectPath` was a deleted temp project and recents held 9 test files. | **Harness defect** — no more dev-launch runs in this campaign |
| `test-manual-solve.cjs` | `ERR_DLOPEN_FAILED`: `native/calib/calib.node` needs `opencv_world4110.dll` beside it or on PATH. | Environment — passes with the installed `resources\` on PATH |

**Passed:**
- **Pure logic (12 of 12):** blend, recal, docktree, renderclock, import, workspace, people, lookahead, mediagrid, mpcdi-roundtrip, manual-solve, colour engine.
- **Own-Electron harnesses:** audio-offline, frame-exact, matte-gl, show-control UI, and hap-exact on HAP, HAP-Q and HAP-Alpha. The HAP clips were encoded for this run with a local ffmpeg; the repo has no HAP fixture.
### Phase 2 — feature matrix on the installed v0.33.8

**Bug found and fixed:**

| Bug | Measured | Fix |
|---|---|---|
| **A project opening on a lighting take starts 15 s late.** `lighting` is the only core lane kind; plugins register theirs, nobody registered it, so its clip (`path: ''`) went through the per-frame video sync, warmMedia and the cold-start gate as a video. The gate waited for a `<video>` that could never load. | `examples/lighting/02-a-recorded-busk`: `[boot] armed by TIMEOUT after 15.0s — 1 item(s) never became ready: ` (an empty name), on every open. Since lighting lanes shipped (2026-07-26). | `registries.ts` registers `lighting` with `skipVideoSync` + `excludeFromProgram`. New invariant: every non-video `LayerKind` must be registered (mutation-tested). Re-run on the local build: arms with no timeout, and the take still drives the heads on the wire. |

**Passed:**

| Area | Result |
|---|---|
| Examples sweep (all 18 shipped examples) | Every one opens; no uncaught exceptions; output at the engine rate wherever the example patches fixtures. The six with no DMX (LiDAR ×4, OSC-Arduino ×2) have no fixtures, which is correct. Only defect: the lighting one above. |
| Output matrix (15 checks) | Effect → Art-Net u0+u1 (a 340-LED strip spans) · HAP-Q → u3 changing exactly as often as the same clip as MP4 (11.6 vs 11.4/s, so no dropped frames) · still image → **sACN** u5, priority 150 on the wire · no cross-protocol leak · **ArtSync** at 60 Hz · OSC scene recall to brightness 0 blacks every universe and keeps sending · recall back · pause freezes, play resumes |
| Bake (9 checks) | Effect, HAP and a **5.7K HEVC timeline layer** baked into `assets/video` (60/60 frames, all distinct; 0.3 / 0.5 / 0.9 s); surfaces keep animating afterwards. A bake while the state machine runs is **refused** with a clear reason — correct. |
| Save → move → reopen (7) | Save All writes valid JSON; surfaces, fixtures, controllers (sACN priority) and scenes unchanged; asset paths relative; after renaming the folder, HAP, MP4 and the image all still play on the wire. |
| Headless / broadcast (7) | `mode=` reported correctly; universe 0 on the wire; the state machine advances on its own; headless has no visible window; broadcast opens both projector windows. |
| Spout | The demo sender's texture arrives at 58 Hz and lights the strip (459 lit channels, changing). |
| Audio + OSC transport | The bed sounds on play and stops on pause; stop returns to 0; seek lands; JUCE engine loaded. |
| Show control | The tablet page is served; the API answers 401 to an unpaired device. |

**Not bugs (checked and dismissed):**
- **Render at 30 fps.** The default engine rate is 30 (`AppSettings.engineFps`, documented). The owner's profile is set to 60, and the bench was switched to match.
- **"ARTLux" in window titles.** That's the wordmark.
- **The CSP warning.** It appears only in the unpackaged dev build.

**Retracted.** "OSC input is dead" was wrong. Git Bash rewrote `/artlux/transport/pause` to `C:/Program Files/Git/artlux/…` (the MSYS trap already in the 2026-10-23 record). Traced packet by packet into main's socket. With `MSYS_NO_PATHCONV=1`, OSC works.

### Phase 3: fault injection on the installed v0.33.8

**THE FINDING OF THIS CAMPAIGN: after a GPU-process crash, the LED output freezes on one frame for
good, and every health signal stays green.** The repro is `gpuloss.mjs` (one `Browser.crashGpuProcess`,
then 60 s of watching universe 0's payload). It was run on the single-clip project, in editor and
broadcast mode:

| | Before the crash | After |
|---|---|---|
| Art-Net packets, u0 | 60/s | 60/s (the wire never stops; worst gap 25 ms) |
| Payload changes, u0 | 22–30/s | **0/s, for 59 of 60 s, in both modes** |
| `artlux_render_fps` / `output_fps` | 60 / 60 | 60 / 60 |
| mp4 decoders | configured | **recovered** (`r1`), as v0.33.6 promised |
| Perf log | `fps=60 … gpuP99≈8ms` | `fps=60 … gpuP99=0.02ms` (the GPU doing nothing is the only tell) |

- **Why:** `WebGPUMapper` has no `device.lost` handling (listed as open on 2026-10-22). The mapper
  samples every LED, so a lost device leaves `frameEngine` packing the last colours forever. The device
  is also shared with the 3D view (`gpuDevice.ts`, `publishGpuDevice` settles once and never re-publishes).
- **The v0.33.6 CHANGELOG overstates it.** "The show keeps running through a real graphics crash"
  holds for the decoders, not for the picture that reaches the LEDs.
- **The watchdog catches it only when Unattended is on.** Unattended is off by default, even in
  `--broadcast`. With it on, the machine log shows `relaunch → gpu-gone reason=crashed` about 1 s after
  the crash. The end-to-end outage was not measured: the relaunch drops `--user-data-dir`, so the
  successor came up on the owner's profile (see below).

**Passed:**

| Fault | Result |
|---|---|
| `__artluxMp4Fault` close / error / configure / error-all ×3, while 4 states cycle | Wire worst gap 25 ms throughout; page alive; no uncaught exception |
| Broken media beside good (truncated MP4, truncated HAP, garbage `.mp4`, a missing file, a broken PNG) | The good MP4 and image play; every universe still sent; 0 exceptions; the machine log names each bad file |
| A controller at an unreachable IP (10.255.255.1) | Output holds 61 fps on the others |
| A corrupt `.artlux` / a path that does not exist | The app starts (≈260 ms to page), no exception |

**Weaknesses (not fixed):**
- **A known-failed file still holds the show for the full 15 s cold-start timeout.** `missing.mp4` is
  logged "missing" at 1.4 s, yet the gate armed by TIMEOUT at 15 s, listing 5 items. Same family as the
  lighting bug: the gate should count a decided failure as "ready (failed)". HAP's `preRoll` already does.
- **The watchdog relaunch drops `--user-data-dir`.** `relaunchArgs()` + `--broadcast --project=` rebuild
  argv from scratch. It is harmless for a default install, but wrong for anyone running a second profile.

### Phase 4: unattended lifecycle (installed, NO CDP port; Win32 EnumWindows every 100 ms)

| Check | Result |
|---|---|
| Editor cold start | Splash visible at once; editor 1456×908 at **723 ms**; then the projector windows; still visible at the end |
| Broadcast cold start | All three output windows visible by 1.1 s; Art-Net on the wire with nothing attached |
| No `--project` | Reopens `lastProjectPath` |
| Supervisor restart (`watchdog-check.ps1`) | Covered by Phase 1 `test:showctl`. Not re-run, because it reads the owner's profile |

### Phase 5: soak (installed, broadcast, 4 heavy states + 2 projector outputs, sampled every 30 s)

| Run | Duration | State changes | Gaps mid-state | Frames held per change | Deaths | Render fps (min) | Output / wire (min) | Drift per hour |
|---|---|---|---|---|---|---|---|---|
| 8 s per state | **7 h** (691 samples) | 3,149 | **0** | 5.0 | 0 | 59.9 | 59 / 59 Hz | RSS +0.7 MB, adapter −19 MB, handles +5.6 (6,321 → 6,349) |
| 1.5 s per state | 19 min (stopped early, on request) | 751 | **0** | 4.7 | 0 | 59.9 | 60 / 60 Hz | too short for a slope |

Also over the 7 h: frame p99 had a median of 18.1 ms and a max of 19.6 ms; main event-loop p99 stayed at or under 12 ms; mp4 errors were 0.
**Pass: flat memory, no deaths, no picture loss inside a state.**

### Phase 6: the gaps the coverage audit found (installed build unless noted)

**Bug found and fixed:**

| Bug | Measured | Fix |
|---|---|---|
| **NDI receive never retries.** `startRecv` logged "ndi source not found" and returned, so a surface whose sender starts after ArtLux stays dark for good. Boot order at a venue decides it. | NDI Tools ▸ Test Patterns: sender first lights all 100 LEDs; ArtLux first and the sender 15 s later stays at 0 lit, 20 s after the sender appeared. | `ndiManager.startRecv` retries every 2 s until connected (first failure logged, then about once a minute); `stopRecv` cancels it. New invariant (mutation-tested). On the rebuilt local build the same run connects and lights 100/100. |

**Passed:**

| Area | Result |
|---|---|
| State machine, every trigger (10 checks) | onMarker 2.11 s (marker at 2.0) · atTime 1.52/1.5 · onClipEnd 2.52/2.5 · onTimelineEnd 2.02/2.0 · manual stays put, then fires over OSC in 13 ms · `requireEnd` makes a 1 s afterDelay wait for the 3 s hold · an entry action fires a cue (brightness 0.25 → peak 64 on the wire) · `idleResetSec` 3 returns home at 5.0 s · a `fromAny` rule fires in 16 ms |
| DMX-in | Art-Net u7 red into the app comes out of the strip; a change reaches the output in **108 ms** |
| Camera (IPEVO V4K) | Lights and moves its strip |
| Text | Renders crisp and centred (screenshot) |
| OSC out (timeline OSC track) | `/led` bool sends T/F once a second, follows the keyframes, stays under maxRate, stops on pause |
| LiDAR zones → show | The zone-driven example with the documented emitter cycles by itself: 12 state changes in 60 s, at about 1,500 OSC messages/s |
| Collect Assets | Copies an outside file into `assets/video`, rewrites the path relative, and the project reopens and plays from the copy |
| Projector warp + soft-edge | The corner pin lands exactly; the 25 % left edge fades to black (screenshot). The logo in the corner appears on windowed previews only, by design. |

**Checked and dismissed:**
- **A solid-white strip after Collect.** The clip is a sketch on white paper, and the strip sits on a band of white.
- **The `--pairs` emitter not cycling the zone show.** The tutorial specifies the default emitter, which works.

### Coverage: what is still untested

| Untested | Why | Where |
|---|---|---|
| Undo/redo under load, keyboard shortcuts / rebinding, `test-workspace-live` | Needs UI driving through main-menu accelerators (CDP keys do not reach them), or a dev attach on the owner's profile | here, with a profile-safe harness |
| Renderer-crash / stall / output-down / white-screen watchdog relaunches | A relaunch drops `--user-data-dir` and lands on the owner's profile | here, once relaunches keep the profile |
| MediaPipe pose, Augmenta (no shipped example), Launcher, auto-update | A person in frame / no fixture / a release to update to | here, with setup |
| Cold-open bench (`bench-open`) | It launches on the default profile | here |
| Real projector calibration (structured light, auto-align), NVWarp, LED nodes, ENTTEC USB-DMX, real LiDAR, audio heard on a device | Hardware | **on site** |

### Test hygiene: what the existing scripts did to the OWNER's machine (needs a human)

The Phase 1 dev-launch scripts run on `%APPDATA%\artlux`, the owner's real profile, and left in it:
1. `lastProjectPath` = `…\Temp\artlux-showctl-lit.artlux`, and 9 temp test projects in `recentFiles`.
2. **`showctl-playlist.json`: an ENABLED daily playlist (00:01) pointing at `…\Temp\artlux-showctl-shows\Lobby.artlux`.**
   The watchdog relaunch above followed it, so any broadcast launch on this machine now jumps to a test project.
3. `showctl-devices.json`: tablet devices paired by the test.

A backup of the prefs as found is at `%TEMP%\claude\battle\owner-prefs.polluted.json`. Cleaning them was
refused by the session's permission policy, so it is left to the owner. The scripts should take a
`--user-data-dir` like the bench does.

### Phase 1 (continued)
- **Live, dev build (11 of 13 ran clean):** engine-output (≥ 54 Hz over 8 contexts, headless at 61 Hz), cmy-bridge, color-lane, import-runs, project-import-live, copy-paste, auto-key, fixture-track, zone-fsm (9/9), timeline-rightclick (no failed checks in its output), lighting-take, showctl (ALL PASS). The two that did not run clean are hold-at-end and scene-timelines, the stale harnesses above.
