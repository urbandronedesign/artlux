# Changelog

## Unreleased

## v0.21.0

- **New: In-app Docs & Tutorials browser + illustrated example tutorials (`src/main/docs.ts`, `src/renderer/components/DocsBrowser.tsx`).** A **Help ▸ Docs & Tutorials** viewer — a dockable right-side panel that **detaches into its own window** — renders the shipped example/tutorial sets and the **illustrated user guide** as in-app markdown, with sibling **images loaded inline** (a main-side reader hands the sandboxed renderer image bytes over a traversal-guarded IPC, which wraps them in blob URLs) and **"open example"** links that load the `.artlux` straight into the editor. Bundled into packaged builds via `extraResources` (examples + user guide). Ships two openable **tutorial courses** — **LiDAR blob tracking** (feed → calibrate → replay, driven by a bundled synthetic emitter, no hardware) and the **state machine** (looping show → triggers → interactive installation) — each now illustrated with **self-contained SVG diagrams** (state graph, hub-and-spoke, tracking zones, merge-people). Adds new reference docs (**STATE-MACHINE, EFFECTS, CODECS, SPOUT**) and a **`plans/`** folder of implementation plans (incl. the native audio engine) with a dev-sequencing guide. `tsc` + `npm run build` clean; all 23 doc image references validated (resolve + read), docs-scan + traversal guard exercised, in-app visual test confirmed.
- **New: Unattended self-healing watchdog (`src/main/watchdog.ts`).** Keeps a broadcast/show install
  alive without a human. **Two tiers:** Tier-1 (in-app, main process) detects renderer crash
  (`render-process-gone`), GPU crash (`child-process-gone` type GPU), an unresponsive window, a **frozen
  render loop** (no `render:stats` heartbeat), and **sustained Art-Net output loss** (`fps==0` after the
  wire was live), and recovers with a **full leak-safe relaunch** into `--broadcast --project=…` (the same
  clean-process pattern the playlist scheduler uses — no media/GPU/undo leaks). Tier-2 is a **Windows
  Scheduled Task** (logon + every-minute; `scripts/{install,uninstall}-watchdog-task.ps1` +
  `watchdog-check.ps1`) that relaunches the app if the whole process is gone (hard crash / reboot). A
  **crash-loop circuit breaker** (`maxRelaunchesPerHour`, persisted across relaunches) writes a tripped
  marker and stops rather than storming — **both tiers honor it**. A new **single-instance lock**
  guarantees the two tiers never run two copies. Every detection/recovery is written to a persistent,
  **tail-on-boot** JSONL event log (`userData/artlux-watchdog.log`) surfaced in **Preferences → Unattended
  / Watchdog** and the tablet **Metrics** tab, so an overnight run is auditable. **Off by default; arms
  only in `--broadcast`** (or `unattended.always`) so it never surprises a developer in the editor. Config
  lives on `Prefs.unattended`. `tsc` + `npm run build` clean; on-hardware unattended validation pending.
  See [docs/WATCHDOG.md](docs/WATCHDOG.md).
- **New: Show Control — tablet remote + scheduler + project playlist (`plugins/show-control`).** A
  cross-process first-party plugin: an embedded **HTTP + Server-Sent-Events** server (main) serves a
  self-contained tablet **PWA** (any phone/tablet browser, zero install) with tabs for **Control**
  (scenes / cue columns / transport), **States** (drive the state machine — enable, fire manual
  transitions, jump to any state; works in **broadcast** mode where the tablet is the only UI),
  **Schedule** (in-project time-of-day triggers), **Projects** (scan a folder, build a time-of-day
  playlist), and **Metrics** (the Grafana series — output fps/pps/universes, **renderer** fps/frame-p99/
  work-p99/long-frames, and system CPU/RSS/heap/event-loop-lag — live with sparklines, no Grafana
  needed). Secured by **PIN pairing** + per-device tokens with an operator **Lock**/kick; a **QR code**
  on the operator panel (View ▸ Show Control) encodes a `?pin=` URL so scanning opens the PWA and
  **auto-pairs**. Commands reuse the existing `cueBus`/`timeline` buses via a new **`host.show`** SDK
  service (no show-model coupling, **zero project migration** for triggers); adds `ProjectData.schedule`
  and a `ctx.onRenderStats` context hook. Two scheduler layers: in-project `ScheduleEntry` (renderer
  tick — this app disables renderer timer throttling, so it runs in broadcast) and a machine-global
  **project playlist** that switches whole projects unattended by **relaunch-per-project** (a fresh
  process each switch — no media/GPU leaks over days; stateless across relaunch, loop-guarded). Transport
  is SSE (zero deps, native `EventSource` reconnect — a tablet self-heals across a broadcast relaunch);
  the PWA + QR encoder are embedded (no second build, no CDN). `tsc` + `npm run build` +
  `verify:plugins` clean; server/pairing/command/SSE/scan + a live 3-series metrics frame verified
  end-to-end against the dev app, and the QR Reed–Solomon core asserted against the QR-spec test vector.
  On-hardware validation (physical tablet + a real broadcast project switch) pending. See
  [docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md).
