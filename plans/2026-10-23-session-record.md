# 2026-10-23 — session record: v0.33.6, v0.33.7, MP4 memory, and what a Spout test turned up

> **Status:** Open (the list under *Still open* is not done) · **Not a limitation-lift plan** — this
> folder's 10-section template does not apply. A dated record of one working session on the RTX box:
> what shipped, what was measured, what was claimed and then retracted, and how to test on this machine
> without repeating the session's own mistakes. Written for the owner and for the next session.

## How it started, and where it went

The owner launched a Spout sender and reported "a very bad framerate inside ArtLux". The cause was not
Spout (§*The original question*). Monitoring that test showed an MP4 clip held in memory three times
over, which led to the MP4 residency work; reading that code exposed a decoder that could kill the
renderer; and each fix's verification turned up the next bug. Everything below was measured on this
machine unless it says otherwise.

## What shipped

Branch `fix/mp4-memory-residency`, merged to `main` as `5049550`, then two releases.

| Commit | What |
|---|---|
| `58eff23` `355d1ef` `23ea595` `735360d` | **MP4 decoder freeze.** A decoder that died was replaced by an unconfigured one and fed forever; the renderer died of OOM at ~14.8 GB **4.7 s** after a fault or a real GPU-process crash. Now it re-seeks, holds its last frame, backs off; recovery 50–80 ms. Fault hook `__artluxMp4Fault`. [mp4-decoder-freeze.md](mp4-decoder-freeze.md) |
| `1854de4` `c09e96b` | **Residency step 1.** `probe()` reads the moov by byte range (7 ms vs a 3.9 s full open) instead of opening an unowned full decoder (+2.3 GB per probed library clip, half of it permanent). Also: a missing `.mp4` returned a 404 that hung `open()` forever and wedged every MP4 thumbnail for the session. [mp4-memory-residency.md](mp4-memory-residency.md) |
| `a847619` `e0f2329` | **Step 2.** One refcounted parse per file shared by all three pools; the timeline pre-warm holds the parse, not an unused surface decoder. 3 copies → 1 (backing store 3.9 → 1.3 GB). |
| `5721785` `89b326c` | **Step 3.** Samples read from disk one GOP at a time into a 256 MB cache. Show arms in **0.3 s instead of 4.4 s**; renderer private memory **813 MB vs 4.7 GB**; 150 s across both loop points with 0 gaps. |
| `717ed7b` | **Bake** left every surface clock paused (`setPlaying(false)` never undone, since `4af847f`). |
| `8d3805e` | Thumbnail diagnostics; **retracted** a "60–75 s thumbnail delay" that was my harness (§*Retracted*). |
| `a24913e` `70b749f` | **MP4 thumbnails are the exact frame** (`frameExact`); they and their sidecar saves **wait while the transport plays** (`thumbnailWhilePlaying: false`, new optional SDK field). Old MP4 sidecars orphaned by a key salt. |
| `9737826` | **An editor reload left every projector output on "Waiting for the main window…" forever** — reachable from Ctrl+R and the renderer-fault ladder's reload rung. Main now re-bridges open outputs on every editor load; longest gap across a reload 383 ms. |
| `5049550` | Merge to `main`. |
| `9226443` | **Release v0.33.6.** |
| `4dcc19a` | **CI release retention never ran** (the `release` job has no checkout; `gh` failed, printed "nothing to retire", passed). Now `GH_REPO` is set and a failed listing warns. |
| `b34f444` | **Right-click ▸ Add clip ▸ Video/Image linked the file in place** (no Media entry, not portable). Now imported exactly like a drop, through one `importAndPlace()`. |
| `cb8ca2c` | **Release v0.33.7.** Its retention step drafted 22 old releases; public now: v0.33.7, .6, .5. Tags kept. |

Every fix carries a `verify:invariants` check, each mutation-tested (break the rule, watch it go red).

## The original question — the "bad framerate"

- **Not Spout, not the GPU.** Spout ran GPU-only (Spout settings `CPU=0`), both apps on the RTX 5090
  (per-process GPU counters + `nvidia-smi`), frames arrived at ~58 Hz as BGRA `VideoFrame`s.
- **The engine rate.** `AppSettings.engineFps` was unset, so it defaulted to **30** (`App.tsx`) — the `44`
  in prefs is the Art-Net wire rate. The engine sampled a 60 Hz feed at 30 Hz on an unrelated clock:
  uneven motion. Set to 60, the engine held 59.9 fps with 0.6 ms of work.
