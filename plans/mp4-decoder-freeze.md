# MP4 decoder freeze: a dead decoder must not be able to hang the renderer

> **Deliverable:** this document, saved as `plans/mp4-decoder-freeze.md` and indexed in `plans/README.md`.
> **Status:** 📝 **Draft 2026-10-23** — nothing built. Branch `fix/mp4-memory-residency` (this lands
> FIRST on it, in its own commits, before any residency work touches the same feed loop). · **Lifts:** the
> open bug *"MP4 decoder can freeze the editor"* in [2026-10-22-session-record.md](2026-10-22-session-record.md)
> · **Placement:** **Plugin** (`plugins/mp4/src/mp4Decoder.ts`) + one invariant check · **Risk:** 🟢 Low —
> the change is confined to the error path of one class; the happy-path feed is unchanged by construction
> (§6).

## 1. Context — what actually happens when a decoder dies

Confirmed by reading, **not yet reproduced** (Phase 0 does that). Line numbers are `mp4Decoder.ts` at
`30d8c8d`.

**The chain, step by step:**

1. A `VideoDecoder` errors. Per the WebCodecs spec an error **closes** the codec: `state` becomes
   `'closed'` and the `error` callback runs. Ours (`:384`) only logs — it touches no decoder state, so
   `segAbs` still names the segment the dead decoder was feeding.
2. The next `pump()` (from `frame()`, or from the module's own rAF via `topUp()` at `:552-557` — so it
   runs whether or not anyone is asking for a picture) calls `ensureDecoder()` (`:476`). That sees
   `'closed'` and builds a **new, unconfigured** decoder (`:372-386`). Its own comment says why
   configuring is deferred: *"configured lazily in seekSegment (single reset+configure path)"*.
3. `seekSegment()` is only reached by the three branches at `:460-471`: idle (`segAbs === -1`), a
   backward jump, or falling behind with a nearer keyframe. **A forward-playing surface hits none of
   them** — `segAbs` is still set, `wantUs` is monotonic, and `fedTs` is ahead of the playhead. So the
   fresh decoder is never configured.
4. The feed loop (`:481-487`) calls `decode()` on it. An unconfigured codec throws `InvalidStateError`
   **synchronously**. The `catch { /* skip a bad chunk */ }` at `:486` swallows it and `fedAbs` advances.
5. Every exit condition of that loop measures decoder *progress* — `decodeQueueSize < QUEUE_BUDGET`,
   `framesAhead + decodeQueueSize < TARGET_AHEAD` — and a codec that throws on every call makes none:
   `decodeQueueSize` stays 0, nothing new is output. The one bound that does not depend on the decoder is
   `fedAbs < maxAbs`, and for a looping surface `maxAbs = Infinity` (`:478`). **The loop never ends.**
   Each iteration also constructs an `EncodedVideoChunk` (`:485`), which copies the sample's bytes before
   `decode()` throws — so the spin also churns memory.

The loop is entered as soon as the frames buffered before the error have been played past
(`framesAhead` drops below `TARGET_AHEAD`) — i.e. within about 80 ms at 60 fps.

**What each consumer gets** (the three pools, `:536-565`):

| Consumer | `maxAbs` | Outcome |
|---|---|---|
| **Surface** (looping, `decoders`) | `Infinity` | **Renderer main thread hangs forever.** |
| **Timeline layer** (`layerDecoders`) | `N - 1` | One synchronous pass that constructs a chunk for **every remaining sample in the file** (a copy of the rest of the track, then a throw, per sample) — a stall proportional to what is left of the clip — then the layer freezes on its last good frame. It recovers at the next backward jump (a timeline loop wrap or a scrub), which reaches `seekSegment`. |
| **Thumbnail** (`thumbDecoders`) | `N - 1` | Same as a layer: one stall, then every later thumbnail of that file shows the same frame until a request lands earlier than the dead segment. |
| **Offline render** (`frameExact`, `:265`) | `N - 1` | Same stall; then `fedAll && drained` (`:326`) sets `segAbs = -1` and the next round re-seeks with a configured decoder. Recovers once; a second error returns null and the bake fails visibly. The least bad case. |

