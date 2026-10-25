# 2026-10-24 (evening) — session record: v0.33.12 → v0.33.13, the interactive-show template, the 3D freeze

> **Status:** Record (closed session). Written for two readers: the owner, and the next Claude session
> on this machine. It follows the [morning record](2026-10-24-session-record.md) of the same day.
> Measurements are from the RTX test box (RTX 5090, Windows 11, Electron 42.4.1).

## How it went

1. **"Test my last project in broadcast mode, no screen appears."** The project was fine. A test
   playlist left in the owner's profile by the morning's scripts hijacked every broadcast launch into a
   deleted temp project, and the app then ran an empty document → **v0.33.12**.
2. **"Update the help and the tutorials… a project with videos and 4 states with a branch… text on each
   timeline… LiDAR transitions… 3 zones in 3D… a Launcher template… Full HD MP4 only."** The enhanced
   brief is [interactive-show-template.md](interactive-show-template.md). Building it found **five app
   bugs**, the worst being a 3D view that froze for good when a person was tracked.
3. **"Fix in the code base, we need the 3D scene for simulation and building shows."** Fixed (`d3eb677`),
   then the template and its course (`ea06249`) → **v0.33.13**, installed and verified on this machine.
4. **A presentation for the BIP students** (the workflow, no exercise; they are onboarded later).

## What shipped

| Commit | What |
|---|---|
| `f27a14d` → `422652c` **v0.33.12** | **Broadcast never runs a missing project.** The playlist scheduler skips a due entry whose file does not exist (warned once, re-checked each tick), and the broadcast/headless loader falls back to the last-opened project when `--project=` cannot be read, logging which file failed. |
| `d3eb677` | **The 3D view no longer freezes when somebody is tracked**, plus four fixes found on the way (below). |
| `ea06249` | **`examples/interactive-show/`**: the template, its generators, the scripted visitor, a five-chapter course, and the user guide's tracking / state-machine screenshots re-shot from it. |
| `dac37a2` **v0.33.13** | Release of both. CI built every installer; v0.33.13 is installed here and the template walk passes on the installed build. |

Seven new `verify:invariants` checks over the session, each mutation-tested (broken on purpose, caught).

## The 3D freeze: what it was, and the wrong turns on the way

**Symptom:** with the LiDAR overlay on, the 3D view stopped drawing for good, usually the moment the
first person was tracked. Markers stopped, zones stopped lighting, a 3D screen stayed on the previous
state. The 2D map and the outputs were fine. Intermittent: about 2 launches in 3.

**Cause:** the overlay's translucent floor and wall planes were sized with `<planeGeometry args={[W, D]}>`.
The first tracking packet carries the floor size as float32 (5.825 → 5.82499…), so r3f replaced the
geometry of a mesh that had already drawn. On WebGPU three kept the mesh's old vertex-buffer bindings:
`Vertex buffer slot 1 required by [RenderPipeline "renderPipeline_MeshBasicMaterial_48"] was not set`,
the whole frame's command buffer was rejected, every frame. **Fix:** 1×1 geometry sized by `scale`, in
TrackingViz, AugmentaViz and PoseViz; an invariant forbids non-literal `planeGeometry` args anywhere.

**How it was found, so the next session skips the detours:**

- The first theory was a texture problem: a multi-track surface's composite canvas grows from 640 px to
  1920 px after the 3D texture is allocated, and WebGPU copies into storage of the old size (a cropped
  corner). That bug is **real and fixed** (the texture keeps its born size; a resized source is drawn into
  a staging canvas), but it was **not** the freeze. Two ways of reallocating the texture (`dispose()`
  in place, then a fresh texture object) both made things worse.
- "It's my framing camera" and "it's the floor screen" were also wrong: elimination runs with each
  removed still froze.
- What settled it: **the session log.** The renderer logs WebGPU uncaptured errors; `grep 'Vertex buffer
  slot'` in `<profile>/logs/*.log` showed the failing pipeline. Three's pipeline label is
  `renderPipeline_<material type>_<material.id>`, so a temporary hook that traversed the scene for
  `material.id === 48` named the mesh in one run. Then: 0 errors in 8 launches after the fix.
- Several early "failures" were contaminated: a visitor script from a previous run was still walking, and
  the owner was using the same test window. Kill stray `visitor.cjs` processes before each run.

