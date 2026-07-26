# On-site procedure — sync ArtLux with the LiDAR tracker (1 person = 2 blobs)

Field checklist for verifying the live LiDAR feed and resolving the **"1 person produces 2 blobs on
the floor"** behaviour, so ArtLux counts/visualises **one person as one entity**. Related:
[OSC.md](OSC.md), [TRACKING_TAKES.md](TRACKING_TAKES.md), [[artlux-osc-tracking]].

## Already confirmed (from an OSC dump)
The wire format and geometry match our implementation — no parser change needed:

- Addresses: `/SOL` (floor) + `/MUR` (wall), each `…/blobs/blob<n>/{id,tx,ty,u,v}` and
  `…/specs/Scalex|Scaley`. Matches `BLOB_RE`/`SPEC_RE` in `plugins/lidar-tracking/src/trackingStore.ts`.
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

> Tip: also **record a LiDAR take** (`Ctrl+T` for the timeline drawer ▸ Takes bin ▸ record) during the
> test — it captures the
> raw feed so we can replay and inspect it back at the desk if the live read is too fast.

### What an on-site recording showed (Take 2, 34 s, 3–4 people)
Analysed `plugins/lidar-tracking/src/blobClustering.ts` against a real `.lblob`. Findings:
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

---

# Trigger zones — making the show react to the room

A **trigger zone** is a named area of a tracking surface that the **show machine** can transition on:
*someone enters the entrance zone → play the reaction state.* Zones are the bridge between the blob
feed documented above and [STATE-MACHINE.md](STATE-MACHINE.md).

## How it fits together — zones, transitions, states, scenes

The one-paragraph mental model, because it is easy to conflate four things that are deliberately
separate:

- **Zones are the room, and they are always present.** They are project-scope geometry, shared by every
  scene and every state. You draw the entrance / stage / doorway **once**; nothing recreates or loses
  them when the show changes look.
- **Each transition chooses what it watches** — **one zone**, or a **combination** of zones (`ALL`/`ANY`,
  each optionally `NOT`). Different transitions can watch different zones independently.

A transition fires when its zone condition becomes true **and** two gates are open:

| Gate | Meaning | Default |
|---|---|---|
| **Which state you're in** | a transition only fires from its **source state** (the state you drew it out of) — unless it is a **⚡ global rule** (`fromAny`), which is evaluated from every state | you draw one edge per state that should react; a global rule reacts everywhere |
| **Whether the current scene listens to the zone** | each scene has an optional **active set** (the eye toggle in the Trigger Zones panel, `Scene3D.activeZoneIds`) — a zone switched off for a scene is *unanswerable* there, and any rule naming it is inert in that scene | **every zone is live in every scene** — so unless you deliberately switch one off, this gate is always open |

So the accurate summary: **the zones always exist; each transition picks a zone or a combo; and it fires
when that condition becomes true, provided the show is in the right state (or the rule is global) and the
current scene has not switched that zone off.** If you never touch the per-scene eye toggles, drop that
last clause — every zone is simply live everywhere.

## The model

`Scene3D.trackingZones: TrackingZone[]` — persisted project data (a core type in
`shared/protocol.ts`; all the behaviour lives in `@artlux/plugin-lidar-tracking`).

```ts
TrackingZone {
  id, name,
  surface,                 // SOL | MUR | SOL_MUR — a trackingStore surface key
  u0, v0, u1, v1,          // normalized rect [0..1], origin BOTTOM-LEFT (the blob convention, Y up)
  color?,
  minBlobs?,               // people needed to count as occupied (default 1, AFTER people-merge)
  enterSec?, exitSec?,     // dwell OVERRIDE; absent ⇒ follows the venue-wide dwell (below)
}
```

**Normalized, not metres** — deliberately. Blobs arrive as `u`/`v` in [0..1], so that is what the test
compares against: no unit conversion on the frame path, and no re-authoring when the venue re-measures
itself. Metres are a *display* concern (the panel shows the live `Scalex`/`Scaley`).

### Two scopes: the room, and what a look listens to

| | scope | travels with a scene? |
|---|---|---|
| `Scene3D.trackingZones` | **the room** — the rectangles themselves | **no.** Stripped from the look snapshot (`App.buildSceneSnapshot`) and preserved across a recall |
| `Scene3D.activeZoneIds` | **the look** — which of them this scene listens to | **yes.** Absent ⇒ every zone is live |

A zone is a rectangle taped to a real floor; it does not change shape because the lighting did. So the
geometry is authored **once**, and a scene chooses which zones it *listens to* — "the welcome state
watches the entrance, the performance state watches the stage" — with the eye toggle in the panel.

> ⚠ **This was a bug, briefly.** Zones live on `Scene3D`, `Scene3D` rides in the look snapshot, and
> recall assigned the whole object — so every scene silently carried a **copy** of the zones, and the
> first GO onto a scene captured *before* the zones were drawn replaced the live list with nothing.
> Every zone vanished and every zone rule went inert, with nothing logged. `verify:invariants` now
> guards both halves of the fix.

An **inactive** zone is not evaluated and has **no state at all** — it is *unanswerable*, not "empty".
That distinction is load-bearing: answering "empty" would make an `everyone leaves` or `empty for…` rule
fire in a scene that was never watching that part of the room. A rule naming an inactive zone is inert,
and the transition inspector says so rather than letting it be discovered during a show.

## Authoring

**Tracking** workbench → **Trigger Zones** dock tab.

- **drag on empty space** to draw a new zone;
- **click** a zone to select it, **drag its body** to move, **drag a corner** to resize;
- the **eye** toggle sets whether the *current scene* listens to it (dim + hollow = ignored here);
- the list carries **People needed** per zone; **dwell follows the venue-wide value** unless you tick
  **Override dwell for this zone**.

