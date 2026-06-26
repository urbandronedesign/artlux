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

### What an on-site recording showed (Take 2, 34 s, 3–4 people)
Analysed `services/blobClustering.ts` against a real `.lblob`. Findings:
- **Coordinates/ids all match the spec** (`u,v∈[0,1]`, `|tx|,|ty|≤Scale/2`, ids large & unique).
- **A person's blobs have different ids** (0 of 120 two-blob frames shared an id) → grouping must be
  spatial, confirmed.
- **The venue feed flickers hard**: ~454 distinct SOL ids in 34 s, **median id life 0.13 s, 67 % under
  0.25 s**. The tracker emits transient detections, not stable tracks — its ids are unusable for
  identity, and a person's far-apart blobs blinking makes the cluster *centroid jump ~1 m* even
  when the person stands still. A naive nearest-match re-IDs constantly (gave 152 person-ids).

### How robust tracking is achieved
`clusterAndTrack` is a small **predictive multi-object tracker** (off by default): cluster blobs →
observation centroids, then **predict** each track by its velocity, **associate** within `GATE_M`
(1.5 m) of the prediction, **confirm** only after a few hits (rejects 1–3 frame flicker), and
**coast** a confirmed person through missed frames (≤700 ms). Output positions come from the track,
so ids and motion stay stable. Validated on the recording (was → now):

| Metric (SOL) | old matcher | tracker @ 0.8 m |
|---|---|---|
| people/frame (truth 3–4) | 2.97 | **3.8** |
| distinct person-ids over 34 s | **152** | **23** |
| median person-id lifetime | <0.5 s | **3.6 s** (max ~20 s) |

## Step 2 — Enable & tune on-site (already implemented)
1. Open the **3D Scene** window → tracking controls → turn on **Merge people (2 blobs → 1)**.
2. Adjust **Merge radius (m)** (**default 0.8**): lower if distinct people merge; raise (→1.0) for
   steadier counts if one person still shows two markers.
3. Tune **Predict (ms)** / **Smoothing** for motion (≈66–100 ms predict at 30 Hz).

## Step 3 — Validate
- Steady marker count = your real headcount; each person keeps one `#id` as they move.
- 2 people apart → 2; 2 people close → if they merge, lower the radius (their closest approach is the
  upper bound). Re-record a take as a regression fixture.
- Known limits (revisit if needed): one radius for all surfaces; merge feeds the viz/projector
  outputs while the 2D editor stage preview still shows raw blobs; tracker constants (gate/confirm/
  coast) are fixed (tunable in code if needed).

## What to bring back from the test
1. The filled table above (slots, ids, separations).
2. **Same id or different ids?** — the single answer that unblocks Step 2.
3. A recorded `.lblob` take of the one-person and two-people cases.
4. The live `SOL`/`MUR` `Scalex`/`Scaley` values shown on the blob cards.
