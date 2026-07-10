# 01 · Blob Viewer

> Project: [`../01-blob-viewer.artlux`](../01-blob-viewer.artlux)
> You'll learn: the **LiDAR blob feed**, the **synthetic emitter**, the **OSC Monitor** sniffer, the
> **TRACKING surface content** inspector, and the **3D tracking-zone** viz.

The tracker isn't here — but the whole pipeline is. This chapter feeds ArtLux a **synthetic** blob
stream from a script, watches two blobs orbit the floor, and takes apart the two places blobs show up:
the 2D **Stage** and the **3D Scene**. No real LiDAR, no venue network.

## 1. Open it

**File ▸ Open…** (`Ctrl+O`) → `01-blob-viewer.artlux`. (Single-file project — use *Open…*, not *Open
Project Folder…*.)

On the 2D **Stage** you'll see one full-screen **Floor (SOL)** surface — dark and empty, with **no
blobs yet**. Nothing is moving on the floor because nothing is sending. (This surface ships with its
**Background** set to *none*; a media-free effect wash drawn *under* the blobs is chapter 02's job.)
The project already listens: its settings ship with **`oscListenPort: 10000`** and
**`oscListenAddress: ""`** (empty = **all interfaces**, so the loopback feed on `127.0.0.1` arrives).
We just need a sender.

> **Why the empty bind address matters.** Leaving the listen address blank binds every NIC, including
> loopback. A real venue NIC IP (e.g. `192.168.61.32`) would *not* receive the local emitter — see the
> `EADDRNOTAVAIL` note in [`../../../docs/OSC.md`](../../../docs/OSC.md#troubleshooting).

## 2. Run the emitter → orbiting blobs

From the repo root, in a terminal:

```
node scripts/lidar-emitter.cjs            # 127.0.0.1  10000  2 blobs/surface (defaults)
```

It prints `emitting 2 blobs/surface (SOL+MUR) at 61fps -> 127.0.0.1:10000` and starts sending. Switch
back to ArtLux: **two blobs now orbit the Floor (SOL) surface** on the Stage, each tracing a slow
Lissajous loop (the script gives every blob its own phase so smoothing/motion is visible). `Ctrl+C` in
the terminal stops the feed; the blobs fade out.

The emitter speaks the exact venue protocol — for each surface it sends
`/<surface>/specs/Scalex|Scaley` (the zone size, **5.825 × 3.125 m**) and, per blob slot,
`id / tx / ty / u / v`. It emits **both `SOL` (floor) and `MUR` (wall)** every frame, so the wall zone
is being fed too even though this project only shows the floor.

> **What the Stage shows is raw.** The editor Stage intentionally draws **un-merged, un-smoothed**
> blobs straight from the feed — one marker per active slot. Smoothing and the "2 blobs → 1 person"
> merge happen downstream in the 3D Scene and projector output, not here.

## 3. OSC Monitor — read the wire

**View ▸ OSC Monitor…** (`Ctrl+Shift+M`) opens a live sniffer of the raw incoming stream — the fastest
way to confirm *"is anything actually arriving on this machine?"* With the emitter running you'll see:

- **Status strip** — a **green** dot (receiving), the bind target **`*:10000`**, live **msg/s**, the
  number of distinct addresses, and total **active blobs**. (Amber + `0 msg/s` = listening but nothing
  arriving; grey = OSC receive off.)
- **Blob cards** — one per surface seen: **`SOL`** and **`MUR`**, each showing `active / total` slots
  and the zone size in metres. A card glows **green** while it has active blobs.
- **Address table** — every address with its update **rate (Hz)**, count, and last value. Type
  `SOL` in the **filter** box to isolate the floor: you'll see `/SOL/specs/Scalex`,
  `/SOL/specs/Scaley`, and `/SOL/blobs/blob0/…`, `/SOL/blobs/blob1/…` each ticking near the wire rate.

Because the Monitor taps the **raw wire**, the per-address rate reads close to the emitter's **61 fps**.
ArtLux's tracking store then **coalesces** that to one update per animation frame before it reaches the
Stage, 3D viz, or a recording — which is why a captured take holds **up to ~60fps**, not 61. (Recording
takes is chapter 03's job; here we're just watching.)

### The `id == 0` empty-slot rule (protocol, not live)

In the real protocol each blob slot carries an **`id`**, and **`id == 0` means the slot is empty** — it
is how the tracker signals *"this person left"* (see the protocol table in
[`../../../docs/OSC.md`](../../../docs/OSC.md#protocol-reference-tracking)). You will **not** see this
on the wire here: `scripts/lidar-emitter.cjs` always sends `id = i + 1` for every slot and **never
sends `0`**, so its blobs never "leave" — they just orbit forever. To *observe* a leave-signal you'd
have to teach the emitter to drop a slot (a ~3-line tweak: stop firing a blob's fields, or emit its
`id` as `0`, for part of the loop). Read the rule from the protocol; don't expect the shipped emitter
to demonstrate it.

## 4. Take apart the TRACKING inspector

Click the **Floor (SOL)** surface on the Stage, then open its **Content** in the Inspector. Because its
type is **Tracking**, you get the LiDAR content controls (grounded in `ContentEditor.tsx`):

| Control | What it does |
|---|---|
| **Source** | `SOL — floor` / `MUR — wall` / `SOL_MUR — combined` — which zone's blobs this surface draws. |
| **Background** | a timeline video/effect layer drawn *under* the blobs (here **— none —**; chapter 02 wires an EFFECT wash in). |
| **Blob size** | marker diameter as a % of the zone (0.01–0.15). |
| **Trail (s)** | how long each blob smears a fading tail (0–3 s); the **Trail** checkbox turns it on/off. |
| **Rotate** | 0 / 90 / 180 / 270° of the whole zone. |
| **Flip H / Flip V** | mirror the mapping — used on-site to line the projection up with the real floor. |
| **Show IDs** | draw each blob's tracking `id` next to its marker. |
| **Calibrate** | overlay the zone border + grid + amber U/V axis arrows (a projector-alignment aid). |

**Try it:**

1. **Show IDs** — this project ships with it **on**, so labels `1` and `2` already sit beside the two
   blobs (the emitter's `i + 1`). Untick to hide them, re-tick to bring them back.
2. **Blob size** — drag it up; the markers swell.
3. **Source → `MUR`** — switch the floor surface to read the **wall** feed instead. The emitter sends
   `MUR` too (phase-shifted by π), so two blobs keep orbiting — sourced from the other zone. Switch
   back to `SOL` when done.
4. **Calibrate** — tick it to see the zone border + U/V arrows; the arrows show the data's orientation
   (`u` right, `v` up — a **bottom-left** origin). Untick it.

## 5. The 3D tracking-zone viz

![The SOL floor and MUR wall in 3D, sharing their bottom edge](images/tracking-zones.svg)
*The two zones at real scale — **SOL** floor on `y = 0` and **MUR** wall on `z = 0`, sharing their bottom edge. Each active blob is a bloom-lit marker; the amber **U/V** gizmo sits at the bottom-left origin (`u` across the width, `v` up the zone toward the wall).*

Blobs live in real 3D space, not just the flat Stage. Open the **3D Scene** window; in the bottom-right
panel under **Lighting**, enable **Tracking zones (LiDAR)** (grounded in `ScenePanel3D.tsx`). The
**SOL** floor (on `y = 0`) and **MUR** wall (on `z = 0`) appear at real scale, sharing their bottom
edge, with a glowing bloom-lit marker per active blob. Toggling it reveals three sub-controls:

- **Smoothing** (0–1) — One-Euro filter strength on the marker motion.
- **Predict (ms)** — how far ahead motion is extrapolated to hide latency.
- **Show IDs** — label markers in 3D.

Nudge **Smoothing** up and the orbiting markers glide more; drop it to `0` and they snap frame-to-frame.
Unlike the Stage, this is the **smoothed** view — the same data, filtered the way the projectors will
see it.

## 6. The pieces, named

| Concept | Here | Where it lives |
|---|---|---|
| **Zone** | `SOL` floor, `MUR` wall | `/<surface>/specs/Scale*` → 5.825 × 3.125 m |
| **Blob** | an orbiting marker | `/<surface>/blobs/blob<n>/{id,tx,ty,u,v}` |
| **Empty slot** | (not shown live) | `id == 0` in the protocol |
| **Surface content** | Floor (SOL) surface | `content.type: "TRACKING"`, `trackingSource: "SOL"` |
| **OSC listener** | receives the feed | `oscListenPort: 10000`, `oscListenAddress: ""` |
| **Raw view** | the 2D Stage | un-merged, un-smoothed markers |
| **Smoothed view** | 3D Scene | Tracking zones (LiDAR), One-Euro + prediction |

## Recap

A **blob** is a tracked person's position, streamed over OSC per-zone. You fed ArtLux with the
**synthetic emitter**, confirmed it on the **OSC Monitor** (green dot, `/SOL` addresses ticking near
the ~61 fps wire rate), took apart the **TRACKING** surface inspector, and saw the smoothed **3D zone**
viz. Remember the two invariants you *read* rather than saw: `id == 0` marks an empty slot, and the
store coalesces the feed to **up to ~60fps**.

Next in this set: **calibrate and project** these blobs onto a real floor and wall — the **Calibrate**
overlay, fixing a mirrored feed with **Flip / Rotate**, and wiring the media-free **EFFECT background**
under the blobs. Chapter 03 then replays a **bundled take** so the whole show runs with **no emitter and
no scripts** at all. Deeper reference: [`../../../docs/OSC.md`](../../../docs/OSC.md) (protocol +
Monitor) and [`../../../docs/TRACKING_TAKES.md`](../../../docs/TRACKING_TAKES.md) (record & replay).

➡ **[02 · Calibrated Projection](02-calibrated-projection.md)** · project [`../02-calibrated-projection.artlux`](../02-calibrated-projection.artlux)

> **Tip — keep your edits.** These templates are a sandbox. To keep changes, **File ▸ Save As…** to a
> new file so the original stays pristine for the next read-through.
