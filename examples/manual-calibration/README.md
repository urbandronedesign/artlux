# Manual calibration — from a Blender scene to a calibrated projector

A template for the most common job: **one screen, one projector**, the venue drawn in Blender, the
projector calibrated without a camera or a checkerboard.

| File | What it is |
|---|---|
| `manual-calibration.artlux` | The project. Open it with **File ▸ Open…**. |
| `assets/models/screen-venue.blend` | The venue, in Blender: one 16:9 screen `screen_main` (3.2 × 1.8 m, 2 m up, 3 m back) and one projector `projector_main` (9 m in front, throw ratio 2.0). |
| `assets/models/screen-venue.glb` | Its export, so the project also opens where Blender is not installed. |
| `make-scene.py` / `make-project.cjs` | Rebuild the scene (in Blender) and the project. |

The project loads the **`.blend` itself**. With Blender installed, saving the `.blend` updates the
venue in ArtLux while the project is open.

## What the template already does

- A surface, **Screen**, shows a **test card**: a white border, a grid of square cells, a centre ring
  and four coloured corners — **red top-left, green top-right, blue bottom-right, yellow bottom-left**,
  with an arrow pointing up.
- **Screen** goes to a projector output. It opens **windowed** so the template works on any machine;
  in **Projection Outputs**, pick your projector's display instead.
- In the 3D view, `screen_main` shows the **Screen** surface, and `projector_main` is drawn as a cyan
  frustum where Blender puts it.

## Calibrate

Launch ArtLux with `--calibrate` (calibration tools are part of that launch).

1. In **Projection Outputs**, press **Calibrate** on the Screen output and choose **Manual**.
2. **Setup** — all three rows should be ticked: the engine, the live output, the venue model.
3. **Lens** — under **Projector placed in the venue file**, choose **projector_main** and press
   **Start from it**. The throw ratio becomes 2.00. If your projector has lens shift, enter it here.
4. **Points** — before you click anything, the projector already draws the screen's outline where
   Blender expects it. For each corner of the screen:
   - click the corner on the model in the 3D view (just inside it — it snaps to the corner);
   - its point appears on the projection where Blender predicts it; **drag it onto the real corner**.

   After the 4th corner the position solves and the outline sits on the real screen.
5. **Verify** — turn on **Test projection** and check the outline against the screen's edges, then
   **Apply & finish**. The project is saved, and the output now projects the test card onto the
   screen through the calibration.

## Reading the test card

On the real screen, after calibration:

- **The white border runs along the screen's edges** — the calibration is aligned.
- **The cells are square** — the lens and the screen's size are right.
- **The ring is round and centred** — nothing is stretched or shifted.
- **Red is top-left and the arrow points up** — nothing is flipped.

## What to expect from one flat screen

Four corners of a single flat screen fix the picture **on that screen** precisely — in the test this
template was built with, every corner landed within half a pixel. They fix the projector's own
position less well: on one plane, moving the projector a few centimetres and turning it a fraction of
a degree look almost the same. That does not matter for this screen. If the same projector also
covers something **in front of or behind** the screen, add points on that too: depth is what pins
the position down.

## Rebuild the files

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python examples/manual-calibration/make-scene.py
node examples/manual-calibration/make-project.cjs
```

The rules behind the names are in the 3D chapter — [Import a Blender file](../../docs/user-guide/09-3d-scene.md#import-a-blender-file),
[screens](../../docs/user-guide/09-3d-scene.md#screens-named-in-blender) and
[projectors](../../docs/user-guide/09-3d-scene.md#projectors-named-in-blender) — and the
calibration steps in [the Manual flow](../../docs/CALIBRATION.md#the-manual-flow-no-board-no-camera).
