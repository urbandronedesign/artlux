# Changelog

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
