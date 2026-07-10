# Tutorial — the ArtLux state machine

A hands-on, three-project course on the **state machine**: ArtLux's tool for turning a set of *looks*
into a **show that runs itself** — a timed sequence, an unattended attract loop, or a live-triggered
installation.

You'll open a ready-made project, watch it run, take it apart in the editor, and change it. No media
files, no LED hardware, and (for the first project) not even the Play button are required — every look
is a built-in GPU **effect**, so the projects animate the moment you open them.

## What is the state machine?

A **finite-state graph over your Scenes**. Each **state** is a circle that *is* a look (it recalls a
bound **Scene** when entered). **Transitions** are arrows between states; each arrow has a **trigger**
that decides *when* it fires — a delay elapses, the timeline reaches a time or marker, a clip ends, or
you fire it by hand / OSC. While the machine is **enabled**, it sits in one state, watches that state's
outgoing arrows, and moves when a trigger fires — recalling the next look (optionally crossfading).

```
   ( Calm ) ──after 6s──▶ ( Rise ) ──after 6s──▶ ( Burn ) ──after 8s──┐
      ▲                                                                │
      └────────────────────────────────────────────────────────────────┘
```

## Before you start

1. **Open ArtLux** and load a project with **File ▸ Open…** (`Ctrl+O`), then pick one of the
   `.artlux` files in this folder. (These are single-file projects — use *Open…*, not *Open Project
   Folder…*.)
2. Find the **state machine's home**: open the **Timeline** panel (bottom dock). Its top row is the
   **state lane**. There you'll see:
   - a **⚙ toggle** (the *Workflow* icon) that turns the machine **on/off**,
   - the **current state's name**,
   - an **`edit`** link that opens the **state-graph editor** (the node canvas),
   - **buttons** for any manual triggers available from the current state.

That's the whole surface. Everything below happens in the graph editor and the state lane.

## The course

| # | Project | You'll learn |
|---|---------|--------------|
| 1 | [01 · Hello State Machine](01-hello-state-machine.md) — [`.artlux`](../01-hello-state-machine.artlux) | states, **Scene binding**, the **initial** state, the `afterDelay` trigger, looping, the **transition crossfade** |
| 2 | [02 · Triggers & Actions](02-triggers-and-actions.md) — [`.artlux`](../02-triggers-and-actions.artlux) | **all five triggers** (`manual`/`afterDelay`/`atTime`/`onMarker`/`onClipEnd`), the **two clocks**, **entry actions**, **lock time**, **regions** |
| 3 | [03 · Interactive Installation](03-interactive-installation.md) — [`.artlux`](../03-interactive-installation.artlux) | the **hub-and-spoke** pattern, live **manual triggers**, **OSC** control, **auto-return** dwell, a **blackout**, deployment |

Work through them in order — each builds on the last.

## Where to go deeper

- **Reference:** [`docs/STATE-MACHINE.md`](../../../docs/STATE-MACHINE.md) — the complete model, every
  trigger/action field, runtime semantics, and OSC.
- **Related:** [`docs/SCENES.md`](../../../docs/SCENES.md) (what a Scene captures),
  [`docs/SCENE-TIMELINES.md`](../../../docs/SCENE-TIMELINES.md) (a state can own its own timeline),
  [`docs/TIMELINE.md`](../../../docs/TIMELINE.md), [`docs/OSC.md`](../../../docs/OSC.md).

> **Tip — keep your edits.** These templates are a sandbox. To keep changes, **File ▸ Save As…** to a
> new file so the originals stay pristine for the next read-through.
