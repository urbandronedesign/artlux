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
- **Both blobs share the same `id`** → group blobs by `id` (exact, trivial). Best case.
- **Different ids** → spatial clustering: merge active blobs within a distance threshold ≈ the
  measured 1-person separation (e.g. ~0.6 m), guarding against merging two real people who stand
  close (note the "2 people close" separation as the lower bound).

## Step 2 — Implementation (back at the desk, after the test)
Add an optional "merge blobs → people" stage; **off by default** so nothing changes until enabled:

- New `src/renderer/services/blobClustering.ts`: active blobs of a surface → **people** (group-by-`id`
  *or* centroid of blobs within `trackingMergeRadius`).
- Settings: `trackingMergePeople` (toggle) + `trackingMergeRadius` (m) in the Scene/Tracking panel.
- Feed merged people to the 3D viz markers, projected blobs, `#id` labels, and any blob-count / zone
  logic; keep raw blobs available behind the toggle for debugging.
- Smooth the merged position in `src/renderer/services/blobMotion.ts`, keyed by person id.

## Step 3 — Validate
- 1 person → **1** marker; 2 apart → **2**; 2 close → tune `trackingMergeRadius`.
- Re-record a take as a regression fixture.

## What to bring back from the test
1. The filled table above (slots, ids, separations).
2. **Same id or different ids?** — the single answer that unblocks Step 2.
3. A recorded `.lblob` take of the one-person and two-people cases.
4. The live `SOL`/`MUR` `Scalex`/`Scaley` values shown on the blob cards.
