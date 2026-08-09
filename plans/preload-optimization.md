# Preload optimization — opening a heavy show without reading it all

> **Status:** ☑ **SHIPPED 2026-08-06** (branch `preload-optimization`, 14 commits, `70ef02f`…`dbf36a6`) ·
> **Placement:** core + `plugins/{hap,mp4,audio}` + one new main-process seam · **Risk:** 🟡 medium —
> touches the media transport for every window, staged so each phase is independently revertible ·
> **Not verified:** projector output windows and real Art-Net to hardware (no projector/LED node available).

The cold-start gate (`services/bootGate.ts`) already held the show until the opening look was decoded, and
it worked — it took a real show from *61 → 22 → 61 fps with 251 ring misses* to *61 fps with 43*. But
everything underneath it scaled with the size of the project rather than with what the show was about to
display, and the gate itself had **never once reached `ready`** on any project: it always failed open at
its deadline, which meant its readiness logic — and the codec pre-roll that exists to serve it — applied
to nothing.

## 1. Results

Measured on a 60-scene / 2400-clip / 24-surface / 3000-LED fixture over 2.3 GB of **real** media (14 HAP +
10 H.264), and — for the gate — on a real venue project.

| | before | after |
|---|---|---|
| bytes read over IPC at open | **887 MB** | **0 MB** |
| renderer heap | 1459 MB | **326 MB** |
| peak main RSS | 1963 MB | **284 MB** |
| codec residency, walking show | 3793 MB, climbing | **~250 MB, flat** |
| cold-start gate, real project | 17.1 s, `armedBy=timeout` | **7.3 s, `armedBy=ready`** |
| standby warm pools | 3, budget unenforced | **2 of 2** |
| warm scene's audio resident | 0% | 69% at a 6 s dwell (31% at 1 s) |

## 2. What changed

- **Media streams instead of being read whole.** `artlux-media://` (`shared/mediaUrl.ts`,
  `src/main/mediaProtocol.ts`) answers HTTP Range from a read stream, admitted by a per-project allowlist
  (`src/main/mediaAccess.ts`) rebuilt on every open. `mediaCache`'s blob path is **deleted** — after the
  migration it had no consumers. See [ARCHITECTURE.md → Media transport](../docs/ARCHITECTURE.md).
- **Warming is a relevance window**, not the whole document: each layer's start clip plus a look-ahead,
  advanced by `frame()` while playing (`services/timeline.ts`).
- **The residency budget binds.** `evictExcess` counts protected pools; `services/smLookahead.ts` ranks
  reachable states by how soon their trigger can fire and includes `fromAny`; `services/codecResidency.ts`
  gives a demoted pool a release path it never had, and unifies the two refcounts that let the gap survive.
- **The gate's buffer guarantee is codec-agnostic** — mp4 gained `preRoll` and `preWarmLayer`
  (`VideoCodecContribution`), and no longer waits minutes on an audio conform.
- **Progress is a ledger**, keyed on identity rather than the display label, plus a phase word.
- **Warm scenes keep their sound** via a new `PreloadService` seam — core drives it, the audio plugin
  rides it, and neither imports the other.
- **The media library** windows its grid and persists thumbnails in `<project>/.artlux-cache/`.

## 3. Three bugs only the measurements found

1. **The gate waited on audio conforms that take minutes.** A conform is a transcode (two decode passes
   per file); nine in parallel reached ~40% after 75 s and a closed app discarded the partial work. Bounded
   to 2.5 s — long enough for a cached conform, not for a transcode.
2. **HAP keyed its decode ring by path only**, so a file on both a surface (free-running clock) and a
   layer (playhead) had two playheads over one ring, each evicting the other. 88% ring miss.
3. **A pre-roll shared its retention claim with playback** — same layer, two questions, one `windows`
   entry, so each overwrote the other every poll. Found on a real project: a 1 GB clip cycling
   0 → 3 → 0 MB, never accumulating. This is what kept the gate from ever reaching `ready`.

…plus one shipped and caught inside the same wave: **mp4's `preRoll` was unsatisfiable by construction**,
asking for more frames than `pump()` will ever hold. It compiled, threw nothing, and held every show with
an `.mp4` in its opening scene to the full timeout.

## 4. Dropped on its own evidence

The plan's "make the open O(1) in scene count" phase was **not implemented**. Sweeping 1/40/160 scenes:

| scenes | read | parse | resolve | normalize (renderer) | apply-total |
|---|---|---|---|---|---|
| 1 | 8 ms | 2 ms | 1 ms | 0.6 ms | 4.9 ms |
| 160 | 21 ms | 12 ms | 30 ms | **3.3 ms** | 8.1 ms |

The per-scene `normalizeTimeline` it targeted costs 3.3 ms at 160 scenes; the whole document pipeline is
~71 ms against a 13-second hold. Memoizing it would optimize a rounding error, and its blast radius —
every consumer of `scene.timeline` — was the largest change in the plan. **Do not revive this without a
measurement showing parse dominating.**

