# 2026-10-24 — session record: v0.33.8 → v0.33.11, the battle test, and GPU-crash recovery

> **Status:** Record (closed session). Written for two readers: the owner, and the next Claude session
> on this machine. Measurements are from the RTX test box (RTX 5090, Windows 11, Electron 42.4.1).
> The detailed campaign log, phase by phase, is [battle-test-v0.33.8.md](battle-test-v0.33.8.md); this
> page is the summary and the hand-over.

## How it started, and where it went

1. **"Add 4 states with a video each and switch between them."** The flicker the owner saw was the
   preloader taking over the MP4 decoder of the track on screen → **v0.33.8**.
2. **"Extensive tests, a very serious battle-testing strategy."** Six phases on the installed build:
   every existing script, a feature matrix, fault injection, lifecycle with no CDP, and a 7 h soak.
   Then a coverage audit, and a Phase 6 for the gaps it found.
3. **The top finding:** a GPU-process crash froze the LEDs and blacked out the projectors **for good**,
   with every health metric green. That was fixed in two releases: the LEDs and projectors in
   **v0.33.9**, then every other GPU consumer plus a watchdog that recovers in place in **v0.33.10**.
4. **Re-testing the installed v0.33.10** found "Send as NDI" dead on windowed outputs → **v0.33.11**.
   Installed and verified.

## What shipped

| Commit | What |
|---|---|
| `2600747` → `f155504` **v0.33.8** | **MP4 flicker between states.** Layer decoders are keyed by track id alone, and states share track ids (Capture Scene clones them). The preloader's 250 ms top-up warmed each standby state's file through two doors (`preWarmLayer`, `preRoll`), which closed the decoder on screen, so the picture dropped every 250 ms and showed the previous state's frame. The warm doors now skip a decoder read in the last second. Result: 0 mid-state gaps over 31 changes. A state change still holds about 5 frames at the cut; per-state decoders were assessed and **declined** (cost unmeasured, and HAP-style sharing is cheaper). |
| `ca9c2b3` | **A lighting lane was treated as a video.** It is the only core lane kind and was never registered, so the boot gate waited 15 s for a `<video>` with `path: ''` on every project that opens on a lighting take. |
| `7528d97` | **NDI receive never retried.** A sender that started after ArtLux was never picked up. It now retries every 2 s. |
| `499c283` | `test:blend` / `test:recal` had failed to compile since July (`.ts` imports, React default import). |
| `2b03ff9` | The battle-test plan ([battle-test-v0.33.8.md](battle-test-v0.33.8.md)). |
| `f0150f4` → `148bff0` **v0.33.9** | **A GPU crash froze the LEDs for good.** `WebGPUMapper` had no `device.lost` handling: every read-back failed into a silent catch, so the output repeated one frame forever. Now the mapper rebuilds on a new device (about 0.5 s), `app.disableDomainBlockingFor3DAPIs()` keeps Chromium from blocking WebGPU/WebGL after the **second** crash, projectors reload on `webglcontextlost`, and main bridges a projector on **every** load (it was `once`). The loss is reported in the heartbeat as `artlux_gpu_device_lost`, a red Stage banner, and a watchdog relaunch after 15 s unrecovered. `relaunchArgs()` keeps `--user-data-dir`. |
| `48e40bb` | **The rest of the GPU consumers.** HAP (`isLost()` → rebuild; a failed construction is retried, no longer cached forever), the three tracking overlays, text (cache dropped on the new SDK `GPU_LOST_EVENT` / `onGpuLost`), and the 3D view (keyed `<Canvas>` remount once visible). |
| `4bf8b11` → `b41a6ca` **v0.33.10** | **The watchdog recovers in place.** A GPU crash is logged (`gpu-gone → recovering in place`) and no longer relaunches immediately; it relaunches only via `gpu-device-lost`, render-stall or output-down. |
| `960487f` → `a1aac85` **v0.33.11** | **"Send as NDI" never sent from a windowed output.** The NDI reconcile ignored `WINDOWED_DISPLAY`, which the projector reconcile accepts. |

