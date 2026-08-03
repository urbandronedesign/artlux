# Lighting keyframes — an authorable, group-addressed encoding for a light show

> **Status: E1–E6 BUILT — 2026-07-27, on `origin/main`** (this line said "NOT PUSHED" until the
> 2026-08-03 audit; `origin/main..main` is empty). Rework expected before release; see
> **[lighting-rework-status.md](lighting-rework-status.md)** for what is verified, what is open, and
> where to resume. **Core**. Risk 🟡 Med.
> Companion to [fixture-kinds.md](fixture-kinds.md) (it supplies the typed *light* group this addresses).
>
> Every phase is implemented and verified — E1 and E2 against the hardware-recorded numbers in
> docs/LIGHTING-SHOW.md, E6 by watching the wire change. **The degrees display transform (§L6) and
> its lane-shadow badge shipped afterwards, so L6 is now closed too.** Two of the §10 open questions
> were answered by building, and one of the answers contradicts the recommendation written here —
> see the status doc.

## Context — the one-sentence problem

**ArtLux has a good keyframe engine and a good group/role/spread engine, and they are not connected.**

The keyframe engine ([automation.ts](../src/renderer/services/automation.ts)) has linear/hold/bezier
segments, CSS-style easing, an O(1) monotone-cursor sampler, and a drawn editor where *"the curve you
SEE is literally the curve you HEAR"*. It addresses **one channel of one fixture, in 0..1**.

The lighting engine ([lightingTake.ts](../src/renderer/services/lightingTake.ts)) has role space,
degrees, head morphing, an ordered group as the spread axis, four spread modes, mirror/scale/offset,
and HTP/LTP merging. It can be fed **a recording, or a sine**.

So there is no way to express the most ordinary thing in lighting:

> at 0 s the group looks like **this**, at 4 s like **that**, ease between.

You can record yourself busking it (dense, uneditable), pick one of five procedural forms (one role,
one shape), or hand-draw 800 individual 0..1 lanes — which is the exact thing
[docs/LIGHTING-SHOW.md](../docs/LIGHTING-SHOW.md) opens by saying nobody does.

## The evaluation — three curve systems, none of them authorable on a group

| | `LightingTake` | `LightingEffect` | `AutomationLane` |
|---|---|---|---|
| Role space / degrees | ✅ | ✅ | ❌ — `dmx.<key>`, **0..1** |
| Addresses a **group** | ✅ | ✅ | ❌ — one fixture |
| Phase spread / mirror | ✅ | ✅ | ❌ |
| **Authorable by hand** | ❌ **record-only** | ⚠ 5 forms × 1 role | ✅ |
| Editable after the fact | ❌ | ✅ (4 numbers) | ✅ |
| Easing / hold | ❌ **linear only** | ❌ | ✅ linear/hold/bezier |
| Has an editor | ❌ **none exists** | ✅ inspector | ✅ lane |
| Sampler | binary search | analytic | **O(1) cursor** |
| Precedence | below the lane | below the lane | **wins** |

### Findings

