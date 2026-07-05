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
| Detects | renderer crash, GPU crash, unresponsive window, frozen render loop, sustained output loss | the whole process gone (hard crash / reboot) |
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
| `renderStallSec` | `10` | relaunch after no render heartbeat / unresponsive this long |
| `minRelaunchGapSec` | `30` | debounce between relaunch decisions |
| `maxRelaunchesPerHour` | `6` | circuit breaker |
| `always` | `false` | arm outside `--broadcast` too |

## Audit — persistent event log

Every detection + recovery is appended as JSONL to `userData/artlux-watchdog.log` and kept in a memory
ring that is **tailed on boot**, so the previous run's final events (i.e. *why it just restarted*) survive
into the new process. The tail shows in:

- **Preferences → Unattended / Watchdog** (in-app), and
- the **tablet Metrics tab** (forwarded through show-control's metrics SSE stream — the watchdog is core,
  so disabling the remote loses only the display, never the log).

## Verifying

Drive the real app (no unit runner — see [DEVELOPMENT.md](DEVELOPMENT.md)). Launch
`--broadcast --project=<test>` with the watchdog enabled and:

- force a renderer crash (`webContents.forcefullyCrashRenderer()`) → relaunches into the same project;
- kill the GPU process → `child-process-gone` recovery;
- block the Stage tick → `render-stall` fires after `renderStallSec`;
- stop the output engine → `output-down` recovery;
- force repeated crashes → breaker trips after `maxRelaunchesPerHour`, writes the marker, stops;
- launch twice → the second instance focuses the first and exits;
- install the task, kill `ArtLux.exe`, confirm relaunch within ~1 min, uninstall cleanly.