Six new `verify:invariants` checks (206 total), each mutation-tested: warm doors on a live decoder, the
lighting kind, NDI retry, GPU-loss recovery (all parts), the watchdog not relaunching on `gpu-gone`, and
the NDI windowed liveness. Docs updated: WATCHDOG.md, MONITORING.md, CHANGELOG for each release.
**v0.33.11 is installed on this machine.**

## The headline numbers

| | Before | After |
|---|---|---|
| LEDs after 1 GPU crash | frozen 59 of 60 s | recovered in 0.5–0.66 s |
| 2 crashes in a row | (never recovered from the first) | 0.52 s, 0.44 s |
| HAP-Q/Alpha, text, tracking, 3D, projectors after a crash | black for good | all back; all ten consumers pass, three times on the installed v0.33.10 |
| 7 h soak (v0.33.8, 4 heavy states, broadcast) | — | 3,149 changes, **0 mid-state gaps**, 0 deaths, fps ≥ 59.9, RSS +0.7 MB/h |
| Project opening on a lighting take | starts 15 s late | starts at once |

## Needs the owner

| Item | What to do |
|---|---|
| **Test data left in your real profile** (`%APPDATA%\artlux`) by the repo's dev-launch test scripts | Delete or disable **`showctl-playlist.json`** (an ENABLED daily playlist pointing at `…\Temp\artlux-showctl-shows\Lobby.artlux`; any broadcast launch follows it). Delete `showctl-devices.json` (test tablets). Fix `lastProjectPath` (a deleted temp file) and the 9 temp recent files in `artlux-prefs.json`. A backup as found is at `%TEMP%\claude\battle\owner-prefs.polluted.json`. I was not permitted to edit it. |
| **Installers are unsigned** | `Get-AuthenticodeSignature` reports NotSigned for v0.33.8–.11 alike. Not new; noted. |

## Still open