**Why a hang of the renderer is the worst kind of failure here:** the renderer's main thread is the
engine (`renderer/engine/frameEngine.ts`). While it spins, nothing composites, so Art-Net keeps going out
only because the native pacer repeats the last frame (the LEDs freeze); projector windows are fed from
this renderer over the MessagePort bridge, so they freeze too; and the UI is dead. In `--broadcast` the
watchdog's render-stall detector relaunches after ~10 s. **In the editor nothing recovers** — the
operator has to kill the app.

**A second entry into the same loop:** if `configure()` throws inside `seekSegment()` (`:420`), it
returns before setting `segAbs`, and `pump()` carries straight on into the feed loop with an
unconfigured decoder. Same spin.

**Triggers, in the order we think matters:**

1. **The GPU process crashing or resetting.** Every hardware `VideoDecoder` in the renderer errors at
   once. This is the "white 3D + no HAP" end state of the Spout leak fixed in v0.33.4 — that leak is
   gone, but a driver reset (`nvlddmkm` on NVIDIA) produces the same event, and on this code it would
   also freeze every looping MP4 surface for good.
2. **Chromium reclaiming idle codecs — a hypothesis, unverified.** Chromium closes *inactive*
   hardware codecs with a `QuotaExceededError` ("codec reclaimed due to inactivity"). That is exactly
   what warm-pool and thumbnail decoders are: open, idle, waiting. We do not know whether Electron's
   `backgroundThrottling: false` on the editor (`src/main/index.ts:166`) exempts a window from it, or
   whether the hidden editor of `--broadcast` counts as backgrounded. **If this is real, it is the
   common trigger** — a show that sits on a state for a couple of minutes, then cuts to a warm MP4.
   Phase 0 settles it.
3. **Corrupt data.** A hardware decoder errors on a malformed frame. (A software H.264 decoder usually
   conceals instead — so whether a given corruption trips this is hardware-dependent, which is why the
   test trigger in §4 W1 does not rely on it.)
4. **`configure()` failing at re-seek** — rare, since `open()` already asked `isConfigSupported()`
   (`:141`), but the code path exists.

## 2. Requirements this must satisfy

- **R1 — No unbounded loop.** No code path in `pump()` may iterate more than a fixed number of times per
  call, whatever state the decoder is in. This is the actual bug; R2–R4 are about what happens next.
- **R2 — Recover automatically.** A decoder that dies is rebuilt and re-seeked to the keyframe covering
  the playhead, with no operator action and no change in the consumer's API.
- **R3 — Do not thrash.** A file that will never decode (permanently corrupt, GPU gone) must not
  rebuild a hardware decoder 60 times a second. Retries back off.
- **R4 — Say so, once.** Each failure and each recovery is one log line (which the console tap already
  carries into the machine log, see [docs/LOGGING.md](../docs/LOGGING.md)), never a flood.
- **R5 — The happy path is unchanged.** Same frames chosen, seamless loop untouched, offline render
  output unchanged.
- **R6 — A deterministic test trigger** that works on any machine, including the Intel dev PC.
- **R7 — A guard**, per `CLAUDE.md`: this bug compiled, booted, threw nothing visible and hung. Add a
  `verify:invariants` check and prove it fails when the rule is broken.

## 3. Architecture at a glance

```
decoder error ──► markDead(err)
                    · record (count, name, message, at which keyframe)
                    · segAbs = -1          ← the next pump must re-seek
                    · keep `buffer`        ← decoded frames stay valid; the picture holds
                    · schedule retry (backoff)

pump() ──► decoder usable?  (exists AND state === 'configured')
             no  ──► retry due? ── no ──► return          (hold the last frame)
                                 └ yes ─► seekSegment(kf) ──► configured? ── no ──► markDead, return
             yes ──► feed, at most QUEUE_BUDGET chunks this call
                       decode() throws ──► markDead, break   (re-seek, never skip a delta)

first frame out after a recovery ──► reset backoff, log "recovered"
```

## 4. Design / approach — workstreams

### W1 — Instrumentation first (so before and after are measured with the same tool)

Same window-guarded diagnostic pattern as `__artluxHapStats` / `__artluxLayerGaps`:

- **`__artluxMp4Stats()`** — per open decoder (pool, key, path): `state`, `errors`, `lastError`
  (`name: message`), `recoveries`, `retryAt`, `feedCapHits`. Plus `__artluxMp4StatsReset()`.
