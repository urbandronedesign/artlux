# Watchdog — unattended self-healing

ArtLux is often run **unattended**: a broadcast/show install that drives fullscreen projectors and
Art-Net for days with nobody watching (see [SHOW-CONTROL.md](SHOW-CONTROL.md) for the playlist + tablet
remote). The watchdog keeps that show alive without a human: it detects the ways a show goes dark and
recovers automatically, and gives up cleanly (rather than thrashing) when a fault is persistent.

It is **off by default** and only arms in `--broadcast` mode, so it never surprises a developer in the
editor.

## Two tiers

| | Tier 1 — in-app | Tier 2 — OS supervisor |
|---|---|---|
| Where | main process ([src/main/watchdog.ts](../src/main/watchdog.ts)) | Windows Scheduled Task |
| Detects | renderer crash, GPU crash, unresponsive window, frozen render loop, **an uncaught UI error (the white screen)**, sustained output loss | the whole process gone (hard crash / reboot) |
| Latency | seconds | ~1 minute |
| Action | full relaunch into `--broadcast --project=…` | same, if the app isn't running |

Tier 1 can't recover once its own process is dead — that's Tier 2's job. A **single-instance lock**
([src/main/index.ts](../src/main/index.ts)) keeps the two from ever running two copies.

## Tier 1 — detection

Armed when `Prefs.unattended.enabled` is set **and** the process is `--broadcast` (or `unattended.always`).

- **Renderer crash** — `webContents 'render-process-gone'` (skips a clean exit).
- **GPU crash** — `app 'child-process-gone'` with `type === 'GPU'`. WebGPU device loss is the classic
  silent show-killer.
- **Unresponsive window** — `'unresponsive'` held past `renderStallSec` (a `'responsive'` cancels it).
- **Frozen render loop** — no renderer heartbeat for `renderStallSec`. The heartbeat is the existing
  ~1 Hz `render:stats` IPC ([src/main/ipc.ts](../src/main/ipc.ts)); this catches a stalled compositor
  loop that never trips `'unresponsive'`.
- **Sustained output loss** — `output.getStats().fps` at 0 for `outputDownSec`, but only *after* the wire
  was live (so an unconfigured project never triggers it). Note the native pacer's keep-alive holds
  `fps > 0` through a mere renderer stall, so this fires only on genuine engine/socket death — the two
  detectors are complementary.
- **Uncaught UI error — the white screen.** See the section below; this one is not like the others.

## The white screen — why it needed its own detector

**The failure.** A single bad value in a project file can make the interface throw while it is drawing.
When that happens the whole UI unmounts and the window goes blank — but **the process stays alive, stays
responsive, and keeps its event loop turning.** Every other detector above is looking for something that
*stopped*, and nothing did: the process is running, the window answers, the GPU is fine, and because the
output engine's keep-alive keeps re-transmitting the last frame, **the rig holds its last look and the
wire still looks busy.** The projectors were the same lie — a video output froze on its final frame,
while a generative one carried on animating off its own clock and looked perfectly healthy.

So the venue showed a plausible picture, the console showed traffic, nothing alarmed, and nobody knew
until the client called. **The install was dead, silent, and invisible to every tier — indefinitely.**

**What happens now.** Three changes, and each one covers the others' blind spot:

- **The UI reports its own crashes.** Every window (editor, projector, docs, splash) catches uncaught
  errors and tells the main process. Each one is written to the audit log below — **always, even with
  the watchdog switched off**, which is how an editor install gets a record too. In an armed broadcast
  install, a crash that took the whole UI triggers the normal relaunch + circuit breaker.
- **A UI that never appears is now a fault.** `render-stall` previously needed the interface to have run
  at least once before it would arm — so a project that crashed *while opening* was never detected at
  all. The clock now starts when the window finishes loading, so a UI that never draws its first frame
  is treated exactly like one that stopped drawing. This works even if the crash-reporting path is
  itself what broke.
- **A projector tells the truth.** If the main window stops sending for ~5 s, each projector goes
  **black and re-shows its "Waiting for the main window…" caption** instead of holding a frozen frame or
  animating over a dead show. ⚠ **A venue that has unknowingly been running on a frozen frame will now
  visibly go dark.** That is the fault becoming legible, not a new fault.

Crash-on-load is the case this was built for, so it ends where every persistent fault ends: the
relaunches hit `maxRelaunchesPerHour`, the **breaker trips**, and the install stays down — but now as a
**dark install that alarmed, wrote an audit trail, and reads `breaker tripped`** in Preferences and on
the tablet. That is the whole point: the venue is never *silently* dead.

## Safe Mode — the operator's way out

The unattended install relaunches. An operator at the keyboard gets a different recovery, because
relaunching into the same broken project just repeats it.

A crash that takes the whole interface shows a recovery screen with the error and a **Reload** button.
If the *same project* fails to open **twice**, the app offers **Start in Safe Mode** instead — and
Safe Mode is the rung that ends the loop:

- it opens **empty**, with the **default workspace layout**;
- it does **not** reopen the last project (that autoload is the trap — a project that crashes on load
  reopens itself at every launch, and the app is unusable until someone edits settings by hand);
- **your project file on disk is not modified.** Nothing in this path writes a project.

The path stays in **File ▸ Open Recent**, so retrying it once it is fixed is one click.

A crashed *panel* is not this: panels are contained individually, so one shows a small recovery card
while the rest of the app — and the output — keeps running.

## Recovery — a full relaunch (not a reload)

