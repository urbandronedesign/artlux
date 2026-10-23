# MP4 memory residency: hold a file once, then stop holding it at all

> **Deliverable:** this document, saved as `plans/mp4-memory-residency.md` and indexed in `plans/README.md`.
> **Status:** 🟡 **IN PROGRESS** — steps 1–3 ✅ built 2026-10-23 (§11); steps 4–5 not started. Branch
> `fix/mp4-memory-residency`, after the [decoder freeze fix](mp4-decoder-freeze.md) it carries first.
> · **Lifts:** the open item in [preload-optimization.md](preload-optimization.md) §9 (*"mp4 still
> buffers the whole file to demux"*), §0.4 of [offline-bake.md](offline-bake.md), and the last entry of
> the [2026-10-22 session record](2026-10-22-session-record.md)'s list · **Placement:** **Plugin**
> (`plugins/mp4`) + small core seams (`codecResidency`, `timelinePreloader`, `timeline` pre-warm) ·
> **Risk:** 🟡 Medium overall — step 1 is low; step 3 rewrites how samples reach the decoder and carries
> the risk (loop wrap, backward scrub, offline render).

## 1. Context — what is held, and why

Measured 2026-10-23 on the RTX box with a 1.36 GB, 142 s, **5760×2880 29.97 fps** H.264 clip (4,261
frames, 143 keyframes), on a looping surface and a timeline layer.

Every `FileDecoder.open()` (`plugins/mp4/src/mp4Decoder.ts`) fetches the **whole file** into one
ArrayBuffer, demuxes it synchronously on the renderer main thread, and keeps **every encoded sample** in
`samples[]` for the decoder's life. There are three pools, and each open is its own copy:

| Pool | Opened by | Read by a timeline clip? |
|---|---|---|
| surface (`decoders`, per path) | timeline pre-warm (`timeline.ts` `warmWindow`/`warmMedia`/the cold-start gate), and — until step 1 — every `probe()` | **No.** A layer reads only `layerDecoders`. |
| layer (`layerDecoders`, per layer) | the layer's playback and pre-warm | yes |
| thumbnail (`thumbDecoders`, LRU 4) | the filmstrip | for thumbnails only |

Measured: the codec reported **4,062 MB resident for the 1,355 MB file — 3.00×**. The JS heap itself
was 30 MB; the bytes are ArrayBuffer backing store (`Runtime.getHeapUsage().backingStorageSize`), so
the ceiling is RAM and the renderer's allocator, not the ~4 GB V8 heap limit. Opening took **7.1 s**
before the show could arm (two full demuxes).

## 2. Requirements

- **R1** One file is held at most once, whatever pools use it.
- **R2** Nothing that only wants a verdict or metadata (probe, aspect, sourceInfo) holds samples.
- **R3** Steady-state memory does not grow with file length (step 3).
- **R4** Open does not block the renderer main thread in proportion to file size (steps 3–4).
- **R5** Playback is unchanged: seamless surface loop, frame-exact timeline scrub, exact offline render.
- **R6** Every defect fixed becomes a `verify:invariants` check.

## 3. Architecture at a glance

```
today      surface ─ samples(1×)   layer ─ samples(1×)   thumb ─ samples(1×)        = 3× the file
step 1     probe/aspect/sourceInfo answered from the INDEX (no decoder, no samples)
step 2     surface ─┐
           layer   ─┼─► SampleStore(path)  refcounted, freed with its last holder    = 1× the file
           thumb   ─┘   pre-warm holds the STORE, not a decoder
step 3     SampleStore = index (≈10 MB/h) + byte-range GOP cache (fixed budget)     = O(budget)
step 4     index parse in a Worker
```

## 4. Design — the steps

1. **Index-only probe.** `probe()` reads the `moov` by byte range (mp4box skips an `mdat` before the
   `moov` and returns the offset it wants next), asks `isConfigSupported()` on the same config the
   decoder will use, and caches the verdict and the metadata. `aspect()`/`sourceInfo()` answer from that
   cache when no decoder is open. Also: `open()` must fail, not hang, on a refused/missing file.
2. **Shared sample store.** One refcounted store per path; every `FileDecoder` reads from it and keeps
   its own playhead. The timeline pre-warm retains the store instead of opening a surface decoder, so a
   layer opening at a clip switch attaches to already-parsed samples instead of reading the file again.
   *(Moved here from step 1: dropping the pre-warm before this exists would make a clip switch read the
   file from cold disk.)*
3. **Range-read GOPs.** Keep only the index; read the GOP covering the playhead plus a lead by byte range
   into a fixed-budget cache; pre-read the loop's first GOP ahead of the wrap so the seamless loop
   (`mp4Decoder.ts` absolute-index design) still lands on samples in memory. Fragmented MP4 stays on the
   whole-file path until its moofs are indexed.
4. **Parse in a Worker.**
5. **Honest accounting.** Count a shared store once; warn when `MAX_RESIDENT_BYTES` is breached with
   nothing evictable (today it is silently exceeded: 4 GB against a 1.5 GB budget, because the bytes are
   in the protected global pool).

## 5. ⚠️ Breaking changes

None planned. No persisted data, no SDK change.

## 6. Risk evaluation

Step 1 🟢 (additive; the probe is a new path, the full open is unchanged). Step 2 🟡 (ownership/refcount
across three pools and the warm-pool budget). Step 3 🟠 (the feed path — loop wrap, backward scrub,
`frameExact`; regression-test with `__artluxLayerGaps` at every wrap and a bake).

## 7. Migration & back-compat

None.

## 8. Verification

The CDP probes used throughout: `__artluxMp4Stats` (per-pool decoders), `__artluxCodecResidency`
(owners + bytes), `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage` (real backing store),
`__artluxLayerGaps` (gaps at open/switch/wrap), `__artluxThumbs` (drive a thumbnail with no filmstrip),
the render metrics. Measure on the RTX box, with a clip that is in the project folder but on no surface
or timeline for the probe cases. ⚠ Do not `import()` `mp4Decoder.ts` from the console to call it
directly: Vite serves a **second module instance**, which also re-registers the `window.__artluxMp4*`
hooks onto its own empty maps — reload the page afterwards.

## 9. Effort & phasing

Step 1 ~½ d (done) · step 2 ~1 d · step 3 ~2–3 d · step 4 ~1 d · step 5 ~½ d. One commit (or a short
series) per step, each measured before the next.

## 10. Open questions

1. Cache budget per file for step 3 (proposed 256 MB) — tune on the RTX box with 4K/5.7K material.
2. Do thumbnails need their own store reference at all after step 3, or one keyframe GOP per request?

## 11. What shipped

### Step 1 — 2026-10-23

**Reproduced first.** A thumbnail request for a clip that sat in the library and nowhere else
(`__artluxThumbs([path])`) left **two** decoders for it: the expected thumbnail decoder, and a surface
decoder that **no residency owner held** — `probe()` was `ensureOpen()`, and only an owner's release ever
closes a surface decoder. **+2.3 GB** of backing store from one thumbnail, half of it permanent.

**Found on the way — the thumbnail wedge.** `FileDecoder.open()` never checked `res.ok`. A 404/403 is a
resolved fetch with an empty body; mp4box ignores an empty buffer without calling `onReady` or `onError`
(`checkBuffer`: *"Ignoring empty buffer"*), so the promise never settled. One request for a missing
`.mp4` held the thumbnail pump's `codecBusy` for the rest of the session: a valid clip whose decoder was
already open waited > 60 s behind it and never ran.

**After:**

| | Before | After |
|---|---|---|
| Probe of the 1.36 GB clip | full open, **3,954 ms**, samples resident with no owner | index only, **7 ms**, nothing retained |
| Probe of a missing file | never settles; wedges the thumbnail queue | `false` in **1 ms** |
| Library-clip thumbnail | thumb decoder + unowned surface decoder | thumb decoder only |
| Missing file, then a valid thumbnail | the valid one never runs | both done in **1 s** |
| `sourceInfo()` from the index vs a full parse | — | **identical** (5760×2880, 29.970 fps, 142.175 s) |
| 60 s healthy play | — | 1,800 frames per decoder (30.0 fps), 0 errors/recoveries/gaps/long tasks |

Guarded by `verify:invariants` *"an mp4 probe opens no decoder, and a refused file fails instead of
hanging"*, mutation-tested four ways (probe back to `ensureOpen`, `res.ok` dropped, ranges dropped, the
no-`moov` settle dropped) — red on each.