- **⚠ This machine's prefs were changed:** `engineFps: 60` in `%APPDATA%\ArtLux\artlux-prefs.json`.
  The original is backed up at `%TEMP%\claude\spout-test\artlux-prefs.backup.json`.
- **[docs/SPOUT.md](../docs/SPOUT.md) is still wrong** — it says the engine rate "does not apply to Spout".
  Only the receiver's poll ignores it; what is drawn and sent is still capped by it. Not fixed (§*Still open*).

## Still open

| Item | Notes |
|---|---|
| **SPOUT.md engine-rate claim** | Above. Fix the doc, or have Spout surfaces raise the engine rate. |
| **An editor renderer death is never logged** | `watchdog.attach()` returns early when unarmed, so nothing listens for `render-process-gone` in the editor; the machine log only shows main's 1/s "Render frame was disposed". [mp4-decoder-freeze.md](mp4-decoder-freeze.md) §11. |
| **`artlux_render_fps` reads 60 after the renderer dies** | Main re-publishes the last value. A dead renderer looks healthy on that metric. |
| **Codec reclaim hypothesis, half-tested** | Foreground idle 3.5 min: nothing reclaimed. The minimised/hidden half was not run. The fix covers a reclaim either way. |
| **Windows "GPU Process Memory" counter climbs ~520 MB/s** with Spout live | Real adapter memory stays flat (~1.6–3.3 GB), handles flat. Reached >600 GB on a 32 GB card — a bookkeeping artefact, probably shared-texture accounting. Unexplained; a long run watching for slowdowns would settle whether it matters. |
| **Residency steps 4–5** | Worker parse (low value now); count shared data once in the budget + warn when `MAX_RESIDENT_BYTES` cannot be met. Fragmented MP4 still parses whole. Cache budget (256 MB) sat at the cap with two playheads — a smaller one is likely fine. |
| **Filmstrips while playing** | MP4 filmstrips are blank until the transport stops — the owner noticed ("thumbnail missing") before it was explained. Offered and not chosen: give each clip its first picture even while playing (~1 dropped frame per clip). |
| **The owner's test project** | `freeze-test.artlux`: the `capture003` clip on "Track 2" still links `Desktop\capt003\capture003.mp4` (added before v0.33.7). Re-add it on v0.33.7 to import it. |
| **Launcher retention** | `GH_REPO` added and dry-run checked; not yet run by a real `launcher-v*` release. |
| **`package-lock.json` says 0.29.0** | Version field never bumped with releases. Harmless; restored rather than committed this session. |
| From [2026-10-22](2026-10-22-session-record.md) | HapA/Hap7 display, HAP layers streamed to projectors that decode them, no recovery from GPU loss in hapGL / WebGPUMapper / renderer3d. |

## Retracted — things I said this session that were wrong

Recorded so they are not repeated.

- **"The renderer's JS heap is at 3.5 GB, near Electron's ~4 GB limit."** The JS heap was **30 MB**;
  the bytes were ArrayBuffer backing store (`Runtime.getHeapUsage().backingStorageSize`), which that limit
  does not cover. `performance.memory.usedJSHeapSize` counted them and misled me.
- **"The test clip is 1080p."** It is **5760×2880, 29.97 fps** (a 360° camera file).
- **"Thumbnails sometimes take 60–75 s to start."** Never true. My polling loops grepped
  `'"inFlight":0'` against `JSON.stringify`'d output (`\"inFlight\":0`), never matched, and ran to their
  last iteration: 60 s = 30 × `sleep 2`, 74 s = 120 × (0.5 s + 0.12 s). Timed in the page: 25 ms.
- **"The branch costs 248% of a core."** That was the **dev server** (development React re-rendering
  per frame). Production build: 34% vs v0.33.5's 18% — the difference off the main thread is disk reads.
- **The freeze plan predicted a permanent hang.** Measured: the spin allocates a chunk copy per pass and
  the renderer **dies of OOM** in ~4.7 s.

## Testing on this machine — what works, and the traps

