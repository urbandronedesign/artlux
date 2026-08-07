# ArtLux — Feature & Usage Guide

How to use ArtLux end-to-end. For the engine internals see
[ARCHITECTURE.md](ARCHITECTURE.md); for the build log see [PROGRESS.md](PROGRESS.md).

## Workspace layout

The editor is organised as **workbenches**, not one fixed screen. A rail down the left switches
between nine of them, grouped by what you are doing:

| Cluster | Workbenches |
|---|---|
| **BUILD** | **Map** (place surfaces, map content, patch fixtures) · **3D** (the venue scene) |
| **ALIGN** | **Proj** (projector outputs) · **Calib** (projector calibration) |
| **SHOW** | **Cues** · **Machine** (the state graph) · **Audio** · **Show** (show control) |
| **APP** | **Prefs** |

Each workbench decides what surrounds the viewport — which browser lists on the left, which
parameters on the right, which panels in the dock — and **remembers its own sizes**, so the dock
height you set while patching survives a trip through Audio.

- **Title bar**: ArtLux logo · **File/Edit/Context/View/Window/Help** menus · action icons · window
  controls. Transport (play/pause) lives in the timeline and on **Space**.
- **Action bar**: the active workbench and the actions that belong to it (Add Surface, Auto-patch,
  Routing, Collect Assets, …).
- **The timeline is a DRAWER, not a workbench.** Eight of the nine pull it up with **Ctrl+T**, over
  the full width of the window, and each remembers whether you left it open. It is a tool you want
  *while* working in a viewport — cutting against the 2D stage, placing a recorded take on a lane with
  the rig in front of you — not a place you travel to.
- **Take recording is NOT in the timeline.** Capture is transport-independent, so the two recorders are
  dock panels — **Lighting Takes** (Venue & Rig, Scenes & Cues) and **Tracking Takes** (Venue & Rig,
  Show) — with matching action-bar buttons and **Ctrl+Shift+R** / **Ctrl+Alt+R** working in every
  workspace. The timeline owns *placing* a take on a lane, which is a timeline edit.
- **Status bar**: contextual help (hover any control) · a **REC** light while a take is recording,
  naming which document it will land in and stopping everything when clicked · render FPS ·
  LIVE/target · engine stats.
- **Help** (**F1** / **?** / Help menu): one searchable modal over the topic guides and every
  function's help entry, with a remembered **EN/FR** toggle for the guides. Contextual hover help
  lives in the status bar.

### Arrange it yourself (dockable workspace)

Any workbench can be rearranged and it stays that way:

- **drag a panel by its tab** onto another group to join it, or onto an **edge** to split;
- **right-click a tab** for the same moves from the keyboard, plus Close;
- **+** on a tab strip adds any panel, including ones this workbench does not normally show;
- **drag the dividers** to resize; **the chevron** collapses a group;
- **Reset this workbench** (in the **+** menu) puts it back to how it ships.

Arrangements are **per workbench**, saved with your preferences, and survive a restart. If you would
rather have the fixed layout back, turn off **Preferences › Appearance › Dockable workspace**.

> Rearranging the editor never touches the show. The rendering engine does not live in the UI —
> output keeps running while you drag panels around, and it keeps running even if a panel crashes.

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
spreadsheet (File → Routing…) to:
- manage **Controllers** (physical output devices: name, protocol, IP, broadcast, start universe,
  sACN priority) — fixtures assigned to a controller are packed into its universes and output to its IP;
- patch every fixture in a grid (surface link, controller, universe/start, channels, LED count);
- **lock** a row to set its universe/address manually (auto otherwise), or hit **Auto-patch**.
A fixture with no controller falls back to the global Preferences target. Save the selected fixture
as a reusable **template** from the browser **Library**.

## Moving lights — profiles, a rig in 3D, and an encoded show
ArtLux drives **light fixtures** (moving heads, washes, beams) as well as LED tape, and treats them as
a different device rather than a strip with odd options. Full detail:
[FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md) and [LIGHTING-SHOW.md](LIGHTING-SHOW.md).

- **506 shipped DMX profiles** (built offline from the Open Fixture Library) plus **GDTF import** for
  the manufacturer's own mesh. Give a fixture a profile and it *becomes* a light: pixel controls
  disappear, its mode's real footprint is patched, and it is placed and aimed in the **3D scene**.
- **Pan/tilt are stored in physical DEGREES**, so a movement recorded on a 540° head replays as the
  same *angle* on a 630° one — what consoles call head morphing.
