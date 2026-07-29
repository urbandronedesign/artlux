# 16. Moving lights & light shows

Chapter 3 covered the fixture you *sample* — a strip or a matrix that takes its colour from the
picture underneath it. This chapter is the other kind: a **moving head, wash or beam** that you
*drive*, by telling it where to point and how bright to be.

They are two different devices, not one device with extra fields, and ArtLux treats them that way
from the moment you create one.

| | **LED fixture** | **Light fixture** |
|---|---|---|
| What it is | pixel tape, a matrix panel | a moving head, wash, beam |
| Where its colour comes from | sampled off the surface beneath it | values you author |
| Where you place it | the 2D stage, over a surface | **the 3D scene** |
| Typical wire | Art‑Net / sACN to an LED node | USB‑DMX or Art‑Net to a dimmer/head |

> **You pick which one at creation time, and it cannot be switched afterwards.** That is deliberate:
> the choice decides how the fixture is addressed, drawn and driven, so a control that flipped it
> later would quietly destroy the thing it was describing. If you picked wrong, delete it and add it
> again.

**A light is never drawn on the 2D stage.** If you are looking for a head you just added, it is in
the 3D scene — see [3D scene](09-3d-scene.md).

---

## 1. Give the head a personality

A moving head has no pixels. It has *channels* — pan, tilt, dimmer, a colour wheel, a gobo — and
which channel is which depends on the model and on the mode it is set to. That description is a
**DMX profile** (a *personality*, in console language).

Select the light and open its **DMX Profile** section, then pick the manufacturer and model. ArtLux
ships a library of profiles; the section only appears for a light fixture, because it means nothing
for pixel tape.

Once a profile is attached, the fixture knows how many DMX channels it occupies, and patching can
place it correctly. A profile marked as a **draft** has not been verified against real hardware —
usable, but check the channel order against the manufacturer's manual before a show.

Bringing a head that is not in the library? See [FIXTURE‑LIBRARY.md](../FIXTURE-LIBRARY.md), which
also covers importing the manufacturer's own **GDTF** file (which can carry the 3D model and the real
pan/tilt axes with it).

---

## 2. Place it in the room

Open the **3D scene** and position the head where it physically hangs. This is not decoration: the
3D position is what makes a stored look mean the same thing after you move a truss, and it is what
the beam preview draws from.

Select a light by clicking its **body** — the slim housing — not its beam.

---

## 3. Patch it

Lights patch the same way as everything else (see [Patching & routing](04-patching-and-routing.md)),
with one thing worth knowing: a light's channel count comes from its profile, so **attach the profile
before you patch**. Patch first and the addresses will be laid out for a fixture whose size ArtLux did
not yet know.

---

## 4. Make it move

Here is the idea the whole chapter turns on.

Forty heads with twenty channels each is eight hundred numbers. Nobody draws eight hundred curves. So
you never store the result — you store **a movement, aimed at an ordered group of fixtures, spread
across them in time**.

Three things can supply that movement, and each answers a question the others cannot:

| Source | What it is | You reach for it when |
|---|---|---|
| **Take** | a recording of you moving the rig by hand | you busked it and want to keep it |
| **Effect** | a generator — a form, a centre, an amplitude, a period | you can describe the shape in words |
| **Sequence** | authored **pose keys**: "at 0 s the group looks like this, at 4 s like that" | you want to build it, and edit it later |

The sequence is the one you can go back and change.

### Values are stored as meaning, not as channel numbers

A movement records **`pan`, `tilt`, `dimmer`** — and pan/tilt in **degrees**. It never records
"channel 3 = 147".

That is what lets you point the same look at a different group, even a group of different models, and
what makes a show survive a rig change: a move recorded on a 540° head replays as the same *angle* on
a 630° head, not as the same fraction of its travel.

### The authoring loop

> select the lights → place them in 3D → aim them → set their parameters → **Store Key**

