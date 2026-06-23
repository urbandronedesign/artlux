# ArtLux — Feature & Usage Guide

How to use ArtLux end-to-end. For the engine internals see
[ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md); for the build log see [PROGRESS.md](PROGRESS.md).

## Workspace layout (MadMapper logic)
- **Top bar**: brand · undo/redo · **File menu** (save/open/recents/rig) · **module switcher**
  (Media · Map · Fixtures · 3D) · transport (play/pause) · DMX-monitor toggle · Preferences.
- **Left panel**: browser (**Surfaces** tree + Fixtures tree + groups + scenes) on top, **inspector**
  below — the inspector shows surface properties or fixture properties depending on the selection.
- **Center**: the persistent 2D **Stage** (Media/Map/Fixtures) or the **3D simulator** (3D module).
  On the stage, **surfaces are cyan**, **fixtures are red**.
- **Bottom dock**: **DMX Monitor** (live per-fixture pixel output) and **Fixture Editor**
  (pixel structure).
- **Status bar**: contextual help (hover any control) · render FPS · LIVE/target · native engine stats.

## The core workflow (Surfaces model)
See [SURFACES.md](SURFACES.md) for the full design.
1. **Create a Surface** — add a surface (cyan rectangle) and place it on the stage (drag to move,
   corner to resize, top handle to rotate; or use the inspector Transform).
2. **Feed it content** — with the surface selected, pick its **Content**: video / image / camera /
   Spout / DMX-in / effect (effects render in S2). One live input (camera/Spout) at a time.
3. **Create & place Fixtures** — add LED fixtures (red), position them over the content, and **link**
   each to a surface (inspector → Mapping → **Surface**; new fixtures auto-link to the first surface).
4. **Patch** — universe, start address, LED count, color order, channels, matrix/serpentine, ledmap.
5. **Monitor & output** — the DMX Monitor dock shows live values; Art-Net/sACN streams to hardware.

Each fixture samples **only its linked surface** (strict per-surface, regardless of overlap) on the
WebGPU path; the WebGL fallback samples the composite (degraded).

## Routing & auto-patch
Universes/addresses are assigned **automatically**: as you add/remove fixtures (or change LED count,
channels, or controller) the patch re-packs sequentially per controller. Open the **Routing**
spreadsheet (TopBar network icon or File → Routing…) to:
- manage **Controllers** (physical output devices: name, protocol, IP, broadcast, start universe,
  sACN priority) — fixtures assigned to a controller are packed into its universes and output to its IP;
- patch every fixture in a grid (surface link, controller, universe/start, channels, LED count);
- **lock** a row to set its universe/address manually (auto otherwise), or hit **Auto-patch**.
A fixture with no controller falls back to the global Preferences target. Save the selected fixture
as a reusable **template** from the browser **Library**.

## Surface content sources
Select a surface, then in the inspector **Content** section:
- **Video / Image / Camera** — load a file or use the webcam (`getUserMedia`); each video/image
  surface has its own player.
- **DMX In** — capture incoming Art-Net/sACN as the surface's content (single live input).
- **Spout** (Windows) — receive a live GPU stream from Resolume/MadMapper/TouchDesigner; pick a
  sender (or "Active sender") + refresh. Received natively, downscaled, composited (single live).
- **Effect** — a generative shader fills the surface (rendering arrives in S2; params save now).

