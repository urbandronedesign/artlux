# Audio Scoping (Wave B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Ground truth:** [`.superpowers/sdd/wave-b-ground-truth.md`](../../../.superpowers/sdd/wave-b-ground-truth.md) — six agents read the code and mapped every surface this touches. Where the design spec ([`plans/timeline-transport-and-audio-scoping.md`](../../../plans/timeline-transport-and-audio-scoping.md)) disagrees with it, **the ground truth wins**. Every `file:line` in this plan came from it or was re-verified by reading the file.

**Goal:** The global audio bed keeps playing, uninterrupted, across scene recalls — because it rides its own **show clock**. Audio becomes a first-class timeline lane (drag, trim, blade, fade handles) instead of a numeric `@ N s` field. The Audio Bed panel becomes a real **mixer** whose clip inspector follows the timeline selection. And scenes/cues can recall audio parameters with a fade, where an automation lane always wins.

**Architecture:** ONE transport, TWO playheads.

```
                 ┌── playing (ONE flag) ──┐   ONE transport: one play state, one set of
                 │  ONE rAF, ONE frame()  │   decoding <video>s, one pool of layers.
                 └───────────┬────────────┘
            ┌────────────────┴─────────────────┐
            ▼                                  ▼
      showTime                            playhead
   showOriginMs (NEW)                     originMs
   the SHOW clock                         the SCENE clock
   ─────────────────                      ─────────────────
   • ProjectData.audio (the bed)          • video (the BOUND Timeline)
   • the GLOBAL timeline's automation     • Timeline.audio of the BOUND doc
     (the base layer)                     • the BOUND doc's automation lanes
   • bounded by the GLOBAL doc's          • bounded by the BOUND doc's
     [timelineStart, timelineEnd)           [timelineStart, timelineEnd)

   scene recall  → PRESERVED              scene recall  → RESET to the scene's in-point
   exit to Global→ PRESERVED              exit to Global→ RECONVERGES onto showTime (D7)
   seek (Global bound) → moves with it    seek → always moves
   seek (scene bound)  → does NOT move

   While Global is bound the two are THE SAME NUMBER (an identity the engine maintains).
   The instant a scene is bound they diverge: the scene restarts, the bed rolls on.
```

**Tech Stack:** Electron 42 · React 19 · TypeScript (strict) · Tailwind (design tokens only) · `requestAnimationFrame` engine in `src/renderer/services/timeline.ts` · native JUCE audio engine behind `plugins/audio` (IPC only; **zero direct native calls from the renderer**).

---

## Global Constraints

**Every task's requirements implicitly include this section.** Read it before writing any code.

### The seven hard invariants — violating one is a CRITICAL defect

1. **The engine NEVER writes the `playing` flag.** App is the single writer; the engine emits a `TransportIntent` (`timeline.ts:72` `emitIntent`, consumed at `App.tsx:1253-1290`).
2. **Mirror/projector windows (`external === true`) run NO transport logic and emit NO intents.** They phase-lock with a 10 %/update slew, snapping only when `|err| > 0.5 s` (`timeline.ts:733-748`, `SLEW = 0.1` at `:95`).
3. **The playhead NEVER enters React state.** It is painted imperatively 60×/s (`Timeline.tsx:118-123`).
4. **The playhead is DERIVED as `(now - originMs) / 1000`, never accumulated.** Every branch that moves time must re-anchor `originMs`, and if the move is a JUMP it must re-baseline `prevPlayhead` — otherwise `fsm.tick(playhead, prevPlayhead)` sees a window that never happened and fires PHANTOM SCENE RECALLS (the wrong scene on stage). **The same rule applies to `showTime` and its own origin.**
5. **`hitEnd` is a ONE-FRAME pulse with exactly ONE reset** (`timeline.ts:432` clear, `:513` set, read only at `:106`). A document swap must never pulse it.
6. **`normalizeTimeline` runs on every load with NO try/catch and NO ErrorBoundary.** It must never throw and never emit junk a consumer iterates. Rule: **COERCE, DO NOT DROP.**
7. **A drag must NOT commit into App per pointermove** (`onChange` → `setTimeline` → `engine.setData` → `warmMedia` + `pruneStaleLayers` + `compileAutomation` + a `postMessage` to every projector port). Draft locally, commit ONCE on pointerup.

### Verification reality — THERE IS NO TEST RUNNER IN THIS REPO

Do not write test files. Do not plan a "run the tests" step. The gates are:

- `npx tsc -p tsconfig.json --noEmit`   (exit 0)
- `npm run build`                        (exit 0)
- `npm run verify:plugins`               (**runs against BUILT output** — a stale `dist/` will lie to you)
- design-token grep: `git grep -n "text-\[[0-9]" -- src/renderer/components/timeline/` must print **NOTHING** (10 px floor → use `text-micro`; no raw hex in `className`; named z-tiers for cross-app overlays)
- a HUMAN live smoke test at the end.

Where an engine change has subtle timing behaviour, the task **MUST prove it with a standalone Node simulation** that steps frames and prints the clock values. Inspection is not proof. This is how Wave A's blockers were caught and how its fixes were validated.

**IMPORTANT: the dev app MUST BE CLOSED for any native rebuild** — a running app locks `audio_engine.node`, the link fails with `LNK1104`, and it **SILENTLY LEAVES THE STALE `.node` IN PLACE**. (No task here rebuilds native, but the live smoke test runs the app.)

### Branch & commits

Branch `wave-3-audio`. Commit after every task. Do **not** merge to `main` — the user merges explicitly.

---

## Design calls this plan makes (the spec + ground truth did not settle them)

