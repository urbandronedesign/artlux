# LiDAR tracking example projects

Four ready-to-open `.artlux` projects that teach **LiDAR blob tracking** — ingesting tracked-object
("blob") positions over [OSC](../../docs/OSC.md), mapping them onto a floor zone, and letting the room
**drive the show** — paired with a hands-on written tutorial in [`tuto/`](tuto/README.md) (which covers
chapters 01–03; chapter 04 is documented here).

**Portable — "artlux + script", no hardware.** There is no real tracker and no LED rig anywhere in this
set. The three live chapters are fed by a companion **emitter script** already in the repo
([`scripts/lidar-emitter.cjs`](../../scripts/lidar-emitter.cjs)) that speaks the venue's OSC protocol to
`127.0.0.1:10000` (loopback) — start it, and synthetic blobs drift across the floor. The third chapter
is **script-free**: it replays a **bundled take** ([`demo.lblob`](assets/tracking/demo.lblob)) straight
off the timeline, so it needs nothing running at all. As with every example set, ArtNet output is aimed
at `127.0.0.1`, so opening a project transmits nothing to real fixtures until you repoint it.

| Project | What it demonstrates | Runs on open? |
|---|---|---|
| [`01-blob-viewer.artlux`](01-blob-viewer.artlux) | the `TRACKING` content source, the **SOL** floor zone, OSC receive on port `10000`, live blobs + IDs + trails on the 2D stage | **With the emitter** — start `lidar-emitter.cjs`, then blobs appear |
| [`02-calibrated-projection.artlux`](02-calibrated-projection.artlux) | a media-free **EFFECT backdrop** drawn *under* the blobs (`bgLayerId`), a **calibration** overlay + horizontal **flip**, and the **3D Scene tracking visualization** (`trackingViz`) | **With the emitter** — backdrop draws on open; blobs on the wire |
| [`03-replayed-take.artlux`](03-replayed-take.artlux) | replaying a recorded **take** from the tracking lane — a whole show authored & rehearsed **with no tracker present** | **Yes, no script** — opens running; the bundled take loops |
| [`04-zone-driven-show.artlux`](04-zone-driven-show.artlux) | **the room driving the show, on two projectors** — three **trigger zones** wired to a three-state **Show Machine**, a `SHADER` wall that changes with the state, and a floor carrying **pads + live blob debug in one surface** | **With the emitter** — the blobs walk onto the pads and the show cycles by itself |

## The companion emitter

Chapters 01, 02 and 04 read a live OSC feed. Rather than a real LiDAR server, this set drives them with the
repo's synthetic emitter. From the **ArtLux repo root**:

```
node scripts/lidar-emitter.cjs            # 127.0.0.1  10000  2 blobs/surface (SOL + MUR)
```

It sends `SOL` and `MUR` zone specs plus a couple of orbiting blobs at ~61 fps to UDP `10000`
(`Ctrl+C` to stop). Watch them arrive in the **OSC Monitor** (**View ▸ OSC Monitor**, `Ctrl+Shift+M`) —
now a dock tab on the **3D** (Venue & Rig) workspace context. Two accuracy notes worth knowing:

- **OSC receive is a machine setting, not part of the project.** Turn it on once in **Preferences ▸ OSC
  / Tracking**: **OSC receive** on, **Listen port** `10000`, **Bind address** **All**. Keep the bind on
  **All** (every interface, loopback included) so the emitter reaches you over `127.0.0.1` — a venue NIC
  IP would not. Nothing about OSC ships *inside* these projects: the `settings` block older `.artlux`
  files carry is **ignored on load** (it is the machine, not the show — see
  [`docs/OSC.md`](../../docs/OSC.md)).
- The emitter always sends `id = i+1` and **never `id = 0`**, so the protocol's *"`id == 0` means the
  slot is empty"* leave-signal can't be seen on the wire with the shipped emitter — the tutorial
  teaches that rule from the protocol (see [`docs/OSC.md`](../../docs/OSC.md)), not from a live packet.

## The bundled take (chapter 03)

