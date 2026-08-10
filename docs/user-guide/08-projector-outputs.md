# 8. Projector outputs

Send any surface fullscreen to a physical display with geometry correction. Open the **Outputs** panel
from the title‑bar **Outputs** icon. Each surface gets a row.

![The Outputs panel](images/11-outputs.png)
*The Outputs panel: one row per surface, with On toggle, Display picker, Status, and Align. The header has a global FPS cap and Re‑scan.*

---

> **Outputs are set once for the whole project, not per scene.** Display bindings, warps, soft edges,
> gamma, labels and calibrations belong to the *room* — they do not change because the lighting did, so
> **scenes do not store them and a GO never changes them**. Set your rig up once and it stays set up.
> (Older projects may still carry per‑scene copies from before this rule; they are ignored.)

## Turn an output on

1. Pick a **Display** for the surface's row. A real projector appears here; **Windowed (this screen)**
   outputs to a movable window on your current monitor (handy for testing on one screen). Use
   **Re‑scan** if you plug/unplug displays.
2. Tick **On**. A frameless fullscreen window opens on that display and the status reads **Live**.

![An output enabled in Windowed mode](images/11b-outputs-windowed.png)
*"Logo Wall" output On, set to Windowed — status **Live**, and the **Align** button is now active.*

> The projector window itself is hardware‑accelerated and isn't shown here, but it mirrors the surface
> exactly. On a real rig you'd see the surface content filling the projector.

---

## Name it, and find it in the room

A surface is named for its picture — *Wall A*, *Logo Wall*. The projector throwing that picture is
known by where it hangs — *Stage Left*, *Ceiling 3*. Those are two different names, and on a wall of
six they stop matching the first time an output is re-pointed. So an output can carry its own
**Label**: expand a row (the **gear**) and type it. The row then reads `Stage Left · Wall A`, and the
projector window uses it too. Leave it blank and everything falls back to the surface name, exactly
as before. The label is saved with the project.

**Identify** answers the question the app otherwise can't: *which machine in the ceiling is this?* It
puts the label on the projection itself, big enough to read from the floor, with the display it is
bound to and the raster it is running underneath — the second line is what turns "the picture is
wrong" into "that cable is in the wrong port". Press the **tag** icon on a row, or **Identify all**
in the header to name the whole wall at once; one more press turns it all off.

It draws over the content behind a dark scrim rather than replacing it (you identify a rig while it
is showing something, and a full-white card on a projector aimed at an audience is not a neutral
act), and it is never warped — so it stays square and readable whatever the corner-pin, calibration
or blend is doing to the picture below. It is **never saved with the project**, so it cannot come up
over a show; an output switched off stops identifying by itself.

> Identify is a rigging aid, not a picture. It is drawn as an overlay, so an **NDI send** of that
> output carries the content without it — the same reason the preloading sign doesn't travel either.

The label also names the **output window itself**: its title bar and taskbar entry read
`ARTLux — Stage Left · DISPLAY 2` instead of the `ARTLux — Output` every output used to share, which
is what makes four windowed previews tellable apart in Alt‑Tab. In **Windowed** mode the window also
carries a small ARTLux mark and the label in its top‑left corner — windowed is a preview on your own
screen, so it costs nothing there. Fullscreen outputs never draw it: on a real projector that mark
would be a watermark on the venue wall for the length of the show.

---

## Hanging a multi‑projector rig — alignment aids

Everything else on this page bends the *picture*. Aids come first: they help you aim, zoom, roll and
focus the **real machines** so their light lands where you want and overlaps by the right amount.

They live in the **Alignment aids** bar at the top of Outputs, and a pattern goes up on **every live
output at once** — overlapping two projectors means seeing both. Each output is tinted **its own
colour**, and the first three are red / green / blue on purpose: where two machines overlap you see
their mix (red + green = yellow) with nothing to measure. The dot in each row tells you which light
belongs to which output.

| Pattern | Use it to |
|---|---|
| **Grid** | Judge geometry, keystone and roll. Columns are lettered and rows numbered, so two people on two ladders can name the same square — *"my P4 has to sit on your A4"*. |
| **Blend** | **Set the overlap.** Each feathered side is hatched in the output's colour, its inner edge drawn bright, with a **ladder** of rungs across it. Match your neighbour's ladder and you have matched three things at once: same band width (zoom), same position (aim), rungs parallel (roll). The band is labelled with its size in % and pixels. |
| **Focus** | Sharpen the lens — fine detail at the centre, edges *and* corners, where a projector focused only in the middle gives itself away. |
| **Greys** | Match brightness and gamma between machines (11 steps), and see how much a blend lifts black. |
| **Bars** | Match colour between machines. |
| **1:1** | Check the projector is on its native raster — moiré means something is scaling. |
| **White / Black** | Flat fields for coverage, spill and black level. |

**Dim** sets how far the show underneath is darkened; you often want to align against the real content
rather than a blank field. Nothing here is saved with the project, so an aid can't come up over a show.

> **The aids are drawn unwarped, in each projector's raw raster** — that is deliberate. While you are
> hanging a machine you are adjusting where its *light* goes, so an aid that moved with the corner‑pin
> would hide the very error you are looking for. If an output already carries a warp, the aid says so
> on the projection. Do the physical work first, then **Align** the software on top.

### A working order for a wall

1. **Identify** every output so you know which machine is which.
2. **Grid** — aim and zoom each projector so its frame covers its share of the surface, using the
   numbered corners and the centre cross. Get roll right here; it is painful later.
3. **Blend** — set each output's **Soft edge** (or let a **Span** do it), then physically slide the
   projectors until neighbouring ladders sit on top of each other.
4. **Focus**, then **Greys** and **Bars** to match the machines to each other.
5. Only now use **Align** / calibration to take out what optics could not.

---

## Align (corner‑pin)

Click **Align**, then on the projector window drag the four corners onto your projection surface:

| Input | Action |
|-------|--------|
| Drag a corner handle | Move that corner |
| Arrow keys | Nudge the selected corner (**Shift** = ×10) |
| **R** | Reset to a clean rectangle |
| **Esc** | Finish aligning |

---

## Bézier warp (curved surfaces)

Expand a row (the **gear**) and tick **Bézier warp**, then **Align** to drag a 16‑point control mesh —
for cylinders, coves, domes and angled walls. **R** resets the mesh.

---

## Soft edge, gamma & color match

Per output (in the expanded row):

- **Soft edge** — feather each edge (L/R/T/B %) with a blend **gamma** for multi‑projector overlaps.
- **Output γ** — a per‑screen gamma.
- **Color / black match** — match brightness/black level across projectors.

---

## Other controls

- **Send as NDI** — publish the warped output as an NDI source for downstream tools.
- **FPS cap** (panel header — Off / 60 / 30 / 24) — throttle all outputs to save GPU on big rigs.
  Outputs otherwise render at native resolution with anti‑aliasing.

For a precise lens+pose solve (so the 3D scene maps onto the real surface), use the
[calibration wizard](10-calibration.md). Hardware acceleration (NVAPI scanout warp/blend) is used
automatically on supported NVIDIA pro GPUs — see [NVWARP.md](../NVWARP.md). More in
[OUTPUTS.md](../OUTPUTS.md).

➡ Next: [3D scene](09-3d-scene.md)
