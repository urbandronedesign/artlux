# On-site procedure — sync ArtLux with the LiDAR tracker (1 person = 2 blobs)

Field checklist for verifying the live LiDAR feed and resolving the **"1 person produces 2 blobs on
the floor"** behaviour, so ArtLux counts/visualises **one person as one entity**. Related:
[OSC.md](OSC.md), [TRACKING_TAKES.md](TRACKING_TAKES.md), [[artlux-osc-tracking]].

## Already confirmed (from an OSC dump)
The wire format and geometry match our implementation — no parser change needed:

- Addresses: `/SOL` (floor) + `/MUR` (wall), each `…/blobs/blob<n>/{id,tx,ty,u,v}` and
  `…/specs/Scalex|Scaley`. Matches `BLOB_RE`/`SPEC_RE` in `src/renderer/services/trackingStore.ts`.
- `id` is a **large unique integer** (e.g. `2673`) for an active blob; **`id = 0` means the slot is
  empty** and carries garbage values (`u≈-0.1821`, `v=-1`, `tx=-4`). We filter `id===0`, so empties
  never render.
- Coordinates (verified against a live sample, `Scalex=5.864`, `Scaley=3.125`):
  - `u = tx / Scalex + 0.5`   ·   `v = ty / Scaley + 0.5`
  - `tx`/`ty` = metres about the **zone centre**; `u`/`v` = normalised `0–1`, **origin bottom-left**.

Cross-checked against the venue's **official protocol doc** (2026-06-25) — all fields match:
`id` Int `[1;+∞]` (0 = inactive) · `tx` Float `[-ScaleX/2; ScaleX/2]` · `ty` Float
`[-ScaleY/2; ScaleY/2]` · `u`,`v` Float `[0;1]`. The doc does **not** state the `u/v` origin; we
assume bottom-left (flip `1-v` for screen) from live validation — confirm with a corner test on site.

**The only open item is the pairing rule** below — everything else is in sync.

## Before you start
- ArtLux dev/show machine is **192.168.61.32**; the tracker server is **192.168.61.21** (emits to
  **udp/10000**).
- Preferences ▸ OSC / Tracking: **OSC receive ON**, **Listen port 10000**, Bind = this machine's IP
  (`192.168.61.32`) or **All**. *Never* bind the server's `.21`.
- Gotcha: ping `192.168.61.21` first — being on the `.61` subnet isn't enough; confirm the server is
  actually up before expecting blobs.

## Step 0 — Confirm reception
1. Open **View ▸ OSC Monitor** (`Ctrl+Shift+M`).
2. Expect: **green** status dot, live **msg/s**, and **SOL** + **MUR** blob cards. Amber + `0 msg/s`
   = listener up but nothing arriving (check server/network).

## Step 1 — Determine the pairing rule  ← the key test
Goal: with the data, decide whether the **two blobs of one person share the same `id`** or have
**different ids**. This picks the algorithm.

1. Have **exactly ONE person** stand on the floor (SOL). Keep everyone else off it.
2. In the OSC Monitor, type `SOL/blobs` in the filter and find the rows where **`…/id` ≠ 0**
   (or watch the green SOL card count — it should read **2 active**).
3. Record, for each of the two active blobs: its `blob<n>`, its **`id`**, and its `tx`,`ty`.
4. Repeat: **two people far apart**, then **two people close together** (~0.5 m).

Fill this in on-site:

| Scenario | Active blob slots | id values | tx, ty (m) each | Separation (m) |
|---|---|---|---|---|
| 1 person | blob__ , blob__ | __ , __ | (__,__) (__,__) | __ |
| 2 people apart | | | | |
| 2 people close | | | | |

> Tip: also **record a LiDAR take** (Timeline ▸ Takes bin ▸ record) during the test — it captures the
> raw feed so we can replay and inspect it back at the desk if the live read is too fast.

### Decision
We expect the two blobs to have **different ids**, so **spatial clustering** is implemented (and is
robust either way): merge active blobs within a distance threshold ≈ the measured 1-person
separation, guarding against merging two real people who stand close (note the "2 people close"
separation as the lower bound for the radius).

## Step 2 — Enable & tune the merge (already implemented, off by default)
The **"Merge people (2 blobs → 1)"** feature ships off by default — `services/blobClustering.ts`
clusters a surface's blobs within `trackingMergeRadius` metres into one centroid "person", applied
at the snapshot bridge so the **3D viz and projector outputs** show merged people (the raw OSC feed
and recorded takes are untouched).

On-site:
1. Open the **3D Scene** window → tracking controls.
2. Turn on **Merge people (2 blobs → 1)**.
3. Adjust **Merge radius (m)** (default 0.6) until one person shows a single marker.

## Step 3 — Validate
- 1 person → **1** marker; 2 people apart → **2**; 2 people close → raise/lower **Merge radius**
  until both hold (the "2 people close" separation from Step 1 is your upper bound for the radius).
- Re-record a take as a regression fixture.
- Person ids are **temporally stable**: each frame's people are matched to the previous frame's by
  proximity (≤0.8 m, 400 ms dropout tolerance), so a person's `#id` survives the underlying blobs
  dropping/reacquiring. Ids reset when you toggle merging off.
- Known limits (fine for now, revisit if needed): clustering applies to all surfaces with one radius;
  merge feeds the viz/projector outputs, while the 2D editor stage preview still shows raw blobs.

## What to bring back from the test
1. The filled table above (slots, ids, separations).
2. **Same id or different ids?** — the single answer that unblocks Step 2.
3. A recorded `.lblob` take of the one-person and two-people cases.
4. The live `SOL`/`MUR` `Scalex`/`Scaley` values shown on the blob cards.
