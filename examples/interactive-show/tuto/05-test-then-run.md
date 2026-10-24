# 05 · Test it, then run it

> Project: [`../interactive-show.artlux`](../interactive-show.artlux)
> You'll learn: three ways to test a show with nobody in the room and what each one proves, how to run it
> as a show, and what changes when you take it to a real venue.

A show like this fails in front of visitors in ways a quick look never catches: a pad that fires while
someone walks past, a story that never ends because nobody stood in one zone, a return that comes too
soon. **Each way of testing proves something different, and only one of them proves the rules.**

## 1. Three ways to test

| How | What it proves | What it does not |
|---|---|---|
| **Double-click a state** in the Show Machine | every look plays: video, title, pads | anything about the rules: it skips them |
| **`visitor.cjs`** (chapter 1) | every rule fires, in order, with real timings | crowds, or people who do odd things |
| **`lidar-emitter.cjs`**, several people wandering | the show copes with a busy room | the order of anything: it is random |

Use all three, in that order. The visitor's walk passes through every arrow, the branch both ways and the
global rule twice, so a clean run of it means each rule fired at least once.

**Is anything arriving?** Open **View ▸ OSC Monitor** (`Ctrl+Shift+M`). A green dot and a rising message
count mean the tracking input works; an amber dot at `0 msg/s` means ArtLux is listening and nothing is
reaching it (check the port and the bind address from chapter 1).

**A busy room.** The emitter ships with ArtLux, next to the visitor:

```bash
# from a source checkout
node scripts/lidar-emitter.cjs 127.0.0.1 10000 3 --pairs
# installed:  …\ArtLux\resources\scripts\lidar-emitter.cjs (same arguments)
```

That is three people, each reported as **two** blobs, the way a real LiDAR often sees a person. They
wander through every zone, so the show will flip between states. What you are checking is that it never
gets stuck and never flickers.

## 2. Run it as a show

In the editor the show already runs, but with the whole editor around it. For the real thing:

1. **Outputs.** In the left rail, click **Proj** (*Align* group). There is one row per surface: **Wall**
   and **Floor**. For each, pick the projector in **Display** and tick **On**. With one screen to hand,
   pick **Windowed (this screen)** to see the output in a window.
2. **Save** the project (**File ▸ Save**).
3. **File ▸ Launch in Broadcast Mode.** ArtLux restarts with no editor: the outputs go fullscreen, the
   show runs, and the tracking input keeps listening. To stop, use the system-tray icon or
   `Ctrl+Shift+Q`.

> **Broadcast follows the playlist if one is switched on.** If **Show Control** has a project playlist
> enabled, broadcast plays the project that playlist says is due, not the one you launched. Turn the
> playlist off, or put this project in it.

## 3. In a real venue

What stays the same: the states, the rules, the titles, the timings. What you redo on site:

1. **The tracker's address.** In **Prefs ▸ OSC / Tracking**, set **Bind address** to this computer's own
   network address (or **All**), never the tracker's. Check it with the OSC Monitor.
2. **The room's size.** The tracker reports its own floor size, and the zones are stored as fractions of
   the floor, so they stretch to fit. Look at them in the 3D view and in **Trigger Zones**, and move
   them if the real pads are somewhere else (and repaint the pads, chapter 4).
3. **The floor projection.** Lining the projected pads up with the real floor is a calibration; the
   [LiDAR course, chapter 2](../../lidar-tracking/tuto/02-calibrated-projection.md) walks through it.
4. **The dwells.** Watch real visitors for ten minutes, then adjust **Zone enter dwell** and **Zone exit
   dwell** (chapter 4) to the room.
5. **The LED strip.** It sends Art-Net to `127.0.0.1`, this computer. In the **Map** context, click
   **Routing** on the action bar and change the **Loopback** controller's address to the real LED node's.
6. **Leaving it alone.** For a show that runs for days, read
   [Running unattended](../../../docs/user-guide/18-unattended.md): the watchdog restarts ArtLux if it
   ever stops.

## Try it yourself

Run the emitter with **two** people, without `--pairs`, then with `--pairs`. With the blob setting in
Trigger Zones on **part of a person (merge)**, the headcount above the map is 2 both times. Switch it to
**one whole thing — a hand** and run `--pairs` again: every person now counts twice, and the line above
the map reads `4 blobs` with no merging. On a real installation, that is the difference between "two
visitors" and "four". Switch it back to **part of a person (merge)** when you are done.

That is the course. You have taken a show apart, rule by rule, and you can test it without a room.

⬅ Back to the [course index](README.md)
