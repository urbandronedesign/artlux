```
      _      ____    _____   _      _   _  __  __
     / \    |  _ \  |_   _| | |    | | | | \ \/ /
    / _ \   | |_) |   | |   | |    | | | |  \  /
   / ___ \  |  _ <    | |   | |___ | |_| |  /  \
  /_/   \_\ |_| \_\   |_|   |_____| \___/  /_/\_\

  A media server for interactive installations
```

# ArtLux

ArtLux is a **media server for interactive installations**. From one project file it plays video,
generative content, light and sound across **projectors, LED rigs, DMX lighting and speakers**, and it
reacts to the people in the room: tracked bodies, sensors and show control drive what happens next.
It runs on Windows, macOS and Linux, and it is built to run a show unattended.

Designed and built by Zaki Jawhari and Bérenger Recoules. Free for education and non-commercial use —
see [Licence](#licence).

## Principal features

### Content

- **Video and images** — MP4 decoded on the GPU, HAP and still images, from a managed
  [media library](docs/ASSETS.md) inside a portable project folder.
- **Live sources** — cameras, **NDI** and **Spout** video ([NDI](docs/NDI.md), [Spout](docs/SPOUT.md)), and
  incoming DMX over Art-Net / sACN.
- **Generative content** — built-in [effects and palettes](docs/EFFECTS.md), [GPU shaders](docs/SHADERS.md)
  with a node editor, and [text](docs/TEXT.md) with its own fonts and motion.
- **Baking** — [pre-render a surface to video](docs/BAKE.md) (MP4 + AAC) when the live version is too heavy.

### Mapping and outputs

- **Surfaces** on a 2D stage, and a **3D venue** loaded from glTF or straight from a **Blender** file that
  updates when you save it ([surfaces](docs/SURFACES.md), [3D scene](docs/user-guide/09-3d-scene.md)).
- **Projectors** — corner-pin and Bézier warp, soft edges, one picture spanning several projectors
  ([outputs](docs/OUTPUTS.md)).
- **Projection-mapping calibration** — align projectors to the venue model by hand, with structured light, or
  with a markerless camera auto-align; blend overlapping projectors on the GPU; import and export
  **MPCDI** calibration files; warp and blend at the scanout on NVIDIA Quadro / RTX
  ([calibration](docs/CALIBRATION.md), [auto-align](docs/AUTO-ALIGN.md), [NVIDIA warp](docs/NVWARP.md)).
- **LED pixel mapping** — fixtures sampled per LED on the GPU, sent over **Art-Net / sACN** by a native
  output engine, with device discovery and ArtSync ([LED map](docs/LEDMAP.md)).
- **DMX lighting** — moving heads and other fixtures from a [fixture library](docs/FIXTURE-LIBRARY.md), over
  the network or USB DMX, with recorded [lighting takes](docs/LIGHTING-SHOW.md).
- **NDI out** — any output published as an NDI source.
- **Spatial audio** — every sound at a point in the room, decoded to headphones (binaural) or a speaker array,
  on the same clock as the picture; insert effects and automation ([audio](docs/AUDIO.md)).

### Interaction

- **Tracking** — LiDAR over OSC, [Augmenta](docs/AUGMENTA.md) optical tracking and
  [camera pose tracking](docs/MEDIAPIPE.md); trigger zones on the floor; record a take and replay the show
  with no tracker present ([tracking](docs/TRACKING_SYNC.md), [takes](docs/TRACKING_TAKES.md)).
- **State machine** — the show as a graph of scenes, moved on by a GO, a timer, OSC or people entering a
  zone ([state machine](docs/STATE-MACHINE.md)).
- **OSC in and out** — control ArtLux from anything that speaks OSC, and send timeline curves to devices
  such as Arduino boards ([OSC](docs/OSC.md)).

### Show

- **Timeline** — a non-linear editor for the show and for each scene ([timeline](docs/TIMELINE.md),
  [scene timelines](docs/SCENE-TIMELINES.md)), with [scenes and cues](docs/SCENES.md).
- **Show control** — a tablet remote in the browser, a wall-clock scheduler and an unattended multi-project
  playlist ([show control](docs/SHOW-CONTROL.md)).
- **Unattended running** — broadcast and headless modes, a [self-healing watchdog](docs/WATCHDOG.md) that
  recovers from crashes and hangs, [machine logging](docs/LOGGING.md) and [monitoring](docs/MONITORING.md).
- **Reuse** — copy a show, its scenes and everything they use [between projects](docs/PROJECT-IMPORT.md).

### Around it

- **The Launcher** — a small separate app that installs ArtLux, checks the machine, finds your projects and
  opens the example gallery ([Launcher](docs/LAUNCHER.md)).
- **Plugins** — features are built as plugins on an internal SDK ([plugins](docs/PLUGINS.md)).

The full tour is in **[docs/FEATURES.md](docs/FEATURES.md)**.

## Get ArtLux

The easiest way onto a Windows machine is the **Launcher** —
[download it](https://github.com/urbandronedesign/artlux/releases/download/launcher-latest/ArtLuxLauncher-Setup-x64.exe).
It installs ArtLux, verifies the download, sets up what the machine needs and checks it can run a show.

Downloads for Windows, macOS and Linux, installing by hand, and what to expect on first launch:
**[docs/INSTALL.md](docs/INSTALL.md)**.

## Documentation

- **[User guide](docs/user-guide/README.md)** — every screen of the app, task by task.
- **[Examples](examples/README.md)** — projects you can open, with written tutorials.
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** — a symptom, and the page that fixes it.
- **[Changelog](CHANGELOG.md)** — what changed in each release.
- For contributors: [architecture](docs/ARCHITECTURE.md), [building and releasing](docs/DEVELOPMENT.md),
  [plugin SDK](docs/SDK.md).

## Build from source

Node.js 20+, the Rust toolchain and a C++17 toolchain with CMake. Setup, the native builds, packaging,
testing and releasing are in **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## Licence

**ArtLux is licensed for education and non-commercial use only — no commercial work is permitted.** It is not
an open-source licence. The licence is **[`LICENSE`](LICENSE)**, the third-party inventory is
**[`NOTICE`](NOTICE)**, and the record of what is linked into ArtLux and what was decided about it is
**[LICENSING.md](LICENSING.md)**.

NDI® is a registered trademark of Vizrt NDI AB.
