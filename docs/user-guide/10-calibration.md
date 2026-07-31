# 10. Projector calibration

Calibration recovers a projector's **lens + position** so the 3D scene can be projected onto the real
surface at 1:1. You launch it from the [Outputs panel](08-projector-outputs.md): enable an output, then
click the **Calibrate** (target) icon on that row.

> **Hardware required:** the Board and Auto-Align modes need a **camera**, a **projector**, and
> (ideally) a darkened room. The wizard UI below is the real panel; with no camera connected the
> *Camera detected* check shows a ✗ and the camera steps wait for a device. **No camera at all?**
> Use the **Manual** mode — it needs only the projector and the venue's 3D model.

![The calibration wizard — Setup step](images/13-calibration.png)
*The calibration wizard for "Logo Wall": Board / Auto‑Align modes, the 5 steps (Setup ▸ Camera ▸ Lens ▸ Pose ▸ Verify), and a readiness checklist.*

---

## Three modes

- **Board** — structured‑light + a **printed checkerboard**. Most accurate; recovers full lens
  intrinsics and pose. A ready‑to‑print board is in [`docs/checkerboard-9x6-25mm.svg`](../checkerboard-9x6-25mm.svg).
- **Auto‑Align** — markerless: you nominate a few correspondences and it solves the pose. Faster setup,
  no print needed. See [AUTO-ALIGN.md](../AUTO-ALIGN.md).
