# Driving a fixture (or a group) from a set of curves — the "super track"

> **Status: SUPERSEDED IN PART, AND PARTLY BUILT. 2026-09-10.**
>
> ⚠ **The address-space decision below was NOT what shipped.** This plan proposed extending the
> lighting clip and widening `LightingTakePart.channels` to carry channel keys. What was built instead
> lets the address space FOLLOW THE TARGET: a **single-fixture** super track is a grouped view over
> `fixtures.<id>.dmx.<key>` **automation lanes**, which need no format change, reach every channel
> (including a second gobo wheel and `unknown`, which role space cannot name), sit ABOVE a lighting
> clip in precedence — so this plan's trap (A) cannot happen — and carry no HTP or `scale`/`offset`
> hazard. Shipped in `523fa1c`, on top of the four extractions in `e2c394c`, `ddfc6b4`, `30b4bb0`,
> `08d65fb`, plus auto-key in `c8ed116`.
>
> **What is still live in this document is the GROUP route** — a take-backed track over an ordered
> group, in role space, with phase spread — which remains unbuilt and still wants the slot selector,
> the shared-take badge, cursor invalidation and an honest "N channels not addressable by role" state.
> The traps, the measured library numbers and the verification patterns below all still hold.
>
> Original header follows.
>
> **Status: PLAN — nothing built. 2026-09-10.**
> Goal, in the owner's words: *"drive a light fixture or a group of fixtures via a set of curves
> depending on the parameters of the fixture … basically a super track exposing all the params where
> we can put keyframes and edit them."*

Companion to [lighting-keyframes.md](lighting-keyframes.md) (what pose keys were meant to be) and
[lighting-rework-status.md](lighting-rework-status.md) (what shipped, and how each claim was proved).
Read those first; this plan assumes them.

---

## The finding that changes the shape of this work

**The data format already exists, and it is exactly what was asked for.**

```ts
LightingTakePart.channels: Partial<Record<ChannelRole, Keyframe[]>>   // types.ts:1677
LightingTake.parts: LightingTakePart[]                                // ordered — the group axis
```

A take is *already* "a set of curves, one per parameter, per slot of a group". It uses the **same
`Keyframe`** an automation lane uses (`t`, `v`, `curve`, bezier handles) — that was the entire point
of commit `1fbc92c` *"one curve format — a take stores keyframes"*. And `sampleRole()` already gives
us, for free, everything a super track needs at playback time:

| Already built | Where |
|---|---|
| per-role sparse sampling (an absent role is **not driven**, not zeroed) | `lightingTake.sampleRole` |
| the group axis, with `parts` wrapping so 1 part fans across 40 heads | same |
| phase spread / wing / block / random / mirror / scale / offset / roleMask | `phaseOffset`, `sampleRole` |
| O(1) cursor sampling, keyed per (clip, fixture, role) | `lightingPlayback.cursorFor` |
| scrub-live playback (subscribes every frame, even paused) | `lightingPlayback.tick` |
| role→channel conversion using **each fixture's own range** (head morphing) | `profilePack.valueFromPhysical` |
| a full curve editor — drag, bezier, typed entry, display units, commit-on-release | `timeline/AutomationLane.tsx` (578 lines) |
| per-channel axis + degrees display map, derived from the profile | `automationTargets.core.profileChannelRange` |

**So this is not an engine problem. It is an authoring-surface problem.** That is good news and it
should be stated plainly, because the instinct here is to design a new object, and a new object would
duplicate `sampleRole` and then drift from it.

## What is genuinely missing

Today a `LightingTake` can only come into existence by **recording a busk** and reducing the capture
(`lightingRecorder` → `reduceCurve`, RDP). There is no way to:

1. **create an empty take from scratch** — every take is a recording of something that already happened;
2. **see its per-role curves** on the timeline (a lighting clip draws as a solid block, or as pose diamonds);
3. **add / move / delete / re-ease a keyframe** on any role;
4. **add a role the recording never captured** (record a pan sweep, then draw the dimmer by hand);
5. **target a single fixture** — `targetsOf()` returns `[]` when `groupId` is absent, so a clip with no
   group drives nothing at all (`lightingPlayback.ts:64`).

The only per-key authoring that exists is the **pose-key diamond** (a `LightingSequence`), and that is
a different verb: it stores *a look across the group at time t*, not *a curve per parameter*. Both are
wanted; they are not substitutes. A pose key answers "at 0 s it looks like THIS"; a super track answers
"pan does this bezier while the dimmer holds and the zoom ramps".

---

## The design

**A super track is a lighting clip, expanded.** No new persisted object, no format change in phase 1.

```
▾ Heads · Sweep A · 8 fixtures · phase 0.25s spread          [clip header row]
    ▾ Position
        Pan     ╭─────╮      ╭─────╮          0 … 540 °      [curve row]
        Tilt    ────────╮___________          0 … 270 °      [curve row]
    ▾ Intensity
        Dimmer  ______╱‾‾‾‾‾‾‾‾‾‾‾‾‾          0 … 1          [curve row]
    + Parameter
```

