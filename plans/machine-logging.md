# Machine logging — config, timings, errors and actions, per install

> **Deliverable:** this document. **Status:** ⬜ **PROPOSED — nothing built.** Written 2026-09-06; **re-scoped
> the same day** from "action logging" to the four things actually wanted — **machine configuration,
> loading timings, errors, and video-load timings** — with operator actions demoted to one family among
> five (§5.E). · **Placement:** **Core** (new `src/main/logger.ts` + `src/main/machineInfo.ts` +
> `src/renderer/services/log.ts`, one IPC channel, a handful of taps, one prefs block, one SDK field) ·
> **Risk:** 🟢 Low overall — every work package is independently revertible and nothing changes existing
> behaviour · **Breaking changes:** none to the `.artlux` schema; **additive** to `Prefs` and to the
> renderer plugin context · **Blocked on:** the decisions in §11.

## 0. The answer in three lines

**Possible: yes, and more of it exists than expected** — `openTrace`, `bootReport`, `bootGate` and
`perfMonitor` already measure most of the loading timings; they just have nowhere durable to go (§1).
**Perf: no measurable cost, if one boundary holds** — nothing at frame rate (§2). **The disk is the real
hazard, and it comes from the words "in the project folder"** — a venue project folder can be a USB stick
or an SMB share, so the project sink must be *best-effort* and the local sink the sink of record (§4).

**The one genuinely missing measurement is per-asset video load time** (§5.C). Nothing in
`surfaceMedia`, `contentSource`, `timelinePreloader` or `mediaCache` calls `performance.now()` — I
checked. We know from the boot-chip work that HAP probing can eat **3.2 s** of an open, and today
nothing records *which file* spent it.

## 1. What already exists — do not rebuild it

Most of the "loading timings" ask is already instrumented. It ends up in `console.log`, which means it
is visible to a developer with DevTools open and to nobody else, ever.

