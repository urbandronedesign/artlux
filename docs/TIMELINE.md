# Timeline (NLE) — architecture & usage

The **video-layer timeline** is a DaVinci Resolve-style non-linear editor for placing video clips
on tracks (layers) over time. A track is an addressable output channel: surfaces and 3D planes bind
to a track's `layerId` and show whatever clip is under the playhead. Shipped as a basic editor in
v0.4.0, reworked into a full NLE in v0.11.0, and made an **infinite, navigable, programmable**
surface in **v0.12.0** (maximize, mouse zoom/pan, unbounded clock + optional loop region, and an
always-present state-machine control layer). Wave A later **bounded the clock again** (see
**Length bounds playback** below) — the infinite pan/zoom canvas and the state-machine layer are
unaffected.

> **Scope invariant (clips):** clip editing is **UX-only** — the track header flags
> (`muted/solo/locked/enabled`) are visual aids, never engine inputs, and the engine still samples
> the **topmost clip per track** under the playhead (gaps → black). Multiple clips per track sequence
> naturally from this.
>
> **Deliberate engine changes (v0.12.0; clock re-bounded in Wave A):** the playback **clock** in
> `services/timeline.ts` bounds playback to `[timelineStart, timelineEnd)` — `Timeline.loop` wraps
> over that range (the whole timeline when no in/out region is set); with Loop off the playhead
> advances to the end and **parks on the last frame** instead of going black. See **Length bounds
> playback** below. A separate **state-machine** layer can drive transport — it never writes
> `playing` itself, only emits `TransportIntent`s that `App` turns into React state (App stays the
> single transport writer). Video sampling/compositing is otherwise untouched.

## Where it lives

```
src/renderer/components/timeline/
  Timeline.tsx        container: ephemeral UI state, layout, wiring (the only stateful component)
  TimelineToolbar.tsx  transport, tool mode, snap toggle, marker, zoom, fps, length, add track
  TimelineRuler.tsx    HH:MM:SS:FF ticks, markers, in/out band, click-to-seek
  TrackHeader.tsx      name, M/S/L, show-hide, color, reorder grip, height-resize (React.memo)
  Lane.tsx             one track's clip lane: drop target, hosts ClipBlocks
  ClipBlock.tsx        one clip: move/trim/blade hit zones, hosts the Filmstrip / BlobSparkline (React.memo)
  Filmstrip.tsx        imperative <canvas> of thumbnails; decoupled from React render
  TakesBin.tsx         LiDAR take recorder control + draggable take chips (v0.14.0)
  BlobSparkline.tsx    per-clip blob-density signature for tracking-take clips (v0.14.0)
  StateLane.tsx        always-present control lane: live state, manual-trigger buttons, time markers
  StateGraphEditor.tsx modal node-graph editor: states (draggable), transitions, entry actions/triggers
  AudioLane.tsx        one audio track's lane (Timeline.audio): clips, waveform, drag/trim/blade, fade handles, gutter
  audioPeaks.ts        cached waveform peaks (decodeAudioData) — path-keyed + deduped, never on the rAF path
  geometry.ts          layout constants (+ SM_LANE_H, AUDIO_LANE_H, PAGE_SECS) + px<->sec + timecode helpers
  operations.ts        PURE clip ops: split, blade, rippleDelete, liftDelete, rippleTrim (generic over video + audio clips)
  snapping.ts          PURE: collect snap points + nearest-within-threshold
  hooks/useTimelineKeys.ts  keyboard shortcuts scoped to the panel

src/renderer/services/
  timeline.ts          the playback engine (bounded clock + THE SHOW CLOCK: loops or stops at Length + per-track decode + transport intents + per-scene pools)
  selection.ts         render-free timeline-selection channel (ephemeral; published to plugin panels)
  timelinePreloader.ts tiered residency (ACTIVE/WARM/COLD) so per-scene timeline swaps stay hitless — see SCENE-TIMELINES.md
  stateMachine.ts      PURE-ish FSM runtime: tick/triggerManual/subscribeState, emits TransportIntents
  thumbnailCache.ts    async LRU thumbnail extraction, isolated from playback
  hapDecode.ts         + decodeFrameRaw(): one-shot HAP decode that bypasses the playback ring
```

