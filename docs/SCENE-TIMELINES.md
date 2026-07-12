# Per-scene timelines & the per-state authoring loop

Each **Scene** may own its own **Timeline** (its own tracks/clips/markers/playhead), so a show can
be authored as a sequence of decoupled *states* — trigger a state, build its timeline, save, move to
the next. Recalling a scene **warm-swaps** the playback engine to that scene's timeline; scenes
without one fall back to the shared global `ProjectData.timeline` (so existing projects need **zero
migration**). Shipped after v0.19.2 — commit `c85483e`.

> Read [TIMELINE.md](TIMELINE.md) (the NLE engine) and [SCENES.md](SCENES.md) (look snapshots) first —
> this doc is the seam between them. The timeline *engine* and *editor* are unchanged in shape; what's
> new is **which** timeline they're bound to and how the engine holds more than one.

## The model in one breath

- A `Scene` optionally carries `timeline?: Timeline` (+ a stable `accent?` identity colour).
- The **editor** is always bound to exactly one timeline — the **current scene's** own timeline, or
  the shared global one. `App` tracks this as `activeSceneId` (`null` = global).
- The **engine** plays exactly one timeline at a time — its **active pool** (see below). Recall keeps
  `activeSceneId` and the engine's active pool in **lockstep**, so the thing you edit is the thing that
  plays, everywhere (main window + projector windows + broadcast).

### Invariant: one transport, two playheads

There is only ever **one running transport** — one `playing` flag, one `requestAnimationFrame` loop, one
set of decoding `<video>`s, one set of acquired live sources. We never composite or run two timelines.
Even the recall crossfade uses a single transport (the incoming timeline plays; the outgoing is a
*frozen last frame* that fades out via the existing look fade). Everything else is idle or a cheap warm
standby. This invariant is what makes the whole resource model tractable — everything below follows
from it.

What that one transport carries is **two derived times** (Wave B):

| | `playhead` — the SCENE clock | `showTime` — the SHOW clock |
|---|---|---|
| drives | the BOUND timeline's video, its own `Timeline.audio`, its automation lanes, the state machine | the global audio bed (`ProjectData.audio`) and the GLOBAL timeline's automation (the base layer) |
| bounded by | the BOUND doc's `[timelineStart, timelineEnd)` | the GLOBAL doc's `[timelineStart, timelineEnd)` |
| on a scene recall | **RESETS** to the scene's in-point | **NEVER RESETS** — the bed plays on |
| on exit to Global | **RECONVERGES**: `playhead := showTime` | unchanged |
| on a seek | always moves | only while **Global is bound** (the pill) — i.e. only while the two clocks are the **same number** |
| anchor | `originMs` | `showOriginMs` |

**While Global is bound (the pill) the two are the same number** — an identity the engine maintains inside
`seek()` by testing `clocksCoincident()` (`activeKey === GLOBAL_POOL`). They diverge the moment **any** scene
is bound: **the scene restarts, the bed rolls on.** This does not break the one-transport rule — there is
still exactly one `playing`, one rAF, one `<video>` pool. A second *time value* rides the same clock.

> ⚠ **TWO PREDICATES. DO NOT SWAP THEM.**
> - `isGlobalDocBound()` = `activeKey === GLOBAL_POOL || data === globalDoc` — **which DOCUMENT is bound.**
>   A scene with **no timeline of its own** binds the GLOBAL document under its own pool key
>   (`handleRecallScene`), and the lanes in `data.automation` there *are* the base layer — so they ride the
>   **show clock**. That is `compileAutomation`'s question, and this is the right answer to it.
> - `clocksCoincident()` = `activeKey === GLOBAL_POOL` — **are the two clocks EQUAL.** That is `seek()`'s
>   question. Under a timeline-less scene the document is bound but the clocks are **minutes apart**
>   (`transport:'restart'` reset the playhead; `showClock:'preserve'` left the bed running), so a seek that
>   tracked the *document* would drag `showTime` to a scene-relative number and **hard-restart the bed on
>   every entry to that state** — the exact bug the show clock exists to prevent, through the seek door.
>
> `isGlobalDocBound()` says which clock a **lane** rides. It has never asserted that the clocks are equal.

**The show clock is silent.** It never emits a `TransportIntent` and never pulses `hitEnd`: the bed
wrapping is not a show event, and firing `onTimelineEnd` from it would advance the state machine behind
the operator's back. It only wraps (global loop on) or parks (global loop off) — and the park is
*published*, not inferred: `getStatus().showEnded`.