- **New: Augmenta optical tracking (`plugins/augmenta`).** An [Augmenta](https://augmenta.tech) box +
  camera as a *tracking source* — each tracked object streamed over **OSC v2 / Fusion** becomes a
  normalized position that maps onto a surface like a LiDAR blob, from a self-contained pre-calibrated
  sensor. Standalone **renderer-only** plugin (own store + `SourceType.AUGMENTA`) that **shares the
  host's single OSC listener** — no main-process half, no native crate, no transport changes: point the
  box at the app's OSC port and the `/au/…` messages fall through the control router to the plugin. Adds
  an Augmenta content source (GPU markers / heading / trails, the LiDAR look), a projector
  snapshot+render channel, a 3D field-and-objects scene overlay, an **Augmenta Monitor** debug modal
  (View menu) for validating the wire on hardware, and an **Augmenta Tracking** Preferences section. The
  3D viz places objects at their real-world field position directly (the box reports field size in
  metres), so there is no floor-calibration wizard. `scripts/augmenta-emitter.cjs` drives the whole
  pipeline in dev without the box; parser + emitter→`oscManager`→store verified end-to-end. The exact
  `/au/` address/arg schema is finalized on hardware via the Monitor. See [docs/AUGMENTA.md](docs/AUGMENTA.md).

## v0.20.0

- **New: per-scene timelines + per-state authoring loop.** Each **Scene** may now own its own
  **Timeline** (its own tracks/clips/playhead). Recalling a scene **warm-swaps** the playback engine to
  that timeline; scenes without one fall back to the shared global timeline (additive, **zero project
  migration**). The engine holds **pool-keyed per-layer decoders per scene** (one active at a time —
  `warmPool`/`swap`/`releasePool`) with a **clean first-frame restart** on every trigger, and a tiered
  **preloader** (`services/timelinePreloader.ts`: ACTIVE / ≤`MAX_WARM` WARM / COLD, LRU + FSM
  look-ahead) keeps swaps hitless — steady-state load stays that of a single-timeline app, and only the
  active scene holds live NDI/camera/Spout receivers (one transport at a time). The timeline **editor
  binds to the current scene** (initial-state scene on load, and follows GO/cueBus/FSM), so "just
  editing" attaches to a real scene instead of Global; `buildSceneSnapshot` is now **look-only** so
  "Update Scene" never clobbers a scene's timeline; projector windows receive the current scene's
  timeline. UX: a Timeline **scene/state pill** + author strip (Prev/Save/Next), empty-timeline CTA,
  per-state **accent** identity, state-graph build-status badges + "Edit timeline", and a Scenes/Cues
  cell **Edit** + hover-preload. Verified end-to-end via `scripts/test-scene-timelines.cjs` (CDP,
  10/10). See [docs/SCENE-TIMELINES.md](docs/SCENE-TIMELINES.md).
- **New: camera pose tracking (`plugins/mediapipe`).** A webcam + Google MediaPipe **BlazePose** as a
  *tracking source* — each detected person becomes a normalized position that maps onto a surface like
  a LiDAR blob, so body-driven interactive mapping works with no specialized sensors. Standalone
  renderer-only plugin (own store + `SourceType.MEDIAPIPE`), inference runs **in-renderer via WASM +
  WebGL GPU delegate** (no native crate). Adds a MediaPipe content source (GPU markers / skeleton /
  trails), a projector snapshot+render channel, a 3D scene overlay, a **Pose Monitor** debug modal
  (View menu), and a **Pose Tracking (MediaPipe)** Preferences section (camera / model / delegate /
  max-people / confidence). Model + WASM assets are staged offline with `npm run assets:mediapipe`;
  when absent the feature logs and no-ops (graceful degrade). See [docs/MEDIAPIPE.md](docs/MEDIAPIPE.md).
- **New: MediaPipe floor calibration + real-world position preview.** For a camera pointed at a floor, a
  **Pose Floor Calibration** wizard (View menu) relates the video feed to real space with a 4-point
  homography — drag four handles onto a known floor rectangle, enter its width × depth (metres), save.
  The 3D scene then previews each person at their mapped real-world position on the floor (foot
  ground-contact mapped through the homography), mirroring the LiDAR floor viz. Calibration persists per
  project in `Scene3D.mediapipeFloor`. Display-only for now (content stays image-space). Reuses the
  projector corner-pin math (`squareToQuad`/`applyH`); no camera-intrinsics solve — a plane needs 4
  points. See [docs/MEDIAPIPE.md](docs/MEDIAPIPE.md).

## v0.19.2

- **Fix: packaged app started with no window at all.** On some packaged builds/GPU configs the
  window's `ready-to-show` event never fired, so the editor window (created hidden) was never
  revealed — the process ran but nothing appeared on screen (looked headless; not broadcast). Dev was
  unaffected. The editor window is now revealed on `did-finish-load` (which always fires) plus a
  backstop timer, in addition to `ready-to-show`, so it can never launch with no visible window.

## v0.19.1

- **Fix: packaged app no longer launches hidden.** On machines that set `ELECTRON_RUN_AS_NODE=1` in the
  environment (common with Python/ML tooling), a double-clicked packaged ArtLux inherited it and the
  Electron binary ran as plain Node — the process started but **no window was ever created**, looking
  like a stuck headless run. The Electron **`runAsNode` fuse is now disabled** in packaging, so the
  binary ignores that variable and always starts as the real app. (Dev was unaffected.)

## v0.19.0

- **A performance pass across the render/output loop — steady framerate under load.** Groundwork for
  demanding features (e.g. sound spatialization) that need frames to never drop.
  - **Frame-time instrumentation.** A rolling-window monitor of the renderer loop — both the
    inter-frame interval (jank / dropped frames) and in-frame work time (headroom) — surfacing fps,
    p50/p99, and a dropped-frame count. Read it via an editor debug HUD (**Ctrl/Cmd+Alt+P** or
    `?perf=1`) or the new **`artlux_render_*` Prometheus gauges**, so broadcast/headless shows (no
    on-screen chrome) finally have a frame-health signal next to the native output pacer.
  - **Leaner frame loop.** Hoisted the per-LED / per-channel allocations out of universe packing,
    precomputed a controller→fixture map (was a linear scan per fixture per frame), cached the 2D
    context + reused the surface sort; broadcast/headless **skip the redundant composite** (fixtures
    sample per-surface there); Art-Net send is **throttle-first**, so frames dropped by the ~44 Hz cap
    allocate nothing.
  - **Surface atlas (multi-projector fix).** The WebGPU mapper now composes all surfaces into one
    atlas texture and does a **single upload + compute pass** instead of one per surface. Per-surface
    uploads were each stalling the main thread on the GPU process when projector output windows
    contend for it — a heavy 12,800-LED / 12-surface / 4-projector show went from **~16 fps to a
    locked 60**, scaling to 24 surfaces. Output is byte-identical to the previous mapper.

## v0.18.0

- **Plugin architecture — features become first-party plugins.** A new in-process, contribution-based
  plugin foundation: an npm-workspaces monorepo with an internal `@artlux/sdk`, host contribution
  registries, and a generic plugin IPC bridge. **LiDAR tracking** and **NDI** are the first two features
  extracted into self-contained plugins (`@artlux/plugin-lidar-tracking`, `@artlux/plugin-ndi`) — same
  behavior, cleaner boundaries — laying the groundwork for the rest of the app (next: projector
  calibration; see [docs/ROADMAP.md](docs/ROADMAP.md)).
- **State machine — a project-level "Show" graph.** An always-available finite-state graph over scenes:
  each state binds a scene (recalled on entry) and/or runs transport actions, driven on a standalone
  wall clock. Triggers cover **manual / after-delay / at-time / on-marker / on-clip-end**, with an
  **AutomataUI** node editor (per-state lock time + per-transition fade time, curved bézier edges,
  grouping regions).
- **Drop images straight onto timeline lanes** — with a thumbnail preview and one-step import into the
  project's asset library.
- **Contributor docs** — a full `CLAUDE.md` entry point (build/run, repo map, plugin conventions,
  documentation index) plus the `docs/ROADMAP.md` plugin-architecture roadmap.

## v0.17.0

- **Timeline = a full content + compositing system.** Two big additions on one shared model:
  - **Any source type as a clip.** A timeline clip can now carry a full content source — **Camera,
    Image, DMX-in, Spout, NDI, Effect, Tracking** — not just video. Right-click a lane to pick a type
    (the same source picker used by surfaces, now shared) and place a clip; a clip inspector configures
    it. Live sources are **scheduled** (a clip routes the live feed onto its layer only while the
    playhead is inside it) via a shared, refcounted receiver registry, so a feed runs when either a
    surface or a clip needs it. Overlapping Spout/NDI clips that want different senders show a conflict
    badge (single-sender, last-one-wins). Existing video/HAP clips and projects are unaffected.
  - **Layered Program output.** The timeline now **composites all of its layers** (top track in front,
    per-layer **opacity + blend mode**, with **enabled/solo/mute** finally gating the output) into one
    Program image each frame. A surface can route to the **whole Timeline (Program)** in addition to a
    single **Layer**; projector outputs stream it through the existing path. Per-layer opacity/blend
    live in a track-header popover.
- **The timeline Program on a 3D screen.** A 3D scene screen (plane or mesh) can display the whole
  composited timeline, not just one layer — via a **★ Timeline (Program)** binding (dropdown or a
  one-click **TL** toggle).
- **One unified 3D scene.** The detached "3D Scene" window is gone; the **split-view 3D pane** now
  carries the full toolset — object import/add (GLB + screen planes), per-object transform, the
  lighting/tracking controls, and Save — plus a **collapse** toggle and a **maximize-3D** button.
  Removing the second renderer process and its MessagePort bridge (per-LED pixel copies, frame
  streaming, tracking fan-out) is also a real performance win.

## v0.16.0

- **Pro calibration workspace (big RGB camera ⟷ 3D)** — the calibration camera now fills a large
  viewport in the left pane, side-by-side with the 3D scene, with **wheel-zoom, drag-pan, and a
  magnifier loupe** for sub-pixel point picking. The feed is now **true RGB** for both the OpenCV
  (DirectShow) and browser sources — previously it was reduced to grayscale before display — via a new
  native `camera_grab_rgba` colour path (the grayscale path is unchanged for detection/decode). A
  collapsible **Camera parameters** panel exposes the full set: exposure/gain/gamma/brightness/contrast
  plus white balance, focus, saturation, hue, sharpness, zoom, and resolution/fps, capability-gated per
  source.
- **Edit placed anchor points** — already-placed camera↔model correspondences are now editable. Select
  one from the camera marker, the 3D sphere, or the list; **drag or arrow-nudge** its camera point and
  **click the model** to re-place its 3D point. The pose re-solves automatically after each edit.
- **Camera-measured projector gamma + colour** — an **Auto-measure (camera)** button per output projects
  a grayscale level ramp, samples the camera RGB in the projector's lit footprint, fits the per-channel
  response, and writes the output's **gamma** + **colour gain** (white-point match). Applied through the
  existing GLSL/NVAPI uniforms.
- **Auto-Align: anchor markers** — each placed camera↔model correspondence now shows a numbered marker
  in **both** views: a cyan crosshair + number on the camera preview (with a dashed orange ring for the
  pending point awaiting its model match) and a matching numbered marker in the 3D scene. Same colour +
  number on both sides so pairs are easy to verify; the 3D markers appear as you place them (no longer
  only after a full solve) and aren't hidden behind the model.
- **3D models: independent per-axis scale + numeric transform** — models can now be scaled
  **non-uniformly** (X/Y/Z independent), via the gizmo's per-axis handles or exact numeric entry. The
  main editor's 3D view gained a **transform inspector** (Position / Rotation / per-axis Scale) for the
  selected model, and the Scene window's Scale field is now per-axis. Numeric fields are buffered (type
  decimals/values freely, commit on Enter or blur). Data model: `SceneModel.scaleXYZ` supersedes the
  uniform `scale` when set; existing projects keep their uniform scale until edited.