`assets/tracking/demo.lblob` is a small, hand-authored recording of the SOL feed (~18 s, deterministic
blob paths). A **take** is exactly what the tracking store emits each frame, re-injected on replay — see
[`docs/TRACKING_TAKES.md`](../../docs/TRACKING_TAKES.md). It is referenced by the same folder-relative
POSIX path (`assets/tracking/demo.lblob`) in both the timeline's take list **and** the placed tracking
clip, and that path resolves against the project's own folder on open — which is what makes chapter 03
portable with zero setup. (A live-recorded take captures **up to ~60 fps**, not 61: the store coalesces
the feed to one update per animation frame.)

## Making the show react — trigger zones

Blobs on the floor are the *input*; **trigger zones** are how the room drives the show. A zone is a named
rectangle you draw on a tracking surface (**3D** workbench ▸ **Trigger Zones** dock tab, or **View ▸ Trigger Zones**); the
**Show Machine** can transition on it — *someone enters the entrance → play the reaction state*. Zones are
project-scope geometry (drawn once, shared by every scene), read from the **same store** the live feed and
take replay fill — so you can build and tune the whole interaction against the emitter or the bundled take,
**no venue required**. The tutorial covers this in [`tuto/README.md`](tuto/README.md#trigger-zones--making-the-room-drive-the-show)
and chapter 03; wiring a zone to a transition is in [`docs/STATE-MACHINE.md`](../../docs/STATE-MACHINE.md),
the field-tuning knobs in [`docs/TRACKING_SYNC.md`](../../docs/TRACKING_SYNC.md).

### Chapter 04 — a whole interactive piece, built for a venue

[`04-zone-driven-show.artlux`](04-zone-driven-show.artlux) is that idea built out: **three states, three
scenes, three zones**, and nothing else driving it. Unlike chapters 01–03 it is shaped for **two real
projectors** — one on the wall, one on the floor.

| | Wall (projector A) | Floor pads lit (projector B) | Leaves when |
|---|---|---|---|
| **Home** | slow blue-green tide | **Left** (amber) + **Right** (magenta) | somebody steps on a side pad |
| **State 1** | amber radial bloom | **Return** (cyan) | somebody stands on the return pad ~**1.45 s** |
| **State 2** | magenta sweeping bars | **Return** (cyan) | same |

The return is **1.45 s** of standing, not 1.2: `occupiedFor` counts from the moment the zone *latches*,
which is itself `trackingZoneEnterSec` (0.25 s) after somebody arrives.

**Exactly two surfaces, because a `ProjectorOutput` binds exactly one `surfaceId`.** The floor cannot
be "the debug view plus three pad rectangles" — it has to be *one* picture. So the pads are drawn as
the floor's **background layer** (`bgLayerId`) and the `TRACKING` content composites the live blobs,
ids and trails on top: one projector, showing both the thing you step on and the proof the tracker saw
you, in register. Both outputs ship **disabled with no display bound** — `displayId` is an Electron
display id, which belongs to your machine and not to the file.

## Taking chapter 04 to a venue

**1 — Machine settings (not in the project).** Preferences ▸ OSC / Tracking: **OSC receive** on,
**Listen port** `10000`, **Bind address** **All**. Confirm packets in the **OSC Monitor**
(`Ctrl+Shift+M`) before touching anything else — no blobs here means nothing downstream can work.

**2 — Outputs.** **Projection Outputs** workbench (rail ▸ *Proj*) ▸ **Wall** → pick its display, enable,
drag the corner-pin handles onto the wall. Same for **Floor**. Then **check the transport is running**
(the Play/Pause button reads **Pause**) — see the clock note below. Do not reflexively press Play: it is
a toggle, and the transport comes up running, so pressing it stops the show.

**3 — Zones, against the live feed.** **3D** (Venue & Rig) ▸ **Trigger Zones**, with a person walking the floor.
Drag and resize the three rectangles that are already there — **move them, never delete and redraw**.
The transitions and `sync-pads.cjs` match on zone **id** (`zn_left`, `zn_right`, `zn_home`), ids are not
shown or editable in the panel, and a freshly drawn zone gets a random UUID — so a redrawn "Left pad"
leaves its transition permanently inert. The visible **Name** is yours to change. **Then `Ctrl+S`.**

**4 — Re-sync the paint to the zones, and check the wiring:**

```
node examples/lidar-tracking/sync-pads.cjs <your-project.artlux>
```

⚠ **Save before, re-open after.** The script only ever sees the file on disk, while the zones you just
dragged live in the app's document until `Ctrl+S`. Skip the save and it reads the *old* zones and
cheerfully reports "pads already match". Skip the re-open (**File ▸ Open…**) and the app — which has no
idea the file changed underneath it — writes its stale pad shader back over the regenerated one on your
next save. Re-open and check the transport is running again.

The painted pads are **generated from the zone rectangles** — nothing in ArtLux draws a zone on a
projector, so a pad is only content that happens to sit where a zone is. Move a zone and the paint
stays put: the piece still looks deliberate while asking people to stand in the wrong place. This
script is the only writer of that shader. It also refuses a project whose wiring is broken — a zone a
transition names but no scene listens to, a `bgLayerId` that resolves in one scene and not another, a
surface with no output. Add `--check` to verify without writing (it exits non-zero when stale, so it
drops straight into a pre-show check).

**5 — Turn the alignment overlay off before the doors open.** The floor surface ships with
**Calibrate** ticked — an emerald border, an 8×4 grid, a centre crosshair, `TL/TR/BR/BL` labels and a
U/V gizmo. That is what you want while corner-pinning in step 2, but it is composited into the
**projector output**, not just the editor stage, so the audience sees it too.

Recall each scene in turn, untick **Calibrate** (and usually **Show IDs**) on its floor surface, and
**store the look before moving on** — *Update Scene*, or `Ctrl+Alt+S` (**Save All**), which stores the
active scene and then saves. A surface edit lives only in the live look: plain `Ctrl+S` does not put it
into the scene, and recalling the next scene replaces `surfaces` wholesale. The editor does flag it —
an amber `· look not stored (<scene>)` chip in the title strip, and a *Store your changes?* modal if
**you** GO to another scene — but a recall driven by the **show** (the state machine, OSC, a cue, the
scheduler) never prompts. That is the path chapter 04 runs on, so here the tweak really does vanish
silently the moment somebody steps on a pad.

**6 — Walk it.** Left pad → amber. Return pad, ~1.45 s → home. Right pad → magenta.

### Two traps this file is built to avoid

- **Do not use `flipH` / `flipV` / `rotate` on the floor surface.** They mirror the **blob layer only**
  — markers, trails, `#id` labels and the Calibrate gizmo, all of which go through `transformUV` in
  [`trackingRenderer.ts`](../../plugins/lidar-tracking/src/trackingRenderer.ts). Nothing else moves: the
  pads are a *background layer*, drawn through an untransformed full-screen quad, and occupancy is
  tested against **raw** tracker coordinates in
  [`zones.ts`](../../plugins/lidar-tracking/src/zones.ts) (`ZonePanel` has no idea these fields exist).

  So the show keeps firing on the right rectangles — but the marker that proves the tracker saw somebody
  stops landing on the pad they are standing on, and that overlay is exactly what you use to check
  alignment on site. You end up debugging a room that is working. If the projection comes out mirrored,
  **cross the corner-pin handles** instead: that moves the whole picture and never touches tracker
  space. `sync-pads.cjs` fails the project if a flip is set.
- **Every scene lists every zone in `activeZoneIds`.** `configure()` drops the state of a zone the
  incoming look does not listen to, so a per-scene subscription makes the zone re-arm **from empty** —
  and somebody already standing on it then reads as a fresh arrival one enter-dwell later. Simulated
  over 600 s against the 2-blob emitter at the shipped settings (people-merge **on**, which `zones.ts`
  applies before counting), per-scene subscription collapses **Home** to a median of **0.36 s**;
  listening to all three lifts that to **0.81 s**, because the trigger's arm-and-hold then has real
  occupancy history instead of a blank slate. Per-scene subscription is still the right tool
  when two looks watch genuinely different parts of a room — just not for a zone handed back and forth.

  It is the **`occupiedFor` dwell**, not the subscription, that protects the *triggered* states: State 1
  and State 2 never drop below **5.06 s** and **2.39 s** in that same run. Home stays brief on purpose — it
  is a pass-through between pads — and with the emitter it is often *very* brief (29 of 48 visits under a
  second). That is a property of the **shipped zone layout**, not of the blobs being fast: `zn_home` ends
  at u 0.62 and `zn_right` starts at 0.70, so stepping off the return pad onto a side pad is a gap of
  0.08 in u, crossed in well under a second. (A full edge-to-edge sweep takes the emitter 5–8 s.) Space
  your real pads further apart, or raise `trackingZoneEnterSec`, if the hand-off reads as a flicker.

### Things worth knowing before the doors open

- **Shaders ride the show clock, so the transport must be running.** A surface's generative content is
  driven by `timeline.getShowTime()`, not wall time — **pause freezes the picture**. You rarely have to do
  anything about it: the transport comes up **running** (App's `isVideoPlaying` defaults true and is
  pushed into the engine on mount), in the editor and under `--broadcast` alike. What matters is not
  pausing it by accident — the Play/Pause button is a toggle. **Home** also carries a `play` **entry
  action**, which re-arms the transport if something did pause it, so the show heals itself on the next
  return to Home rather than sitting on a still frame. A scene recall does *not* restart it, so the wall
  look continues across a state change rather than popping back to its first frame.
- **`trackingMergePeople` is ON here**, unlike chapters 01–03. A venue LiDAR emits roughly **two blobs
  per person**, so a raw count double-counts everyone and every `minBlobs` you author would mean half
  what you typed. Tune the radius (metres) in the Tracking parameters.
- **Dwell**: `trackingZoneEnterSec` 0.25 / `trackingZoneExitSec` 0.8 — quick to arm, slower to release.
  The slow release is not politeness, it is what rides out a real tracker's dropouts: blob ids have a
  ~0.13 s median lifetime, and a naive "occupied continuously for N seconds" rule never fires at all.
  See [`docs/TRACKING_SYNC.md`](../../docs/TRACKING_SYNC.md).
- **`idleResetSec` is 120, and as shipped it never fires.** The unattended "nobody came, go home" reset
  is keyed on a state being **held** — a *non-looping* timeline parked on its last frame with
  `holdAtEnd` on — not on plain dwell, because a looping state never "reached its end"
  (`services/stateMachine.ts`). Every timeline here loops, so the safety net is inert. It is left in the
  file as the hook: give the triggered scenes `loop: false, holdAtEnd: true` and a picture that ends,
  and it starts working. Until then the return pad is the only way out of States 1 and 2.
- **No tracker yet?** The whole piece still runs off the bundled emitter — the zones ship placed inside
  its orbit, so it drives itself:

  ```
  node scripts/lidar-emitter.cjs 127.0.0.1 10000 1     # one "visitor"; drop the 1 for a crowd
  ```

## How to open

In ArtLux: **File ▸ Open…** (`Ctrl+O`) → pick a `.artlux` file. These are single-file projects — use
**Open…**, not *Open Project Folder…*. Then open the **Timeline** panel; chapter 03's tracking clip
sits on a dedicated **tracking lane**. Note that chapter 02 turns on the **3D Scene tracking
visualization** (`trackingViz`), so its blobs also render in the **3D Scene**, not just the 2D editor
stage. (`trackingViz` gates that overlay ONLY — a bound projector draws a TRACKING surface either way,
and chapter 02 ships no outputs at all) — open the **3D** (Venue & Rig) workspace context alongside the stage
to see both. (The tracking overlays are tuned in that context's **Tracking** inspector section — put the
2D stage beside it with split view rather than switching back and forth. Formerly shared by both
contexts — see the tutorial.)

## Start the tutorial

➡ **[tuto/README.md](tuto/README.md)** — a three-part course that opens chapters 01-03, watches each run,
takes it apart in the editor, and has you modify it.

## Keep your changes

These are a sandbox; edits apply live. To keep them, **File ▸ Save As…** to a new file so the originals
stay clean for the next read-through. (Recording your **own** take copies the `.lblob` into the *opened*
project's `assets/tracking/` folder, so open a project first before you hit record.)

---

*How these were built:* chapters 01-03 are normal ArtLux projects (`version 1.1`), chapter 04 is `version 1.2`. The floor surface carries
a `TRACKING` content source bound to the **SOL** zone; the optional backdrop is a built-in GPU `EFFECT`
on a `bgLayer` drawn beneath the blobs. See [`docs/TRACKING_TAKES.md`](../../docs/TRACKING_TAKES.md) for
record/replay, [`docs/OSC.md`](../../docs/OSC.md) for the tracking protocol and control, and
[`docs/EFFECTS.md`](../../docs/EFFECTS.md) for the effect/palette catalog. Back to all sets:
[`examples/README.md`](../README.md).