- The **track header** is the clip: its target (group *or* fixture), its spread controls, its take.
- Each **curve row** is one `ChannelRole`, drawn from `take.parts[slot].channels[role]`.
- Rows are **sparse by default** — only roles the take actually carries — because that is already the
  data model, and because 20+ channels × 64 px is 1300 px of lane nobody can use.
- `+ Parameter` adds a role: creates an empty `Keyframe[]`, which is what makes authoring-from-scratch
  possible without a new object.
- Rows group by **attribute** (Position / Intensity / Colour / Beam / Gobo / Control). The
  `ChannelRole` union already partitions almost exactly along these lines — see its own comment
  headings in `protocol.ts:1039-1058`. Do not invent a second taxonomy; derive it from that union.

### Which slot am I editing?

A take has `parts[]`, one per group slot, and they **wrap**. Editing needs an explicit answer, and
the honest one is a **slot selector on the track header**, defaulting to *All*:

- **All** (default) — the take collapses to **one part**; a curve edit drives every fixture, spread by
  phase. This is the common case and the reason a 40-head look costs one curve, exactly as
  `LightingKey.slots` documents for poses.
- **Slot N** — edit that part alone, promoting a 1-part take to N parts on the first per-slot edit.

Do **not** show 8 stacked copies of Pan for an 8-head group. That is the failure mode this design is
avoiding, and it is the same one `LightingKey`'s one-slot default already avoids for poses.

### The axis a curve is drawn against

Role values are stored in **role units** (degrees for pan/tilt, 0..1 otherwise) and converted per
fixture on the way out. So the drawing axis is a **display** decision, not a storage constraint.

Take it from the group's **first resolvable fixture** (the *reference fixture*), reusing
`profileChannelRange`'s logic, and **name it in the row** ("0…540°, per Head 1"). Fall back to a
canonical role axis only when nothing resolves. This is honest about the thing that makes role space
worth having: a curve drawn to 500° stays 500° when retargeted, and lands correctly on a 630° head.

---

## Decisions, and the alternatives rejected

**1. Extend the lighting clip — do not add a `FixtureTrack` object.**
Rejected: a new persisted type with its own `role → Keyframe[]` map. It would need its own sampler, and
that sampler would be a second implementation of `sampleRole`'s spread/wrap/scale/mirror/sparse rules.
This repo has the scar: `roleValue()` existed three times and **had already drifted from its own list**
(both copies of the captured-role list named `white`; no copy of the switch handled it, so every
consumer silently dropped a role the list promised). One sampler, or it drifts.

**2. Extract a shared `CurveEditor` — do not fork `AutomationLane.tsx`.**
The curve *body* (polyline from `Keyframe[]`, key drag, the editor popover, `fmtIn` display
formatting, `BEZ_DEFAULT` handles) is generic; what is lane-specific is `targetPath`, the registry
`def`, `sampleLane`, and `onChange(lane)`. Extract the body to take `{ keyframes, axis, onChange }`
and render it from both. This is a **refactor of show-critical code** and is the largest single risk
in the plan — it is phased first, alone, so it can be proved before anything is built on it.
Rejected: copy-paste. Two curve editors would disagree about bezier handles within a release.

**3. Phase 1 is roles only. Say plainly which channels are unreachable.**
`ChannelRole` cannot address: a **second gobo wheel** (both channels are `goboWheel`), macro/control
channels, and anything mapped `unknown`. Reaching those means widening `channels` to
`Record<ChannelRole | 'ch:<key>', Keyframe[]>` — a **file-format change** touching `rolesOf`,
`sampleRole`, `centreOf`, the recorder, the fitter and every take on disk. Last time the format moved,
five fields became silently unreadable by older builds (see the forward-incompat list in
[lighting-rework-status.md](lighting-rework-status.md)). Not in the same phase as a new UI.
**Phase 1 must show a "N channels not addressable by role" note on the track**, or the operator will
believe the track exposes *all* params — which is what they asked for — and quietly not find Gobo 2.

**4. A take stays SHARED, with an explicit "Make unique".**
Two clips can reference one `takeId`; editing a curve edits the take, so it changes every clip using
it. That is a feature (fix a sweep once) and a footgun (edit here, break there). Mirror how the app
already treats referenced things: **badge a take with >1 user** and offer *Make unique* before the
first edit. Rejected: silent copy-on-write, which makes "fix it once" impossible and is the reason
people distrust NLE nested sequences.

**5. A single fixture is a target, not a group of one.**
`targetsOf()` requires `groupId`. Allow `LightingClip.fixtureId` as an alternative target and resolve
it to a one-element list — `sampleRole` already handles `total = 1`, and `index/total` need no change.
Rejected: auto-creating a hidden one-member `FixtureGroup` per fixture. Groups are operator-facing rig
structure; the browser would fill with junk, and a scene recall already had to learn to leave `groups`
alone once (it deleted the group a clip targeted — the bug that "bites this feature set hardest").

