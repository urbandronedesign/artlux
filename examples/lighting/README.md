# Lighting example projects — a rig of nothing but moving heads

Two ready-to-open `.artlux` projects for the half of ArtLux that has **no pixels in it at all**: a rig of
**light fixtures** (moving heads, washes, beams) driven by authored role values, aimed by hand, recorded
as a **take**, and replayed from a **lighting clip** on the timeline.

Reference: [`docs/LIGHTING-SHOW.md`](../../docs/LIGHTING-SHOW.md) (how a light show is encoded) and
[`docs/FIXTURE-LIBRARY.md`](../../docs/FIXTURE-LIBRARY.md) (what a profile is, and why pan/tilt are degrees).

**Portable and media-free.** No video, no images, no LED tape, no network. The profiles come from the
bundled fixture library, so the projects open on any machine.

> ⚠ **Check Preferences ▸ Output before opening these on a rig.** The output target is machine state, not
> project state, so opening one of these sends to whatever *this machine* is already set to send to. On a
> venue PC wired to real fixtures, that is the real fixtures — and these projects drive pan, tilt and
> dimmer at full. Point Preferences ▸ Output somewhere harmless (or turn output off) first.

| Project | What it demonstrates | Runs on open? |
|---|---|---|
| [`01-a-rig-of-lights.artlux`](01-a-rig-of-lights.artlux) | the empty page: six heads in two **ordered groups**, patched, hung and floor-standing, aimed off their mountings. This is what you record *into*. | no — you drive it |
| [`02-a-recorded-busk.artlux`](02-a-recorded-busk.artlux) | the same rig with a **recorded take** on the lighting lane, aimed at the *Movers* group with a **0.6 s phase spread** — one busk of four heads, replayed as a chase | **yes** — press Play |

## The rig

Six **light fixtures** and **zero surfaces** — deliberately. A light samples nothing; it is driven by
named DMX parameters, so there is no picture anywhere in this project and nothing on the 2D stage. The
whole rig lives in **Venue & Rig** (the `3D` workbench).

| | Fixture | Profile | Mode | Patch |
|---|---|---|---|---|
| `Movers` | Mover 1–4 | Martin **MAC 250 Beam** | 16-Bit (13 ch) | universe 0, ch 1 / 14 / 27 / 40 |
| `Washes` | Wash 1–2 | Chauvet **Rogue R1 Wash** | 15 ch | universe 0, ch 53 / 68 |

The two makes are there on purpose, and they differ in the two ways that matter here.

**Colour.** The MAC mixes **subtractively** — cyan/magenta/yellow flags in front of a white lamp, so all
three at zero is *open white*, not black. The Rogue mixes **additively** — red, green, blue emitters. A
take records colour in RGB either way and replays correctly onto both.

**Beam angle.** The MAC's is fixed by its lens (25.9°–48.8°, so the 3D cone is drawn at the mid-point);
the Rogue has a **zoom channel**, 8°–30°, which is what lets you drag the beam angle open and watch the
cone follow — see below.

**Mount.** The four Movers are **Ceiling** — hung, so the base is bolted up under the truss at Y = 5 and
the yoke and head hang beneath it. The two Washes are **Floor** — upright, standing on their bases at
Y = 0. With a mount declared, Y is the *mounting face*, so a floor light is simply 0. Both are aimed a
quarter turn off tilt centre, which sends the hung heads down onto the stage and the floor pack up the
wall; the mount says where a fixture is bolted, pan and tilt say where it points. Switch either one in
**Position ▸ Mount** and watch the body turn over.

**Group order is the show.** `Movers` is Mover 1 → 4, left to right on the truss, and that order is the
axis a phase spread runs along. Nothing in the lighting path ever sorts a group.

## Chapter 1 — aim a head

1. Open `01-a-rig-of-lights.artlux`, pick **3D** from the left rail.
2. In the browser column, click **Mover 1**, then **Ctrl-click** Mover 2, 3 and 4. *That click order is
   the order a spread will travel in* — pick them left to right.
3. The parameter column now shows **Channels**: the MAC's real channel strip. Drag **Pan**.

Every selected head moves **while you drag**, together, and the readout is in degrees because the profile
declares the head's travel. The line under the strip says how many lights the fader is reaching.

Two things worth knowing about that fader:

- **It drives the whole selection, matched by role.** Pan is pan whatever the manufacturer called the
  channel. Select a MAC *and* a Rogue and drag Pan and both go to the same **angle** — not the same
  fraction of travel, which on a 540° head and a 230° head would be two different places.
- **Only the release is an edit.** The drag itself is render-free and never touches the document, so one
  sweep is one undo step, not two hundred.

### The cone tells you where it is pointed

Each lit head draws the outline every fixture datasheet prints — the apex at the lens, the cone edges at
the head's **beam angle**, the **optical axis**, and the **illumination boundary** where the light lands:

```
              ▭  the lens
             /|\
            / | \      cone edges, at the BEAM ANGLE
           /  |  \
          /   |   \    the OPTICAL AXIS, down the middle
         /    |    \
    ____(_____|_____)____   the ILLUMINATION BOUNDARY, where the beam meets the floor
```

