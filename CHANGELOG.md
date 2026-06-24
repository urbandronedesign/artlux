# Changelog

## v0.12.0

**Pro timeline — infinite, navigable, programmable.** The video-layer timeline becomes a full-screen
editing surface with a control layer. Clip editing stays UX-only; per-LED compositing is unchanged.

- **Infinite timeline** — the playhead now advances unbounded: place clips end-to-end to build long
  sequences and play right past the old fixed length. Where no clip sits under the playhead the output
  is black. Looping is now opt-in: toggle **Loop** (Shift+L) to wrap over the in/out region.
- **Mouse zoom & pan** — the mouse wheel zooms toward the cursor, **Shift+wheel** scrolls horizontally,
  and **middle-button drag** pans the timeline in any direction. The view grows as you explore.
- **Maximize** — drag the timeline dock's top edge to resize it, or press **F** (or the maximize
  button) to expand the timeline to fill the whole window; press again to restore.
- **State-machine control layer** — an always-present, optional logic layer that can drive the
  transport (play / pause / stop / seek / loop / jump-to-marker). Build a graph of states and
  transitions in the **Edit logic** editor; transitions fire manually (buttons on the state lane) or
  automatically after a delay, at a time, on a marker, or when a clip ends. Disabled by default; turn
  it off any time to return to manual control.

> No native rebuild required. Old projects load unchanged (new fields default in). Note: projects that
> previously looped at their set length now play unbounded unless you enable Loop.

## v0.11.0

**DaVinci-style timeline** — the video-layer timeline is reworked into a proper NLE editing surface.
Editing UX only; playback and per-LED compositing are unchanged.

- **Filmstrip thumbnails** — clips now show video-frame thumbnails along their length. Frames are
  decoded asynchronously into an LRU cache (a dedicated offscreen path for normal video, and a
  one-shot HAP decode on its own GPU context) so the strip never disturbs live playback.
- **Pro track headers** — per-track mute / solo / lock / show-hide, a color label, drag-to-reorder,
  and drag-to-resize track height. Lock blocks edits and drops on that lane. (Mute/solo/hide are
  visual aids — the output engine still shows the topmost clip per track.)
- **Blade, snapping & ripple** — a Blade tool splits clips at the cursor or playhead; magnetic
  snapping aligns drags to clip edges, the playhead, markers and the in/out range with a live guide;
  ripple-delete closes the gap left behind.
- **Frame-accurate timecode, markers & in/out** — an `HH:MM:SS:FF` ruler and readout at a settable
  project frame rate, colored timeline markers (add / seek / delete / note), and an in/out range band.
- **Keyboard shortcuts** — Space play/pause, L/K/J, B blade, V select, S/N snapping, M marker,
  I/O in/out, C blade-at-playhead, Delete ripple-delete, +/- zoom, Home/End — scoped to the timeline
  panel and suppressed while typing.

> No native rebuild required. Old projects load unchanged (new fields default in).

## v0.10.0

**Smoother HAP playback** — the HAP player is reworked for glitch-free, display-synced playback,
tuned for high-refresh output on high-end GPUs.

- **Vsync-locked cadence** — playback time is now derived from a single drift-free monotonic clock
  (instead of accumulating per-frame deltas) and the source frame is chosen by nearest-sample. On a
  display whose refresh is a multiple of the clip's rate (e.g. 30 fps on 120 Hz) each frame is held
  for an even beat, which removes the judder that came from uneven frame repeats.
- **No periodic hitch** — fullscreen projector outputs phase-lock their clock to the transport with a
  gentle continuous correction instead of a hard periodic resync, so the recurring stutter is gone.
- **Decode-ahead ring** — the decoder now keeps a short rolling buffer of upcoming frames decoded
  ahead of the playhead (and pre-warms the loop point), so the exact frame is ready in time instead
  of showing a stale/repeated one when decode briefly falls behind under load.
- **In-place GPU upload** — decoded blocks update the existing GPU texture in place rather than
  reallocating it every frame, removing per-frame allocation churn the driver could hitch on.

> Playback only — Art-Net output and per-LED sampling are unchanged. No native rebuild required.

## v0.9.0

**HAP video** — GPU-decompressed HAP playback. HAP-coded `.mov` clips now play natively: decoded
once in the main process (CPU/SIMD — no hardware video-decode session) and decompressed on the GPU,
so they run smoothly on timeline layers and video surfaces without the browser's H.264 decode limits.