**L1 · Two curve formats, two samplers, one of them strictly worse.**
`LightingCurve { t: number[]; v: number[] }` ([types.ts:1287](../src/renderer/types.ts#L1287)) is
parallel float arrays, linear-only, sampled by a per-call binary search
([lightingTake.ts:13](../src/renderer/services/lightingTake.ts#L13)). `Keyframe { t, v, curve, cx1,
cy1, cx2, cy2 }` ([types.ts:493](../src/renderer/types.ts#L493)) is sparse, eased, and sampled with a
carried cursor. Every capability the first lacks, the second already shipped — for audio.

**L2 · A take is write-only.** Grep confirms it: nothing in the tree edits a `LightingTake`.
`TakesBin` lists them, `LightingClipInspector` picks one. After capture the only knobs are the clip's
`scale`, `offset`, `roleMask` and phase. **Get the busk wrong and you re-record.** For a show that is
tuned over days in a venue, that is the limitation, not the file size.

**L3 · RDP is the wrong reducer for a smooth movement.** `reduceCurve` measures vertical distance to a
**straight chord** ([lightingTake.ts:189](../src/renderer/services/lightingTake.ts#L189)). A pan sine
never straightens, so the point count scales with curvature ÷ ε. The measured table in
`reductionEpsilon()` is honest about the cost — **1,195 points kept from 10,779** at 1°, ~600 KB. A
curve made of *eased segments* needs points only at the extremes.

**L4 · The take library is per-`Timeline`, and every Scene owns a Timeline.**
`Timeline.lightingTakes?: LightingTake[]` ([types.ts:536](../src/renderer/types.ts#L536)) and
`Scene.timeline: Timeline` (required since 2026-07-14). So a take is **not shareable across scenes** —
using one look in five states means five copies of the same sampled arrays in the `.artlux`. There is
no project-level library the way there is for assets.

**L5 · There is no pose / cue-to-cue model at all.** The entire encoding is *a movement*, never *a look
at a time*. A console's bread and butter — cue 1, cue 2, a 3-second crossfade — has no representation
here. The available approximation is to record yourself moving faders, which is precisely what
keyframes exist to avoid.

**L6 · The unit split, and a silent precedence trap.** An automation lane on a head's Pan is published
as **0..1, not degrees** — deliberately, and
[automationTargets.core.ts:44](../src/renderer/services/automationTargets.core.ts#L44) explains why in
detail ("*an honest 0..1 axis beats a unit label that lies*"; the display transform that would fix it
"does not exist yet"). Meanwhile that lane **outranks the lighting clip**. So a stray per-channel lane
in 0..1 silently beats a group sequence in degrees, and **nothing in the UI says so**.

**L7 · Per-frame sampling is O(log n) where it could be O(1).** `sampleCurve` binary-searches per
fixture per role per frame. Forty heads × six roles × 60 fps ≈ **14.4k searches/second** on the hot
path, in a service whose sibling solved this with a cursor two waves ago.

**L8 · The target group is untyped.** `FixtureGroup` is `{id, name, fixtureIds}` — nothing stops a
sequence being pointed at a group holding LED tape, where role values have nowhere to land. This is
finding F7 of [fixture-kinds.md](fixture-kinds.md), and the reason these two plans are linked.

### What is *not* wrong, and must survive

Role space, degrees and head morphing. The ordered group as the spread axis (nothing sorts a group,
ever). `phaseOffset`'s four modes. HTP-for-intensity / LTP-for-position merging. The
release-on-empty-frame rule in `lightingPlayback`. Live scrub authoring (the playhead subscription
fires **even while paused**). The 30 hand-computed sampler checks and the hardware-verified four-MAC
capture. **This plan changes what a curve is made of, not what a light show is.**

## Requirements this must satisfy

1. **One curve format** in the app, not two.
2. A keyframe addresses a **group**, not a fixture — a 40-head look costs one entry, not forty.
3. **Interpolation between keys is authorable**: linear, hold, and eased, per key and per role.
4. Recorded takes stay valid, and become **editable** rather than staying write-only.
5. **Zero project migration**; identical output on the wire until someone authors something new.
6. The clip's existing spread machinery (`phase`, `wing`, `mirror`, `scale`, `roleMask`) applies to
   the new form **unchanged** — no second spread engine.
7. Nothing regresses in `lightingOverlay`'s per-frame allocation behaviour.
8. A stored look can be **fired with no timeline involved** — from the cue grid, the show-control
   tablet, OSC or a state's entry action — and it is *the same look* the timeline stores, not a
   parallel copy in a second format.

## Architecture at a glance

```
Keyframe[]  ← ONE format, from types.ts, already used by automation
   ├─ LightingTakePart.channels[role]   (was LightingCurve — normalized on load)
   └─ LightingSequence.keys[].slots[]   NEW: pose keyframes over a group

services/automation.ts   sampleAt(kfs, t, cursor)   ← the ONE sampler, reused verbatim
services/lightingSequence.ts   NEW — COMPILES pose keys → per-(slot, role) Keyframe[] on edit/load
services/lightingTake.ts       keeps phaseOffset / scale / mirror / rolesOf UNCHANGED
services/lightingPlayback.ts   gains a cursor pool, keyed (FIXTURE, role)
services/curveFit.ts     NEW — constrained cubic-Bézier fit (capture path)
services/lightingCue.ts  NEW (E6) — fires a pose at a group as a role-space fade

LightingClip.sequenceId?      ← the THIRD mutually-exclusive source, beside takeId and effect
ProjectData.lightingPoses?    ← the shared pose library — one look, referenced from keys AND cues
Cue.lighting?                 ← (E6) fire a pose from the grid / tablet / OSC / an FSM entry action
```

**The one atom.** A `LightingPose` is what a keyframe stores *and* what a cue fires. That is the whole
reason both models fit in one plan rather than competing — see *Why cues are the invocation layer*.

## Design — the model

### One curve format

`LightingCurve` stops being a type and becomes a **legacy read shape**. `LightingTakePart.channels[role]`
becomes `Keyframe[]`. The normalizer is lossless and total:

```ts
// {t:[0,1,2], v:[0,5,10]}  →  [{t:0,v:0,curve:'linear'}, …]
```

A linear-only `Keyframe[]` samples **identically** to today's `sampleCurve`, which is what makes E1
verifiable byte-for-byte on the wire.

### The new unit: pose keyframes over a group

```ts
/** What one slot of the group is doing. SPARSE — an absent role is not driven. */
export type LightingPose = Partial<Record<ChannelRole, number>>;

export interface LightingKey {
  t: number;                        // seconds, sequence-local
  /**
   * One pose per SLOT of the target group, on the same index-wraps axis a take's `parts` uses.
   * ONE slot ⇒ the whole group takes the same pose — which is the common case, and the reason a
   * forty-head look costs one entry rather than forty.
   */
  slots: LightingPose[];
  curve?: CurveKind;                // shapes the segment STARTING here
  cx1?: number; cy1?: number; cx2?: number; cy2?: number;
  /** Per-role override — the dimmer snaps while the pan eases. */
  roleCurves?: Partial<Record<ChannelRole, CurveKind>>;
  name?: string;                    // "verse", "blackout" — this is a cue label, and it belongs here
}

export interface LightingSequence {
  version: 1;
  id: string;
  name: string;
  duration: number;
  keys: LightingKey[];              // INVARIANT: ascending t (normalizer enforces, like automation)
}
```

### The sampling rule — the part that makes it work

A pose keyframe is **storage sugar**. The sampler treats every role independently:

> To sample role *R* at time *t*: find the nearest keys before and after *t* **that carry R**, and
> interpolate with the earlier one's curve. A role carried by exactly one key is **constant**. A role
> carried by no key is **not driven at all**.

Every consequence is one we want:

- *"Fade the dimmer up over 4 s while the pan holds"* = `key0{pan:270, dimmer:0}`, `key1{dimmer:1}`.
  Pan holds because no later key mentions it. No filler keyframes.
- A movement-only sequence leaves colour alone — preserving the existing composition rule that
  `sampleRole` returns `undefined` for a role the source does not carry, so two clips can layer
  movement and colour the way a console layers effects.
- **A take is the degenerate case**: a sequence whose per-role keys happen to be dense. That is what
  lets E1 and E2 share one sampler, and what makes it possible to later express a take *as* a
  sequence and delete the second path entirely.

### Why cues are the invocation layer, and never the storage

**The obvious alternative — store the show as cues** (named looks with fade times, the theatrical
console model) — was evaluated and rejected as the *storage*, then adopted as the *workflow*. Written
down here so the next person with the same reasonable instinct finds the analysis instead of
re-deciding it.

Two code facts settle it:

- [paramPath.ts:216](../src/renderer/services/paramPath.ts#L216) already publishes
  `fixtures.<id>.dmx.<key>` to cues — so "a cue that sets a head's channels" **exists today**. It is
  per-fixture and in **0..1**: forty heads × six roles is 240 entries per cue, and a 0..1 fraction is
  a *different angle* on a different head. That is precisely the head-morphing property role space
  exists to provide.
- [transitions.ts](../src/renderer/services/transitions.ts) runs a cue fade as a wall-clock batch
  (`startMs` → `onComplete`, with retarget semantics). A fade is a **one-way event**, not a function
  of the playhead.

| | Keyframe sequence | Cue-based storage |
|---|---|---|
| **Scrub to author** | pure *f(t)* — drag the playhead, the rig follows | dead. There is nothing *at* t = mid-fade to scrub to |
| **Seek / restart determinism** | state at any T is computable — survives a broadcast-mode relaunch, a watchdog restart, an FSM re-entry | state at T is the cue *history*; a seek cannot reconstruct it |
| **Units / rig swap** | role space, degrees, head morphing | 0..1 per-fixture paths — institutionalises the L6 trap |
| **Group spread** | phase / wing / block / mirror, inherited from the clip | none — a cascade would need the spread engine duplicated inside cues |
| **Movement between looks** | curves, eased or generated | a cue is a *target*; anything between two of them needs a timeline clip again |

And an architectural one: **cue-to-cue pacing already exists in this app, one level up.** A scene
timeline + `holdAtEnd` + a state-machine GO *is* a cue stack — "play this look to its end, freeze,
wait for something to advance it" is documented as the shape the whole interactive-show feature serves
([types.ts](../src/renderer/types.ts) `Timeline.holdAtEnd`). Making cues the lighting storage would
rebuild that pacing layer *inside* the lighting model, in a form that can neither scrub nor seek.

**What the cue instinct gets right, though, is a real gap:** everything in this plan lives inside a
timeline clip, so there is no way to fire a named look *outside* one — busking from the cue grid, the
show-control tablet, an OSC GO, a state's entry action. Closing it is cheap, because both designs turn
out to share one atom:

> **A pose is the cue's content and the keyframe's content.** Cues and keys become two ways to
> *invoke* the same stored look.

That is what the pose library (below) and **E6 · pose cues** are for.

### The pose library

```ts
export interface NamedPose {
  id: string;
  name: string;                 // "verse", "blackout", "warm wash"
  slots: LightingPose[];        // the same slot array a LightingKey carries
}
// ProjectData.lightingPoses?: NamedPose[]
```

**Project-level, not per-Timeline** — which also closes L4 for poses: a look used in five scenes is
stored once, not five times. A `LightingKey` may carry `poseRef?: string` **or** inline `slots`;
`Store key` gains a companion verb **Save pose to library**, and a key created from a library pose
keeps the reference, so re-tuning the pose updates every key that uses it.

Resolution mirrors the fixture-profile order that already works: **inline slots win over `poseRef`**,
and an unresolved `poseRef` drives nothing (never a silent fallback to a plausible-but-wrong look —
the same rule `fixtureFootprint` follows by returning 0).

### It inherits the spread engine for free

`LightingClip` gains `sequenceId?`, mutually exclusive with `takeId`/`effect`. Everything else on the
clip — `groupId`, `phase`, `phaseMode`, `wings`, `blocks`, `mirror`, `scale`, `offset`, `roleMask` —
applies unchanged, because they all operate on *(index, total, time)* and know nothing about where the
value came from.

A phase spread over a **pose sequence** is a cascading look change: head 1 arrives at the new pose,
head 2 a beat later, and so on down the group. Nobody has to build that — it falls out.

### Efficiency, costed honestly

Per *point*, `[{t,v,curve}]` is roughly **3× fatter** than two parallel float arrays. The win is
entirely in point count, so it is only a win where the curve becomes sparse:

| 10 s pan sine, 1° tolerance | points | est. bytes |
|---|---|---|
| RDP linear (today) | 66 *(measured, docs/LIGHTING-SHOW.md)* | ~0.8 KB |
| Bézier-fit keys (E4) | ~6 *(estimate)* | ~0.4 KB |
| Hand-authored pose keys | 3–5 *(estimate)* | ~0.3 KB |

⚠ **Only the first row is measured.** The other two are estimates and must be measured against a
corpus of real takes before ε is chosen for the fitter — the existing `reductionEpsilon()` table is
the standard this repo sets for that kind of number.

So for *movement*, the size win is real but modest (~2×) and **editability is the actual prize**. For
**cue-to-cue** (L5) the win is not modest: a three-minute look change that today can only exist as a
~600 KB recorded take becomes **two keys**.

## Design — the runtime

**One sampler.** Delete `sampleCurve`'s binary search; call `automation.ts`'s `sampleLane`. Its `log`
flag is **always `false`** for lighting — degrees and 0..1 roles interpolate linearly; log space is an
audio-target concern.

Cursors are per **(fixture, role)** — NOT per (slot, role). Part-wrapping lets two fixtures share a
slot while sampling at *different* times (each carries its own `phaseOffset`), and a shared cursor
would ping-pong between their positions every frame: still correct (`seekIdx` falls back to binary
search) but silently O(log n) again, which is the failure mode worth guarding precisely because
nothing visible breaks. The pool is a flat array on `lightingPlayback`, sized per clip at
`targets.length × roles.length`, invalidated on scrub/seek exactly as the automation cursor is.
Honestly stated, the win is: **O(1) within a take cycle, plus one binary search per fixture per
`wrapIntoTake` wrap** — a take's time jumps backwards once per repeat, and the cursor re-seeks there.

**Compiled, not filtered.** The sparse per-role rule ("nearest keys before/after that carry R") must
never run as a per-frame scan over `LightingKey[]` — that is allocation and search on the exact hot
path `lightingOverlay` exists to keep clean. `lightingSequence.ts` **compiles** a sequence into
per-(slot, role) `Keyframe[]` arrays **on edit and on load**, cached against the sequence identity;
the frame loop only ever calls `sampleLane` on precompiled arrays. Editing a key recompiles one
sequence — authoring-rate work, not frame-rate work.

**No new overlay.** `lightingOverlay` already takes `(fixtureId, role, value)` and does HTP/LTP. A
sequence resolves to exactly that. Nothing downstream of the overlay changes — not the packer, not
`profilePack.channelValue()`, not the wire.

**No precedence change.** A lane still beats a clip. Changing that would break the single
"a lane always wins" story that spans audio, surfaces and fixtures — and the fix for L6 is *visibility*,
not inversion (below).

## Design — authoring (this is what the operator sees)

### The loop this exists to serve

> select a light in the list → **place it in the 3D scene** → position it → change its parameters →
> **store the key at the right place in the timeline**

The first four steps are [fixture-kinds.md](fixture-kinds.md) §WS9. This plan owns the fifth, and the
fifth is one verb: **Store key**.

**What "the right place" means.** The playhead. `Store key` writes a `LightingKey` at the current
playhead position, clip-local, into the lighting clip under it. Three cases, and all three must be
answered or the verb is unpredictable:

| At the playhead | Behaviour |
|---|---|
| a lighting clip is under it, on the selected lighting lane | write the key there (replace if one already exists within a frame) |
| a lighting lane exists but no clip under the playhead | **create** a clip starting at the playhead, seed it with a sequence, write key 0 |
| no lighting lane at all | create the lane, then as above |

**Which group does a created clip target?** A lighting clip is meaningless without one, so the rule
follows the recorder's own convention (*"their selection order becomes the take"*):

1. a fixture **group** is selected → use it;
2. else light fixtures are selected → **create a group from the selection, in selection order**, and
   use it — order is the spread axis, so it must be the operator's, never sorted;
3. else → **refuse**, with a toast saying to select the lights first. This is the one refusal left in
   the verb, and it is the right one: storing a key for nobody is meaningless, and inventing a target
   would be worse than declining.

Never silently do nothing. "I pressed Store key and nothing happened" is the failure this table
exists to prevent — and creating the lane is cheap and undoable, whereas hunting for why a keypress
was ignored is not.

**What gets stored.** The **resolved role values** for every fixture of the clip's target group, read
from `fixtureSignal` — the same source `lightingRecorder` captures, which is what guarantees a key
comes out in the same role space it replays in (degrees for pan/tilt, 0..1 otherwise). If every
fixture in the group resolves to the same pose, it is written as **one slot**; otherwise one slot per
fixture. That collapse is where the encoding efficiency actually shows up: a 40-head unison look is
one entry.

**Which roles.** Only roles the operator has *touched* since the last key, plus every role already
carried by the sequence — not every role the profile has. Storing all twenty channels of a head in
every key would pin colour and gobo on a movement-only sequence, destroying the layering property
that `sampleRole`'s `undefined` return exists to protect. A **Store all roles** modifier covers the
"I want a full look here" case explicitly.

### The rest of the surface

**Key diamonds on the clip.** A lighting clip carrying a sequence draws its keys on the clip body,
like ruler markers. Drag to move, right-click for easing, double-click to rename.

**Selecting a key snaps the rig to it.** Free — `lightingPlayback` already subscribes to the playhead
*every frame including while paused*, which is the property the whole authoring loop rests on.

**Store key** is specified above — it is the same verb whether it creates a key or updates the one
under the playhead, so there is one button and one mental model rather than an add/update pair the
operator has to choose between.

**Where the button lives.** On the `3d` context's action bar, beside **Record Lighting Take** — which
already sits there and already requires a fixture selection. The two are the same gesture at two time
scales (an instant vs a stream), and putting them together is what makes the drawer-not-a-context
decision pay off: the rig, the channel strip and the lanes are on screen at once, so `Ctrl+T`,
position, store, scrub, store is a loop without a single context switch. It also gets a keybinding
through the shortcuts registry, because this is a key pressed hundreds of times in a session.

**Expand a role** to get a full curve editor: the same bezier-handle interaction
`AutomationLane.tsx` already implements (367 lines of it), rendering the same `Keyframe[]`. Reuse the
drawing and the handle maths; do **not** reuse its addressing (dot-paths, 0..1 axis) — a lighting
curve is role-space and degrees.

**Two visibility fixes for L6:**
- The lighting inspector badges any role currently shadowed by an automation lane, so *"my keyframe
  does nothing"* is answered on screen instead of in a log.
- `AutomationTargetDef` gains an optional **display transform** (`toDisplay`/`fromDisplay` + `unit`),
  so a `fixtures.<id>.dmx.pan` lane can be *authored in degrees* while still storing 0..1. This is
  exactly the missing piece `automationTargets.core.ts:44` names, and it ends the unit split without
  changing one byte of what is persisted.

## Design — E6 · pose cues (firing a look with no timeline)

A cue entry that names a **pose** and a **group**, rather than 240 dot-paths:

```ts
/** A Cue entry that fires a lighting POSE. Lives beside CueEntry, not inside it. */
export interface LightingCueEntry {
  poseId: string;
  groupId: string;
  fadeSec?: number;
  transition?: CueTransition;   // reuses the existing EASES shapes
}
// Cue.lighting?: LightingCueEntry[]
```

Firing one fades the group **to the pose, in role space**, over `fadeSec`. Three deliberate choices:

- **It gets its own layer, inserted between the clip and the lane** — *not* the live-override layer.
  The existing stack is
  ([lightingOverlay.ts:18](../src/renderer/services/lightingOverlay.ts#L18)):

  ```
  profile default  <  authored Fixture.dmx  <  lighting clip  <  automation lane  <  live override
  ```

  and it becomes

  ```
  profile default  <  authored Fixture.dmx  <  lighting clip  <  POSE CUE  <  automation lane  <  live override
  ```

  Putting a pose cue at the top was the first instinct and it is wrong twice. It would break
  **"a lane always wins"** — the single precedence story this app deliberately keeps across audio,
  surfaces and fixtures — and the top layer means something specific: `livePreview`, the render-free
  channel a *fader drag right now* writes to (`frameEngine.ts:361`). A cue fired by the scheduler at
  3 a.m. with nobody in the building is not a live override. Between clip and lane is what both the
  console model and this codebase's own rule already say: a fired cue beats a clip that happens to be
  running, an explicitly drawn lane still beats the cue, and your hand on a fader still beats
  everything.
- **It reuses `transitions.ts`'s `EASES`, not its engine.** Those fades interpolate over the committed
  `StateView` by dot-path; a lighting cue interpolates role values into a render-free overlay. Sharing
  the easing *shapes* keeps a `smooth` cue on lights feel identical to a `smooth` cue on a surface;
  sharing the *engine* would drag lighting back onto per-fixture 0..1 paths.
- **HTP/LTP merging is already there.** Two pose cues raising a dimmer do not fight; two aiming a head
  resolve latest-wins. No new merge rule.

The payoff is that lighting looks appear, with no further wiring, everywhere the cue system already
reaches: the cue grid, the show-control tablet, OSC, the scheduler, and a state's entry actions.

## ⚠️ Breaking changes (warn loudly)

- **`LightingTakePart.channels[role]` changes shape** (`LightingCurve` → `Keyframe[]`). Normalized on
  load, so old projects are fine — but a project **saved** after E1 carries the new shape and an older
  build reads it as a curve with no `t`/`v` arrays, i.e. **a take that silently drives nothing**. Same
  class as the asset-paths change; it needs a CHANGELOG line and a `version` bump on `LightingTake`
  (it already carries `version: 1`, so this is what that field was for).
- `sampleCurve` is removed from `lightingTake.ts`'s exports. Internal; the throwaway verification
  scripts that call it need updating alongside.
- `LightingClip` gains a third mutually-exclusive source — any code doing
  `clip.takeId ? … : effect` must learn a third arm. Grepped: `lightingPlayback.ts:63`,
  `lightingTake.ts:130`, `LightingClipInspector.tsx`. Three sites.
- **`ProjectData.lightingPoses` is a new persisted array** (the pose library). Additive optional, so
  old projects load — but a project saved with poses is read by an older build as **keys that
  reference nothing**, and an unresolved `poseRef` drives nothing. Same forward-incompatibility class
  as the take shape change above; one CHANGELOG line covers both.
- **`Cue.lighting`** is likewise additive-optional. An older build silently ignores the lighting arm
  of a cue — the cue still fires its ordinary entries, so the failure is partial, not total.
- **No `ProjectData.version` bump** is required for either: both are additive optional arrays with a
  read-site default, per the cross-cutting hazard in [README.md](README.md).

## Risk evaluation — 🟡 **Medium**

- **E1 is the highest-consequence, lowest-uncertainty step.** It re-plumbs what feeds the packer, but
  the correctness bar is exact and cheap: linear-only keyframes must produce **byte-identical
  universes**. If the wire test passes, E1 is done.
- **E4's curve fitter is the only real algorithmic risk.** Constrained least-squares with Newton
  reparameterisation has a well-known failure mode (degenerate tangents on near-collinear runs). It is
  **pure**, so it is provable with a throwaway `tsc`-checked script over a corpus of recorded takes,
  asserting max deviation ≤ ε. And it is optional: the RDP path stays as the fallback.
- **The `cx ∈ [0,1]` constraint is load-bearing and easy to miss.** `Keyframe`'s bezier is a *CSS-style
  timing function*, not a free 2-D cubic: `cx` is clamped so `x` stays monotone and solvable, while
  `cy` is deliberately unclamped — which is how you get overshoot
  ([automation.ts:47](../src/renderer/services/automation.ts#L47)). A fitter that emits an unconstrained
  cubic will produce curves the sampler cannot invert. It also means **one segment cannot hold an
  inflection**, so a full sine period needs a key at each extreme — which is what a human would draw
  anyway, and worth stating so nobody "optimises" it away.
- **Low risk elsewhere**: no overlay change, no packer change, no wire change, no precedence change.

## Migration & back-compat

Additive optional everywhere except `LightingTakePart.channels`, which gets a total, lossless
read-site normalizer (the `normalizeAutomation` pattern at [types.ts:645](../src/renderer/types.ts#L645)
is the precedent — it already coerces junk, defaults `curve`, and sorts). Existing takes replay
identically because a linear-only keyframe list *is* the old curve.

## Verification (repo patterns — no unit runner)

1. **The E1 gate — byte-identical wire.** `--headless --project=<the verified four-MAC show>` + the
   `dgram` ArtDmx listener, before and after. The existing hardware-verified numbers in
   docs/LIGHTING-SHOW.md (`pan ranges 113,113,113,113`; `correlation 0.00,-1.00,-0.00`; `DMX 71..184`)
   are the exact regression target — this is the rare case where the acceptance test is already
   written down and already passed once.
2. **Port the 30 hand-computed sampler checks** to the new sampler before touching playback. They
   cover curve interpolation, all five forms, every spread mode, take wrap, scale/mirror, role masking
   and reduction — they are the spec.
3. **New hand-computed checks for the sparse-role rule** (E2): a role in one key is constant; a role
   in no key returns `undefined`; a role in keys 0 and 2 but not 1 interpolates *across* key 1; per-key
   `roleCurves` overrides the key's own `curve`.
4. **Fitter corpus test** (E4): fit → sample → compare against the source samples; assert max
   deviation ≤ ε for every role of every take in a corpus, and **report the point counts**, so the
   table in this plan gets replaced by measurements.
5. **In the app — the whole loop, timed.** Place four heads in 3D (fixture-kinds §WS9), group them,
   then: playhead to 0 s ▸ aim them ▸ **Store key** ▸ playhead to 4 s ▸ re-aim ▸ **Store key** ▸ scrub.
   The rig must sweep between the two poses. Then set the first segment to `hold` and confirm it steps
   instead. Then `phase 0.5` and confirm the cascade. **All three cases of the Store-key table must be
   exercised**, including pressing it with no lighting lane in the project at all.
6. **In the app**: `hold` then `bezier` on adjacent segments, scrubbed slowly — step, then ease.
7. **Perf**: `core.dock.perf` before/after with 40 heads × 6 roles, confirming the cursor pool removes
   the per-frame search cost rather than merely moving it. Include a **phased** clip whose take is
   shorter than the clip, so the `wrapIntoTake` re-seek is actually exercised — an unphased,
   non-wrapping test would report a win the show never gets.
8. **E6, no timeline at all**: save a pose, put it on a cue cell, fire it from the grid — the group
   fades to it over `fadeSec`. Then fire it from the **show-control tablet** and from an FSM entry
   action, confirming it needed no per-surface wiring. Then fire it *over a running lighting clip* and
   confirm the **cue wins**; then draw an automation lane on one of those channels and confirm the
   **lane still wins over the cue**; then drag that channel's fader and confirm the **drag wins over
   both**. Those three checks are the inserted layer, and getting any of them backwards is invisible
   until a show. Clearing the cue must release back to the clip rather than latching (the same
   trailing-empty-frame rule `lightingPlayback` already follows).
9. **E6 pose resolution**: a key with an unresolved `poseRef` must drive **nothing** — not a fallback
   look. Verify by deleting a library pose that a key references.

## Effort & phasing — **L**

| Phase | Content | Ships alone? |
|---|---|---|
| **E1 · One curve format** | `Keyframe[]` in takes, legacy normalizer, swap to the cursor sampler, cursor pool | Yes — **invisible**, and closes L1 + L7. The wire test is the whole gate. |
| **E2 · The sequence** | `LightingSequence`/`LightingKey`, per-role sparse resolution, `clip.sequenceId`, playback | Yes — headless-verifiable with **no UI at all** (hand-write a sequence into a `.artlux`). Closes L5. |
| **E3 · Authoring** | **Store key** (+ the three-case table), key diamonds, snap-to-key, per-key easing, role expansion | Yes — **this closes the operator's loop**, and it is the half of it this plan owns. |
| **E4 · Capture as keys** | the constrained Bézier fitter | Yes — closes L2 + L3; recordings land editable. |
| **E5 · The traps** | lane-shadow badge, degrees display transform (L6), take library placement (L4), group-kind gate (L8) | Yes, individually. |
| **E6 · Pose cues** | `NamedPose` library on `ProjectData`, `poseRef` on a key, **Save pose to library**, `Cue.lighting`, the role-space fade into the live-override layer | Yes — and it is what puts lighting on the **cue grid, the tablet, OSC and FSM entry actions**. |

**E1 → E2 → E3 is the spine.** E4 and E5 are independent of each other and of E3. E5's group-kind gate
needs Wave A of [fixture-kinds.md](fixture-kinds.md).

**E6 depends on E2 and nothing else** — it needs `LightingPose` to exist as a type, not the whole
authoring surface. It can therefore land before or after E3, and if firing looks by hand matters more
than editing them on a timeline, it should go first. Its half of the pose library (the `NamedPose`
array + resolution order) is the same code either way.

## Open questions / decisions

1. ~~Should the library live on `ProjectData`?~~ **Decided (2026-07-27): yes, for poses** — E6 puts
   `lightingPoses` there, because a cue fired from the tablet or an FSM entry action belongs to no
   timeline at all, so a per-`Timeline` library could not hold its content. **Still open for takes and
   sequences**: they are timeline-shaped, so L4's duplication argument is weaker for them. Deciding to
   move them is E5; deciding *not* to is also fine, and then L4 stands as a known cost.
2. **Is a pose a Scene?** No — a `Scene` is a whole-look snapshot including surfaces, projector outputs
   and a whole timeline; a pose is one group's role values. But they overlap enough that the boundary
   should be *decided* rather than discovered, or "capture look" will end up meaning two things.
   **Sharper now that E6 exists**: a scene recall and a pose cue can both change the rig, and a scene
   snapshot captures `fixtures[]` including their `dmx` — so recalling a scene while a pose cue holds
   the live-override layer is a precedence question the E6 work must answer explicitly, not discover.
3. **Relative poses?** A key meaning *"+30° pan from wherever you are"* is genuinely useful for
   layering and impossible in the absolute model. It also makes the sampler stateful, which is how
   scrubbing breaks. Recommend **absolute only** in v1, and say so in the type.
4. **Does `LightingEffect` survive?** Yes — analytic, free, and nothing about it is wrong. The
   interesting option is making it a **generator that emits keys** (bake a sine to keyframes, then
   hand-tune), which would collapse three sources back to two.
5. **Does Store key respect the clip's `phase`?** A phase-spread clip means head 3 is a beat behind
   head 1, so "what the rig looks like now" is **not** any single key — it is one key sampled at four
   different times. Storing the visible pose into a phased clip would therefore bake the spread into
   the data and then spread it *again* on playback. Options: refuse (badge "clear the phase to store"),
   store the *un-phased* pose by inverting each slot's offset, or store per-slot as seen. **Recommend
   inverting the offset** — it is the only one that round-trips — but it must be decided before E3,
   not discovered during it.
6. **What happens when the group changes size under a sequence?** Slots wrap (the take rule), so it
   degrades rather than breaking — but adding a 5th head to a 4-slot look silently gives it slot 0's
   pose. Worth a badge, and worth deciding whether wrap is right for *poses* as it is for *parts*.
