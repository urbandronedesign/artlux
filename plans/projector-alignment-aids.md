# Alignment aids — hanging and overlapping real projectors

**Status:** built (first cut). **Owner ask:** *"when I setup a multiscreen project I need helpers on the
output projectors in order to setup the real projectors — a way to overlap precisely in the real venue."*

## What the app already had, and why none of it answers this

| Existing | What it is for | Why it is not this |
|---|---|---|
| **Align** (corner-pin / Bézier) | Bending the *picture* in software after the machine is hung | It warps content. During physical setup the warp must be identity — you are moving a projector, not a mesh |
| **Calibration** (structured light + pose) | Recovering the projector's optics with a camera | Needs a camera, a board and a venue model. It answers "where is this projector in 3D", not "is my right edge sitting on your left edge" |
| **Soft edge** (L/R/T/B % + γ) | The blend ramp the GPU applies | Numbers in a panel. Nothing on the wall says where the band physically lands |
| **Spans** | Cutting one picture into overlapping tiles | Authoring metadata. It decides the overlap; it does not help you *achieve* it |
| **Identify** | Which machine is this | Names an output; says nothing about geometry |

So the gap is specific: **nothing is drawn on the projector, in the projector's own raster, that two
neighbouring machines can be physically matched against.** That is the whole feature.

## The principle: raster space, not content space

An aid is drawn **unwarped, in the projector's raw raster** — DOM/SVG over the canvas, never through
the warp pipeline. That is not an implementation shortcut, it is the point: while hanging a projector
you are adjusting *where its light goes* (yoke, lens shift, zoom, focus, roll). An aid that moved with
the software warp would hide exactly the error you are trying to remove. The overlay says so out loud
when the output has a residual warp.

## What is drawn

**Every pattern** carries the common chrome: a 2px frame on the exact raster boundary (the edge of the
projector's light), numbered corner targets, a centre cross, thirds, and the output's label in the
output's own colour.

**Per-output colour** is the oldest trick in the trade and the most useful: each output is tinted a
different hue, so on the wall you can see which light is whose, and the overlap shows as the *sum* of
two hues. The first three are R/G/B on purpose — red + green reads as yellow exactly where the two
machines overlap, with no measurement at all. Derived from the output's index (no persisted field, so
nothing to migrate or drift).

| Pattern | Answers |
|---|---|
| **Grid** | Geometry, keystone, roll. Lettered columns and numbered rows, so two operators can talk: *"my P4 has to sit on your A4"* |
| **Blend** | **The overlap itself.** Each feathered side is hatched in the output's hue with its inner boundary drawn bright, plus a *ladder* — rungs at fixed fractions of the band. Matching the neighbour's ladder proves three separate physical adjustments at once: same band **width** (zoom), same **position** (aim), rungs parallel (**roll**) |
| **Focus** | Lens focus and sharpness — high-frequency checker patches at centre, edges and corners, where a projector focused only in the middle gives itself away |
| **Grey** | Brightness and gamma match between machines: an 11-step ramp, plus the black patch where a blended rig's black lift shows |
| **Bars** | Colour match between machines |
| **1:1** | A device-pixel checkerboard. Moiré ⇒ something is scaling, and the projector is not running at its native raster |
| **White / Black** | Flat fields — coverage, spill, and black level in the overlap |

## State, and what is deliberately NOT persisted

One transient control for the whole rig (`alignAid` in App state, beside `identifyOutputIds`): a
pattern and a dim level, pushed to every live output. Nothing reaches `ProjectorOutput`, so an aid can
never be saved into a project and come up over a show. Same reasoning as Identify.

The blend bands come from the output's **real** `softEdge`, sent in the aid payload rather than read
from `render` — under NVAPI scanout warp the GPU is handed a flat soft edge (the double-blend guard),
but the band still physically exists, and an aid that vanished on a hardware-blended rig would be
worst-where-it-matters.

## Not built (deliberate, for a later pass)

- **Solo / cycle** — flashing outputs one at a time. Identify already answers "which machine is this".
- **A measured overlap readout** — needs a camera; that is the calibration plugin's territory.
- **Per-output pattern override.** Aligning a wall means seeing all of it at once; one global pattern
  is the operation, and a per-row override would mostly be a way to get confused.
