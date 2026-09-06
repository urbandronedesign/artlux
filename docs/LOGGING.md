# Machine logging

Every ArtLux install keeps a plain-text record of what it did: what the machine is, how long a project
took to open, which video cost that time, and everything that failed. It is on by default and needs no
setup.

It exists for one situation — the one where a venue machine misbehaves and nobody was watching. "It
worked last week" is not evidence; this is.

## Where the files are

**On the machine** — this is the copy that always exists:

```
%APPDATA%\artlux\logs\artlux-<date>-<n>.log
```

**One file is one run of the app** — it opens the moment ArtLux starts and closes when it exits, and
everything that happened in between is in it. Each run gets its own file; nothing is ever interleaved.

Fifty runs are kept, nothing older than 30 days, and never more than 256 MB in total — whichever limit
runs out first.

**In the project folder** — the same session again, so a show folder carries its own history. The
project opens later than the app does, so everything from before that point is copied in first: this
file is a complete run too, not a fragment starting mid-way.

```
<your project>\logs\<machine-name>-<date>-<time>.log
```

⚠ **A project folder is portable.** If you copy a show to another machine or hand it to someone, these
logs go with it — including this machine's name, its network addresses, and the paths to your media.
Set `"projectSink": false` (see **Settings** below) if that matters for a particular show.

If the project lives on a USB stick or a network share and that share disappears mid-show, ArtLux stops
writing there, carries on, and records the fact in the machine copy. It never waits for a dead disk.

## Reading one

Each line is one event, written as JSON so it can be searched by script. It opens in Notepad as-is, and
`npm run logs:render` prints it as aligned text if you would rather read than grep — it also filters
(`--level warn`, `--cat media`, `--run r7`).

The lines worth knowing:

| Line | What it tells you |
|---|---|
| `session.start` | **Always the first line.** A run began — version, mode, and which project. |
| `session.end` | **The last line of a healthy file.** How the run ended, and how long it lasted. |
| `session.incomplete` | The *previous* run never wrote `session.end` — it crashed, was killed, or relaunched. Names the file. |
| `config.snapshot` | **The full machine spec** — see below. |
| **`config.changed`** | **What changed since the last run.** Only appears when something did. |
| `project.read` | Opening the file: bytes, read/parse/resolve times, scene and clip counts. |
| `open.trace` | Where the open spent its time, phase by phase. |
| **`open.armed`** | **Why the show started when it did** — and, if it timed out, exactly which items never became ready. |
| `media.probe` / `media.load` | Per video: how long identifying and opening it took. |
| `media.ready` | Which asset the show waited on longest, sorted worst-first. |
| `output.down` / `output.up` | Art-Net stopped, and came back — with how long the gap was. |
| `fault.*`, `watchdog.*` | A crash, a white screen, an automatic relaunch. |

### What `config.snapshot` records

Written once per run, before any project loads — so a machine that cannot open a show still says what
it is.

| | |
|---|---|
| **OS** | Name (*Windows 11 Pro*), build number, **architecture** (x64 / arm64), machine uptime, **timezone and locale** |
| **CPU** | Model, core count, clock |
| **Memory** | Total and free |
| **GPU** | **Every adapter**, each with its **driver version**, and which one is active |
| **Displays** | Resolution, position, scale factor, **refresh rate**, colour depth, rotation, which is primary |
| **Network** | Every IPv4 interface — name, address, MAC |
| **Storage** | Free space on the system disk, and on the project's own volume once one is open |
| **ArtLux** | Version, Electron and Chromium builds, and every native module and plugin with its load time and whether it loaded |

Four of those are here for reasons specific to this app:

- **Architecture** decides whether the native modules load at all — Art-Net output, NDI, Spout, HAP,
  calibration and NVAPI warp are every one of them native.
- **Every GPU adapter**, not only the active one: a venue PC usually has an integrated chip *and* a
  discrete card, and it is the discrete card that decides whether hardware warp/blend is available.
- **Refresh rate per display** explains a whole class of "it looks different on that output" — a
  projector locked to 60 Hz beside a 144 Hz monitor.
- **Timezone**, because the scheduler and the playlist run on the wall clock. A machine set to the wrong
  zone runs the right show at the wrong hour, and nothing else in any log would show it.

### The two lines to look at first

**`config.changed`** answers the most common question there is. It appears only when the machine moved
under the app, and it names the field:

```json
{"ev":"config.changed","lv":"warn","d":{"count":1,"gpu.driverVersion":["566.36","572.16"]}}
```

A driver that updated itself overnight, or a projector that was replugged and had its display renumbered,
both show up here as one line — and both are common causes of "it worked last week".

**`open.armed`** answers "why did the show open on black":

```json
{"ev":"open.armed","lv":"error","d":{"elapsedSec":15,"timedOut":true,"pendingCount":8,
 "pending":["clip-04.mp4 (mp4-webcodecs)", "…"]}}
```

`timedOut: true` means the wait ran out and the show started anyway, with those items still missing.
Pair it with `media.ready` to see which file was slowest.

## Settings

⚠ **There is no Preferences panel for this yet.** Settings live in the machine's preferences file, and
ArtLux must be closed while you edit it:

```
%APPDATA%\artlux\artlux-prefs.json
```

Add a `"logging"` block. Every key is optional; the values below are the defaults:

```json
"logging": {
  "enabled": true,
  "level": "info",
  "projectSink": true,
  "maxFileMB": 32,
  "maxFiles": 50,
  "maxAgeDays": 30,
  "maxTotalMB": 256,
  "sessionKeep": 50
}
```

- **`level`** — `info` records configuration, timings, media and everything that failed. `debug` adds
  operator actions (every change to the document) and internal detail; a busy session at `debug` writes
  considerably more. `warn` records only problems.
- **`projectSink`** — set to `false` to stop writing into the project folder. See the warning above.
- **`maxFileMB`** — a ceiling on ONE run's file. A run that reaches it is marked `log.truncated` and
  stops being recorded, rather than being split across two files — one file is always one run.
- **`categories`** — optional per-area overrides, to turn one area up without raising the whole log:
  `"categories": { "media": "debug" }`.

Turning logging off entirely is possible but rarely what you want: it costs almost nothing to leave on,
and it is only useful for the day *after* something went wrong.

### Did the last run end cleanly?

Look at the last line. `session.end` means it exited normally. Anything else means the run died — a
crash, a kill, or an automatic relaunch — and the next run says so explicitly with `session.incomplete`,
naming the file. An unattended machine that keeps relaunching leaves a trail of files that never reached
`session.end`, which is the shape of a problem worth chasing.

## Sending one to someone

Attach the newest file from the machine log folder shown at the top of this page.

⚠ **Read it first if the machine is on a network you would rather not describe.** It contains
this machine's name, **its IP and MAC addresses**, the addresses it sends Art-Net to, and the full
paths to your media. That is deliberate — those are the fields that make a network fault
diagnosable — but they are also the fields you would not want in a public issue tracker.

Passwords and the show-control PIN are never written, at any level.

## What it costs

Nothing you can measure. Records are written in batches once a second regardless of how much happens,
and the frame loop is never involved — logging cannot slow the show down or make output stutter, by
design. A venue night is typically a few hundred kilobytes.

## Related

- [WATCHDOG.md](WATCHDOG.md) — automatic recovery on an unattended machine; its events appear in this log.
- [MONITORING.md](MONITORING.md) — live metrics over the network, which answers "how is it doing right
  now" where this answers "what happened".