Recovery reuses the proven, leak-safe pattern from the playlist scheduler: `app.relaunch()` + `exit(0)`
into `--broadcast --project=<current>`. A fresh process avoids the media-cache / decode-pool / undo-history
leaks that an in-place `applyProjectData` would accumulate over days (same rationale as
[SHOW-CONTROL.md](SHOW-CONTROL.md#L70) relaunch-per-project). Each relaunch releases the single-instance
lock first so the incoming process reclaims it without racing the guard.

## Crash-loop circuit breaker

Without a cap, a crash-on-launch would relaunch forever. The breaker persists relaunch timestamps in
`userData/artlux-watchdog-state.json` (survives the relaunch) and, once `maxRelaunchesPerHour` is reached
in a rolling hour, **stops** and writes `userData/artlux-watchdog-tripped.flag`. Leaving the show down
beats an infinite storm — and Tier-2 honors the same marker, so it stands down too. The breaker
self-clears on a stable start (no relaunches in the last hour), or on **Remove OS task** in Preferences,
or by deleting the flag file.

## Tier 2 — Windows Scheduled Task

Registered by [scripts/install-watchdog-task.ps1](../scripts/install-watchdog-task.ps1) (self-elevates via
UAC). It runs **at logon** and **every minute**; the action
[scripts/watchdog-check.ps1](../scripts/watchdog-check.ps1) relaunches ArtLux into broadcast on the
configured project **only if** the process is gone and the tripped marker is absent. Remove it with
[scripts/uninstall-watchdog-task.ps1](../scripts/uninstall-watchdog-task.ps1). Install/remove from
**Preferences → Unattended / Watchdog** (buttons shell out to these scripts; the scripts ship as packaged
`extraResources`). Windows-only.

## Configuration — `Prefs.unattended`

Persisted in `artlux-prefs.json` ([shared/protocol.ts](../shared/protocol.ts) `UnattendedPrefs`); edited in
**Preferences → Unattended / Watchdog**. Changes take effect on the next launch/relaunch (the watchdog
arms + attaches its detectors at process start).

| field | default | meaning |
|---|---|---|
| `enabled` | `false` | master on/off |
| `crashRecovery` | `true` | Tier-1 crash/hang/GPU recovery |
| `outputDownSec` | `15` | relaunch after output down this long (post-live) |
| `renderStallSec` | `10` | relaunch after no render heartbeat / unresponsive this long. **Booting gets longer**: a freshly-loaded project has `max(renderStallSec, 30 s)` to draw its first frame, because a cold start (plugin activation, a project read off a network share, a first-run shader compile) is a different question from a frame loop that froze mid-show. Raising this raises the boot allowance with it. |
| `minRelaunchGapSec` | `30` | minimum gap between successive relaunches. The **first** relaunch after a stable run is never delayed; a 2nd+ relaunch inside the gap is **deferred** (not dropped) until the gap elapses, logging a `skipped-debounce` audit event. `0` disables pacing. |
| `maxRelaunchesPerHour` | `6` | circuit breaker |
| `always` | `false` | arm outside `--broadcast` too |

## Audit — persistent event log

Every detection + recovery is appended as JSONL to `userData/artlux-watchdog.log` and kept in a memory
ring that is **tailed on boot**, so the previous run's final events (i.e. *why it just restarted*) survive
into the new process. A **refusal is logged once, not once per detection** — the detectors re-fire every
second and the faults that reach a refusal are by definition the ones that persist, so both the pacing
refusal (`skipped-debounce`) and the breaker refusal (`skipped-tripped`) would otherwise write a line
per second into a log that is only ever trimmed at boot, on an install that has stopped rebooting. UI crashes (`renderer-fault`) are logged **even when the watchdog is disabled** —
on an editor install this file is the only durable record that the app white-screened at all, and it
names the project that was open, whether it had drawn a frame yet, and the plugin at fault if there was
one. The tail shows in:

- **Preferences → Unattended / Watchdog** (in-app), and
- the **tablet Metrics tab** (forwarded through show-control's metrics SSE stream — the watchdog is core,
  so disabling the remote loses only the display, never the log).

## Verifying

Drive the real app (no unit runner — see [DEVELOPMENT.md](DEVELOPMENT.md)). Launch
`--broadcast --project=<test>` with the watchdog enabled and:

- force a renderer crash (`webContents.forcefullyCrashRenderer()`) → relaunches into the same project;
- **the white screen** — hand-edit a copy of a project into something the UI cannot draw, then launch
  broadcast on it. Expect a relaunch after the boot grace, a `renderer-fault` **and** a `render-stall`
  line in the log, and the breaker tripping after `maxRelaunchesPerHour` (set it to `2` for the test).
  **Before this existed the same test produced nothing, forever — that delta is the point.** Open the
  same file in the editor instead and expect the recovery screen, then Safe Mode on the second attempt,
  with the project file byte-identical on disk afterwards;
- **boot grace / no false positive** — launch broadcast on the *largest* real project with the watchdog
  armed at defaults. Expect **no relaunch**. If a slow cold start is being killed, raise `renderStallSec`;
- **projector truth** — with a projector on a video surface, stop the main window from sending. Expect
  the output to go black with its caption within ~5 s, not to hold a frozen frame;
- kill the GPU process → `child-process-gone` recovery;
- block the Stage tick → `render-stall` fires after `renderStallSec`;
- stop the output engine → `output-down` recovery;
- force repeated crashes → breaker trips after `maxRelaunchesPerHour`, writes the marker, stops;
- launch twice → the second instance focuses the first and exits;
- install the task, kill `ArtLux.exe`, confirm relaunch within ~1 min, uninstall cleanly.
