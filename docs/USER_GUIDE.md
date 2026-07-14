# ArtLux — User Guide

> 📖 **Looking for the illustrated guide?** There's now a **screenshot‑driven, per‑screen user guide**
> in **[docs/user-guide/](user-guide/README.md)** — one page per context (interface, surfaces, fixtures,
> routing, timeline, outputs, 3D, calibration, projects, preferences) with a screenshot and walkthrough
> for each. This single page remains as a text‑only quick reference.

ArtLux is a professional **addressable-LED pixel-mapping console**. You point a *content source*
(a video, image, live camera, network stream, or built-in effect) at one or more *surfaces*, lay
your LED *fixtures* over those surfaces, and ArtLux samples the picture per-pixel and streams it to
your hardware over **Art-Net** or **sACN/E1.31**. It can also drive video **projectors** with
corner-pin/warp and run a video **timeline**.

This guide is for operators and designers using the app. For internals see the other files in
`docs/` (ARCHITECTURE, SURFACES, OUTPUTS, LEDMAP, NDI, TIMELINE, ASSETS, TRACKING_TAKES).

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [The interface](#2-the-interface)
3. [Quick start](#3-quick-start-first-light-in-5-steps)
4. [Surfaces](#4-surfaces)
5. [Content sources](#5-content-sources)
6. [Fixtures](#6-fixtures)
7. [Patching & routing (DMX addressing)](#7-patching--routing-dmx-addressing)
8. [LED mapping (ledmap)](#8-led-mapping-ledmap)
9. [Color & output quality](#9-color--output-quality)
10. [Effects, groups & scenes](#10-effects-groups--scenes)
11. [The timeline & state machine](#11-the-timeline--state-machine)
12. [Projector outputs](#12-projector-outputs)
13. [3D Scene](#13-3d-scene)
14. [Projects, media library & broadcast mode](#14-projects-media-library--broadcast-mode)
15. [Keyboard & mouse reference](#15-keyboard--mouse-reference)
16. [Monitoring (Prometheus & Grafana)](#16-monitoring-prometheus--grafana)
17. [Troubleshooting](#17-troubleshooting)

---

## 1. The big picture

The signal flows in one direction:

```
Content source  →  Surface (a rectangle on the stage)  →  Fixture (your LEDs, placed over the surface)  →  Art-Net / sACN  →  your controller
```

- A **surface** is a rectangle on the 2D stage that shows one piece of content.
- A **fixture** is your physical LED product (a strip, a matrix panel, etc.). You place it on the
  stage *on top of* a surface and link it to that surface. Each LED samples the color underneath it.
- The same fixtures can be sent to LED hardware **and** to a video **projector**, and arranged in a
  **3D scene** for a true-to-venue preview.

Keep that order in mind and everything else follows: no surface → nothing to sample; surface but no
fixture linked → nothing goes out; fixture linked but content is *None* → it stays black.

---

## 2. The interface

- **Title bar (top)** — a single dark strip with the ArtLux logo, the **File / Edit / View / Window /
  Help** menus (app-styled dropdowns), the action icons (**3D Scene**, **Outputs**, **Routing**,
  **DMX Monitor**, **Preferences**, **Help**), and the window minimize / maximize / close controls.
  Drag the empty middle to move the window; double-click it to maximize. (Video/timeline play-pause
  lives in the Timeline dock and **Space**, not here.)
- **Left panel** — two tabs: **Scene** (the **Surfaces** and **Fixtures** lists — add with **+**,
  double-click to rename, hover to delete) and **Media** (the project's [media library](#14-projects-media-library--broadcast-mode):
  import, preview and drag media onto the Stage or Timeline).
- **Stage (center)** — the 2D canvas where you place and arrange surfaces and fixtures. Top-right of
  the stage has a **grid toggle**, a **snap (magnet)** toggle, and a **reset view** button.
- **Right panel (Inspector)** — properties for whatever is selected: a surface's content & transform,
  or a fixture's mapping, effect, geometry and 3D layout. Also hosts **Groups** and **Scenes**.
- **Bottom dock** — tabs for **Fixture Editor**, **Timeline**, and **DMX Monitor**. Drag its top edge
  to resize; click the chevron to collapse.

- **Help panel (right)** — open it with **F1**, the **?** icon in the title bar, or **Help ▸ Help
  Panel**. It shows contextual help for whatever control you hover or focus, plus a browsable set of
  topic guides (Getting Started, Surfaces, Outputs, OSC/LiDAR Tracking, Timeline, Shortcuts). A small
  **EN / FR** toggle switches the help language and is remembered between sessions. Drag its left edge
  to resize.

You can hide the left/right panels from the toggles at the ends of the **status bar** (bottom).

---

## 3. Quick start: first light in 5 steps

1. **Add a surface.** In the left panel under *Surfaces*, click **+**. A cyan rectangle appears on
   the stage.
2. **Give it content.** Select the surface; in the Inspector's *Content* section pick **Video** (or
   **Camera**, **Image**, an **Effect**, etc.) and choose a file/source. If it's video, open the
   **Timeline** dock and press **Space** to play.
3. **Add a fixture.** Open the **Fixture Editor** dock tab and click **Add fixture** (or build it in
   the *Geometry* card — e.g. a Matrix). It appears on the stage.
4. **Place & link it.** Drag the fixture over the surface and resize it to cover the area you want.
   With the fixture selected, set the Inspector's *Mapping → Surface* to your surface.
5. **Send output.** Open **Preferences → DMX Output**, set your protocol (Art-Net/sACN), target IP
   and enable output. Click **Auto-patch** (Fixture Editor or Routing) to assign addresses. Your LEDs
   now mirror the content under the fixture.

Save with **Ctrl/Cmd+S**.

---

## 4. Surfaces

A surface is a rectangle (shown in **cyan**) that carries one content source. Coordinates are
relative to the stage, so a layout scales cleanly.

**Create:** left panel *Surfaces* → **+**. New surfaces appear centered at half size.

**Arrange on the stage:**
- **Move** — drag the surface body.
- **Resize** — drag the bottom-right corner handle (keeps aspect).
- **Rotate** — drag the rotation handle above the surface.
- **Snap** — turn on the **magnet** (top-right of the stage) to snap to the grid and to other
  items' edges/centers while dragging.
- **Precise values** — with a surface selected, the Inspector's *Transform* section has X, Y, Width,
  Height and Rotation fields.

**Stacking:** surfaces have a z-order; a fixture that's linked to a specific surface always samples
*that* surface even if others overlap it.

---

## 5. Content sources

Select a surface, then choose a type in the Inspector's **Content** grid:

| Source | What you provide | Notes |
|--------|------------------|-------|
| **None** | — | Black surface (linked fixtures go dark). |
| **Video** | A video file (`.mp4`, `.webm`, `.mov`, `.mkv`) | Controlled by the top-bar **Play/Pause**. HAP-encoded `.mov` is GPU-decoded for smooth high-res playback. |
| **Image** | An image file | Static (Play/Pause does nothing). |
| **Camera** | — (uses a connected webcam) | The OS will ask for camera permission the first time. |
| **DMX In** | — | Shows incoming Art-Net/sACN as content (input port set in Preferences). |
| **Spout** | A Spout sender name (Windows) | Live GPU feed from Resolume/TouchDesigner etc. Use **Refresh** to rescan senders; blank = active sender. |
| **NDI** | An NDI source name | Network video. Requires the free **NDI Runtime/Tools** installed; if missing the panel shows an install link. **Refresh** rescans; blank = first source. |
| **Layer** | A timeline track | The surface shows whatever clip is under the timeline playhead on that track. |
| **Effect** | An effect + palette | A built-in generative effect (e.g. solid, rainbow, wave, fire) with **Speed** and **Intensity** sliders. No media file needed. |
| **Tracking** | A tracking **Source** (`SOL`/`MUR`/`SOL_MUR`) | Live **LiDAR blob** positions as content — for interactive floors/walls. Options below. Needs OSC enabled (Preferences → OSC / Tracking). |

The top-bar **Play/Pause** is the global transport for video, camera and the timeline (it's only
enabled when there's something playable). Live sources (camera, Spout, NDI, DMX-in) are real-time.

> **Tip:** for **Video** and **Image** you don't have to browse each time — import once into the
> **Media** library (left panel → *Media*) and **drag a tile onto the surface** (or select the surface
> and click **Use**). See [§14](#14-projects-media-library--broadcast-mode).

### Tracking content (LiDAR blobs you can project)
Shows a glowing marker per tracked person. Because it's a normal surface, you can route it to a
**projector** and map it onto the real floor/wall at 1:1. Inspector options:

- **Source** — `SOL` (floor), `MUR` (wall), or `SOL_MUR` (both as one zone).
- **Blob size** — marker size (updates live as you drag).
- **Show IDs** — print each person's tracking id.
- **Flip H / Flip V / Rotate** — orient the data to match the room (use during calibration).
- **Calibrate** — overlay a zone border + grid + corner labels + **U/V** arrows to align by.
- **Background** — a timeline layer drawn *under* the blobs (one surface = video + blobs, so it
  projects on a single projector). The layer must have a clip playing to appear.

**Calibrate a projection (1:1):** point a projector at the tracking surface (§12), tick **Calibrate**,
use **Outputs → Align** to drag the projected border onto the real edges, then have someone stand at
a known spot and toggle **Flip/Rotate** until their marker lands on them. Turn **Calibrate** off for
the show. (Floor + wall = two surfaces → two projectors, calibrated independently.)

> Stacking order: in the **Surfaces** list, the top item is front-most. Use the **▲ / ▼** buttons on
> each surface to bring it forward / send it back (e.g. put a Tracking surface over a video).

---

## 6. Fixtures

A fixture describes one LED product: how many LEDs, how they're wired, and how many channels each
uses. Build and edit fixtures in the **Fixture Editor** dock tab; fine-tune placement and 3D layout
in the right Inspector.

**Create:** Fixture Editor → **Add fixture** (defaults: 30 LEDs, RGBW, RGB order, a Line shape,
auto-patched). Or add one from a **template** (see below).

**Geometry (shape):**
- **Line** — a single run of LEDs (a strip).
- **Matrix** — a 2D panel: set **Cols** and **Rows**, and toggle **Serpentine** if the rows are wired
  in a zig-zag (row 0 left→right, row 1 right→left, …). The Fixture Editor's **Wiring** card previews
  the physical LED order.

**Pixel type:**
- **Order** — the physical channel order of each LED (RGB, GRB, BGR, …). WS2812B strips are usually
  **GRB**. If colors look swapped, this is the setting to change.
- **Channels** — **RGB (3)** or **RGBW (4)**.
- **White** (RGBW only) — *Subtract min* derives the white channel from the common minimum of R/G/B
  (brighter, keeps hue); *None* leaves white off.
- **Reverse** — flips the whole fixture's pixel order (pixel 0 ↔ last) for backward wiring.

**Place on the stage:** drag to move; drag the corner/edge handles to resize (corner = both axes,
side handles = one axis); drag the top handle to rotate. Hold **Ctrl/Cmd** or **Shift** while
clicking to multi-select; rotation snaps to 45° steps with snapping on.

**Templates (reusable fixture types):** configure a fixture, select it, and in the Fixture Editor's
**Library** card click **Save selected**. It stores the *structure only* (LED count, shape, matrix
size, serpentine, color order, channels) — not its position or address. Click a template later to
drop a new fixture of that type. Delete templates from the same card.

**Link to a surface:** with the fixture selected, set Inspector *Mapping → Surface*. `— none (off) —`
means the fixture samples nothing. New fixtures auto-link to the first surface.

---

## 7. Patching & routing (DMX addressing)

Every LED needs a DMX **universe** and **start channel**. ArtLux can assign these for you.

**Auto-patch:** click **Auto-patch** (in the Fixture Editor *Create* card, or the Routing header). It
packs fixtures back-to-back — each consumes `LEDs × channels` — wrapping to the next universe at the
512-channel boundary. Fixtures you've **locked** keep their manual addresses and are skipped.

**The Routing panel** (top bar → *Routing*) is the full patch sheet:
- **Controllers** — add a row per physical output device: *Name*, *Protocol* (Art-Net/sACN), *IP*,
  *Broadcast* (Art-Net) / multicast (sACN), *Start universe*, and sACN *Priority*. With no controllers,
  fixtures use the global target from Preferences.
- **Fixtures** — a grid of *Name*, *Surface*, *Controller*, *Universe*, *Start*, *Channels*, *LEDs*,
  and a computed *Span* (total channels · universe range). The **lock** icon toggles a fixture between
  auto and manual addressing.

**Per-fixture overrides** (Inspector *Routing* card): a single fixture can override the protocol,
target IP, broadcast mode, sACN priority, or enable **Sparse output** (don't resend a universe whose
data hasn't changed). A blank IP falls back to the global target.

**Global output** (Preferences → *DMX Output*): protocol, output on/off, target IP, port, broadcast,
and **Discover devices** to scan for Art-Net nodes. *Engine* settings include output **FPS**,
keep-alive, ArtSync and **Gamma**.

---

## 8. LED mapping (ledmap)

A **ledmap** remaps the order of physical pixels onto the fixture's geometry — it answers "the *Nth*
pixel in the data stream lights *which* position?" Most rigs don't need one: **Reverse** handles
backward strips and **Serpentine** handles zig-zag panels. Reach for a ledmap only for irregular or
hand-wired layouts those two can't express.

In the Fixture Editor's **Ledmap** card:
- **Load** — import a `.json` map. ArtLux accepts a bare array `[0,1,2,…]` or a WLED-style
  `{ "map": [...] }`, so you can drop in a WLED `ledmap.json` directly.
- **Export** — save the current map (or an identity template to edit by hand).
- **Clear** — remove the map (back to natural order).
- **Generate serpentine** (matrix only) — bake the zig-zag wiring into a ledmap and switch the
  Serpentine toggle off so it isn't applied twice.

The map length should equal the LED count; any out-of-range entries fall back to natural order (the
card warns you if the lengths don't match). Transforms apply in the order **Reverse → ledmap →
Serpentine**.

---

## 9. Color & output quality

- **Color order** (per fixture) — fixes swapped R/G/B (e.g. GRB for WS2812B).
- **RGBW white mode** (per fixture) — *Subtract min* vs *None* (see Fixtures above).
- **Master brightness** (right panel *Global Params*) — scales every fixture 0–100%.
- **Output gamma** (Preferences → *Engine*) — global non-linear brightness correction (1.0–3.0).
- **Per-projector gamma & soft-edge** — set independently per projector output (see Outputs).

---

## 10. Effects, groups & scenes

**Effects** — instead of media, a surface (or a fixture, via the Inspector *Effect* section) can run a
built-in generative effect with a color **palette**, **Speed** and **Intensity**. Multi-segment
fixtures can split an effect across segments.

**Groups** (right panel *Groups*) — named selection sets. Click **+** to make a group from the current
selection; click a group to reselect it; use the row actions to add the selection, copy one fixture's
"look" (effect/palette/speed/intensity/segments) to the whole group, or delete it. Groups don't copy
position or patch.

**Scenes** (right panel *Scenes*) — snapshots of the current look. Click the **camera** to capture all
fixture colors + master brightness under a name; click a scene to recall it instantly. Scenes capture
the static look, not effects, media or patch.

---

## 11. The timeline & state machine

Open the **Timeline** dock tab (or press **F** to maximize it full-screen; drag the dock's top edge to
resize). It's a DaVinci-style editor for sequencing video on tracks (layers); point a surface's
content at a **Layer** to show it.

**Editing:**
- **Drop** a video onto a track to make a clip. Place several clips on one track to build a sequence —
  the playhead plays whichever clip it's over, and outputs **black** over gaps.
- **Select tool (V)** — drag a clip to move it; drag its edges to trim.
- **Blade tool (B)** — click to split a clip; **C** splits at the playhead.
- **Snapping (S)** — aligns drags to clip edges, the playhead, markers and the in/out range.
- **Markers (M)** — add at the playhead; click to seek, Alt/right-click to delete, double-click to
  note. **I/O** set the in/out region.
- **Tracks** — mute / solo / lock / show-hide, recolor, reorder (drag the grip), and resize height
  from the track header.

**Length & looping:** the **Length** field (toolbar) is the end of the timeline — playback stops and
holds on the last frame when it gets there. Looping is off by default; toggle **Loop** (**Shift+L**) to
repeat the **in/out** region, or the whole timeline if no region is set. **Stop**, **Set In**/**Set
Out** buttons and draggable ruler handles set the region without needing the **I**/**O** keys.

**Navigation:** **mouse wheel** zooms toward the cursor, **Shift+wheel** scrolls horizontally, and
**middle-button drag** pans in any direction.

**Tracking takes (record & replay LiDAR without the tracker):** the **Takes** strip under the toolbar
records the live LiDAR blob feed into reusable *takes*, so you can rehearse and run an interactive
show with no tracker connected.
- **Record** — press **● Record** to capture the live feed (independent of Play/Pause), **■** to stop.
  A take chip appears and a green **Tracking** lane is created.
- **Place** — drag a take onto the tracking lane (or drag it from the **Media** library). It shows a
  blob-density sparkline; move/trim it like any clip.
- **Replay** — with the tracker disconnected, **Play** or scrub: the recorded blobs drive the 3D Scene
  and any *Tracking* projector outputs. While a take plays it takes over from any live feed; past the
  clip the blobs clear and the live tracker resumes.

See [TRACKING_TAKES.md](TRACKING_TAKES.md) for details.

**State machine (control layer):** an always-present logic layer (the lane above the tracks; the
**Edit logic** button opens its editor). It's **disabled by default**. When enabled it can drive the
transport automatically: build a graph of **states** (each can *play / pause / stop / seek / set loop
/ jump to a marker* on entry) connected by **transitions** that fire **manually** (buttons on the
state lane) or automatically **after a delay**, **at a time**, **on a marker**, **when a clip ends**,
or **when the timeline ends** (the trigger to reach for when the whole show should advance
unattended). Turn it off any time to return to fully manual control. (The app's Play/Pause button
always reflects the real state, whether you or the machine changed it.)

---

## 12. Projector outputs

Send any surface fullscreen to a physical display with geometry correction. Open the **Outputs** panel
from the top bar (*Outputs*). Each surface gets a row:

1. Toggle **On** and pick a **Display** — a frameless fullscreen window opens on that monitor; status
   reads **Live**. Use **Re-scan** if you plug/unplug displays.
2. **Align (corner-pin):** click **Align**, then on the projector window drag the four corners onto
   your projection surface. **Arrow keys** nudge the selected corner (**Shift** = ×10), **R** resets,
   **Esc** finishes.
3. **Bézier warp (curved surfaces):** expand a row (gear) and tick **Bézier warp**, then **Align** to
   drag 16 control points — for cylinders, coves, domes, angled walls.
4. **Soft edge & gamma:** per output, feather each edge (L/R/T/B %) with a blend gamma for
   multi-projector overlaps, and set a per-screen **Output γ**.
5. **Send as NDI:** optionally publish the warped output as an NDI source for downstream tools.

A global **FPS cap** (Off/60/30/24) in the panel header throttles all outputs to save GPU on big rigs.
Outputs render at native resolution with anti-aliasing.

---

## 13. 3D Scene

Open the **Scene** window from the top bar to lay out fixtures in real-world space and preview the
show in 3D (handy for venue design and client previews).

- **Camera:** left-drag orbits, middle/right-drag pans, wheel zooms.
- **Transform a fixture:** select it, then **W** move / **E** rotate / **R** scale (or the buttons),
  and drag the gizmo.
- **3D layout** (Inspector): set Position (X/Y/Z metres) and Rotation (pitch/yaw/roll), and a layout of
  **line** (spacing), **matrix** (cols/rows/serpentine), or **arc** (radius/angle).
- **Models & planes:** load a venue model (`.glb`/`.gltf`) and add screen **planes** from the outliner
  (top-right) to show surface/timeline content in 3D. Toggle visibility or remove items there, and
  **Save** from the outliner.

The LEDs light up with live output colors, so the 3D view matches what your rig is doing.

---

## 14. Projects, media library & broadcast mode

**Save/open** (File menu): *New Project* (**Ctrl/Cmd+N**), *Open…* (**Ctrl/Cmd+O**), *Save*
(**Ctrl/Cmd+S**), *Save As…* (**Ctrl/Cmd+Shift+S**). Projects store everything — surfaces, fixtures,
controllers, settings, brightness, groups, scenes, the 3D scene, the timeline, the media library, and
projector outputs. **Open Recent** lists your last projects.

**Projects are folders.** *New Project* now prompts you for a **location** and creates a project
**folder** — `project.artlux` plus an `assets/{video,images,models,tracking}/` tree — and saves it
immediately, so imported and recorded media always has a home. *Open Project Folder…*
(**Ctrl/Cmd+Shift+O**) opens one. Asset paths inside the folder are stored relative, so you can zip or
move the whole folder and it stays self-contained.

### Media library
The left panel's **Media** tab is the project's media hub — video, images, 3D models and recorded
tracking takes in one place.

- **Import** — the **Video / Image / Model** buttons copy the chosen files **into** the project's
  `assets/` folder (so the project stays portable). Recorded **takes** appear here automatically
  (recorded from the Timeline — [§11](#11-the-timeline--state-machine)).
- **Browse** — filter by type, search by name. Each tile shows a thumbnail (a video frame, the image,
  a take's blob-density, or a model glyph) and a badge: **used N×**, **unused**, or **⚠ missing**.
- **Place** — **drag a tile** onto a Stage surface (sets its video/image content) or onto a Timeline
  lane (creates a clip). Or select a video/image tile and click **Use** to assign it to the selected
  surface.
- **Manage** — open the full **Asset Manager** (the ⤢ button) to see an asset's **usage** (click a
  surface usage to jump to it), **Relink** a moved/missing file (every reference updates),
  **Reveal in folder**, **Remove**, and **Consolidate** (copy any still-external media into the folder
  and relativize paths — the successor to *Collect Assets*).

See [ASSETS.md](ASSETS.md) for details.

**Broadcast (show) mode:** File → **Launch in Broadcast Mode** opens every enabled output fullscreen
and streams Art-Net/sACN with no editor UI. Quit it from the system-tray icon or with
**Ctrl/Cmd+Shift+Q**.

**Updates:** Help → *Check for Updates…* (Windows/Linux auto-update; macOS prompts you to download).

---

## 15. Keyboard & mouse reference

Text-field typing suppresses these shortcuts.

### Global (anywhere in the editor)

| Shortcut | Action |
|----------|--------|
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y | Redo |
| Ctrl/Cmd+A | Select all fixtures |
| Ctrl/Cmd+N | New project (prompts for a folder) |
| Ctrl/Cmd+O | Open project |
| Ctrl/Cmd+Shift+O | Open project folder |
| Ctrl/Cmd+S | Save |
| Ctrl/Cmd+Shift+S | Save As |
| Ctrl/Cmd+, | Preferences |
| Ctrl/Cmd+Shift+M | OSC Monitor (LiDAR feed sniffer) |
| F1 | Toggle the Help panel |
| Ctrl/Cmd+Shift+Q | Quit (also quits broadcast mode) |
| Ctrl/Cmd+R | Reload |
| Esc | Close the open dialog |

### 2D stage (surfaces & fixtures)

| Input | Action |
|-------|--------|
| Drag body | Move surface/fixture |
| Drag corner handle | Resize (corner = both axes; side handles on fixtures = one axis) |
| Drag top handle | Rotate (snaps to 45° with snapping on) |
| Click fixture + Ctrl/Cmd or Shift | Add/remove from multi-selection |
| Click empty space | Deselect |
| Mouse wheel | Zoom (toward cursor) |
| Shift + wheel | Pan horizontally |
| Middle-drag (or Shift+drag) | Pan the view |
| Magnet / grid buttons (stage top-right) | Toggle snapping / grid; reset view |

### Timeline

| Shortcut | Action | Shortcut | Action |
|----------|--------|----------|--------|
| Space | Play/pause | M | Add marker |
| L / K / J | Play / pause / (pause) | I / O | Set in / out |
| Shift+L | Toggle loop region | B / V | Blade / select tool |
| F | Maximize / restore | S / N | Toggle snapping |
| C | Blade at playhead | Delete | Ripple-delete (Shift = lift) |
| + / − / wheel | Zoom in / out | Home / End | Seek start / content end |
| Shift+wheel | Scroll horizontally | Middle-drag | Pan both axes |

### 3D Scene

| Input | Action |
|-------|--------|
| Left-drag | Orbit camera |
| Middle/right-drag | Pan camera |
| Wheel | Zoom camera |
| W / E / R | Move / rotate / scale the selected fixture |
| Click empty space | Deselect |

### Projector alignment (on the projector window)

| Input | Action |
|-------|--------|
| Drag handle | Move a corner / control point |
| Arrow keys | Nudge selected handle (Shift = ×10) |
| R | Reset corners/warp |
| Esc | Finish aligning |

---

## 16. Monitoring (Prometheus & Grafana)

ArtLux can report live health metrics — output FPS, packets/sec, active universes, CPU and memory —
that you can graph on a dashboard, on this machine or another one on the network. It's built to be
**cheap on the machine running the show**: ArtLux only publishes a tiny text page; the graphing tools
(Prometheus + Grafana) do all the heavy lifting and run wherever you like.

- **How it works.** ArtLux exposes a metrics page at `http://127.0.0.1:9464/metrics`. A collector
  (**Prometheus**) reads it every few seconds and stores the numbers; **Grafana** draws the dashboard.
  Nothing is pushed and no extra process runs inside ArtLux — the page is only generated when read, so
  the cost on your output machine is negligible.
- **Turn it off / move it.** It listens on loopback only by default (invisible on the network). Set the
  environment variable `ARTLUX_METRICS=0` to disable it entirely, or `ARTLUX_METRICS_HOST=0.0.0.0` to
  allow another machine (or Docker) to read it. Port is `ARTLUX_METRICS_PORT` (default `9464`).
- **See the dashboard.** Open Grafana (default `http://localhost:3001`, login `admin` / `admin`) and
  pick the **ArtLux** dashboard. The `artlux_output_up` panel reads **LIVE** while output is running.
- **Watching from another machine.** Run Grafana/Prometheus on your laptop, start ArtLux with
  `ARTLUX_METRICS_HOST=0.0.0.0`, and point the collector at this machine's LAN address on port `9464`.

Full setup (Docker one-liner, native-binary path, and the ready-made dashboard) is in
[docs/MONITORING.md](MONITORING.md).

---

## 17. Troubleshooting

- **My LEDs are dark.** Check the chain: the surface has content (not *None*), a fixture is placed over
  it and linked (*Mapping → Surface*), the fixture is patched (Auto-patch), and DMX output is enabled
  with the right IP/protocol in Preferences.
- **Colors are swapped (red shows as green, etc.).** Set the fixture's **Color order** (often GRB).
- **A matrix is scrambled / zig-zags wrong.** Toggle **Serpentine**, or **Reverse**; for odd wiring
  load a **ledmap**. Don't both bake serpentine into a ledmap *and* leave the toggle on.
- **Video stutters.** Use HAP-encoded `.mov` for heavy clips; cap projector **FPS** if a multi-output
  rig is GPU-bound.
- **NDI source missing.** Install the free **NDI Tools/Runtime** (the NDI content panel links to it),
  then **Refresh**.
- **Camera is blank.** Grant camera permission, and make sure no other app is holding the device.
- **Projector geometry looks off.** Re-**Align** the output; **R** on the projector window resets to a
  clean rectangle to start over.
- **No output on the network.** Confirm the target IP/broadcast and that another tool (e.g. an Art-Net
  monitor) isn't binding the same UDP port; verify with the **DMX Monitor** tab.
- **The Grafana dashboard is empty.** In Prometheus (`http://localhost:9090` → Status ▸ Targets) the
  `artlux` target should be **up**. If it's down: ArtLux isn't running, or — when graphing from Docker /
  another machine — it was started without `ARTLUX_METRICS_HOST=0.0.0.0`. See [Monitoring](#16-monitoring-prometheus--grafana).
