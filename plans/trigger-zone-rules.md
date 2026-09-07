# Trigger zones — counting people, and stacking rules per zone

> **Status: BUILT + PUSHED — 2026-09-07, branch `trigger-zone-rules` (not merged to `main`).**
> Two commits, in this order. Part A is a **bug fix** answering a venue report; Part B is the
> **feature** that report interrupted. A went first deliberately: B makes `at least N people` far
> easier to reach, and it had to be trustworthy before it became prominent.
>
> ```
> 8d5fc12  feat(tracking): every zone in a combination carries its own rule      Part B
> a9a252d  fix(tracking): a zone counts people, not blobs — and a wall counts hands  Part A
> ```
>
> **Read [What is NOT proven](#what-is-not-proven) before trusting any of it.** One whole class of
> verification — the end-to-end CDP harness — is written and was never run green.

This says what was *built*, **how it was proved**, what was *decided* (so it is not re-litigated), and
what the next session should know before touching any of it.

---

## Why: the report

> *"the lidar track 2 blobs for each person so i had to put 4 persons instead of two in order to
> trigger a contain 2 persons"*

…and then, mid-investigation:

> *"good for the floor but for the wall the blobs represent each a hand and we expect the users to use
> only one hand to trigger a zone"*

The people-merge existed and was correct. **Four** separate things stood between it and a right answer,
and the second message revealed that the model itself was wrong: what a blob *means* is a property of
the **surface**, not of the project.

---

# PART A — a zone counts people (`a9a252d`)

## A1. What a blob means is per-surface

One venue needs both answers at once. On **SOL** (floor) the LiDAR paints ~2 blobs per visitor (legs);
on **MUR** (wall) each blob is a **hand** and a visitor raises one. A single project-wide
`trackingMergePeople` could not say that — so turning merging on for the floor was **silently merging
wall hands**, and two people touching within 0.8 m became one trigger. That was live in `tide.artlux`.

- New core field `Scene3D.trackingSurfaceMerge?: Record<string, boolean>` (`shared/protocol.ts`).
  **Absent for a surface ⇒ follow the global flag**, so zero migration.
- UI: *Trigger Zones ▸ **a blob is*** beside the surface picker — `part of a person (merge)` /
  `one whole thing — a hand`.
- A "hand" surface runs at **radius 0 _through_ the tracker**: never merged, still flicker-rejected and
  coasted, so a hand the sensor loses for a frame does not drop the trigger. (Decided with the owner
  over raw blobs — a wall trigger that chatters is worse than one that releases 0.7 s late.)

## A2. The show and the screen counted with different algorithms

Zones ran `clusterBlobs` (spatial merge only); the projector outputs ran `clusterAndTrack` (that **plus**
the predictive tracker). On a feed whose blob ids have a ~0.13 s median lifetime that is not a nuance:
**the number an operator validates against was not the number the show acts on.**

`zones.ts` declined the tracker for a *correct* reason — it is stateful and documented "call ONCE per
frame, from a single caller" — but the fix is to **be** that caller, not to run something weaker in the
path that drives the show. New `plugins/lidar-tracking/src/people.ts` computes once per frame from
`ctx.onPlayhead`; zones and the projector channel both read it. Guarded by an invariant
(*clusterAndTrack is called only from people.ts*).

Two consequences worth knowing:

- Zones inherit `trackingStore.snapshot()`'s `STALE_TTL` filter. Previously a blob the sensor stopped
  updating **without releasing its slot** held a zone occupied *forever* — nothing in the dwell model
  can release it.
- A person is held up to `MAX_COAST_MS` (**0.7 s**) after vanishing, on top of `exitSec`. That is the
  tracker doing its job, but it means `everyone leaves` / `empty for…` release later than the raw feed
  suggests. Lower the venue **Zone exit dwell** if a release feels late. Documented + in the changelog.
- `resetPeopleTracking()` was **missing** from the take-boundary reset in `trackingPlayback.ts` —
  harmless while the tracker only fed the viz, phantom people once it feeds the show.

## A3. Sensor settings rode the look

`buildSceneSnapshot` stripped only `trackingZones`/`viewFrom`; `handleRecallScene` restored only those
two. So `trackingMergePeople`, `trackingMergeRadius`, the new per-surface meaning and the venue dwell
were captured per scene and **reassigned on every GO** — on-site tuning undone by the next recall.

This is the same defect class as the one that once wiped the zones themselves, documented three lines
above it in the same function. **It recurred because that fix was spelled out separately at each site**
and the sensor fields, added to `Scene3D` later, reached none of them. Hence one
`SCENE3D_NOT_A_LOOK` + `stripNotALook`/`keepNotALook`, read by all **three** sites (the third is the
unsaved-changes `norm()`, which lights the Update chip permanently if it disagrees).

> ⚠ **This was LATENT in the reporting project, not the cause.** All ten scenes in `tide.artlux`
> already carried `merge=true`. Do not claim it fixed the report.

## A4. Nothing showed the number that decides the merge radius

Blobs merge only if closer together than `trackingMergeRadius`. If a venue's pairs sit further apart,
nothing merges, the count silently stays doubled, and the only symptom is a threshold meaning half what
was typed. That number was **unmeasurable from inside the app**.

The zone map now draws a ring per counted person and reads:

```
4 blobs → 2 people  ·  closest pair 0.30m / merge 0.80m
```

…turning **red** when the closest pair exceeds the radius. Stand one person on the surface and the gap
between their own two blobs is right there. **This is the most likely actual cause of the report** —
see [The open venue question](#the-open-venue-question).

---

# PART B — every term carries its own rule (`8d5fc12`)

A **Combination** could only ask about bare occupancy, so *"somebody in the entrance for 5 s and the
stage empty"* was a chain of intermediate states rather than one edge.

## The insight that made it small

`level()` **already computed all five rule kinds as levels** — `enter` is literally `st.occupied`,
`exit` is `!st.occupied` — and the combination path called an `occupied()` helper byte-identical to the
`enter` case. Combinations were using a **hardcoded subset of a vocabulary that already existed.**

So: extract `zoneLevel(zoneId, rule, nowSec)` and give it two equal callers — the one-zone form and
every term. `ZoneTerm extends ZoneRule`; `edge` defaults to `'enter'`, which is exactly what a term
meant before ⇒ **zero migration**, and `describeZoneTrigger` emits byte-identical edge labels for every
existing project. (Verified in the app: the owner's edge stayed `Zone 1 [1]`.)

## Two voices, one table

A rule alone may read as an **event** ("someone enters") because arm-and-hold edge-detects that one
level. Inside a combination the same computation must read as a **state** ("is occupied"), because the
arming is on the whole *sentence*. One `EDGES` table with two label columns keeps the five values in
lockstep with `ZoneEdge`; its `arg` column replaced the hardcoded "which extra field does this rule
need" conditionals in **both** modes.

## Two bugs found on the way

**1. The memo would have fired 60×/s.** `sig()` keys the arm-and-hold memo by the *rule*, not the
transition (the id is not available at the call site — `stateMachine.ts` passes only `source`/`params`).
That is sound only while the key is **injective**. Per-term rules widened the space, so `ALL[zA]` and
`ALL[zA occupiedFor 60s]` out of one state would have shared a memo: the 60 s rule is false every frame
and sets `armed`, the plain rule reads that same `armed` and **fires** — for as long as somebody stands
there. Nothing throws; the two `params` objects visibly differ.

> ⚠ **The guard must check `termSig` and `sig` SEPARATELY.** A combined-region check **passes on broken
> code**, because `sig`'s one-zone branch mentions `edge`/`seconds`/`n` anyway. That mistake was
> shipped into the guard and caught only by deliberately deleting the fields from `termSig`.

**2. The term dots were never live.** The inspector had **zero** `subscribe`/`useEffect`/rAF: it read
zone state during render, and its parent re-renders on selection and state-machine events — never per
frame. So having selected a transition you could walk the room and watch nothing change, while
`03-replayed-take.md` asserted "live occupancy dots". Fixing it needs **two clocks**: `zones.subscribe`
(fires on arrive/leave) **plus** a 250 ms interval, because a dwell comes true on time alone with
nothing to announce it. The dots now show the *term's* level including its NOT, and paint
"unanswerable" as its own state.

## Decided with the owner — do not re-open

| Question | Decision |
|---|---|
| Keep "One zone" as its own mode? | **Yes.** Simple rules stay one click. |
| Sequencing (*A dwells, **then** B enters*) inside one rule? | **No.** Order lives in the graph, as an intermediate state, which enforces it properly. A conjunction is simultaneous and order-agnostic. |
| Keep the per-term NOT? | **Yes.** `¬(occupied for 5s)` ≠ `empty for 5s`. (For `enter`/`exit` it *is* simply the other rule — said so in the UI.) |
| Nesting / `(A ∧ B) ∨ C`? | **No.** Flat ALL/ANY + per-term NOT. |
| 3D scene markers merged too? | **No.** `TrackingViz` stays a raw sensor-diagnostic view; it shows 4 markers where zones count 2, deliberately. |
| Default `Merge people` to on? | **No.** A 1-blob-per-person sensor would merge a close-standing pair. Make it *visible*, not assumed. |

---

## How to verify

| What | Command | Covers |
|---|---|---|
| Merge math | `npm run test:people` | 12 checks, ~1 s: pair merge, the radius boundary, tracker confirm/coast, the wall/hand case, and *"two hands 0.4 m apart WOULD merge at the floor radius"* — the reported bug in a unit test |
| Guards | `npm run verify` | 165 invariants + 11 doc checks + typecheck |
| No sensor | `node scripts/lidar-emitter.cjs 127.0.0.1 10000 2 --pairs` | emits each person as 2 blobs 0.3 m apart, exactly like the venue |
| End-to-end | `node scripts/test-zone-fsm.cjs` | ⚠ **written, never run green** — see below |

**Both new invariants were proved non-vacuous** by breaking the code and watching them fire — the
`SCENE3D_NOT_A_LOOK` one by deleting a field from the list, the memo one by deleting the rule fields
from `termSig`. Do the same to any guard added here; the memo guard passed on broken code in its first
form.

---

## What is NOT proven

- **`scripts/test-zone-fsm.cjs` has never gone green on this branch.** The dwell-inside-a-term case
  (with its load-bearing *negative* assertion) and the NOT-vs-`emptyFor` discriminator are committed and
  untested. Three runs were attempted: the first died on a stale dev server, the second on a **rotted
  selector** (it opened the timeline by clicking a tab captioned `Time`, which stopped existing when the
  timeline became a `Ctrl+T` drawer — now fixed to press the shortcut and assert the state lane is
  readable), and the third was stopped because the harness takes ~5 min, kills any running Electron and
  rewrites OSC prefs.
- **The memo-collision "repeat hops" case** (a state re-entered while a zone stays occupied, asserting
  ≤1 hop) was never written — it needs its own graph. The invariant covers the class instead.
- **Part A's A3 fix is not proven against a *scene* recall in the harness** — only against real FSM GOs
  fired over OSC in a live session, which did hold.

## The open venue question

**Was the merge radius the actual cause?** Unconfirmed. `tide.artlux` has no recorded tracking take, so
the venue's real blob spacing could not be measured. On site, with the sensor connected:

1. Open **Trigger Zones**, pick the floor surface.
2. Stand **one** person in view.
3. Read `closest pair` — that is the gap between *their own two blobs*.

If it exceeds `merge` (and the line is red), the radius was too small for this venue and raising it past
that number is the whole fix. If it is well under, the cause was something else and this doc is wrong.

---

## Traps for the next session

- **`ELECTRON_RUN_AS_NODE=1` is set in this environment** and makes `npm run dev` die with
  `electron.app undefined`. Unset it.
- **A heredoc through the agent's Bash tool eats one backslash.** `\\b` inside a JS *template literal*
  became `\b` = BACKSPACE, and a guard silently matched nothing and passed forever. Use regex
  **literals**, where a single backslash is correct.
- **Driving React over CDP:** a `<select>` accepts a plain `change` event, but a number `<input>` needs
  the native setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`) plus an
  `input` event — assigning `.value` is discarded on re-render. An edge label read `0s` before this was
  spotted.
- **`test-zone-fsm.cjs` captures the original prefs *after* a `waitForFunction` that can time out**, so
  an early failure restores `null` and **clobbers `lastProjectPath`**. It did, once; restored by hand
  from `recentFiles`.
- **Prove a GO actually moved the state** before believing a "the setting survived" result. An OSC
  `/artlux/state/trigger` whose `from` is not the current state is silently ignored.
- **The rule list lives in EIGHT documentation copies.** All eight were updated here. Nothing checks
  them — see the follow-up below.

## Side effects on the owner's project

While testing, `trackingSurfaceMerge: {MUR: false}` was **saved into `tide.artlux`**. It is the correct
setting for that venue's wall, but it was not asked for — revert it in Trigger Zones if it should be set
deliberately.

## Follow-ups, deliberately out of scope

- **`<!-- generated:zone-rules -->`** — emit the five-rule table from the `EDGES` table in
  `ZoneTriggerInspector.tsx` into the two pages that carry it in full. Eight hand-maintained copies is
  exactly what the documentation rule forbids, and this feature *is* the first drift opportunity.
- **An inspector warning for the walk-through trap** — zones are rectangles with a surface, so the
  editor can see that two positively-asserted `ALL` terms name zones that do not overlap and say
  *"these zones don't overlap — one person cannot be in both"*. A soft warning, never a block (two
  people is legitimate). This is the exact confusion the owner hit when asking about "stay 5 s then
  enter the second zone".
- **SDK edit-context for a trigger `Inspector`** — its props are `{ params, onChange }`, so a
  contribution never learns *which transition* it is editing. That is why the inactive-zone warning
  checks the scene currently loaded rather than the one the transition leaves from. Also a general SDK
  hole.
- **A term cap on `describeZoneTrigger()`** edge labels — a pre-existing readability question that
  per-term suffixes make slightly more pressing.
- **Re-shoot `examples/lidar-tracking/tuto/images/zone-trigger-inspector.png`** — it predates per-term
  rules and now shows a UI that no longer exists. The shot spec beside it was rewritten to describe the
  two-line card; redact by eye (Preferences ▸ OSC / Tracking, ▸ Show Control), since the capture
  harness's `redactPrivate()` is retired.