- **A light show is a movement instanced onto an ordered group by a timeline clip that spreads it in
  time** (phase / wing / block / random, mirror, scale, offset — the console effects engine as an NLE
  clip). The movement comes from one of three sources:
  - **record** it — busk the rig with your hands and press stop; the capture is fitted into keyframes
    you can edit, and a role that never moved is dropped so clips layer cleanly;
  - **generate** it — a form, a role, a centre, an amplitude, a period;
  - **author** it — **Store Key** (3D action bar) stores what the group looks like right now as a
    pose key. Press it again later and you have a look that eases between two moments. Clicking a key
    on the clip re-opens it for editing, slot by slot, in degrees.
- **Pose cues** fire a stored look at a group with **no timeline involved** — from the cue grid, the
  tablet, an OSC GO, or a state's entry action.
- **ENTTEC DMX USB Pro** output alongside Art-Net/sACN, on its own writer thread so a stalled widget
  cannot stop the network pacer.

## Surface content sources
Select a surface, then in the inspector **Content** section:
- **Video / Image / Camera** — load a file or use the webcam (`getUserMedia`); each video/image
  surface has its own player.
- **DMX In** — capture incoming Art-Net/sACN as the surface's content (single live input).
- **Spout** (Windows) — receive a live GPU stream from Resolume/MadMapper/TouchDesigner; pick a
  sender (or "Active sender") + refresh. Received natively, downscaled, composited (single live).
- **NDI** (network video) — receive an NDI stream from another machine/app; pick a source + refresh.
  Requires the free NDI Runtime/Tools. See [NDI.md](NDI.md). (Single live input.)
- **Effect** — a generative shader (Solid / Rainbow / Palette Flow / Wave / Fire) fills the surface;
  linked fixtures sample it like any media (see **Effects & palettes** below).
- **Tracking** — a people-tracking source (**LiDAR blobs**, **MediaPipe** webcam pose, or **Augmenta**)
  drawn as markers/skeletons onto the surface (see the tracking sections above).

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

## OSC in: external control & LiDAR tracking
Open **Preferences → OSC / Tracking**: enable the UDP receiver (default port **10000**), pick the
**bind NIC** (this machine's IP), and set the **control prefix** (default `/artlux`). Two streams
share the socket:
- **Control** — `/artlux/transport/{play,pause,stop,seek,loop}` and `/artlux/state/trigger` drive the
  timeline transport + state-machine.
- **LiDAR tracking** — `/<surface>/blobs/blob<n>/{id,tx,ty,u,v}` (surfaces `SOL`/`MUR`/`SOL_MUR`)
  feed a render-free tracking store and the **3D Scene blob visualization** (toggle **Tracking zones
  (LiDAR)** in the Scene window). Full protocol + venue wiring + architecture in [OSC.md](OSC.md).

### Tracking takes — record & replay without the tracker
Record the live LiDAR blob feed into reusable **takes** and replay them from a dedicated **tracking
lane** on the timeline, so you can author and rehearse an interactive show with no tracker connected.
Record from the **Tracking Takes** dock (in Venue & Rig and on the Show deck) or with **Ctrl+Alt+R**
from anywhere — capture is independent of the transport. Drag a take onto the tracking lane, then
Play/scrub to replay the blobs into the 3D Scene and any *Tracking* projector outputs. While a take plays the live feed is suppressed; past the clip it resumes. Takes are `.lblob`
sidecars in `assets/tracking/`. Details in [TRACKING_TAKES.md](TRACKING_TAKES.md).

## Other tracking sources (people → surfaces, no LiDAR)
Besides the LiDAR blob feed, two **camera-based** tracking sources feed the same pipeline — each tracked
person becomes a normalized position that maps onto a surface exactly like a LiDAR blob (a **content
type** on a surface, a projector self-render, and a 3D-scene overlay). Both are first-party plugins.

- **Camera pose tracking (MediaPipe BlazePose)** — a **webcam** + Google MediaPipe pose model, running
  **in the renderer** (WebAssembly, GPU delegate) with no extra sensor. Run `npm run assets:mediapipe`
  once, then select a surface → content **MediaPipe**, pick the camera + model in **Preferences → Pose
  Tracking (MediaPipe)**, and open **View → Pose Monitor…** for the live feed / fps / tracked count.
  A **4-point floor calibration** (**View → Pose Floor Calibration…**) maps the down-pointed camera to
  real floor metres for a world-space preview in the 3D scene. See [MEDIAPIPE.md](MEDIAPIPE.md).
- **Augmenta optical tracking** — an [Augmenta](https://augmenta.tech) box streaming tracked objects over
  **OSC v2**. It shares the app's single OSC listener (no extra port): enable OSC receive in **Preferences
  → OSC / Tracking**, point the box at that port, confirm arrivals in **View → Augmenta Monitor…**, then
  select a surface → content **Augmenta**. Pre-calibrated (the box reports its field in metres), so no
  floor wizard. See [AUGMENTA.md](AUGMENTA.md).

## The show — scenes, state machine & interactive triggers
Turn a pile of looks into a **show that runs itself** — a timed sequence, an unattended attract loop, or a
live-triggered installation.

### The state machine (the "Show" graph)
The **state machine** is an optional finite-state graph over your **Scenes**. Each **state** binds a
Scene (recalled on entry, whole look + its timeline) and can run **entry actions** (play/pause/stop/seek/
loop/jump-marker/recall/fire-cue); each **transition** is an edge with a **trigger** that moves the show
on. Author it from the Timeline dock's **state lane → Edit logic** (a node canvas: drag a node's nub onto
another to wire a transition, double-click a node to force-enter it live, **Build from scenes** to seed one
node per Scene). The machine runs once per frame **even while the transport is stopped**, so a delay-driven
show loops with no Play pressed. Triggers:

- **manual** (state-lane button, Ctrl/Cmd+click an edge, or OSC/tablet),
- **afterDelay** (wall-clock — runs stopped), **atTime / onMarker / onClipEnd / onTimelineEnd** (follow
  the playhead — need Play),
- **LiDAR zone** and other **plugin** conditions (see below).

**Hold at end** parks a state on its last frame with the audio bed still playing (the picture waits, the
room stays alive); **Only after the state has finished** (`requireEnd`) gates an automatic trigger until
that hold — so a visitor can't cut a film three seconds in, while a manual/OSC/tablet trigger always fires.
A **⚡ global rule** (`fromAny`) is evaluated from every state at once (e.g. *someone enters the entrance →
start the welcome*), so you don't redraw one edge per state. **OSC** fires a transition by id
(`/artlux/state/trigger`). Full reference + worked example projects in [STATE-MACHINE.md](STATE-MACHINE.md)
and [examples/state-machine/](../examples/state-machine/).

### Per-scene timelines
Every **Scene owns its own Timeline** (its own tracks/clips/markers/playhead). Recalling a scene
**warm-swaps** the playback engine to that scene's timeline (pre-rolled to its first frame, so no black
first frame) and rebinds the editor to it — the thing you edit is the thing that plays, in the main window,
projectors, and broadcast alike. The scene/state **pill** at the top-left of the Timeline panel shows and
switches which timeline you're editing (a scene's own, or the shared **Global** timeline). A **preloader**
keeps only the active state fully live and a small warm window of likely-next states in standby, so steady
load equals a single-timeline app no matter how many states exist. See
[SCENE-TIMELINES.md](SCENE-TIMELINES.md).