**The four other fixes in `d3eb677`:** `emptyFor` never fired on a zone nobody had entered
(`emptySinceMs = 0`), so "all zones empty for 6 s" held the show; the cropped 3D screen above; zone
outlines rebuilt line + material on every render (~40 WebGPU pipeline compiles in 10 s → 0 in a 35 s walk);
the 3D view now frames the whole venue when the LiDAR overlay appears.

## The interactive-show template

| Piece | Notes |
|---|---|
| `interactive-show.artlux` | Generated by `make-project.cjs` (re-run it after changing zones or rules; it rewrites the whole project). 4 states, separate track ids per scene (clean cuts), a global `fromAny` return rule with `from: ''`. |
| `assets/video/*.mp4` | Four 20 s 1920×1080 H.264 seamless loops, generated by `make-media.cjs` with ffmpeg (`h264_nvenc` here). `geq` needs `clip(…,0,255)`: it wraps, and wrapped bands came out hot pink. |
| Floor pads | A shader generated from the zones; each state lights the pads it wants the visitor to use. **Moving a zone in the app does not move its pad** (documented in chapter 4). |
| `visitor.cjs` | One scripted person, 64 s, through every transition. Ships in the installer; the Launcher's workspace copy leaves `.cjs` out, so the course gives the install path. |
| Course | `tuto/`, five chapters, 8 screenshots (scratch profile, checked by eye for addresses and PINs) and 2 SVGs. |

On the tracker floor **v = 1 is the wall** and v = 0 the side people enter from (`TrackingViz.blobPosition`).
The first zone layout had it backwards.

## The student presentation

- **Deck:** [ArtLux — Building a Show the Room Drives](https://claude.ai/artifact/YQgSfy6iUT1DY4ptitjKni),
  15 slides with speaker notes, private until the owner shares it.
- **Local copy:** `Desktop\ArtLux - Building a Show the Room Drives.html`, self-contained, built from the
  deck's slide files. The build script lived in the session scratchpad and is gone with it; rebuild from
  the deck if the slides change.
- **SVGs in a deck:** the slide viewer ignores an SVG's `<style>` block, so text came out black. The two
  diagrams now carry their fills and sizes as attributes, in the repo too.

## Needs the owner

| Item | What to do |
|---|---|
| **The deck is private** | Share it from its Share menu before students or co-teachers open it. |
| **Test leftovers in your real profile** | The playlist is gone (you deleted it). Still there: `%APPDATA%\artlux\showctl-devices.json` (tablets paired by the tests) and 9 temp entries in Recent files. |

## Still open

| Item | Notes |
|---|---|
| **Guide screenshot count** | 22, over the ~18 ceiling in CLAUDE.md (it was 21; the Trigger Zones shot adds one). |
| **No `.lblob` take for readers without Node** | The course's no-Node path is firing states from the graph, which skips the rules. |
| **The dev-launch test scripts still write to the owner's profile** | Carried over from the morning record. |
| **Untested on the installed build** | Opening the template from the Launcher app itself; broadcast mode with the template's outputs switched on. |
| From the [morning record](2026-10-24-session-record.md) | The boot gate on a known-failed file, the stale test scripts, no soak on the GPU-recovery builds, unsigned installers. |

## Testing on this machine: new recipes (on top of the morning's)

- **Harness** (scratch, `%TEMP%\claude\battle\`, may be wiped):
  - `showtest.mjs`: launches, records every state change, runs the visitor. Use `ARTLUX_EXE` for the installed build, `PROJ` for another project.
  - `still.cjs u v s`: one person standing still.
  - `open.mjs`, `input.mjs` (click / dbl / key over CDP), `kill.ps1`.
- **Kill by process name, never by command-line text alone.** A filter on `*battle*profile*` matched the
  Bash shell running the script and killed it (exit 255, no output). `kill.ps1` checks `electron.exe` too.
- **Synthetic `Ctrl+T` over CDP does not reach the shortcut handler.** Click the button through the DOM
  instead (`[title^="Hide Timeline"]`).
- **The renderer's plain `console.log` is not in the machine log**; warnings and errors are.
- **Headless Edge renders an SVG or a local HTML for a quick look:** `msedge --headless=new
  --screenshot=… file:///…`. It fails silently on a path with spaces in a `#fragment` URL; copy the file.
- **Write in the scratchpad through its long path** (`C:\Users\Ateliernum\…`). The short `ATELIE~1` form
  tripped a read-permission rule on publish.
