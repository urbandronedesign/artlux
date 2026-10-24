# Blender screens — a venue whose screens are named in Blender

A room with **one 16:9 screen** named `screen_main` (3.2 × 1.8 m) on its back wall, plus the wall and a
floor. It is the test file for ArtLux's rule that any object named `screen…` is a screen of its own.

It also holds a camera named `projector_main`, 6 m back and aimed at the screen with a throw ratio of
1.0 — a projector placed in Blender. It shows in the 3D view as a cyan frustum, and the Manual
calibration can start from it (see below).

| File | What it is |
|---|---|
| `venue.blend` | The Blender scene. Open it to see the naming and the screen's UV unwrap. |
| `venue.glb` | The export ArtLux loads. |
| `make-venue.py` | Rebuilds both files from scratch. |

## Try it

1. Make a surface or a timeline layer with something recognisable on it — text, or a video with an
   obvious top and bottom.
2. In the **3D** context, load `venue.glb` as a venue model.
3. Under the model in the outliner, **screen_main** is listed. Select it: the Model card shows a
   **Screens** list.
4. Set **screen_main** to your surface or layer. Only the screen shows it, upright, filling the 16:9
   face. The wall and the floor keep their own materials.
5. Now also set the model's own **Content** to something else. The wall and floor show that, and the
   screen keeps its own picture.
6. Set the screen back to **— as the model —**, and it shows the model's content like the rest.

## Start a calibration from the projector

1. Route a surface to a projector output (windowed works for a test) and launch with `--calibrate`.
2. Press **Calibrate** on that output, switch to **Manual**, and go to **Lens**.
3. Under **Projector placed in the venue file**, choose **projector_main** and press **Start from it**:
   the throw ratio becomes 1.00.
4. Go to **Points**. Before you click anything, the projection already shows the room's wireframe as
   seen from `projector_main`. Click a corner of the screen on the model: its point appears where
   that projector predicts it, and you drag it onto the real corner.
5. From 4 points the position solves and replaces the Blender one.

## Rebuild the files

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python examples/blender-screens/make-venue.py
```

The full rule is in [the 3D scene chapter](../../docs/user-guide/09-3d-scene.md#screens-named-in-blender).