State lives in `App.tsx` (`timeline: Timeline`) and persists to `ProjectData.timeline`. That is the
**shared global** timeline; each **Scene** may also own its own `timeline`, and the editor/engine bind
to whichever is *current* — see [SCENE-TIMELINES.md](SCENE-TIMELINES.md). The engine now holds a
**pool of per-layer decoders per scene** (one active at a time) with `warmPool`/`swap`/`releasePool`;
a tiered `services/timelinePreloader.ts` keeps scene swaps hitless.

## Data model (`src/renderer/types.ts`)

```ts
VideoLayer  { id, name, height?, color?, muted?, solo?, locked?, enabled? }   // flags are UX-only
VideoClip   { id, layerId, name, path, start, duration, inPoint, sourceDuration?, color? }
Marker      { id, time, color, note? }
SmAction    { kind: play|pause|stop|seek|setLoop|jumpMarker, seekTo?, loopOn?, markerId? }
SmTrigger   { kind: manual|afterDelay|atTime|onMarker|onClipEnd|onTimelineEnd, seconds?, time?, markerId?, layerId? }
SmState     { id, name, x, y, entry: SmAction[] }
SmTransition{ id, from, to, trigger: SmTrigger }
StateMachine{ enabled, states[], transitions[], initialStateId }
AudioSpatial{ x, y, z, order? }                              // absent on a clip ⇒ non-spatial
AudioClip   { id, trackId, name, path, start, duration, inPoint, sourceDuration?, gain?, mute?,
              fadeIn?, fadeOut?, spatial?: AudioSpatial, effects? }
AudioTrack  { id, name, busId?, gain?, mute?, solo?, color? }   // NO height: audio lanes are a constant
TimelineAudio { tracks: AudioTrack[], clips: AudioClip[] }
Timeline    { layers, clips, duration, fps?, markers?, inPoint?, outPoint?, loop?, trackingTakes?,
              automation?, audio?, boundedDuration?, stateMachine? /* @deprecated → ProjectData */ }
```

- The spatial field is **`spatial`**, not `position`. It is also the automation leaf: a clip's fadeable
  paths are `audio.clip.<id>.gain`, `audio.clip.<id>.spatial.{x,y,z}` and `audio.clip.<id>.fx.<id>.<param>`
  (`AUDIO_FADEABLE_RE`, `services/paramPath.ts`). Any other spelling is a **silent** failure: the fade gate
  rejects it (the cue snaps instead of gliding) and the provider has no such leaf (the write is a no-op, no
  error, no log). Never hand-type an audio path — take it from `provider.enumerate()`, which is the catalog.
- `VideoClip.inPoint` is the **source trim** (offset into the file). `Timeline.inPoint/outPoint` is a
  separate **timeline range** that narrows the timeline's own start/end (see below) — it now bounds
  playback whether `loop` is on or off, not only when looping.
- **Length bounds playback (restored in Wave A).** `Timeline.duration` — the **Length** field — is the
  end of the timeline. `inPoint`/`outPoint` narrow it:

      start = inPoint  ?? 0
      end   = outPoint ?? duration

  With **Loop** on, playback wraps over `[start, end)` — including with no in/out region set, in which
  case it loops the whole timeline. With Loop off, the playhead advances to `end` and **parks on the
  last frame** (`end - 1/fps`, standard NLE semantics — one frame back so a clip is still under the
  playhead and the output doesn't cut to black), and the engine emits a `pause` TransportIntent (it
  never writes `playing` itself — App owns that).

  This reverses the v0.12.0 change that made the clock unbounded. That change left **Length** and
  **Loop** as controls that did nothing: `duration` was a hint nothing read, and Loop needed an in/out
  region settable only via the undocumented `I`/`O` keys. Projects saved under the old rule may hold
  clips past their Length; `normalizeTimeline` raises `duration` to the content end **at load** so none
  of them truncate — it never lowers it, since a deliberately long Length (trailing silence, a hold) is
  a legitimate authoring choice. Seeking past the end is still allowed — only *playback* is bounded.
- All new fields are optional and back-compatible. `normalizeTimeline()` defaults old projects on
  load (`loop:false`, an empty disabled `stateMachine`). Save/broadcast carry the whole object.

## Key design decisions (read before extending)

