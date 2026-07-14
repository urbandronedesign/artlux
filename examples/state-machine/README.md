# State-machine example projects

Three ready-to-open `.artlux` projects that teach the [state machine](../../docs/STATE-MACHINE.md),
paired with a hands-on written tutorial in [`tuto/`](tuto/README.md).

**Portable by design.** Every look is a built-in GPU **effect** on a surface (no video/image files),
so these open and animate on any machine — no media, no LED hardware, no network required. Output goes
to `127.0.0.1` (harmless loopback) so nothing is transmitted to real fixtures unless you repoint it.

| Project | What it demonstrates | Runs on open? |
|---|---|---|
| [`01-hello-state-machine.artlux`](01-hello-state-machine.artlux) | states, Scene binding, initial state, `afterDelay`, looping, crossfade | **Yes** — auto-loops (wall clock), no Play needed |
| [`02-triggers-and-actions.artlux`](02-triggers-and-actions.artlux) | five of the six triggers (all but `onTimelineEnd`), the two clocks, entry actions, lock time, regions | Waits for a **manual** trigger, then plays through |
| [`03-interactive-installation.artlux`](03-interactive-installation.artlux) | hub-and-spoke, manual + **OSC** triggers, auto-return dwell, blackout | **Yes** — sits in the attract loop; trigger the spokes by hand/OSC |

## How to open

In ArtLux: **File ▸ Open…** (`Ctrl+O`) → pick a `.artlux` file. These are single-file projects — use
**Open…**, not *Open Project Folder…*. Then open the **Timeline** panel; its top row is the **state
lane** (a **⚙ toggle** to enable the machine, the live current-state name, and an **`edit`** link to
the graph editor).

## Start the tutorial

➡ **[tuto/README.md](tuto/README.md)** — a three-part course that opens each project, takes it apart in
the editor, and has you modify it.

## Keep your changes

These are a sandbox; edits apply live. To keep them, **File ▸ Save As…** to a new file so the originals
stay clean for the next read-through.

---

*How these were built:* each file is a normal ArtLux project (`version 1.1`) — states bind Scenes, and
each Scene is a full-look snapshot whose surface carries an `EFFECT` content source. See
[`docs/STATE-MACHINE.md`](../../docs/STATE-MACHINE.md) for the data model and
[`docs/EFFECTS.md`](../../docs/EFFECTS.md) for the effect/palette catalog.
