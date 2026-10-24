# The interactive-show template — one project that teaches the whole show workflow

> **Status:** Built, documented, verified; uncommitted as of 2026-10-24 evening. Owner's request,
> enhanced below; decisions marked **(assumed)** are mine and can be overruled.
>
> **Outcome.** `examples/interactive-show/` (project, 4 generated Full HD MP4s, `make-media.cjs`,
> `make-project.cjs`, `visitor.cjs`), a five-chapter course in `tuto/` with 8 screenshots and 2 SVGs,
> the set in `examples/README.md`, `docs/manifest.json` and `docs/LAUNCHER.md`, and the user guide's
> `13-tracking.png` / `14-show-state-machine.png` re-shot from it plus a new `13b-trigger-zones.png`
> (fills the chapter's old TODO). Changes from the plan below: the way back is one **global** rule
> (`fromAny`) rather than three edges; the 3D scene got a wall screen and a floor projection; the
> floor pads are a generated shader that lights different pads per state.
>
> **Building it found five app bugs**, all fixed in `d3eb677`: the WebGPU 3D view froze for good when
> the first person was tracked (LiDAR overlay planes resized through geometry args), `emptyFor` never
> fired on a never-entered zone, a 3D screen showed a cropped corner of a growing surface, zone outlines
> compiled ~4 GPU pipelines a second, and the 3D view opened on the origin instead of the venue.
>
> **Open:** the `.lblob` take for readers without Node (not built: the course's no-Node path is
> firing states from the graph); screenshots of the media library and of broadcast mode (not taken).

## The request, as the owner gave it

> the help and the tutorials should be updated · a project with videos and 4 states with a branch, for
> all the screenshots we need · on each scene's timeline a text · the transitions in the graph use LiDAR,
> to explain the conditions · in the 3D scene, 3 zones of interaction · this project in the launcher as a
> template · only Full HD MP4 videos

## The enhanced prompt

Build **one showcase project** that exercises the whole authoring loop of an interactive installation —
media → scenes → per-scene timelines → state machine → LiDAR zones → broadcast — and use it as the
single source for every screenshot in the help and the tutorials that touch that loop. Ship it as an
example set so the Launcher offers it as a template.

### 1. The project (`examples/interactive-show/interactive-show.artlux`)

**Story (assumed):** a lobby installation. Nobody there → an attract loop. Someone walks in → a welcome
that asks them to choose a side. They step on the left or the right pad → one of two stories. Everyone
leaves → back to the attract loop.

**Four states, one branch:**

```
            Entrance: someone enters          Left pad: occupied 1.5 s
  ATTRACT ───────────────────────────▶ WELCOME ─────────────────────────▶ STORY A
     ▲                                    │  └──────────────────────────▶ STORY B
     │                                    │     Right pad: occupied 1.5 s
     └──── all three zones empty for 6 s ◀┴──── (from Welcome, Story A and Story B)
```

| Transition | Trigger (`lidar.zone`) | What it teaches |
|---|---|---|
| Attract → Welcome | Entrance · `enter` | the simplest rule: an edge |
| Welcome → Story A | Left pad · `occupiedFor 1.5 s` | dwell, so walking across a pad does not fire it |
| Welcome → Story B | Right pad · `occupiedFor 1.5 s` | **the branch**: two rules out of one state, first one true wins |
| Welcome / Story A / Story B → Attract | **Combination**: ALL of Entrance, Left, Right · `emptyFor 6 s` | the ALL/ANY combination form, and a level that "arms and holds" |

Every transition is a LiDAR rule, so each one can be explained by pointing at a zone in the 3D view.

**Media: only Full HD MP4.** Four clips, 1920×1080, H.264, 30 fps, about 20 s each and seamless
loops, one per state, each in its state's accent colour. **(assumed)** They are **generated** with
ffmpeg by a committed script (`make-media.cjs`), not filmed. That keeps them license-free for a
public repo and small enough to ship in the installer, and anyone can rebuild them. Target ≤ 5 MB each.

**Per-scene timelines:** every state's scene owns a timeline with two tracks:
- **Video** — the state's clip, looping.
- **Text** — a TEXT clip with the state's title and one instruction line (*"Step onto a pad"*,
  *"Stay on the left pad"*), with fade in/out handles. The words cannot be keyframed (TEXT.md), which is
  why each state carries its own text.

**3D scene:** a floor surface (SOL) with **three zones** — Entrance, Left pad, Right pad — each in a
distinct colour, tracking viz on, people-merge on. The wall surface shows the video + text.

**Safe to open anywhere:** output to `127.0.0.1`, projector outputs present but disabled, no fixtures
that need hardware (one demo strip so the LED path shows something).

**Testing without a LiDAR:** a scripted visitor (`visitor.cjs`, same OSC protocol as
`scripts/lidar-emitter.cjs`) walks the whole graph: enter → Welcome → left pad → Story A → leave →
Attract → enter → right pad → Story B. **Open question:** also ship it as a recorded `.lblob` take, for
readers without Node. A take lives on a timeline, and per-scene timelines swap at every state change,
so where it lives has to be checked first.

### 2. The documentation

| Where | What changes |
|---|---|
| `examples/interactive-show/` | README (title + blurb feed the Launcher card), the project, `make-media.cjs`, `visitor.cjs`, `assets/video/*.mp4` |
| `examples/interactive-show/tuto/` | A new course, one chapter per step: 1 media and scenes · 2 a text and a video on each scene's timeline · 3 the graph and the branch · 4 zones in the 3D scene and the LiDAR conditions · 5 test it without the room, then broadcast |
| `examples/README.md`, `docs/manifest.json` (`examples`) | the new set |
| `docs/user-guide/` 06 timeline, 09 3D scene, 13 tracking, 14 state machine | re-shoot the screenshots that show this loop from the new project; link the course |
| `docs/LAUNCHER.md` § Examples | name the set as the starting template for an interactive show |
| `CHANGELOG.md` | the new template |

### 3. Screenshots

Taken from the **installed** build on a scratch profile, from this project, by a CDP pass. Each one is
then checked by eye for private data (IPs, PINs) per CLAUDE.md, since screenshots are hand-made and
nothing redacts them. Each image gets a `<!-- shot spec -->` comment so it can be re-shot. The set:

1. The media library with the four clips.
2. A scene's timeline: video track + text track, the text clip selected (fades visible).
3. The text inspector.
4. The state graph: four states, the branch, regions.
5. The transition inspector on Welcome → Story A (zone rule, dwell).
6. The transition inspector on the combination rule.
7. The 3D view: floor, three coloured zones, a visitor blob standing in the Left pad.
8. The Trigger Zones panel with live occupancy.
9. The Show context while running (current state highlighted).

Cap: the guide's ~18-screenshot ceiling stands, so these **replace** stale shots rather than add to the
pile.

## Order of work

1. `make-media.cjs` → the four MP4s. Check size and that they play in ArtLux.
2. A generator script that writes the project (reproducible), then open it in the app and fix what the
   app rewrites.
3. `visitor.cjs`; run the full graph on the installed build and watch every transition fire.
4. Screenshots.
5. Tutorial chapters, then the user-guide and Launcher edits; `npm run verify`.
6. Commit (when the owner asks), cut a release so the template ships in the installer.