## v0.15.0

- **Markerless camera auto-align (projection mapping)** — a new **Auto-Align wizard** (Outputs →
  Calibrate → *Board → Auto-Align*) calibrates a projector against the loaded venue 3D model **without a
  checkerboard**: anchor a few camera↔model points, scan Gray-code, optionally **self-calibrate the
  camera lens from the scan**, raycast the venue mesh, and resection the projector. A **residual
  heatmap** flags model/scale mismatches. The scene then renders from the recovered viewpoint (true
  projection mapping). See [docs/AUTO-ALIGN.md](docs/AUTO-ALIGN.md).
- **Hardware warp + edge-blend via NVIDIA NVAPI** — on **Quadro / RTX-pro** GPUs, ArtLux can apply each
  projector's geometry **warp** and **edge blend** at the GPU **scanout** (content-agnostic, persistent)
  instead of in GLSL. New native addon `native/nvwarp` (Rust/napi over an NVAPI C++ shim), per-output
  **Hardware warp/blend** toggle, and a panic **Ctrl/Cmd+Shift+W clear-all** + clear-on-quit so a warp is
  never left stuck. Built and validated on an **RTX 6000 Ada**; GLSL is the automatic fallback on every
  other GPU. See [docs/NVWARP.md](docs/NVWARP.md).