- **`__artluxMp4Fault(kind, path?)`** — test-only fault injection, inert unless called:
  - `'close'` — calls `close()` on the live `VideoDecoder`(s). That puts the codec in exactly the state
    a spec error leaves it in, minus the callback, so it also exercises "died without telling us".
  - `'error'` — routes a synthetic error through the real error handler: the full path.
  - `'configure'` — makes the next `configure()` throw: the second entry (§1).

  Landing W1 **before** the fix means Phase 0 can reproduce the hang deterministically on the current
  code, and the identical calls prove the fix afterwards.

### W2 — The fix, all inside `FileDecoder`

1. **`markDead(err)`**, called from the `error` callback (`:384`), from a `decode()` throw, and from a
   `configure()` throw in `seekSegment`. It records the failure, sets `segAbs = -1`, drops the dead
   decoder, and arms the retry. It **keeps `buffer`** — `VideoFrame`s already output stay valid after
   their codec closes, so `frame()` keeps returning the last good picture while we recover.
2. **`pump()` checks usability before feeding.** If the decoder is not `'configured'`, it re-seeks only
   when the retry is due, and returns without feeding if that fails. This replaces the assumption that
   "`ensureDecoder` returned something" means "something that accepts chunks".
3. **The feed loop gets a per-call bound** (`QUEUE_BUDGET` chunks). In healthy operation it never
   binds: `decode()` increments `decodeQueueSize` synchronously, so the existing condition already exits
   after at most `TARGET_AHEAD` (5) iterations. Its only job is to make an unbounded spin impossible
   whatever the decoder does. Count `feedCapHits` so a cap that does bind is visible.
4. **A `decode()` throw re-seeks instead of skipping.** Skipping one delta frame corrupts every frame
   after it until the next keyframe anyway; re-seeking to the covering keyframe gives a correct picture.
5. **Backoff.** First retry immediately (a GPU reset or a reclaim recovers on the first try), then
   250 ms → 500 ms → 1 s → … capped at 5 s, reset by the first frame out. **A poisoned GOP:** if the same
   keyframe fails three times in a row, start from the next keyframe. There is no terminal "give up"
   state: retrying every 5 s is cheap, and it means a decoder comes back on its own once the GPU does.
6. **`frameExact`** goes through the same `pump()`, so it inherits all of this. Its existing
   `reseeked` rule (`:327`) still decides when a render gives up — an offline render must fail visibly
   rather than retry quietly for ever.

### W3 — The guard

A `verify:invariants` check over `mp4Decoder.ts`:
- the feed `while` in `pump()` carries a per-call counter bound;
- the `VideoDecoder` `error` callback reaches `markDead`;
- the feed's `catch` does not swallow without re-seeking.

Mutation-test each one (remove the bound, watch the check go red), as the repo does for every new guard.

### W4 — Docs

- [docs/CODECS.md](../docs/CODECS.md), MP4 section: what an operator sees if a decode fails (the
  picture holds, then resumes; one log line naming the file), and that a driver reset no longer freezes
  the editor. Operator-tier text, then a contributor-marked paragraph for the mechanism.
- Session record: move the bug's row to *fixed*, link here.
- This file's §11 records what shipped, as the folder's other plans do.

## 5. ⚠️ Breaking changes

**None.** No persisted data, no SDK change, no IPC change, no setting.

One **behaviour change on bad files**, intentional: a chunk that makes `decode()` throw synchronously used
to be skipped, so the following frames decoded wrongly until the next keyframe. Now the decoder re-seeks
and, if that GOP keeps failing, skips to the next keyframe. On a damaged file the picture **jumps one
GOP** instead of showing corrupted frames.

## 6. Risk evaluation — 🟢 Low

- **Blast radius:** one class. Every pool uses the same `FileDecoder`, so the fix reaches surfaces,
  layers, thumbnails and bakes at once — which is also why the test matrix in §8 covers all four.
- **Why the happy path cannot change:** steps 1, 2, 4 and 5 run only after an error. Step 3's bound is
  larger than the number of iterations the existing condition already allows. The frame-selection code
  in `frame()` (`:512-524`) and the loop-wrap logic (`:472-474`) are not touched.
- **Main risk:** a recovery that fires spuriously on a healthy decoder (for example, misreading the
  brief state during a `reset()`/`configure()` pair) would show as an extra re-seek, i.e. a visible
  hitch. `recoveries` and `errors` in `__artluxMp4Stats` must stay at 0 through the regression run.