### The dwell is tuned once, on-site

The enter/exit dwell is a property of the **room** — how hard the real tracker flickers — not of any one
zone, and the value that works against the recording is rarely the value that works in the venue. So it
is a **venue-wide** control, in **the tracking parameters** (the same inspector as *Smoothing* and
*Merge radius*): **Zone enter dwell** / **Zone exit dwell**. Every zone follows it; nudge it once and the
whole room retunes.

- **Enter dwell** (default **0.2 s**) — how long presence must last before a zone latches *occupied*.
  Raise it if a flickery tracker fires arrivals too eagerly.
- **Exit dwell** (default **0.5 s**) — how long absence must last before it clears. This is also the
  **gap tolerance**: a person who briefly vanishes (the feed drops blobs constantly) does not end the
  state they are standing in until they have really been gone this long. Raise it if a standing visitor
  keeps dropping out.

A single zone can still opt out with **Override dwell for this zone** — for the odd entrance that must
react faster, or a lounge that must hold longer, than the rest of the room. (Zones drawn before this
control existed carried a baked `0.2 / 0.5`; those are cleared to *follow venue* on load, so the knob
moves them too. A zone you had deliberately set to any other value is kept as an override.)

Live blobs are drawn on the map as you work — **raw**, not people-merged, because this is the diagnostic
view and the venue's two-blobs-per-person has to be visible rather than mysterious. The same zones appear
in the **3D scene**, labelled with their name and live headcount, so you can check they are where you
think they are against the fixtures. Every drag is a draft until you release: one commit, not one per
mouse sample.

## The rules (transition ▸ trigger ▸ **LiDAR zone**)

Two modes in the inspector: **One zone** and **Combination**.

### One zone

| Rule | Fires when |
|---|---|
| `someone enters` | a person arrives — *since this state was entered* |
| `everyone leaves` | the last person leaves |
| `occupied for…` | somebody has stayed N seconds |
| `empty for…` | nobody for N seconds — the attract-return rule |
| `at least N people` | the headcount reaches N |

### Combination — **ALL / ANY** of N zones, each optionally **NOT**

*"Someone in the entrance **and** nobody on the stage"* is one rule, not two. Pick **Combination**, choose
**ALL** or **ANY**, and add a term per zone with an optional **NOT**.

> ⚠ **A combination is about occupancy, not events.** "Someone enters A" **and** "someone enters B" would
> require two arrivals on the *same frame* — never, in a real room. So a combination evaluates *who is
> standing where* and fires the moment the whole expression becomes true. It is one level deep on
> purpose: ALL/ANY plus per-term NOT covers the logic people actually write, and a nested expression tree
> is a UI nobody can use under show pressure.

### One firing rule for all of them: **arm and hold**

Every rule above — single or combination — is a **level**, and firing is:

```
on a new state entry:   armed = !value      // already true when we arrived ⇒ it must go false first
each frame:             if (!value) armed = true
fire  ⇔  armed && value
```

That one shape solves two problems that are easy to meet and expensive to debug:

- **No strobe.** A show that reacts to people re-enters its states constantly, and the visitor who caused
  the last hop is usually *still standing there*. `armed` starts false whenever the condition is already
  true on entry, so a rule cannot fire until the world actually changes.
- **The guard window.** A one-frame rising edge is too narrow when the transition is gated by
  **only after the state has finished**: the visitor arrives at t=3 *during* the film and the guard opens
  at t=12. Holding `armed && value` true for as long as the condition lasts makes t=12 fire — which is
  what the hold was built for. (See also *a trigger is evaluated even while its guard is closed* in
  [STATE-MACHINE.md](STATE-MACHINE.md).)

Pair a zone trigger with **hold at end** + **only after the state has finished**
([STATE-MACHINE.md](STATE-MACHINE.md#the-state-that-ends-and-waits--hold-at-end--requireend)) and you
get the canonical installation state: *play the look to its end, freeze there, advance when someone
walks in* — instead of a visitor cutting the film three seconds in.

## Hysteresis — and the mistake that is easy to make here

Presence is a **run that survives gaps**, not an unbroken stretch of frames, with `exitSec` doubling
as the gap tolerance:

```
seen this frame        → extend the run (start one if there wasn't one)
not seen for exitSec   → the run is really over
run older than enterSec → OCCUPIED           run ended → EMPTY
```

The obvious alternative — "occupied *continuously* for `enterSec`" — is **worse than no dwell at all
on this feed**. The venue's blob ids have a **median lifetime of 0.13 s** (measured, above), so a
0.2 s continuous dwell is reset before it can ever expire and *nobody ever triggers anything*. That
was caught in simulation (`scratch/zone-rules-sim.mjs`: 240 frames of a person standing still with a
dropout every 7th frame → 0 enter edges) before it could be discovered in a venue.

**Counting is post-merge.** With **Merge people** on, `minBlobs: 1` means one *person*, not one blob —
which matters because this venue emits ~2 blobs per person and every authored threshold would
otherwise mean half what it says. The zone panel deliberately draws the **raw** blobs, so the doubling
is visible rather than mysterious.

## Testing without the venue

Zones read `trackingStore`, and so does take replay — so a recorded `.lblob` take drives them exactly
like the live tracker:

1. Drop a take on a tracking lane and play the timeline (or run `node scripts/lidar-emitter.cjs` for a
   synthetic live feed).
2. Watch the zone light up in the panel and in 3D; tune the dwells against the real recording.
3. Entering or leaving a take **re-arms** every zone (`zones.reset()`), because a take replaces the
   whole store: carrying a latch across that boundary would fire an exit for somebody who never left.