- **World-space multi-projector blend** — `blendCompute` computes a per-projector alpha map on the actual
  3D surface (partition of unity → seamless overlaps), feeding both the NVAPI intensity map and GLSL blend.
- **MPCDI export/import** — projector calibration round-trips through the **MPCDI** interchange format.
- **Calibration: black-camera hint** — if a camera opens but delivers all-black frames (almost always
  another app — Teams, the NDI Webcam tool, OBS — holding the device, or a USB hiccup), the wizard now
  says so ("Camera opened but the image is black…") with a close-it / replug / Restart prompt, instead
  of a silent black preview.

## v0.14.7

- **Projector calibration: PS3 Eye / OpenCV camera support** — the calibration wizard's Camera step
  now has a **Capture via** toggle: **Browser** (any `getUserMedia` webcam, as before) or **OpenCV
  (DShow)** for cameras the browser can't drive. The **PlayStation 3 Eye** and similar non-UVC
  cameras deliver frames to OpenCV's DirectShow backend but throw `NotReadableError` in Chromium's
  `getUserMedia`; ArtLux now captures those natively in the calibration addon (`VideoCapture` +
  `CAP_DSHOW`, MJPG 1280×720) and streams the frames into the same board-detect / structured-light
  pipeline — bypassing the browser entirely. OpenCV addresses DirectShow devices by **index**, so the
  wizard shows a **Device index** picker (try 0–5) instead of a name list, with the live board-detect
  overlay on a native preview. See [docs/CALIBRATION.md](docs/CALIBRATION.md) for PS3 Eye driver setup.
