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
  geometry.ts          layout constants (+ SM_LANE_H, PAGE_SECS) + px<->sec + timecode helpers
  operations.ts        PURE clip-array ops: split, blade, rippleDelete, liftDelete, rippleTrim
  snapping.ts          PURE: collect snap points + nearest-within-threshold
  hooks/useTimelineKeys.ts  keyboard shortcuts scoped to the panel

src/renderer/services/
  timeline.ts          the playback engine (bounded clock: loops or stops at Length + per-track decode + transport intents + per-scene pools)
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
Timeline    { layers, clips, duration, fps?, markers?, inPoint?, outPoint?, loop?, stateMachine? }
```

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