- **HAP decoder** — new native addon (`native/hap`) parses the MOV container and the Snappy/chunked
  HAP sections; supports Hap (DXT1), Hap Alpha (DXT5), Hap Q (scaled YCoCg) and Hap 7 (BC7).
- **GPU decompression** — the renderer uploads the compressed DXT/BC blocks as an `s3tc` compressed
  texture (~8× less data over IPC than RGBA) and the GPU does the decompression.
- **Frame-accurate** — HAP is all-intra, so scrubbing decodes the exact frame; a small prefetch ring
  keeps playback smooth.
- **Drop-in** — assign a HAP `.mov` to a Video surface or drop it on a timeline layer; non-HAP `.mov`
  falls back to the browser `<video>`.
- **Broadcast** — fullscreen projector outputs decode HAP locally at full speed, so playback stays
  smooth even though the editor window is hidden.

Supporting changes: video sources are now decoded once in the main window and streamed to the
Scene/projector windows (avoids exhausting the GPU's concurrent hardware-decode sessions); a
broadcast-mode startup crash (eager auto-updater init) and a View-menu / DevTools crash are fixed.

## v0.8.0

Full-HD output in **Broadcast mode**. The low-res caps that keep the editor light now lift to
**1080p** when the app runs in `--broadcast` (show) mode, so projector outputs and NDI streams
carry full-HD quality; the editor keeps the lighter caps for responsive preview.

- **NDI send** — published projector outputs go out at up to **1080p** in Broadcast mode (≤720p in
  the editor).
- **NDI input** — received NDI sources are kept at up to **1080p** in Broadcast mode (≤720p in the
  editor), so they stay sharp on the projector and over NDI send.
- **Spout input** — received Spout sources are kept at up to **1080p** (aspect-preserving) in
  Broadcast mode (512² in the editor).

> The per-LED sampling resolution is unchanged — Art-Net output is identical; this only affects the
> projector display and NDI image quality. Lifting the NDI/Spout input caps requires the rebuilt
> native addons.

## v0.7.0

NDI® (network video) — the cross-platform counterpart to Spout.

- **NDI source** — receive an NDI stream as a Surface's content: pick **NDI** in the Inspector's
  Content section, choose a source, and it drives the surface (and the fixtures sampling it).
- **NDI send** — publish each **projector output** (the final corner-pin / Bézier-warped result) as
  its own NDI source (**“ArtLux — <surface>”**), so media servers / recorders / other software can
  receive the mapped output over the network. Toggle **Send as NDI** per output in the Outputs gear.
- Requires the free **NDI Runtime / NDI Tools** (<https://ndi.video>); ArtLux degrades gracefully and
  shows an install hint when it isn't present. NDI® is a registered trademark of Vizrt NDI AB.

> Note: NDI is **Windows-first**. Building the native NDI addon requires the NDI 6 SDK (`npm run
> build:ndi`); without it the app builds with NDI inactive.

## v0.6.1

- **Consistent quit**: **Ctrl/Cmd+Shift+Q** now quits from both the editor and broadcast mode —
  including when a frameless fullscreen projector window is focused (where the app menu can't be
  reached). The editor's File ▸ Quit shows the shortcut. Quitting always closes every projector
  window cleanly.
- Fixed **Launch in Broadcast Mode** when running unpacked/from source (the relaunch dropped the app
  path and opened Electron's default window). Packaged builds were unaffected.

## v0.6.0

Projection mapping — send each surface to a real projector — plus a broadcast (show) mode.

### Projector outputs
- **Send any surface to a physical display** as its own **fullscreen output** (projector). Open the
  **Outputs** panel (top bar), enable a surface, and pick a connected display — the output opens
  frameless-fullscreen on it while the editor keeps focus. Outputs are saved with the project and
  re-bind to a display by label across replug/reboot.
- **Corner-pin** alignment: click **Align** to drag the four corners onto the real projection surface
  directly on the projector (arrow-keys nudge, Shift ×10, **R** reset, **Esc** done), with a
  perspective-correct calibration grid.
- **Bézier warp**: enable per output for curved/irregular surfaces — a bicubic patch with 16 draggable
  control points (corners + curve handles) and a live curved calibration grid.
- **Soft-edge blend** (per-edge feather + blend gamma) for overlapping projectors, and a **per-screen
  gamma** control.
- **Anti-aliasing** (MSAA) on the warped output, and a **Performance mode** that caps projector output
  frame-rate (Off / 60 / 30 / 24).
- Outputs render content at native resolution; live camera / Spout / DMX-in sources are streamed to
  their output as well.

### Broadcast (show) mode
- Launch with **`--broadcast [--project=path]`** to run with **no editor interface** — only the
  fullscreen projector outputs and the Art-Net sender, from a saved project (falls back to the
  last-opened one). Controlled from a **system-tray icon** (Quit) and a global **Ctrl/Cmd+Shift+Q**
  hotkey.
- Or use **File → Launch in Broadcast Mode** in the editor to save the current project and relaunch
  straight into the show.

## v0.5.0

### Portable projects (project folders + Collect Assets)
- A project can now be a **folder** (`project.artlux` + `assets/{video,models,images}/`) instead of a
  lone file, so it's self-contained and shareable.
- New File menu items: **New Project Folder…** (Ctrl/Cmd+Shift+N), **Open Project Folder…**
  (Ctrl/Cmd+Shift+O), and **Collect Assets…**.
- **Collect Assets** copies every referenced video, 3D model, and image into the project's `assets/`
  tree (de-duped by name + size) and rewrites references to the local copies; a summary reports copied
  / skipped / missing counts. Asset paths inside a project folder are stored **relative to the folder**,
  so moving or copying the whole folder keeps every asset linked.
- **Surface videos/images now persist**: they're stored by file path instead of a temporary in-memory
  reference, so they survive reloads and are collected with everything else. (Previously surface
  video/image content was lost on reload.)
- Single `.artlux` files still open; run **Collect Assets** on one to migrate it into a folder. Project
  format bumped to `1.1`.
- Note: `.glb` collects cleanly; a `.gltf` referencing external `.bin`/textures won't have those
  companions collected — prefer GLB for portability.

### Fixed
- **CI release publishing**: the duplicate `builder-debug.yml` emitted per OS runner collided on a single
  asset name and failed the GitHub Release step (red CI since v0.4.1). It's now excluded from the release
  upload, so tagged releases publish cleanly.

## v0.4.1

- **Check for updates in About**: the About dialog now has a **Check for updates** button with inline
  status (checking / up-to-date / download / restart & install), so the updater is discoverable without
  the Help menu. (Auto-update still also runs on launch + Help → Check for Updates.)

## v0.4.0

A dedicated 3D Scene window and a video-layer timeline.

### 3D Scene window
- The **3D** view is now its own window (open from the top-bar **Scene** button) — put it on a second
  monitor while you map in the main window. It mirrors the live fixtures + LED colors over a fast
  renderer-to-renderer bridge.
- **Load GLB/glTF venue models** (multiple), each selectable in an **outliner** and transformable
  (**move / rotate / scale** gizmo, pivot at the mesh centre). Identical meshes are instanced; **Auto-fit**
  scales a model to a real-world size; per-object scale/position/rotation.
- **Real-time venue lighting**: each fixture casts a light coloured by its live LED output; plus
  environment ambient, exposure, a configurable grid, and an optional **reflective floor**.
- **Save** from the Scene window persists the scene into the project.

### Video-layer timeline
- A new **Timeline** dock tab: an NLE with **tracks** and **clips** — **drag-and-drop MP4s** onto a track,
  move/trim clips, scrub the playhead. The top-bar **Play** is the unified transport.
- Assign a **track (layer) to a surface** (Inspector → Content → **Layer**) so the surface (and the
  fixtures sampling it) show that track's video.
- Add **screen planes** in the 3D Scene and assign a **layer** to simulate a projection — the plane plays
  the track's video in sync with the main window.
- The timeline (tracks + clips), surface layer bindings, and plane assignments are saved with the project.

### UI / fixes
- **Slimmer top bar**: removed the logo/wordmark, undo/redo, save/open, and the Media/Map/Fixtures module
  buttons (those still live in the File/Edit menu + shortcuts). Added the **Scene** button.
- **No background throttling**: the engine, timeline, and DMX output keep running full-speed when the
  other window has focus (fixes video flicker / stutter while working in the Scene window).

## v0.3.1

- **Auto-update** (Windows / Linux): the app checks GitHub Releases on launch and from
  **Help → Check for Updates…**, then shows an in-app prompt. Nothing downloads or installs without
  your consent — you click **Download**, then **Restart & Install**. macOS shows a prompt linking to the
  Releases page instead (Squirrel.Mac needs a Developer ID signature, which these builds don't have).
  Note: auto-update works between releases that both ship the update metadata, so it takes effect for
  upgrades **from v0.3.1 onward** (install v0.3.1 manually once).

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