- **Camera start more robust** — the browser camera path now progressively relaxes the requested
  resolution (720p → 480p → any) so a limited camera that can't start at 720p is no longer misreported
  as "busy".

## v0.14.6

- **Tracking: robust person tracking** — the venue LiDAR feed flickers heavily (per-blob ids change
  ~8×/second), so the simple merge re-assigned person ids constantly. The merge now runs a small
  **predictive multi-object tracker** (velocity prediction + association gate + hit-confirmation to
  reject flicker + coasting through dropouts), giving each person a **stable id and steadier motion**.
  Validated against an on-site 3–4-person recording: distinct person-ids over 34 s dropped from ~152
  to ~23, with the count holding at 3–4 (median id now lives ~3.6 s, up to ~20 s). Default merge
  radius raised to 0.8 m. Off by default.

## v0.14.5

- **Tracking: merge blobs into people** — the venue LiDAR emits ~2 blobs per person on the floor
  (each with its own id). A new **"Merge people (2 blobs → 1)"** toggle (+ **Merge radius** slider) in
  the 3D Scene tracking controls clusters a surface's blobs within the radius into one centroid
  "person", feeding the 3D viz and projector outputs (raw OSC feed + recorded takes untouched).
  People get **temporally stable ids** (matched frame-to-frame by proximity, surviving the underlying
  blobs dropping/reacquiring). Off by default. See [docs/TRACKING_SYNC.md](docs/TRACKING_SYNC.md).