### Interactive triggers — LiDAR trigger zones
A **trigger zone** is a named rectangle on a tracking surface that the show machine transitions on. Draw
zones once in the **Tracking** workbench → **Trigger Zones** dock tab (they're project-scope room geometry,
shared by every scene; also shown in the 3D scene with live headcount). A transition's **LiDAR zone**
trigger watches **one zone** — `someone enters` / `everyone leaves` / `occupied for…` / `empty for…` /
`at least N people` — or a **Combination** of zones (`ALL`/`ANY`, each optionally `NOT`, e.g. *someone in
the entrance and nobody on the stage*). Occupancy uses an **arm-and-hold** rule so a still-present visitor
doesn't re-strobe the state. Enter/exit **dwell** is tuned **venue-wide** (a room property, in the tracking
parameters), with an optional per-zone override; a per-scene **eye toggle** (`activeZoneIds`) can mute a
zone for a given look. See [TRACKING_SYNC.md](TRACKING_SYNC.md#trigger-zones--making-the-show-react-to-the-room).

### Cold start — the show waits for its content
Opening a project (editor, `--project=`, broadcast, watchdog relaunch, playlist switch) **holds** the state
machine until the opening look has actually **decoded** — first frames + a codec's decode-ahead buffer +
loaded surface media + the audio engine. Until then every projector output draws a dim **PRELOADING SHOW**
sign (the status bar shows a *Preloading n/m* chip), then the show starts from the top. It **fails open**
after *Preferences ▸ Engine ▸ Preload wait* (default 15 s), and pressing Play (or an OSC/tablet transport
command) arms it immediately. Details in [STATE-MACHINE.md](STATE-MACHINE.md#the-cold-start--the-show-waits-for-its-content-servicesbootgatets).

## Spatial audio
ArtLux plays **object-based, spatialised audio** in step with the show — a native **JUCE** engine with
**libspatialaudio** ambisonics, decoded to headphones (**HRTF binaural**) or a real **speaker array**
(**Preferences ▸ Audio** picks the device, channels, and binaural/speakers). Audio rides the show, is
recalled by Scenes, and is automated by the same curve engine as everything else, mixed in the **Audio**
panel (bed tracks, the bound timeline's tracks, per-clip insert chains, master). The one thing to hold in
your head is **three containers, two clocks**: the **bed** (`ProjectData.audio`, one per project) rides the
**show clock** and plays straight through a scene recall; a **timeline's own audio** and a **video clip's
soundtrack** ride the **playhead** and **restart** with their scene. Requires `npm run build:audio` (without
it the audio UI renders and plays silence). Full guide + tutorial in [AUDIO.md](AUDIO.md) and
[examples/audio/](../examples/audio/README.md).

## Projects, rigs & preferences
- **Save / Save As / Open** (File menu or top bar) — native dialogs writing `.artlux` project files
  (fixtures, brightness, groups, scenes — the *show*. Machine preferences like the audio device and the
  Art‑Net target are **not** in the project; they live per‑machine, so opening a show never re‑patches the
  computer that opens it).
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
    tracking/   # recorded LiDAR takes (.lblob)
```

- **New Project** (Ctrl/Cmd+N) — now always prompts for a **location**, scaffolds the `assets/` tree,
  and saves `project.artlux` into it (so imported/recorded media always has a home).
- **Open Project Folder…** (Ctrl/Cmd+Shift+O) — pick a project folder to open its `project.artlux`.
- **Consolidate** (Asset Manager) / **Collect Assets…** (File menu) — copies every referenced video,
  3D model, image and take into the project's `assets/` tree and rewrites paths to the local copies
  (de-duped by name + size). A summary reports how many were copied, skipped, or missing on disk.

### Media library
A managed library of all project media — **video, image, 3D model, take** — in the left panel's
**Media** tab. Import (files are copied into the project folder), preview thumbnails, search/filter,
*used/unused/missing* badges, and **drag a tile onto the Stage or Timeline** to place it. A full-screen
**Asset Manager** adds per-asset usage, relink, reveal-in-folder, remove and consolidate. Full
reference in [ASSETS.md](ASSETS.md).

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
Open **Outputs** (top bar), enable a surface, and pick a display. Each output can also be published as
an **NDI source** (gear → **Send as NDI**). Full guide + architecture in [OUTPUTS.md](OUTPUTS.md);
NDI in [NDI.md](NDI.md).

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

## Show-control tablet remote + scheduler + playlist
Turn any phone/tablet browser into an operator surface, and drive an unattended venue. Enable it in
**Preferences ▸ Show Control**, note the LAN URL + 4-digit **PIN**, and open the URL on the tablet (or scan
the **QR** in **View ▸ Show Control…**) — the served PWA needs no install and auto-reconnects across a
relaunch. Tabs: **Control** (recall scenes, fire cues, transport), **States** (drive the state machine —
fire manual transitions, jump to any state; the only UI in broadcast mode), **Schedule** (in-project
wall-clock triggers, e.g. 09:00 recall *Opening* / 18:00 stop, saved with the project), **Projects** (build
a **time-of-day playlist** that switches whole projects unattended, indefinitely), and **Metrics** (the
live engine/renderer/system series with sparklines and green/amber/red health). Everything the tablet does
is mirrored in the app's **Show** workspace context (Show Deck + Schedule / Playlist / Metrics / Show
Control dock tabs). Commands reuse the same buses as OSC, so App stays the single transport writer. PIN
pairing → per-device token; an operator **Lock** can freeze or kick remotes. See
[SHOW-CONTROL.md](SHOW-CONTROL.md).

## Unattended operation: watchdog & monitoring
For an install that runs for days with nobody watching:

- **Self-healing watchdog** — **off by default**, arms only in `--broadcast`. It detects the ways a show
  goes dark (renderer/GPU crash, unresponsive window, frozen render loop, sustained Art-Net loss) and
  recovers with a **full relaunch** into the same broadcast project; a second **Windows Scheduled Task**
  tier restarts the app if the whole process dies. A crash-loop **circuit breaker** stops it thrashing on a
  persistent fault. Enable via **Preferences ▸ unattended**. See [WATCHDOG.md](WATCHDOG.md).
- **Prometheus metrics** — the main process exposes `GET http://127.0.0.1:9464/metrics` (pull model, near
  zero cost; loopback until you set `ARTLUX_METRICS_HOST=0.0.0.0`): output fps/pps/universes/up plus CPU,
  RSS, heap and event-loop lag. A ready-made **Grafana** dashboard ships in `monitoring/`. See
  [MONITORING.md](MONITORING.md). (The same series are viewable in the show-control **Metrics** tab without
  Grafana.)

## Keyboard
- **Ctrl/Cmd+Z** undo · **Ctrl/Cmd+Shift+Z** or **Ctrl/Cmd+Y** redo.
- **Ctrl/Cmd+Shift+Q** quit — works in both the editor and broadcast mode, even from a focused
  fullscreen projector window (closes every projector cleanly).
- **Esc** closes the Preferences dialog.