- **Interaction with the residency work** that follows on this branch: step 3 of that work rewrites the
  feed. The W3 guard keeps this contract through the rewrite.

## 7. Migration & back-compat

None. Nothing is persisted.

## 8. Verification (repo patterns — no unit runner)

**Prerequisites on the RTX machine:** `npm install`; copy the installed build's addons
(`C:\Program Files\ArtLux\resources\*.node`) into `native/*/`, so dev has Art-Net and Spout without a
Rust toolchain; `npm run dev` with `ARTLUX_CDP_PORT` set. Use a **dev instance**, never a show:
reproducing this deliberately hangs the renderer.

**Phase 0 — reproduce on the current code** (W1 landed, W2 not yet):

1. Looping MP4 surface → `__artluxMp4Fault('close')`. **Expect:** the renderer hangs — a CDP
   `Runtime.evaluate` times out, `artlux_render_fps` stops updating, while main's `/metrics` still answers.
2. Same with `'configure'` (the second entry).
3. Timeline layer → `'close'` while playing. **Expect:** a stall that grows with the remaining clip
   length, then a frozen layer that resumes at the next loop wrap.
4. **GPU crash:** CDP `Browser.crashGpuProcess` with a looping MP4 surface. **Expect:** the same hang as
   (1). This is the realistic trigger.
5. **The reclaim hypothesis:** a warm, paused MP4 decoder, editor minimised for 3 minutes, then play.
   Repeat in `--broadcast` (hidden editor). Record whether a `QuotaExceededError` appears and after how
   long. **This decides whether §1 trigger 2 is real.**
6. **Corrupt file:** using `mp4box` from `node_modules`, overwrite bytes inside one delta frame, one
   keyframe, and every frame after the midpoint. Record which variants make the NVIDIA decoder error at
   all; that is a finding in itself.

**After W2 — the same calls:**

7. (1)–(4) again. **Expect:** no hang. `render_fps` stays at ~60. The picture holds, then resumes within
   one GOP. `__artluxMp4Stats` shows 1 error and 1 recovery per decoder. Record the time to recovery.
8. The permanent-corruption file. **Expect:** retries back off to 5 s, renderer CPU stays idle, one log
   line per failure and none in between.
9. **Offline render:** fault mid-bake. **Expect:** either the exact frame after a re-seek, or the bake
   fails with a message — never a silently wrong frame.
10. **Mutation-test W3:** remove the per-call bound → `npm run verify:invariants` goes red; restore → green.

**Regression (R5):**

11. The current long-run monitor (Spout + a heavy looping MP4 on the timeline, 60 fps engine) for at
    least 30 minutes. **Expect:** the same frame rate and dropped-frame counts as the baseline run of
    2026-10-23, no layer gaps at any loop point, and `errors`/`recoveries` at 0 throughout.
12. `npm run verify` green before every commit.

## 9. Effort & phasing — **S**

| Phase | Commit | Content | Effort |
|---|---|---|---|
| 0 | `feat(mp4): decoder stats and a fault hook` | W1, then the Phase 0 reproduction (results recorded in §11) | ~½ day incl. setup |
| 1 | `fix(mp4): a dead decoder re-seeks instead of spinning` | W2, then §8 7–9 | ~½ day |
| 2 | `chore(verify): guard the mp4 feed loop` + docs | W3, W4, §8 10–12 | ~2 h |

## 10. Open questions / decision points

1. **What does the operator see while a decoder is failing for good?** Recommended: hold the last good
   frame through recovery (it is usually under a second), and keep holding it while retries back off.
   The alternative is black after a few seconds, which is the honest-failure doctrine Spout follows
   ([docs/SPOUT.md](../docs/SPOUT.md)). Owner's call.
2. **Should the failure appear in the UI** — a reason line in the content inspector, as Spout has?
   Recommended: not in this fix. Log and stats now; a UI status line later if Phase 0 shows failures are
   common (i.e. the reclaim hypothesis holds).
3. **Ship the fault hook in production builds?** Recommended: yes. It is inert unless called, and the
   app already ships several CDP hooks of this kind (`__artluxBake`, `__artluxProbeSources`).
4. **Is codec reclamation real here?** Answered by §8 step 5, not by debate. If it is, it also bears on
   the residency work: a reclaimed warm decoder holds its whole sample table for nothing.