| Exists | What it already gives us | Gap |
|---|---|---|
| [`src/renderer/services/openTrace.ts`](src/renderer/services/openTrace.ts) | **Named phase timings across the whole cold open** — parse, apply, per-scene normalize, warm issuance, swap, gate-armed. Already emits one machine-parseable line at gate release. | Console only. Nothing durable, nothing per-machine. |
| [`src/main/bootReport.ts`](src/main/bootReport.ts) | Per-native and per-plugin **load duration** — `BootEntry.ms` — plus state and a failure phrase, across both processes. | Feeds the splash and then evaporates. |
| [`src/renderer/services/bootGate.ts`](src/renderer/services/bootGate.ts) | **Why the show started when it did**: elapsed, `timedOut`, what was still `pending`, and the release reason. It already logs at error level when it fails open. | Console only — so "the show opened on black" is not recoverable after the fact. |
| [`src/renderer/services/perfMonitor.ts`](src/renderer/services/perfMonitor.ts) | Frame p50/p99/max, in-frame work, long-frame count, GPU timing — already computed at 1 Hz for the HUD. | Sampled for display; never retained. |
| [`src/main/projector.ts:28`](src/main/projector.ts#L28) | **Display topology** as a structured `DisplayInfo[]` — id, label, bounds, scale factor, primary, internal. | Used for binding; never recorded, so a replug that changes a display id is invisible after the fact. |
| [`src/main/watchdog.ts:299`](src/main/watchdog.ts#L299) | A working **JSONL append + trim** to `userData/artlux-watchdog.log`. | Its own file, its own format, its own trim. Should merge into one stream. |
| [`src/renderer/services/faultReporter.ts`](src/renderer/services/faultReporter.ts) | Renderer faults (the white screen), rate-limited, written to run while the tree collapses. | Reaches the watchdog, not a log a human reads. |
| `plugins/hap` `getStats()` | `{asked, missed, missRate}` — **decode starvation**, two integer adds per frame. | Read by hand over CDP via `window.__artluxHapStats`. |
| [`src/main/metrics.ts`](src/main/metrics.ts) | Prometheus, per-instance labels. | Aggregates over time — **complementary to logs, not a substitute**. Keep both. |

**Genuinely missing, all four new:** machine hardware/driver configuration (no `getGPUInfo`, no
`os.cpus()`, no WebGPU adapter info anywhere in the tree), any notion of machine identity, per-asset
media load spans, and a durable sink for all of the above.

## 2. The performance contract

### 2.1 The numbers

⚠ Orders of magnitude for Electron IPC and NTFS appends. **Not measured in ArtLux.** WP-M (§7) measures
them before anything periodic or per-action lands; no number here is a fact until it does.

| Step | Estimated cost | Runs on |
|---|---|---|
| Build + summarize one record | 1–3 µs | originating process, main thread |
| Renderer→main IPC | 10–50 µs **per batch, not per event** | renderer main thread |
| Disk append | one syscall per flush window | main, async |

The frame budget is **16.6 ms** at 60 fps, **33 ms** at the default engine rate of 30.

**The four things asked for are structurally cheap, and it is worth being precise about why:**

| Family | Volume | Cost |
|---|---|---|
| Machine config | **once per boot** (+ a diff line when something changed) | irrelevant |
| Loading timings | **once per project open**, ~20–60 records | irrelevant |
| Video load spans | **once per asset per open**, ~20–200 records | irrelevant |
| Errors | rare by definition, and rate-limited | irrelevant |

Only two proposed families have a *rate*: the periodic health digest (§5.F.2, 1/min) and operator
actions (§5.E, ~20/s at the human ceiling). Both are clock-bounded by the 250 ms renderer batch and the
1 s flush, so they cost **4 sends/second and one write/second no matter how fast anything happens**.

### 2.2 The boundary — the thing that must not be crossed

**Nothing is logged at frame rate.** This is the whole perf story; everything else is rounding error.
The specific tripwires here, each of which would look reasonable to instrument:

- **`renderer/engine/frameEngine.ts`** — the entire point of `plans/engine-decoupling.md` was getting
  work *out* of that loop. One line per frame is a 30–60/s floor; per-fixture or per-universe is tens of
  thousands per second.
- **`pushProjectorBrightness`** — documented at [`EditorStore.tsx:159`](src/renderer/state/EditorStore.tsx#L159)
  as a *render-free live channel*: it fires at pointer rate (~120 Hz) **precisely to avoid** the cost a
  logger would re-introduce.
- **`services/livePreview.ts`, `dmxSignal.ts`, `fixtureSignal.ts`, `automationOverlay.ts`** — same class.
- **Decode statistics.** `hapDecode`'s counters are two integer adds *per frame* on purpose. Read them
  **on a timer**, never emit a record from the decode path.

The rule generalises: **sample rates, log edges.** A frame-time digest once a minute; an output-down
*transition*, never the 1 Hz output sample; a starvation *threshold crossing*, never a miss.

### 2.3 The trap that would actually kill it

**`setFixtures(next)`, `setSurfaces(next)` and `setStateMachine(sm)` take whole documents.** A generic
tap that does `JSON.stringify(args)` serializes the **entire rig on every call** — hundreds of KB, tens
of ms, on the renderer main thread, synchronously, inside a user gesture. That one naive line is the
difference between "free" and "the venue judders when you nudge a fixture."

So records are **small by construction, never truncated after the fact**: a per-action summarizer table
(default = arity + argument *kinds* + top-level `id` strings, never a deep clone), log **shape not
content** (`{"n":180}`, not 180 fixture objects), and a 1 KB serialized backstop. Guarded by §8.3.

### 2.4 The disk hazard

`appendFileSync` on main's main thread blocks it. Art-Net survives — the native Rust pacer runs on its
own thread with keep-alive — but IPC, the watchdog health timer, and anything the renderer awaits stall
behind it. And a venue project folder can be a **USB stick or an SMB share**, where an append is ~1–20 ms
nominal and can hang for *seconds* on a flaky link.

- **Never sync**, except in `before-quit`, where blocking is acceptable and correctness matters.
- One **kept-open `createWriteStream`** per sink, `flags: 'a'`.
- A **bounded queue** (4096 records): on overflow **drop oldest**, count, and emit one `log.dropped`
  carrying the count at the next flush. Never grow unbounded, never block, never `await` from a caller.
- **Stall detection per sink.** If a write callback has not returned in ~5 s, mark that sink *degraded*,
  stop feeding it, and record the fact **on the local sink**. A dead share costs one stalled write — not
  a growing buffer, not a hung app.

## 3. Architecture

### 3.1 One writer

Main owns the files; the editor renderer, every projector window and every plugin ship records over IPC.
Not a style choice — **N processes appending to one file interleaves and corrupts it**, and ArtLux
routinely runs main + editor + N projector windows.

```
editor renderer ─┐
projector win N ─┼─ log:event (array, ~250 ms batches, fire-and-forget .send) ─→ main
main-side code  ─┘                                                                │
                                                                      ┌───────────┴───────────┐
                                                              sink A: userData        sink B: <project>/logs/
                                                              (sink of record)        (best-effort, degradable)
```

New IPC constant in `shared/protocol.ts`, next to `RENDERER_FAULT`, which it neighbours conceptually:

```ts
/** Renderer → main: a batch of log records. Fire-and-forget; the logger must never make a caller wait. */
LOG_EVENT: 'log:event',
```

### 3.2 The record

One JSON object per line. This **is** a .txt file — opens in Notepad, `type`s in a terminal, survives
being emailed — while staying machine-queryable, which prose is not the moment the question becomes
"every video that took over a second to load on machine 3 last week."

```json
{"t":"2026-09-06T14:22:31.118Z","up":184213,"lv":"info","cat":"media","ev":"media.load","proc":"editor","run":"r7","seq":1841,"d":{"file":"loop_A.mov","codec":"hap","bytes":412000000,"probeMs":840,"openMs":22,"firstFrameMs":190,"totalMs":1052}}
```

| Field | Why it is there |
|---|---|
| `t` | Wall clock, ISO ms. What a human correlates against a cue sheet. |
| `up` | ms since process start, monotonic. **Both are needed:** a venue clock can be wrong and NTP can step it mid-show — `t` jumps, `up` never does. |
| `lv` | `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `cat` | `app`, `config`, `boot`, `open`, `media`, `project`, `editor`, `timeline`, `scene`, `statemachine`, `transport`, `output`, `projector`, `audio`, `tracking`, `show`, `calib`, `watchdog`, `health`, `plugin:<id>` |
| `ev` | The stable identifier, `<object>.<verb>`. The thing you grep for, and the thing not to rename casually. |
| `proc` | `main` \| `editor` \| `projector:<n>` \| `headless` |
| `run` | **Correlation id, minted per project open.** Every record from one show run groups — see §5.F.4. |
| `seq` | Per-process monotonic. **A gap proves a drop** — without it, back-pressure loss is invisible and the log quietly lies. |
| `d` | Summarized payload, ≤1 KB (§2.3). |
| `err` | Message + stack, on `error` only. |

### 3.3 Levels, and what is on in a venue

| Level | `--broadcast` | dev |
|---|---|---|
| `error` / `warn` | on | on |
| `info` — config, timings, media loads, show events | **on** | on |
| `debug` — internals, actions if you want them | off (but see §5.F.7) | on |
| `trace` | off | off |

The four asked-for families are **bounded per event, not per second**, so `info` in a venue costs a few
hundred KB a day. It is the optional families (§5.E/F.2) that make level gating matter.

### 3.4 Flush policy

Batched on a **1 s timer** or at **256 records**, whichever first. Batching loses the last ≤1 s in a
crash — precisely the second you care about — so these flush **immediately**: `lv === 'error'`, every
`session.*` and `config.*` record, anything from `faultReporter` or the watchdog, and `before-quit` /
`render-process-gone` (the only place a sync write is allowed). Residual exposure: **up to 1 s of `info`
may be lost in a hard crash.** Stated and accepted, not overlooked.

## 4. Where the files live — and why not only the project folder

"In the project folder", taken literally, has two holes:

1. **A project folder is portable.** It gets `collectAssets`'d, zipped, copied between the build PC and
   the venue PC. A machine log inside it travels with the project and mixes machines — the opposite of
   "for each machine installed."
2. **There is often no project folder at the moment you most need the log**: an unsaved project,
   `--headless` with no project, or a crash *before* load — exactly the poisoned-project case
   `faultReporter` exists for. **The machine configuration is knowable before any project opens**, and
   that is the record you most want when a venue PC will not start.

**Dual sink, satisfying both readings:**

- **Sink A, `userData/logs/` — the sink of record.** Per-machine by definition, always writable, local
  disk, already where prefs and the watchdog log live. Rolling, size-capped. Never degrades.
- **Sink B, `<project>/logs/<machine>-<YYYYMMDD-HHMMSS>.log` — one file per session, best-effort.** So
  the folder you hand someone carries its own show history. Degradable per §2.4.

**Verified safe:** `scanAssets` walks only `<root>/assets/` ([`projectFolder.ts:421`](src/main/projectFolder.ts#L421))
and `collectAssets` collects only *referenced* paths, so a sibling `logs/` is never adopted as media nor
swept into a collect. It is not created by `scaffold()` either, so it appears only once written.

## 5. What gets logged — the catalogue

Five families. **A–D are what was asked for. E is the original request, demoted. F is what I suggest
adding**, each with the failure it answers.

### 5.A Machine configuration — `cat: config`

One `config.snapshot` per boot, before any project loads. **All of this is new** — nothing in the tree
collects hardware today.

| Field | Source | Why it earns its place |
|---|---|---|
| App version, build, mode, argv | `app`, `runProfile` | Which build is actually on this machine. |
| Install id + hostname | new `userData/artlux-install.json` (random UUID, **never hardware-derived**) + `os.hostname()` | Machine identity, surviving a NIC change, carrying no fingerprint. |
| OS build | `os.release()` | Windows feature updates change compositor behaviour. |
| CPU model + cores, total RAM | `os.cpus()`, `os.totalmem()` | Distinguishes "this venue PC is smaller" from "the code regressed". |
| **GPU vendor / device / driver version** | `app.getGPUInfo('complete')` | **The single most valuable field.** Most venue regressions are a driver update, not a code change. |
| **WebGPU adapter + whether we fell back to WebGL** | renderer `adapter.info` | Policy is that **WebGPU is required on a venue machine**; a silent fallback to WebGL is a first-class alarm, not a footnote. |
| Display topology | `projector.ts` `describe()` — already structured | **A projector replug renumbers display ids** and silently breaks output binding. Logging the topology makes that diagnosable instead of mysterious. |
| Natives + plugins, each with `ms` and state | `bootReport` — already collected | "Why is there no NDI on this machine" answered without a load-in. |
| Behaviour-changing prefs | `Prefs` | Engine rate, `scene3dRenderScale`, `scene3dMaxFps`, `dockingOff`, `unattended`, `calibrationFile`, `mp4WebCodecs`. A machine that behaves differently usually *is* configured differently. |
| Free disk on the project volume and on userData | `statfs` | A full venue disk takes the show down, and the rotation policy in §6 depends on it. |

**`config.changed` — the highest-value record in this whole plan.** Hash the snapshot into userData; on
each boot, diff and emit **only what changed**:

```json
{"ev":"config.changed","lv":"warn","d":{"gpu.driver":["566.36","572.16"],"displays.2.id":[2528732444,2779098405]}}
```

One line, once per boot, only when something moved. It answers the most common maintenance question
there is — *"what changed on this machine since the last time it worked?"* — and the two examples above
are both real ArtLux failure modes.

### 5.B Loading timings — `cat: boot` / `cat: open`

Almost entirely a matter of **giving existing measurements a durable home**:

| Event | Source | Notes |
|---|---|---|
| `boot.module` | `bootReport` `BootEntry` | One per native/plugin, with `ms` and state. |
| `open.begin` | `openTrace.begin()` | Mints the `run` correlation id (§5.F.4). |
| `open.phase` | `openTrace` marks | Parse, apply, per-scene normalize, warm issuance, swap. Or one `open.trace` carrying the array — §11. |
| `open.armed` | `bootGate` release | `elapsedSec`, `timedOut`, `pending[]`, release reason. **This is the "why did the show open on black" record**, and it already exists as data. |
| `project.read` | main | Bytes read + ms. `bench-open.cjs` already counts bytes for its scoreboard. |

New instrumentation needed: essentially none. This is WP-3, and it is mostly plumbing.

### 5.C Video / media load timings — `cat: media` — **the genuinely missing one**

Nothing in `surfaceMedia`, `contentSource`, `timelinePreloader` or `mediaCache` calls `performance.now()`.
Four distinct spans per asset, and they fail for different reasons:

1. **`probeMs`** — codec identification. HAP's probe is a *native file open*; the boot-chip work measured
   **~3.2 s of HAP probing** on one project, and nothing records which file spent it.
2. **`openMs`** — decoder construction.
3. **`firstFrameMs`** — `readyState ≥ 2` / first decoded frame. **This is what the boot gate waits on**,
   so it is the span that decides how long a venue stares at black.
4. **`poolReadyMs`** — the warm pool parked on frame 0.

One `media.load` per asset per open — `{file, bytes, codec, probeMs, openMs, firstFrameMs, totalMs,
owner}`. Twenty to two hundred records once per open: free, and it turns "the show takes 40 seconds to
start" into a sorted list naming the file.

Plus **runtime** media health, because an asset that loads fine can still starve mid-show:

- **`media.starve`** — HAP `missRate` crosses a threshold (the counters already exist and cost two integer
  adds per frame; **read them on a timer, never emit from the decode path**), or an mp4 underrun. This is
  the log record for the known *"the engine asking faster than the decoder can serve"* condition, which
  was previously diagnosable only by hand.
- **`media.error`** — decode failure, or a file that vanished mid-show (a disconnected share).

### 5.D Errors and degradation — `cat` varies, `lv: error|warn`

Mostly routing what already exists into one stream, so a single file tells the whole story:

- `fault.renderer` — from `faultReporter`: the white screen, with the project that poisoned it.
- `watchdog.*` — relaunch, trigger, breaker tripped. **Merge `artlux-watchdog.log` into this stream**
  rather than keeping two formats and two trim policies.
- `boot.module` at `warn` when a native or plugin is unavailable — already a `BootEntry` state.
- `output.down` / `output.up` — **transitions only**, never the 1 Hz sample.
- `asset.missing` / `asset.relink` — very common after copying a project onto a venue PC.
- `gpu.fallback` — WebGPU unavailable, running WebGL. Against the stated venue policy, this is `warn`.
- Unhandled rejections and uncaught main-process exceptions.

### 5.E Operator actions — `cat: editor` (the original request, demoted)

There is no single funnel. I checked: there are **four** taps with different reach.

| Tap | Covers | Cost |
|---|---|---|
| The `EditorActions` **Proxy**, [`EditorStore.tsx:191`](src/renderer/state/EditorStore.tsx#L191) | Every panel mutation — ~50 named actions, through a wrapper that **already exists** | ~5 lines |
| `dispatchMenu`, [`App.tsx:3040`](src/renderer/App.tsx#L3040) | ~30 menu/file actions | 1 line |
| `keymap.matches`, [`App.tsx:605`](src/renderer/App.tsx#L605) | Shortcuts | 1 line |
| `cueBus` + `stateMachine` + timeline transport | Scene recall, cues, FSM transitions, OSC, the tablet | 1 line each |

The Proxy is a lucky chokepoint, but **only 11 files call `useEditorActions()`** — `Stage` does not, and
the keyboard path calls App's handlers directly. So the Proxy buys panels, not the app.

**Proposed definition:** *every action that changes the document, changes what the audience sees, or
fails.* Not "every function called" — selection, camera moves and panel resizes belong at `debug`, and
recording them by default turns a diagnostic log into a transcript nobody opens.

### 5.F Suggested additions

**1. The config diff.** Already §5.A, restated because it is the recommendation I would fight for. One
line per boot, only when the machine changed. Nearly free, and it is the answer to most support calls.

**2. A health digest once a minute — `cat: health`.** `perfMonitor` already computes p50/p99/max, work
time, long frames and GPU ms at 1 Hz for the HUD; sample it once a minute and add process RSS and free
disk. **1440 lines a day**, and it converts three unanswerable complaints into correlatable curves:
*"it stutters sometimes"* becomes a p99 timeline you can line up against a state transition; a memory
leak becomes a slope; a filling venue disk becomes a countdown you see before it stops the show. Given
the known finding that heavy-load p99 is dominated by context switches and forced layout rather than
React commit cost, having the tail recorded on the real machine is worth more than any local profile.

**3. Show-shape records — `cat: statemachine`.** State entered / left, with dwell, plus cue fires. The log
then doubles as a run sheet: *"how many times did the show cycle last night", "did state X ever fire",
"did the interactive trigger ever arm"*. This is cheap (a show transitions a few hundred times a night)
and it is the difference between a log that diagnoses crashes and one that also answers questions about
the show itself.

**4. A `run` correlation id per project open.** One field, minted at `openTrace.begin()`. Makes every
record from one show run groupable — and an unattended machine may open a project dozens of times a
night via the playlist scheduler and the watchdog, so without it the file is an undifferentiated stream.

**5. `npm run logs:diagnose`.** One command producing a redacted bundle for an email: the config
snapshot, the config-diff history, the last N sessions' errors, the last open trace, the slowest media
loads. `scripts/preflight.ps1` is the prior art for the shape.

**6. Merge the watchdog log.** Two files with two formats and two trim policies describing the same
machine is one file too many.

**7. Optional — a verbosity ramp-down.** Log at `debug` for the first ~2 minutes after an open, then drop
to `info`. Boot is where diagnostics matter and it is bounded, so you get the detail without paying for
it all night. Flagged optional because it makes the log's level non-uniform, which is a real cost when
someone greps it.

## 6. Retention, rotation, redaction

- **Sink A:** `artlux-<YYYYMMDD>-<n>.log`, **10 files × 8 MB**, plus **30-day** max age. An unattended
  install runs for weeks; an unbounded log fills the venue disk and takes the show down. A real failure
  mode for this product, not a theoretical one — and `config.snapshot` records free disk partly so the
  log can say it saw it coming.
- **Sink B:** one file per session, pruned to the **newest 50**.
- **`npm run logs:render`** — JSONL → aligned text, for reading rather than grepping.
- **`npm run logs:export` / `logs:diagnose`** — where redaction lives.

**Redaction — the split that matters.** This log will contain media paths, the OSC bind address, Art-Net
targets, NDI source names, display labels, hostname, and potentially the show-control PIN. A real
`192.168.x.x` already reached this public repo once (2026-08-07). But redacting *in the log* destroys its
diagnostic value — an Art-Net target IP is frequently the answer.

So: **log it raw, redact on export**, through the same `redactPrivate()` treatment the docs harness uses.
The one exception is **secrets, never logged at source at all** — the show-control PIN and anything like
it never enter a record at any level.

## 7. Work packages

Ordered so the four asked-for families land first, and so each of the first three is independently
useful if the rest is deferred.

| WP | What | Risk | Depends on |
|---|---|---|---|
| **WP-0** | `main/logger.ts` (sinks, rotation, back-pressure, stall detection) + `LOG_EVENT` + `renderer/services/log.ts` with 250 ms batching. **Nothing calls it yet** — pure addition, zero behaviour change. | 🟢 | — |
| **WP-1** | `main/machineInfo.ts`: install id, hostname, OS, CPU/RAM, **GPU via `getGPUInfo`**, displays, prefs, free disk + the renderer's WebGPU adapter. `config.snapshot` and **`config.changed`** (§5.A). | 🟢 | WP-0 |
| **WP-2** | Route the **253 existing `console.*` calls** through the logger via a shim, not by editing them. This alone captures `openTrace`'s table, the bootGate verdict and every native/plugin line **for free**. **Audit first** for console in a frame path (`WebGPUMapper` has 7 — they read like init/error; confirm). | 🟡 | WP-0 |
| **WP-3** | Structured loading timings (§5.B): `bootReport`, `openTrace` and `bootGate` emit records instead of only console lines. Mostly plumbing. | 🟢 | WP-2 |
| **WP-4** | **Media load spans** (§5.C) — the one piece of genuinely new instrumentation: `probeMs` / `openMs` / `firstFrameMs` / `poolReadyMs` per asset, plus `media.starve` and `media.error`. | 🟡 | WP-3 |
| **WP-5** | Error + degradation unification (§5.D), including merging `artlux-watchdog.log` into the stream. | 🟢 | WP-3 |
| **WP-M** | **Measurement gate.** `npm run profile:trace` idle + a scripted busk, before/after, one variable at a time; a soak for rotation; `bench-open.cjs` before/after to prove WP-4 did not slow the open it measures. Nothing after this ships on estimates. | 🟢 | WP-4 |
| **WP-6** | Health digest at 1/min (§5.F.2) + show-shape records (§5.F.3). | 🟡 | WP-M |
| **WP-7** | Operator actions — the four taps **plus the summarizer table** (§5.E). The table is the work; the taps are one-liners. | 🟡 | WP-M |
| **WP-8** | Prefs UI (level, per-category overrides, sink B on/off, retention) + `logs:export` / `logs:diagnose` / `logs:render`. `ctx.log` on the renderer plugin context and beside `ctx.ipc` in main — **a field, not a contribution seam**, so it avoids the known SDK gap. | 🟡 | WP-6 |
| **WP-9** | Invariants (§8) + the usage doc + the `docs/manifest.json` entry. | 🟢 | WP-8 |

**WP-0 → WP-3 is the natural first ship.** It delivers machine config, the config diff, all existing
loading timings and every error already instrumented — without writing a single new measurement.

## 8. Invariants to add to `verify:invariants`

Each is a bug that would **compile, boot, throw nothing**, and surface as something else entirely — the
standing criterion for a check.

1. **No logger import in the frame path.** `renderer/engine/frameEngine.ts` and the live-channel services
   (`livePreview`, `dmxSignal`, `fixtureSignal`, `automationOverlay`) must not import `services/log`.
   Symptom if broken: "the venue judders", investigated as a GPU problem.
2. **No sync writes outside the quit path.** `main/logger.ts` may not use `appendFileSync`/`writeFileSync`
   except inside `before-quit`. Symptom: periodic freezes on the one machine whose project lives on a
   share.
3. **Taps never hand raw arguments to the logger** — the §2.3 trap. Symptom: a 40 ms hitch nudging a
   fixture in a big rig.
4. **Decode statistics are read on a timer, never emitted from a decode path** — the §2.2 corollary that
   would otherwise turn a two-integer-add counter into a per-frame record.

## 9. Documentation obligation

Net-new feature, so the gate applies in full: the usage page ships **in the same commits**, with a
`docs/manifest.json` entry, or `npm run verify` fails. Proposed `docs/LOGGING.md`, tagged **hybrid** —
operator half (where the file is, how to read it, how to send one to support, the prefs) and contributor
half (the record schema, the taps, adding an event), split with `<!-- audience:… -->` toggles.
`verify:docs` fails a hybrid that marks no contributor region, so the markers are not optional.

## 10. Rejected, with reasons

- **electron-log / winston / pino.** Another dependency solving neither thing that actually matters here:
  the frame-rate boundary (§2.2) and the degradable network sink (§2.4) are both ArtLux-specific and both
  would still be ours to write. pino is genuinely fast, but its worker-thread transport is one more thing
  to supervise in an unattended venue. The house pattern is small purpose-built modules, and
  `watchdog.ts` already hand-rolls three quarters of this. **Owner's call — §11.**
- **Sync appends.** §2.4.
- **One IPC per event.** Batching makes cost clock-bounded rather than event-bounded.
- **SQLite / a binary format.** Not a txt file, and the query need is `grep`.
- **Folding this into the Prometheus endpoint.** Wrong tool: metrics are aggregates, logs are events.
  Keep both — and note the health digest (§5.F.2) is the deliberate small overlap, because a venue
  without a Prometheus server still needs the tail recorded somewhere.
- **Redacting in the log rather than on export.** Destroys the value of the field you most often need.
- **Hardware-derived machine ids.** A random UUID identifies the install just as well, survives a NIC
  change, and carries no fingerprint.

## 11. Decisions taken, and what is left open

**Settled 2026-09-06 (owner):**

| Question | Decision | Consequence |
|---|---|---|
| **Format** | **JSONL** | Still a readable `.txt`; `npm run logs:render` prints it aligned for reading cold. No second on-disk file. |
| **Actions (§5.E)** | **Included, but at `debug`** — off by default in a venue | The only rate-unbounded family is off unless asked for. The summarizer table is still required: the §2.3 trap is a defect at any level, not a volume problem. |
| **Off-machine** | **No — read in place** | `logs:export` / `logs:diagnose` and the `redactPrivate()` pass **drop out of scope**. Secrets are still never logged at source, which is independent of where the file goes. |

⚠ **One consequence of the last two together, accepted with eyes open.** Sink B lives *inside the
project folder*, and the project folder is the portable thing — copying a show folder to another machine
carries `logs/` with it, LAN addresses and hostname included. That is in tension with "read in place
only". **Resolution: keep sink B on**, because a show folder carrying its own history is the useful half
of the original request, and state it plainly in the usage page. Reversible with one pref.
`collectAssets` and `scanAssets` do not touch `logs/` (verified — `scanAssets` walks only
`<root>/assets/`), so only a manual folder copy carries it.

**Still open — none blocks a start:**

1. **Retention.** 10 × 8 MB / 30 days on sink A, newest 50 on sink B — right for a venue disk?
2. **Sink B granularity.** One file per session (proposed) or one per day?
3. **`open.phase` granularity.** One record per phase (greppable, ~8 lines/open) or one `open.trace`
   carrying the array (compact, one line)?
4. **Dependency.** Hand-rolled as specified (§10), or a logging library? Proceeding hand-rolled.
5. **The verbosity ramp-down (§5.F.7).** Worth the non-uniform level, or keep it simple? Proceeding
   without it.

## 12. Status log

- **2026-09-06** — written, then re-scoped the same day around machine config / loading timings / errors
  / video-load timings. Nothing built. No measurement taken; every number in §2.1 is an estimate awaiting
  WP-M.

---

## 13. Appendix — the data dictionary

Every record and every field, in one place, so what is captured can be reviewed without reading the
rationale. **Ⓝ = new instrumentation. Ⓔ = the value already exists in the tree and only needs a durable
home.**

### 13.0 The envelope — on every record without exception

| Field | Type | Meaning |
|---|---|---|
| `t` | ISO-8601 ms | Wall clock. |
| `up` | int ms | Since process start, monotonic — survives an NTP step that moves `t`. |
| `lv` | enum | `error` \| `warn` \| `info` \| `debug` \| `trace` |
| `cat` | enum | See §3.2. |
| `ev` | string | `<object>.<verb>` — the stable grep key. |
| `proc` | enum | `main` \| `editor` \| `projector:<n>` \| `headless` |
| `run` | string | Correlation id minted per project open. |
| `seq` | int | Per-process monotonic — **a gap proves a dropped record**. |
| `d` | object | Payload, ≤1 KB. |
| `err` | `{message, stack}` | `error` only. |

### 13.1 Session and machine — `cat: app` / `config`

**`session.start`** — once per process launch: `app.version` Ⓔ, `app.build` Ⓔ, `mode` Ⓔ, `argv` Ⓔ,
`install` Ⓝ (random UUID in `userData/artlux-install.json`, **never hardware-derived**), `machine` Ⓝ
(`os.hostname()`), `project` Ⓔ.

**`session.end`** — on `before-quit`: `reason` (quit \| relaunch \| crash-inferred), `uptimeSec`, `opens`,
`errors`.

**`config.snapshot`** — once per boot, before any project loads.

| Group | Fields | |
|---|---|---|
| OS | `platform`, `release` (Windows build number) | Ⓝ |
| CPU | `model`, `cores`, `speedMHz` | Ⓝ |
| Memory | `totalMB` | Ⓝ |
| **GPU** | `vendor`, `device`, `driverVersion` — `app.getGPUInfo('complete')` | Ⓝ |
| **WebGPU** | `adapter.vendor`, `.architecture`, `.device`, `.description`, `backend`, `fellBackToWebGL` | Ⓝ |
| Displays[] | `id`, `label`, `bounds{x,y,width,height}`, `scaleFactor`, `primary`, `internal` | Ⓔ `projector.ts` `describe()` |
| Natives[] | `id`, `state`, `ms`, `detail` — output-engine, spout, hap, ndi, calib, nvwarp | Ⓔ `bootReport` |
| Plugins[] | `id`, `group`, `state`, `ms`, `detail` | Ⓔ `bootReport` |
| Prefs | `engineRateHz`, `scene3dRenderScale`, `scene3dMaxFps`, `dockingOff`, `unattended.enabled`, `calibrationFile`, `mp4WebCodecs`, `uiScale`, `showSplash` | Ⓔ |
| Disk | `userDataFreeMB`, `projectVolumeFreeMB` | Ⓝ |

**`config.changed`** Ⓝ — emitted **only when the diff is non-empty**, at `warn`. A map of dotted field
path → `[old, new]`:
`{"gpu.driver":["566.36","572.16"],"displays.2.id":[2528732444,2779098405]}`

### 13.2 Loading timings — `cat: boot` / `open`

| Event | Fields | Trigger | |
|---|---|---|---|
| `boot.module` | `id`, `name`, `group`, `state`, `ms`, `detail` | one per native + plugin half | Ⓔ |
| `open.begin` | `project`, `bytes` | project data reaches the renderer; **mints `run`** | Ⓔ |
| `open.phase` | `phase`, `atMs`, `deltaMs` | one per `openTrace` mark | Ⓔ |
| `open.armed` | `elapsedSec`, `timedOut`, `pending[]`, `reason`, `phase` | boot gate releases | Ⓔ |
| `project.read` | `path`, `bytes`, `ms` | main-side read | Ⓔ |
| `project.save` | `path`, `bytes`, `ms`, `ok` | each save | Ⓝ |

### 13.3 Media — `cat: media`

**`media.load`** Ⓝ — one per asset per open: `file`, `path`, `bytes`, `codec` (`hap` \| `mp4` \|
`webcodecs` \| `image` \| `audio`), `probeMs`, `openMs`, `firstFrameMs`, `poolReadyMs`, `totalMs`,
`owner`, `ok`, `error`.

**`media.starve`** — threshold crossing only, **read on a timer, never emitted from the decode path**:
`file`, `codec`, `missRate`, `asked`, `missed`, `windowSec`. Ⓔ for HAP.

**`media.error`** Ⓝ — `file`, `phase` (`probe` \| `open` \| `decode`), `message`.

### 13.4 Errors and degradation

| Event | `lv` | Fields | |
|---|---|---|---|
| `fault.renderer` | error | `window`, `project`, `message`, `stack`, `painted` | Ⓔ |
| `watchdog.trigger` | warn | `trigger`, `detail` | Ⓔ |
| `watchdog.relaunch` | warn | `trigger`, `argv`, `countThisHour` | Ⓔ |
| `watchdog.breaker` | error | `relaunches`, `windowHours` | Ⓔ |
| `boot.module` | warn | native/plugin unavailable | Ⓔ |
| `output.down` / `output.up` | warn / info | `protocol`, `universes`, `downSec` — **transitions only** | Ⓝ |
| `asset.missing` | warn | `path`, `type` | Ⓝ |
| `asset.relink` | info | `from`, `to`, `type` | Ⓝ |
| `gpu.fallback` | warn | `reason`, `adapter` | Ⓝ |
| `app.exception` / `app.rejection` | error | `message`, `stack`, `proc` | Ⓝ |
| `log.dropped` | warn | `count` | Ⓝ |
| `sink.degraded` | warn | `sink`, `path`, `reason`, `stalledMs` | Ⓝ |

### 13.5 Operator actions — `cat: editor`, at `debug`

`editor.<action>` (~50 `EditorActions` names + summarizer output only — ids, counts, changed field
names, **never raw arguments**) · `menu.<action>` (~30 ids) · `shortcut.<binding>` · `scene.recall`
(`ref`, `fadeSec`, `source`) · `cue.fire` / `column.fire` · `transport.<verb>`.

Never logged at all: selection, camera moves, panel resize/dock drags, hover.

### 13.6 Suggested additions

**`health.digest`** Ⓝ — once a minute, `cat: health`. Every value Ⓔ from `perfMonitor` except RSS and
disk: `fps`, `frameP50`, `frameP99`, `frameMax`, `workP50`, `workP99`, `longFrames`, `samples`, `gpuMs`,
`rssMB`, `heapMB`, `freeDiskMB`, `outputPps`, `outputFps`, `universes`.

**`statemachine.enter` / `.leave`** Ⓝ — `state` (id + name), `from`/`to`, `dwellSec`, `trigger`
(automatic \| manual \| osc \| zone \| schedule).

### 13.7 Volume

| Family | Records | Per |
|---|---|---|
| `session.*` | 2 | process launch |
| `config.snapshot` | 1 | boot |
| `config.changed` | 0 or 1 | boot, **only on a diff** |
| `boot.module` | ~16 | boot |
| `open.*` | ~10 | project open |
| `media.load` | 20–200 | project open |
| `media.starve` / `.error` | rare | threshold crossing |
| errors | rare, rate-limited | — |
| `health.digest` | 1440 | day |
| `statemachine.*` | a few hundred | show night |
| actions (`debug` only) | ≤20/s human ceiling | — |

Everything above the actions row is bounded **per event, not per second**. At ~200 bytes/record a venue
night is a few hundred KB — actions being `debug` keeps the only unbounded family off by default.
