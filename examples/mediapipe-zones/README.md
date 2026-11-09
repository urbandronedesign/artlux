# Camera zones — moving the show with a hand

**A webcam, two pads, three states.** Raise a hand in front of the **Left pad** and the show goes to
**Left**; move it to the **Right pad** and it goes to **Right**; walk away and it returns to **Idle**.
No LiDAR, no extra sensor: the camera runs MediaPipe's pose model inside ArtLux.

| File | What it is |
|---|---|
| `mediapipe-zones.artlux` | Three states, **Idle**, **Left** and **Right**, each with its own look (built-in effects, no media). Two **trigger zones** on the camera's interaction area, each counting **hands** only. |
| `simulate-visitor.js` | A pretend visitor to paste into the developer console, for when no camera (or nobody) is there. |

Nothing leaves this computer: the project has no output aimed anywhere but `127.0.0.1`.

## What is bound

| Zone (on **Camera area**) | Detects | Rule | What happens |
|---|---|---|---|
| **Left pad** — the left third | hands | someone enters | Idle → Left, or Right → Left (1 s fade) |
| **Right pad** — the right third | hands | someone enters | Idle → Right, or Left → Right (1 s fade) |
| both pads | hands | **ALL**: both empty for 3 s (a **global rule**) | back to Idle from anywhere (2 s fade) |

A foot, a head or a body in a pad does nothing: each zone's **Detect** is set to **Hands**.

## Run it

**1. Open the project.** **File ▸ Open…** → `mediapipe-zones.artlux`. The state machine is enabled and
starts in **Idle**. The camera switches on by itself, because live zones keep it running.

**2. Mark the interaction area on your camera.** The project ships a starting area (the middle of the
picture); your camera sees a different room, so re-mark it. Open **View ▸ Pose Calibration…**:
- stay on **Interaction area**; you see the camera picture and yourself drawn over it, hands lettered
  **L** and **R**;
- press **Walk the corners**, then stand at each corner of the wall area you want, in the order the
  picture asks (TL, TR, BR, BL), and hold a hand still there for 2 seconds — or simply drag the four
  corners;
- the two pads appear on the picture: check they sit where you want people to reach;
- tick **Mirror (selfie view)** if people face the camera and the picture reads backwards to them;
- **Save area**.

Pick the camera first in **Preferences ▸ Pose Tracking (MediaPipe)** if your computer has several.

**3. Try it.** Open the **Test** tab of the same window: walk up, raise a hand, and watch the pad light.
Close the window and do it for real: the show follows. To redraw the pads, open **View ▸ Trigger
Zones** and pick **Camera area (MediaPipe)** in its **Surface** list.

### No camera? Simulate a visitor

**View ▸ Toggle Developer Tools** → **Console** → paste the whole of `simulate-visitor.js` → Enter. A
pretend visitor puts a hand on the Left pad, moves it to the Right pad, lowers it, and leaves:

1. Idle → **Left** when the hand reaches the Left pad.
2. **Right** when it moves to the Right pad.
3. Nothing fires when the hand is lowered between the pads…
4. …but both pads are now empty, so the show returns to **Idle** about 3 seconds later. A pad counts
   hands, not bodies: a visitor standing there with lowered hands is "nobody" to it.

It hands the camera back when it finishes. (The simulated visitor uses the starting area, so run it
before step 2, or expect the pads to be wherever your own area puts them.)

## Make it yours

- **Click a pad** in the Trigger Zones editor to change what it **Detects**: **Any part**, **Hands**,
  **Feet**, or a mix (left hand only, head, body…). **People needed** counts people, so both hands of
  one visitor on a pad are one person.
- **Click a transition** in the Show Machine to change its rule: occupied for N seconds, at least N
  people, or a combination of pads.
- **A floor instead of a wall:** mark the area on the floor and set the pads' **Detect** to **Feet**.

Reference: [Tracking ▸ Mark the interaction area](../../docs/user-guide/13-tracking.md#mark-the-interaction-area-camera-trigger-zones) ·
[MEDIAPIPE.md](../../docs/MEDIAPIPE.md#the-interaction-area--trigger-zones--the-show).
