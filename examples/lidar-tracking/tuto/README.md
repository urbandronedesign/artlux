# Tutorial — LiDAR tracking in ArtLux

A hands-on, three-project course on **LiDAR blob tracking**: ArtLux's pipeline for turning a venue's
live tracked-object feed — people walking a **floor (SOL)** or **wall (MUR)** zone — into visuals you
can composite, project, **record**, and **replay**.

You'll open a ready-made project, watch it run, take it apart in the editor, and change it. The first
two projects feed off a bundled **synthetic emitter** (a tiny Node script that speaks the venue's OSC
protocol to loopback), so you need **no tracker, no LED hardware, and no network** — just Node. The
third project replays a **bundled take** and needs no scripts at all, so it animates as soon as you
open it — the transport comes up running. (There is no `.artlux` file association; **File ▸ Open…** is
the way in.)

## What is LiDAR tracking here?

The venue's tracking server streams **blobs** (one per tracked person) over **OSC/UDP** — under the
zone addresses `/SOL` (floor) and `/MUR` (wall), each blob arriving as
`/<zone>/blobs/blob<n>/{id,tx,ty,u,v}` (plus a per-zone `/<zone>/specs/Scalex,Scaley`). ArtLux binds a
UDP listener on **port 10000**, ingests those blobs into a store, and hands them to:

- a **TRACKING surface** on the 2D editor stage (un-merged blobs, ids, trails — smoothed and predicted,
  like everywhere else), and
- the **3D Scene** and **projector outputs** (smoothed and predicted everywhere; people-merged only in a
  projector-output window).

A **take** is a recording of that feed (a plain-JSON `.lblob` sidecar) that replays from a dedicated
**tracking lane** on the timeline — so a show can be authored and rehearsed with no tracker present.

```
  scripts/lidar-emitter.cjs ──OSC/udp:10000──▶ [ OSC receive ] ──▶ trackingStore
                                                                        │
                                              ┌─────────────────────────┼──────────────────────────┐
                                              ▼                         ▼                          ▼
                                     Floor (SOL) surface        3D Scene / projector output   record ▸ .lblob take
                                       (un-merged, 2D)          (smoothed; merge people in      (replay from timeline)
                                                                 the projector window only)
```

## Before you start

1. **Install Node.js** (any recent LTS) — projects 1 and 2 run the bundled emitter,
   [`scripts/lidar-emitter.cjs`](../../../scripts/lidar-emitter.cjs). Project 3 replays a bundled take
   and needs **nothing extra**.
2. **Open ArtLux** and load a project with **File ▸ Open…** (`Ctrl+O`), then pick one of the
   `.artlux` files in the set folder one level up. (These are single-file projects — use *Open…*, not
   *Open Project Folder…*. Project 3 also carries its take under `assets/tracking/` beside the
   `.artlux`, resolved relative to the file on open.)
3. **Turn on OSC receive** — once, in **Preferences ▸ OSC / Tracking** (`Ctrl+,`): **OSC receive** on,
   **Listen port** `10000`, **Bind address** **All**. This is a *machine* setting, not part of the
   `.artlux`: the projects carry no OSC config (any legacy `settings` block is **ignored on load**), so
   you set it here once and it sticks across projects.
4. **Start the feed** (projects 1–2 only), from the repo root:
   ```
   node scripts/lidar-emitter.cjs            # defaults: 127.0.0.1 10000 2 blobs
   ```
   Confirm reception in the **OSC Monitor** (**View ▸ OSC Monitor**, `Ctrl+Shift+M`) — a dock tab on the
   **3D** context: a **green** status dot (emerald once traffic arrives, amber if OSC is on but
   silent), live **msg/s**, and **SOL** + **MUR** blob cards that turn green while active. `Ctrl+C` stops
   the emitter.

> **Bind to All (loopback).** Keep **Bind address** on **All** so the emitter reaches you over
> `127.0.0.1`. Don't set a specific NIC IP on the bench — binding an address that isn't on this machine
> fails (`EADDRNOTAVAIL`) and the feed goes silent.

## The course

| # | Project | You'll learn |
|---|---------|--------------|
| 1 | **01 · Blob Viewer** — [`.artlux`](../01-blob-viewer.artlux) | the **OSC listener** (Preferences: port 10000, Bind All), a **TRACKING surface** on the SOL floor, blob **ids / `tx,ty,u,v`** coordinates, trails, and the **`id == 0` empty-slot** rule (taught from the protocol — the emitter never sends it) |
| 2 | **02 · Calibrated Projection** — [`.artlux`](../02-calibrated-projection.artlux) | fixing a **mirrored feed** with the **Calibrate overlay** (Flip H/V · Rotate — this project ships with `flipH` on), and drawing a media-free **EFFECT backdrop** *under* the blobs via `bgLayerId`; the project also ships `trackingViz` on, so the **blobs** (not the backdrop) render in the **3D Scene** as well |
| 3 | **03 · Replayed Take** — [`.artlux`](../03-replayed-take.artlux) | the **`.lblob` take** format, the timeline's **tracking lane**, folder-relative take paths and **loop** replay — all with **no emitter** — then **recording your own take** into the project folder (the one step that does need the emitter running), then **going real**: the 1-person-2-blobs field test and **Merge People** (Scene3D `trackingMergeRadius`, 0.8 m — merged *markers* appear only in a projector output window, never on the editor's 2D Stage or 3D Scene; but the merge also drives trigger-zone counting, so a zone's live headcount does reflect it in the editor) |