**The machine:** RTX 5090 + AMD Radeon iGPU + a Parsec virtual adapter; 125 GB RAM, 32 cores; two
displays (primary DELL S2421HN); Electron 42.4.1. Installed app: `C:\Program Files\ArtLux\` (auto-updates).
OSC input is **off** in prefs. Spout 2.007 demo sender lives in `Desktop\SPOUT-2007\DEMO\`.

**Recipes that worked:**
- **Dev:** `npm install` (npm 11 skips install scripts — run `node node_modules/electron/install.js`
  once for the Electron binary), copy the installed `resources/*.node` into `native/*/` (no Rust needed),
  then `env -u ELECTRON_RUN_AS_NODE ARTLUX_CDP_PORT=9222 npx electron-vite dev -- --project=…`.
- **Performance numbers come from a production build**, never dev: `npm run build`, then
  `env -u ELECTRON_RUN_AS_NODE ARTLUX_CDP_PORT=9222 node_modules/electron/dist/electron.exe . --project=…`.
  Compare against the installed build launched with `ARTLUX_CDP_PORT` set.
- **A second instance beside the owner's open app:** add `--user-data-dir=<scratch>` and another CDP
  port (9223). Separate single-instance lock; use a scratch project, never the owner's file.
- **Time inside the page** (`performance.now()` around the awaited thing). Process CPU/handles from
  `Get-Process`/`Win32_Process`; real GPU memory from `\GPU Adapter Memory(*)\Dedicated Usage`.
- **Faults on demand:** `__artluxMp4Fault('close'|'error'|'configure', pathPart?, pool?)`; a real GPU
  crash is CDP `Browser.crashGpuProcess` on the browser endpoint.
- **Driving the UI:** React props are on DOM nodes (`__reactProps$…`) — find an element by its handlers;
  real input via `Input.dispatchMouseEvent`; pick a file with `DOM.setFileInputFiles`. Read app state by
  walking the fiber tree from `#root`'s `__reactContainer$…` key.

**Traps, each of which cost time today:**
- **`ELECTRON_RUN_AS_NODE=1` is set in VS Code's shell.** Electron then runs as plain Node
  (`--version` prints v24). Always `env -u ELECTRON_RUN_AS_NODE`.
- **The CDP helper prints `JSON.stringify` output — escaped quotes.** Grep after `tr -d '"'`, or return
  plain strings. A loop that never matches looks like a slow app.
- **`import()` of a module through Vite's `/@fs/` URL gives a SECOND instance**, which also re-registers
  the `window.__artlux*` hooks onto its own empty maps. Reload the page afterwards.
- **Structural edits don't HMR cleanly** — reload the page. **Reloading the editor used to orphan open
  projector windows** (fixed in v0.33.6+; on older builds restart the app instead).
- **Git Bash rewrites `/artlux/...` arguments into `C:/Program Files/Git/...`** — `MSYS_NO_PATHCONV=1`.
- **Source files are CRLF.** `sed` patterns with `\n` do not match; do multi-line edits with node.
  Backticks inside `node -e "…"` run as shell commands — use a quoted heredoc.
- **Ctrl+T toggles the timeline drawer**; a synthetic Ctrl+S does not save. **A bake without `outPath`
  opens a modal save dialog** that looks like a hang — pass `intoProject: true`.
- **The fullscreen video output sits on the primary display under the editor**; outputs on one screen
  can be occluded. Check `document.visibilityState` before trusting a projector's draw rate.
- **Windows GPU Process Memory per-process counter is not memory** (§*Still open*).

## Diagnostics added this session

`window.__artluxMp4Stats()` / `__artluxMp4StatsReset()` (per decoder: state, samples, keyframes, feed
position, errors, recoveries, starvedReads, lastFrameMs) · `__artluxMp4Stores()` (per file: ranged/whole,
cache MB, GOPs resident, reads, avg read ms, holders) · `__artluxMp4Fault(…)` · `__artluxThumbs()` now
reports sidecar reads, both queues, busy flags, the codec job's stage and per-stage times, held-while-
playing and pending saves.

## Where things are

| What | Where |
|---|---|
| Decoder freeze: mechanism, reproduction, numbers | [mp4-decoder-freeze.md](mp4-decoder-freeze.md) |
| MP4 residency steps 1–3, measurements, open steps | [mp4-memory-residency.md](mp4-memory-residency.md) |
| Operator docs changed | [CODECS.md](../docs/CODECS.md), [TIMELINE.md](../docs/TIMELINE.md), [BAKE.md](../docs/BAKE.md), [WATCHDOG.md](../docs/WATCHDOG.md); retention note in [DEVELOPMENT.md](../docs/DEVELOPMENT.md) |
| Test project + scripts (scratch, may be wiped) | `%TEMP%\claude\spout-test\` — `freeze-test.artlux`, the 1.36 GB clip, `still-4k.png`, CDP helpers |
| Previous session | [2026-10-22-session-record.md](2026-10-22-session-record.md) |
