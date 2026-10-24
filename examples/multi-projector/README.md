# Multi-projector — two projectors blended on one curved screen

A starting point for a **rig**: one wide curved screen, two projectors side by side, each lighting a
little more than half of it, cross-faded where they overlap so the join disappears.

| File | What it is |
|---|---|
| `multi-projector.artlux` | The project. Open it with **File ▸ Open…**. |
| `assets/models/panorama-venue.blend` | The venue, in Blender: the screen `screen_main` and the projectors `projector_left` and `projector_right`. |
| `assets/models/panorama-venue.glb` | Its export, so the project also opens where Blender is not installed. |
| `make-scene.py` / `make-project.cjs` | Rebuild the scene (in Blender) and the project. |

**The screen** is a slice of a cylinder, concave toward the audience: 6 m of arc by 1.8 m — 10:3
measured along its surface — with a 4 m radius, about 86° of curve. Its middle is 3 m back and 2 m
up. **The projectors** stand 9 m in front, 2.7 m apart, each aimed straight ahead at its own half,
with a throw ratio of 2.1. Each picture is about 4.2 m wide, so the two **overlap by about 1.5 m** in
the middle.

## How the project is laid out

- **Screen** — the picture: a test card wrapped around the whole panorama, bound to `screen_main`.
- **Projector Left** and **Projector Right** — one output each, windowed so the template opens on any
  machine. In **Projection Outputs**, give each its projector's display. Until it is calibrated, an
  output shows the test card flat, so a window is never blank while you set up.

Once calibrated, each output draws the venue **from where its projector stands**, so both show their
own part of the same Screen picture.

## Calibrate the rig

Launch ArtLux with `--calibrate`. Then, **for each projector in turn**:

1. In **Projection Outputs**, press **Calibrate** on its output and choose **Manual**.
2. **Lens** — under **Projector placed in the venue file**, choose that projector
   (`projector_left` for Projector Left, `projector_right` for Projector Right) and press
   **Start from it**.
3. **Points** — place six points on the part of the screen this projector lights:
   - the two corners at **its** end of the screen;
   - the top and bottom of the **middle** of the screen (the test card's centre line), which both
     projectors see;
   - the top and bottom a **quarter** of the way in from its end (the test card's 4th grid line from
     that end).

   Each point appears where the Blender projector predicts it; drag it onto the real spot.
4. **Verify**, then **Apply & finish**.

Both projectors are calibrated against the same 3D model, so they land in one shared frame without
anything to align between them.

## Blend

1. **Open the 3D view once** — it loads the venue model the blend is traced against.
2. In **Projection Outputs**, the **Rig blend** strip now reads *2 calibrated*. Press
   **Solve blend**.
3. **Save** the project: the blend is stored with each output.

Each projector now fades out across the overlap — the left one going dark toward its right edge, the
right one toward its left — so together they put out the same light as either one alone.

## Hand the rig to the show machine

From any calibration wizard's **Verify** step, **Export calibration (.mpcdi)** writes **both**
projectors — warp and blend — into one file. On the show machine, **Projection Outputs ▸
Calibration File ▸ Import calibration (.mpcdi)** plays it back: no `--calibrate`, no 3D model and no
Blender needed there. An imported calibration projects each output's **own** surface through the
map, so give Projector Left and Projector Right the show's content there.

## What to expect

Built and tested with the two projectors placed 5–10 cm off their Blender positions and aimed
slightly differently, as real rigging is:

- each projector calibrates to **within 2 cm** of where it really stands, at under 0.4 px per point;
- across the overlap the two together give **1.00** of the light of one projector alone — measured on
  a white picture, point by point, from the two projectors' own output — with a smooth fade and no
  seam. Because both projectors are calibrated, the blend is computed exactly from where each point
  lands on each projector, not estimated;
- a video plays across the whole panorama with no visible join, in a plain launch as well as under
  `--calibrate`.

## Rebuild the files

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python examples/multi-projector/make-scene.py
node examples/multi-projector/make-project.cjs
```