**~~Seen, not investigated: the first codec thumbnail after a reload can take ~60 s~~ — RETRACTED
2026-10-23, it never happened.** See step 3's "found on the way" item 2: a measurement-harness bug.

### Step 2 — 2026-10-23

**Built.** `SampleStore`: one refcounted parse per path (config + every encoded sample), loaded once by
`loadStore()` — the old `FileDecoder.open()` body, moved — and shared by every holder.
`FileDecoder.open()` is now `acquireStore()`; `close()` releases. The timeline pre-warm (`preWarm` →
`prewarm()`) holds the **store**, not a surface decoder, released by `close(path)` when the last
residency owner lets go. `residentBytes()` counts a store once plus each decoder's decoded frames.
`sourceInfo()` / `aspect()` / `probe()` answer from a loaded store first. New diagnostic:
`window.__artluxMp4Stores()` (file, MB, samples, holders, prewarmed).

| Same project, same clip (surface + timeline layer) | Before | After |
|---|---|---|
| Copies of the track | 3 (surface, layer, unused surface pre-warm) | **1** — 1,291 MB of samples, 3 holders |
| ArrayBuffer storage after a forced GC | ~3.9 GB | **1,321 MB** |
| Codec-reported residency | 4,062 MB | **1,694 MB** (1,291 + decoded 5.7K frames in flight) |
| A second opener of a held file | a full read + demux (~4 s) | **0 ms** (attach) |
| Show armed after a reload | 4.6–5.1 s (7.1 s first cold open) | **4.4 s** |