## 5. What breaks

- **One new persisted field:** `SmTransition.waitForContent` (absent ⇒ fire immediately, so every existing
  project is unchanged). No migration.
- **`ArtluxApi` gains** `perfOpenArmed`, `thumbGet`, `thumbPut`; **`BootService` gains** `elapsedSec()`;
  **`RendererHostServices` gains** `preload`. All additive.
- **`VideoCodecContribution` gains** optional `preWarmLayer`, `residentBytes`, and a fourth `layerKey`
  argument to `preRoll`. Omitting any of them keeps the previous behaviour.
- **The renderer no longer reads media over IPC.** Anything reintroducing `ensureBlobUrl` for pictures or
  sound is rejected by `verify:invariants`.

## 6. Guarding

12 new checks in `scripts/verify-invariants.cjs` (121 total), each verified to go red when its bug is
re-introduced. Pure logic is asserted in `scripts/test-lookahead.ts` (14) and `scripts/test-mediagrid.ts`
(25) — the latter caught a 99843px spacer against 1380px of content on the first run.

## 7. Measuring it again

```bash
node scripts/gen-heavy-project.cjs --out .traces/bench/x --scenes 60 --media <dir> [--dwell 1]
npm run build          # the bench must measure the BUILT app — vite's dev cost is measured as ours
node scripts/bench-open.cjs --project .traces/bench/x/project.artlux --runs 3 [--baseline <prev>.json]
node scripts/bench-warm.cjs --project .traces/bench/x/project.artlux --seconds 40
```

Diagnostics on `window`: `__artluxOpenTrace`, `__artluxBootGate`, `__artluxWarmPools`,
`__artluxCodecResidency`, `__artluxAudioResidency`, `__artluxThumbs`, `__artluxHapStats`.

⚠ Launching the app from a tooling shell needs `ELECTRON_RUN_AS_NODE` unset, or Electron boots as bare
Node and dies at `app.getVersion()`.

## 8. Method notes worth keeping

- **A check that finds nothing passes.** Three times here: an invariant using `fnBody()` on an
  object-literal method (returned `null`, and `if (body && …)` passed); a UI probe that counted zero chips
  and declared virtualization working; a bench fixture whose clip paths deduped, so old and new code read
  identical files and the bench reported a clean 0% delta. Each was caught by deliberately re-breaking the
  thing and watching the check go red — do that for every new guard.
- **Process memory was the wrong instrument** for residency: it varied ~900 MB run-to-run, wider than the
  effect being measured. `bench-warm.cjs` asks the app what it holds instead.
- **Assert the contract, not a coincidence.** A test requiring the boot ledger's `total` to *grow* was
  wrong — growth is possible, not required. The contract is "never shrinks".

## 9. Open

- **Projector output windows and real Art-Net to hardware are unexercised.** The projector bridge gained a
  `phase` field. Exercise a fullscreen output before a show.
- **Audio is verified on residency, not on sound.** Asserting a sting's attack needs playback capture.
- **mp4 still buffers the whole file to demux** (one copy, down from two). Progressive `appendBuffer` with
  a tail Range fetch for a non-faststart `moov` is the remaining win.
- **The byte ceiling (`MAX_RESIDENT_MB`) can only evict standby pools**, and most bytes live in the active
  one — so it is a backstop, not an allocator. Not yet wired to a preference.

## 10. The sequel this work uncovered: the engine was asking too fast

Once shows opened quickly, the owner tested playback and found what preloading had been masking — heavy
video *stuttered while running*. A looping clip, or a track with several clips, visibly stopped and
started. It presented as a **preload** problem ("as if we load the video when the playhead reaches it"),
and it was not one.

**Three fixes aimed at the decoder failed.** Raising the loop's pre-roll landed the wrap on cached frames
but still dipped. A standing retention claim across the wrap was reverted after a bad report — and the
report was probably wrong: the app had stale HMR state that had stopped the FSM ticking altogether, an
unrelated bug. Raising HAP's `MAX_INFLIGHT` from 3 to 6 moved the miss rate 18.1% → 20.6%, i.e. nowhere.

**The cause was the ask rate.** Every engine tick asks each layer's codec for the exact frame at the
playhead. Asking faster than the decoder can serve does not produce more pictures — it produces misses,
and the ring answers with the *nearest* frame it holds. A burst of those is the stutter. The engine ran
at display rate, so on heavy media it was asking for frames nobody could supply.

| engine rate | exact frames missed | worst half-second | scene cuts |
|---|---|---|---|
| uncapped (~60 Hz) | **19.0%** | 78 | visible hitch |
| 25 Hz | **0.27%** | 9 | 4 of 4 clean |

**What pointed there**, after the guesses: the **projector** window — decoding the same media, but only
for the one surface it draws — missed **0.007%** throughout. The window doing *more* work barely
suffered, which is an argument against the decoder and for how often it was being asked.