Work through them in order — each builds on the last. Projects 1–2 need the emitter running; project 3
does not.

## Trigger zones — making the room drive the show

The three chapters get blobs onto the floor and looking right. **Trigger zones** are the next step: the
mechanism that lets the room *drive the show*. This is the current interactive path, so it is worth a
read, and [`04-zone-driven-show.artlux`](../04-zone-driven-show.artlux) is the worked example of it
(documented in the [set README](../README.md#chapter-04--a-whole-interactive-piece-built-for-a-venue)) —
and you can build and tune the whole thing
against the emitter or the bundled take, with **no venue**.

A **trigger zone** is a named rectangle you draw on a tracking surface. You author them in the
**3D** workbench ▸ **Trigger Zones** dock tab:

![Trigger Zones dock — a drawn zone with a live headcount over the raw blob map](images/zones-panel.png)
<!-- TODO screenshot: 3D (Venue & Rig) context ▸ Trigger Zones dock tab. Left: the SOL flat map (bottom-left origin), one drawn amber zone lit "occupied" with "· 2" headcount, raw cyan blobs; right: the zone list with eye toggles + People needed + Override dwell. -->

- **draw** by dragging on empty map space; **click** a zone to select, **drag its body** to move, **drag
  a corner** to resize;
- the **eye** toggle sets whether the *current scene* listens to that zone (`Scene3D.activeZoneIds`) — a
  zone switched off for a scene is *unanswerable* there, and any rule naming it is inert in that scene;
- each zone carries **People needed** (`minBlobs`, default 1, counted *after* people-merge), and follows
  the **venue-wide dwell** unless you tick **Override dwell for this zone**.

**Zones are the room, and they persist.** They are project-scope geometry, shared by every scene and
state — you draw the entrance / stage once; a scene recall never recreates or loses them. What travels
with a scene is only *which* zones it listens to (the eye toggle).

**The dwell is tuned once, on-site,** in the **Tracking** inspector section (alongside *Smoothing* and
*Merge radius*): **Zone enter dwell** (default **0.2 s** — how long presence must last before a zone
latches *occupied*) and **Zone exit dwell** (default **0.5 s** — how long absence must last before it
clears; also the *gap tolerance* for a tracker that constantly drops blobs). Every zone follows these
unless it overrides — nudge once, the whole room retunes.

**The rules** (a transition's **LiDAR zone** trigger, edited in the Show Machine — see below) come in two
modes:

- **One zone** — *someone enters · everyone leaves · occupied for N s · empty for N s · at least N
  people.*
- **Combination** — **ALL / ANY** of several zones, each optionally **NOT** (*"someone in the entrance
  **and** nobody on the stage"* is one rule). A combination is about **occupancy**, not events: it fires
  the moment the whole expression becomes true.

Every rule is *armed once*: it will not re-fire while the visitor who tripped it is still standing there,
and it **holds** so a rule that came true *during* a still-playing state fires the instant that state's
guard opens (**hold at end** / **only after the state has finished**). Pair a zone with those and you get
the canonical installation state: *play the look, freeze on the last frame, advance when someone walks
in.*

Because zones read the same `trackingStore` that live OSC and take replay fill, you tune them with the
**emitter** (a synthetic live feed) or a **replayed take** and watch the rectangle light up in the panel
and in 3D. **Wiring a zone to a transition** is in
[`docs/STATE-MACHINE.md`](../../../docs/STATE-MACHINE.md); the on-site dwell/merge tuning and the
predictive **Merge People** tracker are in [`docs/TRACKING_SYNC.md`](../../../docs/TRACKING_SYNC.md).
Chapter 03 walks a hands-on pass.

## Where to go deeper

- **Reference:** [`docs/TRACKING_TAKES.md`](../../../docs/TRACKING_TAKES.md) — the take format,
  record/replay architecture, and the tracking lane.
- **Related:** [`docs/OSC.md`](../../../docs/OSC.md) (the tracking + control wire protocol and setup),
  [`docs/TRACKING_SYNC.md`](../../../docs/TRACKING_SYNC.md) (on-site sync, the 1-person-2-blobs test, and
  the **trigger-zone** dwell/rules reference),
  [`docs/STATE-MACHINE.md`](../../../docs/STATE-MACHINE.md) (wiring a zone to a state transition),
  [`docs/SURFACES.md`](../../../docs/SURFACES.md) (the TRACKING surface),
  [`docs/EFFECTS.md`](../../../docs/EFFECTS.md) (the backdrop effects & palettes),
  [`docs/TIMELINE.md`](../../../docs/TIMELINE.md).

> **Tip — keep your edits.** These templates are a sandbox. To keep changes, **File ▸ Save As…** to a
> new file so the originals stay pristine for the next read-through.
