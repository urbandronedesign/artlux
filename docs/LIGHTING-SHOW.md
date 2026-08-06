# ArtLux — Encoding a light show

How movement is authored, stored and replayed for **DMX fixtures** (moving heads, washes, beams).
Fixture profiles themselves are [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md); this is what makes them move.

## The problem

Forty heads with twenty channels each is 800 parameters. Nobody draws 800 curves. A console solves
this by encoding an **effect** — a form, spread across an ordered selection by a phase — and storing
the *generator plus the spread*, not the result.

ArtLux has something no console has: a real NLE timeline. So a light show here is

> a fixture-agnostic **movement**, instanced onto an ordered **group** by a timeline **clip** that
> spreads it in time.

A clip can play that movement from **three sources**, and they exist because each answers a question
the others cannot:

| Source | What it is | Where it comes from |
|---|---|---|
| **take** | a *recording* of a busk | you moved the rig with your hands |
| **effect** | a *generator* — form, role, centre, amplitude, period | you described a shape |
| **sequence** | *authored* pose keys — "at 0 s the group looks like THIS, at 4 s like THAT, ease between" | you built it, key by key |

The sequence is the one you can edit, and the gap it filled is the most ordinary request in lighting:
a show could be busked or phased but, until pose keys, never **authored**. Where a project carries
more than one, resolution order is **sequence → take → effect** — the authored thing is the one the
operator most recently meant.

## Role space — the decision everything else rests on

A take stores values by **what a channel means** (`pan`, `tilt`, `dimmer`), never by channel number,
and **pan/tilt are in degrees**.

That is what makes a take assignable to a group at all — the fixtures need not be the same model. It
is also what makes a show survive a rig change: a movement recorded on a 540° head replays as the
same *angle* on a 630° head, not the same fraction of travel. Consoles call this **head morphing**.

The conversion from role space to a specific fixture's channel value happens in `channelValue()`
([profilePack.ts](../src/renderer/services/profilePack.ts)), using that fixture's own declared range.

## The pieces

| Type | What it is |
|---|---|
| `LightingTake` | recorded movement: `parts[]`, each `{ channels: Partial<Record<ChannelRole, Keyframe[]>> }` |
| `LightingEffect` | a *generated* movement — form, role, centre, amplitude, period. No recording behind it |
| `LightingSequence` | authored `keys: LightingKey[]` — one **pose per slot** of the group at each moment |
| `LightingPose` | `Partial<Record<ChannelRole, number>>` — **sparse**: an absent role is not driven |
| `NamedPose` | a named reusable pose on `ProjectData.lightingPoses`. The one atom keys and cues share |
| `LightingClip` | a `VideoClip` with `kind: 'lighting'`: which take/effect/sequence, onto which group, with what spread |
| lighting lane | `VideoLayer` with `kind: 'lighting'` |

### One curve format in the app

A take part stores the **same `Keyframe`** an automation lane stores — not a sampled `{t[], v[]}`
polyline. So a take is sampled by the same O(1) cursor sampler, can carry hold/bezier segments, and
can be drawn by the same editor. Values stay in the **role's own unit** (degrees for pan/tilt, 0..1
otherwise), which is exactly what `Keyframe.v`'s "the target's native units" already meant.

`LightingCurve` (the old `{t[], v[]}`) survives as **read-only legacy**: the normalizer converts one
on load, and nothing writes it. That is invariant-guarded — reintroducing a second curve format is
the failure this replaced.

### Parts, and why a take is a list

A take with **one** part is a single movement fanned across however many fixtures the clip targets.
A take with **eight** is a recorded eight-fixture chase, kept intact. Part *i* drives fixture *i* of
the group, wrapping. One format covers both.

### The spread is the effect engine

[lightingTake.ts](../src/renderer/services/lightingTake.ts) `phaseOffset()` delays fixture *i* by:

