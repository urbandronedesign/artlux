# ArtLux examples & templates

Open, learn from, and remix real ArtLux projects. Most examples are **portable and media-free** — each
look is a built-in GPU **effect**, so the projects open and animate with no external assets, no LED
hardware, and no network. Output is aimed at `127.0.0.1` (loopback), so opening one transmits nothing to
real fixtures until you repoint it. (Two sets carry bundled media, because they have to:
**[`lidar-tracking/`](lidar-tracking/README.md)** simulates a tracker with a Node emitter script and a
recorded take, and **[`audio/`](audio/README.md)** ships synthesized sound — audio needs audio. Still no
hardware for either.)

To open any of them: **File ▸ Open…** (`Ctrl+O`) in ArtLux and pick the `.artlux` file. To keep edits,
**Save As…** to a new file so the originals stay pristine.

## Example sets

| Set | What it teaches | Tutorial |
|---|---|---|
| [`interactive-show/`](interactive-show/README.md) 🚶 | **A room that drives the show** — the template for an interactive installation. Four states (an attract loop, a welcome, two stories) chosen by where visitors stand: three **LiDAR zones** on the floor, a **branch**, and one **global rule** back to the attract loop. Every state has its own timeline with a **Full HD MP4**, a **title in text** and the **pads painted on the floor**; the **3D view** shows the room at real size with both screens. A scripted visitor walks the whole show, so it runs with no tracker. Ships four generated video loops. | **[interactive-show/tuto/](interactive-show/tuto/README.md)** (5 chapters) |
| [`audio/`](audio/README.md) 🎧 | **Sound that keeps playing when you fire a cue** — the background **bed** that a cue never restarts, versus a **Scene's own** sound that always does, versus the soundtrack that came with a video clip: **three containers, two clocks**. Then how to make a sound come from a *direction* in the room, how to put effects on one clip or a whole track, how to make any of it move over time, and how to leave the whole thing running **unattended**. Ships synthesized audio — the bed **counts out loud**, so "it did not restart" is something you can *hear*. | **[audio/tuto/](audio/tuto/README.md)** (6 chapters) |
| [`state-machine/`](state-machine/README.md) | Building a self-running / interactive **show** over your Scenes with the project **state machine** — states, triggers, entry actions, regions, OSC. | **[state-machine/tuto/](state-machine/tuto/README.md)** (3 chapters) |
| [`shader/`](shader/README.md) | **GPU generative content** — a surface whose picture is *computed* every frame instead of decoded. Which shaders suit a projector and which suit a strip (a strip samples ONE line across the picture), why the render size that feeds fixtures should stay small, and why a shader holds still until you press play. | *the README is the walkthrough* |
| [`lighting/`](lighting/README.md) 💡 | **A rig with no pixels in it** — moving heads driven by authored role values instead of sampled picture. Aiming a head live (one fader, the whole selection, in degrees), **recording a busk as a take**, dropping it on a lighting lane, and turning one movement into a chase with a **phase spread**. Also the three capture verbs — Record, **Store Key**, **Save Pose** — and why a CMY head is a white lamp behind three flags. | *the README is the walkthrough* (4 chapters) |
| [`osc-arduino/`](osc-arduino/README.md) 🔌 | **Sending OSC from the timeline** — an **OSC track** is a curve whose value goes out as an OSC message (`/led`, an `int`/`float`/`bool`) to one or more `IP:port` destinations. Watch it in the OSC Monitor with no hardware, then drive **Arduino boards with Ethernet shields**: the PC's fixed IP, one board, several boards (unique MAC per board, one track per board vs one track to all), and a layer-by-layer **debug checklist**. Ships two Arduino sketches. | **[osc-arduino/tuto/](osc-arduino/tuto/README.md)** (4 chapters) |
| [`blender-screens/`](blender-screens/README.md) 🖥️ | **Screens named in Blender** — a venue `.glb` whose object `screen_main` (16:9) ArtLux finds by its name and lets you bind on its own, while the rest of the room shows something else. Ships the `.blend`, the `.glb` and the Blender script that builds both. | *the README is the walkthrough* |
| [`lidar-tracking/`](lidar-tracking/README.md) | Turning a venue's live **LiDAR blob feed** (OSC `/SOL` `/MUR`) into visuals — the **TRACKING surface**, orientation/calibration, and **recording & replaying takes** with no tracker present. Uses the bundled `lidar-emitter.cjs` (ch. 1–2) + a bundled `.lblob` take (ch. 3). | **[lidar-tracking/tuto/](lidar-tracking/tuto/README.md)** (3 chapters) |

*More sets can live beside this one — each folder is a self-contained set of `.artlux` templates plus a
`tuto/` folder with its written walkthrough.*

## See also

- [`docs/`](../docs/) — the reference documentation (start at [`docs/AUDIO.md`](../docs/AUDIO.md),
  [`docs/STATE-MACHINE.md`](../docs/STATE-MACHINE.md), [`docs/SCENES.md`](../docs/SCENES.md),
  [`docs/EFFECTS.md`](../docs/EFFECTS.md)).
- [`README.md`](../README.md) — project overview, build, and run instructions.
