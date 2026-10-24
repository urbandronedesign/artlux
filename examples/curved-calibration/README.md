# Curved calibration — a curved screen, from Blender to a calibrated projector

The [manual-calibration](../manual-calibration/README.md) template with a **curved** screen: the same
test card, the same projector output, the same steps — and one thing a curve adds, depth.

| File | What it is |
|---|---|
| `curved-calibration.artlux` | The project. Open it with **File ▸ Open…**. |
| `assets/models/curved-venue.blend` | The venue, in Blender: one curved screen `screen_main` and one projector `projector_main`. |
| `assets/models/curved-venue.glb` | Its export, so the project also opens where Blender is not installed. |
| `make-scene.py` / `make-project.cjs` | Rebuild the scene (in Blender) and the project. |

**The screen** is a slice of a cylinder, concave toward the audience: 3.2 m of **arc** by 1.8 m —
16:9 measured along its surface — with a 3 m radius. Its middle is 3 m back and 2 m up; its ends come
42 cm closer. Its UVs follow the curve, so a 16:9 picture wraps around it without stretching: on the
real screen the test card's cells stay square along the curve.

**The projector** stands 9 m in front, 0.5 m above the screen's middle, with a throw ratio of 2.0.

## Calibrate

Launch ArtLux with `--calibrate`, then follow the
[manual-calibration steps](../manual-calibration/README.md#calibrate): **Calibrate** on the Screen
output, **Manual**, **Start from it** with `projector_main` in the Lens step, then the points.

On a curve, use **six** points rather than four:

1. the **four corners** (the ends of the arc);
2. the **middle of the top edge** and the **middle of the bottom edge** — these sit deeper than the
   corners, which is what pins the projector's position down.

The model has a vertex every 13 cm along the curve, so zoom the 3D view until the corner you are
clicking is well inside it: a click on the very edge of the view can snap to the vertex next to the
corner. The point's prediction tells you at once — it should land on the corner of the outline the
projector draws.

**What to expect:** with six points the picture lands on the screen within half a pixel, and the
projector's position comes out within a few centimetres — tighter than on a flat screen, because the
curve gives the solve depth. The curve is shallow from 9 m (a 6% depth difference), so the wizard
keeps the lens you entered rather than solving it; that is the right call here.

## Reading the test card on a curve

Everything in [the flat template's guide](../manual-calibration/README.md#reading-the-test-card)
holds, plus: seen from the projector, the horizontal grid lines and the bottom edge **bow** — that is
the curve, correctly drawn. Seen from the audience, the cells along the screen should look square.

## Rebuild the files

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python examples/curved-calibration/make-scene.py
node examples/curved-calibration/make-project.cjs
```