| mode | behaviour |
|---|---|
| `spread` | linear — `phase × i`. A chase or a wave |
| `wing` | mirrored outward from the centre in *N* wings. The symmetric look |
| `block` | fixtures move in *N* blocks, in step within each block |
| `random` | stable per index, so the "random" spread is identical every playback — a show must repeat |

Plus `mirror` (flips pan about its centre for the back half of the group), `scale` and `offset`.

**Group order is the spread axis.** Nothing in the lighting path ever sorts a group — the order the
operator built is the order the wave travels in, exactly as a console's selection order is.

## Pose keys — authoring a look

A `LightingSequence` is a list of moments. Each `LightingKey` carries `t`, one `LightingPose` per
**slot** of the target group (same index-wraps axis a take's `parts` use), an optional easing `curve`
plus `roleCurves` for per-role overrides, and an optional `name` — which is a cue label, and belongs
here.

**One slot means the whole group.** A forty-head unison look costs one entry, not forty, and stays
assignable to a group of a different size. `poseForGroup()` collapses to one slot whenever every
fixture agrees, so this is the normal case rather than an optimisation you have to reach for.

### The sampling rule is per-role and sparse

> To sample role R at time t, use the nearest keys before and after **that carry R**.

Every consequence is deliberate: a role in exactly one key is constant, a role in **no** key is not
driven at all. So "fade the dimmer up over 4 s while the pan holds" is two keys and no filler; a
movement-only sequence still leaves colour alone (preserving the layering that `sampleRole`
returning `undefined` exists to protect); and a take is simply the degenerate case where every
role's keys happen to be dense.

That also makes **removing** a role from a key a distinct verb from **zeroing** it: an unmentioned
role interpolates *across* the key, a zeroed one drags the curve to black.

### Compiled on edit, never resolved in the frame loop

Evaluated live, "the nearest keys that carry this role" is a scan over every key, per fixture, per
role, per frame — allocation and search on the exact hot path `lightingOverlay` exists to keep clean.
So [lightingSequence.ts](../src/renderer/services/lightingSequence.ts) applies the rule **once**, on
edit and on load, into per-slot/per-role `Keyframe[]`; the frame loop only ever calls `sampleLane` on
a plain array that is already correct. Invariant-guarded.

The cache is a **`WeakMap` on the sequence object**. State here is immutable, so a changed sequence
misses the cache and recompiles *by construction* — there is no revision counter to forget to bump,
and a dropped sequence is collected along with its compilation. It is keyed on the pose library too,
so editing a `NamedPose` cannot leave a key that references it frozen on the old look.

### `poseRef` — a key that plays a library pose

A key may name a `NamedPose` instead of inlining slots. **Inline wins** where both exist, and an
**unresolved ref drives nothing** — never a fallback to a plausible other look, the same rule
`fixtureFootprint` follows by returning 0 for an unresolved profile.

The consequence for editing: a `poseRef` key is **not** editable slot-by-slot on the clip, because
inline slots win and writing them would silently promote the key off the look it was sharing with
four other scenes. The inspector says so rather than doing it.

## Precedence

```
profile default  <  authored Fixture.dmx  <  LIGHTING CLIP  <  POSE CUE  <  automation lane  <  live override
```

A clip ranks **below** a hand-drawn automation lane deliberately: it matches the rule the rest of the
app already follows ("a lane always wins"), so there is one precedence story across audio, surfaces
and fixtures. Enforced in exactly one place — the packer asks `automationOverlay.owns(path)`
before consulting the lighting overlay.

**A pose cue sits between the clip and the lane**, and the two obvious alternatives are both wrong.
Putting it on top would break "a lane always wins"; and the top layer means something specific —
`livePreview`, the render-free channel a fader drag writes to, which a cue fired by the scheduler at
3 a.m. with nobody in the building is not. Between clip and lane is what the console model and this
codebase's own rule both say: a fired cue beats a clip that happens to be running, an explicitly
drawn lane still beats the cue, and your hand on a fader beats everything. Invariant-guarded.

Within the lighting layer, overlapping clips merge **HTP for intensity-like roles** (dimmer, colour
emitters) and **LTP for everything else**. Two clips raising a dimmer should not fight; two clips
aiming a head must not average into a position neither asked for.

<!-- audience:contributor -->

## Why a separate overlay

[lightingOverlay.ts](../src/renderer/services/lightingOverlay.ts) is a nested map keyed by fixture and
role, double-buffered and rewritten each frame — not dot-paths like
[automationOverlay](../src/renderer/services/automationOverlay.ts). A clip addresses a whole group by
role; writing forty fixtures × twenty roles as freshly-built path strings every frame would be pure
garbage generation on the hot path.

<!-- audience:operator -->

## Playback

[lightingPlayback.ts](../src/renderer/services/lightingPlayback.ts) subscribes to the engine playhead
**every frame, even while paused**, so scrubbing moves the rig — a show is authored by dragging the
playhead and watching. It publishes one empty frame when the last clip ends, so the rig *releases*
back to its authored values instead of latching on the final pose.

A take shorter than its clip **repeats**, which is what makes a two-second movement usable as a
thirty-second look — and is required anyway, since a phase-delayed fixture is sampled past the end.

## Pose cues — firing a look with no timeline involved

Keyframes are the **storage** of a light show: scrubbable, seekable, spreadable. What they cannot do
is fire a named look from *outside* a timeline — from the cue grid, the show-control tablet, an OSC
GO, or a state's entry action. `Cue.lighting?: LightingCueEntry[]` is that, and it works because both
models share one atom: **a pose**. Keys are the storage, cues are the invocation.

```ts
LightingCueEntry { poseId; groupId; fadeSec?; transition? }
```

[lightingCue.ts](../src/renderer/services/lightingCue.ts) is **render-free** like every other overlay
here: the fade animates at frame rate by being *sampled*, not by pushing React state. Its semantics,
each hand-checked:

- **fade from held** — a cue fades from whatever the fixture is *currently* showing, not from the
  profile default;
- **re-target** — firing a second cue at the same group while the first is mid-fade re-aims from the
  live value rather than snapping;
- **slot wrap** — a 2-slot pose on a 6-head group repeats, as everywhere else;
- **an unresolved `poseId` or `groupId` drives nothing** — no substitute look;
- **clear is a release**, not a write of zeros: the layer stops contributing and the clip (or the
  authored `dmx`) is what shows again.

The arm is optional and additive, so an older build ignores it and still fires the cue's ordinary
`entries`.

## The authoring loop — Store Key

> select a light → place it in 3D → aim it → change its parameters → **Store Key**

Everything before the last step is fixture and 3D work. `Store Key` (the **3D** action bar, next to
*Save Pose* and *Record Lighting Take* — the same capture at three time scales: one instant, one named
instant, one stream) is the last step, and it asks one question: *what does the
group look like right now, and where on the timeline does that go?*

[lightingStoreKey.ts](../src/renderer/services/lightingStoreKey.ts) is **pure** — it decides, the
caller mutates — which is what makes the table below checkable with no timeline, no rig and no
running transport:

| Situation | What one press does |
|---|---|
| a lighting clip under the playhead | writes the key into its sequence, replacing a coincident one (within 1/30 s — a click cannot mean two keys) |
| a lighting lane but no clip there | creates the clip + a sequence, writes key 0 |
| no lighting lane at all | creates the lane too, then as above |

**It never silently does nothing.** *"I pressed it and nothing happened"* is the failure that table
exists to prevent; creating a lane is cheap and undoable, hunting for why a keypress was ignored is
not. The one refusal left is having **no lights selected** — a key for nobody is meaningless, and
inventing a target would be worse than declining. It also reuses an existing group whose membership
matches the selection *in that order*, so a second press does not mint "Group 2", "Group 3"…

Selection order is the show, here as everywhere in this document: nothing sorts.

⚠ **Store Key stores what you SEE, and phase will be applied again on playback.** The plan wanted to
invert each slot's offset when storing; that does not work, because inverting properly means writing
slot *i* at curve time `t − phase×i` — N keys at N times, not one key — so it does not round-trip
either. What ships instead is a warning. In practice you are busking when you store, and phase is
normally added after the looks exist.

## Editing a stored key

A diamond drawn on a lighting clip is a **button**. Clicking one selects the key, seeks the playhead
to it — the rig live-scrubs, so you see the look land on the fixtures — and the clip inspector grows
a **Key** section: one row per slot, *named after the group's fixture at that index*, with a number
input per role in **role units** (degrees for pan/tilt/zoom).

No display map here, unlike an automation lane: a pose already stores degrees.

Two things the shape of the data forced:

- the selection is keyed by **(clip, time), not index** — Store Key re-sorts `keys` on every insert,
  so an index would silently point at a different key;
- a `poseRef` key is not editable here (see above); it says so.

> The bug this found is why the invariant exists: every prop on that four-file chain is optional, so
> `Lane` drew the diamonds while `Timeline` never passed `onSelectKey` — and the typecheck was green
> over a diamond that did nothing. `a pose key drawn on a clip can be selected and edited` now
> asserts the whole chain.

## Using it

1. Timeline → **Lighting lane**.
2. **Right-click** the empty lane → a clip appears, already carrying a slow pan sine. (It is created
   with a generated movement on purpose: a clip that does nothing until you have recorded something
   is a dead end the first time anyone tries the feature.)
3. Select the clip → the inspector asks the four questions in order: *what moves* (generated form, a
   take, or a pose sequence), *who moves* (the group), *how it spreads* (phase, mode, mirror), *how
   much* (scale, offset). It also **names any role an automation lane is already winning**, so a clip
   that appears to do nothing explains itself instead of being debugged.

Or skip all of it and press **Store Key** — case 3 above builds the lane, the clip and the sequence
for you.

<!-- audience:contributor -->

## Verified

Four MAC 250s in one group, a sine on pan (centre 270°, swing ±120°, period 4 s), phase 1 s per head
— captured off real Art-Net from a headless run:

```
head pan ranges .................. 113, 113, 113, 113   (identical movement)
correlation vs head 1 ............ 0.00, -1.00, -0.00   (quarter-cycle spread, head 3 antiphase)
pan span ......................... DMX 71..184 = 150°..390°   (exactly the authored sweep)
```

The sampler itself has 30 hand-computed checks (curve interpolation, all five forms, every spread
mode, take wrap, scale/mirror, role masking, curve reduction) — see DEVELOPMENT.md → Testing for the
throwaway-script pattern. The pose layer added 19 more for the sparse per-role rule (a role skipping
a key and interpolating *across* it, per-role curve overrides, slot wrapping) and 18 for the cue
layer (slot wrap, fade-from-held, re-target, unresolved drives nothing, clear-as-release).

**The move to one curve format did not change the wire**: that same four-MAC capture was reproduced
after it, byte for byte — ranges `113,113,113,113`, correlation `-0.06, -1.00, 0.06`, span DMX
71..184. A hand-built legacy `{t,v}` project still replays too (DMX **210** on all four heads =
444.7° on a 540° head), which is what `LightingCurve`'s read-only survival buys.

A sequence was proved the same way, headless and with no UI: pan 150°→390° landed on **DMX 71..184**
with a phase stagger of `173/144/116/88` ≈ the 28.25 predicted. And a pose cue beating a running
clip, on the wire: `[71,71]` → fire → `[184,184]`.

<!-- audience:operator -->

## Recording

**Do it in Venue & Rig** (the `3d` context) — the workbench this loop was shaped around, because it is
where you can see the heads you are busking. Select them in the 3D scene, aim them, then use any of:

- the **Lighting Takes** dock panel — its *Arm* line tells you how many fixtures are armed before you
  commit, and it holds **✕ Cancel** for a take you want to throw away;
- **Record Lighting Take** on the action bar, which shows REC and an elapsed clock while capturing;
- **Ctrl+Shift+R**, from any workspace at all.

All three drive the same `services/lightingRecorder` singleton, so they cannot disagree about whether
it is armed, and all three commit through `services/takeRecorder`, so the finished take always lands in
the document you were recording into. The **status bar** carries a REC light naming that document
(`REC lighting → Act 2`); clicking it stops. The Lighting Takes panel is also in **Scenes & Cues**,
where a scene's own timeline is authored.

Select the fixtures first: *their selection order becomes the take*, and therefore the order any later
phase spread runs along. With nothing selected the recorder refuses and says why.

Capture is **independent of the transport** — you busk the look with the playhead stopped, press
stop, and the take appears in the panel's library ready to drag onto a lighting lane or pick in a
clip's *Source*. It records the RESOLVED fixture signal (the packer's own output), so a take comes out
in the same role space it will be replayed in. Each take lists its length, its part count and **the
roles it actually carries** — which is not decoration; see the second bullet below.

