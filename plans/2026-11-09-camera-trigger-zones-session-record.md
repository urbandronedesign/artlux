# 2026-11-09 — session record: camera trigger zones (MediaPipe → zones → the show)

> **Status:** Record (closed 2026-11-09). Written for two readers: the owner, and the next Claude session on
> this machine. Everything here is on `main` and pushed. **Not released**: no tag yet. The latest release
> is still v0.35.1.

## What was built, in one paragraph

A webcam can now drive the show the way the LiDAR does. You mark an **interaction area** on the camera
picture (**View ▸ Pose Calibration…**) and draw **trigger zones** on it (**Trigger Zones** editor, surface
**Camera area (MediaPipe)**). Each zone chooses which body parts count (**Detect**: hands, feet, head,
body). Those zones fire states and transitions through the same **Trigger zone** rule as LiDAR zones. The
zones also show in the **3D view** on a camera panel. Usage docs: [MEDIAPIPE.md](../docs/MEDIAPIPE.md) and
[user guide ch. 13](../docs/user-guide/13-tracking.md). Example: [examples/mediapipe-zones](../examples/mediapipe-zones/README.md).

## Commits (all on `main`, pushed)

| Commit | What |
|---|---|
| `e4add55`, `28606e7` | OSC: trigger states from named OSC devices, plus the `osc-states` example (earlier in the day). |
| `0f1434d` | **The feature**: SDK `trackingSurfaces`, the zone engine reads any surface and counts people, the interaction area, the Pose Calibration wizard (area / floor / test), Detect parts, docs. |
| `08554a9` | `examples/mediapipe-zones`: Idle / Left / Right with a pretend visitor. |
| `2ab5c9e` | 11 screenshots re-shot ("LiDAR zone" became "Trigger zone"). |
| `04bfe60` | **Fix: the 3D view froze** after a calibration. See below. |
| `e32b342` | **Camera zones in the 3D view.** |
| *(this commit)* | Wizard explains interaction area vs floor; this record. |

## Interaction area vs floor — the question everybody asks

Two tabs in the wizard, both "four corners on the camera picture", with **unrelated jobs**:

| | Interaction area | Floor (3D) |
|---|---|---|
| Job | **Fires the show.** Zones live inside it. | **3D preview only.** Puts people's feet on a real-size floor. |
| Plane | Any: wall, screen, floor, air. | A floor. |
| Units | None (proportions, Shape W÷H). | Metres, measured. |
| Stored | `Scene3D.mediapipeArea` | `Scene3D.mediapipeFloor` |
| Needed? | Yes, for a camera show. | Optional; zones never read it. |

Both are **room scope**: they're never captured in a scene snapshot (`SCENE3D_NOT_A_LOOK` in App.tsx), so a GO
never changes them. The wizard shows this comparison at the top of both tabs (`AreaVsFloor`).

## How it works (for the next session)

- **The only link between the two plugins** is the SDK registry `ctx.trackingSurfaces`
  (`TrackingSurfaceContribution`). MediaPipe registers `POSE`, which provides `points()` (tagged parts in area
  space), `acquire()` (which keeps the camera running while a zone listens) and `toWorld()` (where the area
  sits in 3D, or null while the camera overlay is off). The zone engine stays in `plugins/lidar-tracking`.
- **Counting is per person**: both hands of one visitor in a pad count as 1. LiDAR behaviour is unchanged
  (each blob is its own person).
- **3D:** `plugins/mediapipe/src/poseField.ts` is the one mapping for the camera panel. `PoseViz` draws the
  panel, the area outline and a dot per counted part; the LiDAR plugin's `ProviderZonesViz` draws the zones on
  it. `TrackingViz` draws LiDAR zones only. Before, it would have put camera zones on the LiDAR floor.
- **Test hook:** `window.__artluxPose.inject(people)` / `.release()` / `.points()` / `.status()` in the
  main window. `inject` takes over the pose store as a replay source, so the real camera cannot overwrite it.

## The 3D freeze (fixed in `04bfe60`) — read this before touching 3D in a plugin

**Symptom:** after a calibration, the 3D view stopped updating. **The log said so the whole time:**
`THREE.NodeBuilder: Material "LineMaterial" is not compatible` about 60 times a second, after one
`drawIndexed: Value is infinite`. **Cause:** `PoseViz` had used drei's `<Line>` since the plugin was first
written; that line type works only in WebGL, and the 3D view renders with WebGPU. **Why no check caught it:**
the guard *"the 3D scene draws on both backends"* only scanned `src/renderer/components/Simulator3D`. It now
also scans every plugin file that imports `@react-three/fiber`. **Rule:** in 3D, use the host's `PolyLine`
(`@/components/Simulator3D/PolyLine`), never drei `Line` / `Grid` / `Text`.

## How it was tested

- `npm run verify` is green at every commit.
- **Example run:** a copy of `mediapipe-zones.artlux` plus its own `simulate-visitor.js`, with the state
  recorded through CDP: `Idle 0.0s → Left 2.3s → Right 6.3s → Idle 13.6s`, **PASS** (run twice).
- **Owner's camera:** the owner marked an interaction area on an **IPEVO V4K, 1280×720** and also saved a
  floor (0.5 × 0.2 m) in a copy of the example. A pretend hand on their area fired **Left**. The 3D view
  ran at 60 FPS with zones visible and no errors in the log.
- **Recipe:** scratch profile `%TEMP%/claude/battle/profile`; launch
  `node_modules/electron/dist/electron.exe . --user-data-dir=<profile> --project=<copy>` with
  `ARTLUX_CDP_PORT=9333` (and `MSYS_NO_PATHCONV=1` in Git Bash); wait for `__artluxWarmPools().active`;
  read the machine log in `<profile>/logs/` **first** when something looks frozen. The app runs the **built**
  `out/`, so `npm run build` (app closed) before relaunching.

## Open

| | |
|---|---|
| **A real visitor, end to end** | Not yet watched: a real hand on a real pad moving the show. The pretend hand works on the owner's own area. |
| **3D with LiDAR overlay on + a floor calibration** | Not checked visually since `e32b342` (logic only). |
| **Release** | Not tagged. Everything above would ship in the next version. |
| **Incident** | While checking the 3D view, a test drag landed on the owner's open calibration window (it was open without my knowing). It most likely changed nothing; the owner was told to check. **Lesson:** before driving the UI over CDP, check for an open `[role=dialog]`. |