---

## The traps — each one will bite

**A. An automation lane silently wins, per channel.**
`frameEngine.ts:621` asks `automationOverlay.owns('fixtures.<id>.dmx.<key>')` and returns `undefined`
from the role override when true. Precedence is fixed and correct — *a lane always wins* — but the
consequence for this feature is specific: an operator who once drew a Pan lane on Head 3 will draw a
beautiful Pan curve on the super track and **Head 3 will not move**, with nothing on screen saying why.

The clip inspector already names roles a lane is winning (status doc, item 1). **The super track must
show it per-row, per-fixture** — a shadow badge on the Pan row reading "Head 3: overridden by a lane".
This is not polish; it is the difference between the feature working and the feature being reported
as broken.

**B. Clips layer, and later wins per role.**
`activeClips()` returns every lighting clip under the playhead. Two super tracks over the same group
is legal and useful (movement from one, colour from another) — but two tracks both carrying `pan`
means the later one wins, invisibly. The row needs the same shadow treatment as (A) for intra-lighting
conflicts.

**C. The cursor pool must not be invalidated by editing.**
`cursors` is keyed `clip|fixture|role` and cleared when the active clip set changes. Editing a curve
mutates the array those cursors index into. A stale cursor is *correct but silently O(log n)* — the
kind of regression nothing visible reports. **Any curve edit must clear the cursors for that clip.**

**D. Commit on release, never per pointermove.**
`AutomationLane` documents this: a commit re-enters App → setScenes → `timelineEngine.setData` →
recompile. At 60 Hz during a drag that is brutal. The extracted editor must keep the local-`draft`
+ commit-once discipline, and the rig should follow the drag through the **live** path, not through
document state.

**E. `--headless` / `--broadcast` must be unaffected.**
The super track is authoring only. Playback already works; nothing here may add a mounted-component
dependency to output. Guarded already by the frame-loop invariants — but this feature touches the
timeline, which is where that rule is easiest to break.

---

## Phases

**P0 — Extract `CurveEditor` from `AutomationLane.tsx`.** No behaviour change, no new feature. Prove
by driving an existing automation lane before and after: same polyline, same drag, same popover, same
formatted values. *This lands alone.*

**P1 — Read-only super track.** Expand a lighting clip to draw its take's per-role curves, grouped by
attribute, sparse, with the reference-fixture axis. No editing. Proves the rows agree with what the
rig is doing (draw the curve, scrub, watch the head).

**P2 — Editing.** Key add / move / delete / ease per role, `+ Parameter` (empty curve), the slot
selector, cursor invalidation, shared-take badge + *Make unique*.

**P3 — Authoring from nothing.** "New lighting track" on a group or a fixture → an empty take → draw.
Plus `LightingClip.fixtureId` single-fixture targeting.

**P4 — Shadow reporting.** Per-row, per-fixture badges for traps (A) and (B).

**P5 — (separate decision) channel-key rows.** The format widening. Only if P1–P4 prove the shape is
right, and only with a written forward-incompat note.

---

## How to prove it (there is no test runner)

Follow the patterns that worked on this feature set last time — the harnesses were throwaways and are
deleted, but the methods hold:

- **Off the wire, not off the log.** `prefs.appSettings = { outputEnabled: true, artNetIp: '127.0.0.1',
  artNetPort: 6469 }` **before** launch; bind 6469 and parse `Art-Net\0` + opcode `0x5000`.
  **Never bind 6454** — the app's own Art-Net input owns it. Allow **~15 s** before the first frame.
- **The USB widget is now a real verification path.** Output over ENTTEC was confirmed working on real
  hardware (2026-09-10), so a moving head on a real wire is available as ground truth for anything the
  UDP capture cannot settle — which is most of what "did the head actually go there" means.
- **Pure logic** — `npx esbuild test/x.ts --bundle --platform=node --format=esm` then `node`.
  `--experimental-strip-types` does **not** work here (extensionless imports).
- **The UI** — CDP (`ARTLUX_CDP_PORT`), and *ask the DOM what it rendered*. Click the rail entry first:
  the workspace layout is banked per context, so a probe that assumes it opens in Mapping reads the
  wrong panel. Never point a fuzzy selector at a destructive control.

**Add invariants as you go** — that is how this subsystem's rules are kept. Candidates:
`a curve edit invalidates that clip's sampler cursors`; `the super track and the automation lane share
one curve editor`; `a lighting clip resolves its targets in ONE place`.

---

## The documentation gate

A super track is a **net-new feature**, so [CLAUDE.md](../CLAUDE.md)'s rule applies: the usage page
ships in the *same commits*. It belongs in [docs/LIGHTING-SHOW.md](../docs/LIGHTING-SHOW.md) — which
is a `hybrid` page, so mind the `<!-- audience: -->` seams — and the examples in
[examples/lighting/](../examples/lighting/README.md) are the natural place for a walkthrough.
`npm run verify` must pass, including `verify:docs`.