Two things happen at stop, and both matter more than they look:

- **Every curve is fitted into editable keyframes** — see [the fitter](#the-fitter) below. A
  recording arrives as something you can grab and move, not a polyline you can only re-record.
- **A role that never moved is dropped.** This is the important one. Playback only writes the roles a
  take carries, so a take that recorded a *static* dimmer would pin that dimmer wherever it happened
  to be — and a movement-only clip would then silently fight a colour clip layered under it. A
  pan-only busk must yield a pan-only take, so clips compose the way a console's effects do.

Recording refuses to start while a lighting clip is already driving the rig, so a take can never be a
recording of its own replay. That refusal — and the "nothing was selected" one, and "nothing moved, so
there is no take" — arrive as **toasts**: a recorder you can arm from a keyboard shortcut in a
workspace with no visible record button cannot fail silently.

### A lighting take belongs to ONE timeline — and a LiDAR take does not

This asymmetry is deliberate, and the Lighting Takes panel names the document its list belongs to so you
meet it before it costs you anything.

A **LiDAR take is captured reality**: a `.lblob` recording of what the venue actually did, on disk, that
any scene in the show might legitimately replay. It goes into the **project's media library**, and you
can drop it on any timeline (docs/TRACKING_TAKES.md).

A **lighting take is authored performance**. It is a busk of *these* heads in *this* look, keyframe-
fitted and stored inline in the document you recorded it against — it is material for the show you are
writing, not a recording of the room. Making it project-global would put every rehearsal take of every
scene in one flat list, and the useful ones are the ones sitting next to the clips they belong to.

If you do want a busk in another scene: place it on a lighting clip here, then **Capture Scene** — the
clone carries the take with it. Recording the take against the scene you mean is the cheaper path.

### The fitter

[curveFit.ts](../src/renderer/services/curveFit.ts) — what a busk goes through on the way to becoming
editable.

The reducer that came before it was **Ramer–Douglas–Peucker**, whose metric is the vertical distance
to a straight **chord**. That is the right tool for a polyline and the wrong one for a movement: a
pan sine never straightens, so RDP keeps points in proportion to curvature ÷ ε and a three-minute
capture lands as ~1200 dumb points. You cannot tune that; you can only re-record it.

This fits **cubic segments** instead — Schneider's method (Graphics Gems, 1990): parameterise the
samples, least-squares the control points, reparameterise by Newton, recursively split at the worst
remaining error. The output is `Keyframe[]` **with bezier handles** — the same thing an automation
lane stores.

Two constraints shape all of it, and both come from `Keyframe`'s bezier being a **CSS-style timing
function**, not a free 2-D cubic (`p0=(0,0)`, `p3=(1,1)` in the segment's unit box, `cx` clamped to
`[0,1]` so x stays monotone and solvable; `cy` deliberately unclamped, which is how you get
overshoot):

- the fit is **constrained, not general** — we solve for the four handle numbers of that form;
- **one segment cannot hold an inflection**, so a full sine period needs a key at each extreme. That
  is what a human would draw anyway, which is why the split step exists rather than being an
  optimisation.

`epsilon` is `reductionEpsilon(role)` — **the role's own unit**, so a degree means a degree.
Tolerances were chosen by measurement, not feel: 1° of pan is 0.19% of a 540° head's travel, about
17 cm at a 10 m throw, and tightening to 0.25° doubles the file for nothing anyone can see.

Two things worth keeping if you touch it:

- **It scores itself the way the SAMPLER will read it** — invert `x(s) = u`, then read y, exactly as
  `automation.ts`'s `bezierEase` does. Scoring at the parameters the fit happened to land on is how
  the first version passed its own check while producing a curve that was **238° out on the wire**:
  least squares is free to choose an s per sample; the sampler is not.
- **It falls back to RDP at the depth cap** (24), so the result is never *worse* than the reducer it
  replaced. That fallback is also why a 180 s sine only reaches ~1.7× compression — correct, but not
  finished; see [plans/lighting-rework-status.md](../plans/lighting-rework-status.md).

Measured, not estimated: a 10 s sine fits in **17 keys**. The plan predicted ~6 — optimistic by ~3×.

### Verified

A triangle sweep recorded on one fixture, reduced to 4 points, then replayed across four fixtures
with 0.25 s of phase:

```
peak value ....................... 444.7°  444.7°  444.7°  444.7°   (identical)
peak time relative to fixture 0 ... 0.000s  0.250s  0.500s  0.750s   (exactly the phase, wrapping)
```

Plus reduction fidelity on a jittered 10 s pan sine: 600 samples → 66 points, worst error 0.98°.

<!-- audience:contributor -->

## Storage

Takes are stored **inline in the project**, not as sidecar files the way LiDAR takes are: a
keyframe-fitted curve is small, and inlining removes an entire class of problem (no sidecar to lose,
no asset path to rewrite when a project folder moves, no extra IPC). Revisit if takes ever get long
enough to bloat the project file.

Where each piece lives, and why:

| | Lives on | Why there |
|---|---|---|
| takes | `Timeline.lightingTakes` | recorded against a timeline |
| sequences | `Timeline.lightingSequences` | authored against a timeline |
| **poses** | **`ProjectData.lightingPoses`** | a cue fired from the tablet, an OSC GO or a state's entry action belongs to **no timeline at all**, so a per-timeline library could not hold its content. It also means a look used in five scenes is stored once |

### Reading a newer project with an older build

None of this needed a `ProjectData.version` bump — every field is additive-optional with a read-site
default. But a project saved by this build is **read incompletely** by a build from before it:

- `LightingTakePart.channels` is now `Keyframe[]` → an older build sees a take that drives nothing;
- `ProjectData.lightingPoses`, `Timeline.lightingSequences`, `Cue.lighting` → silently ignored;
- `Controller.drives` → that rig reverts to `controllers[0]` patching.

<!-- audience:operator -->

## Related

- [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md) — profiles, roles, and why pan/tilt are degrees
- [TIMELINE.md](TIMELINE.md) — the NLE these clips live on
- [SCENES.md](SCENES.md), [STATE-MACHINE.md](STATE-MACHINE.md) — a lighting clip lives on a *scene's*
  timeline, so the show machine drives light shows with no extra machinery; and a scene recall folds
  only the **look** onto the live rig, which is what stops a GO from deleting the group a clip targets
- [plans/lighting-rework-status.md](../plans/lighting-rework-status.md) — what was built, how each
  claim was proved, and the three places building contradicted the plan. **This feature set is
  expected to be reworked**; treat the decisions as revisable and the findings as facts

<!-- audience:contributor -->

## Is lighting a plugin?

Asked and answered **no** (2026-07-27), and worth re-deriving rather than re-asking: the SDK has no
fixture-kind / DMX-packing contribution seam, the packing lives in the frame loop, and every shipped
plugin wraps a native addon or an optional input and graceful-degrades — lighting does neither. The
plugin-shaped thing hiding in that question is a **fixture-kind contribution**, worth designing only
when a *second* implementation (a laser, a media-server head) justifies it. GDTF import is the one
genuinely separable piece.