## v0.14.4

- **Custom single-line title bar** — the editor window is now frameless with its own VS Code-style
  top strip: the ArtLux logo, the `File/Edit/View/Window/Help` menus (app-styled dropdowns; all
  keyboard shortcuts unchanged), the toolbar action icons (3D Scene · Outputs · Routing · DMX
  Monitor · Preferences · Help), and the window min/maximize/close controls — all on one row. The
  separate toolbar row and the center play/pause button were removed (playback lives in the timeline
  panel + Space); the toolbar buttons are now icon-only with 3D Scene grouped on the right.
- **Dockable bilingual Help panel (EN/FR)** — a resizable right-side help panel (open with **F1**,
  the **?** toolbar button, or **Help ▸ Help Panel**). It shows contextual help for whatever control
  you hover/focus and a browsable set of topic guides (Getting Started, Surfaces, Outputs, OSC/LiDAR
  Tracking, Timeline, Shortcuts). An **EN/FR** toggle switches all help text and is remembered across
  sessions. Hover hints are now bilingual; the rest of the UI stays English.

## v0.14.3

- **Dark menu bar** — the native Windows menu bar (File/Edit/View/Window/Help) now renders dark
  instead of following the system light theme. Forced via `nativeTheme.themeSource = 'dark'` at
  startup.

## v0.14.2

- **OSC Monitor (sniffer)** — **View ▸ OSC Monitor** (`Ctrl+Shift+M`) opens a live view of the raw
  incoming OSC stream for testing the LiDAR feed: a receiving/listening status dot with live msg/s,
  per-surface blob cards (`active/total` + zone size, green when active), and an address table with
  per-address rate (Hz), count and last value, plus filter, pause, clear and a raw-message log. It
  taps the stream directly, so it shows the raw wire — including live blobs during take replay — and
  adds no load when closed. Ships `scripts/lidar-emitter.cjs` to drive it with synthetic blobs when
  no tracker is present. See [docs/OSC.md](docs/OSC.md).

## v0.14.1

- **Fix (tracking takes):** replayed takes now show on **fullscreen projector** and **3D Scene**
  outputs, not just the main canvas. The blob bridge's stale-frame filter was dropping a recorded
  take's original timestamps; applied snapshots are now stamped fresh so they survive the bridge.

## v0.14.0

**Record & replay LiDAR takes, and a managed media library.**

- **LiDAR take recording & replay** — capture the live LiDAR blob feed into reusable *takes* and
  place them on a dedicated **tracking lane** of the timeline, so a show can be simulated and
  rehearsed with no tracker present. Record from the timeline's Takes bin (independent of the
  transport), drop a take on the tracking lane, then play or scrub to replay the recorded blobs
  into the 3D Scene and projector outputs. While a take plays it drives the blobs and the live OSC
  feed is suppressed (global simulation override); past the clip the live tracker resumes. Takes are
  stored as compact `.lblob` sidecars.
- **Asset library + Asset Manager** — a new **Media** tab in the left sidebar manages all project
  media — video, image, 3D model, and take — in one place: import (files are copied into the
  project's `assets/` folder), thumbnails/previews, search + type filters, and *used / unused /
  missing* badges. Drag a tile onto a Stage surface or a timeline lane to place it. A full-screen
  **Asset Manager** adds per-asset usage (jump to where it's used), relink, reveal-in-folder,
  remove, and one-click **Consolidate**. **New Project** now always creates a project folder
  (prompts for a location and saves immediately), so imported and recorded media always has a home.
- **Monitoring (Prometheus + Grafana)** — ArtLux now exposes a Prometheus metrics endpoint from the
  main process at `http://127.0.0.1:9464/metrics` (output FPS/packets/universes/up, plus CPU, memory and
  event-loop lag). Pull-based and near-zero cost on the show machine: nothing is pushed and the page is
  only generated when scraped. Loopback-only by default; `ARTLUX_METRICS=0` disables it,
  `ARTLUX_METRICS_HOST`/`ARTLUX_METRICS_PORT` move it. Ships a ready local stack in `monitoring/`
  (Docker Compose with an auto-provisioned Grafana dashboard) and a guide in `docs/MONITORING.md`.

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
