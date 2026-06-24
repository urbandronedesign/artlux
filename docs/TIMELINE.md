# Timeline (NLE) — architecture & usage

The **video-layer timeline** is a DaVinci Resolve-style non-linear editor for placing video clips
on tracks (layers) over time. A track is an addressable output channel: surfaces and 3D planes bind
to a track's `layerId` and show whatever clip is under the playhead. Shipped as a basic editor in
v0.4.0 and reworked into a full NLE in **v0.11.0**.

> **Scope invariant:** the timeline rework is **editing-UX only**. The playback/compositing engine
> (`src/renderer/services/timeline.ts`) is unchanged — it still shows the **topmost clip per track**.
> The track header flags below are visual aids, not engine inputs.

## Where it lives

```
src/renderer/components/timeline/
  Timeline.tsx        container: ephemeral UI state, layout, wiring (the only stateful component)
  TimelineToolbar.tsx  transport, tool mode, snap toggle, marker, zoom, fps, length, add track
  TimelineRuler.tsx    HH:MM:SS:FF ticks, markers, in/out band, click-to-seek
  TrackHeader.tsx      name, M/S/L, show-hide, color, reorder grip, height-resize (React.memo)
  Lane.tsx             one track's clip lane: drop target, hosts ClipBlocks
  ClipBlock.tsx        one clip: move/trim/blade hit zones, hosts the Filmstrip (React.memo)
  Filmstrip.tsx        imperative <canvas> of thumbnails; decoupled from React render
  geometry.ts          layout constants + px<->sec + timecode + tick-density helpers
  operations.ts        PURE clip-array ops: split, blade, rippleDelete, liftDelete, rippleTrim
  snapping.ts          PURE: collect snap points + nearest-within-threshold
  hooks/useTimelineKeys.ts  keyboard shortcuts scoped to the panel

src/renderer/services/
  timeline.ts          the playback engine (clock + per-track decode) — DO NOT change for edit features
  thumbnailCache.ts    async LRU thumbnail extraction, isolated from playback
  hapDecode.ts         + decodeFrameRaw(): one-shot HAP decode that bypasses the playback ring
```

State lives in `App.tsx` (`timeline: Timeline`) and persists to `ProjectData.timeline`.

## Data model (`src/renderer/types.ts`)

```ts
VideoLayer { id, name, height?, color?, muted?, solo?, locked?, enabled? }   // flags are UX-only
VideoClip  { id, layerId, name, path, start, duration, inPoint, sourceDuration?, color? }
Marker     { id, time, color, note? }
Timeline   { layers, clips, duration, fps?, markers?, inPoint?, outPoint? }
```

- `VideoClip.inPoint` is the **source trim** (offset into the file). `Timeline.inPoint/outPoint` is a
  separate **timeline range** (export/loop region) — they do not change playback.
- All new fields are optional and back-compatible. `normalizeTimeline()` defaults old projects on
  load (called in `App.tsx`'s loader); save/broadcast already carry the whole object.

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
- **Range:** **I/O** set the timeline in/out points (shown as a band on the ruler).

### Keyboard shortcuts

Scoped to when the timeline panel is hovered/focused, suppressed while typing in an input.

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| Space | play/pause | M | add marker |
| L / K / J | play / pause / (pause; no reverse yet) | I / O | set in / out |
| B / V | blade / select tool | Delete | ripple-delete (Shift = lift) |
| S / N | toggle snapping | + / − | zoom in / out |
| C | blade at playhead | Home / End | seek start / end |

## Verify

`npx tsc --noEmit` → `npm run build` → launch `env -u ELECTRON_RUN_AS_NODE npm run dev`, open the
**Timeline** dock tab. Drop a clip, check thumbnails, exercise blade/snap, resize/reorder tracks, add
markers, and confirm the `HH:MM:SS:FF` readout. Scope check: mute a track and confirm the projector
still shows it (engine unchanged). Save → reload to confirm new fields persist and old projects default
cleanly.