**Open time barely moved, and that is expected:** one full read + demux of 1.36 GB is ~4.2 s by itself
(measured: the first parse of a store). Step 2 removes the *second* parse; only step 3 removes the
first.

**Refcount verified in isolation** (pre-warm → surface → layer → thumb → release each): holders
1 → 2 → 3 → 4 → 3 → 1, `close(path)` releasing the surface and the pre-warm together; a pre-warm
cancelled by `close(path)` while still loading leaves no store behind once its parse lands.

**Regression:** 60 s of play (1,800 frames per decoder, 0 errors/gaps/long tasks), decoder recovery over
the shared samples in 47 ms, thumbnails unchanged. **Loop wrap:** 150 s across both loop points — the
surface fed frames 5,310 → 9,810 through its seamless wrap at 8,522, the timeline layer ran to the end
of the clip and back round to 1,373 — 0 gaps, 0 errors, 0 long tasks, 0 long frames, p99 17.9 ms.

**Guard:** the step-1 check now also fails if `FileDecoder.open()` fetches or demuxes for itself instead
of taking the shared store.

### Step 3 — 2026-10-23

**Built.** `SampleStore` is now RANGED for every non-fragmented file: `loadStore()` reads the moov by byte
range (`readIndex()`, shared with the probe) and builds the sample table from mp4box's
`getTrackSamplesInfo()` — offset, size, time, keyframe for every frame, no sample bytes. Bytes come per
**GOP**, one Range request each, into a cache with a 256 MB budget (raised to 4 GOPs for huge-GOP files),
GOP 0 pinned. `pump()` names its window each call (`want()`: the GOP it is feeding + 2 ahead, wrapping
for a looping surface), feeds only samples whose bytes are resident, and **stops — never skips — at
one that is not** (`starved`), resuming at that exact sample when the read lands. `frameExact` awaits
that read; `thumbnail()` reads the GOP it needs before asking for a frame. A fragmented file keeps the
whole-file parse (`loadWholeStore()`). `__artluxMp4Stores()` gained `mode`, `gops` resident/total,
`reads`, `avgReadMs`; decoder stats gained `starvedReads`.

| Same dev project (looping surface + timeline layer on the 5.7K clip) | Step 2 | Step 3 |
|---|---|---|
| Held for the clip | 1,291 MB (whole track) | **≤ 256 MB** GOP cache (27–28 of 143 GOPs), independent of file length |
| ArrayBuffer storage after a forced GC | 1,321 MB | **159 MB** at open, **286 MB** in steady play |
| Editor renderer private memory | — (4.7 GB before any fix) | **813 MB** |
| Show armed after a reload | 4.4 s | **0.3 s** |
| GOP reads | — | ~1 per second, **23–26 ms** for ~9.5 MB |
| Feed stalls on missing bytes in steady play | — | **0** over 150 s (≈10 per decoder during the cold start, before the read-ahead has anything) |
| Main process CPU | ~6% of a core | ~13% — it now serves ~10 MB/s of ranges |

