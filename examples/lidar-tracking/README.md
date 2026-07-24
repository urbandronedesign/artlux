# LiDAR tracking example projects

Three ready-to-open `.artlux` projects that teach **LiDAR blob tracking** — ingesting tracked-object
("blob") positions over [OSC](../../docs/OSC.md) and mapping them onto a floor zone — paired with a
hands-on written tutorial in [`tuto/`](tuto/README.md).

**Portable — "artlux + script", no hardware.** There is no real tracker and no LED rig anywhere in this
set. The two live chapters are fed by a companion **emitter script** already in the repo
([`scripts/lidar-emitter.cjs`](../../scripts/lidar-emitter.cjs)) that speaks the venue's OSC protocol to
`127.0.0.1:10000` (loopback) — start it, and synthetic blobs drift across the floor. The third chapter
is **script-free**: it replays a **bundled take** ([`demo.lblob`](assets/tracking/demo.lblob)) straight
off the timeline, so it needs nothing running at all. As with every example set, ArtNet output is aimed
at `127.0.0.1`, so opening a project transmits nothing to real fixtures until you repoint it.

| Project | What it demonstrates | Runs on open? |
|---|---|---|
| [`01-blob-viewer.artlux`](01-blob-viewer.artlux) | the `TRACKING` content source, the **SOL** floor zone, OSC receive on port `10000`, live blobs + IDs + trails on the 2D stage | **With the emitter** — start `lidar-emitter.cjs`, then blobs appear |
| [`02-calibrated-projection.artlux`](02-calibrated-projection.artlux) | a media-free **EFFECT backdrop** drawn *under* the blobs (`bgLayerId`), a **calibration** overlay + horizontal **flip**, and the **3D Scene tracking visualization** (`trackingViz`) | **With the emitter** — backdrop draws on open; blobs on the wire |
| [`03-replayed-take.artlux`](03-replayed-take.artlux) | replaying a recorded **take** from the tracking lane — a whole show authored & rehearsed **with no tracker present** | **Yes, no script** — press **Play**; the bundled take loops |

## The companion emitter

Chapters 01 and 02 read a live OSC feed. Rather than a real LiDAR server, this set drives them with the
repo's synthetic emitter. From the **ArtLux repo root**:

```
node scripts/lidar-emitter.cjs            # 127.0.0.1  10000  2 blobs/surface (SOL + MUR)
```

It sends `SOL` and `MUR` zone specs plus a couple of orbiting blobs at ~61 fps to UDP `10000`
(`Ctrl+C` to stop). Watch them arrive in the **OSC Monitor** (**View ▸ OSC Monitor**, `Ctrl+Shift+M`) —
now a dock tab on the **Tracking** workspace context. Two accuracy notes worth knowing:

- **OSC receive is a machine setting, not part of the project.** Turn it on once in **Preferences ▸ OSC
  / Tracking**: **OSC receive** on, **Listen port** `10000`, **Bind address** **All**. Keep the bind on
  **All** (every interface, loopback included) so the emitter reaches you over `127.0.0.1` — a venue NIC
  IP would not. Nothing about OSC ships *inside* these projects: the `settings` block older `.artlux`
  files carry is **ignored on load** (it is the machine, not the show — see
  [`docs/OSC.md`](../../docs/OSC.md)).
- The emitter always sends `id = i+1` and **never `id = 0`**, so the protocol's *"`id == 0` means the
  slot is empty"* leave-signal can't be seen on the wire with the shipped emitter — the tutorial
  teaches that rule from the protocol (see [`docs/OSC.md`](../../docs/OSC.md)), not from a live packet.

## The bundled take (chapter 03)

`assets/tracking/demo.lblob` is a small, hand-authored recording of the SOL feed (~18 s, deterministic
blob paths). A **take** is exactly what the tracking store emits each frame, re-injected on replay — see
[`docs/TRACKING_TAKES.md`](../../docs/TRACKING_TAKES.md). It is referenced by the same folder-relative
POSIX path (`assets/tracking/demo.lblob`) in both the timeline's take list **and** the placed tracking
clip, and that path resolves against the project's own folder on open — which is what makes chapter 03
portable with zero setup. (A live-recorded take captures **up to ~60 fps**, not 61: the store coalesces
the feed to one update per animation frame.)

## Making the show react — trigger zones

Blobs on the floor are the *input*; **trigger zones** are how the room drives the show. A zone is a named
rectangle you draw on a tracking surface (**Tracking** workbench ▸ **Trigger Zones** dock tab); the
**Show Machine** can transition on it — *someone enters the entrance → play the reaction state*. Zones are
project-scope geometry (drawn once, shared by every scene), read from the **same store** the live feed and
take replay fill — so you can build and tune the whole interaction against the emitter or the bundled take,
**no venue required**. The tutorial covers this in [`tuto/README.md`](tuto/README.md#trigger-zones--making-the-room-drive-the-show)
and chapter 03; wiring a zone to a transition is in [`docs/STATE-MACHINE.md`](../../docs/STATE-MACHINE.md),
the field-tuning knobs in [`docs/TRACKING_SYNC.md`](../../docs/TRACKING_SYNC.md).

## How to open

In ArtLux: **File ▸ Open…** (`Ctrl+O`) → pick a `.artlux` file. These are single-file projects — use
**Open…**, not *Open Project Folder…*. Then open the **Timeline** panel; chapter 03's tracking clip
sits on a dedicated **tracking lane**. Note that chapter 02 turns on the **3D Scene tracking
visualization** (`trackingViz`), so its blobs also render in the **3D Scene / projector output**, not
just the 2D editor stage — open the **3D** (Venue) or **Tracking** workspace context alongside the stage
to see both. (The tracking overlays are tuned in the **Tracking** inspector section, shared by both
contexts — see the tutorial.)

## Start the tutorial

➡ **[tuto/README.md](tuto/README.md)** — a three-part course that opens each project, watches it run,
takes it apart in the editor, and has you modify it.

## Keep your changes

These are a sandbox; edits apply live. To keep them, **File ▸ Save As…** to a new file so the originals
stay clean for the next read-through. (Recording your **own** take copies the `.lblob` into the *opened*
project's `assets/tracking/` folder, so open a project first before you hit record.)

---

*How these were built:* each file is a normal ArtLux project (`version 1.1`). The floor surface carries
a `TRACKING` content source bound to the **SOL** zone; the optional backdrop is a built-in GPU `EFFECT`
on a `bgLayer` drawn beneath the blobs. See [`docs/TRACKING_TAKES.md`](../../docs/TRACKING_TAKES.md) for
record/replay, [`docs/OSC.md`](../../docs/OSC.md) for the tracking protocol and control, and
[`docs/EFFECTS.md`](../../docs/EFFECTS.md) for the effect/palette catalog. Back to all sets:
[`examples/README.md`](../README.md).