Full reset table (every transport event × both clocks): **[TIMELINE.md → The show clock](TIMELINE.md#the-show-clock-wave-b--one-transport-two-playheads)**.

## Data model (`src/renderer/types.ts`)

```ts
Scene {
  …look fields (surfaces, fixtures, globalBrightness, groups, scene3D, projectorOutputs)…
  timeline?: Timeline;   // per-state timeline; absent → uses the shared global timeline
  accent?: string;       // stable identity colour (node/pill/border/strip/cell) — see sceneAccent.ts
}
```

- **Additive, zero migration.** `Timeline` itself is unchanged and carries **no id** — pools are keyed
  by `scene.id` (sentinel `'__global__'` for the shared fallback). A scene without `timeline` behaves
  exactly as before. `applyProjectData` normalizes each loaded `scene.timeline` with
  `normalizeTimeline()` and assigns an accent to scenes that lack one.
- **Persistence is free.** `scenes` already rides in `buildProjectData`/`applyProjectData` /
  `ProjectData.scenes`; a scene's `timeline` saves with it. No `ProjectData` shape change.
- **`buildSceneSnapshot` is look-only.** It deliberately does **not** include `timeline`, so
  "Update Scene" (re-capture look) never clobbers a scene's own timeline. Fresh captures
  (`handleCaptureScene`) add `timeline: structuredClone(activeTimeline)` explicitly; a new state
  (`handleCreateState`) starts with an **empty** `defaultTimeline()`.

## Current-scene binding (the editor ↔ engine lockstep)

`App` derives the bound document each render:

```ts
const activeScene   = activeSceneId ? scenes.find(s => s.id === activeSceneId) : null;
const activeTimeline = activeScene?.timeline ?? timeline;   // scene's own, else the shared global
```

- **Every recall makes the scene current.** `handleRecallScene(scene)` commits the look, then
  `setActiveSceneId(scene.id)` and swaps the engine keyed by **`scene.id`** — *even when the scene has
  no timeline yet* (its pool plays global content). Because the pool key always equals
  `activeSceneId ?? GLOBAL_POOL`, the engine-feed effect's guard
  (`engine.activePoolKey() === (activeSceneId ?? GLOBAL_POOL)`) is satisfied and edits preview live.
- **On load, the editor binds to a real scene** — the initial-state scene
  (`stateMachine.initialStateId`'s `sceneId`), else the first scene. So "just editing the timeline"
  attaches to a scene instead of silently landing on Global. No scenes → stays on the global timeline.
- **Edits write back to the owner.** `handleTimelineChange(next)` → `setScenes(… s.timeline = next)`
  when a scene is current, else `setTimeline(next)`. A scene that was falling back to global is
  **materialized on first edit** (seeded from what was shown).
- **Follows GO.** Manual GO, cueBus, OSC, and the state machine all funnel through `handleRecallScene`,
  so triggering a scene also rebinds the editor to it. During a live show the editor simply follows the
  active state; you don't author during a show, so this never fights an edit.

## Engine: pool-keyed layer buffers (`src/renderer/services/timeline.ts`)

The single `layerVideos` map became **per-pool**:

```ts
const pools = new Map<string /*poolKey*/, Map<string /*layerId*/, LayerVid>>();
let activeKey = GLOBAL_POOL;
let layerVideos = pools.get(activeKey);   // frame()/syncLayer/drawable readers are UNCHANGED
```

Exactly one pool is **ACTIVE**; `layerVideos` points at it, so the frame loop, `syncLayer`,
`buildProgram`, and `getLayerDrawable` need no changes — a warm-swap just repoints `layerVideos`.

New API on the exported `timeline`:

| Method | Purpose |
|---|---|
| `warmPool(poolKey, tl)` | Pre-warm a scene's timeline into a **standby** pool: shared media by path + a paused `<video>` per layer **pre-rolled to the timeline's first frame** (`readyState ≥ 2` before the swap → no black/partial first frame). |
| `swap(poolKey, tl, {transport, showClock, holdMs})` | Promote a pool to ACTIVE. Pauses the outgoing pool (kept warm), releases orphaned live sources, prunes stale layers, and by default **restarts at the first frame** (`transport:'restart'` → `seek(tl.inPoint ?? 0)`). `transport:'reconverge'` instead snaps the playhead **onto the show clock** (used when returning to Global — see below); it replaced the old `'preserve'`. `showClock` defaults to **`'preserve'`** (the bed rolls on); only project open passes `'reset'`. Cold fallback re-warms inline if the pool wasn't pre-warmed. |
| `releasePool(poolKey)` | Demote a standby pool to COLD — tears down its `<video>`s + codec/content it uniquely holds. Never drops the ACTIVE pool or `GLOBAL_POOL`. |
| `warmPoolKeys()` / `activePoolKey()` | Introspection for the preloader's LRU budget + the App guard. |

`setData` is unchanged in contract (feed the active timeline; used on load, edits, and the projector
bridge) — its media-warm/prune body was factored into `warmMedia`/`pruneStaleLayers`, reused by
`warmPool`/`swap`. Projector/mirror windows run the engine in `external` mode where `setData`/`swap`
are near-no-ops (they consume streamed frames), so per-scene pools are a **main-window** concern.

### Clean first-frame start on every trigger

`swap(..., 'restart')` seeks to `inPoint ?? 0` and the WARM pool was pre-rolled to that exact frame, so
**every** trigger — manual GO, cueBus, FSM entry (including *re-entry* of the same state), author-mode
Next — starts the state identically. State entry is **idempotent and repeatable**, which matters for a
show where the machine re-enters a state many times.

**The bed does not restart with it.** A recall resets the *playhead* only; `showTime` is untouched
(`swap`'s default `showClock:'preserve'`), so the global audio bed and the global timeline's automation
play straight through the GO. That is the single defining requirement of Wave B.

### Leaving a scene RECONVERGES the picture onto the bed

Clicking the pill back to **Global** (and deleting the bound scene) swaps with `transport:'reconverge'`:
the playhead **snaps to `showTime`**, so the picture rejoins the bed that never stopped, instead of
restarting the global timeline from its in-point under a bed that is four minutes in. It does not pause
(the old `'preserve'` path ran `clampPlayheadIntoDoc`, which emitted a `pause` intent → the transport
stopped and the bed with it).

One exception, and it is deliberate: if the show clock is **parked** at the global end (global Loop off,
the show ran out), reconverge lands on the last frame and re-applies the end latch — `endLatched = true`
plus a `pause` intent, **without pulsing `hitEnd`**. The show genuinely is over; the machine must not be
advanced by a mouse click (invariant: a document swap never pulses `hitEnd`).

## Preloader & tiered residency (`src/renderer/services/timelinePreloader.ts`)

Because only the active timeline plays, every other state should hold as few live resources as
possible. The preloader keeps a small **sliding window of warmth** that follows the show's path:

| Tier | Count | Decoder | Live sources (NDI/cam/Spout/DMX) | Blobs |
|---|---|---|---|---|
| **ACTIVE** | exactly 1 | playing | acquired | resident |
| **WARM** (standby) | ≤ `MAX_WARM` (≈2) | paused, pre-seeked (~0 CPU) | **not** connected | resident |
| **COLD** | the rest | none (torn down) | none | evictable |

- `warm(poolKey, tl)` warms one scene and trims to budget; `predict(entries)` warms a set;
  `evictExcess(protect)` demotes least-recently-used standby pools past `MAX_WARM` (never the active /
  global / protected keys).
- **FSM look-ahead:** an `App` effect subscribes to state changes and `predict()`s the timelines of all
  **reachable-next** states, so a transition into any likely-next state is hitless. The **Scenes/Cues**
  panel warms a scene on hover.
- **Key fact:** `mediaCache` blob URLs and codec `preWarm` are **path-keyed and globally shared**, so
  warming shared media across states costs ~nothing — only the per-layer `<video>` pool is per-scene.
  Warming is async IPC + `createObjectURL` + decode-init — all **off the rAF/compute path**, so the
  frame loop is never blocked.
- **Only ACTIVE holds live receivers** (NDI/camera/Spout/DMX) — on swap the outgoing state's receivers
  are released, so we never hold N network streams at once. Steady-state decode/GPU/network load equals
  a single-timeline app regardless of how many states exist.

## "Play everywhere" (projector + broadcast)

- **Projector windows** receive the timeline over the existing MessagePort bridge
  (`{t:'timeline', timeline}` → `ProjectorApp` → `engine.setData`). Recall posts the swapped scene's
  timeline to every port, and the projector-connect/refresh push (`pushProjectorState`) posts
  **`activeTimeline`** (dep-tracked) — so a projector connecting or reconfiguring shows the current
  scene, not global.
- **Broadcast window** (`--broadcast`, a hidden main-mode window) runs its own `App`, loads the
  project, and ticks the state machine (`!external`). FSM `enter()` → `cueBus.requestRecall` →
  `recallByRefRef` → `handleRecallScene` → `swapTimelineForScene`, and the resolved scene carries its
  own `timeline` — so the show plays each state's own timeline in broadcast too.

## UX (mistake-proof authoring)

The design goal: the user always knows **which** timeline they're editing, and a new state gives a
fresh timeline to fill.

- **Scene/state pill** (`components/timeline/Timeline.tsx`, top-left of the panel): always-visible
  `◆ Editing: [ <scene> ▾ ]` with the scene's accent; the dropdown lists **Global timeline** + every
  scene (accent swatch + a Film icon if it owns a timeline, else an `↩ global` hint) + **＋ New state…**.
  The whole panel gets an accent top-border while a scene is current.
- **Author strip** (only while authoring a scene): `◂ Prev · State N of M · Save · Next ▸` — the
  trigger→build→save→continue loop. *Save* re-captures look tweaks; the timeline is already stored via
  `onChange`.
- **Empty-timeline CTA:** a fresh state's timeline shows a friendly drop target ("…is empty · drag
  media here · ＋ Track"), never a blank/broken lane.
- **Identity everywhere:** one accent per state across the graph node, pill, panel border, author strip,
  and Scenes/Cues cell — so the eye tracks one thing.
- **State-graph editor:** each node shows its timeline **build status** (`N clips` / `empty` / `↩ global`)
  and an **Edit timeline** action that enters author mode on that state.
- **Scenes/Cues panel:** each scene cell gets an **Edit** (film) action beside **GO**, an accent dot,
  and **hover-preloads** the scene's media.

## Key design decisions (read before extending)

- **Recall is an imperative warm-swap, not a React-state write.** Setting App's `timeline` state to a
  scene's timeline would route through the `setData` effect and pay a **cold rewarm**, defeating the
  preloader. Recall calls `engine.swap(...)` directly; React state only follows to keep the UI in sync.
- **The engine-feed effect is guarded.** It feeds the engine only when
  `engine.activePoolKey() === (activeSceneId ?? GLOBAL_POOL)`. This prevents a live GO on one scene from
  being clobbered by edits bound elsewhere. Because every recall keys the pool by `scene.id`, the guard
  normally passes — the guard is the safety net for the transient/divergent cases.
- **Pool key = `scene.id` even for a timeless scene.** This is what keeps editor and engine in lockstep
  and lets first-edit materialization "just work" without a second swap.
- **Snapshots stay look-only.** Timeline lives on the scene via `onChange`; keeping it out of
  `buildSceneSnapshot` is what stops "Update Scene" from overwriting it.
- **Core stays core.** Persisted types/enums used app-wide are untouched; only *behaviour* moved. A
  scene's `timeline` is plain data, so there is zero project-file migration.
- **Out of scope (intentional):** a full dual-transport cross-timeline **dissolve** (both timelines
  rendering at once) — recall fades a frozen outgoing frame into the playing incoming one, honouring the
  one-transport invariant.

## Testing

`node scripts/test-scene-timelines.cjs` — a CDP harness (launches dev with `ARTLUX_CDP_PORT`, seeds a
crafted 2-scene project into the OS temp dir, drives the real renderer). It asserts, 10/10: load binds
to the initial-state scene (not Global); a scene with no own timeline falls back to global; each scene
renders its own timeline; editing a scene attaches to it and **does not leak** into the global timeline;
the editor **follows GO**. Extend this harness for future timeline-UI tests. (Reuses the launch/connect
plumbing from `scripts/capture-docs.cjs`.)

## Verify (manual)

`npx tsc --noEmit` → `npm run build` → launch `env -u ELECTRON_RUN_AS_NODE npm run dev`.

1. Open a project with scenes. Without touching the pill, drag a clip onto the Timeline → the pill shows
   the current scene and the clip is stored on it (GO it later → it plays; reload → still there).
2. GO another scene → the editor rebinds (pill + accent) and shows that scene's timeline.
3. Open a projector output; GO between two scenes with different timelines → the projector shows each
   scene's own timeline; connect a projector while a scene is current → it shows that scene's timeline.
4. Give a scene a distinct timeline, then press **Update Scene** (↻) → its timeline is preserved.
5. **60 fps warm-swap (still to be measured):** open **PerfHud** and fire GO between two video-heavy
   scenes — with the preloader the swap should not spike frame time; A/B against a cold swap.
