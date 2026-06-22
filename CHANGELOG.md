# Changelog

## v0.3.0

Workspace rework, content-aware surfaces, and an Art-Net output fix.

### Workspace UI
- **Three-region layout**: left outliners + sliders, center stage + dock, **right Inspector/properties**
  panel (toggle from the status bar). Left-panel sections are **independently collapsible**, and
  **Surfaces / Fixtures grow** to fill the panel.
- **Dock fixture workspace**: the Fixture Editor tab now also holds fixture **Create** (add / auto-patch)
  and the **Library**, and the dock opens there by default.
- **Multi-select fixtures** for grouping — click / ctrl·cmd-toggle / shift-range in the outliner and on
  the stage; "Master Layer" or **Ctrl·Cmd+A** selects all. Group create / add-to-group act on the whole
  selection.
- **Smooth sliders**: dragging commits React state only on release; master brightness drives a
  render-free live preview, so sliders no longer stutter.

### Canvas & surfaces
- **Square (1:1) UV canvas** with a **mid-grey backdrop** and a **configurable layout grid**
  (toggle + divisions); surfaces and fixtures **snap to the grid** when snapping is on.
- **Surfaces keep their content's aspect ratio** — a surface fits its media's aspect on load, and the
  corner handle **scales uniformly** (no distortion). Move / scale / rotate every surface in the square.
- **Move surfaces by mouse**: fixed a layering bug where the fixtures layer swallowed all clicks.

### Fixes
- **Camera / live input**: the main process now grants the `media` permission, so Camera surfaces work
  (`getUserMedia` was silently denied).
- **Art-Net dropped-packets warning**: the sequence number is now **per universe** (was a single global
  counter, which monitors read as missing packets) — in both the native engine and the TS fallback.
- **Preview fidelity**: surface preview renders at full opacity; the DMX Monitor folds the RGBW white
  channel back into RGB so whites display. (Output was always correct — these were preview-only.)

## v0.2.1

- **macOS dmg fix**: the app is now **ad-hoc signed** during packaging (`afterPack` hook), so it runs
  on Apple Silicon instead of failing with *"ArtLux is damaged and can't be opened."* It is still not
  notarized (no Apple Developer account), so first launch needs a one-time Gatekeeper bypass:
  **right-click → Open → "Open Anyway"**, or `xattr -dr com.apple.quarantine "/Applications/ArtLux.app"`.
  (Builds are arm64 / Apple Silicon.)

## v0.2.0

The **Surfaces** release — a MadMapper-class content/mapping/routing model, plus app polish.

### Surfaces engine
- **Surfaces** as content carriers: each surface (cyan on stage) holds its own content — video,
  image, camera, Spout, DMX-in, or a 2D **shader effect** (Solid / Rainbow / Palette Flow / Wave /
  Fire). Create/select/transform from the browser or on-canvas (move/resize/rotate).
- **Strict per-surface sampling**: each fixture is **linked to one surface** and samples only it,
  regardless of overlap (WebGPU per-surface compute dispatch; WebGL fallback = composite).
- **Fixture library**: save a fixture as a reusable template (LED definition), stored across projects.
- **Controllers + automatic patch**: define physical output devices; universes/addresses are packed
  automatically per controller (lock a fixture to patch it manually).
- **Routing spreadsheet**: manage controllers and patch every fixture in one grid
  (TopBar network icon or File → Routing).

### Features
- Persistence: native Save/Open (`.artlux`), auto-restore on launch, recent files, `.artrig` rig
  export/import.
- Art-Net **device discovery** (ArtPoll) and **ArtSync** synchronous output.
- **Headless mode** (`--headless --project=…`) — run the GPU compute + output with no UI.
- **Spout** receiver (Windows) as a content source.

### App
- Teal "A" app icon, native File/Edit/View/Window/Help menu, About dialog, fixed play/pause,
  source-aspect stage.

### Engine (since 0.1.0 baseline)
- Native Rust (napi-rs) Art-Net + sACN output engine, WebGPU compute mapper, 2D matrix/ledmap/
  color-order/RGBW/gamma, 3D simulator, groups & scenes.

## v0.1.0
- Initial release: Electron + WebGPU pixel mapper + native Art-Net/sACN output; Windows/macOS/Linux
  installers via CI.