- **Engine boundary.** Do not read `muted/solo/enabled` in `services/timeline.ts` `syncLayer()` — that
  would change playback and break the scope invariant. They only dim/highlight in the UI. (Making
  `enabled` actually hide a track would be a deliberate engine change.)
- **Thumbnails never disturb playback.** `thumbnailCache.ts` decodes on its own path: normal video via
  a small offscreen `<video>` pool (separate from the engine's layer videos); HAP via
  `hapDecode.decodeFrameRaw()` (a one-shot IPC decode that bypasses the playback decode-ahead ring) and
  rasterizes on a dedicated `hapGL` key `'__thumb__'` (never a live layer's canvas/context). Cache is
  LRU-bounded and time-quantized so adjacent strip slots share frames.
- **Ephemeral vs persisted.** Tool mode, snapping toggle, selection, zoom, hover, and the live drag
  draft are **component state** — they must not enter `Timeline` (it broadcasts to the Scene/projector
  on every change and dirties the project). Only data fields persist.
- **Selection is ephemeral, and stays ephemeral even though a plugin can read it.** The clip selection is
  *mirrored* into a render-free singleton (`services/selection.ts` — `set`/`get`/`subscribe`, the
  `automationOverlay` idiom) and published to plugin panels as `host.show.getSelection()` /
  `subscribeSelection()`, which is how the audio mixer's clip inspector follows the timeline. It is a
  **channel, not a store**: nothing persists it, and it must never enter the `Timeline` type. (That
  indirection is exactly *why* it can be published without dirtying the project.)
- **Perf (whole-tree re-render, no app-wide memo).** `ClipBlock` and `TrackHeader` are `React.memo`'d
  and receive **stable** `useCallback` handlers that read live values from refs. Clip move/trim uses a
  local `setDraft` (not `onChange`) so the engine isn't re-warmed (`setData`) mid-drag; it commits once
  on release. The playhead, snap guide, filmstrip, and timecode all update imperatively.
- **Layout.** A single vertical scroller holds a **sticky** track-header gutter (left) and a **sticky**
  timecode ruler (top); the playhead/snap-guide are absolutely positioned in content coords. Pointer→
  time uses `clientXToTime()` (scroll container rect + `scrollLeft` − `GUTTER`).
- **Infinite width without per-frame setState.** Content width = `max(contentEnd, (pages+1)·PAGE_SECS)·
  pxPerSec`. `pages` is bumped (quantized to `PAGE_SECS`) in the engine subscription only when the
  playhead nears the right edge, so the growing canvas never re-renders the tree per frame. The ruler
  draws ticks across the rendered width, and `clientXToTime` clamps to the explored view edge.
- **Cursor-anchored zoom.** The wheel handler is a **non-passive** `addEventListener('wheel', …,
  {passive:false})` (React `onWheel` is passive and can't `preventDefault`). It preserves the
  time-under-cursor by setting `scrollLeft` in a `requestAnimationFrame` after the new width lays out,
  using the same `GUTTER` offset as `clientXToTime`.

## Infinite navigation, looping & the end-stop (v0.12.0; clock bounded again in Wave A)

- **Bounded clock.** `frame()` advances `playhead = (now − originMs)/1000` and tests it against
  `[timelineStart, timelineEnd)` every frame (see **Length bounds playback** above). Looping wraps over
  that range; not looping parks the playhead on the last frame at the end instead of running past it.
- **Loop region.** Toolbar loop toggle (**Shift+L**) sets `Timeline.loop`; the clock wraps over
  `[timelineStart, timelineEnd)` — the **whole timeline** when no `inPoint`/`outPoint` is set, or the
  narrower region when one is (re-anchoring `originMs` to keep cadence uniform). Loop is computed
  **only in the main window**; mirror windows (Scene/projector) receive the wrap as a bridged seek (the
  >0.5s branch snaps; the slew path is for small drift). The region's edges are **draggable on the
  ruler**, and toolbar **Set In** / **Set Out** buttons set them without needing the `I`/`O` keys.
  **Stop** returns to the in-point (not hard 0).
- **Mouse:** wheel = zoom (anchored at the cursor), **Shift+wheel** = horizontal scroll, **middle-button
  drag** = pan both axes (imperative — zero re-renders). Left-button-only guards on the lane/ruler seek
  handlers keep middle-click free for panning.
- **Maximize:** the dock is drag-resizable (top edge), and **F** / the toolbar button toggle a
  fullscreen overlay. The timeline renders in **exactly one** place at a time (dock XOR overlay) so its
  key hook and engine subscription are never doubled.

## The show clock (Wave B) — one transport, two playheads

The transport carries **two derived times**. There is still exactly **one** running transport — one
`playing` flag, one rAF loop, one `<video>` pool (see [SCENE-TIMELINES.md](SCENE-TIMELINES.md)); what is
new is a second *time value* riding the same clock, because a scene recall must restart the picture
**without restarting the music**.

> **This section exists because of audio, and it is the half of the story that lives here.** The other half —
> which container a sound goes in, and therefore which of these two clocks it rides — is
> **[AUDIO.md](AUDIO.md)**. If you are here because something restarted (or *didn't*) when you fired a cue,
> that is the page you want. To *hear* the difference in about four minutes, open
> **[`examples/audio/`](../examples/audio/README.md)**.

| | `playhead` — the SCENE clock | `showTime` — the SHOW clock |
|---|---|---|
| drives | the BOUND timeline's video, its own `Timeline.audio`, its automation lanes, the state machine | the global audio bed (`ProjectData.audio`) and the GLOBAL timeline's automation (the base layer) |
| bounded by | the BOUND doc's `[timelineStart, timelineEnd)` | the GLOBAL doc's `[timelineStart, timelineEnd)` |
| on a scene recall | **RESETS** to the scene's in-point | **NEVER RESETS** — the bed plays on |
| on exit to Global | **RECONVERGES**: `playhead := showTime` | unchanged |
| on a seek | always moves | only while the **global document** is bound |
| anchor | `originMs` | `showOriginMs` |
| read by | `subscribe(playhead)`, `getStatus().playhead` | `getShowTime()`, `getStatus().showTime` |

Both are **derived** — `(now − anchor) / 1000`, never accumulated — so every branch that *moves* a clock
must re-anchor its own origin. (`showTime` has no `prevShowTime` to re-baseline, because nothing
crossing-detects on it: `fsm.tick()` runs on `playhead` alone, deliberately.)

### The three rules

1. **The reset policy cannot live in `mainSeek`.** `mainSeek` is reached from five semantically distinct
   events (Stop, a user seek, a scene recall, play-from-the-parked-end, project open) and the policy
   discriminates among them. Instead the engine maintains the **identity** (`clocksCoincident()` ⇒ the show
   clock tracks the playhead) inside `seek()`, and *every other* move is an explicit `showSeek()` from a
   named call site or an explicit `swap()` option.
2. **The show clock is silent.** It emits **no** `TransportIntent` and pulses **no** `hitEnd` — it only
   wraps or parks. Firing `onTimelineEnd` from the bed looping would advance the state machine behind the
   operator's back. "Silent" is not "invisible": the park is published on `getStatus().showEnded`, because
   a consumer riding a **frozen** clock has to know it is frozen (the audio driver stops the bed on it —
   reconciling a live driver against a frozen clock does not go silent, it *buzzes*).
3. **TWO PREDICATES, TWO QUESTIONS — and swapping them is a bug.**
   - **`isGlobalDocBound()`** = `activeKey === GLOBAL_POOL || data === globalDoc` — *which **document** is
     bound.* A scene with **no timeline of its own** plays the GLOBAL document under its own pool key, and
     there `data.automation` **is** the base layer. This is the right question for **which clock a LANE
     RIDES** (`compileAutomation`): a lane of the global doc is a base lane and rides the **show** clock,
     wherever that doc happens to be bound. Ask the **document**, not the key.
   - **`clocksCoincident()`** = `activeKey === GLOBAL_POOL` — *are `playhead` and `showTime` **the same
     number**.* This is the right question for **whether a seek MOVES BOTH CLOCKS** (`seek()`). It is
     **narrower**, and it must be: a timeline-less scene is bound with `transport:'restart'` (playhead → 0)
     and the default `showClock:'preserve'` (bed rolls on) — the **document** is bound, the **clocks are
     minutes apart**. Gating the seek on the document there hurls `showTime` to a scene-relative number and
     **hard-restarts the bed on every entry to that state**. The Global pill is the only state no
     restart-swap has pulled apart — which is also why `App.tsx` gates the bed's *lanes* on `activeSceneId`.

   `isGlobalDocBound()` **does not assert that the two clocks are equal.** It never did.

### The two audio containers — the clock follows the CONTAINER

| | `ProjectData.audio` — **THE BED** | `Timeline.audio` — **this doc's audio** |
|---|---|---|
| one per | project | timeline (the global one *and* every scene's) |
| rides | **`showTime`** | **the `playhead`** |
| on a scene recall | **never restarts** | restarts with its timeline |
| authored on | the Audio Bed panel's lane + the mixer | that timeline's audio lanes |

The clock follows the **container**, never the timeline the lane happens to be drawn next to. A bed clip
drawn on the global timeline's ruler still rides `showTime`; the global timeline's *own* `Timeline.audio`
rides the playhead and restarts whenever the global timeline does. A show can legitimately use both.

**The global timeline's Length is the SHOW's length**, and the bed lives inside it:

- **Global Loop ON** → `showTime` wraps `[globalStart, globalEnd)` and **the bed restarts with it**. That
  backward jump is read by the audio driver as a seek and hard-resyncs the bed — which is *correct*: the
  show looped. (A **scene's** loop wrap no longer touches the bed at all — that was the bug.)
- **Global Loop OFF** → `showTime` **parks** at `globalEnd − 1/fps`, `showEnded` goes true, and **the bed
  stops**. It stays stopped until Stop→Play, a `play` intent, or a longer global Length. Set the global
  Length to cover your show.

**An audio clip does NOT extend `Length`.** `normalizeTimeline`'s one-shot duration raise is
**video-only** (raising it for audio would re-break the "deliberately short Length" rule Wave A's
`boundedDuration` marker exists to protect). The affordance is instead the **overrun badge** on the ruler
— "content past the end" — with a one-click **Length → content end** fix. It counts video *and* audio
clips.

### THE SHOW-CLOCK RESET TABLE

`G` ≡ `clocksCoincident()` (`activeKey === GLOBAL_POOL` — the Global pill). `globalStart` / `globalEnd` ≡
`timelineStart(globalDoc)` / `timelineEnd(globalDoc)`.
**This is the specification** — the next person to touch `mainSeek`, `swap` or `frame()` needs all of it.

| # | Transport event | `playhead` | `showTime` | Enforced by |
|---|---|---|---|---|
| 1 | **Stop** (`{kind:'stop'}`) | → the **BOUND** doc's start | **RESET to `globalStart`** — `getStart()` is the *bound* doc's start, and while a scene is bound that number means nothing to the bed | an explicit `showSeek(getGlobalStart())` in App's `stop` intent handler |
| 2 | **Seek while GLOBAL is bound** — the pill (ruler scrub, `seekTo`, automation-lane click, Home/End, OSC, `host.show.transport`) | jumps | **MOVES to the same value** (the identity) | inside `seek()`: `if (!external && clocksCoincident()) showSeekInternal(clamped)` |
| 3 | **Seek while ANY SCENE is bound** — *its own* timeline **or the global doc under its pool key** (a timeline-less scene) | jumps | **DOES NOT MOVE** | the same `if` — it simply does not fire. ⚠ **The timeline-less case is why the test is `clocksCoincident()` and not `isGlobalDocBound()`:** the *document* is bound but the clocks are minutes apart (`restart` reset the playhead; `preserve` left the bed running), so tracking the seek would hurl `showTime` to a scene-relative number and **hard-restart the bed on every entry to that state** |
| 4 | **Scene recall / GO / cueBus / FSM hop / `enterAuthor` / `fireColumn`** | → the scene's in-point | **NEVER RESET** — *the defining requirement* | `swap`'s default `showClock:'preserve'`; `mainSeek` never touches `showOriginMs` |
| 5 | **Exit to Global** (pill → Global) | **RECONVERGES: `playhead := showTime`** | does not move | `swap(..., {transport:'reconverge'})`. Normally `showTime` is inside `[globalStart, globalEnd)` ⇒ nothing to clamp, **no `pause`**. ⚠ **Exception:** a **parked** show clock is at `globalEnd − 1/fps`, one frame inside the end, and `mainSeek` *clears* `endLatched` — so the raw end-stop would pulse `hitEnd` two frames later and fire `onTimelineEnd` **from a mouse click**. The arm therefore re-applies the latch: `endLatched = true` + a `pause` intent, **without pulsing `hitEnd`** |
| 6 | **Scene deleted while bound** | as row 5 | as row 5 | `'reconverge'` |
| 7 | **Loop wrap of the BOUND (scene) timeline** | wraps to the scene's `timelineStart` | **DOES NOT MOVE** — *the scene restarts, the bed rolls on* | the bound doc's wrap touches only `originMs` / `prevPlayhead` |
| 8 | **Loop wrap of the GLOBAL region** (`globalDoc.loop === true`) | unaffected (unless `G`, where it *is* the same wrap) | **WRAPS over `[globalStart, globalEnd)`**, re-anchoring `showOriginMs` | the show-clock branch in `frame()`. The driver reads the backward jump as a seek and restarts the bed — **correct: the show looped** |
| 9 | **End-stop of the GLOBAL region** (`globalDoc.loop === false`) | unaffected (unless `G`) | **PARKS at `globalEnd − 1/fps`**, and **`showEnded` goes TRUE** | the show-clock branch. **No intent, no `hitEnd`** — but the park is *published*, and the audio driver **stops the bed and skips `reconcile()`** on it. `playing` is no signal here: a scene looping underneath keeps it true |
| 10 | **End-stop of the BOUND (scene) timeline** (loop off) | parks on the last frame | **FREEZES — but only if the `pause` actually lands.** If the FSM re-armed the clock in the same tick the pause is swallowed, `playing` stays true, and the bed rolls on: **an auto-advancing show never freezes its bed** | falls out of the existing end-stop latch — no new mechanism |
| 11 | **Document edit of the BOUND doc** (Length lowered, `O` at the playhead, fps changed) | conditionally jumps + emits `pause` | **DOES NOT MOVE** | `clampPlayheadIntoDoc` never touches `showOriginMs` |
| 11b | **Document edit of the GLOBAL doc while a SCENE is bound** (`setData`'s guard does *not* run — `activeTimeline` is the scene's) | unaffected | **RE-ANCHORED INTO THE NEW REGION, SILENTLY** — no intent, no pulse, no phantom recall. ⚠ **But it is audible:** dropping the global Length 300 → 60 while `showTime` is at 300 **is** a −240 s move — the driver reads it as a seek and **the bed hard-cuts**; if the new region has already ended it *stops* (row 9) | `setGlobalDoc` re-anchors into `[globalStart, globalEnd)` in the same call, deterministically, and **never synthesises a transport event** |
| 12 | **Play from the parked end** | restarts the bound doc | **restarts the SHOW clock iff `showAtEndBound()`** | `setPlaying(true)` **and** App's `play` intent handler — **both**. A `play` arriving while `playing` is already true never reaches `setPlaying()`, and an FSM hopping between *looping* scenes keeps `playing` true forever; without the second site a show that ran out its global Length has a **permanently dead bed** and nothing says so |
| 13 | **Underrun** (Play at 0 on a doc whose in-point is 5 s) | jumps *forward* to the **BOUND** doc's in-point | its **own** underrun test, against `globalStart` — **a scene's in-point cannot drag the show clock** | a parallel `if (s < ga)` branch in the show clock |
| 14 | **Pause / resume** | frozen / seamless | **identical treatment on `showOriginMs`** — the paused hold runs every frame and is what keeps the anchor live | ⚠ `setPlaying` early-returns when unchanged: never put show-clock logic where that guard can skip it |
| 15 | **Project open** | resets | **RESET to `globalStart`** | `applyProjectData` passes `{transport:'restart', showClock:'reset'}` (rows 4/15/16 all reach `swap(..., 'restart')` and cannot be told apart *inside* `swap` — the caller says which it is) |
| 16 | **`handleCreateState`** | resets | **NEVER RESET** — a recall-shaped event: you drop into author mode on a new state and the bed keeps playing | `swap`'s default `showClock:'preserve'` ⇒ the call site does not change |
| 17 | **Mirror-window slew / snap** (projector) | slews / snaps | **NOT COMPUTED AT ALL** | one `if (!external)` around the whole show-clock block (**not** `!external \|\| hapLocal`). Nothing show-clock-driven renders in a projector: the audio driver early-returns for non-main windows and the bridge streams only `{playing, playhead}` |
| 18 | **`start()`** | init | init `showOriginMs` alongside `originMs` | mind the `if (!raf)` guard |
| 19 | **The `loop` intent** (an FSM `setLoop` entry action, or the Loop button) | unaffected | **does not move — but it flips the show clock between row 8 (WRAP: the bed restarts every lap) and row 9 (PARK: the bed stops)** | falls out of the `setGlobalDoc` push. `globalDoc.loop` is a **live input** to the show clock, and an unattended FSM can reach it |
| 20 | **New Project** | **RESET to `globalStart`** | **RESET to `globalStart`** — the show clock must not keep running into a project that no longer exists | `resetToNewProject` clears `activeSceneId` + the state machine and re-binds the engine to the global pool: `swap(GLOBAL_POOL, timeline, {transport:'restart', showClock:'reset'})`. ⚠ **The bare `showSeek` this replaces moved ONE clock and left the binding on a scene that no longer exists** — the engine stayed on the departed scene's pool, `handleTimelineChange` mapped every edit over an empty `scenes` array (silently discarded), and the mixer locked its seek on a phantom `activeSceneId` |

Rationale for every row (and the design calls behind it) lives in
[`docs/superpowers/plans/2026-07-12-audio-scoping-wave-b.md`](superpowers/plans/2026-07-12-audio-scoping-wave-b.md), Task 2.

### Engine API (`services/timeline.ts`)

| Method | Purpose |
|---|---|
| `setGlobalDoc(t)` | App pushes the **global** timeline (the engine's `data` is always the *bound* doc). Also re-anchors `showTime` into the new `[start, end)` — silently (row 11b). |
| `getShowTime()` | the show clock, in seconds. Always `0` in a mirror window. |
| `getGlobalStart()` / `getGlobalEnd()` | the show's playable range. |
| `isShowAtEndBound()` | the show clock is **parked** at the global end (loop off). A driver reconciling against `showTime` **must** check this. |
| `showSeek(sec)` | move the show clock explicitly (Stop, project open, New Project). No-op when `external`. |

## State-machine control layer (v0.12.0)

An always-present FSM (`Timeline.stateMachine`, kept outside `layers[]`/`clips[]` so video logic is
untouched) that can drive transport. It is **disabled by default**; enable it from the state lane or
the toolbar.

- **Model:** named `SmState`s with `entry` actions (play/pause/stop/seek/setLoop/jumpMarker) and
  `SmTransition`s whose `SmTrigger` fires on `manual`, `afterDelay`, `atTime`, `onMarker`, `onClipEnd`,
  or `onTimelineEnd` (the bound timeline reaching its end while playing and not looping — a loop wrap
  does **not** fire it). Note `onClipEnd` **never fires for a clip that runs to the end of the
  timeline**: the end-stop parks the playhead *inside* that clip (see above), so no gap ever opens on
  it; use `onTimelineEnd` for "the show finished". Author it in the **Edit logic** modal
  (`StateGraphEditor`): drag state nodes, use a node's *link* to connect, set the initial (star), edit
  entry actions and triggers in the inspector.
- **Runtime (`services/stateMachine.ts`):** the engine calls `fsm.tick()` once per frame **main window
  only**. It (re)initializes on the `enabled` rising edge or when the current state vanishes (so editing
  the graph while running doesn't reset it), then evaluates the current state's outgoing transitions in
  order, firing **at most one per frame**. Crossings use a `prev→cur` window that handles loop/seek
  wraps; `seek()` resyncs `prevPlayhead` so a deliberate jump doesn't fire every intermediate trigger.
- **Single transport writer:** entry actions emit `TransportIntent`s; the engine **never** sets its own
  `playing`. `App.subscribeIntent` maps them to `setIsVideoPlaying` / `engine.seek` / `setTimeline`
  (loop), and the existing `setPlaying` effect drives the engine — so App stays the one source of truth
  and the FSM-driven changes show in the UI play button and bridge to mirrors for free.
- **State lane:** shows the live current state (render-free via `subscribeSmState`) and **manual-trigger
  buttons** for the current state's manual transitions; `atTime` transitions appear as diamonds.

## Interactions

- **Drop** a video file onto a lane to create a clip at that time.
- **Audio lanes** (`Timeline.audio`) behave like clip lanes: drop an audio file to place a clip, drag to
  move, drag an edge to trim, blade to split, snap to the same guides — plus **fadeIn / fadeOut corner
  handles** (drag the top corners of a clip) and a waveform. A clip past the **Length** raises the ruler's
  **overrun badge** (audio never extends Length by itself); one click sets Length to the content end.
  Selecting a clip drives the Audio Bed panel's clip inspector.
- **Select tool (V):** drag a clip body to move; drag its left/right edge to trim. Magnetic snapping
  (toggle **S/N**) aligns to clip edges, the playhead, markers, the in/out range and track start, with
  a live guide.
- **Blade tool (B):** click a clip to split it at the cursor; **C** blades at the playhead.
- **Tracks:** mute (M), solo (S), lock (L, blocks edits/drops on that lane), show-hide eye, cycle color,
  drag the grip to reorder, drag the header's bottom edge to resize height.
- **Markers:** **M** adds at the playhead; click a marker to seek, Alt/right-click to delete,
  double-click to edit its note.
- **Range:** **I/O** (or the toolbar **Set In**/**Set Out** buttons) set the timeline in/out points,
  shown as a band on the ruler whose edges are also **draggable**.

### Keyboard shortcuts

Scoped to when the timeline panel is hovered/focused, suppressed while typing in an input.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| Space | play/pause | M | add marker |
| L / K / J | play / pause / (pause; no reverse yet) | I / O | set in / out |
| B / V | blade / select tool | Delete | ripple-delete (Shift = lift) |
| S / N | toggle snapping | + / − / wheel | zoom in / out |
| C | blade at playhead | Home / End | seek start / content end |
| F | maximize / restore | Shift+L | toggle loop region |
| Shift+wheel | horizontal scroll | middle-drag | pan both axes |

## Tracking takes (v0.14.0)

A special **tracking lane** (`VideoLayer.kind:'tracking'`) holds recorded LiDAR-blob **takes** instead
of video. The engine's `frame()` loop skips `kind:'tracking'` layers and `setData` skips `.lblob`
clips — replay is handled by a separate `trackingPlayback` service (the engine stays decoupled from
the tracking store). Takes are recorded from the **Takes** strip, placed as `kind:'tracking'` clips
(rendered with a `BlobSparkline` instead of a Filmstrip), and replayed into the tracking store as the
playhead crosses them. Full design in [TRACKING_TAKES.md](TRACKING_TAKES.md); takes are managed in the
[asset library](ASSETS.md).

## Verify

`npx tsc --noEmit` → `npm run build` → launch `env -u ELECTRON_RUN_AS_NODE npm run dev`, open the
**Timeline** dock tab. Drop a clip, check thumbnails, exercise blade/snap, resize/reorder tracks, add
markers, and confirm the `HH:MM:SS:FF` readout. Scope check: mute a track and confirm the projector
still shows it (engine unchanged). Save → reload to confirm new fields persist and old projects default
cleanly.

v0.12.0 checks: wheel-zoom toward the cursor (time under cursor stays put), Shift+wheel scroll,
middle-drag pan; **F** maximize and dock resize. Wave A checks: play to `Length` with **Loop off** and
confirm the playhead **stops and holds on the last frame** (no cut to black), pressing Play again
restarts from the in-point; toggle **loop** with **no** in/out region and confirm it wraps the whole
timeline on first press, then set a region and confirm it wraps that instead (projector/Scene stay in
sync); a project with content past its `Length` loads with `Length` raised to the content end. State
machine: build e.g. *Idle →(manual)→ Play →(atTime)→ Pause →(afterDelay)→ Play*, enable it, and confirm
the transport obeys the graph, the lane's current-state readout updates, the toolbar play button
reflects FSM-driven changes, and disabling reverts to manual. Confirm `onTimelineEnd` fires a
transition when the timeline ends (Loop off) and does **not** fire on a loop wrap.