It is drawn from that head's **live** parameters, so it swings as you drag Pan and Tilt and it opens and
closes as you drag **Zoom** — try it on Wash 1, whose Rogue R1 lens runs 8° to 30°. The boundary is
intersected with the floor **ray by ray**, so it is a circle under a vertical beam and a true ellipse
under a tilted one.

Two deliberate limits keep a big rig readable and cheap:

- **The selection gets the whole diagram**; every other lit head keeps just its boundary — the pool of
  light on the floor — so forty heads do not become a ball of wool.
- **It is lines, not light.** The soft volumetric cone beside it is fill-rate bound and capped; an
  outline costs a few hundred pixels whatever the throw, so every lit fixture can have one. Turn the
  whole thing off in **Lighting ▸ Beam cones** if the viewport is getting busy.

*Seeing the outline but no shaft of light?* That is **Lighting ▸ Haze**. A beam is only visible because
of what is in the air, so at haze 0 you get the pool on the floor and no beam, exactly as a venue with no
hazer looks. The cone diagram is independent of haze, which is the point of having both.

## Chapter 2 — record the busk

Still in **3D**, with the four Movers selected:

1. Open the **Lighting Takes** dock tab. Its *Arm* line reads `4 lights · selection order is the take`.
2. Press **Record move** (or `Ctrl+Shift+R` from anywhere). The button turns red and counts.
3. Busk: sweep **Pan** across, dip **Tilt**, pull the **Dimmer** down and back.
4. Press **Stop**.

A chip appears in the library — `00:12 · 4p · pan·tilt·dimmer`: twelve seconds, four **parts** (one per
selected head), and the roles it actually carries. Recording is **independent of the transport**: the
playhead never moved.

Two things the recorder does at stop, and both matter:

- **A role that never moved is dropped.** A pan-only busk yields a pan-only take, so a movement clip and a
  colour clip can layer without fighting. That is why the chip names its roles.
- **The curves are fitted into editable keyframes**, not kept as a sample dump — you can grab and move
  them afterwards.

If it refuses, it says why, as a toast: nothing selected, no *light* fixtures in the selection (an LED
strip has no roles to record), a lighting clip already driving these heads, or nothing moved.

## Chapter 3 — place it and spread it

1. Pull the timeline drawer up (**Ctrl+T**). The project already has a **Lighting** lane.
2. **Drag the take chip onto that lane.** A clip appears, as long as the take, playing it.
3. Click the clip. Its inspector asks four questions in order: *what moves* (the take), **who moves**
   (pick **Movers**), *how it spreads*, *how much*.
4. Set **Phase s** to `0.6`.
5. Press **Play**.

One recorded movement, four heads, each 0.6 s behind the last — a chase you never drew. Change the
**Spread** to `wing` and the same take mirrors outward from the centre instead.

A clip with **no group is silent**, and its inspector says so rather than leaving you to wonder. ArtLux
fills the group in for you when the answer is not a guess: a take with four parts dropped on a project
whose only four-light group is *Movers* lands on *Movers*.

## Chapter 4 — the other two capture verbs

**Record** is a stream of instants. The action bar in **3D** carries the other two scales of the same
gesture:

- **Store Key** — one instant, written onto the timeline where the playhead is. Aim the rig, press it,
  scrub, aim again, press it: that is a **pose sequence**, and it is the one source you can edit key by
  key afterwards (click a diamond on the clip).
- **Save Pose** — one instant, stored under a **name** in the project's pose library, with no timeline
  involved. That is what a **cue** fires — from the cue grid, the tablet, an OSC GO or a state's entry
  action.

Store Key never silently does nothing: with no lighting lane it makes one, with no clip under the
playhead it makes one, and the only thing it refuses is having no lights selected.

## What to look at on the wire

Everything here is ordinary Art-Net. With the projects' controller pointed at `127.0.0.1`, a listener on
the Art-Net port sees universe 0, and the MAC's 16-bit mode puts Mover 1's pan high byte on **channel 8**
(shutter, dimmer, C, M, Y, gobo, frost, **pan hi**, pan lo, tilt hi, tilt lo, …). Pan `0.5` is DMX `128`
is **271°** of a 540° head.

`scripts/test-lighting-take.cjs` drives exactly the loop above against the real app and asserts the
result on the wire, including the phase stagger — run it if you change any of this.

## See also

- [`docs/LIGHTING-SHOW.md`](../../docs/LIGHTING-SHOW.md) — takes, effects, pose sequences, pose cues, the
  precedence stack, and the spread modes
- [`docs/FIXTURE-LIBRARY.md`](../../docs/FIXTURE-LIBRARY.md) — profiles, modes, roles, and adding a head
- [`docs/TIMELINE.md`](../../docs/TIMELINE.md) — the NLE these clips live on
- [`docs/OUTPUTS.md`](../../docs/OUTPUTS.md) — Art-Net, sACN and USB-DMX output
