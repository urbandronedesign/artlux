# ArtLux examples & templates

Open, learn from, and remix real ArtLux projects. Most examples are **portable and media-free** — each
look is a built-in GPU **effect**, so the projects open and animate with no external assets, no LED
hardware, and no network. Output is aimed at `127.0.0.1` (loopback), so opening one transmits nothing to
real fixtures until you repoint it. (The **[`lidar-tracking/`](lidar-tracking/README.md)** set is the
exception: it simulates a tracker with a bundled Node emitter script and a recorded take — still no
hardware.)

To open any of them: **File ▸ Open…** (`Ctrl+O`) in ArtLux and pick the `.artlux` file. To keep edits,
**Save As…** to a new file so the originals stay pristine.

## Example sets

| Set | What it teaches | Tutorial |
|---|---|---|
| [`state-machine/`](state-machine/README.md) | Building a self-running / interactive **show** over your Scenes with the project **state machine** — states, triggers, entry actions, regions, OSC. | **[state-machine/tuto/](state-machine/tuto/README.md)** (3 chapters) |
| [`lidar-tracking/`](lidar-tracking/README.md) | Turning a venue's live **LiDAR blob feed** (OSC `/SOL` `/MUR`) into visuals — the **TRACKING surface**, orientation/calibration, and **recording & replaying takes** with no tracker present. Uses the bundled `lidar-emitter.cjs` (ch. 1–2) + a bundled `.lblob` take (ch. 3). | **[lidar-tracking/tuto/](lidar-tracking/tuto/README.md)** (3 chapters) |

*More sets can live beside this one — each folder is a self-contained set of `.artlux` templates plus a
`tuto/` folder with its written walkthrough.*

## See also

- [`docs/`](../docs/) — the reference documentation (start at [`docs/STATE-MACHINE.md`](../docs/STATE-MACHINE.md),
  [`docs/SCENES.md`](../docs/SCENES.md), [`docs/EFFECTS.md`](../docs/EFFECTS.md)).
- [`README.md`](../README.md) — project overview, build, and run instructions.