## Effects & palettes
Effects are a **surface content type** — a 2D shader (Solid / Rainbow / Palette Flow / Wave / Fire)
fills the surface; linked fixtures sample it like any media. Per-fixture effects are retired (the
engine now samples each fixture's surface). Groups can still copy a fixture's look.

## Output: Art-Net / sACN
Open **Preferences → DMX Output**:
- **Protocol** — Art-Net or sACN (E1.31); **Target IP**, **Port**, **Broadcast/multicast**.
- **Discover** — broadcasts an **ArtPoll**; lists responding nodes by name + IP. Click one to set the
  target IP.
- **Synchronous output (ArtSync)** — after each frame's data packets, ArtLux sends an **ArtSync**
  (`0x5200`) so all nodes latch and output simultaneously (tear-free multi-universe).
- **Engine** — output **FPS**, **keep-alive** (re-send last frame so receivers never starve),
  **gamma**.

**Per-fixture routing** (Fixtures inspector → Routing): override protocol / target IP / broadcast /
sParse / sACN priority per fixture, so one show can address many controllers.

## Projects, rigs & preferences
- **Save / Save As / Open** (File menu or top bar) — native dialogs writing `.artlux` project files
  (fixtures, settings, brightness, groups, scenes).
- **Auto-restore** — settings, master brightness, recent files, and the last project reload on launch.
- **Recent files** — quick-reopen from the File menu.
- **Export / Import Rig** — `.artrig` holds only patch/wiring/routing/geometry (no effects, scenes,
  or media), so you can carry a rig between shows. Import appends the rig's fixtures.

### Portable projects (project folders + Collect Assets)
For a show you can move between machines or hand off, make the project a **folder** instead of a lone
file. A project folder holds `project.artlux` plus an `assets/` tree:

```
MyShow/
  project.artlux
  assets/
    video/      # timeline clips, surface videos
    models/     # GLB/glTF venue models
    images/     # surface images
```

- **New Project Folder…** (Ctrl/Cmd+Shift+N) — choose an existing folder or create a new one; ArtLux
  scaffolds the `assets/` tree and saves `project.artlux` into it.
- **Open Project Folder…** (Ctrl/Cmd+Shift+O) — pick a project folder to open its `project.artlux`.
- **Collect Assets…** (File menu) — copies every referenced video, 3D model, and image into the
  project's `assets/` tree and rewrites the project to point at the local copies (de-duped by name +
  size). A summary reports how many were copied, skipped (already collected), or missing on disk. Run
  it before sharing, then copy or zip the whole folder — it's self-contained.

Asset paths inside a project folder are stored **relative to the folder**, so moving or copying the
folder keeps every asset linked. Surface videos/images are stored by file path (not a temporary
in-memory reference), so they persist across reloads and are collected like everything else. Single
`.artlux` files still work; run **Collect Assets** on one to migrate it into a folder.

> **glTF note:** `.glb` is self-contained and collects cleanly. A `.gltf` that references external
> `.bin`/texture files won't have those companions collected — prefer **GLB** for portability.

## 3D simulator
Switch to the **3D** module to place fixtures in space. Each fixture has a 3D position/rotation and a
layout (line / matrix / arc). Use the Move/Rotate gizmo; the LEDs render live with bloom.

## Projector outputs (projection mapping)
Send any **Surface** to a real projector as its own **fullscreen output** — with **corner-pin** or
**Bézier warp**, **soft-edge blend**, **per-screen gamma**, **MSAA**, and a **performance FPS cap**.
Open **Outputs** (top bar), enable a surface, and pick a display. Full guide + architecture in
[OUTPUTS.md](OUTPUTS.md).

## Headless mode
Run the compute + output engine with no UI (lower CPU/GPU, good for installs/servers):

```bash
ArtLux.exe --headless --project="C:\path\to\show.artlux"
```

It loads the project, runs the WebGPU mapper in an invisible window, and emits Art-Net/sACN (and
ArtSync) at the configured FPS. Omit `--project` to use the last-opened project. Note: media sources
aren't stored in the project file, so headless drives **Effect** and **DMX-in** fixtures (Spout also
works); media-source fixtures render black.

## Broadcast (show) mode
Run the projector **outputs + Art-Net** with **no editor interface** — for an installed show:

```bash
ArtLux.exe --broadcast --project="C:\path\to\show.artlux"
```

It opens every enabled output fullscreen and streams Art-Net, controlled from a **system-tray icon**
and a global **Ctrl/Cmd+Shift+Q** hotkey (or **File ▸ Launch in Broadcast Mode** from the editor).
See [OUTPUTS.md](OUTPUTS.md).

## Keyboard
- **Ctrl/Cmd+Z** undo · **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redo.
- **Ctrl/Cmd+Shift+Q** quit — works in both the editor and broadcast mode, even from a focused
  fullscreen projector window (closes every projector cleanly).
- **Esc** closes the Preferences dialog.
