# 9. 3D scene

The **3D Scene** lays out fixtures in real‑world space and previews the show in 3D — handy for venue
design and client previews. It lives as a **split pane** beside the Stage (toggle it with the
split‑view button in the Stage's top‑right toolbar; drag the divider to resize).

![The 3D scene split pane and its outliner](images/00-main-editor.png)
*The 3D Scene (center‑right) with its outliner: OBJECTS (a "Screen 1" plane, models), FIXTURES, and a LIGHTING section. The LEDs light up with live output colors, so the view matches what your rig is doing.*

---

## Navigate the camera

| Input | Action |
|-------|--------|
| Left‑drag | Orbit |
| Middle / right‑drag | Pan |
| Wheel | Zoom |
| Click empty space | Deselect |

---

## Transform a fixture in 3D

Select a fixture, then **W** move / **E** rotate / **R** scale (or the gizmo buttons), and drag the
gizmo. For exact values, use the Inspector's **3D Layout** card:

- **Position (m)** — X / Y / Z in metres.
- **Rotation** — pitch / yaw / roll (degrees).
- **Layout** — `line` (spacing), `matrix` (cols / rows / serpentine), or `arc` (radius / angle). This is
  the *physical* arrangement of the LEDs in space, independent of the 2D stage placement.

---

## The outliner (top‑right of the pane)

Lists everything in the scene under **OBJECTS** and **FIXTURES**:

- **Add** screen **planes** (the **+** in OBJECTS) to show surface/timeline content on a flat panel in
  3D — useful as a backdrop or projection screen.
- **Load a venue model** (`.glb` / `.gltf`) via the Media library or the outliner, then position/scale
  it.
- Toggle each item's **visibility** (the eye), select it to edit, or remove it.
- **Save** the scene layout from the outliner header.

---

## Show content on an object

Select a plane or a mesh and pick a **Content** source in the Model card:

- a **Surface** — the object then shows whatever that surface is playing (a video, an image, a
  camera, NDI, Spout, an effect, a timeline layer, the whole timeline). This is the one to use for
  projection mapping: bind the venue mesh to the surface routed to your projector and the show lands
  on the real object.
- a **Timeline layer** — a single track of the NLE, or **★ Timeline (Program)** (the **TL** shortcut
  button) for the whole composite.

Planes display the frame directly; meshes get it textured through UV coordinates, and a **UVs**
selector chooses which:

- **Mesh UVs** — the UV map authored in the GLB file. If the file has none (common for CAD exports),
  there is nothing to spread the picture across and the whole mesh shows a single flat color — that
  is the tell.
- **Projected from view** — bakes UVs by projecting the mesh from the current 3D viewpoint, like a
  virtual projector: orbit the camera until the mesh is framed the way the content should land, then
  press **From view**. From that viewpoint the layer reads as a fullscreen image. The texture stays
  glued to the mesh if it is moved afterwards; press **From view** again to re-project. Surfaces the
  viewpoint cannot see get stretched, exactly as with a real projector.

Switching back to **Mesh UVs** keeps the baked viewpoint, so comparing the two is a two-click A/B —
nothing in the GLB file is modified either way.

---

## Look through a calibrated projector

Once a projector output has been calibrated (see [Projector calibration](10-calibration.md)), a
**view selector** (camera icon) appears in the 3D toolbar. Pick a projector and the viewport renders
from *its* viewpoint, using the lens and position the calibration recovered — letterboxed to the
pane, never stretched, so what you see is honestly what that projector covers. It is the fastest way
to check framing and to see the content on the mesh as the projector will show it, with no projector
switched on.

While a projector view is active the camera is driven by the calibration, so orbiting is off (and
that projector's own frustum is hidden — you are inside it). Choose **Editor camera** to go back.
The selection is saved with the project, and it is *not* captured into scenes: recalling a scene
never moves your viewpoint.

---

## Lighting & preview options

The **LIGHTING** section controls the preview render: **Light gain**, **Exposure**, **Ambient (env)**,
**Reflective floor**, **Grid**, plus **Tracking zones (LiDAR)** and **Merge people** for visualizing
live tracking in 3D.

See [SCENES.md](../SCENES.md) for the full 3D model.

➡ Next: [Calibration](10-calibration.md)
