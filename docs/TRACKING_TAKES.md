# Tracking takes — record & replay LiDAR blobs (architecture & usage)

A **take** is a recording of the live LiDAR blob feed (the 61 fps OSC tracking stream — see
[OSC.md](OSC.md)) that can be **replayed** later from the timeline, so a show can be authored,
rehearsed and run **with no tracker present**. Shipped in **v0.14.0**. Takes are first-class media in
the [asset library](ASSETS.md) and play back from a dedicated **tracking lane** on the
[timeline](TIMELINE.md).

> **Scope invariant:** replay must look identical to the live feed. A take captures exactly what
> `trackingStore.snapshot()` produces each frame, and replay re-injects those snapshots through the
> same store and bridge — so the 3D Scene's One-Euro smoothing/prediction treats replayed data like
> live data. The timeline **engine never couples to the tracking store**: replay lives in a separate
> service that subscribes to the engine playhead.

## How it works

```
record:   trackingStore.subscribe ─► trackingRecorder (wall-clock frames) ─► .lblob sidecar + AssetEntry/take ref
replay:   engine.subscribe(playhead) ─► trackingPlayback ─► trackingStore.applySnapshot ─► (App pump) ─► Scene/projectors
```

- **Capture is independent of the transport.** Recording taps `trackingStore.subscribe` (already
  coalesced to one notification per animation frame) and pushes a `{ t, snap }` frame per tick,
  stamped with wall-clock elapsed. You record a performance, then place the take on the timeline.
- **Replay is driven by the playhead.** `trackingPlayback` subscribes to the engine and, when the
  playhead is over a `kind:'tracking'` clip, looks up the frame at `local = playhead − clip.start +
  clip.inPoint` (binary search) and calls `trackingStore.applySnapshot`. Because `applySnapshot`
  marks the store dirty, **App.tsx's existing snapshot pump** forwards it to the Scene and
  tracking-projector windows — no new bridge wiring. Scrubbing while paused works because the engine
  notifies subscribers every frame.
- **Global simulation override.** While a take drives the store, `trackingStore.setReplaySource(true)`
  makes `ingest()` swallow live OSC blob/spec messages (it still returns `true` so the OSC router
  stops there — control messages are unaffected). Past the clip, playback clears the blobs
  (`applySnapshot({surfaces:[]})`) and calls `setReplaySource(false)` so the live tracker resumes.

<!-- audience:contributor -->

## Where it lives

```
plugins/lidar-tracking/src/
  trackingTake.ts      take format (.lblob), serialize/parse, frameAt (binary search), density, load cache
  trackingRecorder.ts  taps trackingStore.subscribe; start/stop/isRecording/getElapsed; builds a take
  trackingPlayback.ts  subscribes to engine playhead; injects frames; sets/clears the replay override
  trackingStore.ts     +setReplaySource/isReplaySource + the ingest() gate (live OSC suppression)
src/renderer/services/
  takeRecorder.ts      THE ONE OWNER of the commit: naming, the .lblob write, the copy-in, the doc-key
                       guard across both awaits, the replay cache seed, the ref append + the auto-lane
src/renderer/contexts/panels/takes.tsx
  TrackingTakesDock    record/cancel/lane + the take library (rename, sparkline, drag out)
src/renderer/components/timeline/
  BlobSparkline.tsx    blob-density signature — drawn on the clip AND on the take row
  Timeline.tsx         take→clip drop (placement only; recording left the timeline)
src/renderer/services/timeline.ts   frame loop skips kind:'tracking' layers; setData skips .lblob clips
```

The recorder is a UI-agnostic singleton and the commit is a host service, so the record button is not
tied to any one surface: the dock panel, the Venue & Rig action bar, the status-bar REC chip and the
global shortcut all call the same `takeRecorder.toggleTracking()`. That is what let the control leave
the timeline — the drawer was never the reason it lived there, the commit logic was.

### The `.lblob` take format
A take is a compact JSON sidecar:
```ts
interface TrackingTake {
  version: 1; id: string; name: string;
  duration: number;            // seconds (t of the last frame)
  fps?: number;                // nominal capture rate
  frames: { t: number; snap: TrackingSnapshot }[];  // monotonic by t (step lookup; no tween)
  density?: number[];          // per-bin active-blob count, for the clip sparkline
}
```
`frameAt(take, local)` returns the last frame whose `t ≤ local` (blob updates are discrete events,
so there's no interpolation). Files are written via the `SAVE_TRACKING_TAKE` IPC to
`userData/tracking-takes/<id>.lblob`, then **copied into the project's `assets/tracking/`** on record
stop (copy-in policy — see [ASSETS.md](ASSETS.md)). They are loaded lazily and cached by path.

### Data model
- The take **library** lives in `Timeline.trackingTakes: TrackingTakeRef[]` (`{ id, name, path,
  duration, fps }`). A placed take is an ordinary `VideoClip` with `kind:'tracking'`, `takeId` = the
  ref id, and `path` = the `.lblob`. The asset library (ASSETS.md) **aggregates** these for display;
  takes are **not** migrated into `ProjectData.assets` — the timeline remains their owner.
- `mapAssetPaths` (main/`projectFolder.ts`) already visits `trackingTakes[].path` and tracking clip
  paths, so save/relativize/resolve/Collect-Assets all handle takes.

<!-- audience:operator -->

## Usage

1. **Record.** Capture is independent of Play/Pause — the playhead can be stopped, and usually is. Any
   of three doors, all the same recorder:
   - the **Tracking Takes** dock panel (in **Venue & Rig** and on the **Show** deck) — press **● Record**,
     press **■** to stop, or **✕ Cancel** to throw the capture away;
   - **Record Tracking Take** on the Venue & Rig action bar, which shows REC and an elapsed clock;
   - **Ctrl+Alt+R**, which works in *every* workspace — Calibration and Preferences included, where
     there is no timeline drawer at all.

   While anything is recording, the **status bar** carries a REC light naming what is being captured
   and **which document it will land in** (`REC tracking → Act 2`); clicking it stops. On stop the take
   is written to disk, copied into the project, and a **Tracking** lane is created if there is none.
   Recording is refused while a take is already playing under the playhead (you would be recording
   replayed data) — the refusal says so in a toast.
2. **Place.** Drag a take out of the **Tracking Takes** panel (or the **Media** library) onto the
   tracking lane. It becomes a clip with a green blob-density sparkline — the same signature the take
   row carries — and moves/trims like any clip. Click a take's name to rename it.
3. **Replay.** With the tracker disconnected, press **Play** (or scrub) — the recorded blobs drive
   the 3D Scene and any TRACKING projector outputs. Past the clip's end the blobs clear.
4. **Mixing with a live tracker.** While a take plays, the live feed is globally suppressed; it
   resumes automatically when no take is under the playhead.

<!-- audience:contributor -->

## Verify

`npx tsc --noEmit` → `npm run build` → launch `env -u ELECTRON_RUN_AS_NODE npm run dev`.
With an OSC blob sender feeding port `10000` (or the real tracker), record ~10 s from the **Tracking
Takes** dock (and once more with **Ctrl+Alt+R** from **Preferences**, which is the reachability the
move exists for), stop, confirm a `.lblob` lands in `assets/tracking/` and the take row shows a
sparkline. Also confirm the doc-key guard: stop a recording bound to one scene and recall another
*while the file is being written* — nothing may be written into the scene you did not record into.
Drop the take on the tracking lane;
**disconnect the sender** and confirm Play/scrub replays the blobs in the Scene and projector; past
the clip the blobs clear and (reconnecting the sender) live resumes. Save → reload and confirm the
take + clip restore.