| Item | Notes |
|---|---|
| **The dev-launch test scripts write to the owner's profile** | That's why the profile above needs cleaning. They should take a `--user-data-dir` like the bench does. |
| **A known-failed file still holds the boot gate 15 s** | `missing.mp4` is logged "missing" at 1.4 s, but the gate times out at 15 s. It should count a decided failure as ready (HAP's `preRoll` already does). |
| **Stale or weak scripts** | `test-hold-at-end` (looks for a "Time" rail label that's gone) and `test-scene-timelines` (attaches before the startup navigation). Both behaviours were re-tested on the installed build and pass. `test-timeline-rightclick` always exits 0. `test-lighting-take` steps 4–5 are known red. |
| **The battle harness lives in `%TEMP%\claude\battle`** | It may be wiped. `gpuall.mjs`, `outtest.mjs`, `smtest.mjs`, `inputs.mjs`, `nditest.mjs`, `badmedia.mjs`, `lifecycle.mjs`, `soak.mjs` are worth promoting to `scripts/`. They take `BATTLE`, `ARTLUX_EXE/PRE/CWD`, `ARTLUX_ARGS`. |
| **No soak on the GPU-recovery builds** | The 7 h soak was on v0.33.8. An overnight run on v0.33.11 would cover the new code paths. |
| **Untested areas** | Undo/redo, shortcuts, `test-workspace-live`, the watchdog's renderer-crash / stall / output-down / white-screen relaunches (now testable, since relaunches keep the profile), MediaPipe, Augmenta, Launcher, auto-update, `bench-open`. On site only: real calibration, NVWarp, LED nodes, USB-DMX, LiDAR, hearing the audio. |
| **A state change holds about 5 frames** | This is between states that share a track id. Per-state decoders were declined for now (see v0.33.8 above). |
| From [2026-10-23](2026-10-23-session-record.md) | SPOUT.md engine-rate claim · an editor renderer death is not logged when the watchdog is unarmed · `artlux_render_fps` stays stale after a renderer death · residency steps 4–5 · MP4 filmstrips blank while playing · `package-lock.json` still says 0.29.0 · launcher retention never run for real. |

## Retracted: things I said this session that were wrong

- **"OSC input is dead."** Git Bash rewrote `/artlux/transport/pause` into `C:/Program Files/Git/artlux/…`.
  Traced into main's socket with `--inspect`; with `MSYS_NO_PATHCONV=1` OSC works. (The trap was already
  in the 10-23 record and still cost an hour.)
- **"The render rate follows the timeline fps."** The engine renders at `AppSettings.engineFps`, default
  **30**. The owner's profile sets 60.
- **"The 3D view shares the LED mapper's device."** Sharing is an opt-in flag; by default three builds its
  own WebGPU device. (It still needed its own recovery, now done.)
- **"MP4 and HAP-Q recover slowly after a crash."** That clip is a line sketch on white; on a
  constant-motion clip both run at 24/s before and after.
- **"Solid white after Collect Assets."** Same sketch clip: the strip sat on white paper.

## Testing on this machine: new recipes and traps (on top of the 10-23 list)

- **The bench:** the installed `C:\Program Files\ArtLux\ArtLux.exe` with
  `--user-data-dir=%TEMP%\claude\battle\profile` (OSC enabled on 127.0.0.1, engineFps 60) and
  `ARTLUX_CDP_PORT=9333`. A local build: `node_modules/electron/dist/electron.exe .` with the same flags.
- **Installing a release** needs the owner to approve the **UAC prompt**; two attempts were cancelled
  while nobody was at the screen. Recipe: `gh release download vX -p "ArtLux-X-x64.exe"`, then
  `Start-Process … -ArgumentList '/S' -Wait`.
- **Never pass an OSC address through Git Bash** without `MSYS_NO_PATHCONV=1`; or build the packet in JS.
- **With a DMX-in surface the app owns 6454**, so a listener there hears nothing. Send the output as
  **sACN multicast** and join `239.255.0.x` from the listener.
- **A watchdog relaunch dropped `--user-data-dir`** (fixed in v0.33.9). Before the fix, an armed test on
  the scratch profile relaunched onto the owner's profile and followed its stale playlist. Keep
  Unattended **off** in the scratch profile unless a test needs it.
- **Don't build a path with `$PWD` after `cd` into the repo**: a stray `profile/` landed in the repo root
  once (removed).
- **Test media:**
  - HAP / HAP-Q / HAP-Alpha clips are encoded with `E:\zaki\360Gaussian-1.2.0\_internal\bin\ffmpeg.exe`
    (`-c:v hap -format hap|hap_q|hap_alpha`).
  - NDI source: `C:\Program Files\NDI\NDI 6 Tools\Test Patterns\Application.Network.TestPatterns.exe`.
  - Spout: `Desktop\SPOUT-2007\DEMO\SpoutSender.exe`.
  - Camera: the IPEVO V4K.
- **GPU crash on demand:** CDP `Browser.crashGpuProcess` on `/json/version`'s endpoint. After the second
  one, Chromium used to block 3D for the page; that's now prevented by `disableDomainBlockingFor3DAPIs`.
- **Judge "is the picture alive" on the wire** (payload changes per second per universe), not on
  `render_fps` / `output_fps`. Both read 60 through a frozen picture. Use a clip with constant motion.
- **Main-process inspection:** the local build accepts `--inspect=9230`; `process._getActiveHandles()`
  finds the OSC socket.

## Where things are

| What | Where |
|---|---|
| The campaign, phase by phase, with every table | [battle-test-v0.33.8.md](battle-test-v0.33.8.md) |
| GPU-loss recovery | `frameEngine.recoverFromDeviceLoss`, `WebGPUMapper.onDeviceLost`, `hapGL.uploadFrame`, `*Drawable.getGL`, `textRaster` (`onGpuLost`), `Simulator3D` (`glEpoch`), `ProjectorApp` (`webglcontextlost`), `projector.ts` (bridge on every load), `watchdog.ts` (`gpu-gone`, `gpu-device-lost`) |
| Operator docs changed | [WATCHDOG.md](../docs/WATCHDOG.md), [MONITORING.md](../docs/MONITORING.md), [CHANGELOG.md](../CHANGELOG.md) |
| Harness + logs (scratch, may be wiped) | `%TEMP%\claude\battle\` (scripts, `out/`, `profile/`, `media/`) |
| Previous sessions | [2026-10-23](2026-10-23-session-record.md), [2026-10-22](2026-10-22-session-record.md) |