**Store Key** lives in the 3D action bar, next to *Save Pose* and *Record Lighting Take*. One press
asks a single question — *what does this group look like right now, and where on the timeline does
that go?* — and then does whatever is needed:

- a lighting clip under the playhead → the key goes into it;
- a lighting lane but no clip there → it creates the clip and writes the first key;
- no lighting lane at all → it creates that too.

**It never silently does nothing.** The only time it declines is when **no lights are selected** — a
look for nobody is meaningless, and picking a target for you would be worse.

Selection **order** is the show. Nothing is sorted for you: the order you selected the heads in is the
order a spread walks them.

> ⚠ **Store Key stores what you see, and any phase spread is applied again on playback.** In practice
> you build the looks first and add the spread afterwards, which is the order that behaves.

### Starting from the timeline instead

1. Open the timeline and add a **lighting lane**.
2. Right‑click the empty lane. A clip appears already carrying a slow pan — deliberately, so it does
   something on the first try.
3. Select the clip. Its inspector asks four questions in order: **what moves** (a generated form, a
   take, or a pose sequence), **who moves** (the group), **how it spreads** (phase, mode, mirror), and
   **how much** (scale, offset).

If a clip looks like it is doing nothing, the inspector will **name the role that something else is
already winning** — which is usually the answer.

---

## 5. Sparse looks, and why that matters

A pose only carries the roles you actually set. A role that appears in **no** key is **not driven at
all** — it is left to whatever else is controlling it.

This is the feature, not a limitation:

- "fade the dimmer up over 4 s while the pan holds" is two keys and nothing else;
- a movement‑only sequence leaves colour completely alone, so a colour cue underneath still shows.

It also makes **removing** a role from a key a different act from **setting it to zero**: an
unmentioned role interpolates straight across the key, a zeroed one drags the light to black.

---

## 6. Firing a look without a timeline

Keys are how a look is **stored**. Sometimes you want to **fire** one — from the cue grid, the tablet
remote, an OSC message, or when the show enters a state. That is a **pose cue**: a named pose, a
group, and a fade time.

Both models share one atom — a pose — so the same look you stored as a key can be fired as a cue.

Cues behave the way a console leads you to expect: a cue fades **from whatever the light is showing
now**, not from a default; firing a second cue mid‑fade re‑aims from the live value instead of
snapping; and clearing a cue **releases** the light rather than writing zeros over it, so whatever was
underneath comes back.

---

## 7. When two things want the same light

Lowest to highest:

```
profile default  <  the fixture's own DMX values  <  lighting clip  <  pose cue  <  automation lane  <  your hand on a fader
```

Read it as one sentence: **a fired cue beats a clip that happens to be running, a lane you drew by
hand still beats the cue, and a fader you are holding beats everything.**

Where two lighting clips overlap, brightness‑like roles take the **highest** value (two clips raising
a dimmer should not fight) and everything else takes the **latest** (two clips aiming a head must not
average into a direction neither asked for).

---

## Troubleshooting

**The head does not move at all.** Check, in this order: it has a DMX profile; it is patched; the
output for its controller is enabled; and nothing higher in the precedence list is holding it — the
clip inspector names the culprit.

**I added ten heads and they are all in one spot.** They were created without a 3D position and are
stacked at the origin. Place them in the 3D scene.

**A stored look points somewhere else after I changed the rig.** Looks are stored per **slot** of a
group, in selection order. Changing who is in the group, or the order they were selected in, re‑aims
the look. Re‑select in the order you want and store again.

**It moves, but only a fraction of the way.** The profile's pan/tilt range does not match the real
head — check the model and mode against the fixture's own menu.

---

Deeper reference: [LIGHTING‑SHOW.md](../LIGHTING-SHOW.md) (how movement is stored and replayed) and
[FIXTURE‑LIBRARY.md](../FIXTURE-LIBRARY.md) (profiles, GDTF, regenerating the library).

⬅ Back to the [User Guide index](README.md)
