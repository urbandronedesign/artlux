# Tutorial — LiDAR tracking in ArtLux

A hands-on, three-project course on **LiDAR blob tracking**: ArtLux's pipeline for turning a venue's
live tracked-object feed — people walking a **floor (SOL)** or **wall (MUR)** zone — into visuals you
can composite, project, **record**, and **replay**.

You'll open a ready-made project, watch it run, take it apart in the editor, and change it. The first
two projects feed off a bundled **synthetic emitter** (a tiny Node script that speaks the venue's OSC
protocol to loopback), so you need **no tracker, no LED hardware, and no network** — just Node. The
third project replays a **bundled take** and needs no scripts at all, so it opens and animates the
moment you double-click it.

## What is LiDAR tracking here?

The venue's tracking server streams **blobs** (one per tracked person) over **OSC/UDP** — under the
zone addresses `/SOL` (floor) and `/MUR` (wall), each blob arriving as
`/<zone>/blobs/blob<n>/{id,tx,ty,u,v}` (plus a per-zone `/<zone>/specs/Scalex,Scaley`). ArtLux binds a
UDP listener on **port 10000**, ingests those blobs into a store, and hands them to:

- a **TRACKING surface** on the 2D editor stage (raw blobs, ids, trails), and
- the **3D Scene** and **projector outputs** (smoothed, predicted, optionally people-merged).

A **take** is a recording of that feed (a plain-JSON `.lblob` sidecar) that replays from a dedicated
**tracking lane** on the timeline — so a show can be authored and rehearsed with no tracker present.

```
  scripts/lidar-emitter.cjs ──OSC/udp:10000──▶ [ OSC receive ] ──▶ trackingStore
                                                                        │
                                              ┌─────────────────────────┼──────────────────────────┐
                                              ▼                         ▼                          ▼
                                     Floor (SOL) surface           3D Scene / projectors      record ▸ .lblob take
                                       (raw blobs, 2D)            (smoothed · merge people)     (replay from timeline)
```

## Before you start

1. **Install Node.js** (any recent LTS) — projects 1 and 2 run the bundled emitter,
   [`scripts/lidar-emitter.cjs`](../../../scripts/lidar-emitter.cjs). Project 3 replays a bundled take
   and needs **nothing extra**.
2. **Open ArtLux** and load a project with **File ▸ Open…** (`Ctrl+O`), then pick one of the
   `.artlux` files in the set folder one level up. (These are single-file projects — use *Open…*, not
   *Open Project Folder…*. Project 3 also carries its take under `assets/tracking/` beside the
   `.artlux`, resolved relative to the file on open.)
3. **Start the feed** (projects 1–2 only), from the repo root:
   ```
   node scripts/lidar-emitter.cjs            # defaults: 127.0.0.1 10000 2 blobs
   ```
   Confirm reception in **View ▸ OSC Monitor** (`Ctrl+Shift+M`): a **green** status dot (emerald once
   traffic arrives, amber if OSC is on but silent), live **msg/s**, and **SOL** + **MUR** blob cards
   that turn green while active. `Ctrl+C` stops the emitter.

> **Loopback only.** Every project here listens on `oscListenAddress: ""` (all interfaces) so the
> emitter reaches it over `127.0.0.1`. Don't set a specific NIC IP — binding an address that isn't on
> this machine fails (`EADDRNOTAVAIL`) and the feed goes silent.

## The course

| # | Project | You'll learn |
|---|---------|--------------|
| 1 | **01 · Blob Viewer** — [`.artlux`](../01-blob-viewer.artlux) | the **OSC listener** (port 10000, all interfaces), a **TRACKING surface** on the SOL floor, blob **ids / `tx,ty,u,v`** coordinates, trails, and the **`id == 0` empty-slot** rule (taught from the protocol — the emitter never sends it) |
| 2 | **02 · Calibrated Projection** — [`.artlux`](../02-calibrated-projection.artlux) | fixing a **mirrored feed** with the **Calibrate overlay** (Flip H/V · Rotate — this project ships with `flipH` on), and drawing a media-free **EFFECT backdrop** *under* the blobs via `bgLayerId`, previewed in the **3D Scene** (`trackingViz`) |
| 3 | **03 · Replayed Take** — [`.artlux`](../03-replayed-take.artlux) | the **`.lblob` take** format, the timeline's **tracking lane**, folder-relative take paths, **loop** replay, **recording your own take** into the project folder — then **going real**: the 1-person-2-blobs field test and **Merge People** (Scene3D `trackingMergeRadius`, 0.8 m, in the 3D / projector output, never the raw 2D stage) — all with **no emitter** |

Work through them in order — each builds on the last. Projects 1–2 need the emitter running; project 3
does not.

## Where to go deeper

- **Reference:** [`docs/TRACKING_TAKES.md`](../../../docs/TRACKING_TAKES.md) — the take format,
  record/replay architecture, and the tracking lane.
- **Related:** [`docs/OSC.md`](../../../docs/OSC.md) (the tracking + control wire protocol and setup),
  [`docs/TRACKING_SYNC.md`](../../../docs/TRACKING_SYNC.md) (on-site sync, the 1-person-2-blobs test),
  [`docs/SURFACES.md`](../../../docs/SURFACES.md) (the TRACKING surface),
  [`docs/EFFECTS.md`](../../../docs/EFFECTS.md) (the backdrop effects & palettes),
  [`docs/TIMELINE.md`](../../../docs/TIMELINE.md).

> **Tip — keep your edits.** These templates are a sandbox. To keep changes, **File ▸ Save As…** to a
> new file so the originals stay pristine for the next read-through.
