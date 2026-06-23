# ArtLux — Projector outputs & Broadcast mode

Send each **Surface** to a real **projector** (its own fullscreen output, with corner-pin / Bézier
warp, soft-edge blend, gamma, and MSAA), and run a show with no editor UI via **Broadcast mode**.

This is the video-output counterpart to the LED engine: the same surfaces that drive Art-Net fixtures
can also be projected onto physical surfaces. Added in **v0.6.0**.

---

## For users

### Send a surface to a projector
1. Connect the projector as an extra display.
2. Open **Outputs** (top-bar monitor icon).
3. For a surface: tick **On**, then pick its **Display**. A frameless **fullscreen** window opens on
   that projector showing the surface's content. The editor keeps focus; LED output keeps running.
4. **Re-scan** re-enumerates displays after plugging/unplugging.

Outputs are saved in the project. Electron display IDs aren't stable across reboot/replug, so each
output also stores the display **label** and re-binds by label if the saved ID is gone.

### Align it onto the real surface
Click **Align** on the row, then work **on the projector**:
- **Corner-pin** (default): drag the four corners (TL/TR/BR/BL) onto the physical surface. A green
  perspective-correct calibration grid shows the mapping.
- Arrow keys nudge the selected handle (**Shift** = ×10), **R** resets, **Esc** finishes.

### Curved surfaces — Bézier warp
Open the row's **gear** ▸ tick **Bézier warp**. The mapping becomes a bicubic patch with **16 control
points** (4 corners + 12 curve handles). In **Align**, drag any control point; curved iso-lines + a
faint control net show the warp. Use it for cylinders, cyclorama corners, domes, angled walls.

### Overlapping projectors — soft-edge blend
In the gear panel, set per-edge **Soft edge %** (L/R/T/B feather) and **Blend γ**. Each output fades
its overlapping edge so two projectors sum to even brightness across the seam.

### Per-screen gamma
The gear panel has an **Output γ** slider per output — correct a projector that's darker/brighter than
the rest without touching the others.

### Quality & performance
- **Anti-aliasing**: outputs render with 4× **MSAA** and at the display's native resolution (crisp on
  4K).
- **Performance mode**: the Outputs header has an **FPS cap** (Off / 60 / 30 / 24) that throttles all
  projector output windows — the biggest easy GPU saving for multi-projector / 4K rigs.

### Content that works
File **video / image**, **effects**, and **timeline layers** render independently in each projector at
native resolution. Live **camera / Spout / DMX-in** are streamed from the main window to the output.

---

## Broadcast (show) mode

Run only the outputs + Art-Net, with **no editor interface** — for an installed show / playback
machine.

```bash
ArtLux.exe --broadcast --project="C:\path\to\show.artlux"
```

- Loads the project (or the **last-opened** one if `--project` is omitted), opens every **enabled**
  output fullscreen, and streams Art-Net/sACN — no editor window.
- **Control**: a **system-tray icon** (tooltip = project name, right-click ▸ **Quit Broadcast**) and a
  global **Ctrl/Cmd+Shift+Q** hotkey.
- From the editor, **File ▸ Launch in Broadcast Mode** saves the current project and relaunches
  straight into the show.

> Difference from `--headless`: headless is engine-only (Art-Net, invisible, **no projectors**);
> broadcast adds the fullscreen projector outputs + tray control.

### Quitting (both modes)
**Ctrl/Cmd+Shift+Q** quits cleanly from anywhere — editor **and** broadcast — including when a
frameless fullscreen projector window is focused (where the app menu can't be reached). The editor's
**File ▸ Quit** shows the same shortcut; broadcast also has the tray ▸ Quit. Any quit path runs the
same teardown: unregister the shortcut, destroy the tray, and close every projector window.

---

## For developers / architecture

### Data model (`shared/protocol.ts`)
- `ProjectorOutput { surfaceId, enabled, displayId, displayLabel?, cornerPin, warp?, softEdge?,
  gamma? }`, persisted as `ProjectData.projectorOutputs[]`. Global perf: `ProjectData.projectorFpsCap`
  (0 = uncapped).
- `CornerPin { tl,tr,br,bl }` normalized display-space corners.
- `BezierWarp { points:[16] }` — bicubic 4×4 control net (row-major, corners at indices 0,3,15,12).
- `SoftEdge { left,right,top,bottom,gamma }` (feather fractions 0..0.5).

### Windows & bridge (`src/main/projector.ts`)
- One frameless, fullscreen `BrowserWindow` per enabled output, positioned on the target display
  **before** `setFullScreen` (Windows multi-monitor) and shown with `showInactive()` so the editor
  keeps focus. Tracked in a `Map<surfaceId, {win, displayId}>`; `screen` watchers handle hot-plug.
- Bridged to the main window with a `MessageChannelMain` (one port pair each), the same pattern as the
  3D Scene window. The bridge works with the main window **hidden** (used by broadcast mode).

### Renderer (`src/renderer/projector/`)
- `projector.html` / `projector.tsx` → `ProjectorApp`: receives a `render` config + transport over the
  port, **self-renders** file/effect/layer content via `services/surfaceMedia` (native res), or draws
  transferred `ImageBitmap`s for singular sources, then warps it.
- `ProjectorGL.ts`: **WebGL2** with a **4× multisampled FBO** resolved via `blitFramebuffer` (WebGL1
  `antialias` fallback). One fragment shader does warp geometry + soft-edge feather + gamma. Draw
  buffer sized by `devicePixelRatio` (= the display's `scaleFactor`) for native-res output.
- `homography.ts`: corner-pin via the perspective-correct vertex `q` trick + Heckbert `squareToQuad`
  (used for the calibration grid).
- `warp.ts`: Bézier — `makeBezierWarp` seeds a flat patch from the corner-pin; `evalBezier` (bicubic
  Bernstein); `tessellateBezier(n)` → a `WarpGrid` mesh the GL renderer draws (24× per axis).

### Main-window glue (`src/renderer/App.tsx`)
- Holds `projectorOutputs` state + a single reconciler (`useEffect` on surfaces/outputs/displays) that
  opens/moves/closes output windows and re-matches displays by label.
- A `projectorPortsRef` map handles each output's port; pushes the `render` config + transport; a
  ~30 fps frame pump `createImageBitmap`s singular-source drawables and transfers them.
- **Broadcast branch**: gated on the `?broadcast=1` query (set by main). It auto-loads the project,
  then renders **only the offscreen `Stage`** — every output/projector effect above still runs, so
  Art-Net flows and outputs open without any editor chrome.

### Broadcast launch (`src/main/index.ts`)
- `--broadcast` → create the main window **hidden**, load `index.html?broadcast=1&project=…`,
  `setupBroadcastControls()` (Tray + `globalShortcut` Ctrl/Cmd+Shift+Q). `before-quit` unregisters the
  shortcut, destroys the tray, and `closeAllProjectors()`.
- File-menu **Launch in Broadcast Mode** → App saves, then `relaunchBroadcast(path)` IPC
  (`APP_RELAUNCH_BROADCAST` → `app.relaunch({args:['--broadcast','--project='+path]}); app.exit(0)`).

### Build
`electron.vite.config.ts` adds the `projector` HTML rollup input (alongside index/headless/scene).
electron-builder ships it automatically (`out/**/*`).