Shipped as **Preferences → Engine → Engine rate (fps)**, default 30, machine-scoped: the right value
depends on the computer, not the show. It is **not** the Art-Net rate — the native pacer sends at
`AppSettings.fps` with keep-alive, so a slower engine repeats the last frame on the wire rather than
starving a node. (That warning was given wrongly here first, then checked and corrected.)

The instrumentation ships with it, because three wrong guesses came first: `__artluxLayerGaps()` (clip
switches vs frames where a layer had no picture) and `__artluxHapPulls()` (who pulls a ring, at which
index, with what cached). Both are measure-only.

**The method lesson, and it generalises past this repo:** resident bytes tell you something is cached —
never that the frame being *asked for* is there. Both failed fixes reported success against residency
while the operator still saw a hitch. Measure the question the consumer actually asks.

## 11. What the status-bar chip is actually counting (measured 2026-08-09, NOT fixed)

The owner asked whether the launch preload covers all scenes or only the first ones, and then said the
chip at the bottom of the window read differently from the answer. It does. **Nothing was changed** —
this section is the record so the next person does not have to re-measure.

**The scope, from `bootGate.collect()`:** the *pictures* are one look — the scene bound to the FSM's
initial state, and within it only the frame the timeline opens on (`poolReadiness`, `startClip` per
layer). But the two other contributors are **not** scene-scoped: `surfaceMedia.pendingMedia` walks
`data.surfaces` (the document's whole surface list), and the audio probe's `allClips()` is
`bed ∪ the bound timeline ∪ video audio` — and the bed is show-clocked, i.e. project-wide. So "the
preload is one scene" is true of video and false of the fraction.

**Measured on the owner's real project** (`Documents/projetled/artlux-project.artlux`, 6 scenes /
18 clips, built app, `--headless --project=`), gate armed by `ready` in 6.6 s with **12 items**:

| t | chip | pending |
|---|---|---|
| 0.5–2.7 s | `0/7 audio` | 5 × `conform: *.mov`, 2 × `*.mov (hap)` |
| 2.8–6.0 s | `5/7 warming` — **frozen 3.2 s** | only the 2 HAP probes |
| 6.05 s | `5/12 audio` — **denominator jumps** | 2 × `(buffering)` + 5 new `audio: <hash>.wav` |
| 6.6 s | armed `ready`, 12/12 | — |

**The 12 items are 5 files.** Scene 1 holds five clips; each is counted once as `conform:` and again as
its conform output (`AppData/Roaming/artlux/audio-conform/<hash>.wav` — verified by hash), and the two
HAP ones a third time for probe + pre-roll. Three genuinely distinct waits, one asset. Nothing came from
another scene here: the bed is empty and the single surface is a `LAYER` source, so `pendingMedia`
contributed **zero** — the project-wide path exists but did not fire.

**Three defects in the readout, all display-only:**
1. **The phase word is wrong for HAP, for half the boot.** `phaseOf` tests
   `/\(buffering\)|\(.*codec.*\)|^Surface /`. `(mp4-webcodecs)` matches `.*codec.*`; **`(hap)` matches
   nothing** — so the 3.2 s stretch where two HAP codecs are probing reads `warming`. That is exactly the
   frozen-fraction moment the phase word was added to explain.
2. **`^Surface ` matches a surface NAME, not a source.** `pendingMedia` emits `` `${s.name || s.id}: file` ``,
   so the test only works while surfaces keep their default names; rename one to "Wall Left" and its
   pending line stops reading as `decoding`.
3. **`total` grows late and the bar goes backwards** — 5/7 (71%) → 5/12 (42%), because the conformed WAVs
   cannot exist as ledger keys until the conforms land. The ledger's growth is by design; here the growth
   is the same five assets re-entering under names nothing can relate to the originals.

**Why it was left alone.** The show-critical boundary is *when the gate arms* — `pending.length === 0`
and the timeout — and none of the above touches it. A safe fix exists (tag each line inside `collect()`,
which already calls the three contributors separately, so no signature and no SDK change; then derive the
phase from the tag instead of from display text). The unsafe half is collapsing 12 into 5: **there is no
shared identity to dedupe on** — `0f0e8055….wav` cannot be related to `Drums_Verse_GFX.mov` without the
conform table, which only the audio plugin holds, so it needs a `ReadyProbe` signature change; and
`pending.length` is already published as `bootPending` through `@artlux/sdk`'s show status and rendered
on the tablet as "*n* item(s) left". Prettier count, less truthful tooltip, three surfaces moved.

**Measuring it again — `bench-open.cjs` CANNOT answer this.** It reads the gate only after it has armed,
when `pending` is empty by definition. Poll `__artluxBootGate()` *during* the hold, and install the
recorder with `page.evaluateOnNewDocument()` + `page.reload()` — attaching over CDP the ordinary way cost
11 s on the first attempt and had already missed 3 of the 11 items. The reload works because the project
path rides in the window's URL query (`editorQuery()` in `main/index.ts`), so it re-runs the whole open.
The throwaway script lived at `.traces/probe-boot.cjs` (gitignored, not committed).