- **Manual** — no board, **no camera**. You enter the projector's lens specs, then pick matching
  points on the real object and the 3D model. Switch to it with the **Manual** button in the wizard
  header. See [Manual mode](#manual-mode-no-board-no-camera) below.

---

## The Setup checklist

The first step confirms you're ready:

| Check | Meaning |
|-------|---------|
| ✅ **Calibration engine installed** | The native OpenCV addon is present. |
| ✅ **Projector output live** | The output you're calibrating is On. |
| ❔ **Camera detected** | Pick your camera in the dropdown; ✗ until one is connected. |
| ⚠ **Venue model loaded (for pose)** | Add a `.glb` in the 3D Scene — needed for the Pose step. |
| ⚠ **Dim the room** | So the projection dominates the camera image. |

---

## The 5 steps

1. **Setup** — the checklist above; pick the camera and **Start the camera**.
2. **Camera** — frame the projector so the camera sees the whole projection.
3. **Lens** — capture the checkerboard / patterns to solve the projector's lens intrinsics.
4. **Pose** — solve where the projector sits relative to the venue model (PnP).
5. **Verify** — overlay the solved projection on the camera feed to confirm the fit.

**Back / Next** move between steps. The result feeds the projector output so the 3D scene maps onto the
real surface.

---

## Manual mode (no board, no camera)

Pick **Manual** in the wizard header. Instead of measuring the lens with a camera, you tell ArtLux the
lens and then anchor the projector by clicking matched point pairs. Four steps:

1. **Setup** — the checklist: calibration engine, output live, and a **venue model** in the 3D Scene.
   The model is the only metric reference in this mode, so it must match the real object's true
   dimensions.
2. **Lens** — with **Auto‑solve lens from the points** on (the default), you don't need to know the
   projector's optics at all: the throw ratio you enter is only a **starting guess**, and from 6
   points the focal is re‑estimated automatically on every solve. Enter what you know (throw ratio =
   throw distance ÷ image width; lens shift: 0% = centered, +100% vertical = image entirely above the
   lens axis), press **Apply lens**, and move on. Untick auto‑solve only if you trust the spec‑sheet
   numbers more than the points.
3. **Points** — pair points between the real world and the model:
   - On the **projector output**, click (or arrow‑key) the white crosshair onto a distinct physical
     feature of the real object — a corner, an edge junction.
   - In the **3D view**, click the same feature on the model — the click pairs with wherever the
     crosshair is, no confirmation needed. It snaps to the nearest mesh vertex (hold **Alt** to pick
     freely).
   - Repeat with at least **4** pairs — more is better — spread across the image **and across depth**
     (not all on one flat face). The pose solves automatically from 4 pairs on.
   - Every placed point is drawn **numbered on the projection itself**, in the right‑pane raster map,
     and on the 3D model — the same number everywhere, so you can stand at the object and see which
     features are already anchored.
   - **Project wireframe while picking** (on by default): from the first solve (4 points), the mesh's
     edges and **vertex dots** are projected live onto the object. You see exactly where the model
     thinks its vertices are versus where they really are, and every point you add or fix visibly
     pulls the wireframe into alignment. Aim the crosshair at a physical corner, click the matching
     (lit) vertex in 3D, watch it converge.
   - Once solved, each point in the list shows its own error in pixels — fix the worst one instead of
     starting over. Editing is direct: **drag the point** wherever you see it, and the solve (and the
     projected wireframe) follows live —
     - drag its **marker in the 3D view** across the mesh (still snaps to vertices);
     - drag its **dot on the raster map** (right pane);
     - grab and drag the **numbered point on the projection itself**.
     The selected point's buttons offer the same as slower alternatives (**Move 3D point** — next
     model click re‑places it; **Re‑aim projector pixel** — the crosshair jumps there and the point
     follows it until **Done**/**Cancel**), and the trash icon deletes a point entirely.
   - With auto‑solve on, the panel shows which lens is in play (*auto‑solved from the points* vs
     *entered value*) and the current throw ratio. The auto‑solve is validated — when your points
     are too flat to support it, the entered lens silently stands, so add points at different depths.
     With auto‑solve off, a manual **Refine lens** button (≥8 points) and **Revert lens** do the same
     on demand.
4. **Verify** — enable **Test projection** and check the render lands on the real object. It starts
   in **Wireframe** (bright mesh edges — readable even when the model's materials are dark); untick
   it for the shaded render. The panel also shows the **solved projector distance** — compare it to
   the real throw distance: if it's off by some factor, your throw ratio is off by the same factor,
   so multiply the throw ratio by *real ÷ solved* in the Lens step and re‑apply (the pose re‑solves
   from your points automatically). Then **Apply & finish**.

**Apply & finish** saves the project and switches the output to **render‑from‑projector**: from then
on, in the normal show (not just the wizard), that projector renders the 3D venue from its own solved
viewpoint — content mapped onto the mesh lands on the real object, like any projection‑mapping setup.
The **Render from projector** toggle on the output row turns it on/off later; the calibration itself
stays saved in the project.

Manual mode trades the board's accuracy for zero hardware: expect a good fit at the picked points and
small drift far from them. If you later get a camera, a Board calibration replaces the manual lens and
keeps your picked points.

### Multi‑projector

The same technique scales to a rig: calibrate **each output** with Manual mode **against the same
venue model** — the model is the shared reference, so every solved projector lands in one common
world frame automatically, each rendering the venue from its own viewpoint. Where projectors overlap,
use the **Rig blend** strip in the Outputs panel: with two or more calibrated outputs, press
**Solve blend** and each projector gets its share of the light so the overlap sums to one (no seam,
no double brightness). No camera scan is needed — the blend traces each projector's coverage from its
calibration and the venue model (the model must be loaded in the 3D scene when you solve).
Recalibrating a projector marks the blend **stale** — re‑solve it when convenient.

ArtLux also imports/exports **MPCDI** for interchange with other warping tools, and can camera‑measure
projector **gamma**. Full details, the optimization passes (ArUco one‑click recal, masking, exposure,
colour/black match), and troubleshooting are in [CALIBRATION.md](../CALIBRATION.md) and
[CALIB-OPTIMIZATIONS.md](../CALIB-OPTIMIZATIONS.md).

➡ Next: [Projects, media & broadcast](11-projects-media-broadcast.md)