| # | Question | Decision | Where |
|---|---|---|---|
| **DC1** | Where does the show-clock reset policy live? `mainSeek` is reached from 5 semantically distinct events. | It **cannot** live in `mainSeek`. The engine maintains the **identity** (`activeKey === GLOBAL_POOL ⇒ showTime tracks playhead`) inside `seek()` and `setPlaying(true)`; every other move is an **explicit** `showSeek()` from a named call site or an explicit `swap()` option. | Task 2 |
| **DC2** | Is the show clock bounded when the global doc's `loop` is OFF? | **Yes — it PARKS at `globalEnd - frameSec`**, exactly like the playhead. If it ran unbounded, the "while Global is bound the two are the same number" identity would break the instant the global doc ended. ⇒ *the global timeline's Length is the SHOW's length; the bed lives inside it.* **BUT THE PARK MUST BE OBSERVABLE (DC2b).** | Task 2 |
| **DC2b** | A parked show clock is a **frozen number handed to a live driver**, and that is a defect, not a no-op. `reconcile()`'s drift re-lock (`plugin.renderer.ts:211-219`) compares a `desired` source offset derived from the clock against an `estimated` one that advances in **real time**: with the clock frozen the two diverge past `SYNC_THRESHOLD = 0.05` every ~50 ms, and the driver re-seeks the clip back to the same offset **forever — a 50 ms buzz loop, not silence.** The park frame's own Δ (≈ −0.017 s) is far under `SEEK_THRESHOLD = 0.2`, so `seeked` never fires and the driver never leaves the `else if (playing) reconcile(...)` arm. Today this is impossible: when the BOUND doc end-stops it emits `pause` → `playing` false → `stopAllSounding()`. Under the show clock, `playing` stays **true** (a scene is looping underneath) and nothing stops the bed. And it is the **default** configuration — `defaultTimeline()` is `{duration: 60, loop: false}` (`types.ts:396-399`). | **The park is PUBLISHED, not inferred.** `getStatus()` carries `showEnded` (`= isShowAtEndBound()`), and the driver **stops the bed and skips `reconcile()`** for the bed container while it is true. The show clock stays silent (no intent, no `hitEnd`) — it is *observable*, not *chatty*. | Task 2, 3, 6 |
| **DC3** | The show clock's own end-stop / wrap — does it emit `pause` or pulse `hitEnd`? | **NEVER.** The show clock emits no `TransportIntent` and pulses no `hitEnd`: it only wraps or parks. (Spec :121 already forbids the show clock firing `onTimelineEnd`.) *"Silent" means it never drives the transport or the FSM — it does **not** mean invisible: the park is readable through `getStatus().showEnded` (DC2b), because a consumer riding a frozen clock has to know it is frozen.* | Task 2 |
| **DC4** | Ground-truth §C-1: the global loop wrap is a >0.2 s backward jump the driver reads as a seek → `stopAllSounding()` every lap. | **That is CORRECT and intended.** Under WS-B1 the driver rides `showTime`, so a *scene's* loop wrap no longer touches the bed at all (the real bug). The *show's* own wrap SHOULD restart the bed — it is the show looping. No wrap-aware driver path is built. | Task 2, 6 |
| **DC5** | Ground-truth §C-2: `clampPlayheadIntoDoc` emits `pause` and is reached from `swap(..., 'preserve')`. | D7's **reconverge** replaces it: exit-to-Global sets `playhead := showTime`, which is *by construction* inside `[globalStart, globalEnd)`. `transport: 'preserve'` is **replaced** by `transport: 'reconverge'`; `clampPlayheadIntoDoc` survives only as `setData`'s document-edit guard. **⚠ ONE CASE IS NOT FREE (DC5b).** | Task 2 |
| **DC5b** | "Inside `[globalStart, globalEnd)`" ⇒ "nothing to clamp and **nothing to pause**" is **FALSE at the boundary.** With global loop off, a parked show clock is *exactly* `globalEnd − frameSec` — the last frame, **one rAF inside the end**. `mainSeek` **clears `endLatched`** (`timeline.ts:292`), so one or two frames later the raw clock crosses `b` and takes the end-stop (`:480-516`): `endLatched = true`, **`hitEnd = true` (`:513`)**, `pause` (`:555`), and `fsm.tick` sees `atEnd` ⇒ **an `onTimelineEnd` transition fires from a mouse click.** That violates **invariant 5** ("a document swap must never pulse `hitEnd`") and is exactly what `clampPlayheadIntoDoc`'s latch-**without**-pulse exists to prevent (`timeline.ts:325-326`: *"the machine must never be advanced by an edit or a click"*). Reachable from the pill → Global **and** from deleting the bound scene (`App.tsx:673`). | **The `'reconverge'` arm re-applies the latch when the show clock is parked**, with `clampPlayheadIntoDoc`'s exact treatment: `mainSeek(showTime); if (showAtEndBound()) { endLatched = true; emitIntent({kind:'pause'}); }` — **latch without pulsing `hitEnd`**, and emit the `pause` (the show genuinely is over: D4's "stop + hold on the last frame"). In the normal case — a show clock anywhere short of the global end — nothing latches, nothing pauses, and D7's whole point survives intact. | Task 2 |
| **DC6** | Where do base (global) automation lanes sample from? Two shapes only; the spec picks neither. | **Shape (a):** `LaneRT` gains `clock: 'show' \| 'scene'`, set at compile time in `compileAutomation`, and `sampleAutomation(playhead, showTime)`. No second array. Preserves H-4's same-frame ordering. **TAGGED BY *DOCUMENT*, NOT BY LIST (DC6b).** | Task 2 |
| **DC6b** | Deriving the tag from *which list a lane came from* is wrong, because `activeKey === GLOBAL_POOL` is **not** the only way the **global document** is bound. `App.tsx:663`: a scene with **no timeline of its own** binds `timeline` — the GLOBAL doc — under `activeKey = scene.id` (a documented, supported shape, `App.tsx:1282-1283`). `compileAutomation` then sees `active = data.automation` = **the global timeline's own lanes**, and `base = baseAutomation.filter(l => !activePaths.has(l.targetPath))` = **`[]`** (every base lane is shadowed *by itself*). Every global lane would be tagged `'scene'` and would restart from t=0 on every GO — including a lane driving `audio.master.gain`, which **snaps the bed's level** while the bed itself plays on at 4:30. Same root, second symptom: `seek()`'s identity would not fire there either, so the ruler the operator is scrubbing (`activeTimeline = activeScene?.timeline ?? timeline` — **the global doc**) would move the picture and not the bed. | **One predicate, used by both:** `isGlobalDocBound() ≡ activeKey === GLOBAL_POOL \|\| data === globalDoc`. `compileAutomation` tags `active` lanes `clock: isGlobalDocBound() ? 'show' : 'scene'` (and `base` is `[]` there, unchanged — the global doc must not stack on itself); `seek()`'s identity tests the same predicate. When Global is *genuinely* bound the two clocks are the same number, so `'show'` is safe. **Consequence, stated so nobody "fixes" it:** under a timeline-less scene the global *picture* restarts while the global *curves* continue on the show clock. That is the base-layer doctrine applied consistently (a base lane is the SHOW's automation), and a global lane driving a *core* param under a recalled scene is already fighting that scene's look. | Task 2 |
| **DC7** | `sampleAutomation` runs OUTSIDE the `playing` gate (scrubbing moves curves). Does a `playing`-gated `showTime` break that for base lanes? | **No.** While paused, `showOriginMs` is re-anchored every frame, so `showTime` is a stable readable number. While **Global** is bound, scrubbing moves `showTime` too (the identity) — base lanes behave exactly as today. While a **scene** is bound and paused, scrubbing moves only the scene clock and the global (base) curves hold — which is the entire point of the split. | Task 2 |
| **DC8** | How does the driver receive `showTime`? Widen the SDK `onPlayhead` payload, or add a getter? | **A getter.** `timeline.getShowTime()` polled inside the driver's existing `tick`. Strictly cheaper, zero SDK churn, and it preserves H-4 (the sampler runs before `subs.forEach`, same frame). | Task 2, 6 |
| **DC9** | D8 says "Wave A's *content past the end* ruler warning + one-click *Length → content end* fix already cover this; extend them to count audio clips." | **THEY DO NOT EXIST.** Wave A shipped the `normalizeTimeline` one-shot duration raise + `boundedDuration` marker instead (`types.ts:594-607`); grep for a ruler warning returns nothing. So this plan **BUILDS** the overrun badge + one-click fix, counting video **and** audio clips, and audio clips do **not** extend `Length` (the `duration` raise stays video-only). | Task 5 |
| **DC10** | How does a **core** `AudioLane` learn a dropped audio file's duration? `audioClient.loadClip` is plugin-side, and `AssetEntry.durationSec` is **not populated** on import (`projectFolder.ts:159-173` mints `{id,name,type,path,size,addedAt}` — no `durationSec`). | **Core probes with an offscreen `<audio>` element**, exactly as `Timeline.tsx:426-429` probes video with an offscreen `<video>`. `mimeForPath` (`mediaCache.ts:12`) already maps wav/aiff/flac/ogg. The NATIVE engine still loads the file itself for playback (`syncLoaded` → `audioClient.loadClip`). Same split as video: core probes, the engine decodes. **No SDK change, no plugin coupling.** | Task 5 |
| **DC11** | Ground-truth §4.4: `automationOverlay.owns()` is core-only; the SDK provider has no `owns()`; `transitions.ts:97` cannot learn that an audio lane owns `audio.master.gain`. "A lane always wins over a scene fade" is unenforceable across the plugin boundary. | **The seam is opened as a READ-ORDER precedence inside the provider, not as an `owns()` query across the boundary.** `AutomationTargetProvider` gains an **optional** `writeFade(path, value)`: a scene/cue fade writes to a **SEPARATE** override layer the provider owns. The driver reads `lane-override ?? scene-fade ?? authored`. A lane therefore wins **structurally**, and a lane's `release()` can never nuke a live fade (different map). `transitions.ts` routes a leg by head: core heads → `setByPath` (unchanged); any other head → `registry.get(head)?.writeFade?.(...)`. **No `owns()` is added and `StateView` is NOT widened** (H-5's 9 sites and Stage's 2 per-frame allocations are dodged entirely). **THE LAYER NEEDS THREE MORE MEMBERS (DC11b).** | Task 9 |
| **DC11b** | A write-only `fade` map is a **trap**: a fade's value *persists* by design, so the moment any scene or cue touches `audio.master.gain` (D5's headline), `fade.get('audio.master.gain')` is set **forever**. `effGain`/`syncMaster` read `laneOvr ?? fade ?? authored` — so the mixer's **master fader goes DEAD for the rest of the session** (and across a project open: the map is module-level and the plugin is never deactivated). Same for any clip/track gain a cue ever faded. An automation lane does not have this bug *precisely because it has a `release()`*, and this codebase's own doctrine names the failure (`timeline.ts:401-408`: a dropped target *"must be handed back to manual control, or the target would be STRANDED at the outgoing curve's last value forever"*). Second trap: `applyAudioEntries` builds a fade's `from` with `provider.get(path)`, which is `enumerate().find(...)?.def` — **the AUTHORED value** (`automationTargets.ts:168-170`). So a *second* recall of the same path starts from the authored value: scene A fades master 1.0 → 0.2; scene B fades it → 0.5; frame 1 of B's fade writes ≈ **1.0** — a full-scale pop on every recall after the first. | The provider gains **three** more optional members beside `writeFade`: **`releaseFade(path)`** (a manual fader move is a **takeover** — the mixer clears that path's fade entry), **`releaseAllFades()`** (App calls it on project open, through the registry), and **`getLive(path)`** (`laneOvr ?? fade ?? authored` — the fade's `from` must be the **effective** value; `get()` stays authored so lane seeding is unchanged). | Task 9, 10 |
| **DC12** | `paramPath`'s grammar is hardwired to `<head>.<id>.<leaf>` via `slice(2)`; audio is one segment deeper. | Introduce **one** exported head-aware helper, `pathLeaf(path)`, and use it in `isGeometryPath`, `isFadeablePath` and `CueBankPanel.labelForPath`. `getByPath`/`setByPath` are **NOT** extended for audio — audio is not in `StateView` and never will be; audio reads/writes go through the registry. | Task 9 |
| **DC13** | D5: how does a **Scene** carry audio, given `buildSceneSnapshot` captures whole slices and its fade only diffs the 3 `StateView` fields? | **`Scene.audio?: CueEntry[]`** — a scene carries an explicit list of `{path, value}` audio entries, the exact `CueEntry` shape. Recalled through the same fade-leg path as `applyCues`. This dodges the snap-vs-fade ambiguity entirely (there is no whole-mix snapshot to classify) and gives the FSM audio recall for free (`fireCue` / `recallScene` both already route through `handleRecallScene` / `applyCues`). | Task 10 |
| **DC14** | WS-B3's "clip inspector follows the timeline selection" — the selection is `useState` local to `Timeline.tsx:65` and `docs/TIMELINE.md:110-113` forbids it entering the `Timeline` data type. | **A new render-free selection singleton** (`services/selection.ts`, modelled on `automationOverlay`) that `Timeline.tsx` writes and a new `host.show.getSelection()` / `subscribeSelection()` slice exposes. Selection stays ephemeral and never enters `Timeline`. The mixer stays in the plugin (moving it to core would drag `audioClient` + the native engine into core). | Task 7 |
| **DC15** | `AUDIO_FADEABLE_RE` admits `fx.<id>.<param>` — and **some of those are LOG-CURVE params** (`effectDefs.ts:66` `cutoff` 20–20000 Hz `curve:'log'`; `:93` `timeMs`; `:106-107` `attackMs`/`releaseMs`). The automation engine honours the curve (`LaneRT.log` → `sampleLane(..., rt.log)`, `timeline.ts:355`/`:420`; the SDK contract states it, `renderer.ts:75`). **The fade engine does not**: `FadeLeg` carries no `log` and `apply` is `leg.from + (leg.to − leg.from) * ease(t)` — pure linear (`transitions.ts:100`). A cue fading a cutoff 200 Hz → 8 kHz over 3 s is past 4 kHz in the first ~700 ms; the *same move drawn on a lane* sounds nothing like it, and that is the comparison the operator makes in the room. | **Carry `log` on the leg.** `FadeLeg` gains `log?: boolean`; `ActiveLeg` gains `log: boolean`; the **plugin-leg branch** of `apply()` interpolates in log space when set (with a `from > 0 && to > 0` guard — a hand-authored 0 falls back to linear rather than producing `−Infinity`). `applyAudioEntries` reads `log` from `provider.enumerate()`'s def. Core legs are untouched. | Task 9, 10 |
| **DC16** | Task 10 must write **`Scene.audio`** (D5's headline), but `CueBankPanel`'s capture picker is **structurally incapable of writing anything but the selected cue**: `captureEntry` opens with `if (!selCue) return;` and commits with `patchCue(selCue.id, …)`; `removeEntry` / `setEntryValue` / `setEntryFade` / `setEntryTransition` are all `selCue`-bound; every `CaptureGroup` takes `cue={selCue}` (`:301-307`, `:320-329`). A `♪` button and one prop cannot invent a second target. | **Make the picker's commit target an interface.** `type CaptureTarget = { key: string; label: string; entries: CueEntry[]; setEntries: (e: CueEntry[]) => void; audioOnly: boolean }`, satisfied by a **Cue** (`setEntries: e => patchCue(cue.id, {entries: e})`) or a **Scene** (`setEntries: e => onUpdateSceneAudio(scene.id, e)`). All **five** entry mutators drive off it, and `CaptureGroup`'s `cue: Cue` prop becomes `entries: CueEntry[]` (it only ever reads `cue.entries`). A scene target sets `audioOnly` ⇒ the picker renders **only** the plugin groups (a `Scene.audio` is an audio list by DC13). This is a task-sized step, not a prop. | Task 10 |

---

## File structure

| File | Created / Modified | Responsibility | Task |
|---|---|---|---|
| `src/main/projectFolder.ts` | **modify** | `mapAssetPaths` → four container visitors (`mapSurfaces` / `mapScene3D` / `mapTimeline` / `mapAudio`) applied to the top level **and every scene** and the bed. Widens the `:67` guard to include `tl.audio?.clips`. | 1, 4 |
| `src/renderer/services/timeline.ts` | **modify** | `showTime` + `showOriginMs` + `globalDoc`; `setGlobalDoc` (which also re-anchors the show clock) / `getShowTime` / `getGlobalStart` / `getGlobalEnd` / `isShowAtEndBound` / `showSeek`; `isGlobalDocBound()`; the identity rule inside `seek()` and `setPlaying()`; `transport: 'reconverge'` (replacing `'preserve'`, **with the parked-clock latch**); `LaneRT.clock`; `sampleAutomation(playhead, showTime)`. | 2 |
| `src/renderer/App.tsx` | **modify** | push the global doc to the engine; Stop → `showSeek(globalStart)`; New Project → `showSeek(globalStart)`; `exitToGlobal`/`handleRemoveScene` → `'reconverge'`; `applyProjectData` → `showClock: 'reset'` + `releaseAllFades()`; `getStatus().showTime` / `.showEnd` / `.showEnded`; `host.audio.getTimelineAudio()`; usage + relink for `Timeline.audio`; `audioMix` down to the timeline panel; the selection slice on `host.show`; `applyCues` (**per cue**) + `handleRecallScene` audio legs; `handleUpdateSceneAudio`. | 2, 3, 4, 5, 6, 7, 9, 10 |
| `src/renderer/types.ts` | **modify** | `Timeline.audio?: TimelineAudio`; `sanitizeAudioClip`; `sanitizeAudioTrack`; `normalizeTimelineAudio`; `normalizeAudioMix` reuses the sanitizer; `Scene.audio?: CueEntry[]`. | 4, 10 |
| `src/renderer/services/paramPath.ts` | **modify** | `pathLeaf()`; `isFadeablePath` gains an `audio` arm + `AUDIO_FADEABLE_RE`. | 9 |
| `src/renderer/services/transitions.ts` | **modify** | route a leg's write by head: core → `setByPath`; else → `registry.get(head)?.writeFade?.()`. `FadeLeg.log` / `ActiveLeg.log` — a log-curve target interpolates in log space (DC15). | 9 |
| `src/renderer/services/selection.ts` | **create** | render-free selection singleton (`set`/`get`/`subscribe`). | 7 |
| `src/renderer/services/assetLibrary.ts` | **modify** | `usageIndex` also counts `tl.audio?.clips[].path` (and the two paths it already misses). | 4 |
| `src/renderer/components/timeline/AudioLane.tsx` | **create** | the audio lane: clips, waveform, drag/trim/blade, fadeIn/fadeOut corner handles, gutter (AutomationLane idiom). | 5 |
| `src/renderer/components/timeline/audioPeaks.ts` | **create** | cached peaks extraction via `AudioContext.decodeAudioData` (path-keyed, deduped). | 5 |
| `src/renderer/components/timeline/Timeline.tsx` | **modify** | mount `AudioLane`s; `contentEnd` counts audio; overrun badge + one-click fix; audio drop; publish the selection. | 5, 7 |
| `src/renderer/components/timeline/snapping.ts` | **modify** | `collectSnapPoints(..., extra?: SnapPoint[])`. | 5 |
| `src/renderer/components/timeline/operations.ts` | **modify** | generify `splitClipAt` / `liftDelete` over `{id,start,duration,inPoint}`. | 5 |
| `src/renderer/components/timeline/geometry.ts` | **modify** | `AUDIO_LANE_H`. | 5 |
| `src/renderer/components/CueBankPanel.tsx` | **modify** | `labelForPath` fix; audio capture groups from the registry; `captureEntry` registry fallback. | 10 |
| `packages/sdk/src/renderer.ts` | **modify** | `ShowService.getStatus()` gains `showTime` + `showEnd` + `showEnded`; `AudioService.getTimelineAudio()`; `ShowService.getSelection` / `subscribeSelection`; `AutomationTargetProvider.writeFade?` / `releaseFade?` / `releaseAllFades?` / `getLive?`. **A build-verified boundary — `npm run verify:plugins` runs against BUILT output.** | 3, 6, 7, 9 |
| `src/renderer/host/plugins.ts` | **modify** | `NOOP_HOST` must track every one of the above or `activateRendererPlugins` fails to typecheck (H-7): `show.getStatus()`'s three new fields, `audio.getTimelineAudio`, the selection stubs. (The provider members are on a *provider*, not on `NOOP_HOST`.) | 3, 6, 7 |
| `plugins/audio/src/plugin.renderer.ts` | **modify** | the driver: bed on `showTime` (**stopped, not stuttering, when `showEnded`**), `Timeline.audio` on `playhead`; honour `solo`, `fadeIn`, `fadeOut`; read through the scene-fade layer. | 3, 6, 9 |
| `plugins/audio/src/automationTargets.ts` | **modify** | the second override layer (the scene/cue `fade` map) + `writeFade` / **`releaseFade` / `releaseAllFades` / `getLive`**; the layered read-order helpers (lane ?? fade ?? authored). | 9 |
| `plugins/audio/src/AudioBedPanel.tsx` | **modify → the MIXER** | first the show-clock corrections (readout, scrub range, the **disabled** scrub-while-a-scene-is-bound, `sourceDuration` on drop); then the rebuild: track faders + mute/solo, master strip, a clip inspector that follows the timeline selection, **`releaseFade` on every authored write**. `@ N s` deleted. | 3, 8 |
| `docs/TIMELINE.md`, `docs/SCENE-TIMELINES.md`, `CHANGELOG.md`, `plans/audio-engine.md` | **modify** | "one transport, two playheads"; the reset table; the false P5 claim. | 11 |

---

### Task 1: Asset paths — restructure `mapAssetPaths` into per-container visitors

**Why this is FIRST (hard ordering, ground truth H-1):** Task 4 adds `Timeline.audio`, a path-bearing container on **every** timeline (the global one *and* each scene's). `mapAssetPaths` does not visit `data.scenes[]` **at all** today, and does not visit `data.audio` either. If Wave B lands first, the audio-path visitor gets added to the *inline* timeline branch and then has to be re-extracted and re-remembered for the scenes loop — "the field gets added twice, and the second time it will be forgotten," which is exactly the failure this restructure exists to kill. Land the visitors first and Task 4 adds `tl.audio.clips[].path` in **one** place and gets the scene case for free.

Also note the guard at `projectFolder.ts:67` — `if (tl && (Array.isArray(tl.clips) || Array.isArray(tl.trackingTakes)))` — **skips an audio-only timeline entirely**, and an audio-only timeline is now an authorable shape (Wave A removed `normalizeTimeline`'s `if (!Array.isArray(t.layers)) return base;` bail; see the comment at `types.ts:537-540`).

Full context: [`plans/asset-paths-scenes-and-audio.md`](../../../plans/asset-paths-scenes-and-audio.md).

**Files:**
- Modify: `src/main/projectFolder.ts` — `mapAssetPaths` and its comment header (**lines 38-86**)

**Interfaces:**
- Consumes: nothing.
- Produces (module-private to `projectFolder.ts` — but **Task 4 edits `mapTimeline` by name**, so these signatures are the contract):
  ```ts
  type PathMap = (path: string) => string;
  function mapSurfaces(surfaces: unknown, map: PathMap): unknown;
  function mapScene3D(scene3D: unknown, map: PathMap): unknown;
  function mapTimeline(tl: unknown, map: PathMap): unknown;
  function mapAudio(audio: unknown, map: PathMap): unknown;   // AudioMix.clips[].path — NEW
  ```
  The public exports (`relativizeAssets` `:97`, `resolveAssets` `:102`, `collectAssets` `:259`, `collectAssetsToFolder` `:266`) are **unchanged**, and `collectInto` (`:202-256`) keeps calling `mapAssetPaths` **twice** (discovery `:212`, rewrite `:232`) — do not "optimise" one of them into a bespoke walk, that is precisely today's bug one level up.

- [ ] **Step 1: Extract the four visitors**

In `src/main/projectFolder.ts`, replace **lines 38-86** (from the `// ---- The single source of truth …` comment through `mapAssetPaths`'s closing `}`) with:

```ts
// ---- The single source of truth for where asset paths live in a project ----------
// Visits every asset path string, replacing it with map(value) (return the same string to leave it
// unchanged). Mutates a shallow-cloned copy so the input isn't touched.
//
// EXPRESSED AS PER-CONTAINER VISITORS ON PURPOSE. A Scene is a full look snapshot with its OWN
// surfaces, scene3D and timeline — every one of them carrying collectable paths. Written inline (as
// this used to be), the moment scenes needed the timeline walker too there would be TWO lists of
// "where paths live", and the next field added to Timeline would be remembered in one and forgotten
// in the other. (Wave B adds Timeline.audio — see mapTimeline.)
//
// EVERY HELPER MUST BE TOTAL OVER GARBAGE. This runs on every load of a possibly hand-edited file:
// `scenes` may be `{}`, a scene may be `null`, a scene's `timeline` may be a string, `audio.clips` may
// be a number. It must NEVER throw. (The renderer's sibling, normalizeTimeline, had FOUR separate
// crash-on-load paths of exactly this shape, each found by adversarial review, each reproduced by
// actually executing the expression.) The main process deliberately does not import renderer types —
// ProjectData.scenes is `unknown[]` and `audio` is `unknown` — hence the `any` casts, matching the
// file's existing style.
type PathMap = (path: string) => string;

// Surfaces: VIDEO/IMAGE content.url (skip blob:/http:/data: live urls — isFilePath).
function mapSurfaces(surfaces: unknown, map: PathMap): unknown {
  if (!Array.isArray(surfaces)) return surfaces;
  return surfaces.map((s: any) => {
    const c = s?.content;
    if (c && (c.type === 'VIDEO' || c.type === 'IMAGE') && isFilePath(c.url)) {
      return { ...s, content: { ...c, url: map(c.url) } };
    }
    return s;
  });
}

// 3D scene: mesh model paths (planes have path '' → skipped by isFilePath's empty check).
function mapScene3D(scene3D: unknown, map: PathMap): unknown {
  const s3d = scene3D as any;
  if (!s3d || typeof s3d !== 'object' || Array.isArray(s3d) || !Array.isArray(s3d.models)) return scene3D;
  return {
    ...s3d,
    models: s3d.models.map((m: any) => (isFilePath(m?.path) ? { ...m, path: map(m.path) } : m)),
  };
}

// Timeline: video clip paths + generalized content-clip urls + the recorded tracking-take library
// (.lblob sidecars). Both placed clips and unplaced bin takes carry collectable paths, so map them
// together.
//
// ⚠ WAVE B adds `Timeline.audio` (per-timeline audio clips). Its clips' `path` is mapped HERE — this
// one function is what makes relativize/resolve/collect all see it, on the global timeline AND on
// every scene's, because mapAssetPaths calls it from both places.
function mapTimeline(tl: unknown, map: PathMap): unknown {
  const t = tl as any;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return tl;
  if (!Array.isArray(t.clips) && !Array.isArray(t.trackingTakes)) return tl; // nothing path-bearing
  const next = { ...t };
  if (Array.isArray(t.clips)) next.clips = t.clips.map((c: any) => {
    let n = isFilePath(c?.path) ? { ...c, path: map(c.path) } : c;
    // Generalized content clips carry the collectable file on content.url (Image/Video sources).
    const cu = c?.content?.url;
    if ((c?.content?.type === 'VIDEO' || c?.content?.type === 'IMAGE') && isFilePath(cu)) {
      n = { ...n, content: { ...n.content, url: map(cu) } };
    }
    return n;
  });
  if (Array.isArray(t.trackingTakes)) {
    next.trackingTakes = t.trackingTakes.map((r: any) => (isFilePath(r?.path) ? { ...r, path: map(r.path) } : r));
  }
  return next;
}

// An AudioMix's clips (the global bed today; a timeline's own audio in Wave B — same shape, same
// visitor). AudioClip.path's own comment claims it is "relative on disk — like every asset path";
// until this landed nothing made it so: the bed's paths were written ABSOLUTE, baked to the authoring
// machine, never resolved on load, and never copied or reported missing by Collect Assets.
function mapAudio(audio: unknown, map: PathMap): unknown {
  const a = audio as any;
  if (!a || typeof a !== 'object' || Array.isArray(a) || !Array.isArray(a.clips)) return audio;
  return {
    ...a,
    clips: a.clips.map((c: any) => (isFilePath(c?.path) ? { ...c, path: map(c.path) } : c)),
  };
}

function mapAssetPaths(data: ProjectData, map: PathMap): ProjectData {
  const out: ProjectData = { ...data };

  out.surfaces = mapSurfaces(out.surfaces, map) as ProjectData['surfaces'];
  out.scene3D = mapScene3D(out.scene3D, map) as ProjectData['scene3D'];
  out.timeline = mapTimeline(out.timeline, map) as ProjectData['timeline'];

  // Scenes: each is a full look snapshot with its own surfaces, scene3D and timeline. Missing this is
  // why Collect Assets shipped a folder whose scenes pointed at the author's D: drive — and why a file
  // referenced ONLY from a scene was never copied AND never named in CollectResult.missing, because
  // `missing` is populated from this very visitor (projectFolder.ts:219). The user got zero signal.
  if (Array.isArray(out.scenes)) {
    out.scenes = out.scenes.map((sc: any) => {
      if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return sc;
      const next = { ...sc };
      if (sc.surfaces !== undefined) next.surfaces = mapSurfaces(sc.surfaces, map);
      if (sc.scene3D !== undefined) next.scene3D = mapScene3D(sc.scene3D, map);
      if (sc.timeline !== undefined) next.timeline = mapTimeline(sc.timeline, map);
      return next;
    });
  }

  // The global audio bed (Wave 3) — ProjectData.audio.
  if (out.audio !== undefined) out.audio = mapAudio(out.audio, map);

  // Managed asset library: every entry's path (incl. unused entries).
  if (Array.isArray(out.assets)) {
    out.assets = out.assets.map((a: any) => (isFilePath(a?.path) ? { ...a, path: map(a.path) } : a));
  }

  return out;
}
```

**Aliasing is already safe, and it is worth knowing why.** `buildSceneSnapshot` (`App.tsx:608-615`) stashes `surfaces`/`scene3D` **by reference** and `handleCaptureScene` (`App.tsx:620`) does `structuredClone(activeTimeline)` — so the *same path string*, and sometimes the *same object*, legitimately appears in a dozen places. That is fine on all three consumers: `collectInto`'s `remap` is keyed by **path string**, so a file referenced twelve times is copied **once** (`projectFolder.ts:213`), and every `map` in play is **idempotent** — `relativize` no-ops on an already-relative path (`isAbsolute` is false), `resolve` no-ops on an already-absolute one, and the collect-rewrite's `remap.get(p) ?? p` no-ops on a path already pointing into `assets/`. Visiting the same object twice cannot double-apply. (It does mean the output holds two distinct objects where the input held one shared reference — irrelevant: the value is immediately serialised to JSON.)

- [ ] **Step 2: Verify**

```
npx tsc -p tsconfig.json --noEmit      # exit 0
npm run build                           # exit 0
```

**Behavioural verification — a real fixture and a real folder move. Nothing else proves it.**

1. **Fixture.** One project, four assets, each referenced from exactly ONE place, all kept **outside** the project folder:
   - `a.mp4` — only on the **global timeline** (the control: this already works).
   - `b.mp4` — only on a **scene's own timeline** (capture a scene, then remove it from the global doc).
   - `c.png` — only on a **scene's look snapshot** (`scene.surfaces[].content.url`: set a surface's content, capture the scene, then change the live surface to an Effect).
   - `d.wav` — only on the **audio bed**.
2. **Collect Assets → a fresh folder.** Inspect the written `project.artlux` JSON directly. Expected: **all four** copied into `assets/`, and `scenes[].timeline.clips[].path`, `scenes[].surfaces[].content.url` and `audio.clips[].path` **all begin with `assets/`**.
3. **The portability test — the one that matters.** Move the collected folder to a different directory. Open it. Press GO on the scene → **it plays**. Play the bed → **it plays**. Today both are black/silent.
4. **`missing` is honest.** Delete `b.mp4` from disk, run Collect. Expected: it is **named** in the missing report.
5. **Idempotence.** Run Collect twice. The second run copies 0, skips all, mangles no path.
6. **Corrupt-input safety.** Hand-edit the saved JSON so `scenes` is `{}`, one scene is `null`, one scene's `timeline` is the string `"x"`, and `audio.clips` is `5`. Reopen. **Expected: it loads (degraded) and does not crash.**
7. **Regression:** `a.mp4` behaves exactly as before.

⚠ **FORWARD-COMPAT BREAK — carry this into the CHANGELOG (Task 11).** A project saved by the fixed build **will not fully load on an older build**: once scene/audio paths are relativized on save, an older ArtLux — whose `resolveAssets` does not visit them — reads those relative strings and never makes them absolute, so its scenes and its bed point at nonexistent relative paths. This is inherent (the entire point is to start writing relative paths where absolute ones used to be written) and **no schema version distinguishes the two**: `ProjectData.version` is **read by nothing** (`App.tsx:835` writes `'1.2'`; grep confirms zero readers). Accept + changelog is the honest minimum. **Backward-compat is untouched**: an old project's absolute paths stay valid absolute paths and load exactly as they do today; the first save under the fixed build converts them, in place, to relative — which is the fix.

- [ ] **Step 3: Commit** — `fix(main): mapAssetPaths visits every scene and the audio bed`

---

### Task 2: WS-B1a — the show clock (engine)

**This is the highest-risk task in the wave. Read all of it before writing a line.**

**The spec's central premise is FALSE.** Its diagram says "one `originMs` (ONE clock)". `originMs` (`timeline.ts:87`) is re-anchored by **seven** distinct sites: `mainSeek` (`:290`), the underrun branch (`:460`), the loop wrap (`:465`), the end-stop park (`:493`), the paused hold (`:520`), `setPlaying(true)` (`:728`), the mirror snap/slew (`:743`/`:744`), and `start()` (`:806`). **A single anchor cannot carry two times that are required to diverge** — and divergence is the entire point. `showTime` gets its own `showOriginMs`.

**The reset policy cannot live in `mainSeek`.** `mainSeek` (`timeline.ts:287-293`) is reached from **five semantically distinct events**: Stop, a user seek, a scene recall, play-from-the-parked-end, and project open. The policy discriminates among them. So: the engine maintains the **identity** (`activeKey === GLOBAL_POOL` ⇒ show clock tracks the playhead) inside `seek()` and `setPlaying()`, and every *other* move is either an explicit `showSeek()` from a named call site or an explicit `swap()` option (DC1).

**The engine has no handle on the global timeline.** `data` (`timeline.ts:74`) is **always the BOUND doc**. Bounding/wrapping `showTime` on the *global* region therefore needs a **new App→engine push** (`setGlobalDoc`) and a new App effect — which must go **next to `App.tsx:250`** (`setBaseAutomation`), **NOT** into the `App.tsx:1220-1250` window: the declaration order of the `setData` and `setPlaying` effects there is load-bearing (their own ⚠ comments say so) and anything inserted between them silently kills `setData`'s `clampPlayheadIntoDoc` guard — no type error, no test to catch it (ground truth H-3).

#### THE SHOW-CLOCK RESET TABLE — every transport event, derived from D1 + D7

`G` ≡ `activeKey === GLOBAL_POOL` — the engine's **only** representation of "Global is bound" (`timeline.ts:46`, exposed at `:697`). It is correct because App keys the pool by `scene.id` / `GLOBAL_POOL` in lockstep with `activeSceneId`, **including for a scene with no timeline of its own** (`App.tsx:662-667` still keys by `scene.id`).
`globalStart` / `globalEnd` ≡ `timelineStart(globalDoc)` / `timelineEnd(globalDoc)`.

| # | Transport event | Engine site | `playhead` | `showTime` | Enforced by |
|---|---|---|---|---|---|
| 1 | **Stop** (`{kind:'stop'}`) | `App.tsx:1270` → `seek(getStart())` | → the **BOUND** doc's start | **RESET to `globalStart`.** *(OQ1 answered: the GLOBAL in-point — `getStart()` is the BOUND doc's start, and while a scene is bound that number means nothing to the bed.)* | an explicit `showSeek(getGlobalStart())` in App's `stop` handler |
| 2 | **Seek while the GLOBAL DOC is bound** — ruler scrub, `seekTo`, AutomationLane click-to-seek, `Home`/`End`, OSC, `host.show.transport` | `timeline.ts:733` `seek()` | jumps | **MOVES to the same value** (the identity) | inside `seek()`: `if (!external && isGlobalDocBound()) showSeekInternal(clamped)`. **`isGlobalDocBound()`, not `activeKey === GLOBAL_POOL`** — a scene with no timeline of its own binds the GLOBAL doc under its own pool key (`App.tsx:663`), and the ruler being scrubbed there **is** the global timeline (DC6b) |
| 3 | **Seek while a SCENE'S OWN timeline is bound** | same | jumps | **DOES NOT MOVE** | the same `if` — it simply does not fire |
| 4 | **Scene recall / GO / cueBus / FSM hop / `enterAuthor` / `fireColumn`** | `App.tsx:665` → `swap(scene.id, tl, {transport:'restart'})` → `timeline.ts:666` `mainSeek(timelineStart(t))` | → the scene's in-point (**not 0** — with an in-point it never was) | **NEVER RESET.** *The single defining requirement of WS-B1.* | `swap`'s default `showClock: 'preserve'`; `mainSeek` never touches `showOriginMs` |
| 5 | **Exit to Global** (pill → Global) | `App.tsx:691` → `swap(GLOBAL_POOL, timeline, {transport:'reconverge'})` | **RECONVERGES: `playhead := showTime`** (D7) | **DOES NOT MOVE** | the new `'reconverge'` arm. In the normal case `showTime` is inside `[globalStart, globalEnd)` and there is nothing to clamp and no `pause` — which is the whole point of D7. **⚠ THE ONE EXCEPTION (DC5b): a PARKED show clock is at `globalEnd − frameSec`, one rAF inside the end.** `mainSeek` clears `endLatched`, so two frames later the raw end-stop pulses `hitEnd` and fires an `onTimelineEnd` transition **from a mouse click** — invariant 5, violated. So the arm ends with `if (showAtEndBound()) { endLatched = true; emitIntent({kind:'pause'}); }` — **latch WITHOUT pulsing `hitEnd`**, exactly `clampPlayheadIntoDoc`'s treatment |
| 6 | **Scene deleted while bound** | `App.tsx:673` → `swap(GLOBAL_POOL, timeline, …)` | as row 5 | as row 5 | `'reconverge'` |
| 7 | **Loop wrap of the BOUND (scene) timeline** | `timeline.ts:463-479` | wraps to the scene's `timelineStart` | **DOES NOT MOVE** — *the scene restarts, the bed rolls on* | the show clock's wrap tests the **global** doc; the bound doc's wrap touches only `originMs`/`prevPlayhead` |
| 8 | **Loop wrap of the GLOBAL region** (`globalDoc.loop === true`) | **NEW** show-clock branch in `frame()` | unaffected (unless `G`, where it *is* the same wrap) | **WRAPS over `[globalStart, globalEnd)`**, re-anchoring `showOriginMs` | the new show clock. This is a real backward jump the driver's inferred-seek test reads as a seek → `stopAllSounding()` + resync — **which is CORRECT: the show looped, so the bed restarts with it** (DC4). *The global timeline's Length is the SHOW's length.* |
| 9 | **End-stop of the GLOBAL region** (`globalDoc.loop === false`) | **NEW** show-clock branch | unaffected (unless `G`) | **PARKS at `globalEnd - frameSec(globalDoc)`** (DC2), and **`showEnded` goes TRUE** | the new show clock. It emits **NO** intent and pulses **NO** `hitEnd` (DC3) — but the park is **published** on `getStatus().showEnded`, and the audio driver **stops the bed and skips `reconcile()`** on it. **Without that the bed does not go silent — it BUZZES**: `reconcile()`'s drift re-lock re-seeks every sounding clip back to the same source offset every ~50 ms, forever, because `desired` is frozen and `estimated` advances in real time (DC2b). `playing` is no signal here — a scene looping underneath keeps it true |
| 10 | **End-stop of the BOUND (scene) timeline** (loop off) | `timeline.ts:480-516` → deferred `pause` (`:555`) | parks on the last frame | **FREEZES — but only if the `pause` actually lands.** If the FSM re-armed the clock inside the same tick, `endLatched` is clear and the pause is **swallowed** (`timeline.ts:547-552`), `playing` stays true, and the bed rolls on: **an auto-advancing show never freezes its bed.** | falls out of the existing latch — **no new mechanism**. Consistent with OQ2: `playing` gates both clocks (an installation that wants sound with no picture runs the transport) |
| 11 | **Document edit of the BOUND doc** (Length lowered, `O` at the playhead, out-handle dragged left, fps changed) | `App.tsx:1227` `setData` → `timeline.ts:620` `clampPlayheadIntoDoc` | conditionally jumps + emits `pause` | **DOES NOT MOVE.** `clampPlayheadIntoDoc` never touches `showOriginMs`. | `clampPlayheadIntoDoc` is left exactly as it is |
| 11b | **Document edit of the GLOBAL doc while a SCENE is bound** (its Length lowered, its out-handle dragged left) — `setData`'s guard does **not** run: `activeTimeline` is the scene's | the new `setGlobalDoc` (fires on `[timeline]`) | unaffected | **RE-ANCHORED INTO THE NEW REGION, SILENTLY** — no intent, no pulse, no phantom recall. **⚠ BUT SAY THE AUDIBLE PART OUT LOUD:** dropping the global Length from 300 to 60 while `showTime` is at 300 **is** a −240 s move. The driver reads it as a seek (≫ `SEEK_THRESHOLD`) — **the bed hard-cuts**, and if the new region has ended it stops (row 9 / `showEnded`). That is honest ("you just told the show it is 60 s long, and it is now over") but it is **not** a no-op, and the earlier draft of this table claimed it was. | `setGlobalDoc` gets `clampPlayheadIntoDoc`'s doctrine for the show clock: re-anchor into `[ga, gb)` **in the same call**, deterministically, and **never synthesise a transport event** (`timeline.ts:305-311`) |
| 12 | **Play from the parked end** | `timeline.ts:722` (`setPlaying(true) && atEndBound()`) **and** `App.tsx:1265` (`play` intent while `isAtEndBound()`) → `seek(getStart())` | restarts the bound doc | **restarts the SHOW clock iff `showAtEndBound()`** — parked at the global end with global loop off | a new `showAtEndBound()` inside `setPlaying(true)`, exactly parallel to `atEndBound()`. Without it, a show whose global Length ran out while a scene looped underneath would have a **permanently dead bed**. (App's `play` path goes through `seek()`, so row 2's identity also applies when `G`.) |
| 13 | **Underrun** (Play at 0 on a doc whose in-point is 5 s) | `timeline.ts:453-462` | jumps *forward* to the **BOUND** doc's in-point | **its own underrun test, against `globalStart`.** When `G` the two coincide (identity); when a scene is bound, **a scene's in-point cannot drag the show clock**. | a parallel `if (s < ga)` branch in the show clock |
| 14 | **Pause / resume** | `timeline.ts:519-521` (paused hold), `:727-728` (resume re-anchor) | frozen / seamless | **identical treatment on `showOriginMs`.** ⚠ `setPlaying` **early-returns when unchanged** (`timeline.ts:699`) — do NOT put show-clock logic anywhere that guard can skip. The **paused hold runs every frame** and is what keeps the anchor live. | duplicate the paused hold and the resume re-anchor |
| 15 | **Project open** | `App.tsx:916` → `swap(curKey, curTl, {transport:'restart'})` | resets | **RESET to `globalStart`.** Rows 4 / 15 / 16 all reach `swap(..., 'restart')` and **cannot be distinguished inside `swap`** — so the CALLER says which it is. | `applyProjectData` passes `{ transport: 'restart', showClock: 'reset' }` |
| 16 | **`handleCreateState`** | `App.tsx:709` → `swap(id, tl, {transport:'restart'})` | resets | **NEVER RESET** — a recall-shaped event (you drop into author mode on a new state; the bed keeps playing). | `swap`'s default `showClock: 'preserve'` ⇒ **the call site does not change** |
| 17 | **Mirror-window slew / snap** (projector) | `timeline.ts:738-746` | slews / snaps | **NOT COMPUTED AT ALL.** The show clock runs only when `!external` — matching `sampleAutomation` (`:528`) and the FSM block (`:533`). Nothing show-clock-driven renders in a projector: the audio driver early-returns for non-main windows (`plugins/audio/src/plugin.renderer.ts:62`), and `App.tsx:1444` streams only `{playing, playhead}`. | one `if (!external)` around the whole show-clock block (**not** `!external \|\| hapLocal`) |
| 18 | **`start()`** | `timeline.ts:806` | init | init `showOriginMs` alongside `originMs` (mind the `if (!raf)` guard). | one line |
| 19 | **The `loop` intent** (`App.tsx:1284-1289`) — an FSM `setLoop` entry action, or the Loop button | its `else` branch writes the **GLOBAL** doc's `loop` whenever the active pool is `GLOBAL_POOL` **or a timeline-less scene** (`owner?.timeline` is undefined) | unaffected | **DOES NOT MOVE — but it flips the show clock between row 8 (WRAP: the bed restarts every lap) and row 9 (PARK: the bed stops).** `globalDoc.loop` is a *live input* to the show clock, not a static one. | falls out of the `setGlobalDoc` push (the `[timeline]` effect fires on the `loop` change like any other). **No new mechanism — but it must be in the table, because an unattended FSM can reach it.** |
| 20 | **New Project** (`resetToNewProject`, `App.tsx:995-1007`, from `handleNewProject` `:1015`) | never swaps the engine and never clears `activeSceneId` today | unchanged (pre-existing) | **RESET to `globalStart`** — the show clock must not keep running into a project that no longer exists. (Open — row 15 — already gets `showClock:'reset'`; New Project got nothing.) | one line in `resetToNewProject`: `timelineEngine.showSeek(timelineEngine.getGlobalStart());`. *(The pre-existing stale `activeSceneId` after New Project is listed under "Known minor issues" — do not fix it here.)* |

**Files:**
- Modify: `src/renderer/services/timeline.ts`
- Modify: `src/renderer/App.tsx` (`:250` area, `:668-676`, `:689-693`, `:916`, `:995-1007`, `:1270`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- **Produces — Tasks 3, 6, 8 and 9 learn these names ONLY from here:**
  ```ts
  // src/renderer/services/timeline.ts — new members on `export const timeline`
  setGlobalDoc(t: Timeline): void;  // the GLOBAL timeline document — the show clock's bounds. App pushes it.
                                    // ALSO re-anchors showTime into the new [start,end) — silently (row 11b).
  getShowTime(): number;            // the SHOW clock, in seconds. Always 0 in mirror windows.
  getGlobalStart(): number;         // timelineStart(globalDoc)
  getGlobalEnd(): number;           // timelineEnd(globalDoc)  — Task 3's scrubMax, Task 8's mixer
  isShowAtEndBound(): boolean;      // the show clock is PARKED at the global end (loop off). Task 3's driver
                                    // MUST see this: reconciling against a frozen clock BUZZES (DC2b).
  showSeek(sec: number): void;      // move the show clock explicitly (Stop; project open; New Project).
                                    // No-op when external.

  // swap() gains a third transport mode and a show-clock policy. 'preserve' is REMOVED (DC5):
  swap(poolKey: string, t: Timeline, opts?: {
    transport?: 'restart' | 'reconverge';
    showClock?: 'preserve' | 'reset';   // default 'preserve'
    holdMs?: number;                    // still dead — accepted, never read
  }): void;

  // module-private, but Task 6 must not break it:
  function isGlobalDocBound(): boolean;   // activeKey === GLOBAL_POOL || data === globalDoc  (DC6b)
  function showAtEndBound(): boolean;     // the private twin of isShowAtEndBound()
  function sampleAutomation(playhead: number, showTimeSec: number): void;
  interface LaneRT { …; clock: 'show' | 'scene' }
  ```

- [ ] **Step 1: module state**

In `src/renderer/services/timeline.ts`, immediately after `let originMs = 0;` (**line 87**), add:

```ts
// ── THE SHOW CLOCK ───────────────────────────────────────────────────────────────────────────────
// ONE TRANSPORT, TWO PLAYHEADS. `playhead` is the SCENE clock (the BOUND document's time). `showTime`
// is the SHOW clock — the time the global audio bed and the GLOBAL timeline's automation (the base
// layer) ride. Both are DERIVED from performance.now() against their own anchor, both are gated on the
// SAME `playing` flag, and there is still exactly one rAF, one `playing`, one <video> pool. What is new
// is a second derived TIME VALUE, not a second transport.
//
// WHY IT NEEDS ITS OWN ANCHOR: originMs is re-anchored by SEVEN sites (mainSeek, the underrun branch,
// the loop wrap, the end-stop park, the paused hold, setPlaying(true), the mirror snap/slew). A single
// anchor cannot carry two times that are REQUIRED to diverge — and divergence is the whole point: a
// scene recall mainSeeks the playhead to the scene's in-point, and the bed must not hear it.
//
// WHILE GLOBAL IS BOUND THE TWO ARE THE SAME NUMBER. That identity is maintained inside seek() and
// setPlaying() by testing `activeKey === GLOBAL_POOL` — the engine's only representation of "Global is
// bound", and a correct one because App keys the pool by scene.id / GLOBAL_POOL in lockstep with
// activeSceneId (including for a scene with no timeline of its own).
//
// THE SHOW CLOCK IS SILENT. It NEVER emits a TransportIntent and NEVER pulses hitEnd: the bed wrapping
// is not a show event, and firing 'onTimelineEnd' off it would advance the state machine behind the
// operator's back. It only WRAPS (global loop on) or PARKS (global loop off).
let showTime = 0;
let showOriginMs = 0;
// The GLOBAL timeline document, pushed by App. `data` is ALWAYS the BOUND doc, so this is the engine's
// only handle on the global one — and the show clock is bounded by ITS [start, end): the global
// timeline's Length is the SHOW's length, and the bed lives inside it.
let globalDoc: Timeline = defaultTimeline();
```

- [ ] **Step 2: `showSeekInternal` + `showAtEndBound`**

Immediately after `mainSeek` (**timeline.ts:287-293**), add:

```ts
// The show clock's mainSeek — the ONLY thing that moves showTime from outside the frame loop.
// DELIBERATELY SEPARATE from mainSeek: mainSeek is reached from five semantically different events
// (Stop, a user seek, a scene recall, play-from-the-parked-end, project open) and the show-clock policy
// DISCRIMINATES among them — a recall must not reset it, a Stop must. So the policy lives at the CALL
// SITES, never in here. See the reset table in docs/TIMELINE.md.
function showSeekInternal(sec: number): void {
  const clamped = Math.max(0, sec);
  showTime = clamped;
  showOriginMs = performance.now() - clamped * 1000;
}

// Is the SHOW clock parked at the global end (global loop off)? The twin of atEndBound(), asked of the
// GLOBAL document instead of the bound one. Without it, a show that ran out its global Length while a
// scene looped underneath would have a permanently parked bed: setPlaying()'s restart test only ever
// looks at the BOUND doc, which is still merrily looping.
function showAtEndBound(): boolean {
  return !globalDoc.loop && showTime >= timelineEnd(globalDoc) - frameSec(globalDoc) - 1e-6;
}

// IS THE BOUND DOCUMENT THE GLOBAL ONE? Not the same question as "is Global bound" — and getting them
// confused is a real bug (DC6b). `activeKey === GLOBAL_POOL` is true only when the operator is on the
// Global pill. But a scene with NO TIMELINE OF ITS OWN plays the GLOBAL DOC under its own pool key
// (App.tsx:663: `const tl = scene.timeline ? normalizeTimeline(scene.timeline) : timeline`), so `data`
// IS globalDoc while activeKey is the scene's id. In that state:
//   · the global timeline's lanes are `data.automation` — they must still ride the SHOW clock (they are
//     the base layer; a lane on audio.master.gain restarting from 0 on every GO would snap the bed's
//     level while the bed itself plays serenely on);
//   · the ruler the operator scrubs IS the global timeline, so a seek must move the bed with it.
// Identity, not the key. Re-evaluated on every call — App pushes globalDoc from an effect declared at
// App.tsx:250, which flushes BEFORE the setData effect, so the reference is never stale when we ask.
function isGlobalDocBound(): boolean {
  return activeKey === GLOBAL_POOL || data === globalDoc;
}
```

- [ ] **Step 3: the clock — a PARALLEL derivation inside `frame()`**

The main-window clock block is `timeline.ts:440-522`. Insert the show clock **after** it closes (after **line 522**) and **before** the `sampleAutomation` call at `:528`:

```ts
    // ── THE SHOW CLOCK — a PARALLEL derivation on the same wall clock and the same `playing` flag.
    //
    // `!external` only — NOT `|| hapLocal`. A hapLocal projector runs the SCENE clock (so it plays at
    // full speed while the hidden main window's rAF is throttled), but nothing show-clock-driven exists
    // in a projector: the audio driver early-returns for non-main windows, and the transport bridge
    // streams only {playing, playhead}. This matches sampleAutomation (:528) and the FSM block (:533).
    //
    // Every branch that MOVES showTime re-anchors showOriginMs — the same rule the scene clock follows
    // for originMs. There is NO prevShowTime to re-baseline, because nothing crossing-detects on this
    // clock: fsm.tick() runs on `playhead` alone, by design (the show clock reaching the global loop's
    // end must NOT fire 'onTimelineEnd' — that would advance the machine behind the operator's back).
    //
    // AND NOTE THE ABSENCE, BELOW: no emitIntent, no hitEnd, no endLatched. The show clock is SILENT.
    if (!external) {
      if (playing) {
        let s = (now - showOriginMs) / 1000;
        const ga = timelineStart(globalDoc), gb = timelineEnd(globalDoc);
        if (s < ga) {                                   // underrun: below the GLOBAL in-point
          s = ga;
          showOriginMs = now - s * 1000;
        }
        if (s >= gb) {
          if (globalDoc.loop) {                         // THE SHOW LOOPS — and the bed restarts with it.
            // This wrap IS a big backward jump, and the audio driver's inferred-seek test will read it
            // as a seek and hard-resync the bed at the wrapped position. That is CORRECT: the show
            // looped. (The bug this whole clock exists to fix is a SCENE's loop/recall doing that — and
            // under showTime it no longer can, because a scene's clock never touches this number.)
            s = ga + ((s - ga) % (gb - ga));
            showOriginMs = now - s * 1000;
          } else {                                      // THE SHOW ENDED — park, silently.
            // Anchor at the RAW end boundary (gb), not at the parked value — the same reason the scene
            // clock does it (see timeline.ts:488-493): re-anchoring to a value BEFORE gb would let the
            // raw clock sail past the end again next frame and sawtooth over the last frame forever.
            showOriginMs = now - gb * 1000;
            s = Math.max(ga, gb - frameSec(globalDoc));
          }
        }
        showTime = Math.max(0, s);
      } else {
        showOriginMs = now - showTime * 1000; // keep the anchor live while paused so resume is seamless
      }
    }
```

- [ ] **Step 4: base automation rides the show clock (DC6)**

`LaneRT` is **timeline.ts:351-359**. Add a `clock` field with this comment:

```ts
  // WHICH CLOCK THIS LANE READS. A BASE lane belongs to the GLOBAL timeline, so it must ride the SHOW
  // clock — otherwise a global curve authored over five minutes is re-sampled at scene-relative 0-30 s
  // on every recall, which is what happens today and is a bug (the audio bed is global, so its curves
  // must outlive a scene swap: that is exactly why setBaseAutomation exists). An ACTIVE lane belongs to
  // the BOUND document and rides its playhead. Resolved HERE, at compile time, because compileAutomation
  // is the only place that still knows which list a lane came from.
  clock: 'show' | 'scene';
```

In `compileAutomation` (**timeline.ts:365-412**), replace **:369-372**:

```ts
  const active = data.automation ?? [];
  const activePaths = new Set(active.map(l => l.targetPath));
  // TAG BY DOCUMENT, NOT BY LIST (DC6b). Which LIST a lane came from does not tell you which CLOCK it
  // rides — because the GLOBAL DOC can be bound under a SCENE's pool key (a scene with no timeline of
  // its own: App.tsx:663). There, `active` IS the global timeline's lanes and `base` filters itself down
  // to [] (every base lane is shadowed BY ITSELF), so a list-derived tag would put every global lane on
  // the scene clock — and a lane driving audio.master.gain would snap the bed's level to its t=0 value on
  // every GO, while the bed plays on. Ask the DOCUMENT.
  const onGlobalDoc = isGlobalDocBound();
  const base = onGlobalDoc ? [] : baseAutomation.filter(l => !activePaths.has(l.targetPath));
  // Tag each lane with the clock it rides BEFORE the concat — afterwards there is no way to tell them
  // apart. When the global doc is bound, `base` is empty (the global timeline IS the base and must not
  // stack on itself) and its own lanes are the base layer ⇒ 'show'. When Global is bound on the pill the
  // two clocks are the same number anyway (the identity), so 'show' is exactly right there too.
  const lanes: { lane: AutomationLane; clock: 'show' | 'scene' }[] = [
    ...base.map(lane => ({ lane, clock: 'show' as const })),
    ...active.map(lane => ({ lane, clock: (onGlobalDoc ? 'show' : 'scene') as 'show' | 'scene' })),
  ];
```
Change the loop header to `for (const { lane, clock } of lanes) {` and add `clock,` to the `next.push({ … })` literal (next to `last: NaN,`).

Then `sampleAutomation` (**timeline.ts:414-427**) takes both clocks:

```ts
function sampleAutomation(playheadSec: number, showTimeSec: number): void {
  const n = lanesRT.length;
  if (n === 0) return; // the no-automation cost is one compare
  let wrote = false;
  for (let i = 0; i < n; i++) {
    const rt = lanesRT[i];
    // The GLOBAL timeline's lanes (the base layer) ride the SHOW clock; the bound document's own lanes
    // ride its playhead. See LaneRT.clock.
    const t = rt.clock === 'show' ? showTimeSec : playheadSec;
    const v = sampleLane(rt.kfs, t, rt.cursor, rt.log);
    if (Math.abs(v - rt.last) < rt.eps) continue; // unchanged — do NOT push (every audio push takes the audio lock)
    rt.last = v;
    rt.provider.write(rt.path, v);
    wrote = true;
  }
  if (wrote) for (let i = 0; i < frameEndProviders.length; i++) frameEndProviders[i].frameEnd!();
}
```
and its call site (**timeline.ts:529**) becomes `sampleAutomation(playhead, showTime)`.

⚠ **The call site must NOT move.** It stays *outside* the `playing` gate (scrubbing while paused must still move the curve — that is what makes the bed sound right the instant you hit Play) and *before* `subs.forEach` (`:568`). H-4: the sampler is deliberately not a subscriber precisely so the audio driver's `reconcile` sees this frame's values; moving it costs every automated audio param a permanent frame of latency.

**On the `playing` gate and the show clock (DC7):** while paused, the show clock's `else` branch re-anchors `showOriginMs` every frame, so `showTime` is a stable, readable number — `sampleAutomation` outside the gate keeps working. While **Global** is bound, scrubbing moves `showTime` too (the identity, Step 5), so base lanes respond to a scrub exactly as they do today. While a **scene** is bound and paused, scrubbing moves only the scene clock and the global (base) curves hold — which is the split working as designed.

- [ ] **Step 5: the identity rule — `seek()` and `setPlaying()`**

`seek()` is **timeline.ts:733-748**. Replace its last line (`mainSeek(clamped);`, **:747**) with:

```ts
    mainSeek(clamped); // don't fire FSM crossings across a deliberate jump
    // THE IDENTITY. While the GLOBAL DOCUMENT is bound, showTime IS the playhead — so every seek moves
    // both, and a ruler scrub, an OSC /transport/seek, the Home key, an AutomationLane click-to-seek and
    // the Stop button all stay coherent without any of them knowing the show clock exists. While a
    // SCENE'S OWN timeline is bound the two have diverged on purpose: seeking the scene must not move the
    // bed.
    //
    // isGlobalDocBound(), NOT `activeKey === GLOBAL_POOL` (DC6b): a scene with no timeline of its own
    // binds the GLOBAL doc under its own pool key, and the ruler being scrubbed there IS the global
    // timeline — so a seek must take the bed with it or the operator scrubs the picture and the sound
    // stays put, on one and the same document.
    //
    // It has to be HERE, not in App: Timeline.tsx's seekTo() calls engine.seek() DIRECTLY (it does not
    // go through the TransportIntent funnel), so a rule living only in App's seek handler would let a
    // ruler scrub break the identity.
    //
    // `!external`: a projector that is NOT hapLocal falls through the mirror arm above into mainSeek, and
    // a mirror has no show clock at all (invariant 2 / row 17). Guard it here rather than relying on the
    // early return.
    if (!external && isGlobalDocBound()) showSeekInternal(clamped);
```

`setPlaying` is **timeline.ts:698-730**. Inside `if (p) { … }`, keep everything and add two lines:

```ts
      if (!external && atEndBound()) mainSeek(timelineStart(data));
      // The SHOW clock has its own end — on the GLOBAL document — and needs its own restart. The test
      // above only ever looks at the BOUND doc, so without this a show whose global Length ran out while
      // a scene looped underneath would come back from a pause with a permanently dead bed.
      if (!external && showAtEndBound()) showSeekInternal(timelineStart(globalDoc));
      endLatched = false;
      originMs = performance.now() - playhead * 1000;     // re-anchor the monotonic clock on resume
      showOriginMs = performance.now() - showTime * 1000; // …and the show clock's, identically
```

⚠ `setPlaying` early-returns when unchanged (`:699`). That is fine here — both re-anchors ride the *transition* into `playing`, and the paused-hold branch from Step 3 keeps `showOriginMs` live every frame while stopped. **Do not** put show-clock logic anywhere that guard can skip it.

- [ ] **Step 6: `swap()` — `'reconverge'` replaces `'preserve'`**

`swap()` is **timeline.ts:637-669**. New signature + transport arm:

```ts
  // Promote a (warm, ideally) pool to ACTIVE — the seamless per-scene timeline swap.
  //
  // transport:
  //   'restart'    (default) — the incoming document plays from its first frame (a scene recall).
  //   'reconverge'           — RETURNING TO GLOBAL. The playhead SNAPS TO THE SHOW CLOCK, so the picture
  //                            rejoins the bed. While a scene was bound the two diverged; the show clock
  //                            is the one that never stopped, and it is BY CONSTRUCTION inside the global
  //                            doc's [start, end) (the clock wraps or parks it there). So — unlike the
  //                            'preserve' this replaces — there is nothing to clamp and NO `pause` intent
  //                            to emit. That emit is what used to kill the bed on a click back to Global:
  //                            clampPlayheadIntoDoc → emitIntent({kind:'pause'}) → App sets playing=false
  //                            → the audio driver's stopAllSounding().
  //
  // showClock:
  //   'preserve'   (default) — THE BED ROLLS ON. The defining requirement of the show clock: a scene
  //                            recall, an FSM hop, enterAuthor and handleCreateState all land here.
  //   'reset'                — project open. Rows 4 / 15 / 16 of the reset table ALL reach swap() with
  //                            transport:'restart' and cannot be told apart in here, so the CALLER says.
  swap(poolKey: string, t: Timeline, opts?: { transport?: 'restart' | 'reconverge'; showClock?: 'preserve' | 'reset'; holdMs?: number }): void {
```
…body unchanged (**:638-652**)…, then replace the transport arm (**:666-667**) with:
```ts
    if ((opts?.transport ?? 'restart') === 'restart') mainSeek(timelineStart(t));
    else {
      // 'reconverge' — the picture rejoins the bed (D7).
      mainSeek(showTime);
      // ⚠ THE BOUNDARY CASE, AND IT IS AN INVARIANT-5 BUG IF YOU SKIP IT (DC5b).
      // A PARKED show clock sits at EXACTLY `globalEnd - frameSec` — one rAF INSIDE the end. mainSeek()
      // has just CLEARED endLatched (timeline.ts:292), so within two frames the raw clock crosses `b`,
      // takes the end-stop, PULSES hitEnd and fires an 'onTimelineEnd' transition — FROM A MOUSE CLICK.
      // (Reachable from the pill → Global and from deleting the bound scene, once the show has run past
      // its global Length with a scene on air — which the default 60 s global Length makes easy.)
      // So: the same LATCH-WITHOUT-PULSE treatment clampPlayheadIntoDoc gives a document edit, and the
      // pause it also gives — the show really is over (D4: stop + hold on the last frame). The machine is
      // never advanced by a click; the transport is simply told the truth.
      // In the NORMAL case showAtEndBound() is false, nothing latches, nothing pauses, and D7 stands.
      if (showAtEndBound()) { endLatched = true; emitIntent({ kind: 'pause' }); }
    }
    if (opts?.showClock === 'reset') showSeekInternal(timelineStart(globalDoc));
    compileAutomation(); // AFTER the seek, so the first post-recall sample is taken at the new playhead
```

⚠ Keep the comment block at **:653-665** (the guarded-start rationale) but **replace its final paragraph** — the one beginning *"'preserve' KEEPS THE CLOCK RUNNING ACROSS THE SWAP…"* — with the `'reconverge'` rationale, because that failure mode no longer exists.

⚠ **`clampPlayheadIntoDoc` (`timeline.ts:334-339`) is NOT deleted.** It remains `setData`'s document-edit guard (`:620`) — still needed, still correct (reset-table row 11). It simply has no `swap` caller any more.

- [ ] **Step 7: the new public exports**

In `export const timeline = { … }`, beside `getPlayhead`/`getEnd`/`getStart` (**:749-754**):

```ts
  // The GLOBAL timeline document. `data` is always the BOUND doc, so this is the engine's only handle on
  // the global one — and the SHOW clock is bounded by it. Pushed by App on every global-timeline change.
  //
  // IT ALSO RE-ANCHORS THE SHOW CLOCK INTO THE NEW REGION (reset-table row 11b). Lowering the global
  // Length, or dragging its out-handle left, while a SCENE is bound does NOT reach setData's
  // clampPlayheadIntoDoc guard (activeTimeline is the scene's) — and the show clock re-reads globalDoc
  // every frame, so it would park on the next frame anyway. Do it HERE, deterministically, in the same
  // call: same doctrine as clampPlayheadIntoDoc (timeline.ts:305-311) — REPOINTING A DOCUMENT UNDER A
  // LIVE CLOCK MUST NEVER SYNTHESISE A TRANSPORT EVENT. So: no intent, no hitEnd, no FSM crossing.
  //
  // BE HONEST ABOUT WHAT THE OPERATOR HEARS: shortening the global region below showTime IS a big
  // backward move, the driver reads it as a seek, and the bed hard-cuts (and then STOPS, because
  // isShowAtEndBound() is now true). That is correct — you just told the show it is over — but it is not
  // a no-op, and the CHANGELOG says so.
  setGlobalDoc(t: Timeline): void {
    globalDoc = t;
    if (external) return;
    const ga = timelineStart(globalDoc), gb = timelineEnd(globalDoc);
    if (showTime < ga) showSeekInternal(ga);
    else if (showTime >= gb) {
      showSeekInternal(globalDoc.loop ? ga : Math.max(ga, gb - frameSec(globalDoc)));
    }
  },
  getShowTime(): number { return showTime; },
  getGlobalStart(): number { return timelineStart(globalDoc); },
  getGlobalEnd(): number { return timelineEnd(globalDoc); },
  // THE PARK, PUBLISHED (DC2b). The audio driver MUST be able to ask this: a parked show clock is a
  // FROZEN NUMBER, and reconcile()'s drift re-lock against a frozen number re-seeks every sounding clip
  // back to the same source offset every ~50 ms — forever. That is a buzz, not silence. `playing` is not
  // the signal (a scene looping underneath keeps it true), and the park is deliberately silent on the
  // intent channel (DC3) — so it is published as a READABLE STATE instead.
  isShowAtEndBound(): boolean { return showAtEndBound(); },
  // Move the SHOW clock explicitly. The POLICY lives at the call sites (Stop; project open; New Project)
  // — see the reset table in docs/TIMELINE.md. No-op in mirror windows, which have no show clock.
  showSeek(sec: number): void { if (!external) showSeekInternal(sec); },
```

and `start()` (**:806**):
```ts
  start(): void {
    if (!raf) {
      originMs = performance.now() - playhead * 1000;
      showOriginMs = performance.now() - showTime * 1000;
      raf = requestAnimationFrame(frame);
    }
  },
```

- [ ] **Step 8: App — push the global doc + the three explicit policy sites**

**8a.** Immediately after the `setBaseAutomation` effect (**App.tsx:250**):
```ts
  // The GLOBAL timeline is the SHOW clock's document: its in/out region and its Length bound the bed and
  // the base automation layer, and its `loop` is what makes the SHOW loop. The engine's `data` is always
  // the BOUND doc, so it has no other way to see this.
  //
  // ⚠ THE DECLARATION SITE IS DELIBERATE: here, beside setBaseAutomation — NOT down in the
  // App.tsx:1220-1250 window, where the declaration order of the setData and setPlaying effects is
  // load-bearing and inserting anything between them silently kills setData's clampPlayheadIntoDoc guard.
  useEffect(() => { timelineEngine.setGlobalDoc(timeline); }, [timeline]);
```

**8b.** The `stop` intent (**App.tsx:1270**) — the only place row 1 lives:
```ts
      // Stop returns to the in-point, not hard 0 — with a region set, 0 is outside the playable range.
      // The SHOW clock resets too, but to the GLOBAL doc's in-point: getStart() is the BOUND doc's start,
      // and while a scene is bound that number means nothing to the bed. Stop is one of only TWO things
      // that reset the show clock (the other is opening a project).
      else if (i.kind === 'stop') {
        setIsVideoPlaying(false);
        timelineEngine.seek(timelineEngine.getStart());
        timelineEngine.showSeek(timelineEngine.getGlobalStart());
      }
```
⚠ Add **nothing** to the `seek` intent (**:1271**) — `timelineEngine.seek()` now maintains the identity itself. A second rule in App would double-apply and would still miss `Timeline.tsx`'s direct `engine.seek()` calls.

**8c.** `exitToGlobal` (**App.tsx:691**) and `handleRemoveScene` (**App.tsx:673**): change **both** `{ transport: 'preserve' }` → `{ transport: 'reconverge' }`, and put this above `exitToGlobal`'s:
```ts
    // RECONVERGE: the playhead snaps to the show clock, so the picture rejoins the bed that never
    // stopped. (This was 'preserve', which ran clampPlayheadIntoDoc → a `pause` intent → the audio
    // driver's stopAllSounding(): clicking the pill back to Global could kill the bed.)
```

**8d.** `applyProjectData` (**App.tsx:915-916**):
```ts
      timelineEngine.setGlobalDoc(tl);   // BEFORE the swap — swap's showClock:'reset' reads globalDoc
                                         // synchronously, and the [timeline] effect above is passive.
      timelinePreloader.warm(curKey, curTl);
      timelineEngine.swap(curKey, curTl, { transport: 'restart', showClock: 'reset' });
```

**8e.** `handleCreateState` (**App.tsx:709**) — **no change** (default `showClock: 'preserve'` = row 16).

**8f.** `resetToNewProject` (**App.tsx:995-1007**) — row 20. It never swaps the engine, so nothing else resets the clock:
```ts
      // NEW PROJECT resets the show clock, like OPEN does (row 15). Without this the bed's clock keeps
      // running into a project that no longer exists — and with `scenes: []` there is no swap to catch it.
      timelineEngine.showSeek(timelineEngine.getGlobalStart());
```
(The pre-existing stale `activeSceneId` / stale engine pool key after New Project is **out of scope** — see "Known minor issues to watch in review".)

- [ ] **Step 9: PROVE IT WITH A NODE FRAME SIMULATION — inspection is not proof**

Write `scratch/showclock-sim.mjs` (scratch only; do not commit it). It must **re-implement the clock arithmetic exactly as written above** — copy the branch bodies verbatim, including `timelineStart`/`timelineEnd`/`frameSec` — step a fake `now` in fixed 16.667 ms increments, and print a per-frame table plus a PASS/FAIL per case. It must cover **every row of the reset table**:

| Case | Setup | Assertion |
|---|---|---|
| **Row 4** | global `{duration:300, loop:true}`; play 20 s bound to GLOBAL; then `swap('scene-a', {duration:30}, {transport:'restart'})`; run 10 s | `playhead` restarts at 0 → 10; **`showTime` continues 20 → 30, strictly monotonic, no discontinuity ≥ 0.05 s at the swap frame** |
| **Row 4 (the driver's own test)** | the same run | on **every** frame including the swap frame: `abs((showTime[i] − showTime[i−1]) − dt) <= 0.2` ⇒ the driver's `seeked` (`SEEK_THRESHOLD = 0.2`, `plugin.renderer.ts:34`) is **false** ⇒ **no `stopAllSounding()`**. *This is the whole bug, asserted.* |
| **Row 7** | scene `{duration:30, loop:true}` bound; run 100 s | `playhead` wraps 3× ; `showTime` strictly monotonic throughout |
| **Row 8** | global `{duration:60, loop:true}`; a scene bound; run 130 s | `showTime` wraps at 60 and 120; each wrap is a ~−60 s jump ⇒ the driver DOES see a seek ⇒ **intended** (DC4) |
| **Row 9** | global `{duration:60, loop:false}`; scene `{duration:30, loop:true}` bound; run 90 s | `showTime` parks at `60 − 1/30` and **stays**; the sim's intent log has **zero** entries from the show clock; `hitEnd` never pulses from it; **and `isShowAtEndBound()` is `true` on every frame from the park onward** |
| **Row 9 (the buzz, asserted — DC2b)** | the same run, with the driver's drift re-lock simulated: track `desired = clip.inPoint + (showTime − clip.start)` and `estimated = sentOffset + (now − sentWallMs)/1000` for a bed clip spanning `[0, 300)` | **WITHOUT the `showEnded` guard**: the sim must SHOW `abs(desired − estimated) > 0.05` recurring every ~50 ms ⇒ a re-seek every ~50 ms, forever. **WITH it**: zero re-seeks after the park frame. *Print both. This is the defect, reproduced, and then the fix, proved.* |
| **Row 5** | as row 4, then at t=45 `swap(GLOBAL_POOL, globalDoc, {transport:'reconverge'})` | `playhead` becomes **exactly `showTime`**; `showTime` unchanged; **no `pause` intent emitted; `hitEnd` never pulses** |
| **Row 5b (the boundary — DC5b)** | global `{duration:60, loop:false}`; scene `{duration:30, loop:true}` bound; run 90 s (⇒ the show clock PARKS); **then** `swap(GLOBAL_POOL, globalDoc, {transport:'reconverge'})`; run 10 more frames | **`hitEnd` must NEVER pulse** and `fsm.tick` must never see `atEnd` from this move. Exactly ONE `pause` intent is emitted (by the reconverge arm itself, not by the end-stop). **Run the sim WITHOUT the `showAtEndBound()` latch first and watch `hitEnd` fire two frames later — that is the bug; then add it and watch it stop.** |
| **Row 11b** | global `{duration:300, loop:false}`; a scene bound; run 100 s; then `setGlobalDoc({duration:60})` | `showTime` re-anchors to `60 − 1/30` **in that same call** (not one frame later), `isShowAtEndBound()` is `true`, **no intent and no `hitEnd` from the show clock**, and the sim logs the −40 s jump the driver will read as a seek (the documented, audible hard-cut) |
| **Rows 2 / 3** | `seek(75)` with `activeKey === GLOBAL_POOL`; then `seek(5)` with `activeKey === 'scene-a'` | both move to 75; then `playhead = 5` and `showTime` **unchanged** |
| **Row 1** | global `{inPoint:10}`; scene bound at playhead 4; `seek(getStart())` + `showSeek(getGlobalStart())` | `playhead` = the scene's start; `showTime` = **10** |
| **Row 12** | global `{duration:60, loop:false}`; run past 60 while a scene loops; `setPlaying(false)` then `setPlaying(true)` | `showTime` restarts at `timelineStart(globalDoc)` |
| **Row 13** | global `{inPoint:5}`; `showSeek(0)`; play | `showTime` jumps forward to 5 and never runs below it |
| **Row 14** | play 10 s, pause 3 s of wall clock, resume | `showTime` is **continuous** across the pause — no 3 s jump on resume |
| **Row 15** | `swap(k, tl, {transport:'restart', showClock:'reset'})` | `showTime` = `timelineStart(globalDoc)` |

Run `node scratch/showclock-sim.mjs`. **Every assertion must PASS, and the output goes in the commit message.** If a row disagrees with the table, the **code** is wrong — or the table is, in which case **stop and raise it**. Do not silently re-decide.

- [ ] **Step 10: Verify**

```
npx tsc -p tsconfig.json --noEmit          # exit 0
npm run build                               # exit 0
npm run verify:plugins                      # exit 0
node scratch/showclock-sim.mjs              # every assertion PASS
git grep -n "transport: 'preserve'"         # must print NOTHING — all callers migrated
```

Live smoke (the bed is not on `showTime` yet — that is Task 3 — so this is **picture-only**):
- Bind a scene → the timeline restarts. Click the pill back to **Global** → the playhead lands **where the show clock is**, not back at 0, and the transport **keeps running** (it used to pause).
- Global Length 20, Loop on; a 5 s scene with Loop on, bound. Play. The scene loops every 5 s; nothing pauses; the transport never stops.

- [ ] **Step 11: Commit** — `feat(timeline): the show clock — one transport, two playheads`

---

### Task 3: WS-B1b — the bed rides the show clock (the audio driver)

The engine now has a show clock (Task 2). This task makes the **bed hear it**, and fixes the two places in the Audio Bed panel that lie about the bed's position. It is deliberately small: the whole point of DC8 is that the driver needs a *different number*, not different logic.

**Root cause, stated once (do not re-diagnose):** the driver infers a seek — it is never told about one. `plugins/audio/src/plugin.renderer.ts:237-238`:
```ts
      const expectedDelta = prevPlaying ? (nowMs - prevWallMs) / 1000 : 0;
      const seeked = Math.abs((playhead - prevPlayhead) - expectedDelta) > SEEK_THRESHOLD;   // 0.2 s
```
A scene recall `mainSeek`s the playhead to the scene's in-point — a jump far beyond wall-clock expectation — so `seeked` is true, `:243` runs `stopAllSounding()`, and **a five-minute ambient bed restarts from its top on every GO.** Feed the same test `showTime` instead and a recall produces `Δ ≈ wall Δ` ⇒ `seeked === false` ⇒ nothing stops. `reconcile()`'s window test (`:201`) and its source-offset math (`:204`/`:211`) are **pure functions of the number passed in** and need **no change at all**.

**Files:**
- Modify: `plugins/audio/src/plugin.renderer.ts` (the `tick` at `:224-248`; the `ctx.onPlayhead` subscription at `:252`)
- Modify: `plugins/audio/src/AudioBedPanel.tsx` (`:103-104`, `:138`, `:169`)

**Interfaces:**
- **Consumes (from Task 2):** `timeline.getShowTime()`, `timeline.getGlobalEnd()`, `timeline.isShowAtEndBound()` — but the plugin **cannot import `src/renderer/services/timeline.ts`** (plugin → host is a forbidden dependency direction; the plugin's only deps are `@artlux/sdk` and its own files). It reaches the host through `ctx` / `host`. So this task **adds three fields to the SDK's `ShowService.getStatus()`**, which App already implements against the engine:
  ```ts
  // packages/sdk/src/renderer.ts — ShowService.getStatus() return type gains THREE fields:
  getStatus(): {
    playing: boolean; playhead: number; showTime: number; duration: number;
    showEnd: number;      // timelineEnd(globalDoc) — the SHOW's length. The bed's scrub range.
    showEnded: boolean;   // the show clock is PARKED at showEnd (global loop off). A CONSUMER RIDING A
                          // FROZEN CLOCK HAS TO KNOW IT IS FROZEN — see the driver, and DC2b.
    currentStateId: string | null; stateElapsedSec: number;
    activeSceneId: string | null; lastFiredTransitionId: string | null;
  };
  ```
  The driver already polls `host.show.getStatus().playing` **every tick** (`plugin.renderer.ts:236`), so these cost it literally nothing extra — and this preserves H-4's same-frame ordering exactly: `sampleAutomation` runs at `timeline.ts:529`, `subs.forEach` at `:568`, same frame, sampler first. **Do NOT widen the `onPlayhead` payload** — that is an SDK break touching `host/plugins.ts:70` and `NOOP_HOST`, for no gain (DC8).
- **Produces:** nothing new beyond the `getStatus()` field above (Task 8's mixer consumes it).

- [ ] **Step 1: SDK — `getStatus()` gains `showTime`**

`packages/sdk/src/renderer.ts:326-330`, inside `ShowService`:
```ts
  // Live transport + FSM status for a remote's status display (polled by the plugin).
  //
  // TWO PLAYHEADS, ONE TRANSPORT. `playhead` is the BOUND document's time (it restarts when a scene is
  // recalled). `showTime` is the SHOW clock — the time the global audio bed rides, which a scene recall
  // does NOT reset. Anything describing the BED must read showTime; anything describing the picture on
  // the bound timeline must read playhead. See docs/TIMELINE.md.
  //
  // `showEnd` is the SHOW's length (the GLOBAL doc's playable end) — `duration` is the BOUND doc's, and
  // while a scene is bound that number means nothing to the bed.
  //
  // `showEnded` says the show clock is PARKED at showEnd (global loop off, the show ran out). It is NOT
  // derivable from `playing`: a scene looping underneath keeps the transport running. A consumer that
  // reconciles against showTime MUST check it — reconciling against a FROZEN clock is not a no-op, it is
  // a defect (the audio driver's drift re-lock would re-seek every sounding clip every ~50 ms, forever).
  getStatus(): {
    playing: boolean; playhead: number; showTime: number; duration: number;
    showEnd: number; showEnded: boolean;
    currentStateId: string | null; stateElapsedSec: number;
    activeSceneId: string | null; lastFiredTransitionId: string | null;
  };
```

**`src/renderer/App.tsx:1341-1349`** (`host.show.getStatus`):
```ts
      getStatus: () => ({
        playing: timelineEngine.isPlaying(),
        playhead: timelineEngine.getPlayhead(),
        showTime: timelineEngine.getShowTime(),
        duration: timelineEngine.getDuration(),
        showEnd: timelineEngine.getGlobalEnd(),
        showEnded: timelineEngine.isShowAtEndBound(),
        currentStateId: currentSmStateRef.current,
        stateElapsedSec: timelineEngine.getSmElapsedSec(),
        activeSceneId: activeSceneIdRef.current,
        lastFiredTransitionId: lastFiredTransitionRef.current,
      }),
```

**`src/renderer/host/plugins.ts:43`** (`NOOP_HOST.show.getStatus`) — **this must be updated or `activateRendererPlugins` fails to typecheck** (H-7):
```ts
    getStatus: () => ({ playing: false, playhead: 0, showTime: 0, duration: 0, showEnd: 0, showEnded: false, currentStateId: null, stateElapsedSec: 0, activeSceneId: null, lastFiredTransitionId: null }),
```

- [ ] **Step 2: the driver's `tick` reads the show clock**

`plugins/audio/src/plugin.renderer.ts:224-248`. Replace the whole `tick` with:

```ts
    // THE BED RIDES THE SHOW CLOCK, NOT THE PLAYHEAD.
    //
    // `ctx.onPlayhead` still drives the cadence (it fires every frame, INCLUDING while paused — the
    // playhead just freezes — which is why pause is detected by polling `playing`, never by "the callback
    // stopped"). But the NUMBER the bed reconciles against is host.show.getStatus().showTime.
    //
    // Why: a seek is not signalled, it is INFERRED (see `seeked` below — anything that displaces the
    // clock by >200 ms in one frame, forward or backward, reads as a seek and hard-resyncs). A scene
    // recall mainSeeks the PLAYHEAD to the scene's in-point, so on the old wiring every GO looked like a
    // seek and stopAllSounding() restarted a five-minute ambient bed from its top. The show clock does
    // not move on a recall, so Δ ≈ wall Δ, `seeked` is false, and NOTHING happens — which is the fix.
    //
    // What still (correctly) reads as a seek on the show clock: a real user seek while the global doc is
    // bound, Stop, opening a project, the GLOBAL timeline's own loop wrap (the show looped, so the bed
    // restarts with it) — and SHORTENING THE GLOBAL LENGTH BELOW showTime, which hard-cuts the bed and
    // ends the show (reset-table row 11b). The first four are intended; the fifth is a documented,
    // audible consequence of telling the show it is shorter than it has already run.
    //
    // AND ONE THING THAT IS NOT A SEEK AND MUST NOT BE TREATED AS PLAYBACK EITHER: THE PARKED SHOW CLOCK.
    // With the global loop off, the show clock parks at showEnd and STOPS ADVANCING — while `playing` can
    // still be true, because a scene is looping underneath. reconcile() against a frozen number is not a
    // no-op: `desired` (derived from the clock) freezes while `estimated` (derived from the wall clock)
    // keeps advancing, so the drift test at SYNC_THRESHOLD = 0.05 trips every ~50 ms and re-seeks every
    // sounding clip back to the same source offset — FOREVER. That is a 50 ms buzz loop, not silence, and
    // the park frame's own Δ (≈ −0.017 s) is far under SEEK_THRESHOLD so `seeked` never catches it.
    // `st.showEnded` is the signal (DC2b). The show is over: the bed stops.
    //
    // The `playhead` argument is deliberately IGNORED here. It is kept in the signature because
    // ctx.onPlayhead's contract supplies it, and Task 6 uses it for the BOUND timeline's own audio.
    const tick = (_playhead: number) => {
      // The automation sampler ran moments ago, in the SAME frame (timeline.ts calls it just before it
      // notifies its subscribers, of which this is one — so a curve's value reaches the engine on the
      // frame it was sampled, not the next). Push whatever it moved. Only the owners it actually touched:
      // an unchanged value never gets here, because the sampler gates on a half-step epsilon and every
      // push costs an acquisition of the engine's audio lock.
      const moved = takeDirty();
      if (moved.size > 0) {
        for (const clip of bed.clips) if (moved.has(clip.id) && loaded.has(clip.id)) pushClipParams(eff(clip));
        if (moved.has(MASTER_BUS_ID)) syncMaster();
      }
      const nowMs = performance.now();
      const st = host.show.getStatus();
      const playing = st.playing;
      const showTime = st.showTime;
      const expectedDelta = prevPlaying ? (nowMs - prevWallMs) / 1000 : 0;
      const seeked = Math.abs((showTime - prevShowTime) - expectedDelta) > SEEK_THRESHOLD;

      if (prevPlaying && !playing) {
        stopAllSounding();                               // paused → freeze the bed
      } else if (st.showEnded) {
        // THE SHOW IS OVER — the clock is PARKED. Never reconcile against a frozen number (see above).
        // Idempotent: only the frame that discovers it does any work. When the clock comes back (Play from
        // the parked end, Stop→Play, a project open, or the global Length raised), showTime jumps and the
        // `seeked` arm below hard-resyncs from the new position.
        if (sounding.size > 0) stopAllSounding();
      } else if (playing && (seeked || !prevPlaying)) {
        stopAllSounding(); reconcile(showTime, nowMs);   // resume, or a real show-clock seek → hard resync
      } else if (playing) {
        reconcile(showTime, nowMs);                      // normal advance (+ live gain/retime/small-seek sync)
      }
      prevPlaying = playing; prevShowTime = showTime; prevWallMs = nowMs;
    };
```
⚠ In Task 6 the `showEnded` arm becomes **bed-scoped** (`for (const c of bed.clips) if (sounding.has(c.id)) stopSounding(c.id)` + skip only `reconcileContainer(bed.clips, …)`): the BOUND timeline's own audio rides the playhead and must keep playing when the *show* ends. Here, with only one container, `stopAllSounding()` is exactly that.

And rename the local at **`plugin.renderer.ts:89`**: `let prevPlayhead = 0;` → `let prevShowTime = 0;`. (Grep the file: `prevPlayhead` must have **zero** remaining occurrences.)

`unsubTick = ctx.onPlayhead(tick);` at **:252** is unchanged — the subscription is the *cadence*, not the *value*.

- [ ] **Step 3: the Audio Bed panel stops lying about the bed's position**

Five sites in `plugins/audio/src/AudioBedPanel.tsx`. (The panel is rebuilt as the mixer in Task 8 — these are corrections that must land **now**, with the clock, or the panel actively misreports, and actively MISFIRES, the thing this task just fixed.)

**`:66`** — the transport mirror's shape:
```ts
  const [transport, setTransport] = useState({ playing: false, showTime: 0, showEnd: 0, sceneBound: false });
```
**`:103-104`** — inside the existing 10 Hz interval:
```ts
      // THE BED RIDES THE SHOW CLOCK. Mirroring getStatus().playhead here was a LIE about the bed the
      // moment a scene was bound: the readout and the scrub slider would show the scene's time while the
      // bed played on at a completely different position. `duration` was the same lie one level down — it
      // is the BOUND doc's Length, so a 20 s scene pinned the bed's scrub slider at its maximum.
      const st = host.show.getStatus();
      setTransport({ playing: st.playing, showTime: st.showTime, showEnd: st.showEnd, sceneBound: st.activeSceneId != null });
```
**`:138`** (`addClip`) — a dropped clip is placed on the **show** clock, because that is the container it lands in; and it now records its **source duration**, which the bed has never written:
```ts
    const start = Math.max(0, host?.show.getStatus().showTime ?? 0);
```
```ts
    // …and in the commit at :154, add `sourceDuration: meta.durationSec`:
    commit({ ...cur, clips: [...cur.clips, { id: clipId, trackId, name: baseName(asset.path), path: asset.path,
      start, duration: meta.durationSec, inPoint: 0,
      // THE TRIM CAP. Absent, `(c.sourceDuration ?? Infinity) - c.inPoint` is INFINITY — the lane's right
      // trim handle would have no cap at all and would happily drag a 30 s clip out to 5 minutes of source
      // that does not exist (the driver's window test would then hold the show on silence). The panel has
      // had this number in `meta` since Wave 3 and simply never wrote it.
      sourceDuration: meta.durationSec,
      gain: 1, mute: false }] });
```
(Old beds have no `sourceDuration` and are **not** back-filled — Task 5's `audioPeaks.sourceDurationFor(path)` recovers it from the decode instead, so no migration writes to a project on load.)

**`:169`** (`scrubMax`) and **`:194`/`:197-199`** (the readout + slider `value`): replace every `transport.playhead` with `transport.showTime`, and drive the range off the **show's** length:
```ts
  // The SHOW's length, not the bound doc's. Always far enough to reach the last bed clip.
  const scrubMax = Math.max(10, transport.showEnd, ...mix.clips.map((c) => c.start + c.duration));
```
**`:187` + `:197-199`** — ⚠ **AND DISABLE THE SEEK CONTROLS WHILE A SCENE IS BOUND. This is not cosmetic.** The slider's `onChange` dispatches `host.show.transport({kind:'seek'})` → `timeline.seek()`, whose identity rule **does not fire while a scene's own timeline is bound** (Task 2, rows 2/3). So a slider that displays the *show* clock would **seek the SCENE** — the operator nudges the control labelled "Scrub the playhead", sitting in the *Audio Bed* panel, and recalls the picture to an arbitrary point mid-show while the bed does not move at all. `SkipBack` (`seek(0)`) has the identical defect. Both get `disabled={transport.sceneBound}` and the title *"Scrub Global to move the bed — a seek inside a scene does not move the show clock."* (Task 8 keeps this; it does not invent it.)

- [ ] **Step 4: Verify**

```
npx tsc -p tsconfig.json --noEmit                                     # exit 0
npm run build                                                         # exit 0
npm run verify:plugins                                                # exit 0 — runs against BUILT output
git grep -n "prevPlayhead" -- plugins/audio/                          # must print NOTHING
git grep -n "getStatus().playhead" -- plugins/audio/                  # must print NOTHING
```

**LIVE — this is the money shot of the entire wave, and a human must hear it:**
1. Load a 5-minute audio file onto the bed. Create three scenes with different timelines. Press Play.
2. GO between the scenes, repeatedly. **The bed must NOT restart, must NOT gap, must NOT click.** It plays continuously, exactly as if nothing happened, while the picture restarts each time.
3. Click the pill back to **Global**. **The bed keeps playing** (this used to kill it — `clampPlayheadIntoDoc`'s `pause`) and the picture jumps to where the bed is.
4. Set the global timeline's Loop **on** with Length 30. Play. At 30 s the bed **restarts** — that is the show looping, and it is correct.
5. Press **Stop**. The bed stops and returns to the global in-point. Press Play. It starts from there.
6. Bind a scene with Loop on and a Length of 5 s. Play. The scene loops every 5 s and **the bed does not notice.**
7. **THE PARKED SHOW (DC2b) — the one that buzzes if you get it wrong.** Global Length **60**, Loop **off**. A 5-minute bed clip. Bind a 5 s scene with Loop **on**. Play, and **wait past 60 s**. The scene keeps looping (the transport never pauses — nothing end-stops), and **the bed must go SILENT and STAY silent.** If you hear a ~50 ms fragment repeating forever, `showEnded` is not wired into the driver.
8. From that state press **Stop**, then **Play**: the show clock restarts at the global in-point and **the bed comes back from the top**. Now raise the global Length to 300 while parked: the bed **resumes** from 60 s (the clock un-parks and runs on).
9. **Row 11b, heard.** With the bed playing at ~2:00 under a bound scene, drag the global timeline's Length down to 30. The bed **hard-cuts and stops** (the show is now over). That is expected and is in the CHANGELOG — but it must not *buzz*, and it must not pause the transport or hop the state machine.

- [ ] **Step 5: Commit** — `feat(audio): the bed rides the show clock — it no longer restarts on every scene recall`

---

### Task 4: WS-B2a — `Timeline.audio`, the data model (types, normalizers, asset paths, usage, relink)

The container. **No UI in this task** — Task 5 draws it, Task 6 plays it. Landing the model and every path/usage site first means the lane cannot ship with a silent data-loss bug.

**The rule (D8), stated once:** `Timeline.audio` exists on **every** timeline, the global one included — it is "audio that plays with this timeline's picture and restarts when it does". It is **not** a second bed. `ProjectData.audio` (the bed) stays exactly where it is, on the show clock. **An audio clip does NOT extend the timeline's `Length`** — the `duration` raise in `normalizeTimeline` (`types.ts:594-603`) stays **video-only**. Length is purely authored; Task 5 makes overrunning audio *visible* and one-click *fixable* instead.

**Files:**
- Modify: `src/renderer/types.ts` (`Timeline` `:363-395`; `defaultTimeline` `:396-399`; `normalizeTimeline` `:535-609`; the audio section `:611-708`)
- Modify: `src/main/projectFolder.ts` (`mapTimeline`, from Task 1)
- Modify: `src/renderer/services/assetLibrary.ts` (`usageIndex` `:52-84`)
- Modify: `src/renderer/App.tsx` (`relinkTimeline` `:1118-1123`)

**Interfaces:**
- Consumes (from Task 1): `mapTimeline(tl: unknown, map: PathMap): unknown` in `src/main/projectFolder.ts`.
- **Produces (Tasks 5, 6, 8, 9 learn these names ONLY from here):**
  ```ts
  // src/renderer/types.ts
  export interface TimelineAudio { tracks: AudioTrack[]; clips: AudioClip[] }
  export interface Timeline { …; audio?: TimelineAudio }          // additive, normalize-defaulted
  export const sanitizeAudioClip: (c: AudioClip) => AudioClip;    // the numeric coercer the bed never had
  export const sanitizeAudioTrack: (t: AudioTrack) => AudioTrack; // …and the one a TRACK never had either
  export const normalizeTimelineAudio: (a: unknown) => TimelineAudio;
  export const timelineAudioClips: (t: Timeline) => AudioClip[];  // guarded reader: t.audio?.clips ?? []
  export const timelineAudioTracks: (t: Timeline) => AudioTrack[];
  ```
  Note the shape **deliberately excludes `buses`**: `AudioBus` stays project-global on `ProjectData.audio.buses`, because there is **one output chain** and it cannot be per-scene (`types.ts:670-679` — "exactly two insert points", the clip and the master).

- [ ] **Step 1: the type + the default**

`src/renderer/types.ts`. Add to `Timeline` (**:363-395**), after `automation?` (**:373**):
```ts
  // A timeline's OWN audio — audio that plays with THIS timeline's picture and restarts when it does.
  //
  // NOT a second bed. The two audio containers differ by CLOCK, and the clock follows the CONTAINER,
  // never the timeline it happens to be drawn next to:
  //   · ProjectData.audio  — THE BED. One per project. Rides the SHOW clock. Survives a scene recall.
  //   · Timeline.audio     — this document's audio. Rides the PLAYHEAD. Restarts with its timeline.
  // It exists on the GLOBAL timeline too (a show can legitimately use both: a bed that never stops, plus
  // global-timeline audio that restarts whenever the global timeline does). No `buses`: AudioBus is
  // project-global (there is ONE output chain — see "WHERE EFFECTS SIT" below).
  audio?: TimelineAudio;
```
(`TimelineAudio` is declared in the audio section further down the file; a TS `interface` is hoisted, so the forward reference is fine — this mirrors how `Timeline` already forward-references `AutomationLane`.)

`defaultTimeline()` (**:396-399**):
```ts
export const defaultTimeline = (): Timeline => ({
  layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
  loop: false, trackingTakes: [], automation: [], audio: { tracks: [], clips: [] }, boundedDuration: true,
});
```

In the audio section, after `AudioTrack` (**:661-669**), add:
```ts
// A timeline's own audio container (Timeline.audio). Tracks + clips, no buses — see Timeline.audio.
export interface TimelineAudio {
  tracks: AudioTrack[];
  clips: AudioClip[];
}
```

- [ ] **Step 2: `sanitizeAudioClip` — the coercer the bed never had**

Ground truth §6.1: `normalizeAudioMix` (`types.ts:701-708`) is a **shape guard only**. There is **no `sanitizeClip` equivalent for audio.** A `NaN` / `"5"` / `Infinity` `start`/`duration`/`inPoint`, a `null` element inside `clips`, an array-typed clip, a clip with no `id` — **all pass through untouched today**, and reach `plugin.renderer.ts:136` and the panel unguarded. `normalizeTimeline` guards every one of those classes for video clips (`types.ts:511-530, 561-563`). Audio does not. Task 5 puts audio clips on a lane whose `Math.max(...)` width arithmetic a single `NaN` poisons exactly as it would a video clip's.

Add immediately after `sanitizeClip` (**types.ts:524-530**):
```ts
// The audio twin of sanitizeClip — and the guard the BED has been missing since Wave 3.
//
// COERCE, DO NOT DROP, same as video: a clip with a bad number is recoverable user data (you can see and
// fix a zero-duration clip); silently deleting it is not. start/duration/inPoint feed the lane's width
// arithmetic (`Math.max(..., ...clips.map(c => c.start + c.duration))`) and the driver's window test
// (`playhead >= clip.start && playhead < clip.start + clip.duration`) completely unguarded — one NaN
// there poisons contentEnd, the scroll-area CSS width, and every audibility decision. `sourceDuration`
// is OPTIONAL and "absent" already means "no cap" at its call sites, and `??` does NOT catch a
// present-but-NaN value — so a non-finite one is DROPPED back to undefined rather than coerced to 0
// (zeroing it would fabricate a trim cap of `-inPoint`, which is worse than no cap). fadeIn/fadeOut get
// the same treatment: a non-finite fade is absent, not a NaN gain ramp in the driver.
export const sanitizeAudioClip = (c: AudioClip): AudioClip => ({
  ...c,
  start: finiteNum(c.start) ?? 0,
  duration: finiteNum(c.duration) ?? 0,
  inPoint: finiteNum(c.inPoint) ?? 0,
  sourceDuration: finiteNum(c.sourceDuration) ?? undefined,
  gain: finiteNum(c.gain) ?? undefined,
  fadeIn: finiteNum(c.fadeIn) ?? undefined,
  fadeOut: finiteNum(c.fadeOut) ?? undefined,
});

// A TRACK's numbers need the same guard as a clip's — and this is not theoretical. The driver multiplies
// the track gain in UNGUARDED: `(autoTrackGain(clip.trackId) ?? trackOf(clip)?.gain ?? 1)`
// (plugin.renderer.ts:98) — and `??` does NOT catch a present-but-NaN value, which is the exact hole
// sanitizeClip's own comment (types.ts:519-523) was written about. A hand-edited/bad-import `"gain": "x"`
// on a track ⇒ `audioClient.setClipGain(id, NaN)` for every clip on it, and the lane gutter's
// `<input type="range" value={NaN}>` goes uncontrolled. Coerce, do not drop: `undefined` means "1" at
// every call site, so a junk gain becomes absent rather than a silent zero.
export const sanitizeAudioTrack = (t: AudioTrack): AudioTrack => ({ ...t, gain: finiteNum(t.gain) ?? undefined });

// Coerce a persisted audio container (Timeline.audio, or an AudioMix's tracks+clips). Never throws; a
// missing/garbage value yields an empty container. Same filter shape as normalizeTimeline's clips guard:
// exclude null/undefined slots and bare ARRAYS (`typeof [] === 'object'`, so they used to sail through a
// naive `typeof c === 'object'` test), but ACCEPT `{}` — sanitizeAudioClip coerces its numbers, so it can
// no longer poison anything, and dropping it would fight the coerce-don't-drop rule.
export const normalizeTimelineAudio = (a: unknown): TimelineAudio => {
  const o = a as Partial<TimelineAudio> | null | undefined;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { tracks: [], clips: [] };
  return {
    tracks: (Array.isArray(o.tracks) ? o.tracks : [])
      .filter((t): t is AudioTrack => !!t && typeof t === 'object' && !Array.isArray(t))
      .map(sanitizeAudioTrack),
    clips: (Array.isArray(o.clips) ? o.clips : [])
      .filter((c): c is AudioClip => !!c && typeof c === 'object' && !Array.isArray(c))
      .map(sanitizeAudioClip),
  };
};

// Guarded readers — every consumer goes through these, so `audio` being absent (an old project) or junk
// is handled in ONE place instead of at each of a dozen `t.audio?.clips ?? []` sites that will drift.
export const timelineAudioClips = (t: Timeline): AudioClip[] => (Array.isArray(t.audio?.clips) ? t.audio!.clips : []);
export const timelineAudioTracks = (t: Timeline): AudioTrack[] => (Array.isArray(t.audio?.tracks) ? t.audio!.tracks : []);
```
⚠ `sanitizeAudioClip` / `normalizeTimelineAudio` must be declared **after** `finiteNum` (**:411**) and **after** `AudioClip`/`AudioTrack`/`TimelineAudio`. Put them in the audio section, after `TimelineAudio` from Step 1, and note that `normalizeTimeline` (which is *above* them in the file) can still call them — `const` arrow functions are **not** hoisted, but `normalizeTimeline` only calls them at **runtime**, long after the module body has finished evaluating. This is exactly how `normalizeTimeline` already works. **Verify with `npx tsc` and by actually opening a project** — if you get a TDZ `ReferenceError` on load, move the two helpers above `normalizeTimeline` instead.

- [ ] **Step 3: `normalizeTimeline` picks it up — AFTER the spread**

`normalizeTimeline` (**types.ts:535-609**). ⚠ **The `...rest` spread at `:566` passes a JUNK persisted `audio` straight through.** It must be overridden *after* the spread, alongside `clips` / `trackingTakes` / `markers` (**:568-570**):

```ts
    trackingTakes: normalizeTrackingTakes(t.trackingTakes),
    markers: normalizeMarkers(t.markers),
    // ⚠ AFTER the spread, like every other array: `...rest` above would otherwise pass a hand-edited
    // `"audio": 5` or `{"clips": null}` straight into the lane renderer and the audio driver, both of
    // which iterate it unguarded.
    audio: normalizeTimelineAudio(t.audio),
```

**And do NOT touch the duration raise (`:594-603`).** D8: an audio clip does **not** extend Length. Adding `...audioClips.map(...)` there would re-break the "deliberately short Length" invariant the `boundedDuration` marker (`:374-392`) exists to protect. Add this comment above the raise so the next reader does not "fix" it:
```ts
    // ONLY VIDEO `clips` extend the Length. trackingTakes, automation and Timeline.audio do NOT — an
    // audio clip past the end is authored content the user can see and one-click-fix on the ruler (see
    // the overrun badge in Timeline.tsx), not a reason to silently rewrite their authored Length.
```

- [ ] **Step 4: `normalizeAudioMix` reuses the sanitizer — the BED gets the guard too**

`normalizeAudioMix` (**types.ts:701-708**). Replace its body:
```ts
export const normalizeAudioMix = (a: Partial<AudioMix> | null | undefined): AudioMix => {
  if (!a || typeof a !== 'object') return defaultAudioMix();
  const inner = normalizeTimelineAudio(a); // tracks + clips, coerced — the SAME guard Timeline.audio gets
  return {
    tracks: inner.tracks,
    clips: inner.clips,
    buses: (Array.isArray(a.buses) ? a.buses : [])
      .filter((b): b is AudioBus => !!b && typeof b === 'object' && !Array.isArray(b)),
  };
};
```
⚠ This **changes behaviour**: the bed's clips are now numerically sanitised on load and on every `host.audio.setMix()` (`App.tsx:1367`). That is the point — it closes a real hole. Confirm a normal bed round-trips unchanged (open → save → open, diff the JSON).

- [ ] **Step 5: asset paths — ONE line in `mapTimeline`, because Task 1 landed**

`src/main/projectFolder.ts`, inside `mapTimeline` (from Task 1). Widen the entry guard and map the audio clips:
```ts
  if (!t || typeof t !== 'object' || Array.isArray(t)) return tl;
  // ⚠ THE GUARD MUST INCLUDE AUDIO. An AUDIO-ONLY timeline (no video clips, no takes) is a first-class
  // authorable shape now — Wave A removed normalizeTimeline's `if (!Array.isArray(t.layers)) return base;`
  // bail — and the old guard skipped such a document ENTIRELY: its audio paths were never relativized,
  // never resolved, never collected, never reported missing.
  if (!Array.isArray(t.clips) && !Array.isArray(t.trackingTakes) && !Array.isArray((t.audio as any)?.clips)) return tl;
  const next = { ...t };
  …the existing clips + trackingTakes arms…
  // This timeline's OWN audio (Wave B). Same clip shape as the bed, same visitor.
  if (t.audio !== undefined) next.audio = mapAudio(t.audio, map);
  return next;
```
**This single site fixes relativize + resolve + collect at once, on the global timeline AND on every scene's** — because Task 1 already calls `mapTimeline` from both places.

- [ ] **Step 6: usage counting — a blind spot here is a SILENT DELETE of an on-air file**

`src/renderer/services/assetLibrary.ts`, `usageIndex` (**:52-84**). The `refs.timelines` loop (**:67-69**) reads only `tl.clips[].path`. It already **misses** `tl.clips[].content.url` and `tl.trackingTakes[].path`, which `mapAssetPaths` **does** map — the two "where paths live" lists have already drifted. Fix all three:

```ts
  for (const tl of refs.timelines) {
    for (const c of tl.clips ?? []) {
      if (c.path) at(normPath(c.path)).c.add(c.id);
      // A generalized content clip carries its file on content.url — mapAssetPaths maps it, this index
      // never counted it. An image placed by drag-and-drop was deletable with no warning at all.
      const cu = (c.content as { url?: string } | undefined)?.url;
      if (cu) at(normPath(cu)).c.add(c.id);
    }
    // Recorded takes: mapAssetPaths maps trackingTakes[].path; this index never counted them either.
    for (const r of tl.trackingTakes ?? []) if (r.path) at(normPath(r.path)).c.add(r.id);
    // Wave B: this timeline's OWN audio. Derived from `timelines` rather than a new ProjectRefs field,
    // because `allTimelines` (App.tsx:196-198) already spans the global doc + every scene.
    for (const c of timelineAudioClips(tl)) if (c.path) at(normPath(c.path)).a.add(c.id);
  }
```
Import `timelineAudioClips` from `../types`. `ProjectRefs.audioClips` (**:36**) keeps its meaning ("the **global** bed's clips") — unchanged. `App.tsx:207-212`'s `projectRefs` memo needs **no change**: it already passes `allTimelines`.

Update the `ProjectRefs.timelines` doc comment (**:31-33**) to say it now also covers each timeline's content-clip urls, tracking takes, and its own audio.

- [ ] **Step 7: Relink**

`src/renderer/App.tsx`, `relinkTimeline` (**:1118-1123**):
```ts
      const relinkTimeline = (t: Timeline): Timeline => ({
          ...t,
          clips: t.clips.map(c => isOld(c.path) ? { ...c, path: newPath } : c),
          // Takes are matched by id as well: a take's library entry IS its trackingTakes row.
          trackingTakes: (t.trackingTakes ?? []).map(r => (r.id === asset.id || isOld(r.path)) ? { ...r, path: newPath } : r),
          // This timeline's own audio (Wave B). The BED is relinked separately at the setAudioMix below.
          audio: t.audio ? { ...t.audio, clips: t.audio.clips.map(c => isOld(c.path) ? { ...c, path: newPath } : c) } : t.audio,
      });
```
It is already applied to the global timeline (**:1127**) and every scene's (**:1132**), so this one edit covers both.

- [ ] **Step 8: `handleRemoveAsset` — audio-clip removal semantics**

`App.tsx:1077-1089`. The take-removal path filters `t.clips`. **Decision: removing an audio ASSET from the library does NOT remove the clips that reference it** — same as video (a video asset's clips survive; the clip goes red/missing). Nothing to change; add a one-line comment so the next reader does not assume it was overlooked:
```ts
      // NB: removing a library entry never removes the CLIPS that reference it (video, audio or content) —
      // the reference survives and reads as missing, which is recoverable. The confirm dialog above is the
      // guard, and it is gated on usageIndex seeing every reference (see assetLibrary.usageIndex).
```

- [ ] **Step 9: Verify**

```
npx tsc -p tsconfig.json --noEmit      # exit 0
npm run build                           # exit 0
npm run verify:plugins                  # exit 0
```
Behavioural (no UI yet — inspect the JSON and the badges):
1. **Round-trip.** Open an existing project with a bed. Save. Diff the JSON: `audio` is unchanged; every timeline gains `"audio": {"tracks":[],"clips":[]}`.
2. **Junk tolerance.** Hand-edit a saved project so one timeline's `"audio"` is `5`, another's is `{"clips": null}`, and a third's is `{"clips": [null, {}, {"start":"x","duration":1e400}]}`. Reopen. **It loads. It does not crash.** The junk timelines show an empty audio container; the third keeps its `{}` and its coerced clip with `start: 0, duration: 0`.
3. **The bed's new guard.** Hand-edit `audio.clips[0].start` to `"5"` (a string) **and `audio.tracks[0].gain` to `"x"`**. Reopen. `start` becomes `0`, `gain` becomes absent (⇒ 1), nothing renders `NaN`, and `setClipGain` is never handed a `NaN`.
4. **Length is untouched.** Hand-write a timeline with `duration: 8` and an audio clip ending at 40. Reopen. **`duration` is still 8** (audio does not extend Length), and `boundedDuration` is still `true`.

- [ ] **Step 10: Commit** — `feat(types): Timeline.audio — the per-timeline audio container, with the sanitizer the bed never had`

---

### Task 5: WS-B2b — audio lanes (`AudioLane.tsx`), fade handles, and the overrun badge

The lane. Per doctrine, **timeline lane rendering is core-only, not a plugin seam** — and `AudioMix`/`AudioClip` are already core persisted types. So a new core `AudioLane.tsx` sits alongside `AutomationLane.tsx` and `StateLane.tsx`, reading `AudioTrack[]`/`AudioClip[]` directly.

**Two containers, two commit paths — the lane must be told which one it is on, per track** (ground truth §3.3, and it is not a detail):
| Track lives in | Drawn when | Clock | Commit path | Cost of one commit |
|---|---|---|---|---|
| **`ProjectData.audio`** (THE BED) | **only while Global is bound** | show clock | `onChangeMix(mix)` → App's `setAudioMix` | `recompileAutomation()` (`App.tsx:255`) + the `audioSubs` fan-out (`:1375`) |
| **`Timeline.audio`** (this doc's audio) | whenever that timeline is bound | playhead | `onChange(timeline)` → `handleTimelineChange` | `setData` → `clampPlayheadIntoDoc` + `warmMedia` + `pruneStaleLayers` + `compileAutomation` + a structured-clone `postMessage` of the WHOLE doc **to every projector port** |

**Why the bed is drawn only while Global is bound (spec :77):** there, show clock ≡ playhead, so the ruler is honest. Inside a scene the two clocks diverge and drawing the bed against a scene-relative ruler would be a **lie**. While a scene is bound the user instead gets a `♪ BED 02:14` readout in the timeline header (Step 6), and the bed's faders/FX stay reachable in the mixer (those are time-independent).

**Invariant 7 is the whole game here.** `ClipBlock`/`AutomationLane` draft locally and commit **ONCE on pointerup**. An audio-clip drag committing per pointermove would recompile every automation lane and structured-clone the project doc to every projector port, 60×/s — **and can emit a `pause` intent that stops the bed.** Copy `Timeline.tsx:216-251` (`onDragMove`/`onDragUp`/`onStartDrag`) and `AutomationLane.tsx:87-117` (`dragKf`), not an invented rig.

**Files:**
- Create: `src/renderer/components/timeline/AudioLane.tsx`
- Create: `src/renderer/components/timeline/audioPeaks.ts`
- Modify: `src/renderer/components/timeline/geometry.ts` (`AUDIO_LANE_H`)
- Modify: `src/renderer/components/timeline/snapping.ts` (`collectSnapPoints` extra points)
- Modify: `src/renderer/components/timeline/operations.ts` (generify `splitClipAt` / `liftDelete`)
- Modify: `src/renderer/components/timeline/Timeline.tsx` (mount, drop, `contentEnd`, the overrun badge, the bed readout)
- Modify: `src/renderer/components/timeline/TimelineRuler.tsx` (the overrun band)
- Modify: `src/renderer/App.tsx` (pass `audioMix` / `setAudioMix` to the timeline panel)

**Interfaces:**
- Consumes (Task 4): `TimelineAudio`, `sanitizeAudioClip`, `timelineAudioClips`, `timelineAudioTracks` from `../../types`.
- **Produces (Task 7's selection channel and Task 8's mixer learn these names ONLY from here):**
  ```ts
  // src/renderer/components/timeline/geometry.ts
  export const AUDIO_LANE_H = 54;   // AudioTrack has no `height` field (types.ts:661-669) — a constant, not a per-track value

  // src/renderer/components/timeline/audioPeaks.ts
  export function peaksFor(path: string, buckets: number): Float32Array | null;  // sync; null while decoding
  export function ensurePeaks(path: string): void;                                // fire-and-forget decode+cache
  export function sourceDurationFor(path: string): number | null;                 // from the decode; null while decoding
  export function probeAudioDuration(path: string): Promise<number | null>;       // offscreen <audio> metadata (DC10)

  // src/renderer/components/timeline/AudioLane.tsx
  export type AudioDragMode = 'move' | 'l' | 'r' | 'fadeIn' | 'fadeOut';
  export interface AudioLaneProps {
    track: AudioTrack;
    clips: AudioClip[];               // already filtered to this track + the draft override applied
    source: 'bed' | 'timeline';       // WHICH CONTAINER — decides the commit path and the clock label
    selectedId: string | null;
    tool: 'select' | 'blade';
    pxPerSec: number;
    width: number;
    onPatchTrack: (patch: Partial<AudioTrack>) => void;
    onRemoveTrack: () => void;
    onStartDrag: (e: React.PointerEvent, clip: AudioClip, mode: AudioDragMode, source: 'bed' | 'timeline') => void;
    onBlade: (clip: AudioClip, clientX: number, source: 'bed' | 'timeline') => void;
    onRemoveClip: (clipId: string, source: 'bed' | 'timeline') => void;
    onSelect: (clipId: string, source: 'bed' | 'timeline') => void;
    onSeek: (clientX: number) => void;
    onDropAsset: (e: React.DragEvent, trackId: string, source: 'bed' | 'timeline') => void;
  }
  export const AudioLane: React.FC<AudioLaneProps>;

  // src/renderer/components/timeline/snapping.ts
  export function collectSnapPoints(tl: Timeline, playhead: number, excludeClipId?: string,
                                    excludeRegion?: 'in' | 'out', extra?: SnapPoint[]): SnapPoint[];

  // src/renderer/components/timeline/Timeline.tsx — Props gains:
  //   audio?: { mix: AudioMix; onChangeMix: (m: AudioMix) => void }
  ```

- [ ] **Step 1: `geometry.ts` + `snapping.ts` + `operations.ts` — the three small enablers**

`geometry.ts`, after `SM_LANE_H` (**:10**):
```ts
export const AUDIO_LANE_H = 54;    // audio lane height. A CONSTANT, not per-track: AudioTrack carries no
                                   // `height` field, and a waveform needs a fixed, generous strip anyway.
```

`snapping.ts`, `collectSnapPoints` (**:14-24**) — it is `Timeline`-typed and **clip-array-bound**, so it will not see audio clips. Add a fifth parameter rather than teaching it about a second array (keeps it pure and lets the caller decide what an audio drag should snap to):
```ts
// `extra`: snap points the CALLER supplies — audio clip edges, which live in a different array (the bed's
// AudioMix.clips, or Timeline.audio.clips) that this function has no business knowing about. Same
// exclusion rule applies: the caller must leave out the clip being dragged (see the rationale above).
export function collectSnapPoints(tl: Timeline, playhead: number, excludeClipId?: string, excludeRegion?: 'in' | 'out', extra?: SnapPoint[]): SnapPoint[] {
  const pts: SnapPoint[] = [{ t: 0, kind: 'trackStart' }, { t: playhead, kind: 'playhead' }];
  …unchanged body…
  if (extra) for (const p of extra) pts.push(p);
  return pts;
}
```

`operations.ts` is entirely `VideoClip[]`-typed (**:1**). `AudioClip` matches on every field it uses **except it calls the owner `trackId`, not `layerId`** (`types.ts:646`). Only `rippleDelete` (`:42`) and `bladeAt` (`:25`) read `layerId`. So generify **only the two that do not** — `splitClipAt` (`:11`) and `liftDelete` (`:31`):
```ts
// The blade and the lift are structurally generic over "a clip on a time axis": they only ever read
// id/start/duration/inPoint. AudioClip satisfies that (it calls its owner `trackId`, not `layerId` — but
// neither of these two functions reads the owner). rippleDelete and bladeAt DO read `layerId` and stay
// VideoClip-typed: audio has no ripple and no playhead-blade in Wave B.
export interface TimeClip { id: string; start: number; duration: number; inPoint: number }

export function splitClipAt<T extends TimeClip>(clips: T[], clipId: string, t: number): T[] { …unchanged body… }
export function liftDelete<T extends TimeClip>(clips: T[], clipId: string): T[] { …unchanged body… }
```
The existing `VideoClip[]` call sites (`Timeline.tsx:256, 259, 391`) infer `T = VideoClip` and need **no edit**.

- [ ] **Step 2: `audioPeaks.ts` — waveforms and the duration probe (DC10)**

Create `src/renderer/components/timeline/audioPeaks.ts`:
```ts
// Waveform peaks + the source-duration probe for audio clips on a lane.
//
// BOTH ARE CORE, AND BOTH USE THE BROWSER, NOT THE NATIVE ENGINE — deliberately.
// `audioClient.loadClip()` (the only thing that knows a file's real duration in the native engine) lives
// in the AUDIO PLUGIN, and core must not reach into a plugin. AssetEntry.durationSec is NOT an option
// either: it is never populated on import (projectFolder.ts's copyIntoAssets mints {id,name,type,path,
// size,addedAt} — no durationSec).
//
// So core probes with the browser, exactly as Timeline.tsx already probes a dropped VIDEO's duration with
// an offscreen <video> — and the native engine still loads the file ITSELF for playback (the driver's
// syncLoaded → audioClient.loadClip). Core decides WHERE the clip sits; the engine decides how it sounds.
// Chromium decodes wav/flac/ogg natively; mimeForPath (services/mediaCache.ts:12) already maps them.
import { ensureBlobUrl, mimeForPath } from '../../services/mediaCache';

const PEAK_BUCKETS = 2048;                       // fixed resolution; the lane downsamples to its pixel width
const peaks = new Map<string, Float32Array>();   // path → normalized |peak| per bucket
const durs = new Map<string, number>();          // path → the SOURCE's true length (s), straight off the decode
const pending = new Set<string>();               // decodes in flight (dedupe — a lane re-renders constantly)
const failed = new Set<string>();                // don't retry-storm an undecodable source on every render

// ⚠ OfflineAudioContext, NOT AudioContext. A live AudioContext OPENS AN OUTPUT STREAM ON THE DEFAULT
// DEVICE — and this app's entire audio path is a native JUCE engine driving that same device
// (audioClient.configure(channels, mode, layout)). On a rig where the engine takes the device exclusively
// (or via ASIO), a stray Chromium output handle can make the engine's configure() fail to open it — and
// the failure surfaces as NO AUDIO AT ALL, with the waveforms drawing perfectly. Peaks need decoding, not
// output, and decodeAudioData lives on BaseAudioContext, so an offline context has it. Zero devices.
let ctx: OfflineAudioContext | null = null;      // lazily created: constructing one per decode is wasteful

// Kick off a decode for `path` if we don't have it. Fire-and-forget: the lane re-renders on the engine's
// ~10 Hz tick anyway, so it picks the peaks up on the next pass without any subscription.
export function ensurePeaks(path: string): void {
  if (!path || peaks.has(path) || pending.has(path) || failed.has(path)) return;
  pending.add(path);
  void (async () => {
    try {
      const url = await ensureBlobUrl(path, mimeForPath(path));
      if (!url) throw new Error('no blob url');
      const buf = await (await fetch(url)).arrayBuffer();
      ctx ??= new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      // THE SOURCE DURATION, FOR FREE. Every bed clip minted before this wave has NO `sourceDuration`
      // (AudioBedPanel.addClip never wrote it), and sanitizeAudioClip deliberately does not fabricate one.
      // Without it the lane's trim cap is `Infinity` and the waveform re-squeezes the whole file into the
      // visible window on every trim. The decode already knows the answer — cache it, and require NO
      // migration write to anyone's project on load. (decodeAudioData resamples to the context's rate; the
      // duration in SECONDS is preserved.)
      durs.set(path, audio.duration);
      const ch = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(ch.length / PEAK_BUCKETS));
      const out = new Float32Array(PEAK_BUCKETS);
      for (let b = 0; b < PEAK_BUCKETS; b++) {
        let m = 0;
        const s = b * per, e = Math.min(ch.length, s + per);
        for (let i = s; i < e; i++) { const v = Math.abs(ch[i]); if (v > m) m = v; }
        out[b] = m;
      }
      peaks.set(path, out);
    } catch {
      failed.add(path);   // undecodable / missing — the lane draws a flat bar, the driver reports the load failure
    } finally {
      pending.delete(path);
    }
  })();
}

// The SOURCE's true length, recovered from the decode. Null while decoding / undecodable.
//
// This is the trim cap and the waveform's time base for a clip that carries NO `sourceDuration` — i.e.
// EVERY clip on EVERY bed authored before this wave. The alternative (a load-time backfill) would write to
// the user's document on open, which this codebase does not do.
export function sourceDurationFor(path: string): number | null {
  const d = durs.get(path);
  if (d === undefined) { ensurePeaks(path); return null; }
  return d > 0 ? d : null;
}

// The cached peaks, downsampled to `buckets`. Null while decoding (or if it failed) — draw a flat bar.
export function peaksFor(path: string, buckets: number): Float32Array | null {
  const full = peaks.get(path);
  if (!full) { ensurePeaks(path); return null; }
  if (buckets >= full.length) return full;
  const out = new Float32Array(buckets);
  const per = full.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = Math.floor(b * per), e = Math.floor((b + 1) * per);
    for (let i = s; i < e; i++) if (full[i] > m) m = full[i];
    out[b] = m;
  }
  return out;
}

// A dropped file's real length, for the clip's initial `duration`/`sourceDuration`. Resolves null when the
// browser can't decode it (an .aiff, say) — the caller then places a default-length clip the user can trim,
// which is strictly better than refusing the drop.
export function probeAudioDuration(path: string): Promise<number | null> {
  return (async () => {
    try {
      const url = await ensureBlobUrl(path, mimeForPath(path));
      if (!url) return null;
      return await new Promise<number | null>((resolve) => {
        const el = document.createElement('audio');
        el.preload = 'metadata';
        el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
        el.onerror = () => resolve(null);
        el.src = url;
      });
    } catch { return null; }
  })();
}
```

- [ ] **Step 3: `AudioLane.tsx`**

Create `src/renderer/components/timeline/AudioLane.tsx`. It follows the **AutomationLane idiom** (ground truth §3.2): the component IS the whole row — it renders its own `<div className="flex border-b border-line-1">` with its own `sticky left-0 z-20` gutter, unlike video lanes where `Timeline.tsx` owns the gutter wrapper.

```tsx
// One audio lane: an AudioTrack's clips on the same time axis as the video lanes.
//
// TWO CONTAINERS, ONE COMPONENT. `source` says which:
//   'bed'      — ProjectData.audio. Rides the SHOW clock. Drawn ONLY while Global is bound (there, show
//                clock ≡ playhead, so the ruler is honest; inside a scene the two diverge and drawing the
//                bed against a scene-relative ruler would be a LIE). Commits via onChangeMix.
//   'timeline' — this document's own Timeline.audio. Rides the PLAYHEAD, restarts with its timeline.
//                Commits via onChange(timeline) — the EXPENSIVE path (setData → recompile + a
//                structured-clone postMessage of the whole doc to every projector port).
// Every callback carries `source` back to the parent for exactly that reason.
//
// DRAFT LOCALLY, COMMIT ONCE ON POINTERUP. Non-negotiable (see ClipBlock/AutomationLane): a commit per
// pointermove re-enters App → setScenes/setAudioMix → engine.setData → warmMedia + pruneStaleLayers +
// compileAutomation + a postMessage per projector, 60×/s — and setData can emit a `pause` intent, which
// stops the bed. The DRAG STATE LIVES IN Timeline.tsx (window listeners, snapping, the one commit); this
// component is dumb and only reports pointerdowns, exactly like ClipBlock.
import React from 'react';
import { Trash2, Volume2, VolumeX, Headphones, Music } from 'lucide-react';
import type { AudioClip, AudioTrack } from '../../types';
import { AUDIO_LANE_H, GUTTER, fmtClock } from './geometry';
import { peaksFor, sourceDurationFor } from './audioPeaks';

export type AudioDragMode = 'move' | 'l' | 'r' | 'fadeIn' | 'fadeOut';

export interface AudioLaneProps {
  track: AudioTrack;
  clips: AudioClip[];
  source: 'bed' | 'timeline';
  selectedId: string | null;
  tool: 'select' | 'blade';
  pxPerSec: number;
  width: number;
  onPatchTrack: (patch: Partial<AudioTrack>) => void;
  onRemoveTrack: () => void;
  onStartDrag: (e: React.PointerEvent, clip: AudioClip, mode: AudioDragMode, source: 'bed' | 'timeline') => void;
  onBlade: (clip: AudioClip, clientX: number, source: 'bed' | 'timeline') => void;
  onRemoveClip: (clipId: string, source: 'bed' | 'timeline') => void;
  onSelect: (clipId: string, source: 'bed' | 'timeline') => void;
  onSeek: (clientX: number) => void;
  onDropAsset: (e: React.DragEvent, trackId: string, source: 'bed' | 'timeline') => void;
}

const H = AUDIO_LANE_H;
const BODY_H = H - 8;   // the clip block insets 4px top and bottom

// The waveform, as an SVG path over the clip's VISIBLE window [inPoint, inPoint + duration) of the source.
// Trimming a clip must move the wave under it, not rescale it — that is the whole point of a waveform.
//
// ⚠ THE SOURCE LENGTH IS NOT `clip.duration`. Falling back to it (`clip.sourceDuration ?? clip.duration`)
// is what makes the wave LIE: on a clip with no `sourceDuration` — which is every clip on every bed
// authored before this wave — `src` would shrink WITH `duration` on every trim, so `t1` is always 1 and
// the whole file is re-squeezed into the visible window each frame. Ask the decode instead
// (`sourceDurationFor`), and if even that is unknown (still decoding, or undecodable), draw a FLAT BAR
// rather than a false one.
const Wave: React.FC<{ clip: AudioClip; widthPx: number }> = ({ clip, widthPx }) => {
  const buckets = Math.max(1, Math.min(600, Math.floor(widthPx)));
  const src = clip.sourceDuration ?? sourceDurationFor(clip.path);
  const full = peaksFor(clip.path, 2048);
  if (!full || !src || !(src > 0)) {
    return <div className="absolute inset-x-0 top-1/2 h-px bg-fg-3/40 pointer-events-none" />; // decoding / undecodable
  }
  const t0 = clip.inPoint / src, t1 = Math.min(1, (clip.inPoint + clip.duration) / src);
  const mid = BODY_H / 2;
  const pts: string[] = [];
  for (let i = 0; i < buckets; i++) {
    const f = t0 + ((t1 - t0) * i) / Math.max(1, buckets - 1);
    const v = full[Math.min(full.length - 1, Math.max(0, Math.floor(f * full.length)))] ?? 0;
    const x = ((i / Math.max(1, buckets - 1)) * widthPx).toFixed(1);
    pts.push(`${x},${(mid - v * mid * 0.92).toFixed(1)}`);
  }
  for (let i = buckets - 1; i >= 0; i--) {
    const f = t0 + ((t1 - t0) * i) / Math.max(1, buckets - 1);
    const v = full[Math.min(full.length - 1, Math.max(0, Math.floor(f * full.length)))] ?? 0;
    const x = ((i / Math.max(1, buckets - 1)) * widthPx).toFixed(1);
    pts.push(`${x},${(mid + v * mid * 0.92).toFixed(1)}`);
  }
  return (
    <svg width={widthPx} height={BODY_H} className="absolute inset-0 pointer-events-none" preserveAspectRatio="none">
      <path d={`M${pts.join(' L')}Z`} className="fill-accent/45" />
    </svg>
  );
};

const AudioClipBlock: React.FC<{
  clip: AudioClip; selected: boolean; blade: boolean; pxPerSec: number;
  source: 'bed' | 'timeline';
  onStartDrag: AudioLaneProps['onStartDrag'];
  onBlade: AudioLaneProps['onBlade'];
  onRemoveClip: AudioLaneProps['onRemoveClip'];
  onSelect: AudioLaneProps['onSelect'];
}> = ({ clip, selected, blade, pxPerSec, source, onStartDrag, onBlade, onRemoveClip, onSelect }) => {
  const widthPx = Math.max(6, clip.duration * pxPerSec);
  const fadeInPx = Math.max(0, Math.min(clip.fadeIn ?? 0, clip.duration)) * pxPerSec;
  const fadeOutPx = Math.max(0, Math.min(clip.fadeOut ?? 0, clip.duration)) * pxPerSec;

  const onDown = (e: React.PointerEvent) => {
    if (blade) { e.stopPropagation(); e.preventDefault(); onBlade(clip, e.clientX, source); return; }
    onSelect(clip.id, source);
    onStartDrag(e, clip, 'move', source);
  };

  return (
    <div
      onPointerDown={onDown}
      className={`absolute top-1 bottom-1 rounded-sm border overflow-hidden ${blade ? 'cursor-col-resize' : 'cursor-grab'} ${selected ? 'border-accent bg-accent/20' : 'border-line-2 bg-surface-3'} ${clip.mute ? 'opacity-40' : ''}`}
      style={{ left: clip.start * pxPerSec, width: widthPx }}
      title={`${clip.name} — ${fmtClock(clip.duration)}`}
    >
      {widthPx > 12 && <Wave clip={clip} widthPx={widthPx} />}

      {/* THE FADE RAMPS — the visual truth of AudioClip.fadeIn/fadeOut, which the driver now honours (D9).
          Drawn as triangles over the wave, so what you see is the gain envelope you hear. */}
      {fadeInPx > 1 && (
        <svg width={fadeInPx} height={BODY_H} className="absolute left-0 top-0 pointer-events-none" preserveAspectRatio="none">
          <path d={`M0,0 L${fadeInPx},0 L0,${BODY_H} Z`} className="fill-surface-0/70" />
        </svg>
      )}
      {fadeOutPx > 1 && (
        <svg width={fadeOutPx} height={BODY_H} className="absolute right-0 top-0 pointer-events-none" preserveAspectRatio="none">
          <path d={`M${fadeOutPx},0 L${fadeOutPx},${BODY_H} L0,0 Z`} className="fill-surface-0/70" />
        </svg>
      )}

      <div className="absolute inset-x-0 top-0 h-3.5 bg-gradient-to-b from-black/55 to-transparent pointer-events-none" />
      <div className="relative px-1.5 pt-0.5 text-micro leading-tight truncate text-fg-1 pointer-events-none drop-shadow flex items-center gap-1">
        <Music size={9} className="shrink-0 opacity-70" />{clip.name}
      </div>

      {!blade && <>
        {/* trim handles — same 6px targets as ClipBlock */}
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'l', source); }}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'r', source); }}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        {/* THE FADE CORNER HANDLES (D9) — the DAW idiom: drag the top corner in to lengthen the fade.
            Offset past the trim handles (left-1.5 / right-1.5) so the two targets never fight. */}
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'fadeIn', source); }}
          title="Fade in — drag right" style={{ left: Math.max(6, fadeInPx) - 4 }}
          className="absolute top-0 w-2 h-2 rounded-sm bg-accent/70 hover:bg-accent cursor-ew-resize" />
        <div onPointerDown={(e) => { e.stopPropagation(); onSelect(clip.id, source); onStartDrag(e, clip, 'fadeOut', source); }}
          title="Fade out — drag left" style={{ right: Math.max(6, fadeOutPx) - 4 }}
          className="absolute top-0 w-2 h-2 rounded-sm bg-accent/70 hover:bg-accent cursor-ew-resize" />
      </>}

      {selected && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemoveClip(clip.id, source)}
          className="absolute top-0.5 right-2 text-fg-2 hover:text-danger"><Trash2 size={10} /></button>
      )}
    </div>
  );
};

export const AudioLane: React.FC<AudioLaneProps> = ({
  track, clips, source, selectedId, tool, pxPerSec, width,
  onPatchTrack, onRemoveTrack, onStartDrag, onBlade, onRemoveClip, onSelect, onSeek, onDropAsset,
}) => {
  const blade = tool === 'blade';
  const muted = !!track.mute;
  // ⚠ THE GUTTER'S FADER AND NAME FIELD ARE DRAFTED LOCALLY AND COMMITTED ONCE — invariant 7, in the file
  // whose own header states it. React maps `onChange` on a range/text input to the DOM `input` event: every
  // pointermove of the fader, every keystroke of the name. For source === 'timeline' one commit is
  // onChange(timeline) → App.handleTimelineChange → setScenes/setTimeline → engine.setData →
  // clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation + a structured-clone
  // postMessage of the WHOLE doc to EVERY projector port, plus the audio fan-out's syncLoaded/syncClips.
  // And clampPlayheadIntoDoc CAN EMIT A `pause` INTENT — so at 60 Hz, with the scene parked at its end,
  // TYPING A TRACK'S NAME WOULD STOP THE TRANSPORT AND KILL THE BED this whole wave exists to protect.
  // Mute/solo/remove are discrete — one commit each — and stay as plain onClick.
  const [gainDraft, setGainDraft] = React.useState<number | null>(null);
  const [nameDraft, setNameDraft] = React.useState<string | null>(null);
  const commitGain = () => { if (gainDraft != null) onPatchTrack({ gain: gainDraft }); setGainDraft(null); };
  const commitName = () => { if (nameDraft != null && nameDraft !== track.name) onPatchTrack({ name: nameDraft }); setNameDraft(null); };
  return (
    <div className={`flex border-b border-line-1 ${muted ? 'opacity-50' : ''} ${track.solo ? 'bg-accent/5' : ''}`}>
      {/* gutter — the component owns it (the AutomationLane/StateLane idiom, not the video-lane one) */}
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex flex-col justify-center gap-0.5 px-2 py-1"
        style={{ width: GUTTER, height: AUDIO_LANE_H }}>
        <div className="flex items-center gap-1">
          <Music size={10} className="text-fg-3 shrink-0" />
          {/* draft on keystroke, commit on blur / Enter (Escape abandons) */}
          <input value={nameDraft ?? track.name}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNameDraft(null); }}
            className="flex-1 min-w-0 bg-transparent outline-none text-micro text-fg-1 truncate" />
          <button onClick={onRemoveTrack} title="Remove track (and its clips)" className="text-fg-3 hover:text-danger"><Trash2 size={11} /></button>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => onPatchTrack({ mute: !track.mute })} title={track.mute ? 'Unmute' : 'Mute'}
            className={track.mute ? 'text-danger' : 'text-fg-3 hover:text-fg-1'}>
            {track.mute ? <VolumeX size={11} /> : <Volume2 size={11} />}
          </button>
          <button onClick={() => onPatchTrack({ solo: !track.solo })} title={track.solo ? 'Un-solo' : 'Solo'}
            className={track.solo ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}><Headphones size={11} /></button>
          {/* draft on drag, commit ONCE on pointerup / keyboard release / blur */}
          <input type="range" min={0} max={1.5} step={0.01} value={gainDraft ?? track.gain ?? 1}
            onChange={(e) => setGainDraft(Number(e.target.value))}
            onPointerUp={commitGain} onKeyUp={commitGain} onBlur={commitGain}
            title={`gain ${(gainDraft ?? track.gain ?? 1).toFixed(2)}`} className="flex-1 min-w-0 accent-accent" />
          {/* Which container this track belongs to — the clock is not a detail the user can guess. */}
          <span className="text-micro text-fg-3 shrink-0" title={source === 'bed'
            ? 'The BED — one per project. Rides the show clock: it does NOT restart when a scene is recalled.'
            : "This timeline's own audio. Rides the playhead: it restarts when this timeline does."}>
            {source === 'bed' ? 'BED' : 'TL'}
          </span>
        </div>
      </div>

      {/* body */}
      <div className="relative" style={{ width, height: AUDIO_LANE_H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/artlux-asset')) e.preventDefault(); }}
        onDrop={(e) => onDropAsset(e, track.id, source)}
        onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) onSeek(e.clientX); }}>
        {clips.map(c => (
          <AudioClipBlock key={c.id} clip={c} selected={selectedId === c.id} blade={blade} pxPerSec={pxPerSec}
            source={source} onStartDrag={onStartDrag} onBlade={onBlade} onRemoveClip={onRemoveClip} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
};
```
⚠ **Design tokens only.** No `text-[Npx]` anywhere in this file (`text-micro` is the 10 px floor), no raw hex in `className`. The guardrail grep must return 0.

---

- [ ] **Step 4: `Timeline.tsx` — the drag rig, the commit, the drop**

`src/renderer/components/timeline/Timeline.tsx`.

**4a. Props + the two containers.** Add to `Props` (**:26-42**):
```ts
  // The GLOBAL audio bed (ProjectData.audio). Passed straight down from App, because the bed's lanes are
  // drawn on THIS ruler while Global is bound — there, show clock ≡ playhead, so the ruler is honest.
  // Absent while a scene is bound (App decides), and the header shows a `♪ BED mm:ss` readout instead.
  audio?: { mix: AudioMix; onChangeMix: (m: AudioMix) => void };
```
and derive:
```ts
  const bedTracks = props.audio?.mix.tracks ?? [];
  const bedClips = props.audio?.mix.clips ?? [];
  const tlTracks = timelineAudioTracks(timeline);
  const tlClips = timelineAudioClips(timeline);
  // ONE draft for a dragged audio clip, tagged with its container so the commit knows which array to write.
  const [audioDraft, setAudioDraft] = useState<{ clip: AudioClip; source: 'bed' | 'timeline' } | null>(null);
  const audioDraftRef = useRef<typeof audioDraft>(null); audioDraftRef.current = audioDraft;
  const audioRef = useRef(props.audio); audioRef.current = props.audio;
  // WHICH ARRAY the single `selected` id lives in. `selected` (:65) is one id for THREE arrays now, and
  // every consumer of it has to be told which — see deleteSelected below, which is a live bug without it.
  // (Task 7's selection channel publishes this same value to the mixer; it is introduced HERE because
  // Task 5 is what first puts a non-video id into `selected`.)
  const [selectedSource, setSelectedSource] = useState<'video' | 'bed' | 'timeline'>('video');
```
⚠ Every existing `setSelected(id)` for a **video** clip (`onStartDrag` **:248**, `createContentClip` **:488**) also does `setSelectedSource('video')`, and `removeLayer` (**:267-271**) resets it with its `setSelected(null)`.

**4b. The two commit helpers** — this is where "the lane must be told which path it is on" becomes code:
```ts
  // TWO CONTAINERS, TWO COMMIT PATHS, TWO VERY DIFFERENT COSTS.
  //   bed      → onChangeMix → App.setAudioMix → recompileAutomation() + the audio host fan-out.
  //   timeline → onChange(timeline) → App.handleTimelineChange → setScenes/setTimeline → engine.setData →
  //              clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation + a
  //              structured-clone postMessage of the WHOLE doc to EVERY projector port.
  // Both are called EXACTLY ONCE, on pointerup. Never per pointermove. (Invariant 7.)
  const commitBedClips = useCallback((clips: AudioClip[]) => {
    const a = audioRef.current; if (!a) return;
    a.onChangeMix({ ...a.mix, clips });
  }, []);
  const commitTlClips = useCallback((clips: AudioClip[]) => {
    const t = timelineRef.current;
    onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t), clips } });
  }, []);
  const commitAudioClips = useCallback((source: 'bed' | 'timeline', clips: AudioClip[]) => {
    if (source === 'bed') commitBedClips(clips); else commitTlClips(clips);
  }, [commitBedClips, commitTlClips]);
  const audioClipsOf = (source: 'bed' | 'timeline'): AudioClip[] =>
    source === 'bed' ? (audioRef.current?.mix.clips ?? []) : timelineAudioClips(timelineRef.current);
```

**4c. The drag** — modelled line-for-line on `onDragMove`/`onDragUp`/`onStartDrag` (**Timeline.tsx:216-251**), with two extra modes:
```ts
  const audioDragRef = useRef<{ mode: AudioDragMode; clip: AudioClip; source: 'bed' | 'timeline'; x0: number; points: SnapPoint[] } | null>(null);

  const onAudioDragMove = useCallback((e: PointerEvent) => {
    const d = audioDragRef.current; if (!d) return;
    const px = pxRef.current; const ds = (e.clientX - d.x0) / px; const c = d.clip;
    const thr = 8 / px; const en = snapRefEnabled.current; const pts = d.points;
    // THE RIGHT-TRIM CAP. Never `Infinity`: a clip with no `sourceDuration` (every bed clip authored
    // before this wave) would then have NO cap at all — drag its right edge from 30 s to 5 minutes and the
    // lane draws it happily, the driver's window test calls it "in window" for 4½ minutes of source that
    // does not exist, and the show HOLDS ON SILENCE. Ask the decode (`sourceDurationFor`); if the source
    // length is still unknown, the cap is the clip's CURRENT duration — you may shorten it, you may not
    // invent source you cannot prove exists.
    const srcLen = c.sourceDuration ?? sourceDurationFor(c.path);
    const srcCap = srcLen != null ? Math.max(0.1, srcLen - c.inPoint) : c.duration;
    if (d.mode === 'move') {
      const raw = Math.max(0, c.start + ds);
      let st = raw, guide: number | null = null;
      if (en) {
        let s = snap(raw, pts, thr);
        if (!s.snapped) { const e2 = snap(raw + c.duration, pts, thr); if (e2.snapped) s = { t: e2.t - c.duration, snapped: true, guideTime: e2.guideTime }; }
        if (s.snapped) { st = Math.max(0, s.t); guide = s.guideTime; }
      }
      setAudioDraft({ clip: { ...c, start: st }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'r') {
      let dur = clamp(c.duration + ds, 0.1, srcCap); let guide: number | null = null;
      if (en) { const e2 = snap(c.start + dur, pts, thr); if (e2.snapped) { dur = clamp(e2.t - c.start, 0.1, srcCap); guide = e2.guideTime; } }
      // A shorter clip cannot carry longer fades than it has room for — clamp them with it, or the driver
      // would compute a ramp longer than the clip and hand the engine a gain that never reaches 1.
      setAudioDraft({ clip: { ...c, duration: dur, fadeIn: Math.min(c.fadeIn ?? 0, dur) || undefined, fadeOut: Math.min(c.fadeOut ?? 0, dur) || undefined }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'l') {
      // A TRUE SOURCE TRIM: start, inPoint AND duration move together (same as the video 'l' branch).
      let delta = clamp(ds, -c.inPoint, c.duration - 0.1); let guide: number | null = null;
      if (en) { const s = snap(c.start + delta, pts, thr); if (s.snapped) { delta = clamp(s.t - c.start, -c.inPoint, c.duration - 0.1); guide = s.guideTime; } }
      const dur = c.duration - delta;
      setAudioDraft({ clip: { ...c, start: Math.max(0, c.start + delta), inPoint: Math.max(0, c.inPoint + delta), duration: dur, fadeIn: Math.min(c.fadeIn ?? 0, dur) || undefined, fadeOut: Math.min(c.fadeOut ?? 0, dur) || undefined }, source: d.source }); showGuide(guide);
    } else if (d.mode === 'fadeIn') {
      // D9. Fades do NOT snap: they are a gain envelope, not a time edit — snapping them to clip edges
      // and markers would make short fades impossible to author at any sane zoom.
      const fi = clamp((c.fadeIn ?? 0) + ds, 0, c.duration);
      setAudioDraft({ clip: { ...c, fadeIn: fi > 0 ? fi : undefined }, source: d.source }); showGuide(null);
    } else { // 'fadeOut' — drag LEFT to lengthen, hence the negated delta
      const fo = clamp((c.fadeOut ?? 0) - ds, 0, c.duration);
      setAudioDraft({ clip: { ...c, fadeOut: fo > 0 ? fo : undefined }, source: d.source }); showGuide(null);
    }
  }, [showGuide]);

  const onAudioDragUp = useCallback(() => {
    const d = audioDraftRef.current;
    // THE ONE COMMIT. Outside any state updater (a commit inside setAudioDraft(d => …) would be a
    // render-phase update to App, which React 19 StrictMode double-invokes — see AutomationLane:109-111).
    if (audioDragRef.current && d) {
      commitAudioClips(d.source, audioClipsOf(d.source).map(c => (c.id === d.clip.id ? d.clip : c)));
    }
    setAudioDraft(null); audioDragRef.current = null; showGuide(null);
    window.removeEventListener('pointermove', onAudioDragMove); window.removeEventListener('pointerup', onAudioDragUp);
  }, [onAudioDragMove, showGuide, commitAudioClips]);

  const onAudioStartDrag = useCallback((e: React.PointerEvent, clip: AudioClip, mode: AudioDragMode, source: 'bed' | 'timeline') => {
    if (e.button !== 0) return;            // middle-drag pans the timeline
    e.stopPropagation(); e.preventDefault();
    // Snap points are captured ONCE at pointerdown (same as the video drag). Audio clip edges come in via
    // the new `extra` parameter — collectSnapPoints is Timeline-typed and cannot see them. The clip being
    // dragged is EXCLUDED from both lists, or the first 8 px of every drag land back on the value you
    // started from — a dead zone the handle refuses to leave.
    const extra: SnapPoint[] = [...audioClipsOf('bed'), ...timelineAudioClips(timelineRef.current)]
      .filter(c => c.id !== clip.id)
      .flatMap(c => ([{ t: c.start, kind: 'clipEdge' as const }, { t: c.start + c.duration, kind: 'clipEdge' as const }]));
    audioDragRef.current = {
      mode, clip: { ...clip }, source, x0: e.clientX,
      points: collectSnapPoints(timelineRef.current, engine.getPlayhead(), undefined, undefined, extra),
    };
    window.addEventListener('pointermove', onAudioDragMove); window.addEventListener('pointerup', onAudioDragUp);
  }, [onAudioDragMove, onAudioDragUp]);
```

**4d. Blade / remove / track ops:**
```ts
  const onAudioBlade = useCallback((clip: AudioClip, clientX: number, source: 'bed' | 'timeline') => {
    commitAudioClips(source, splitClipAt(audioClipsOf(source), clip.id, clientXToTime(clientX)));
  }, [clientXToTime, commitAudioClips]);
  const onAudioRemoveClip = useCallback((id: string, source: 'bed' | 'timeline') => {
    commitAudioClips(source, liftDelete(audioClipsOf(source), id));
    setSelected(s => (s === id ? null : s));
  }, [commitAudioClips]);
  const patchAudioTrack = (source: 'bed' | 'timeline', id: string, patch: Partial<AudioTrack>) => {
    if (source === 'bed') { const a = audioRef.current; if (!a) return; a.onChangeMix({ ...a.mix, tracks: a.mix.tracks.map(t => t.id === id ? { ...t, ...patch } : t) }); }
    else { const t = timelineRef.current; onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t).map(x => x.id === id ? { ...x, ...patch } : x), clips: timelineAudioClips(t) } }); }
  };
  const removeAudioTrack = (source: 'bed' | 'timeline', id: string) => {
    if (source === 'bed') { const a = audioRef.current; if (!a) return; a.onChangeMix({ ...a.mix, tracks: a.mix.tracks.filter(t => t.id !== id), clips: a.mix.clips.filter(c => c.trackId !== id) }); }
    else { const t = timelineRef.current; onChangeRef.current({ ...t, audio: { tracks: timelineAudioTracks(t).filter(x => x.id !== id), clips: timelineAudioClips(t).filter(c => c.trackId !== id) } }); }
  };
  const addAudioTrack = (source: 'bed' | 'timeline') => {
    const track: AudioTrack = { id: crypto.randomUUID(), name: `Audio ${(source === 'bed' ? bedTracks.length : tlTracks.length) + 1}`, gain: 1, mute: false };
    if (source === 'bed') { const a = audioRef.current; if (!a) return; a.onChangeMix({ ...a.mix, tracks: [...a.mix.tracks, track] }); }
    else { const t = timelineRef.current; onChangeRef.current({ ...t, audio: { tracks: [...timelineAudioTracks(t), track], clips: timelineAudioClips(t) } }); }
  };
```

**4d-bis. `deleteSelected` (`:391`) MUST branch on the source.** It is the keyboard **Delete**, wired into the shortcut map at `:530`, and the plan is not finished without it:
```ts
  // `selected` now names an id in ONE OF THREE ARRAYS (video clips, the bed's clips, this timeline's audio
  // clips), and this filtered `timeline.clips` unconditionally. Selecting an audio clip and pressing Delete
  // would: leave the clip exactly where it is (liftDelete finds nothing to remove), CLEAR the selection (so
  // the mixer's inspector empties and it LOOKS like something happened), and still fire a full onChange —
  // liftDelete always returns a NEW array — driving setData → warmMedia + pruneStaleLayers +
  // compileAutomation + a structured-clone postMessage to every projector port, for a document that did not
  // change. Invariant 7's entire cost, paid for nothing, on a no-op.
  const deleteSelected = (ripple: boolean) => {
    if (!selected) return;
    // No ripple for audio: rippleDelete is layerId-bound and audio has no ripple in Wave B (operations.ts).
    if (selectedSource !== 'video') { onAudioRemoveClip(selected, selectedSource); return; }
    onChange({ ...timeline, clips: ripple ? rippleDelete(timeline.clips, selected) : liftDelete(timeline.clips, selected) });
    setSelected(null);
  };
```

**4e. The drop.** Today an `'audio'` asset dropped on a video lane **dies silently** at `Timeline.tsx:421` (`if (asset.type !== 'video') return;`). Audio lanes get their own handler — and it places the clip **at the drop X**, not at the playhead (which is what `AudioBedPanel.tsx:138` does, and which is wrong on a show-clock container anyway):
```ts
  const onDropAudioAsset = (e: React.DragEvent, trackId: string, source: 'bed' | 'timeline') => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/artlux-asset');
    if (!raw) return;
    let asset: { type?: string; path?: string };
    try { asset = JSON.parse(raw); } catch { return; }
    if (asset.type !== 'audio' || !asset.path) return;
    const path = asset.path;
    const start = clientXToTime(e.clientX);
    const name = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'audio';
    const place = (d: number) => {
      const clip: AudioClip = { id: crypto.randomUUID(), trackId, name, path, start, duration: d, inPoint: 0, sourceDuration: d, gain: 1, mute: false };
      commitAudioClips(source, [...audioClipsOf(source), clip]);
      setSelected(clip.id);
      ensurePeaks(path);
    };
    // Core probes the duration with the browser; the native engine loads the file for playback itself
    // (the audio driver's syncLoaded). An undecodable-by-Chromium source (some .aiff) still gets a clip —
    // a default-length one the user can trim — rather than a drop that silently does nothing.
    void probeAudioDuration(path).then(d => place(d && d > 0 ? d : DEFAULT_AUDIO_DURATION));
  };
  const DEFAULT_AUDIO_DURATION = 10;
```
Also **relax `Timeline.tsx:421`**: leave the `return` for `'audio'` (a video lane genuinely cannot hold audio) but make it *say so* — `if (asset.type !== 'video') return; // audio goes on an audio lane (AudioLane's own onDrop); a take on a video lane is rejected above`.

**4f. Mount the lanes.** Between the video-lanes block (ends **:681**) and the automation lanes (start **:685**), and add a `+ Audio` row next to the existing "+ Automation" row (**:701-717**):
```tsx
          {/* AUDIO LANES. The bed's tracks are drawn ONLY while Global is bound (props.audio is absent
              otherwise): there, show clock ≡ playhead, so the ruler is honest. Inside a scene the two
              clocks diverge and drawing the bed against a scene-relative ruler would be a lie. */}
          {props.audio && bedTracks.map(t => (
            <AudioLane key={`bed-${t.id}`} track={t} source="bed"
              clips={bedClips.filter(c => c.trackId === t.id).map(c => (audioDraft?.source === 'bed' && audioDraft.clip.id === c.id ? audioDraft.clip : c))}
              selectedId={selected} tool={tool} pxPerSec={pxPerSec} width={Math.max(width, 100)}
              onPatchTrack={(p) => patchAudioTrack('bed', t.id, p)} onRemoveTrack={() => removeAudioTrack('bed', t.id)}
              onStartDrag={onAudioStartDrag} onBlade={onAudioBlade} onRemoveClip={onAudioRemoveClip}
              onSelect={(id, src) => { setSelected(id); setSelectedSource(src); }} onSeek={seekTo} onDropAsset={onDropAudioAsset} />
          ))}
          {tlTracks.map(t => (
            <AudioLane key={`tl-${t.id}`} track={t} source="timeline"
              clips={tlClips.filter(c => c.trackId === t.id).map(c => (audioDraft?.source === 'timeline' && audioDraft.clip.id === c.id ? audioDraft.clip : c))}
              selectedId={selected} tool={tool} pxPerSec={pxPerSec} width={Math.max(width, 100)}
              onPatchTrack={(p) => patchAudioTrack('timeline', t.id, p)} onRemoveTrack={() => removeAudioTrack('timeline', t.id)}
              onStartDrag={onAudioStartDrag} onBlade={onAudioBlade} onRemoveClip={onAudioRemoveClip}
              onSelect={(id, src) => { setSelected(id); setSelectedSource(src); }} onSeek={seekTo} onDropAsset={onDropAudioAsset} />
          ))}
```
and in the "+ Automation" gutter row, add beside it:
```tsx
              <button onClick={() => addAudioTrack('timeline')} title="Add an audio track to THIS timeline (rides the playhead; restarts with it)"
                className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1"><Plus size={11} /> Audio</button>
              {props.audio && (
                <button onClick={() => addAudioTrack('bed')} title="Add a BED track (rides the show clock; never restarts on a scene recall)"
                  className="text-micro text-fg-3 hover:text-fg-1 inline-flex items-center gap-1"><Plus size={11} /> Bed</button>
              )}
```

**4g. `isEmpty`** (**:543**) must count audio, or the hint card sits over a timeline full of audio clips:
```ts
  const isEmpty = layers.length === 0 && timeline.clips.length === 0
    && (timeline.automation?.length ?? 0) === 0
    && tlTracks.length === 0 && bedTracks.length === 0;
```

- [ ] **Step 5: `contentEnd` counts audio, and the OVERRUN BADGE (D8)**

**`contentEnd`** (**:83-86**) reads only `timeline.clips` — a long audio clip would fall off the right edge of the canvas:
```ts
  // CANVAS EXTENT ONLY — how far the view scrolls, NOT where playback stops (that is `end`, below).
  // Audio counts here: a 5-minute bed clip on a 60 s timeline must be visible and editable, or you cannot
  // reach the thing you just dropped. It does NOT count toward `Length` (see the overrun badge).
  const contentEnd = useMemo(
    () => Math.max(dur, timeline.outPoint ?? 0,
      ...timeline.clips.map(c => c.start + c.duration),
      ...tlClips.map(c => c.start + c.duration),
      ...bedClips.map(c => c.start + c.duration)),
    [timeline.clips, dur, timeline.outPoint, tlClips, bedClips],
  );
```

**The overrun badge — this does not exist yet.** (D8 assumed Wave A shipped a "content past the end" ruler warning and a one-click *Length → content end* fix. **It did not** — grep returns nothing; Wave A shipped the `normalizeTimeline` load-time raise + the `boundedDuration` marker instead. So build it here, counting video **and** audio.)

```ts
  // CONTENT PAST THE END must not be silently unplayable. `Length` bounds playback (Wave A), and an audio
  // clip does NOT extend it (D8: Length stays purely authored) — so a clip beyond `end` is authored
  // content that will never be heard or seen. Say so on the ruler, and offer the one-click fix.
  const overrunAt = useMemo(() => {
    const ends = [
      ...timeline.clips.map(c => c.start + c.duration),
      ...tlClips.map(c => c.start + c.duration),
      ...bedClips.map(c => c.start + c.duration),
    ];
    const far = Math.max(0, ...ends);
    return far > end + 1e-6 ? far : null;
  }, [timeline.clips, tlClips, bedClips, end]);
  // RAISE the out-point, never DELETE it. `timelineEnd` (types.ts:439-446) lets an out-point override
  // Length, so the fix has to move it — but nulling it DESTROYS an authored playable region: a user with a
  // deliberate `in 10 / out 40` clicks this once and their region is gone, with no signal and no undo hint.
  // If there is no out-point, there is nothing to raise.
  const fixLength = () => {
    if (overrunAt == null) return;
    onChange({ ...timeline, duration: overrunAt, outPoint: timeline.outPoint == null ? null : overrunAt });
  };
```
Pass to the ruler and render the badge in the toolbar row:
```tsx
            <TimelineRuler … overrunFrom={overrunAt != null ? end : null} overrunTo={overrunAt} />
```
```tsx
        {overrunAt != null && (
          <button onClick={fixLength}
            title={`Content runs to ${fmtClock(overrunAt)} but playback stops at ${fmtClock(end)}. Click to set Length to the content end${timeline.outPoint != null ? ' (and move the out-point there)' : ''}.`}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 h-5 rounded bg-warn/15 text-warn text-micro">
            <AlertTriangle size={10} /> content past the end — Length → {fmtClock(overrunAt)}
          </button>
        )}
```
(Place it in the `TimelineToolbar` transport zone; add an `overrun?: { at: number; onFix: () => void }` prop rather than smuggling JSX through — keep `TimelineToolbar` props-in/pure, like the rest of the file.)

`TimelineRuler.tsx` — a hatched band past the end, `pointer-events-none`, after the playable-range band (**:45-47**):
```tsx
      {/* Content past the END — authored but unplayable. Distinct from the playable band above. */}
      {overrunFrom != null && overrunTo != null && overrunTo > overrunFrom && (
        <div className="absolute top-0 bottom-0 bg-warn/10 border-l border-warn/50 pointer-events-none"
          style={{ left: overrunFrom * pxPerSec, width: (overrunTo - overrunFrom) * pxPerSec }} />
      )}
```

- [ ] **Step 6: the `♪ BED mm:ss` readout, and App wires the bed**

While a **scene** is bound the bed's lanes are not drawn, so the operator needs to see that it is still running. In `Timeline.tsx`'s author strip (**:548-608**), when `authoring`:
```tsx
              {/* The bed rides the SHOW clock, which has diverged from this ruler the moment a scene was
                  bound. Its lanes are not drawn here (that would be a lie); this is the honest readout. */}
              <span ref={bedTimeRef} className="text-micro text-fg-3 tabular-nums" title="The audio bed's position (the show clock) — it does not restart when a scene is recalled">♪ BED 0:00</span>
```
painted **imperatively** in the existing engine subscription (**:118-123** — invariant 3: this must never enter React state):
```ts
    if (bedTimeRef.current) bedTimeRef.current.textContent = `♪ BED ${fmtClock(engine.getShowTime())}`;
```

`src/renderer/App.tsx` — both `TimelinePanel` mounts (**:2023** and the fullscreen one) get:
```tsx
  audio={activeSceneId ? undefined : { mix: audioMix, onChangeMix: setAudioMix }}
```
⚠ Pass `undefined` while a scene is bound — that is what makes the bed's lanes disappear inside a scene, and it is the single line that enforces the "never draw the bed against a scene-relative ruler" rule.
⚠ `setAudioMix` is `(m: AudioMix) => void` — it does **not** normalize. `host.audio.setMix` (`App.tsx:1367`) does. For consistency and safety pass a wrapper: `onChangeMix: (m) => setAudioMix(normalizeAudioMix(m))`.

- [ ] **Step 7: Verify**

```
npx tsc -p tsconfig.json --noEmit                                        # exit 0
npm run build                                                            # exit 0
npm run verify:plugins                                                   # exit 0
git grep -n "text-\[[0-9]" -- src/renderer/components/timeline/          # must print NOTHING
```

**LIVE:**
1. Bound to **Global**: `+ Bed` and `+ Audio` both appear. Add one of each. Drag a `.wav` from the Media library onto each lane → **it lands where you dropped it**, with a **waveform**, at its **real length**.
2. Drag the clip. It moves smoothly and **snaps** to clip edges / the playhead / markers. **App does not re-render during the drag** (React DevTools: no commit until pointerup).
3. Trim the left edge → the waveform **slides under the clip** (a source trim), it does not rescale.
4. Drag a **fade corner** → the triangle grows. Play across it → **you hear the fade** (Task 6 makes the driver honour it; until then the ramp is visual only — note that in the commit).
5. Blade tool + click a clip → it splits.
6. Bind a **scene**: the **BED lanes vanish**, the `♪ BED` readout appears and **keeps counting**. The scene's own `+ Audio` lane is still there and still editable.
7. Drop an audio clip that ends past `Length` → **the ruler shows the warn band and the "content past the end" badge appears**. Click it → `Length` jumps to the content end and the badge clears. **Set an out-point first and repeat: the region SURVIVES** (the out-point moves to the content end; it is not deleted).
8. **Select an audio clip and press Delete.** It is **removed** (not "the selection clears and the clip stays").
9. **An OLD bed** (a project saved before this wave — its clips carry no `sourceDuration`): the waveform is **correct**, and the right trim handle **will not drag past the source's real end**. Drag it right as far as it will go → it stops at the file's length, not at infinity.
10. Drag the lane gutter's **fader** and type in its **name** field while the transport is playing: React DevTools shows **no App commit until pointerup / blur**, and nothing pauses.

- [ ] **Step 8: Commit** — `feat(timeline): audio lanes — waveforms, trim, blade, and fade handles`

---

### Task 6: WS-B2c — the driver plays `Timeline.audio`, and honours `solo` / `fadeIn` / `fadeOut`

The lane exists (Task 5) and the bed rides the show clock (Task 3). Now the driver plays **two containers on two clocks**, and stops silently ignoring three persisted fields.

**Three fields the driver ignores today** (ground truth §5.3): `AudioTrack.solo` (`types.ts:667`), `AudioClip.fadeIn` and `AudioClip.fadeOut` (`types.ts:655-656`). `audible()` (`plugin.renderer.ts:101`) consults none of them. D9 says the fades are built now, and Task 5 just gave the user corner handles to author them — so the driver must honour them or the handles are a lie.

**Files:**
- Modify: `plugins/audio/src/plugin.renderer.ts`
- Modify: `packages/sdk/src/renderer.ts` (`AudioService` gains the bound timeline's audio)
- Modify: `src/renderer/App.tsx` (`host.audio`)
- Modify: `src/renderer/host/plugins.ts` (`NOOP_HOST.audio`)

**Interfaces:**
- Consumes (Task 3): `host.show.getStatus().showTime`. Consumes (Task 4): `Timeline.audio`.
- **Produces:**
  ```ts
  // packages/sdk/src/renderer.ts — AudioService gains ONE member:
  export interface AudioService<Mix = unknown, TlAudio = unknown> {
    getMix(): Mix;
    setMix(mix: Mix): void;
    subscribe(cb: () => void): () => void;
    /** The BOUND timeline's own audio ({tracks, clips}) — plays on the PLAYHEAD and restarts with its
     *  timeline, unlike the bed. Re-read on every `subscribe` fire. */
    getTimelineAudio(): TlAudio;
  }
  ```

- [ ] **Step 1: the host exposes the bound timeline's audio**

`packages/sdk/src/renderer.ts:341-349` — add `getTimelineAudio()` to `AudioService` with the doc comment above.

`src/renderer/App.tsx:1365-1369` (`host.audio`):
```ts
    // TWO AUDIO CONTAINERS, TWO CLOCKS (see docs/TIMELINE.md).
    //   getMix()          — ProjectData.audio, THE BED. Rides the show clock. Survives a scene recall.
    //   getTimelineAudio()— the BOUND timeline's own Timeline.audio. Rides the playhead, restarts with it.
    // Both read live refs (this memo has [] deps) and both re-fire the same `subscribe` set, so the driver
    // re-syncs on either changing.
    audio: {
      getMix: () => audioMixRef.current,
      setMix: (mix) => setAudioMix(normalizeAudioMix(mix as Partial<AudioMix>)),
      getTimelineAudio: () => activeTimelineRef.current.audio ?? { tracks: [], clips: [] },
      subscribe: (cb) => { audioSubs.current.add(cb); return () => { audioSubs.current.delete(cb); }; },
    },
```
This needs a live mirror — add beside `audioMixRef` (**App.tsx:218**):
```ts
  const activeTimelineRef = useRef(activeTimeline); activeTimelineRef.current = activeTimeline; // live mirror for host.audio ([]-deps memo)
```
and the fan-out (**App.tsx:1375**) must also fire when the bound timeline changes, or the driver never learns a clip was added/moved:
```ts
  // The audio host fan-out fires on EITHER container changing: the bed (audioMix) or the BOUND timeline's
  // own audio (activeTimeline). A scene recall changes activeTimeline, so the driver re-reads the incoming
  // scene's audio and drops the outgoing one's — which is exactly the restart-with-its-timeline semantics.
  useEffect(() => { audioSubs.current.forEach(cb => cb()); }, [audioMix, activeTimeline]);
```

`src/renderer/host/plugins.ts:47` (`NOOP_HOST.audio`) — **or `activateRendererPlugins` fails to typecheck** (H-7):
```ts
  audio: { getMix: () => ({ tracks: [], clips: [], buses: [] }), setMix: () => {}, getTimelineAudio: () => ({ tracks: [], clips: [] }), subscribe: () => () => {} },
```

- [ ] **Step 2: the driver holds two containers**

`plugins/audio/src/plugin.renderer.ts`. Extend the local structural types (**:29-32**) and the reader (**:40-47**):
```ts
interface BedClip { id: string; trackId: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean; fadeIn?: number; fadeOut?: number; spatial?: { x: number; y: number; z: number }; effects?: AudioEffectSpec[] }
interface BedTrack { id: string; gain?: number; mute?: boolean; solo?: boolean }
interface BedBus { id: string; gain?: number; effects?: AudioEffectSpec[] }
interface Bed { tracks: BedTrack[]; clips: BedClip[]; buses: BedBus[] }
// The BOUND timeline's own audio — same clip/track shape, no buses (there is one output chain).
interface TlAudio { tracks: BedTrack[]; clips: BedClip[] }

function readTlAudio(host: RendererHostServices): TlAudio {
  const a = (host.audio.getTimelineAudio() as Partial<TlAudio>) ?? {};
  return { tracks: Array.isArray(a.tracks) ? a.tracks : [], clips: Array.isArray(a.clips) ? a.clips : [] };
}
```
and the state (**:76**):
```ts
    let bed: Bed = readBed(host);
    let tlAudio: TlAudio = readTlAudio(host);
    // EVERY per-clip map below (loaded/sounding/sentGain/sentOffset/…) is keyed by CLIP ID and is shared
    // across both containers. Clip ids are UUIDs, so they cannot collide — and sharing means one
    // syncLoaded, one reconcile-shaped code path, and no chance of the two drifting apart.
    const allClips = (): BedClip[] => [...bed.clips, ...tlAudio.clips];
    const trackOfClip = (clip: BedClip): BedTrack | undefined =>
      bed.tracks.find(t => t.id === clip.trackId) ?? tlAudio.tracks.find(t => t.id === clip.trackId);
```
Replace **every** `bed.clips` iteration in `syncLoaded` (**:121-159**), `syncClips` (**:194-197**) and `tick`'s dirty drain (**:232**) with `allClips()`, and `trackOf` (**:92**) with `trackOfClip`.

Update the subscription (**:251**):
```ts
    unsubMix = host.audio.subscribe(() => {
      bed = readBed(host);
      tlAudio = readTlAudio(host);   // fires on a scene recall too (App's fan-out watches activeTimeline)
      void syncLoaded().then(syncClips);
    });
```

- [ ] **Step 3: `audible()` honours mute AND solo**

`plugin.renderer.ts:101`. Solo is **per-container**: soloing a bed track must not silence the bound timeline's audio, and vice versa — they are two different mixes on two different clocks, and a solo that reached across them would be baffling.
```ts
    // SOLO, honoured at last (AudioTrack.solo has been persisted and silently ignored since Wave 3).
    // Scoped PER CONTAINER: soloing a bed track silences the other BED tracks, not the bound timeline's
    // audio (two mixes, two clocks — a solo reaching across them would make no sense to an operator).
    const anySolo = (tracks: BedTrack[]) => tracks.some(t => t.solo);
    const audibleIn = (clip: BedClip, tracks: BedTrack[]) => {
      const tr = tracks.find(t => t.id === clip.trackId);
      if (clip.mute || tr?.mute || !loaded.has(clip.id)) return false;
      if (anySolo(tracks) && !tr?.solo) return false;
      return true;
    };
    const audible = (clip: BedClip) =>
      bed.clips.includes(clip) ? audibleIn(clip, bed.tracks) : audibleIn(clip, tlAudio.tracks);
```

- [ ] **Step 4: `fadeIn` / `fadeOut` — the driver finally honours them (D9)**

The native engine has **no envelope** — it takes a flat `gain` per clip (`audioClient.setClipGain`). So the fade is a **JS-scheduled gain**, recomputed each frame from the clip-local time. That is exactly what `reconcile` already does for a moving gain (`:210`: `if (sentGain.get(id) !== g) setClipGain(...)`), so it costs one extra multiply and **no extra IPC** when the value has not moved.

Add beside `effGain` (**:97-98**):
```ts
    // THE CLIP'S FADE ENVELOPE at a given container-clock time. Linear in gain (not dB) — this is a
    // clip-edge fade, not a mix fade, and every DAW draws it as the straight line we draw on the lane.
    //
    // The engine takes a FLAT gain per clip and has no envelope of its own, so the ramp is JS-scheduled:
    // reconcile() re-pushes gain only when it actually CHANGES (sentGain), so a steady clip costs zero IPC
    // and a fading one costs one setClipGain per frame — which is precisely what a moving automation lane
    // already costs, and the same audio lock.
    //
    // Overlapping fades on a clip shorter than fadeIn + fadeOut multiply, which is the correct and
    // conventional behaviour (the clip simply never reaches unity). Task 5's trim already clamps each fade
    // to the clip's duration, so neither can exceed it on its own.
    const fadeGain = (clip: BedClip, tLocal: number): number => {
      let g = 1;
      const fi = clip.fadeIn ?? 0;
      if (fi > 0 && tLocal < fi) g *= Math.max(0, tLocal / fi);
      const fo = clip.fadeOut ?? 0;
      if (fo > 0) {
        const left = clip.duration - tLocal;
        if (left < fo) g *= Math.max(0, left / fo);
      }
      return g;
    };
```
`effGain` takes the clip-local time:
```ts
    const effGain = (clip: BedClip, tLocal: number) =>
      (autoGain(clip.id) ?? clip.gain ?? 1)
      * (autoTrackGain(clip.trackId) ?? trackOfClip(clip)?.gain ?? 1)
      * fadeGain(clip, tLocal);
```
`startClip` (**:103-107**) already receives the source offset; give it the clip-local time too, and `reconcile` (**:199-222**) already computes exactly that number:
```ts
    const startClip = (clip: BedClip, srcOffset: number, tLocal: number, nowMs: number) => {
      const g = effGain(clip, tLocal);
      audioClient.playClip(clip.id, srcOffset, g);
      sounding.add(clip.id); sentGain.set(clip.id, g); sentOffset.set(clip.id, srcOffset); sentWallMs.set(clip.id, nowMs);
    };
```

- [ ] **Step 5: `reconcile` takes BOTH clocks**

Replace `reconcile` (**:199-222**) — one function, iterated over both containers with the right clock each:
```ts
    // ONE reconcile, TWO CLOCKS. `clips` and `t` are passed together so the container's clock can never
    // be applied to the wrong array — which is the entire bug class this wave exists to kill.
    const reconcileContainer = (clips: BedClip[], t: number, nowMs: number) => {
      for (const clip of clips) {
        const inWindow = t >= clip.start && t < clip.start + clip.duration;
        const isSounding = sounding.has(clip.id);
        const tLocal = t - clip.start;                       // clip-local time — the fade envelope's input
        if (inWindow && audible(clip) && !isSounding) {
          startClip(clip, clip.inPoint + tLocal, tLocal, nowMs);
        } else if (isSounding && (!inWindow || !audible(clip))) {
          stopSounding(clip.id);
        } else if (isSounding) {
          // In-window, audible, already sounding — track live gain (which now MOVES during a fade) and
          // re-lock after a retime / small seek the tick-level detector missed.
          const g = effGain(clip, tLocal);
          if (sentGain.get(clip.id) !== g) { audioClient.setClipGain(clip.id, g); sentGain.set(clip.id, g); }
          const desired = clip.inPoint + tLocal;
          const estimated = (sentOffset.get(clip.id) ?? desired) + (nowMs - (sentWallMs.get(clip.id) ?? nowMs)) / 1000;
          if (Math.abs(desired - estimated) > SYNC_THRESHOLD) {
            audioClient.playClip(clip.id, desired, g);
            sentOffset.set(clip.id, desired); sentWallMs.set(clip.id, nowMs);
          }
        }
      }
    };
    // ⚠ SUPERSEDED BY STEP 6 — it takes a `showEnded` flag and skips the BED when the show clock is parked
    // (DC2b). Written here only to show the two-clock routing; implement Step 6's four-argument version.
    const reconcile = (showTime: number, playhead: number, nowMs: number) => {
      reconcileContainer(bed.clips, showTime, nowMs);   // THE BED — show clock
      reconcileContainer(tlAudio.clips, playhead, nowMs); // the BOUND timeline's own audio — playhead
    };
```

- [ ] **Step 6: `tick` — the seek test stays on the SHOW clock, and gains a second**

The bound timeline's audio **must** restart on a recall (that is its whole contract), so it needs its own seek inference on the **playhead** — which is exactly the pre-existing test, unchanged in spirit.
```ts
    const tick = (playhead: number) => {
      const moved = takeDirty();
      if (moved.size > 0) {
        for (const clip of allClips()) if (moved.has(clip.id) && loaded.has(clip.id)) pushClipParams(eff(clip));
        if (moved.has(MASTER_BUS_ID)) syncMaster();
      }
      const nowMs = performance.now();
      const st = host.show.getStatus();
      const playing = st.playing;
      const showTime = st.showTime;
      const expectedDelta = prevPlaying ? (nowMs - prevWallMs) / 1000 : 0;
      // TWO CLOCKS, TWO SEEK TESTS — because the two containers WANT opposite things from a scene recall.
      //   showSeeked: the bed. A recall does NOT move showTime, so this stays false and the bed plays on.
      //              It goes true on a real seek, on Stop, on a project open, and on the GLOBAL loop wrap
      //              (the show looped — restarting the bed there is correct).
      //   phSeeked:  the bound timeline's audio. A recall mainSeeks the playhead, so this DOES go true and
      //              the scene's audio hard-resyncs at its new position — which is "it restarts with its
      //              timeline", exactly as specified.
      const showSeeked = Math.abs((showTime - prevShowTime) - expectedDelta) > SEEK_THRESHOLD;
      const phSeeked = Math.abs((playhead - prevPlayhead) - expectedDelta) > SEEK_THRESHOLD;

      if (prevPlaying && !playing) {
        stopAllSounding();                                  // paused → freeze everything
      } else if (playing && !prevPlaying) {
        stopAllSounding(); reconcile(showTime, playhead, st.showEnded, nowMs);   // resume → hard resync both
      } else if (playing) {
        // A seek on ONE clock must only resync THAT container. Stopping everything would put the bed's
        // restart back on every scene recall through the back door.
        if (showSeeked) for (const c of bed.clips) if (sounding.has(c.id)) stopSounding(c.id);
        if (phSeeked) for (const c of tlAudio.clips) if (sounding.has(c.id)) stopSounding(c.id);
        reconcile(showTime, playhead, st.showEnded, nowMs);
      }
      prevPlaying = playing; prevShowTime = showTime; prevPlayhead = playhead; prevWallMs = nowMs;
    };
```
⚠ **`showEnded` becomes BED-SCOPED here** (Task 3's version stopped everything, because there was only one container). The SHOW ending must not silence the BOUND timeline's own audio — that rides the playhead and is still playing. So `reconcile` takes the flag and routes it:
```ts
    const reconcile = (showTime: number, playhead: number, showEnded: boolean, nowMs: number) => {
      // THE SHOW IS OVER (DC2b): the show clock is PARKED — a frozen number. reconcileContainer against it
      // would re-seek every sounding bed clip back to the same source offset every ~50 ms, forever (the
      // drift re-lock at SYNC_THRESHOLD). Stop the BED and skip it; the bound timeline's audio is on the
      // playhead and knows nothing about the show's end.
      if (showEnded) { for (const c of bed.clips) if (sounding.has(c.id)) stopSounding(c.id); }
      else reconcileContainer(bed.clips, showTime, nowMs);      // THE BED — show clock
      reconcileContainer(tlAudio.clips, playhead, nowMs);       // the BOUND timeline's own audio — playhead
    };
```
(This **replaces** the two-line `reconcile` given in Step 5 — update it there rather than shipping both.)
Re-add `let prevPlayhead = 0;` beside `prevShowTime` (Task 3 removed it; it is needed again, for the *other* container).

⚠ `stopAllSounding()` (**:112-115**) clears the shared `sentGain`/`sentOffset`/`sentWallMs` maps wholesale. The per-container stops above use `stopSounding(id)` (**:108-111**), which deletes **only that clip's** entries — that is why the resync is surgical rather than global. Do not "simplify" it back to `stopAllSounding()`.

- [ ] **Step 7: Verify**

```
npx tsc -p tsconfig.json --noEmit                          # exit 0
npm run build                                              # exit 0
npm run verify:plugins                                     # exit 0 — against BUILT output
git grep -n "bed.clips" -- plugins/audio/src/plugin.renderer.ts   # only inside reconcile/audible/tick's per-container arms
```

**LIVE — the two clocks, heard:**
1. A bed clip **and** a `Timeline.audio` clip on the **global** timeline, overlapping. Play. **Both sound.**
2. Bind a scene with its own `Timeline.audio` clip. GO. **The bed plays straight through, uninterrupted; the scene's audio starts from the scene's top.** GO to another scene: **same again.**
3. Return to Global. The bed never stopped; the global timeline's own audio restarts.
4. **Solo** a bed track → the other **bed** tracks go silent; the scene's audio is **unaffected**.
5. **Mute** a track → silent. Unmute → back.
6. Author a 3 s **fadeIn** and a 3 s **fadeOut** on a clip. Play across it → **you hear it fade up and fade down**, and the ramp matches the triangles drawn on the lane.
7. A clip shorter than `fadeIn + fadeOut` → it swells and dies without reaching full level. No click, no NaN, no silence.
8. **The show ends, the scene does not.** Global Length 60, Loop off; a looping scene bound, with its own `Timeline.audio` clip. Run past 60 s. **The BED goes silent** (and stays silent — no buzz), and **the scene's own audio keeps looping with its picture.** That is the two clocks, heard separately.

- [ ] **Step 8: Commit** — `feat(audio): play Timeline.audio on the playhead; honour solo, fadeIn and fadeOut`

---

### Task 7: WS-B3a — the selection channel (core → plugin)

**The ground truth is blunt about this: it is NET-NEW PLUMBING, not a reuse.** The timeline's selection is a `useState<string | null>` **local to `Timeline.tsx:65`**, never lifted to App. `docs/TIMELINE.md:110-113` explicitly forbids it entering the `Timeline` data type ("ephemeral … must not enter `Timeline`"). And the Audio Bed panel is a **plugin panel** that reaches core through exactly one prop (`onClose`, `App.tsx:2129-2131`) plus `host.audio`. **There is no selection channel of any kind.**

**Decision (DC14):** a render-free selection **singleton** in core, exposed through a new `host.show` slice. The selection stays ephemeral (it never enters `Timeline`, never persists), and the mixer stays in the plugin — moving it to core would drag `audioClient` and the native-engine surface into core, which the audio doctrine forbids.

**Files:**
- Create: `src/renderer/services/selection.ts`
- Modify: `packages/sdk/src/renderer.ts` (`ShowService`)
- Modify: `src/renderer/App.tsx` (`host.show`)
- Modify: `src/renderer/host/plugins.ts` (`NOOP_HOST.show`)
- Modify: `src/renderer/components/timeline/Timeline.tsx` (publish on every selection change)

**Interfaces:**
- **Produces (Task 8's mixer learns these names ONLY from here):**
  ```ts
  // src/renderer/services/selection.ts
  export type TimelineSelection =
    | { kind: 'clip'; id: string }                                  // a VideoClip on the bound timeline
    | { kind: 'audioClip'; id: string; source: 'bed' | 'timeline' } // an AudioClip — WHICH container matters
    | null;
  export function setSelection(s: TimelineSelection): void;
  export function getSelection(): TimelineSelection;
  export function subscribe(cb: (s: TimelineSelection) => void): () => void;

  // packages/sdk/src/renderer.ts — ShowService gains:
  getSelection(): { kind: 'clip' | 'audioClip'; id: string; source?: 'bed' | 'timeline' } | null;
  subscribeSelection(cb: () => void): () => void;
  ```

- [ ] **Step 1: `services/selection.ts`**

```ts
// The timeline's current selection — a render-free singleton, modelled on automationOverlay/livePreview.
//
// WHY A SINGLETON AND NOT REACT STATE. Selection is EPHEMERAL: docs/TIMELINE.md is explicit that it must
// never enter the `Timeline` data type (it is not the document, it is the cursor). But the audio MIXER —
// a plugin panel — needs a clip inspector that FOLLOWS it, and a plugin reaches core only through host
// services. Lifting `selected` into App state would re-render the whole App tree on every click of a clip.
// So: an imperative store that Timeline.tsx writes and the mixer subscribes to, with zero React coupling
// in between and zero persistence.
//
// `source` on an audioClip is LOAD-BEARING: the same clip id could exist in either container (the bed, or
// the bound timeline's own audio), and the two commit through DIFFERENT paths at DIFFERENT costs
// (host.audio.setMix vs. onChange(timeline)). An inspector that guessed would write to the wrong document.
export type TimelineSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'audioClip'; id: string; source: 'bed' | 'timeline' }
  | null;

let current: TimelineSelection = null;
const subs = new Set<(s: TimelineSelection) => void>();

const same = (a: TimelineSelection, b: TimelineSelection): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  return a.kind !== 'audioClip' || a.source === (b as { source: string }).source;
};

export function setSelection(s: TimelineSelection): void {
  if (same(current, s)) return;   // idempotent: Timeline re-renders constantly and must not spam the mixer
  current = s;
  subs.forEach(cb => cb(current));
}
export function getSelection(): TimelineSelection { return current; }
export function subscribe(cb: (s: TimelineSelection) => void): () => void {
  subs.add(cb);
  cb(current);                    // fire immediately, so a panel opened mid-show sees the live selection
  return () => { subs.delete(cb); };
}
```

- [ ] **Step 2: SDK + App + `NOOP_HOST`**

`packages/sdk/src/renderer.ts`, `ShowService` (after `getStatus`):
```ts
  // The timeline's live selection (ephemeral — never persisted, never in the document). A panel with an
  // inspector that follows what the operator clicked subscribes here. `source` says WHICH audio container
  // an audioClip belongs to: the two commit through different host calls at very different costs.
  getSelection(): { kind: 'clip' | 'audioClip'; id: string; source?: 'bed' | 'timeline' } | null;
  subscribeSelection(cb: () => void): () => void;
```
`src/renderer/App.tsx`, inside `pluginHost`'s `show` (**:1333-1362**):
```ts
      getSelection: () => selection.getSelection(),
      subscribeSelection: (cb) => selection.subscribe(() => cb()),
```
(`import * as selection from './services/selection';`)

`src/renderer/host/plugins.ts:40-46` (`NOOP_HOST.show`) — **required or the build fails** (H-7):
```ts
    getSelection: () => null, subscribeSelection: () => () => {},
```

- [ ] **Step 3: `Timeline.tsx` publishes**

`Timeline.tsx` keeps its local `selected` state (it drives `ClipBlock`'s highlight and `deleteSelected`, and lifting it would re-render App on every click). It **mirrors** it into the singleton.

**Task 5 already introduced `selectedSource`** (`'video' | 'bed' | 'timeline'`, Step 4a — `deleteSelected` needs it, so it could not wait for this task) and already routes `AudioLane`'s `onSelect(id, src)` into it. This task adds **only the publish**:
```ts
  // Mirror the selection into the render-free store the plugin mixer subscribes to. An effect, not a call
  // inside setSelected, so it fires exactly once per committed selection (StrictMode double-invokes
  // updaters; it does not double-commit effects).
  useEffect(() => {
    if (!selected) { selection.setSelection(null); return; }
    if (selectedSource === 'video') selection.setSelection({ kind: 'clip', id: selected });
    else selection.setSelection({ kind: 'audioClip', id: selected, source: selectedSource });
  }, [selected, selectedSource]);
  // Unmounting the panel (dock ↔ fullscreen) must not strand a stale selection in the mixer.
  useEffect(() => () => selection.setSelection(null), []);
```

- [ ] **Step 4: Verify**

```
npx tsc -p tsconfig.json --noEmit      # exit 0
npm run build                           # exit 0
npm run verify:plugins                  # exit 0 — NOOP_HOST must satisfy the widened ShowService
```
Behavioural (no consumer yet — Task 8 is): temporarily `console.log` in a `host.show.subscribeSelection` from the Audio Bed panel and confirm it fires once (not repeatedly) when you click a video clip, an audio clip on the bed, and an audio clip on a timeline lane — with the right `kind`/`source` each time, and `null` on deselect.

- [ ] **Step 5: Commit** — `feat(host): a render-free timeline-selection channel for plugin panels`

---

### Task 8: WS-B3b — the mixer (the Audio Bed panel, rebuilt)

**Why the arrangement/mixer split is FORCED, not stylistic (D3):** because of ambisonics, the engine has **exactly two insert points — the clip and the master** (`types.ts:670-679`). A spatial source is a point in a field, so it cannot be summed into a bus before it is placed; there is no per-track insert and there never will be. **FX and mix are therefore strip material, not lane material.**

- **The timeline lanes answer "when"** — placement, trim, blade, fades, and the automation curves. (Tasks 5, 6.)
- **The panel answers "how loud / what does it sound like"** — track faders + mute/solo, the master strip (fader, inserts, clipping light), and **a clip inspector that follows the timeline selection**: gain, spatial orbit, FX chain.

The master bus stays **project-global** (`ProjectData.audio.buses`) — there is one output chain, so it cannot be per-scene.

**Files:**
- Modify: `plugins/audio/src/AudioBedPanel.tsx` (rebuild; keep the file name, the panel id `audio-bed`, and the `menuAction: 'audio-bed'` registration at `plugin.renderer.ts:59`)

**Interfaces:**
- Consumes: Task 3's `host.show.getStatus().showTime`; Task 6's `host.audio.getTimelineAudio()`; Task 7's `host.show.getSelection()` / `subscribeSelection()`.
- Produces: nothing new.

- [ ] **Step 1: delete the `@ N s` field, and everything the lane now owns**

Remove from `AudioBedPanel.tsx`:
- **the `@ N s` numeric placement field (`:248-252`)** — the lane replaces it. ⚠ It is currently **the ONLY way to set `AudioClip.start` in the whole app** (grep: no other writer). **Do not remove it until Task 5's lane is merged and working**, or clip placement becomes unauthorable except at the drop position.
- the flat per-track clip **list** (`:243-301`) — that is the lane's job now.
- the duration readout, and the per-clip Trash (both live on the clip block).

Keep and re-shape: the header transport, the L/R meters, the master strip, `commit`/`mixRef`, `EffectChain`, `SpatialPad`.

- [ ] **Step 2: the panel becomes three zones**

```
 ┌ Audio Bed ─────────────────────────────────────────────── ⏵ ♪ 02:14 ── L▓▓ R▓▓ ── ✕ ┐
 │ TRACKS (the bed)              │  CLIP INSPECTOR — follows the timeline selection      │
 │  ▸ Ambience   [M][S] ▬▬▬ 1.00 │   ♪ rain.wav   (bed)                                  │
 │  ▸ Stingers   [M][S] ▬▬▬ 0.80 │   gain  ▬▬▬▬ 1.00                                     │
 │ TRACKS (this timeline)        │   [Orbit] spatial pad + height                        │
 │  ▸ SceneFX    [M][S] ▬▬▬ 1.00 │   [FX]    EffectChain scope="clip"                    │
 ├───────────────────────────────┴───────────────────────────────────────────────────────┤
 │ MASTER   FX (2)   ▬▬▬▬▬▬ 1.00   ⚠ clipping                                            │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```
- The **transport readout is the SHOW clock** (Task 3 already fixed `:103-104` and `:194`). Label it `♪` and title it *"the show clock — the bed's position; it does not restart when a scene is recalled."*
- **Two track sections**, `BED` and `THIS TIMELINE`, from `host.audio.getMix().tracks` and `host.audio.getTimelineAudio().tracks`. Each row: name, mute, **solo** (now honoured — Task 6), gain fader, remove. Bed rows commit via `host.audio.setMix()`. **Timeline rows are READ-ONLY here** — the panel has no write path to `Timeline.audio` (it would need `onChange(timeline)`, which is core's, not the plugin's) — so render them with their faders **disabled** and a title explaining *"edit this track on its timeline lane"*. **Do not invent a host write path for it in this task**; the lane's gutter already carries name/mute/solo/gain (Task 5 Step 3), which is where a timeline track's mix belongs.

- [ ] **Step 3: the clip inspector that follows the selection**

```tsx
  // THE INSPECTOR FOLLOWS THE TIMELINE SELECTION. This is the whole point of the arrangement/mixer split:
  // you place the clip on the lane, you shape it here. The selection arrives through host.show — a
  // render-free channel core publishes and this panel subscribes to (services/selection.ts). It carries
  // `source`, and that is load-bearing: a bed clip and a timeline clip commit through COMPLETELY different
  // paths (host.audio.setMix vs. core's onChange(timeline)), and writing to the wrong one would silently
  // edit a document the operator is not looking at.
  const [sel, setSel] = useState(() => host?.show.getSelection() ?? null);
  useEffect(() => host?.show.subscribeSelection(() => setSel(host.show.getSelection())), [host]);

  const selClip: Clip | null = useMemo(() => {
    if (!sel || sel.kind !== 'audioClip') return null;
    if (sel.source === 'bed') return mix.clips.find(c => c.id === sel.id) ?? null;
    return (tlAudio.clips as Clip[]).find(c => c.id === sel.id) ?? null;
  }, [sel, mix, tlAudio]);
```
Render, when `selClip`:
- header: `♪ {name}` + a `BED` / `THIS TIMELINE` chip.
- **gain** slider `0..1.5`.
- **spatial**: the existing `SpatialPad` (`:25-53`) + the height slider — verbatim, it is good.
- **FX**: the existing `<EffectChain scope="clip" …>`.
- when `sel.source === 'timeline'`: **read-only**, with the same *"edit it on its lane"* note. (Everything a timeline clip needs — placement, trim, fades, mute, gain — is on the lane; spatial/FX for per-timeline audio is a follow-on, and shipping a half-write path that silently edits the wrong doc is worse than not shipping it.)
- when nothing is selected: *"Select an audio clip on the timeline to shape it."*

⚠ Every write still goes through `commit()` (**:110**) → `mixRef` + React state + `host.audio.setMix(next)`. `mixRef` (**:77**) is the **synchronously-fresh** mirror and exists because `host.audio.getMix()` reads App's `audioMixRef`, which only refreshes on render — **two edits in the same turn would otherwise both read the pre-edit bed and the second would clobber the first.** Do not "simplify" it away.

⚠⚠ **STRUCTURE THE AUTHORED WRITES AS NAMED, PATH-AWARE FUNCTIONS — Task 9 needs exactly one place to add the takeover.** Once the scene/cue fade layer exists (Task 9), the driver reads `laneOverride ?? sceneFade ?? authored`, and a fade's value **persists by design** — so once any recall has touched a path, the authored value under it is **shadowed forever** and the control that writes it is **DEAD** unless it clears the fade. The master fader is the headline case (`audio.master.gain` is precisely what D5 exists to recall); a clip gain, a track gain, a spatial axis and an FX param are all reachable the same way. **There is no fade layer yet in Task 8, so nothing can strand here** — but write the controls so Task 9 Step 5 is a one-line insert per path, not a hunt:
```ts
  // Every authored write names its PATH. (Task 9 adds `releaseFade(path)` to each of these — a manual move
  // is a TAKEOVER from whatever scene/cue last faded that param.)
  const setMasterGain = (g: number) => patchMaster({ gain: g });                    // audio.master.gain
  const setTrackGain  = (id: string, g: number) => patchTrack(id, { gain: g });     // audio.track.<id>.gain
  const setClipGain   = (id: string, g: number) => patchClip(id, { gain: g });      // audio.clip.<id>.gain
  // …and the same shape for a spatial axis (audio.clip.<id>.spatial.<x|y|z>) and an FX param
  // (audio.clip.<id>.fx.<fxId>.<key> / audio.master.fx.<fxId>.<key>) — every path AUDIO_FADEABLE_RE can
  // reach has a control here, and every one of them will need its release.
```
(A **lane** override is deliberately *not* released this way — a lane is a visible, disable-able owner; a fade is not. That asymmetry is the point.)

- [ ] **Step 4: the transport strip**

Keep `SkipBack` / Play-Pause / the scrub slider, all through `host.show.transport({...})` — **App remains the single writer of `playing`** (invariant 1). Add the **Stop** button the panel never had:
```tsx
            <button onClick={() => host.show.transport({ kind: 'stop' })} title="Stop — returns the show clock to the global in-point"
              className="p-1 rounded-sm bg-surface-3 text-fg-2 hover:text-fg-1"><Square size={12} /></button>
```
The scrub slider seeks the transport. **While a scene's own timeline is bound, a seek does NOT move the show clock** (the engine's identity rule — Task 2, rows 2/3), so scrubbing here would move the picture and not the bed. **Task 3 already disabled the slider and `SkipBack` while `getStatus().activeSceneId != null`** — *keep* that, and keep its title (*"Scrub Global to move the bed — a seek inside a scene does not move the show clock."*). Its range is `getStatus().showEnd`, not `duration`. Do not re-introduce the enabled version.

- [ ] **Step 5: Verify**

```
npx tsc -p tsconfig.json --noEmit                                    # exit 0
npm run build                                                        # exit 0
npm run verify:plugins                                               # exit 0
git grep -n "text-\[[0-9]" -- plugins/audio/                         # must print NOTHING (the old file had text-[9px] — clear it)
git grep -n "getStatus().playhead" -- plugins/audio/                 # must print NOTHING
```
**LIVE:**
1. Open the mixer. Click an audio clip on a **bed** lane → the inspector shows **that clip**: gain, orbit, FX. Move its gain → **you hear it**, and the lane's clip does **not** move.
2. Click a clip on a **timeline** audio lane → the inspector shows it, marked `THIS TIMELINE`, read-only, with the pointer back to the lane.
3. Click a **video** clip → the inspector says nothing is selected (it is an audio inspector).
4. Deselect → empty state.
5. **Solo** a bed track from the mixer → the other bed tracks go silent; the scene's audio is unaffected.
6. Drag a source around the **orbit pad** → the L/R meters visibly shift and the image moves.
7. The `♪` readout **keeps counting through a scene recall**. Bind a scene → the scrub slider **disables**, with its explanation.
8. `@ N s` is gone; nothing in the app is unauthorable because of it.
9. Every authored control is a **named, path-labelled function** (`setMasterGain`, `setTrackGain`, `setClipGain`, the spatial axes, the FX params) — Task 9 Step 5 adds `releaseFade(path)` to each. *(There is no fade layer yet, so nothing can strand in this task; the live "the master fader still works after a recall" test is Task 9's.)*

- [ ] **Step 6: Commit** — `feat(audio): the Audio Bed panel becomes the mixer — faders, solo, master, and a clip inspector that follows the selection`

---

### Task 9: WS-B4a — the fade seam: `paramPath` grammar, `writeFade`, and the lane-wins rule

**THE TRAP. Read this section twice.** The spec (`:180`) claims *"Audio uses the same rule [`automationOverlay.owns(path)`] — no second mechanism."* **That is FALSE, and it is the crux of WS-B4.**

Four facts, each verified in the code:
1. `automationOverlay.owns()` (`automationOverlay.ts:38` — `values.has(path)`, backed by `values: Map<string, number>` at `:13`) is a **CORE-ONLY** map. Its own header (`:9-10`) states the boundary: *"Plugin namespaces (audio) own their own override layer behind the AutomationTargetProvider contract — **core never reaches into them**."*
2. The audio plugin keeps a **separate** override map: `plugins/audio/src/automationTargets.ts:42` — `const ovr = new Map<string, number>()`.
3. The SDK's `AutomationTargetProvider` (`packages/sdk/src/renderer.ts:77-98`) has **no `owns(path)`** — only `namespaces / enumerate / get / write / release / frameEnd?`.
4. `timeline.ts:361 ownedPaths` — the only set that knows which audio paths a lane owns — is **module-private, never exported**.

⇒ **There is today NO mechanism by which `transitions.ts:97` can learn that an audio lane owns `audio.master.gain`.** And it gets worse: `setByPath(v, 'audio.…', val)` falls through to `return view` (`paramPath.ts:80`) — **a totally silent no-op.** An `audio.*` leg fed to `transitions.start()` today does *nothing at all*, and nothing throws.

**HOW THIS PLAN OPENS THE SEAM (DC11) — a read-order precedence, not an `owns()` query across the boundary:**

```
  THE AUDIO DRIVER'S READ ORDER — and therefore the priority, structurally:

      lane override (ovr)        ← an automation lane. WINS.
        ?? scene/cue fade (sceneOvr)   ← a scene recall or a cue. NEW.
        ?? the authored value          ← what the slider last wrote. Never touched by either.

  · A LANE ALWAYS WINS OVER A SCENE FADE — not because anyone asked owns(), but because the fade's value
    is SHADOWED by the lane's in the very read that reaches the engine. No query, no race, no ordering.
  · A lane's release() (automationTargets.ts:180-186) deletes from `ovr` ONLY — so disabling a lane cannot
    nuke a live scene fade; the fade is simply visible again, one layer down. (Had the fade written into
    `ovr`, a lane's release would have deleted it, and two writers on one map would have fought with
    LAST-WRITER-WINS PER FRAME.)
  · Nothing is ever "restored": the authored AudioMix is never written. Exactly the doctrine
    automationOverlay.ts:1-8 already states for core, one layer deeper.
```

**AND THE AUDIO-AUTOMATION TRAP STILL HOLDS.** `write()` must **NOT** call `audioClient` — the driver re-reads each clip from the bed through `eff`/`effGain` **every frame** (`plugin.renderer.ts:97-100`), so a value pushed straight to the engine is overwritten with the **authored** one on the same frame, forever: **an audible 60 Hz flutter, not a silent bug.** `writeFade` obeys the identical rule — it only sets a map and marks the owner dirty. **Any audio scene-fade must be PULL-THROUGH, not push-per-frame.**

**Files:**
- Modify: `packages/sdk/src/renderer.ts` (`AutomationTargetProvider.writeFade?` / `releaseFade?` / `releaseAllFades?` / `getLive?`)
- Modify: `src/renderer/services/paramPath.ts` (`pathLeaf`, the `audio` arm of `isFadeablePath`)
- Modify: `src/renderer/services/transitions.ts` (route a leg's write by head; `FadeLeg.log` — DC15)
- Modify: `plugins/audio/src/automationTargets.ts` (the `fade` map + `writeFade`/`releaseFade`/`releaseAllFades`/`getLive` + the read-order helpers)
- Modify: `plugins/audio/src/plugin.renderer.ts` (`eff`/`effGain`/`syncMaster` read through the new layer)
- Modify: `plugins/audio/src/AudioBedPanel.tsx` (**the takeover**: `releaseFade(path)` on every authored write — Step 5)
- Modify: `src/renderer/App.tsx` (`applyProjectData` → `releaseAllFades()` through the registry)

**Interfaces:**
- **Produces (Task 10 learns these names ONLY from here):**
  ```ts
  // packages/sdk/src/renderer.ts — AutomationTargetProvider gains FOUR optional members. All four, or the
  // fade layer is a one-way trap (DC11b): a write-only map strands the param forever.
  writeFade?(path: string, value: number): void;    // a scene/cue fade writes HERE, under the lane layer
  releaseFade?(path: string): void;                 // a MANUAL write to the authored value is a TAKEOVER
  releaseAllFades?(): void;                         // project open — App calls it through the registry
  getLive?(path: string): number | undefined;       // laneOvr ?? fade ?? authored — a fade's true `from`

  // src/renderer/services/paramPath.ts
  export function pathLeaf(path: string): string;   // head-aware: strips <head>.<id>. for core, <head>.<kind>.<id>. for audio
  export const AUDIO_FADEABLE_RE: RegExp;           // exported for the label/picker code to agree with the fade engine

  // src/renderer/services/transitions.ts
  export interface FadeLeg extends FadeTarget { transition?: CueTransition; fadeSec?: number; log?: boolean }

  // plugins/audio/src/automationTargets.ts
  export function autoOrFadeGain(clipId: string): number | undefined;
  export function autoOrFadeTrackGain(trackId: string): number | undefined;
  export function autoOrFadeMasterGain(): number | undefined;
  export function hasAnyOverride(ownerId: string): boolean;             // lane OR fade
  export function applyClipLayers<T extends OvClip>(clip: T): T;        // lane over fade over authored
  export function applyBusLayers<T extends OvBus>(bus: T): T;
  export function releaseFade(path: string): void;                      // Task 8's mixer calls it on a manual move
  ```

- [ ] **Step 1: SDK — the optional fade sink**

`packages/sdk/src/renderer.ts`, in `AutomationTargetProvider` (after `release`, `:95`):
```ts
  /**
   * Optional: A SCENE OR CUE FADE writes here — a layer SEPARATE from the automation override above.
   *
   * Two writers, two maps, and the separation is load-bearing:
   *   · A LANE MUST ALWAYS WIN over a scene fade. Providers implement that by READ ORDER — the value the
   *     provider hands the engine is `laneOverride ?? fadeOverride ?? authored`. No owns() query is needed
   *     and none exists: core cannot see inside a plugin's override layer, by design.
   *   · A lane's release() must never delete a live fade. Sharing one map would make it do exactly that,
   *     and would put two writers in a last-writer-wins race every frame.
   *
   * SAME CONTRACT AS write(): called from inside a rAF frame loop. MUST NOT touch React state, MUST NOT
   * write the persisted document, and MUST NOT push to a device/engine directly — the consumer PULLS the
   * value through on its own next read. (A direct push would be overwritten by the authored value on the
   * same frame by whatever re-reads the document each frame — an audible flutter, not a silent bug.)
   *
   * A fade's value PERSISTS after the fade completes: it IS the recalled scene's state for that param,
   * held outside the saved document exactly as the automation override is. A later recall overwrites it.
   * WHICH IS EXACTLY WHY releaseFade() BELOW IS NOT OPTIONAL IN PRACTICE — see it.
   */
  writeFade?(path: string, value: number): void;

  /**
   * Optional: HAND THE PATH BACK. A MANUAL write to the authored value (an operator moving a fader) is a
   * TAKEOVER — the fade layer for that path must be dropped, or the value the user just set is SHADOWED BY
   * A DEAD FADE FOREVER.
   *
   * This is not hypothetical, it is the default outcome of the layer above. A fade's value persists, and
   * the driver reads `laneOvr ?? fade ?? authored` — so the instant ANY scene or cue touches
   * `audio.master.gain` (which is D5's entire purpose), the mixer's master fader stops doing anything at
   * all, for the rest of the session and across every project opened in it. An automation lane does not
   * have this bug precisely because it HAS a release, and this codebase already names the failure:
   * timeline.ts:401-408 — a dropped target "must be handed back to manual control, or the target would be
   * STRANDED at the outgoing curve's last value forever".
   */
  releaseFade?(path: string): void;

  /**
   * Optional: drop EVERY fade. App calls this through the automation-target registry when a project is
   * OPENED or RESET — a fade layer is show state, not document state, and a stale master fade from the
   * previous project must not clamp the new one's output.
   */
  releaseAllFades?(): void;

  /**
   * Optional: the EFFECTIVE value of a path — `laneOverride ?? fadeOverride ?? authored`.
   *
   * `get()` returns the AUTHORED value on purpose (it seeds a new lane's first keyframe, so creating a
   * lane never changes the sound). A FADE'S `from` MUST NOT USE IT: scene A fades the master 1.0 → 0.2;
   * scene B later fades it → 0.5; built from `get()`, B's leg starts at the AUTHORED 1.0 and frame 1 of
   * the fade slams the master to FULL LEVEL before gliding down. A full-scale pop on the second and every
   * subsequent audio recall of the show. Fades read getLive(); lane seeding still reads get().
   */
  getLive?(path: string): number | undefined;
```
No `NOOP_HOST` change (that is a *host-services* stub, not a provider), and core's `coreAutomationProvider` (`automationTargets.core.ts:38-66`) does **not** implement it — core paths still fade through `setByPath`/`StateView`, unchanged. **`npm run verify:plugins` must still pass — run it.**

⚠ **H-6 — DO NOT** add `'audio'` to `coreAutomationProvider.namespaces` (`automationTargets.core.ts:40`). `host/registries.ts:55` fans a provider out over its namespaces **last-write-wins per namespace**, so that would silently **steal the audio namespace from the plugin**. It is a tempting way to "make StateView work". It is a catastrophic one.

- [ ] **Step 2: `paramPath.ts` — the grammar (DC12)**

**The `slice(2)` assumption is the whole design** (`isGeometryPath` `:30`, `isFadeablePath` `:38`, `getByPath` `:52`, and `CueBankPanel.labelForPath` `:345`): the grammar is hardwired to `<head>.<id>.<leaf…>`. **An audio path is one segment deeper** — `audio.<kind>.<id>.<leaf…>` — so `slice(2)` lands mid-path (which is why `audio.clip.c7.gain` renders as `fix · c7.gain` and `audio.master.gain` as `fix · gain`, the word *master* vanishing entirely).

Fix it in **one** place:
```ts
// THE PATH GRAMMAR, IN ONE FUNCTION.
//
// Core paths are `<head>.<id>.<leaf…>`  (surfaces.s1.content.opacity)   → the leaf starts at index 2.
// Audio paths are ONE SEGMENT DEEPER:
//     audio.clip.<id>.<leaf…>     audio.track.<id>.<leaf…>              → the leaf starts at index 3
//     audio.master.<leaf…>                                              → the leaf starts at index 2
// (the master is a singleton — it has no id — which is why it is not uniformly index 3).
//
// Every leaf extractor in the app used a bare `.slice(2)`, so every one of them was wrong for audio. This
// is the single head-aware replacement; use it, never slice(2), for anything that must work across heads.
export function pathLeaf(path: string): string {
  const p = path.split('.');
  if (p[0] !== 'audio') return p.slice(2).join('.');
  if (p[1] === 'master') return p.slice(2).join('.');   // audio.master.gain → 'gain'
  return p.slice(3).join('.');                           // audio.clip.c7.fx.e2.cutoff → 'fx.e2.cutoff'
}
```
`isGeometryPath` (`:29-32`) uses it (`const leaf = pathLeaf(path);`) — behaviour for core paths is byte-identical, and an audio path can now never accidentally match a geometry leaf.

`isFadeablePath` (`:35-42`) gains the audio arm:
```ts
// Continuous audio leaves ONLY. Never a discrete `opts` mode (filter.mode = 'lowpass'), which the fade
// engine would hand `0.37` — AudioEffect.opts is typed as strings ON PURPOSE to make that unrepresentable
// (types.ts:632-635). Never a chain's length, never spatial on/off: each changes the SHAPE of the engine's
// chain and forces a rebuild (a spatial flip changes its channel count 2⇔1), and a rebuild allocates.
//   audio.clip.<id>.gain          audio.track.<id>.gain          audio.master.gain
//   audio.clip.<id>.spatial.{x|y|z}
//   audio.clip.<id>.fx.<effectId>.<param>                        audio.master.fx.<effectId>.<param>
export const AUDIO_FADEABLE_RE = /^(gain|spatial\.[xyz]|fx\.[^.]+\.[^.]+)$/;

export function isFadeablePath(path: string): boolean {
  if (path === 'globalBrightness') return true;
  const head = path.split('.')[0];
  const leaf = pathLeaf(path);
  if (head === 'surfaces') return SURFACE_FADEABLE.includes(leaf);
  if (head === 'fixtures') return FIXTURE_FADEABLE.includes(leaf) || /^segments\.\d+\.(speed|intensity)$/.test(leaf);
  if (head === 'audio') return AUDIO_FADEABLE_RE.test(leaf);
  return false;
}
```
⚠ **`getByPath` and `setByPath` are NOT extended for audio, and never will be.** They operate on `StateView` — a closed 3-field interface (`surfaces`, `fixtures`, `globalBrightness`) — and **audio is not in it and is not being put in it** (DC11/H-5: widening `StateView` breaks 9 construction sites, 7 of which are bare literals that would silently feed `undefined`, and two of which are **inside Stage's rAF `tick()`**, where the slice must not allocate). Audio is read and written through the **registry**. Add this as a comment above `getByPath` so nobody "completes" the switch:
```ts
// NOTE: there is deliberately no `audio` arm here or in setByPath. Audio does not live on the StateView —
// it lives behind the AutomationTargetProvider contract, and is read via provider.get() / written via
// provider.writeFade(). See transitions.ts's head router and DC11 in the Wave B plan.
```

- [ ] **Step 3: `transitions.ts` — route a leg's write by head**

`transitions.ts:89-104` (`apply`). The core path stays byte-identical; a non-core head goes to its provider:
Also widen the leg types so a log-curve param can be carried (DC15):
```ts
export interface FadeLeg extends FadeTarget { transition?: CueTransition; fadeSec?: number; log?: boolean }
interface ActiveLeg { path: string; from: number; to: number; durMs: number; ease: (t: number) => number; geom: boolean; log: boolean }
// …and in start()'s map (`:43-52`): `log: t.log ?? false,`
```
Core legs never set it, so their behaviour is byte-identical.

```ts
import { automationTargetRegistry } from '../host/registries';

const CORE_HEADS = new Set(['globalBrightness', 'surfaces', 'fixtures']);

  const apply = (base: StateView): StateView => {
    let v = base;
    for (const leg of a.legs) {
      const raw = leg.durMs <= 0 ? 1 : (nowMs - a.startMs) / leg.durMs;
      const head = leg.path.split('.')[0];
      if (!CORE_HEADS.has(head)) {
        // A PLUGIN-NAMESPACED LEG (today: audio.*). It does NOT live on the StateView and setByPath would
        // silently no-op on it (paramPath.ts's `return view`). It goes to the namespace's owner, into a
        // LIVE FADE LAYER the provider keeps SEPARATE from its automation-override layer.
        //
        // NO owns() QUERY, AND NONE IS POSSIBLE: automationOverlay.owns() is a CORE-ONLY map, and core
        // never reaches inside a plugin's override layer (automationOverlay.ts:9-10 states the boundary).
        // "A lane always wins over a scene fade" is enforced STRUCTURALLY instead, by the provider's READ
        // ORDER — laneOverride ?? fadeOverride ?? authored — so the fade simply lands UNDERNEATH a live
        // lane and becomes visible the instant that lane is disabled. That is the same "nothing is ever
        // restored, because nothing was ever overwritten" doctrine core already follows, one layer deeper.
        //
        // No re-targeting either (the getByPath(base, …) glide below): base carries no audio, so there is
        // nothing to read. The fade runs its authored from→to and lands under whatever owns the path.
        //
        // LOG-CURVE PARAMS INTERPOLATE IN LOG SPACE (DC15). A filter cutoff is 20 Hz–20 kHz with
        // `curve: 'log'` (effectDefs.ts:66); so are a delay's timeMs and a compressor's attack/release.
        // The AUTOMATION engine honours that (LaneRT.log → sampleLane), and the SDK contract states it —
        // so a linear fade of the same move would be past 4 kHz in the first 700 ms of a 3 s sweep and
        // would sound nothing like the identical curve drawn on a lane, which is the comparison the
        // operator makes in the room. Guarded: a hand-authored 0 endpoint falls back to linear rather than
        // producing Math.log(0) = -Infinity → NaN → setClipEffects(NaN).
        const t = leg.ease(clamp01(raw));
        const val = raw >= 1 ? leg.to
          : (leg.log && leg.from > 0 && leg.to > 0)
            ? Math.exp(Math.log(leg.from) + (Math.log(leg.to) - Math.log(leg.from)) * t)
            : leg.from + (leg.to - leg.from) * t;
        automationTargetRegistry.get(head)?.writeFade?.(leg.path, val);
        continue;
      }
      // Whether a lane owns this path is asked EVERY FRAME, not captured at start(). …(unchanged)…
      const to = automationOverlay.owns(leg.path)
        ? ((getByPath(base, leg.path) as number | undefined) ?? leg.to)
        : leg.to;
      const val = raw >= 1 ? to : leg.from + (to - leg.from) * leg.ease(clamp01(raw));
      v = setByPath(v, leg.path, val);
    }
    return v;
  };
```
⚠ **Timing note, and it is fine:** `apply()` runs inside **Stage's** rAF tick (`Stage.tsx:312`), while the audio driver's `tick` runs from the **engine's** rAF (`timeline.subscribe`). The two are different callbacks, so a fade's value can reach the engine one frame later than an automation lane's. **For a fade (hundreds of ms) that is inaudible; for automation it would not be, which is exactly why the sampler is deliberately NOT a subscriber (H-4).** Do not "fix" this by moving the sampler.

⚠ `transitions.start()` (`:53-58`): **a fade with no leg whose `durMs > 0` never enters the engine** — it fires `onComplete` and clears. So a **zero-fade** scene recall must commit its audio values by another route. Task 10 handles that (it writes the fade layer directly for a `fadeSec === 0` recall).

- [ ] **Step 4: the audio plugin — `sceneOvr`, `writeFade`, and the read order**

`plugins/audio/src/automationTargets.ts`. Add beside `ovr`/`byOwner`/`dirty` (**:42-44**):
```ts
// ── THE SCENE / CUE FADE LAYER ───────────────────────────────────────────────────────────────────
// A SECOND override layer, kept strictly separate from `ovr` above. Written by transitions.ts (a scene
// recall or a cue), read UNDER it.
//
// WHY A SECOND MAP AND NOT `ovr`:
//   · A LANE MUST WIN. With one map, a lane and a fade on the same path would be two writers racing
//     last-writer-wins, every frame. With two, the driver's read order settles it once and for all.
//   · `release(path)` (below) unconditionally deletes the path — so a lane being disabled would have
//     DELETED A LIVE SCENE FADE. Two maps make that structurally impossible.
//
// A fade's value PERSISTS after the fade completes. It is not "the fade animating"; it IS the recalled
// scene's audio state, held outside the persisted AudioMix exactly as `ovr` is — so nothing is ever baked
// into the saved file and nothing has to be "restored". A later recall/cue overwrites it.
const fade = new Map<string, number>();               // targetPath → the scene/cue value
const fadeByOwner = new Map<string, Set<string>>();   // ownerId → its faded paths
```
The read helpers (replacing/extending **:70-73**):
```ts
// THE READ ORDER, IN ONE PLACE: lane override ?? scene/cue fade ?? (the caller's authored value).
// Every driver read of an automatable leaf goes through these — that is what makes "a lane always wins"
// true, structurally, with no query and no coordination.
const layered = (path: string): number | undefined => ovr.get(path) ?? fade.get(path);

export const autoOrFadeGain = (clipId: string): number | undefined => layered(`${NS}.clip.${clipId}.gain`);
export const autoOrFadeTrackGain = (trackId: string): number | undefined => layered(`${NS}.track.${trackId}.gain`);
export const autoOrFadeMasterGain = (): number | undefined => layered(`${NS}.master.gain`);
export const hasAnyOverride = (ownerId: string): boolean =>
  (byOwner.get(ownerId)?.size ?? 0) > 0 || (fadeByOwner.get(ownerId)?.size ?? 0) > 0;
```
`applyClipOverrides` (**:76-93**) and `applyBusOverrides` (**:96-109**) become **layered**: iterate the fade paths **first**, then the lane paths **over** them, so the lane's value lands last and wins.
```ts
/** A clip with its scene/cue fade laid on, then its automated leaves laid OVER that. Lane wins. */
export function applyClipLayers<T extends OvClip>(clip: T): T {
  let out = clip;
  out = applyPaths(out, fadeByOwner.get(clip.id), fade);   // fade first…
  out = applyPaths(out, byOwner.get(clip.id), ovr);        // …lane over it. ORDER IS THE PRIORITY.
  return out;
}
export function applyBusLayers<T extends OvBus>(bus: T): T {
  let out = bus;
  out = applyBusPaths(out, fadeByOwner.get(MASTER_BUS_ID), fade);
  out = applyBusPaths(out, byOwner.get(MASTER_BUS_ID), ovr);
  return out;
}
```
(`applyPaths` / `applyBusPaths` are the **existing bodies** of `applyClipOverrides` / `applyBusOverrides` (`:81-91`, `:100-107`), lifted to take `(paths: Set<string> | undefined, values: Map<string, number>)`. Keep `gain` out of them — it is applied by the driver's `effGain`, as the comment at `:90` says.)

And the provider gains `writeFade`, beside `write` (**:172-178**):
```ts
  // A SCENE/CUE FADE. Same contract as write(): it NEVER calls audioClient. The driver re-reads each clip
  // from the bed every frame through eff()/effGain(), so a value pushed straight to the engine would be
  // overwritten with the AUTHORED value on the same frame, forever — an audible 60 Hz flutter. PULL-THROUGH,
  // never push-per-frame. See the header of this file.
  writeFade(path: string, value: number): void {
    const owner = ownerOf(path);
    if (!owner) return;
    fade.set(path, value);
    let s = fadeByOwner.get(owner);
    if (!s) { s = new Set(); fadeByOwner.set(owner, s); }
    s.add(path);
    dirty.add(owner);   // the driver's takeDirty() re-pushes this owner on the next frame
  },

  // THE TAKEOVER. Without this the `fade` map is WRITE-ONLY and the layer is a one-way trap: the mixer's
  // master fader dies the moment any scene or cue touches audio.master.gain, because effGain/syncMaster
  // read `laneOvr ?? fade ?? authored` and the authored value they'd read is the one the fader just wrote.
  // A manual write to the authored value means the operator has taken the param back. Drop the fade.
  releaseFade(path: string): void {
    const owner = ownerOf(path);
    if (!owner) return;
    fade.delete(path);
    fadeByOwner.get(owner)?.delete(path);
    dirty.add(owner);   // re-push, so the AUTHORED value reaches the engine on the next frame
  },

  // A fade layer is SHOW state, not DOCUMENT state. App calls this on project open/reset (through the
  // registry), or a stale master fade from the last project would clamp the next one's output — silently,
  // with the fader sitting at 1.0 and reading as healthy.
  releaseAllFades(): void {
    for (const owner of fadeByOwner.keys()) dirty.add(owner);
    fade.clear();
    fadeByOwner.clear();
  },

  // The EFFECTIVE value — what is actually reaching the engine right now. A fade's `from` must be this,
  // not get()'s AUTHORED value (DC11b): otherwise the second recall of a path jumps to the authored value
  // on frame 1 and glides down from there — a full-scale pop.
  getLive(path: string): number | undefined {
    return layered(path) ?? this.get(path);
  },
```
⚠ `release(path)` (**:180-186**) **must keep deleting from `ovr` only** — never from `fade`. Add: `// NOTE: `fade` is untouched. A lane being disabled hands the path back to the SCENE FADE (one layer down), not to the authored value — which is exactly right: the recalled scene's value is still in effect. The fade is dropped by releaseFade() (a manual takeover) or releaseAllFades() (a project open) — never by a lane.`

And App calls the reset — in `applyProjectData` (**App.tsx:915-916**), next to `setGlobalDoc`:
```ts
      // A fade layer is SHOW state, not document state — drop it, or the outgoing project's scene fades
      // keep shadowing the incoming project's authored mix. (Core has nothing to clear: its fades live on
      // the StateView, which applyProjectData replaces wholesale.)
      for (const p of automationTargetRegistry.all()) p.releaseAllFades?.();
```

- [ ] **Step 5: the driver reads through both layers**

`plugins/audio/src/plugin.renderer.ts` — swap the imports and the three read sites:
- import `autoOrFadeGain, autoOrFadeTrackGain, autoOrFadeMasterGain, hasAnyOverride, applyClipLayers, applyBusLayers` instead of `autoGain, autoTrackGain, autoMasterGain, hasOverride, applyClipOverrides, applyBusOverrides`.
- `effGain` (Task 6's version): `(autoOrFadeGain(clip.id) ?? clip.gain ?? 1) * (autoOrFadeTrackGain(clip.trackId) ?? trackOfClip(clip)?.gain ?? 1) * fadeGain(clip, tLocal)`.
- `eff` (**:100**): `(clip) => (hasAnyOverride(clip.id) ? applyClipLayers(clip) : clip)`.
- `syncMaster` (**:185-193**): `applyBusLayers(authored)` and `autoOrFadeMasterGain() ?? master?.gain ?? 1`.

⚠ **Naming collision:** Task 6 introduced a local `fadeGain(clip, tLocal)` (the clip's fadeIn/fadeOut *envelope*). This task's `fade` map is in a **different module**. They are different concepts — the envelope is a property of the *clip*, the fade layer is a *recall* — and the names must not be conflated. Keep `fadeGain` local to the driver and never export it.

**AND THE TAKEOVER — `plugins/audio/src/AudioBedPanel.tsx` (the mixer, Task 8).** The fade layer exists as of *this* step, so from *this* step the mixer's controls can be shadowed by it. Task 8 left every authored write as a named, path-labelled function precisely so this is a one-line insert each:
```ts
  import { releaseFade } from './automationTargets';

  // A MANUAL MOVE TAKES THE PARAM BACK from whatever scene/cue last faded it. WITHOUT THIS the fader moves
  // on screen, `master.gain` changes in the document, and NOTHING HAPPENS TO THE SOUND — `fade` is still
  // winning the read (laneOvr ?? fade ?? authored), and it keeps winning for the rest of the session and
  // across every project opened in it. The house-volume fader would be dead the moment ANY scene or cue
  // touched audio.master.gain — which is the entire purpose of D5.
  const setMasterGain = (g: number) => { releaseFade('audio.master.gain'); patchMaster({ gain: g }); };
  const setTrackGain  = (id: string, g: number) => { releaseFade(`audio.track.${id}.gain`); patchTrack(id, { gain: g }); };
  const setClipGain   = (id: string, g: number) => { releaseFade(`audio.clip.${id}.gain`); patchClip(id, { gain: g }); };
  // …and the same for each spatial axis and each FX param the panel writes.
```

- [ ] **Step 6: Verify**

```
npx tsc -p tsconfig.json --noEmit                                      # exit 0
npm run build                                                          # exit 0
npm run verify:plugins                                                 # exit 0 — the SDK contract changed; run it against BUILT output
git grep -n "applyClipOverrides\|applyBusOverrides\|hasOverride\b" -- plugins/audio/   # must print NOTHING (all migrated)
git grep -n "slice(2)" -- src/renderer/services/paramPath.ts src/renderer/components/CueBankPanel.tsx
#   → the ONLY hits allowed are the two inside pathLeaf() itself. pathLeaf OWNS the grammar; every other
#     leaf extractor (isGeometryPath, isFadeablePath, labelForPath) must call it, never slice.
git grep -n "'audio'" -- src/renderer/services/automationTargets.core.ts # must print NOTHING (H-6)
```
There is no UI for audio cues yet (Task 10) — so **prove the seam from the console** in a running dev app:
```js
// 1. The fade lands and is audible, pull-through:
transitions.start([{ path: 'audio.master.gain', from: 1, to: 0.2 }], { fadeSec: 3, transition: 'smooth' })
//    → the master fades down over 3 s. No flutter, no zipper, no 60 Hz chatter.
// 2. THE LANE WINS. Draw an automation lane on audio.master.gain, enable it, then run the fade again:
//    → the lane's curve keeps driving the master. The fade is INAUDIBLE (it is shadowed).
// 3. Now DISABLE the lane:
//    → the master snaps to the FADE's value (0.2) — not to the authored 1.0. The fade was there all along,
//      one layer down. Re-enable the lane → the curve takes over again.
// 4. THE TAKEOVER (DC11b). With the fade from (1) still in effect (master at 0.2, no lane), open the mixer
//    and MOVE THE MASTER FADER.
//    → the master MOVES. If it does not, `fade` is shadowing the authored value with no way out and the
//      house-volume fader is dead for the rest of the session: releaseFade() is missing from the write path.
// 5. NO POP ON THE SECOND RECALL (DC11b). From that state (master faded to 0.2), run:
transitions.start([{ path: 'audio.master.gain', from: audioProvider.getLive('audio.master.gain'), to: 0.5 }],
                  { fadeSec: 4, transition: 'smooth' })
//    → it glides 0.2 → 0.5. If you hear it SLAM TO FULL LEVEL and then come down, the leg's `from` is
//      coming from get() (the AUTHORED 1.0) instead of getLive().
// 6. A LOG PARAM FADES LIKE ITS LANE (DC15). Put a filter on the master, fade `fx.<id>.cutoff` 200 → 8000
//    over 3 s, and compare it against the SAME move drawn on an automation lane. They must sound the same.
//    (Linear-in-Hz is past 4 kHz within ~700 ms — you will hear the difference immediately.)
```
Assertions **3, 4 and 5** are the ones that prove the layer is a *layer* and not a trap. **If disabling the lane returns 1.0, the fade is being written into `ovr` and `release()` deleted it. If the master fader is dead, `releaseFade` is missing. If the second recall pops, the `from` is authored.** All three send you back to Step 4.

- [ ] **Step 7: Commit** — `feat(audio): the scene/cue fade layer — a lane always wins, structurally`

---

### Task 10: WS-B4b — `audio.*` on scenes and cues (the picker, the labels, the recall)

The seam is open (Task 9). Now the operator can actually author against it: capture an audio param into a **cue**, bind one to a **scene**, and have a recall **fade** it (D5).

**Two more live bugs this task fixes, both verified:**
- **`CueBankPanel.captureEntry` (`:109-117`) BAILS ON `undefined`** (`:112`) — and `getByPath(view, 'audio.…')` returns exactly that (`paramPath.ts:54`). **So you cannot even ADD an audio param to a cue today.**
- **`labelForPath` (`:341-348`) is worse than the spec says.** `leaf = parts.slice(2).join('.')` and `owner = parts[0] === 'surfaces' ? 'surf' : 'fix'` (**no `else` branch** — every non-`surfaces` head is labelled `fix`). Real current output: `audio.clip.c7.gain` → **`fix · c7.gain`** (the clip id presented as a leaf); `audio.master.gain` → **`fix · gain`** (the word *master* vanishes entirely); `audio.master.fx.e2.cutoff` → **`fix · fx.e2.cutoff`**.

**Why `Scene.audio` is a `CueEntry[]` and not a `StateView` slice (DC13):** `buildSceneSnapshot` (`App.tsx:608-615`) captures **6** of `Scene`'s 10 fields, but `handleRecallScene`'s fade only diffs the **3 StateView fields** (`fromView`/`toView`, `App.tsx:636-637`) — `groups`/`scene3D`/`projectorOutputs` are committed by direct setters (`:641-643`) and **SNAP**. A whole-mix audio snapshot would have to be told which side of that line it is on, and the answer ("some leaves fade, some snap, some are strings the fade engine must never see") is a classification problem with no good answer. **An explicit `{path, value}` list dodges it entirely**: every entry is a path the picker already vetted with `isFadeablePath`, and it recalls through the exact same leg machinery as a cue. It also gives the FSM audio recall **for free** — `recallScene` and `fireCue` both already route through `handleRecallScene` / `applyCues` (`stateMachine.ts:71-72` → `cueBus` → `App.tsx:744-748` / `:773`), so **`SmActionKind` needs ZERO changes**.

**Files:**
- Modify: `src/renderer/types.ts` (`Scene.audio?: CueEntry[]`)
- Modify: `src/renderer/components/CueBankPanel.tsx` (`labelForPath`, `captureEntry`, the picker)
- Modify: `src/renderer/App.tsx` (`applyCues`, `handleRecallScene`, `buildSceneSnapshot`'s sibling)

**Interfaces:**
- Consumes (Task 9): `pathLeaf`, `isFadeablePath`'s audio arm, `AutomationTargetProvider.writeFade` / **`getLive`**, `FadeLeg.log`, `automationTargetRegistry`.
- **Produces:**
  ```ts
  // src/renderer/types.ts — Scene gains:
  audio?: CueEntry[];   // { path, value, fadeSec?, transition? } — audio params this scene recalls

  // src/renderer/App.tsx
  const applyAudioEntries: (entries: CueEntry[], fadeSec: number, transition?: CueTransition) => transitions.FadeLeg[];
  ```

- [ ] **Step 1: `Scene.audio`**

`src/renderer/types.ts`, in `Scene` (**:801-813**), after `accent?` (**:812**):
```ts
  // AUDIO PARAMS THIS SCENE RECALLS — an explicit list, not a snapshot of the mix.
  //
  // A Scene is a LOOK snapshot for surfaces/fixtures/brightness, but audio deliberately is not: the mix is
  // a live, continuous thing (the bed does not restart on a recall — that is the whole point of the show
  // clock), and snapshotting it whole would force every leaf to be classified snap-vs-fade, including the
  // discrete `opts` strings the fade engine must never be handed. So a scene carries exactly the params
  // the operator CHOSE to bind, in the same {path, value} shape a Cue uses — recalled through the same
  // fade legs, with the same "a lane always wins" rule.
  //
  // Absent ⇒ this scene changes no audio at all (which is what every existing project means).
  audio?: CueEntry[];
```
`CueEntry` is `types.ts:821-826` — already `{ path; value: number | string | boolean | null; fadeSec?; transition? }`. Nothing else to add.

⚠ Serialization is **free**: `buildProjectData` (`App.tsx:843`) ships `scenes` whole. `handleCaptureScene` deep-clones nothing here (it spreads `buildSceneSnapshot()`), so add `audio` explicitly where a scene is created/updated — see Step 4.

- [ ] **Step 2: `CueBankPanel` — the label, the capture, the picker**

**`labelForPath` (`:341-348`)** — use `pathLeaf` and give the ternary an `else`:
```ts
// Short label from a dot-path leaf. HEAD-AWARE: an audio path is one segment deeper than a core one, and
// a bare slice(2) rendered `audio.master.gain` as "fix · gain" — the word "master" simply vanished, and
// every non-surfaces head was labelled "fix".
function labelForPath(path: string): string {
    if (path === 'globalBrightness') return 'LED Brightness';
    const parts = path.split('.');
    const leaf = pathLeaf(path).replace(/^content\./, '');
    if (parts[0] === 'surfaces') return `surf · ${leaf}`;
    if (parts[0] === 'fixtures') return `fix · ${leaf}`;
    if (parts[0] === 'audio') {
        // audio.clip.<id>.…  /  audio.track.<id>.…  /  audio.master.…
        const what = parts[1] === 'master' ? 'master' : `${parts[1]} ${parts[2]?.slice(0, 6) ?? ''}`;
        return `♪ ${what} · ${leaf}`;
    }
    return `${parts[0]} · ${leaf}`;   // an unknown plugin namespace: say its name, don't call it a fixture
}
```
(import `pathLeaf` from `../services/paramPath`.)

**The capture TARGET (DC16) — do this BEFORE `captureEntry`, or `Scene.audio` is unauthorable.** The whole picker is welded to `selCue`: `captureEntry` opens `if (!selCue) return;` and commits `patchCue(selCue.id, {entries})`; `removeEntry` / `setEntryValue` / `setEntryFade` / `setEntryTransition` (`:118-137`) are all `selCue`-bound; every `CaptureGroup` takes `cue={selCue}` and reads only `cue.entries` (`:320-329`). A `♪` button and one prop cannot invent a second commit destination. So give it one:
```ts
    // WHAT THE PICKER IS EDITING. A Cue and a Scene both carry a CueEntry[]; they differ only in where it
    // is committed. Everything below drives off this, so there is exactly ONE capture UI and no second,
    // drifting copy of the entry mutators.
    interface CaptureTarget {
        key: string;                              // for React keys / the header
        label: string;
        entries: CueEntry[];
        setEntries: (e: CueEntry[]) => void;
        audioOnly: boolean;                       // a Scene carries AUDIO params only (Scene.audio, DC13)
    }
    // Which one is open: the selected cue (Edit mode) or a scene's ♪ button.
    const [audioSceneId, setAudioSceneId] = useState<string | null>(null);
    const audioScene = audioSceneId ? scenes.find(s => s.id === audioSceneId) ?? null : null;
    const target: CaptureTarget | null =
        audioScene && onUpdateSceneAudio
            ? { key: audioScene.id, label: `♪ ${audioScene.name}`, entries: audioScene.audio ?? [],
                setEntries: (e) => onUpdateSceneAudio(audioScene.id, e), audioOnly: true }
        : selCue
            ? { key: selCue.id, label: selCue.name, entries: selCue.entries,
                setEntries: (e) => patchCue(selCue.id, { entries: e }), audioOnly: false }
        : null;
```
Then **all five** entry mutators take `target` instead of `selCue` — e.g. `const removeEntry = (path: string) => target?.setEntries(target.entries.filter(e => e.path !== path));` — and `CaptureGroup`'s prop `cue: Cue` becomes `entries: CueEntry[]` (it only ever read `cue.entries`). The scene row in the scene list gets a `♪` button: `onClick={() => { setAudioSceneId(s.id); setSelCueId(null); setMode('edit'); setAddOpen(true); }}`, and a visible way back out (clicking a cue clears `audioSceneId`).

**`captureEntry` (`:109-117`)** — the `getByPath` bail is the other half of why an audio param is uncapturable:
```ts
    const captureEntry = (def: ParamDef) => {
        if (!target) return;
        // Core params live on the StateView (getByPath). A PLUGIN-NAMESPACED param (audio.*) does not and
        // never will — it lives behind the AutomationTargetProvider contract, whose get() returns the
        // AUTHORED value (what the slider last wrote). Without this fallback, getByPath returns undefined
        // and the bail below fires: you could not add an audio param to a cue at all.
        const head = def.path.split('.')[0];
        const v = head === 'surfaces' || head === 'fixtures' || def.path === 'globalBrightness'
            ? getByPath(getCurrentState(), def.path)
            : automationTargetRegistry.get(head)?.get(def.path);
        if (v === undefined) return;
        const entries = target.entries.some(e => e.path === def.path)
            ? target.entries.map(e => e.path === def.path ? { ...e, value: v as CueEntry['value'] } : e)
            : [...target.entries, { path: def.path, value: v as CueEntry['value'] }];
        target.setEntries(entries);
    };
```

**The picker (`:301-307`)** — three **hardcoded** groups today, calling the three `paramPath` enumerators by name. **This is the sharpest asymmetry in the codebase** (contrast `AutomationTargetPicker.tsx:48`, which is `automationTargetRegistry.all().flatMap(...)`). Add the non-core namespaces from the registry:
```tsx
                            <div className="border border-line-1 rounded p-1.5 bg-surface-0 space-y-1.5 max-h-48 overflow-auto">
                                {/* A SCENE target carries audio params only (Scene.audio, DC13) — its look is a
                                    snapshot, captured by Capture/Update Scene, not by this picker. */}
                                {!target.audioOnly && <>
                                    <CaptureGroup title="Global" defs={globalParams()} entries={target.entries} onCapture={captureEntry} />
                                    {surfaces.map(s => <CaptureGroup key={s.id} title={s.name} defs={surfaceParams(s)} entries={target.entries} onCapture={captureEntry} />)}
                                    {fixtures.map(f => <CaptureGroup key={f.id} title={f.name} defs={fixtureParams(f)} entries={target.entries} onCapture={captureEntry} />)}
                                </>}
                                {/* PLUGIN NAMESPACES (today: audio). Registry-driven, like the automation picker
                                    already is — core does not know what a filter cutoff is, and does not need to.
                                    FADEABLE LEAVES ONLY: a cue that captured a discrete `opts` mode would hand the
                                    fade engine a string, or worse, interpolate a mode to 0.37. */}
                                {pluginParamGroups.map(g => (
                                    <CaptureGroup key={g.title} title={g.title} defs={g.defs} entries={target.entries} onCapture={captureEntry} />
                                ))}
                            </div>
```
(and `const CaptureGroup: React.FC<{ title: string; defs: ParamDef[]; entries: CueEntry[]; onCapture: (d: ParamDef) => void }>`, with `const has = entries.some(e => e.path === d.path);` — the only thing it ever read off the cue.)
with, near the top of the component:
```tsx
    // Re-enumerated on every open (the bed changes as clips are added), not memoized on a stale dep.
    const pluginParamGroups = useMemo(() => {
        const out: { title: string; defs: ParamDef[] }[] = [];
        for (const p of automationTargetRegistry.all()) {
            if (p.namespaces.every(ns => ns === 'surfaces' || ns === 'fixtures' || ns === 'globalBrightness')) continue; // core — already above
            let defs: { path: string; label: string; group: string }[] = [];
            try { defs = p.enumerate(); } catch { defs = []; } // a provider in a bad state must not break the panel
            const byGroup = new Map<string, ParamDef[]>();
            for (const d of defs) {
                if (!isFadeablePath(d.path)) continue;
                const g = byGroup.get(d.group) ?? [];
                g.push({ path: d.path, label: d.label });
                byGroup.set(d.group, g);
            }
            for (const [title, ds] of byGroup) out.push({ title, defs: ds });
        }
        return out;
    }, [addOpen]);
```

- [ ] **Step 3: `applyCues` — commit the audio legs (the drop-on-the-floor bug)**

`App.tsx:754-772`. **Today only `surfaces`/`fixtures`/`globalBrightness` are committed (`:767-769`) — an `audio` slice computed into `next` would be silently DROPPED ON THE FLOOR.** So audio must never go into `next` at all; it goes into the legs, and — for a zero-length fade — straight into the provider's fade layer:
```ts
  // The audio legs of a cue/scene. Audio does NOT live on the StateView (setByPath would silently no-op on
  // it), so it never touches `next` — it goes to its namespace's provider, through the fade engine.
  //
  // A ZERO-LENGTH FADE NEVER ENTERS THE ENGINE: transitions.start() fires onComplete and clears when no leg
  // has durMs > 0 (transitions.ts:53-58). So a snap recall must write the value ITSELF, or an audio param
  // bound to a scene with fadeSec 0 would do nothing at all — the single most likely way to author one.
  const applyAudioEntries = (entries: CueEntry[], fadeSec: number, transition?: CueTransition): transitions.FadeLeg[] => {
    const legs: transitions.FadeLeg[] = [];
    for (const e of entries) {
      if (typeof e.value !== 'number' || !isFadeablePath(e.path)) continue;
      const head = e.path.split('.')[0];
      const provider = automationTargetRegistry.get(head);
      if (!provider) continue;                       // the plugin is disabled — the entry persists, inert
      // THE FADE'S `from` IS THE *EFFECTIVE* VALUE, NOT THE AUTHORED ONE (DC11b). provider.get() returns
      // the authored value — what the slider last wrote — and the authored mix is NEVER touched by a fade.
      // So on the SECOND recall of a path, an authored `from` starts the leg where the operator's fader is,
      // not where the sound actually is: scene A fades master 1.0 → 0.2, scene B fades it → 0.5, and frame
      // one of B slams the master to FULL LEVEL before gliding down. getLive() = laneOvr ?? fade ?? authored.
      const from = provider.getLive?.(e.path) ?? provider.get(e.path);
      const sec = e.fadeSec ?? fadeSec;
      const trans = e.transition ?? transition;
      if (typeof from !== 'number' || sec <= 0 || trans === 'none') {
        provider.writeFade?.(e.path, e.value);       // SNAP — write the fade layer directly
        continue;
      }
      // LOG-CURVE TARGETS FADE IN LOG SPACE (DC15) — a cutoff, a delay time, an attack. The def knows;
      // enumerate() is the only thing that does. A missing def (a dangling path) just means linear.
      const log = provider.enumerate().find(d => d.path === e.path)?.log ?? false;
      legs.push({ path: e.path, from, to: e.value, transition: trans, fadeSec: sec, log });
    }
    return legs;
  };
```
⚠ **`e.transition === 'none' || transition === 'none'` was wrong**: a per-entry `transition` **overrides** the batch's, it does not AND with it (`transitions.start`: `const trans = t.transition ?? opts.transition ?? 'smooth'`, `:44`). An entry that explicitly asks for `'smooth'` inside a cue whose default is `'none'` must **fade**. Resolve first, then test — as above.

Wire it into `applyCues` (**:754-772**), splitting core from plugin heads:
```ts
    for (const cue of cues) for (const e of cue.entries) {
      const head = e.path.split('.')[0];
      if (head !== 'surfaces' && head !== 'fixtures' && e.path !== 'globalBrightness') continue; // handled below
      if (isFadeablePath(e.path) && typeof e.value === 'number') { …unchanged leg push… }
      next = setByPath(next, e.path, e.value);
    }
    setSurfaces(next.surfaces); setFixtures(next.fixtures); setGlobalBrightness(next.globalBrightness);
    // Plugin-namespaced entries (audio.*) — they never touch the StateView, and `next` above would have
    // dropped them on the floor.
    //
    // ⚠ PER CUE, NOT FLATTENED. Each cue carries its OWN fadeSec/transition, and the core loop right above
    // respects that (`fadeSec: e.fadeSec ?? cue.fadeSec` — App.tsx:763). Flattening the entries and handing
    // them cues[0]'s timing would fade a column's music in 0.5 s because the FIRST cue is a 0.5 s look cue —
    // or SNAP it, if cues[0].transition is 'none'. And `fireColumn` sorts bottom-to-top (App.tsx:786), so
    // cues[0] is not even the one the operator thinks of as "first". Iterate.
    const isPluginHead = (e: CueEntry) => {
      const h = e.path.split('.')[0];
      return h !== 'surfaces' && h !== 'fixtures' && e.path !== 'globalBrightness';
    };
    for (const cue of cues) {
      legs.push(...applyAudioEntries(cue.entries.filter(isPluginHead), cue.fadeSec, cue.transition));
    }
    if (legs.length) transitions.start(legs, { fadeSec: cues[0].fadeSec, transition: cues[0].transition });
    else transitions.cancel();
```
(The `transitions.start` opts stay `cues[0]`'s — they are only the **batch defaults**, and every leg above already carries its own `fadeSec`/`transition`. That is exactly how the core legs already work.)

- [ ] **Step 4: `handleRecallScene` — the scene's audio**

`App.tsx:633-658`. The fade already exists (`:647-651`); add the audio legs to the **same** `transitions.start()` batch so picture and sound fade together:
```ts
    // ── audio (Wave B) ── The scene's bound audio params. They do NOT ride the StateView diff above (audio
    // is not on the StateView and never will be) — they are an explicit {path, value} list, faded through
    // the same engine and landing in the provider's fade layer, UNDER any automation lane that owns the
    // same path. Absent `scene.audio` ⇒ this scene changes no audio, which is every existing project.
    const audioLegs = applyAudioEntries(scene.audio ?? [], scene.fadeSec ?? 0, 'smooth');
    const lookLegs = (scene.fadeSec && scene.fadeSec > 0) ? collectFadeableTargets(fromView, toView) : [];
    if (lookLegs.length || audioLegs.length) {
      transitions.start([...lookLegs, ...audioLegs], { fadeSec: scene.fadeSec ?? 0, transition: 'smooth' });
    } else {
      transitions.cancel();
    }
```
(This replaces the existing `if (scene.fadeSec && scene.fadeSec > 0) { transitions.start(...) } else { transitions.cancel(); }` block at `:647-651`. Note `applyAudioEntries` already snapped any zero-fade entry into the fade layer itself and returned no leg for it, so a `fadeSec: 0` scene still applies its audio — it just does not animate.)

**Authoring a scene's audio.** `buildSceneSnapshot` (`:608-615`) is **look-only, on purpose** ("so Update never clobbers it"). Do **not** put `audio` in it — that would make "Update Scene" silently re-capture the *live* audio over a carefully bound list. Instead, the **`♪` button on the scene row** from Step 2 opens the same picker with a **scene** `CaptureTarget` (DC16 — that abstraction is what makes this a button and not a second panel), via a new prop:
```ts
  onUpdateSceneAudio?: (id: string, entries: CueEntry[]) => void;
```
wired in App as:
```ts
  const handleUpdateSceneAudio = (id: string, entries: CueEntry[]) =>
    setScenes(prev => prev.map(s => s.id === id ? { ...s, audio: entries } : s));
```
⚠ The picker is the **only** writer of `scene.audio`; `handleUpdateScene` ("Update Scene") must keep spreading `buildSceneSnapshot()` over the scene, which — being look-only — leaves `audio` untouched. Verify that by binding audio to a scene, tweaking a light, pressing **Update Scene**, and confirming the audio binding survives.

- [ ] **Step 5: Verify**

```
npx tsc -p tsconfig.json --noEmit                                   # exit 0
npm run build                                                       # exit 0
npm run verify:plugins                                              # exit 0
git grep -n "parts\[0\] === 'surfaces' ? 'surf' : 'fix'"            # must print NOTHING
```
**LIVE — this is D5, end to end:**
1. Cue picker → the **audio** groups appear (`Master`, `Bed ▸ <clip>`, `Track ▸ <name>`), listing **only continuous leaves** (gain, position x/y/z, effect params). **No `filter.mode`. No effect type. No spatial on/off.**
2. Capture `audio.master.gain` into a cue with `fadeSec: 3`. The entry's label reads **`♪ master · gain`** — not `fix · gain`. Set its value to `0.2`. Fire the cue → **the music fades down over 3 s.**
3. Bind `audio.master.gain` to a **scene** with a 4 s fade. GO → **the music fades**, in step with the look, and **the bed does not restart** (Task 3).
4. **Set the scene's fade to 0.** GO → the audio **snaps** to the value. (This is the zero-fade path — if nothing happens, `applyAudioEntries`'s direct `writeFade` is missing.)
5. **THE OWNERSHIP RULE (D5's other half).** Draw an automation lane on `audio.master.gain`. Enable it. Recall the scene → **the lane wins**: the curve keeps driving the master and the fade is inaudible. **Disable the lane** → the master hands over to the **fade's** value, not to the authored one.
6. An FSM state bound to that scene → hopping into it fades the audio too, with **zero** state-machine changes.
7. **PER-CUE TIMING.** A column with cue A (`fadeSec 0.5`, a look) and cue B (`fadeSec 5`, `audio.master.gain`). Fire the column → **the music takes 5 s**, not 0.5. Now set A's transition to `none` → **the music still takes 5 s** (it does not snap with A).
8. **NO POP ON THE SECOND RECALL.** Recall scene A (master → 0.2, 3 s). Then recall scene B (master → 0.5, 4 s). It must **glide 0.2 → 0.5**. If it slams to full level first, the leg's `from` is authored, not live.
9. **Update Scene does not clobber the binding** (see the ⚠ in Step 4).

- [ ] **Step 6: Commit** — `feat(cues): audio.* on scenes and cues — recall with a fade; a lane always wins`

---

### Task 11: Docs, the new invariant, the CHANGELOG, and the false claim in `audio-engine.md`

**Files:**
- Modify: `docs/TIMELINE.md`
- Modify: `docs/SCENE-TIMELINES.md`
- Modify: `CHANGELOG.md`
- Modify: `plans/audio-engine.md`
- Modify: `plans/README.md` (index this plan)

- [ ] **Step 1: `docs/SCENE-TIMELINES.md` — the invariant, corrected in place**

**`docs/SCENE-TIMELINES.md:22-28`** currently reads *"There is only ever **one running transport**, one set of decoding `<video>`s, one set of acquired live sources."* **The next person to read that will be misled.** Rewrite the section as **"one transport, TWO PLAYHEADS"**:

> ### Invariant: one transport, two playheads
>
> There is only ever **one running transport** — one `playing` flag, one `requestAnimationFrame` loop, one
> set of decoding `<video>`s, one set of acquired live sources. We never composite or run two timelines.
>
> What that transport carries is **two derived times**:
>
> | | `playhead` — the SCENE clock | `showTime` — the SHOW clock |
> |---|---|---|
> | drives | the BOUND timeline's video, its own `Timeline.audio`, its automation lanes, the state machine | the global audio bed (`ProjectData.audio`) and the GLOBAL timeline's automation (the base layer) |
> | bounded by | the BOUND doc's `[timelineStart, timelineEnd)` | the GLOBAL doc's `[timelineStart, timelineEnd)` |
> | on a scene recall | **RESETS** to the scene's in-point | **NEVER RESETS** — the bed plays on |
> | on exit to Global | **RECONVERGES** onto `showTime` | unchanged |
> | on a seek | always moves | only while Global is bound |
> | anchor | `originMs` | `showOriginMs` |
>
> **While Global is bound the two are the same number** — an identity the engine maintains inside `seek()`
> and `setPlaying()` by testing `activeKey === GLOBAL_POOL`. They diverge only inside a scene: **the scene
> restarts, the bed rolls on.** This does not break the one-transport rule — there is still exactly one
> `playing`, one rAF, one `<video>` pool. A second *time value* rides the same clock.
>
> **The show clock is silent.** It never emits a `TransportIntent` and never pulses `hitEnd`: the bed
> wrapping is not a show event, and firing `onTimelineEnd` from it would advance the state machine behind
> the operator's back. It only wraps (global loop on) or parks (global loop off).

- [ ] **Step 2: `docs/TIMELINE.md` — the reset table, in full**

`docs/TIMELINE.md:71-75` and `:110-113` are the sections to extend. Add a new **"The show clock"** section carrying:
- the same two-playhead table as above;
- **the complete 18-row reset table from Task 2, verbatim** — it is the specification, and the next person to touch `mainSeek` needs it;
- the three rules, stated once: *the policy cannot live in `mainSeek`* (five callers, five different meanings); *the show clock is silent*; *`activeKey === GLOBAL_POOL` is the only representation of "Global is bound"*;
- **the two containers**: `ProjectData.audio` (the bed, show clock, never restarts) vs `Timeline.audio` (this doc's audio, playhead, restarts with it) — and that the clock follows the **container**, never the timeline it is drawn next to;
- **that the global timeline's Length is the SHOW's length** (DC2), and that a global loop wrap **does** restart the bed, on purpose (DC4);
- **that an audio clip does NOT extend `Length`** (D8) — the overrun badge is the affordance;
- the selection doctrine, unchanged but extended: selection is ephemeral, must never enter `Timeline`, and now lives in `services/selection.ts` (which is exactly why it can be published to a plugin panel without persisting).

- [ ] **Step 3: `plans/audio-engine.md` — correct the false P5 claim IN PLACE**

**`plans/audio-engine.md:68`** claims P5 works with *"**no new recall plumbing**"*. **That is false and must be corrected where it is written**, not just contradicted elsewhere. Replace that clause with:

> ~~Scene/state recall then works with **no new recall plumbing**~~ — **CORRECTED (Wave B, 2026-07-12).** The
> *recall* plumbing is reusable; the **param model was not extensible.** `paramPath.ts` had **zero**
> occurrences of "audio"; `isFadeablePath`/`getByPath`/`setByPath` are hardcoded head switches whose whole
> grammar is `<head>.<id>.<leaf>` via `slice(2)` — and an audio path is one segment deeper; `StateView` is a
> closed 3-field interface not exported from `@artlux/sdk`; `transitions.ts` is typed on `StateView`
> end-to-end; and there is **no `paramPathRegistry`**. Worse, `automationOverlay.owns()` — the rule that makes
> "a lane always wins over a scene fade" true — is a **core-only** map, so it could never see that an audio
> lane owned `audio.master.gain`, and `setByPath` on an `audio.*` path was a **silent no-op**.
> P5 therefore required: a head-aware `pathLeaf`, an `AUDIO_FADEABLE` leaf set, a registry-driven cue picker,
> a `writeFade` member on the SDK's `AutomationTargetProvider`, and a **second override layer** in the audio
> plugin read *under* the automation one. See
> [2026-07-12-audio-scoping-wave-b.md](../docs/superpowers/plans/2026-07-12-audio-scoping-wave-b.md), Task 9.

Also fix **`plans/audio-engine.md:68`**'s companion claim that per-frame audio fades apply *"at the existing hook (Stage.tsx)"* — **there is no audio sink in Stage's `tick()`**; the `eff*` values feed only the LED mapper and the composite. The sink is the **audio driver's own `eff`/`effGain`** pull-through.

- [ ] **Step 4: `CHANGELOG.md`**

Under `## Unreleased`, after the Wave A block:

```markdown
**Audio scoping — the bed no longer restarts on every scene recall (Wave B).** *One transport, two playheads.*

- **The show clock.** The global audio bed (`ProjectData.audio`) and the global timeline's automation now
  ride a second derived time, `showTime`, which a scene recall does **not** reset. A five-minute ambient
  bed plays continuously across every GO while the picture restarts. There is still exactly one transport
  (one `playing`, one rAF, one `<video>` pool) — see [docs/TIMELINE.md](docs/TIMELINE.md) for the full
  reset table. **Leaving a scene reconverges**: the playhead snaps to the show clock, so the picture
  rejoins the bed. (Clicking the scene pill back to Global used to *stop the transport* and kill the bed.)
- **The global timeline's Length is the SHOW's length.** The bed is bounded by it: with the global Loop on,
  the bed wraps with the show; with it off, **the bed ends at the global end and stays silent** until you
  Stop and Play, or lengthen the timeline. **Set the global Length to cover your show.** (Shortening it
  below where the show has already reached ends the show *immediately* — the bed cuts and stops.)
- **Audio lanes.** Audio is authored on a timeline lane — drag, trim, blade, snap, waveforms, and **fadeIn /
  fadeOut corner handles** (which the driver now honours; the two fields have been persisted and silently
  ignored since Wave 3). The Audio Bed panel's `@ N s` numeric placement field is **removed** — the lane
  replaces it. **`AudioTrack.solo` is honoured too** (also silently ignored until now).
- **`Timeline.audio` — every timeline gets its own audio.** Additive, normalize-defaulted. It rides the
  **playhead** and restarts with its timeline — unlike the bed. The clock follows the *container*.
- **The Audio Bed panel is now a mixer**: track faders + mute/solo, the master strip, and a clip inspector
  that follows the timeline selection.
- **Scenes and cues can recall audio params, with a fade** (`audio.master.gain`, clip/track gains, spatial
  position, effect params — continuous leaves only). **An automation lane always wins over a scene fade**,
  and disabling the lane hands the param to the fade, not back to the authored value.
- **Fixed: `Collect Assets` shipped a broken project.** `mapAssetPaths` never visited `data.scenes[]` or
  `data.audio`, so a file referenced only from a scene or only from the bed was **not copied, not rewritten,
  and not even reported as missing** — Collect said "copied 12" and the venue machine played nothing.
- **Fixed: the cue picker could not add an audio param at all** (`captureEntry` bailed on the `undefined`
  that `getByPath` returns for any `audio.*` path), and `labelForPath` rendered `audio.master.gain` as
  `fix · gain`.

> ⚠ **FORWARD-COMPAT:** a project saved by this build **will not fully load on an older one.** Scene and
> audio-bed asset paths are now relativized on save (they were written absolute, baked to the authoring
> machine); an older build's `resolveAssets` does not visit them and will never make them absolute again.
> No schema version distinguishes the two — `ProjectData.version` is read by nothing. Backward-compat is
> unaffected: old projects load exactly as they do today and are converted on the first save.
```

- [ ] **Step 5: `plans/README.md`** — index this plan next to the Wave A one.

- [ ] **Step 6: Verify**
```
npx tsc -p tsconfig.json --noEmit      # exit 0 (docs-only, but the repo gate is the repo gate)
npm run build                           # exit 0
git grep -n "only ever one running transport"    # must print NOTHING
git grep -n "no new recall plumbing"             # only inside the struck-through correction
```

- [ ] **Step 7: Commit** — `docs: one transport, two playheads — the show clock, the reset table, and the P5 correction`

---

## Final gate — the whole wave, live

Run **all** of these, in a real project, before calling Wave B done:

1. **The bed never restarts.** A 5-minute bed + three scenes. Press Play. GO between them, repeatedly, for a full minute. **The bed plays continuously — no restart, no gap, no click** — while video and each scene's own audio restart.
2. **Exit reconverges.** Click the pill back to Global. The bed keeps playing and the **picture jumps to where the bed is**. The transport does **not** pause.
3. **The lane.** Drag an audio clip on a lane → hear it move. Trim it → the waveform slides. Author a fade → hear it.
4. **The mixer.** Select the clip → the mixer shows its strip. Solo a bed track → only the bed's other tracks go quiet.
5. **The binding.** Bind `audio.master.gain` to a scene → recall **fades** the music. Draw a gain lane on the same path → **the lane wins**. Disable the lane → it hands the param back to the fade.
6. **Portability.** Collect Assets to a fresh folder, move it, open it. **Every scene plays. The bed plays.**
7. **Regression.** An existing project (no `Timeline.audio`, no `Scene.audio`, absolute scene paths) opens, plays to its end, and saves without losing anything.
8. **The parked show.** Global Length 60, Loop off, a looping scene bound, a 5-minute bed. Run past 60 s. **The bed goes silent and STAYS silent** (no 50 ms buzz), the scene's own audio keeps playing, the transport does not pause and the state machine does not hop. Stop → Play brings the show back from the top.
9. **The takeover.** After any audio recall, **every fader in the mixer still works.**
10. **The gates.** `npx tsc --noEmit` · `npm run build` · `npm run verify:plugins` · the design-token grep — all clean.

---

## Known minor issues to watch in review

Verified against the code, judged **not worth fixing inside this wave** — but a reviewer who spots one should know it was seen, not missed.

1. **`resetToNewProject` leaves a stale scene binding.** `App.tsx:995-1007` clears `scenes` but never clears `activeSceneId` and never swaps the engine — so after New Project the engine's `activePoolKey()` still names a deleted scene's pool, and `activeScene` is `undefined` (so `activeTimeline` silently falls back to the global doc). **Pre-existing**, unrelated to the show clock, and fixing it means deciding what New Project should do with the engine — which is a separate change. This wave only adds the show-clock reset (row 20). Do not expand it here.
2. **The mixer's clip/track/master faders still commit per `input` event** (`AudioBedPanel.commit()` → `host.audio.setMix`, the panel's existing idiom since Wave 3). That is `setAudioMix` → `recompileAutomation()` + the audio fan-out on every pointermove — expensive, but it does **not** reach `engine.setData`, so it cannot emit a `pause` intent and cannot postMessage the doc to the projectors. The *lane gutter's* faders **do** reach `setData`, which is why **those** are drafted (Task 5 Step 3) and these are left alone. If Task 8 grows a draft rig for them anyway, that is a bonus, not a requirement.
3. **`AUDIO_FADEABLE_RE` would admit a hand-authored `fx.<id>.mode`.** No code path constructs one — `AudioEffect.opts` (the discrete filter mode) is a separate list from `params`, and both the automation picker and the cue picker are `enumerate()`-driven, which iterates `def.params` only. A hand-edited project could still write one, and the fade engine would hand it a number. Low value to guard; note it.
4. **A fade entry for a deleted clip lingers in the `fade` map** (as a lane override already lingers in `ovr`). Harmless — nothing reads a path whose owner is gone — and `releaseAllFades()` clears them on the next project open. Not worth a pruning pass.
5. **`Timeline.audio` tracks are not editable from the mixer** (Task 8 renders them read-only, pointing back at the lane). That is deliberate: the panel is a plugin and has no write path to a core `Timeline`. The lane gutter carries name/mute/solo/gain for them. A `host.audio.setTimelineAudio()` is a follow-on, not this wave.
6. **A timeline-less scene restarts the global picture while the global curves keep running on the show clock** (DC6b). Consistent with the base-layer doctrine and required for the bed's automation to survive a recall — but it is a real behavioural asymmetry for a *core* global lane under such a scene. Legacy shape (every scene captured by `handleCaptureScene`/`handleCreateState` gets its own timeline), so the blast radius is small.