**Regression:** 150 s across both loop points — the surface's seamless wrap past frame 4,261 and the
timeline layer's wrap 4,135 → 222 — with **0 gaps, 0 errors, 0 long tasks**, p99 18 ms, cache steady at
budget (eviction working). A 2 s bake (60 frames, `clock: 'playhead'`) completed in 3.3 s with no
`[mp4/exact]` warning, the layer decoder awaiting a GOP read 6 times. Decoder recovery still works.

**Guard:** the probe/open check now follows the code into `readIndex()` / `loadStore()` /
`loadWholeStore()`, and fails if `loadStore()` stops trying the ranged index first, if the ranged path
drops its `isConfigSupported` gate (the older "asks the decoder" check is satisfied by the whole-file
path alone, so it could not see this), or if `pump()` advances `fedAbs` before checking the sample's
bytes are resident. Mutation-tested three ways (index skipped, config gate dropped, a non-resident sample counted and fed anyway); the third first PASSED an order-only version of the check, which now also requires the `break`.

**Found on the way, not fixed here:**
1. **A bake leaves every surface clock paused.** `bakeRunner.ts:515` calls `contentSource.setPlaying(false)`
   and its `finally` never restores it; surfaces are only re-set by `surfaceMedia`'s sync, which runs on a
   surface or play-state change. Seen live: after a bake the looping MP4 surface stopped (`fedAbs` flat)
   while the timeline layer kept playing, until play/pause was toggled. Pre-existing since `4af847f`
   (2026-09-12). **Fixed 2026-10-23** (separate commit): the render records `contentSource.isPlaying()` before pausing and restores it in its `finally`; verified both ways live (playing → playing, paused → paused) and guarded by "a bake restores the surface play state it paused", mutation-tested.
2. **~~A thumbnail sometimes takes 60–75 s to start~~ — RETRACTED: the app was never slow; the
   measurement was.** Investigated after a full app restart with new diagnostics in `__artluxThumbs()`
   (sidecar reads pending, both queues, busy flags, and which stage the codec job is in and for how long).
   Nothing reproduced it: a fresh start, a bake into the project, a bake cancelled at its save dialog, a
   decoder fault, a forced GC, a whole-file read (3.6 s at 354 MB/s) — every thumbnail job finished in
   0.03–0.9 s, and a continuous queue tracer never saw a backlog. The cause was the polling loops that
   produced the numbers: they exited on `grep '"inFlight":0'`, but the CDP helper prints through
   `JSON.stringify`, so the text is `\"inFlight\":0` and the pattern can never match. Each loop ran to its
   last iteration, and the "delays" are exactly the loops' own lengths — 30 × `sleep 2` = **60 s**,
   60 × (`sleep 1` + ~0.13 s) ≈ **67.8 s**, 120 × (`sleep 0.5` + ~0.12 s) ≈ **74 s** (measured 74.6 /
   74.5 / 74.1). Proven directly: the same job timed inside the page took **25 ms**, and the old exit test
   did not match its own output. **Lesson for this harness:** time inside the page
   (`performance.now()` around the awaited thing), or strip the escaping before grepping (`tr -d '"'`, as
   `thumbtrace.sh` does) — and be suspicious of any delay that comes out constant.

   **What the investigation did turn up (real, open):** a codec thumbnail job often **stores nothing**.
   `thumbnail()` returns `frame()`, which never blocks — on a GOP it has only just fed it returns null (or
   the nearest frame it still holds from an earlier request), so the job ends without a bitmap and the
   filmstrip slot keeps showing its nearest neighbour until something re-asks. Measured: a 190 ms job,
   `cached` unchanged. Pre-existing — [offline-bake.md](offline-bake.md) already notes mp4's `thumbnail()`
   is not frame-exact. A fix would await the exact frame the way `frameExact` does.
3. **The cache sat AT its 256 MB budget** with two playheads a few frames apart — they share GOPs, so the
   budget, not the windows, set the size. Open question 1 (§10) stands: a smaller budget is likely fine.
