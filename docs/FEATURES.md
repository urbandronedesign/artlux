# ArtLux — Feature & Usage Guide

How to use ArtLux end-to-end. For the engine internals see
[ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md); for the build log see [PROGRESS.md](PROGRESS.md).

## Workspace layout (MadMapper logic)
- **Top bar**: brand · undo/redo · **File menu** (save/open/recents/rig) · **module switcher**
  (Media · Map · Fixtures · 3D) · transport (play/pause) · DMX-monitor toggle · Preferences.
- **Left panel**: browser (fixtures tree + groups + scenes) on top, **inspector** below — the
  inspector's sections change with the active module and the selected fixture.
- **Center**: the persistent 2D **Stage** (Media/Map/Fixtures) or the **3D simulator** (3D module).
- **Bottom dock**: **DMX Monitor** (live per-fixture pixel output) and **Fixture Editor**
  (pixel structure).
- **Status bar**: contextual help (hover any control) · render FPS · LIVE/target · native engine stats.

## The core LED-strip workflow
1. **Media** — pick a content source (video / image / camera / DMX-in / Spout).
2. **Map** — drag, resize, rotate, and snap fixtures over the content on the stage.
3. **Fixtures** — patch DMX: universe, start address, LED count, color order, channels (RGB/RGBW),
   matrix + serpentine, ledmap, and per-fixture output routing.
4. **Monitor** — open the DMX Monitor dock to watch the live values; output streams to your hardware.

## Content sources
- **Video / Image / Camera** — load a file or use the webcam (`getUserMedia`).
- **DMX In** — capture incoming Art-Net/sACN and use it as the content texture.
- **Spout** (Windows) — receive a live GPU video stream from Resolume, MadMapper, TouchDesigner,
  etc. In the **Media** module click **Spout In**, then pick a sender from the dropdown (or leave
  "Active sender") and hit refresh to re-scan. Frames are received natively, downscaled to 512²,
  and fed to the mapper.

## Effects & palettes
Per fixture (or per segment), set the source to **Effect** and choose an effect (incl. **fire2012**)
+ palette, with speed/intensity. Split a fixture into **segments** to run different looks across one
strip. Apply a fixture's look to a whole **group** from the browser.

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

## 3D simulator
Switch to the **3D** module to place fixtures in space. Each fixture has a 3D position/rotation and a
layout (line / matrix / arc). Use the Move/Rotate gizmo; the LEDs render live with bloom.

## Headless mode
Run the compute + output engine with no UI (lower CPU/GPU, good for installs/servers):

```bash
ArtLux.exe --headless --project="C:\path\to\show.artlux"
```

It loads the project, runs the WebGPU mapper in an invisible window, and emits Art-Net/sACN (and
ArtSync) at the configured FPS. Omit `--project` to use the last-opened project. Note: media sources
aren't stored in the project file, so headless drives **Effect** and **DMX-in** fixtures (Spout also
works); media-source fixtures render black.

## Keyboard
- **Ctrl/Cmd+Z** undo · **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redo.
- **Esc** closes the Preferences dialog.
