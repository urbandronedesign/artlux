# ArtLux — Encoding a light show

How movement is authored, stored and replayed for **DMX fixtures** (moving heads, washes, beams).
Fixture profiles themselves are [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md); this is what makes them move.

## The problem

Forty heads with twenty channels each is 800 parameters. Nobody draws 800 curves. A console solves
this by encoding an **effect** — a form, spread across an ordered selection by a phase — and storing
the *generator plus the spread*, not the result.

ArtLux has something no console has: a real NLE timeline. So a light show here is

> a fixture-agnostic **take**, instanced onto an ordered **group** by a timeline **clip** that
> spreads it in time.

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
| `LightingTake` | recorded movement: `parts[]`, each a set of per-role sampled curves |
| `LightingEffect` | a *generated* movement — form, role, centre, amplitude, period. No recording behind it |
| `LightingClip` | a `VideoClip` with `kind: 'lighting'`: which take/effect, onto which group, with what spread |
| lighting lane | `VideoLayer` with `kind: 'lighting'` |

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

## Precedence

```
profile default  <  authored Fixture.dmx  <  LIGHTING CLIP  <  automation lane  <  live override
```

A clip ranks **below** a hand-drawn automation lane deliberately: it matches the rule the rest of the
app already follows ("a lane always wins"), so there is one precedence story across audio, surfaces
and fixtures. Enforced in exactly one place — Stage's packer asks `automationOverlay.owns(path)`
before consulting the lighting overlay.

Within the lighting layer, overlapping clips merge **HTP for intensity-like roles** (dimmer, colour
emitters) and **LTP for everything else**. Two clips raising a dimmer should not fight; two clips
aiming a head must not average into a position neither asked for.

## Why a separate overlay

[lightingOverlay.ts](../src/renderer/services/lightingOverlay.ts) is a nested map keyed by fixture and
role, double-buffered and rewritten each frame — not dot-paths like
[automationOverlay](../src/renderer/services/automationOverlay.ts). A clip addresses a whole group by
role; writing forty fixtures × twenty roles as freshly-built path strings every frame would be pure
garbage generation on the hot path.

## Playback

[lightingPlayback.ts](../src/renderer/services/lightingPlayback.ts) subscribes to the engine playhead
**every frame, even while paused**, so scrubbing moves the rig — a show is authored by dragging the
playhead and watching. It publishes one empty frame when the last clip ends, so the rig *releases*
back to its authored values instead of latching on the final pose.

A take shorter than its clip **repeats**, which is what makes a two-second movement usable as a
thirty-second look — and is required anyway, since a phase-delayed fixture is sampled past the end.

## Using it

1. Timeline → **Lighting lane**.
2. **Right-click** the empty lane → a clip appears, already carrying a slow pan sine. (It is created
   with a generated movement on purpose: a clip that does nothing until you have recorded something
   is a dead end the first time anyone tries the feature.)
3. Select the clip → the inspector asks the four questions in order: *what moves* (generated form or
   a take), *who moves* (the group), *how it spreads* (phase, mode, mirror), *how much* (scale,
   offset).

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
throwaway-script pattern.

## Recording

**Do it in Venue & Rig** (the `3d` context) — the workbench this loop was shaped around. Select the heads
in the 3D scene, aim them, then either press **Record Lighting Take** on the action bar or pull the
**timeline drawer** up with **Ctrl+T** and use **Record move** in the Takes bin. Both drive the same
`services/lightingRecorder` singleton, so they cannot disagree about whether it is armed; the action bar
is just the version that does not make you hunt for the bin. The drawer is why no separate light-show
context was needed: the rig, the channel strip and the lanes are on screen together.

Select the fixtures first: *their selection order becomes the take*, and therefore the order any later
phase spread runs along.

Capture is **independent of the transport** — you busk the look with the playhead stopped, press
stop, and the take appears in the bin ready to drop into a clip's *Source*. It records the RESOLVED
fixture signal (the packer's own output), so a take comes out in the same role space it will be
replayed in.

Two things happen at stop, and both matter more than they look:

- **Every curve is reduced** (Ramer–Douglas–Peucker). Tolerances were chosen by measurement, not by
  feel — see `reductionEpsilon()`. 1° of pan is 0.19% of a 540° head's travel, about 17 cm at a 10 m
  throw; tightening it to 0.25° doubles the file for nothing anyone can see.
- **A role that never moved is dropped.** This is the important one. Playback only writes the roles a
  take carries, so a take that recorded a *static* dimmer would pin that dimmer wherever it happened
  to be — and a movement-only clip would then silently fight a colour clip layered under it. A
  pan-only busk must yield a pan-only take, so clips compose the way a console's effects do.

Recording refuses to start while a lighting clip is already driving the rig, so a take can never be a
recording of its own replay.

### Verified

A triangle sweep recorded on one fixture, reduced to 4 points, then replayed across four fixtures
with 0.25 s of phase:

```
peak value ....................... 444.7°  444.7°  444.7°  444.7°   (identical)
peak time relative to fixture 0 ... 0.000s  0.250s  0.500s  0.750s   (exactly the phase, wrapping)
```

Plus reduction fidelity on a jittered 10 s pan sine: 600 samples → 66 points, worst error 0.98°.

## Storage

Takes are stored **inline in the project**, not as sidecar files the way LiDAR takes are: a
keyframe-reduced curve is small, and inlining removes an entire class of problem (no sidecar to lose,
no asset path to rewrite when a project folder moves, no extra IPC). Revisit if takes ever get long
enough to bloat the project file.

## Related

- [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md) — profiles, roles, and why pan/tilt are degrees
- [TIMELINE.md](TIMELINE.md) — the NLE these clips live on
- [SCENES.md](SCENES.md), [STATE-MACHINE.md](STATE-MACHINE.md) — a lighting clip lives on a *scene's*
  timeline, so the show machine drives light shows with no extra machinery
