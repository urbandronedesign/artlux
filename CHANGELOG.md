# Changelog

## Unreleased

### A full-HD Spout sender now arrives full HD

A 1920×1080 Spout source reached the compositor as **512×288** — 7% of its pixels — and the reduction
was a nearest-neighbour point sample. Sending full HD got you a visibly aliased picture back: jagged
edges, moiré on fine detail, and crawling shimmer on anything that moved, because which surviving
pixel won shifted from frame to frame. No setting in the app explained it.

Two causes, both fixed. **The receive cap is 1080p in every mode**, where it was 512² and lifted to
1080p only under `--broadcast`. That mode split was wrong in principle: a projector window can be
opened from the *editor*, so the "preview-grade" cap was never only preview — it was feeding live
output. **And the resample is a box filter**, averaging every source pixel covering a destination
pixel instead of keeping one and discarding the rest.

With a 1080p cap an ordinary 1080p sender needs no resample at all, so that case takes a new copy-only
path; the filter now runs only for a source larger than the cap, such as a 4K sender.

**The old cap was not buying what it appeared to buy.** Measured against a live sender, capping at
512² rather than 1080p saved 0.47 ms per frame — inside the run-to-run noise. The cost of a Spout
receive is dominated by the GPU→CPU readback, and that happens at the *sender's* resolution either
way. The cap cost 93% of the image to save half a millisecond.

What it did save is IPC payload, and that part is real: a 1080p RGBA frame is 8.3 MB against 0.59 MB.
Half of that is addressed below; transferring the buffer instead of cloning it is still to come.

### Spout frames arrive as GPU textures, with no readback and no copy

A Spout frame now reaches the compositor as the **texture itself**. Nothing is read back to system
memory and no pixels cross IPC: main imports the sender's texture and hands the renderer a
`VideoFrame`, which is a `CanvasImageSource` and so draws exactly where a canvas did.

Getting there needed a **re-share**, because Electron will not accept Spout's own handle. It requires
an NT handle, and Spout's NT mode is an opt-in its senders rarely set — the default is a legacy
DX9-style token that is not a kernel object, so the import fails with "Unable to duplicate handle."
That is not fixable upstream; Resolume, TouchDesigner and OBS choose it. So the receiver opens the
sender's texture on its own D3D11 device and copies it into one it created itself, entirely in VRAM.

The picture is identical either way, so a line on startup says which path a machine is on:
`[spout] GPU shared-texture path active`. **Every failure falls back** — a sender on another GPU, an
Electron without the API, a format we cannot describe — and the CPU path is unchanged beneath it.

Delivery uses a first-party preload seam rather than the plugin IPC bridge, because a shared texture
cannot be structured-cloned. It is deliberately generic: the sender names a channel, so NDI receive
and any future GPU source take the same road.

### Spout no longer stutters against a 60 fps sender

The poll rate briefly followed **Engine rate**, on the reasoning that producing frames faster than
anything consumes them is waste. That was wrong, and it stuttered: a 60 fps sender polled at the
engine's 30 Hz is *sampled* at half rate off an unrelated clock, so the picture advanced by one
source frame on some ticks and two on others. Right frame count, visibly uneven motion.

The poll now follows the **sender** — a floor of 60, which is what Spout senders overwhelmingly run
at — so every frame it makes is caught. Interval spread fell from ragged to a 0.8 ms standard
deviation around a 17.6 ms mean.

There is a ceiling too, and it exists because **Spout's own frame gate cannot be trusted**:
`is_frame_new()` depends on the sender publishing frame counts, and against one that does not it
answers "yes" forever. Polling above the sender's rate therefore does not cost a cheap no-op — it
re-delivers the same picture at full price. Measured at 92 Hz against a 60 fps sender: 278 frames
delivered in 3 s, only 179 of them distinct.

*This gives back the IPC saving claimed for the CPU path below — that saving was what caused the
stutter, and smooth motion is worth more than the bandwidth.*

### Spout stopped producing frames nobody reads

The native receiver polled on a fixed 16 ms timer — about 60 Hz — while the frame engine consumes at
**Preferences ▸ Engine ▸ Engine rate**, which defaults to 30. Every surplus poll that found a new
frame paid the whole cost of a receive: a GPU→CPU readback at the sender's resolution, around 9 ms on
the main process's own thread, followed by an 8.3 MB structured clone across IPC — for a frame nothing
would ever look at. At 1080p that is a quarter of a gigabyte per second produced in order to be
dropped.

The poll now follows the engine rate, on the same reasoning the setting itself rests on: asking faster
than anything consumes does not produce more pictures. At the default this halves both the
main-thread time and the IPC traffic, and raising Engine rate raises the Spout poll with it.

Changing the rate re-arms the poll **without reconnecting**. A reconnect resets the receiver and its
first frame is all zeros, so otherwise nudging the setting would have blinked every Spout surface
black.

## v0.25.2

### A projector can play a calibration instead of recomputing one

Replaying a calibration used to mean rendering the whole venue a second time, from the projector's
viewpoint, in its own 3D scene with a depth pass — at showtime, per output. Now the geometry is
**baked once into a file**: for every pixel of every projector, which point of the content belongs
there, with occlusion, the object's silhouette and the content's footprint edge already resolved into
it. Playback samples a picture through that map. **No venue model, no 3D scene, no depth pass.**

The map now *supersedes* the live venue render rather than drawing underneath it — which is what it
did at first, invisibly, because both paths draw the same silhouette and a screenshot agreed with the
map to 0.25% while the wrong one was on screen.

**A show machine boots calibrated.** The file's path is remembered per machine (never in the project —
a calibration describes the room, so one file serves every show run there) and re-read at startup.
Without that, a baked calibration could never reach `--broadcast` at all: it renders the show and no
editor chrome, so there is nothing to import from and nobody to click it.

**Playing a calibration no longer needs the app that makes one.** `--calibrate` now gates only
*authoring* — the wizards, the camera, OpenCV and the venue render you align against. Import and
playback are in every launch, so a plain editor has no Calibration entry on the rail but does have a
**Calibration File** panel under Projection Outputs.

### The projected picture stopped stair-casing

Two separate causes, one of them a regression from the above.

The baked silhouette was a **binary** hit flag, so the outline stepped from nothing to full in one
pixel and stair-cased along every slanted edge. The mesh path never had this: it drew a real warp mesh
into a multisampled buffer and got its outline antialiased for free. MSAA cannot help the baked path
at any cost — that edge is made by a branch in a fragment shader, so every sample in a pixel takes the
same side of it. The bake now renders at 2× and stores real coverage per texel, in a channel the file
already reserved. **Re-export to benefit.**

Content is also **mipped and anisotropically filtered** now. Content mapped onto a venue is almost
always minified, and undersampling does not merely blur — it crawls as the video plays, which on a
large projection is far more objectionable than a static jagged edge.

### A new timeline track lands on top, and the reorder grip is findable

**+ Track** appended, and on this timeline array position *is* depth: index 0 is both the top row and the
front-most contributor to the Program composite. So every new track was filed **behind** everything
already authored — you added a track, dropped a video on it, and the picture did not change. It now
lands on top, and the track list scrolls so you can see it arrive. Every NLE does this, and the in-app
help already promised it ("higher tracks composite over lower ones").

Reordering tracks by dragging the header grip has shipped for a while and **nobody could find it**. Two
reasons, and the second is the real one:

- The grip was a 12px glyph at the dimmest text tier carrying a native `title` and nothing else — the
  only control in that header not wired into the help system, while all seven of its siblings had a
  tooltip and a *? Learn more* link. It now has a real hit target, a hover chip, the brighter text tier,
  and its own help entry.
- **The drag's hit-test was 30px out.** It converted the pointer into content space and subtracted the
  ruler, but the row it measures from is the *first track*, and the always-present state-machine lane
  (30px) sits in between. Against a 36px default lane that is nearly a full row: the track swapped on the
  first pixel of movement and then trailed the pointer by most of a lane for the rest of the gesture. A
  feature can be present, documented and shipped and still read as absent if it does not track your hand.

The gesture itself is unchanged — it still drafts locally and commits **once** on release, so a reorder
on a running show is one document write rather than one per lane crossing. The carried row now takes an
accent ring and the cursor turns to `grabbing` for the duration.

Track order carries no other meaning: clips, surface bindings, 3D planes and audio all bind by id, so a
reorder moves depth and nothing else, and **no project file changes**. The Tracking and Lighting take
lanes still append — they are excluded from the composite, so the bottom keeps them out of the way.

### The mapping canvas is an open workspace, not a square

Drag a surface off the unit square and it kept sampling, kept reaching projectors, kept drawing in the
3D scene — and **vanished from the Stage**. The preview was a blit of a fixed 512×512 composite raster,
so anything outside it was silently cropped from the one view you author in. The output was right and
the picture lied.

The engine now paints and positions **one preview canvas per surface** at 30 Hz, fed from the effective
surfaces so automated geometry and opacity stay live, and content follows a surface anywhere. The square
chrome is hidden, the grid and snap guides tile the whole workspace at the cell size snapping already
used, and the legacy fixture-overlay clip is gone. Stored coordinates are untouched — the invisible
container stays as the percent frame — so **no project file changes**.

The square composite is no longer built on WebGPU at all. It remains, unthrottled, as the WebGL
fallback's sampling source, and in that reduced mode the frame comes *back*, labelled **Document UV
0–1**, with an amber black-on-LEDs chip on any surface outside it — because there it really is the
sampling extent, and cropping there is the truth rather than a rendering artifact.

### The state graph is an open workspace, and the show flows top to bottom

The same fence, in the other editor: a fixed 2600×1700 scroll-document. The graph canvas now adopts the
Stage camera and is **unbounded in every direction** — left-drag empty canvas or middle-drag anywhere
pans, the wheel zooms toward the cursor (0.1–5×), and **Fit** / **Reset** plus a rebindable `F` recover
a graph you have lost. Saved projects load pixel-identically; the coordinates just stopped being fenced.

Authoring now runs **top to bottom**. The link nub rides the node rim toward your cursor, dropping a
link on empty canvas **creates the linked state right there**, and a new **Tidy** relayouts the graph as
a BFS-layered vertical flow — unreachable states last, region membership re-derived spatially,
hand-drawn curves straightened, and idempotent, so a second Tidy moves nothing. **Build from scenes**
seeds a vertical column at the view centre.

**Build from scenes is a top-up now**, not a rebuild: scenes already bound to a state are skipped, so
running it again after capturing new scenes adds only the missing ones instead of duplicating the whole
graph. The button disables when every scene has a state, and shows the missing count when they do not.

**A state whose scene was deleted stops being pixel-identical to an unbound one.** The node carries a
scene-missing warning, the inspector explains the dead binding and offers an undoable clear, *Edit
timeline* no longer renders as a silent no-op, and a `recallScene` entry action pointing at a dead id
warns the same way. Deliberately **no auto-cleanup** when a scene is deleted — a cascade that quietly
unwires a flow is worse than a warning that doesn't.

Two details worth keeping: the wheel handler is a native non-passive listener, because React's root
`onWheel` is passive and its `preventDefault` was a console-warning no-op; and the auto-fit fires when
states *first exist*, because the editor can mount before the project arrives.

### An LED fixture reads as the device it is

On the 2D canvas a fixture was a plain rect that disappeared over bright content. It now has a blue
hatched body (one `.fixture-hatch` class, flipped red on selection through `--hatch-c`), so it stays
visible over anything, and **a resize handle on every edge**, anchored on the opposite edge and
rotation-aware through the existing anchor correction.

The created rect is also **derived from the pixel description** instead of being a fixed square: at 4px
cells, a strip is `ledCount` wide by one cell tall, and a matrix keeps its Cols × Rows aspect. It
re-derives on count and shape edits *only while the rect is still pristine* — the first hand-resize
makes it the operator's forever. Saved projects hold the old 0.2 square, which matches no derivation,
so **existing rigs are untouched by construction**.

### Undo reaches the rest of the document

The machine viewport wrote through a bare setter while `stateMachine` **is** in the undo snapshot. So
graph edits were not merely un-undoable: undoing any unrelated recorded gesture **silently reverted the
graph work done since**. Writes now record through the single chokepoint, coalesced per gesture — a live
bezier drag or a typing burst is one step, and 500 ms of quiet starts the next. Node and region drags
gained the Stage's moved-latch, because a drag-less click must not commit a no-op patch that recording
would turn into a junk step eating the operator's next `Ctrl+Z`.

That finished a sweep of every authored slice: each one now records, or is excluded on purpose with an
honest reason.

- **Scene deletion records.** `Ctrl+Z` resurrects the scene, its timeline, its cue cells, and heals any
  scene-missing states it stranded. The confirm now says *"Ctrl+Z can bring it back"* instead of lying
  the other way.
- **Surface deletion records**, with the asymmetry spelled out in the confirm: the surface returns, the
  projector-output binding does not, because `projectorOutputs` is deliberately outside the snapshot.
- **The 3D scene writers record** — add model, remove model, scene config — all discrete commits.
- **The gizmo commit paths stay record-free on purpose:** gizmos latch history at drag start, so a
  second post-mutation record would make the next `Ctrl+Z` a visible no-op. An invariant guards **both**
  directions.
- **Asset relink and delete stay un-recorded.** `assets` is outside the snapshot, so recording them
  would produce a *torn* undo — clips restored, library entry still gone — and their "can't be undone"
  confirms stay truthful.

### The engine has a frame rate now — and asking faster was making video *worse*

Heavy video stuttered: a looping clip, or a track with several clips, would visibly stop and start.
Three attempts to fix it in the decoder failed (one made it worse and was reverted) because they were
aimed at the wrong thing.

Every engine tick asks each video layer's codec for the exact frame at the playhead. **Asking faster
than the decoder can serve does not produce more pictures — it produces misses**: the decode ring hands
back the nearest frame it holds instead, and a burst of those is exactly what an operator sees as a
hitch. The engine ran at display rate, so on heavy media it was asking for frames nobody could supply.

Measured on a 1080p60 HAP show looping every 14 s:

| engine rate | exact frames missed | worst half-second |
|---|---|---|
| uncapped (~60 Hz) | **19.0%** | 78 |
| 25 Hz | **0.27%** | 9 |

Every scene cut was clean at the lower rate. The clue that found it: the **projector** window, decoding
the same media but only for the one surface it draws, missed **0.007%** throughout — the window doing
*more* work had almost no problem, which pointed away from the decoder and at how often it was asked.

**Preferences → Engine → Engine rate (fps)**, default **30**. It is *not* the Art-Net rate — the wire
keeps running at **FPS** with keep-alive, so a slower engine never starves a node; only new pixel data
arrives less often. Machine-scoped, because the right value depends on the computer's disk and GPU
rather than on the show.

Also ships the instrumentation that found it, since three wrong guesses preceded it:
`window.__artluxLayerGaps()` (clip switches vs frames with no picture) and `__artluxHapPulls()` (who is
pulling on a decode ring, at which index, with what cached).

### A heavy show opens without reading itself

The cold-start gate held the show until the opening look was decoded — and had **never once reached
`ready`** on any project. It always failed open at its deadline, so the readiness logic, and the codec
pre-roll that exists to serve it, applied to nothing. Underneath it, everything scaled with the size of
the project rather than with what the show was about to display.

Measured on a 60-scene / 2400-clip / 3000-LED project over 2.3 GB of real HAP + H.264, and on a real
venue show:

| | before | after |
|---|---|---|
| bytes read over IPC at open | 887 MB | **0 MB** |
| peak main RSS | 1963 MB | **284 MB** |
| codec residency, walking show | 3793 MB, climbing | **~250 MB, flat** |
| cold-start gate, real project | 17.1 s, armed by TIMEOUT | **7.3 s, armed by READY** |

**Media streams instead of being read whole.** A privileged `artlux-media://` scheme answers HTTP Range
from a read stream, so a decoder pulls the byte windows it needs and nothing holds a file in memory — a
1 GB HAP `.mov` used to cost 2.3 s of read and take main's RSS from 125 MB to 3.7 GB for a few megabytes
of actual want. Only what the open project references is served, and closing a show revokes it. It also
deletes a correctness hazard: *"the blob has not landed yet"* was a state the timeline carried, and it is
what let a warm pool promote on an empty element — the show starting on black.

**Warming became a relevance window** rather than every clip in the document, **the residency budget now
binds** (it was bypassed by its own protect set, and a demoted pool never released its decoders at all),
and **the look-ahead is ranked** by how soon an edge can fire — including `fromAny` global rules, which
the old filter could never match, so the edge most likely to fire in an interactive show was the one edge
never preloaded.

**Three bugs surfaced only by measuring.** The gate waited on audio conforms that take *minutes* (a
transcode, not a decode). HAP keyed its decode ring by path alone, so a file used by both a surface and a
timeline layer had two playheads over one ring, each evicting the other — 88% ring miss. And a pre-roll
shared its retention claim with playback, so a 1 GB clip cycled 0 → 3 → 0 MB of cached frames forever —
that last one is what kept the gate from ever arming ready.

Also: the boot fraction is a ledger now (it could previously go backwards, or read `n/0`) and says what it
is waiting on; a warm scene keeps its **sound** loaded, so a cut into it no longer eats a sting's attack;
thumbnails persist in `<project>/.artlux-cache/`; the media grid is windowed; and
`SmTransition.waitForContent` lets an unattended installation wait briefly for a destination's picture —
off by default, because a GO in front of an audience should fail fast rather than hang.

Full record, including what was measured and **dropped**:
[plans/preload-optimization.md](plans/preload-optimization.md).


### …and the four places that assumed the engine ran at display rate

Capping the engine did not just change a number — it invalidated an assumption four unrelated places had
baked in, and every one of them was invisible in the editor preview. Found by running a **fullscreen
projector output in broadcast mode**, which is the path the rest of this release could not exercise.

**Three producer/consumer seams, all gated at 33 ms.** Each was written when the engine always ran faster
than it was sampled, so "every other tick" was stable. Against a 30 Hz producer they alias: sub-millisecond
jitter drops a whole update.

| Seam | Symptom on the wall |
|---|---|
| Transport → projector | The playhead arrived 33, 33, **66**, 33 ms apart. A projector decoding a HAP layer *locally* uses it as its time base → a visible hitch |
| Frame pump → projector | A codec's drawable generation only advances when the engine asks, so pump and producer beat against each other and frames were held |
| mp4 refill | `pump()` ran only from `frame()` — **the decoder refilled only when asked**. Half the asks, half the refill rate at a cold clip entry → most of a second of missing video |

The gates are now finer than any selectable producer period (15 ms passes every tick at both 30 and 60 Hz),
and the mp4 decoder tops itself up from its **own** rAF. Shipping did not get more expensive: the generation
dedup still decides when a bitmap is made. The consumers that *cannot* dedup — live sources with no
generation, the render-from-projector layer streams, the referenced-surface budget — explicitly keep the
original cadence.

**The fourth was the tablet's health tiles**, which is the one nobody would have reported. Both thresholds
were absolute (`fps < 50`, `p99 > 25 ms`), written when 60 Hz was the only possibility. A perfectly healthy
30 Hz show reads 30 fps with a ~33 ms p99 — so an unattended venue's remote would have sat **permanently
amber**, which is worse than no indicator: it teaches the operator to ignore the colour. Now judged against
the show's own frame period. The long-frames tile needed no change; it was already relative (`p50 × factor`),
which is the pattern the other two should have followed.

Verified in broadcast on a real fullscreen output, after resetting every counter so the window contains no
boot noise: **0 gap events across 5 clip switches, 0 HAP ring misses in 3055 asks, 5442 pump ships with 0
aliased skips**, frame delivery 33.3 ms median / 33.5 p95 / 66.5 max. The same run before the reset — which
included boot — showed 492 gaps and an 816 ms pump stall.

**And the Art-Net question is now measured, not argued:** `artlux_render_fps 30.12` with
`artlux_output_fps 61`, live in broadcast. A slower engine does not starve the wire; the native pacer sends
at its own rate with keep-alive.

### The design system is a page you can look at

`docs/design-system.html` renders every choice in DESIGN-SYSTEM.md **as the thing itself**: the surface
ladder, contrast-annotated text tiers, the hover/press film on working buttons, the z-tier cascade, live
kit mocks, the patterns, both brand marks, and a to-scale splash. The app's own IBM Plex faces are
embedded and the wordmark geometry comes from `shared/brandMarks.ts`, so it is exact offline with no CDN.
Dark-only, like the system it documents. Assembled by hand this once and **not wired into the build** —
regenerating means re-deriving from the doc and `tokens.css`.

### Also

- A calibration import reaches a projector window that **opens later**. It was sent when an output was
  *enabled*, which is before the window exists and its bridge port is up, so it landed on nothing.
- Contribution registries **replace by id** instead of appending. Four of them did not, so a plugin
  activating twice mounted its panels twice — a projector window reached eighteen canvases in one
  session of edits.
- **A measurement that had spread to three files was wrong.** "A calibrated output takes the app from
  60 fps to 17.6" compared two *different projects*; controlled, it was 38.9 against 34.4. It had been
  quoted into `runProfile.ts`, the plugin host and an invariant's rationale, and was the stated reason
  for a design decision. Corrected in all three.
- **A dropped download exited 0 and reported success** — which is how the first v0.25.2 build failed, on
  a missing VC++ redistributable that only surfaced four minutes later. All three fetch scripts settled
  their promise on four events, and a response that stops *without ending* hits none of them: `.pipe()`
  calls `end()` only on the source's end, the long-sent request never errors, and an unsettled promise
  keeps nothing alive, so the loop drains and node exits clean. One shared `scripts/lib/download.cjs`
  now pipes through `stream.pipeline()` (which is what detects a premature close), writes to `.part` and
  renames only after a size check, and retries three times. mediapipe's copy was the worst of the three
  — it skipped on `size > 0`, so one dropped connection would have parked a truncated pose model on disk
  that every later run accepted. Guarded by an invariant, which itself first shipped inspecting **zero**
  files because it walked `.ts`/`.tsx` only and passed.
- **A tooltip-wrapped child that carries a ref stopped logging a React 19 deprecation.** Refs ride on
  props now, and the clone-time merge read `element.ref` first — so every such child logged on render.
  Surfaced by the state-graph smoke test's console-error check, the first time it visited Scenes & Cues.


## v0.25.1

### Broadcast mode starts, and says so when it cannot

**The tray icon is back.** Broadcast is the one mode with no window and no menu, so the tray — and its
**Quit Broadcast** item — is the operator's way out of a running show. In an installed build it was
never there: the icon it loaded lives with the *installer's* artwork, which is not shipped inside the
app, so the tray silently failed to appear on every packaged run and left `Ctrl+Shift+Q` as the only
way to stop a show. It loads the app's own icon now.

**A show that cannot start no longer pretends to run.** If the interface fails to load at all, a
`--broadcast` or `--headless` install used to stay alive with no window, no output and nothing in the
log — holding the network ports and the audio device, invisible, indefinitely. Every check that could
have noticed was waiting for the interface to *finish* loading, which is exactly what had not happened.
It now reports the failure and exits, so a supervisor or the watchdog can act on it.

*For developers:* **Launch in Broadcast Mode** did nothing when run from `npm run dev`, and the process
it left behind broke the next run. A relaunch inherits the dev-server address but the exit that
performs it is what shuts that server down, so the new process loaded a port nobody was serving.
Broadcast and the calibration profile now run the **built** renderer — run `npm run build` first. See
[DEVELOPMENT.md](docs/DEVELOPMENT.md) and [OUTPUTS.md](docs/OUTPUTS.md).

### The watchdog can see a white screen

An unattended install had one way to die completely quietly. A single bad value in a project file can
make the interface throw while it is drawing; when that happens the whole UI unmounts and the window
goes blank — but the process **stays alive, stays responsive, and keeps its event loop turning.** Every
detector the watchdog had was looking for something that *stopped*, and nothing had. The output
engine's keep-alive kept re-transmitting, so the rig held its last look and the wire looked busy. The
projectors were the same lie: a video output froze on its final frame, while a generative one carried
on animating off its own clock and looked perfectly healthy.

So the venue showed a plausible picture, nothing alarmed, and nobody found out until the client called.
The one detector that *could* have seen it — the render-loop heartbeat — was armed only once the
interface had run at least one frame, which meant **a project that crashed while opening was never
detected at all.** Dead, silent, and invisible to every tier, indefinitely.

Three changes, each covering the others' blind spot:

- **The UI reports its own crashes** to the process that can do something about it. Every window
  reports; every fault is written to the watchdog's audit log — **including with the watchdog switched
  off**, which is how an editor install gets a record too. Armed broadcast installs relaunch.
- **A UI that never appears is now a fault.** The stall clock starts when the window finishes loading,
  not when the first frame arrives, so a project that crashes on load is treated like one that froze.
  Cold starts get a longer allowance than mid-show stalls, so a slow venue is not relaunched for being
  slow. This works even if the crash-reporting path is itself what broke.
- **Projectors stop lying.** If the main window goes quiet for ~5 s, each output goes black and re-shows
  its "Waiting for the main window…" caption. ⚠ **A venue unknowingly running on a frozen frame will
  now visibly go dark** — that is the fault becoming legible, not a new one.

Crash-on-load still ends with the circuit breaker tripping and the install down. The difference is that
it is now a dark install that **alarmed, wrote an audit trail, and reads `breaker tripped`** in
Preferences and on the tablet.

**And an operator gets a way out instead of a relaunch.** A crash that takes the whole interface now
shows a recovery screen rather than a blank window. If the *same project* fails to open **twice**, the
app offers **Start in Safe Mode**: it opens empty, with the default layout, and **does not reopen the
last project** — the autoload is the trap, because a project that crashes on load reopens itself every
launch until someone edits settings by hand. **Your project file is not modified.** It stays in *File ▸
Open Recent*, one click away once it is fixed. A crashed *panel* is not this: panels are contained
individually, so one shows a small card while everything else, output included, keeps running. Plugin
panels are contained too — in the editor, in Preferences, in the 3D scene and in a projector window,
where a throwing overlay used to take the output canvas with it.

Fixed alongside: closing the detached Docs window closed the editor; and a tripped circuit breaker
no longer writes a refusal line every second into a log that is only trimmed at startup — on an install
that has, by then, stopped starting.

### An LED fixture is no longer offered a DMX profile

Selecting an LED fixture used to open its parameters column with **"Choose a DMX profile…"**. It read
like an explanation of what a DMX profile is. It was in fact a conversion: it pinned the fixture's LED
count to 1, **unbound it from its surface** — losing the mapping — seeded a full channel block, and
**repatched the entire rig**, because a 14-channel head where a 120-channel strip used to be leaves a
hole that every fixture patched after it slides into. Nothing about the button said any of that.

The *DMX Profile* section is now shown for **light fixtures only**, and **Clear** is gone from it — that
was the same trap mirrored, turning an aimed moving head into a one-pixel strip bound to nothing.

**The kind is decided where the fixture is created**, where there is nothing yet to destroy: *Add
Fixture* (or Library ▸ **LED Templates**) gives you a strip, Library ▸ **Light Fixtures** gives you a
head. Added the wrong one? Delete it and add the other — a cost you can see, instead of a repatch you
cannot. A light still gets **Change…**, which swaps it to another profile or mode, and remains the way
out of a profile this machine's library does not have.

## v0.25.0

### The workspace is yours to arrange, and the engine no longer depends on it

Two things landed together, and the order matters: the second is only cheap because of the first.

**The rendering engine stopped depending on the UI.** The frame loop used to live in a `Stage` effect and bailed out if a DOM node was missing, so unmounting one component stopped Art-Net mid-show. It now lives in `renderer/engine/frameEngine.ts`: it starts itself when its module loads, reads no DOM at all, and reaches the native output engine over its own MessagePort. Proven by deleting the Stage's canvas *and* its container out of a running app while the native engine held 61 Hz — and re-provable any time with `node scripts/test-engine-output.cjs`.

That deleted the invariant every previous workspace design had to be built around.

**So the workbench became rearrangeable.** In any of the nine contexts you can drag a panel by its tab into another group, drop it on an edge to split, reorder, collapse, close it, add any panel from a menu, and reset the workbench to what it ships as. Per context, remembered, surviving a restart. It is on by default; *Preferences › Appearance › Dockable workspace* turns it off and restores the fixed layout exactly.

**It cost the plugin SDK nothing.** The arrangement is *compiled* from the flat manifest a context already declares, so contexts and plugins keep declaring what they always did — and because the absence of a saved arrangement is what triggers the build, upgrading changes nothing you can see: your column widths, dock height and dock tab come across.

**The editor also got quieter.** The timeline panel was re-rendering itself ten times a second for ever, in eight of nine contexts, to move a few characters of text — a clock sampled into React state. Removing it, and taking the ruler and toolbar out of a clip drag, took the idle editor from **177 ms/s of React work to 0.0**, and the frame-time tail with it: **p99 54 ms → 21 ms, long frames 18 → 0**.

*Full reasoning: [plans/engine-decoupling.md](plans/engine-decoupling.md) and [plans/dockable-workspace.md](plans/dockable-workspace.md), each carrying its own work-package tracker with what was measured and what was deviated from.*

### The timeline is a drawer now, and there are two fewer workbenches

The rail is down from **eleven contexts to nine**, and the timeline is not one of them. It is a full-width
**drawer** that eight of the nine workbenches pull up with **Ctrl+T** (or View ▸ Timeline, or a click on
the collapsed strip at the bottom of the window), with open/closed and height remembered **per
workbench**.

The reason is a mistake we nearly made. The light-show work needed the 3D scene and the timeline on screen
together — to record a lighting take against the rig you are aiming — and the only way to get that was a
twelfth context. Which exposed the real problem: **the timeline is a tool, not a place.** You want it
*while* cutting against the 2D stage, *while* recording a take against the 3D rig, *while* authoring a
scene's timeline from the cue grid. Reaching it cost you the viewport you were working in.

So it became a drawer, and the `timeline` context had nothing left of its own — its program monitor is the
`Program` dock tab (the same full-bleed component) and its media library is a new `Media Library` dock tab,
both now in **Mapping** along with Collect Assets. Two side effects worth having: the timeline **no longer
remounts** when you change context (it did, every time, losing your zoom, scroll and clip selection), and
the Show Machine's *Timeline* button and a scene card's *Edit Timeline* now open the drawer **underneath**
the graph or the cue grid instead of taking it away.

**`Tracking` merged into the 3D context, retitled Venue & Rig.** It had become a near-duplicate: no
browser column, one parameter section the 3D context already carried, and a default layout whose whole
purpose was to get the 3D scene on screen — because the 3D scene is where live blobs are drawn. Its four
plugin monitors (OSC, Trigger Zones, Pose, Augmenta) are dock tabs there now, in a dock region that was
previously empty. Venue & Rig also gained the DMX Profile + Channels parameter sections and a **Record
Lighting Take** action, so the whole light-show loop happens in one place.

Also fixed, found while merging: turning split view on inside a 3D context produced an **empty left pane**
— the shell pins the 3D scene to the right pane, so there was nothing to show. A context whose viewport is
the 3D scene now names a `companion` for the other pane; Venue & Rig names the 2D stage, which restores the
stage-beside-3D arrangement Tracking used to provide, as a toggle rather than a rail entry.

Your saved workspace is migrated: an install sitting on `Timeline` or `Tracking` opens on Mapping or Venue
& Rig rather than an unselected rail. Two new invariant guards were added for the failure modes this
touched, both of which are silent by nature — a menu entry or a plugin's dock tabs that resolve to a
context that no longer exists, and a context whose declared layout omits a banked flag (which made the
drawer's per-workbench memory behave like a global one on first run).

### Also in v0.25.0

> **The first release since v0.21.0.** v0.22.0, v0.23.0 and v0.24.0 were each prepared — version bumped,
> changelog written — and never tagged, so no build was distributed. This release therefore carries all
> three of those sections below as well as this one. It is also the **first release published with a
> `LICENSE`**, a settled JUCE election, and third-party notices that match what the installer actually
> ships (see [`NOTICE`](NOTICE)).

### A startup splash that says what actually loaded — and who made it, under what licence

ArtLux now opens with its own splash window: the wordmark and version, a plain-language explainer of what
the program is, **a console reporting every native addon and plugin as it loads**, and the credit +
licence line. It closes itself once the editor is up and the report is complete; click it or press Esc to
skip. **Preferences ▸ Appearance ▸ Startup splash** turns it off, and it never opens in `--headless` or
`--broadcast` — broadcast is the watchdog's relaunch mode, where an always-on-top window would flash over
live projector output, mid-show, unattended.

The console is the reason it exists. Every native-backed feature in ArtLux **graceful-degrades on
purpose**: a missing `.node` disables its feature, logs one line, and the app boots looking perfectly
healthy. On a load-in nobody is reading a terminal, so "why is there no NDI on this machine" — or worse,
"the audio UI all works and nothing plays" — cost real minutes to diagnose. Now each thing reports itself
on screen: `✓ loaded` / `! degraded` / `· inactive` / `✕ FAILED`, with what is missing and how long it
took. Nothing on it is faked — a row appears when that plugin's `activate()` actually returned, the
progress bar tracks the two real waves (main process, then renderer), and there is no spinner because
activation is synchronous. A plugin that *throws* at activation used to leave no trace outside
`console.error`; it is now a red line an operator can read out over the phone.

Plugins report via a new optional `status?()` on both SDK halves ([docs/SDK.md](docs/SDK.md)). `off` is
kept distinct from `degraded` on purpose: `nvwarp` is `off` on every machine without a Quadro/RTX-pro GPU,
and a splash that opened on "2 need attention" when nothing is wrong would teach operators to ignore it.

### ArtLux has a licence, and the JUCE question is settled

- **[`LICENSE`](LICENSE)** — a Non-Commercial Educational Licence, © **Zaki Jawhari and Bérenger
  Recoules**. Education, teaching and academic research are free; **commercial use is not permitted** —
  paid or sponsored shows, client work, promotion of a commercial product or venue, resale, or
  redistribution for a charge. It is deliberately **not** an open-source licence.
- **JUCE 8 → the free Starter tier, one seat per author, held personally**, recorded in [`NOTICE`](NOTICE)
  with the clauses quoted. JUCE offers AGPLv3 *or* its EULA; **AGPLv3 is expressly not elected**, because it
  would both force this application's source under AGPL-compatible terms and grant recipients the very
  commercial rights the licence above withholds. **Educational was rejected despite the authors qualifying
  for it** — §1.2.4 makes it endure only "for the period of time the Education Licence requirements are met",
  so it would lapse at graduation and take the right to keep distributing with it, and it bars "promotional"
  use, which catches exhibitions and open days. Starter is free, perpetual, and its
  revenue test on an individual counts only income *from use of the Framework* — zero here, and kept there by
  `LICENSE` §2.
  `JUCE_DISPLAY_SPLASH_SCREEN=0` is reconciled against that election, and ArtLux's own splash credits
  JUCE regardless.
- **libspatialaudio's LGPL static-link relinking obligation** is discharged by a written offer
  (`LICENSE` §5): object files + build instructions on request.
- Three of the five open licensing questions in `NOTICE` are now closed; the rest are named as still open,
  including that nobody has confirmed the Starter revenue test with JUCE. `appId` and the GitHub release
  owner still read *urbandronedesign* — those are machine identifiers (upgrade identity, release URL) and
  changing them would orphan installed machines; authorship is `LICENSE` + `shared/credits.ts`.

The credit and the licence line are a **licence requirement** (`LICENSE` §3), not chrome, so they live
once in `shared/credits.ts` — the same one-source treatment as the brand marks — and both the splash and
the About dialog are guarded by `verify:invariants` for rendering them. About's explainer had already
drifted from `package.json`'s description, and its footer credited a party that is not an author.

### Also

- **`bg-bg-stage` was a documented Tailwind class that never existed.** DESIGN-SYSTEM §1.1 has listed it
  from the start, but the `bg` colour key was missing from `tailwind.config.js`, so anything written from
  that row rendered **transparent** (Tailwind drops unknown colours silently). Found when the splash
  console's well had no background. The class is now real.
- New [DESIGN-SYSTEM §9](docs/DESIGN-SYSTEM.md) documents the splash: sizes, the four bands, and the rules
  that are load-bearing rather than taste (why red is confined to a badge, why `off` isn't a problem, why
  nothing 10–11px is on the dim text tier).
- **The MIT HRTF dataset was reviewed** and is MIT-licensed ("Copyright (c) 2007 Aristotel Digenis · Credit:
  Bill Gardner and Keith Martin"), so it is redistributable with that credit — which `NOTICE` now carries. No
  SOFA dataset is bundled at all (MySofa is deliberately not provided), so no SOFA terms attach.
- **The splash reveals on three paths, not one.** `ready-to-show` **does not always fire in a packaged
  build** — the editor window has known that for a long time, which is why it reveals on three. The splash
  was first cut relying on that event alone, and in the packaged installer it never arrived: the window was
  created and never shown, and because its close deadlines are measured from the show time, `Date.now() - 0`
  read as "long past" and destroyed it silently. It now reveals on `ready-to-show`, `did-finish-load` and a
  backstop timer, and refuses to close a window that was never shown. `verify:invariants` fails any
  main-process window reveal that depends on `ready-to-show` alone.

## v0.24.0

> Prepared but **never tagged** — no build was distributed. Released as part of v0.25.0 above.

### Keyboard shortcuts are configurable

Shortcuts used to be a static prose list in the Help panel, hand-maintained and quietly out of step with
the real bindings, with the actual keys hardcoded across a dozen independent handlers. That list is gone.
There is now one registry of every rebindable action, one keymap the handlers consult, and a full-page
editor (**Help ▸ Keyboard Shortcuts…**): an Excel-style table, one ruled row per action grouped by
category. **Click a shortcut cell and press the keys** — the cell records directly, no separate button —
and it applies and persists at once, with a per-row reset and **Reset all**. Colliding keys are blocked
*within a scope*
(Global / Timeline / State graph / Projector), while the same key may be reused across scopes on purpose,
since a Timeline shortcut only fires while the timeline is focused. Overrides are saved to
`artlux-prefs.json` as deltas from the shipped defaults. See [docs/SHORTCUTS.md](docs/SHORTCUTS.md).

### The first run of a show is smooth

A show's opening seconds were the worst seconds it had: on a real 1080p60 HAP project the editor went
61 → 22 → 61 fps over the first half-minute, with 251 decode-ring misses (each one a repeated frame on
the wall) and frame times spiking past 200 ms. Three causes, all measured, all fixed:

- **The show started on an empty decode buffer.** The cold-start gate waited for each layer's *first
  frame*, and a decode-ahead codec starts empty — so playback opened by missing the next hundred
  frames. Codecs can now report a primed buffer (`VideoCodec.preRoll`), and the gate's polling is what
  fills it. 167 of those misses lived in the first ten seconds; they are gone.
- **A waveform pulled a whole video into memory.** Drawing a clip's soundtrack blob-read the *source
  video* — a 1 GB HAP `.mov` read whole in 2.3 s, main's resident memory from 125 MB to 3.7 GB, its
  event loop stalled 1.7 s, and every HAP frame decode is answered on that same thread. Waveforms now
  decode audio containers only; a video's sound belongs to the audio conform.
- **Filmstrips competed with the show.** Thumbnails held off while the gate holds (and for a beat
  after — releasing them *on* the arm merely moved the stutter into the first seconds of playback),
  one job per second while the transport runs, and never a fresh whole-file read mid-show.

- **The show did not start at the top.** The transport runs from launch, so the playhead advanced for
  the entire preload: a project that took 11 s to get ready began its show **11 seconds in**, with the
  audio bed already playing under a picture that had not appeared. Both clocks are now rewound to their
  in-points the moment the gate releases — unless the operator armed it themselves by pressing Play,
  in which case the playhead is theirs.

Same project, same machine, after: **61 fps on every sample from launch to steady state**, zero long
main-thread tasks, and 1.27 GB of startup file reads reduced to 0.5 MB.

### Clips can no longer be stacked on a track

Two clips could be dropped at the same spot on the same track. The engine tolerates it — `activeClip()`
takes the last match — so nothing broke visibly, and that was the problem: the covered clip stayed in
the document, invisible and unpickable, saved and reloaded forever. (One real project carried two copies
of the same file overlapping by 29.9 s.) Drags now slide against their neighbour, trims stop at it, and
every drop lands at the nearest free start — computed at creation, not at drop, since three paths probe
the file's duration first and the length decides whether a gap fits. See
[docs/TIMELINE.md](docs/TIMELINE.md#key-design-decisions-read-before-extending).

### HAP: an unplayable file fails once, and one decode serves every window

Two defects found while investigating a report of 20 fps with HAP on two surfaces and one output.
Neither is confirmed as that operator's cause — measurements ruled out the canvas reads, the IPC
bandwidth, and the surface→output topology, and their picture plays normally — but both are real.

**An undecodable HAP used to retry forever, at full speed.** `open()` accepted any `Hap*` fourcc without
decoding anything, so the codec claimed files it could not play — **HAP Q Alpha (`HapM`)** above all, a
multi-image format carrying two textures where the decoder reads one. Every frame then failed, and the
renderer's decode-ahead ring re-issued three decodes per frame, forever, each doing a real seek + read
of a multi-MB sample in main and logging a warning, with black on the output. Now the native `open()`
validates the first frame's section header and refuses the file with one line naming the variant
(re-export as Hap Alpha `Hap5` for transparency); the ring remembers failed frames and gives up on a
file after a few; the main-side warning is once per path. See [docs/CODECS.md](docs/CODECS.md) for the
variant table.

**Decode work no longer multiplies by the number of outputs.** Every projector window runs its own
decode ring, and main had neither an in-flight dedupe nor a cache — so two windows asking for the same
frame ran the native decode twice. Worse, a mirror walked *every* layer in the document, so a projector
showing an image still decoded the timeline's HAP video. Decodes are now shared (in-flight dedupe + a
byte-bounded recent-frame cache), and a projector decodes only the layer it actually draws. Both guarded
by `npm run verify:invariants`.

### The show waits for its content before it starts

Opening a project used to start the show on the **next frame**. Everything that loads content is
fire-and-forget, so the state machine entered its initial state and ran its `play` action over decoders
that held nothing: a `<video>` below `readyState 2` is undrawable and the compositor clears to black, so
the opening seconds went out **black on the projectors and on Art-Net**, with the bed silent under them
(measured on a cold boot: ~6 s of genuine load) — and an `afterDelay` on the opening state burned its
dwell while the audience looked at nothing.

The machine is now **held** on every project open until the opening look is actually decoded — the first
frame of each of the opening scene's layers, the surfaces' own video/image media, and the audio plugin's
engine loads and conforms (plugins register their own readiness through the new `host.boot` service).
It **always fails open**: after *Preferences ▸ Engine ▸ Preload wait* (default 15 s) the show starts
regardless and the log names what never loaded. Live sources — camera, NDI, Spout, DMX-in, tracking —
are never waited on; one dark venue because a sending machine was off is not a trade worth making.

**The outputs say so too.** While the gate holds, every open projector window draws nothing and shows a
dim **PRELOADING SHOW** sign naming its surface — in the editor exactly as in broadcast. A projector is
pointed at a wall, and half a look (one layer on its first frame, the rest black) reads as *the show is
broken* to anyone standing in the room. It clears by itself. The LED output is not held: `Stage` must
keep publishing frames or Art-Net stops, so fixtures show whatever the surfaces have during the wait.

Pressing Play during the wait starts it immediately. The status bar shows a *Preloading n/m* chip, and
the show-control tablet says "Loading show content" rather than showing a stopped transport. Every cold start goes through the same door — editor open,
`--project=`, the watchdog's relaunch, the playlist's next show. See
[docs/STATE-MACHINE.md](docs/STATE-MACHINE.md#the-cold-start--the-show-waits-for-its-content-servicesbootgatets).

Also fixed on the way: a warm pool whose blob landed *after* its pre-roll pass waited for a later
`warm()` that, for the scene the show opens on, never came — that pool promoted on an empty element.

### The browser and parameter columns resize — and stay resized

Every workbench's side columns were hard-coded (288px / 320px). That was fine for an outliner and wrong
for everything else: a media library at 288px shows two tiles, a wide fixture patch reads as a column of
ellipses, and on a 4K panel both looked like slivers next to the viewport.

Both columns now **drag from their inner edge** — a handle over the viewport edge, the same idiom as the
dock and the timeline region — and **double-click resets** either to its default. The widths are banked
**per context** like every other size, so a wide media browser in Timeline does not force a wide
outliner in Mapping, and they persist to prefs, so they survive a restart.

The cap is the window width minus the other column minus ~420px, rather than a fixed number: the app is
also UI-scaled 80–200%, so a static cap either starves the viewport at 100% or wastes half a 4K panel.
A saved width too wide for the current window is clamped **for display only** — un-maximizing never
permanently shrinks a column you sized on a big screen. See
[docs/WORKSPACE.md](docs/WORKSPACE.md#the-two-side-columns).

### Media Library — **Scan** for media added by hand

Import copies files into the project, but on a venue machine most media arrives the other way round:
someone drops it into `assets/video/` in Explorer, off a USB stick or a sync tool. Those files were
**invisible in the library forever** — they showed up only if something happened to reference them *and*
Collect Assets ran.

The Media panel's import row now has a **⟳ Scan** button. It walks the project's own `assets/` tree
(recursively, into sub-folders you made yourself) and adds a library entry for every media file the
library doesn't already have — **reading only: nothing is copied, moved or rewritten**, so it is safe to
run at any time and running it twice does nothing. Files are typed by extension rather than by which
folder they sit in, dot-files and unknown extensions are skipped, and `.lblob` takes are left to the
timeline that owns them. The result is reported in the panel ("added 3 files" / "no new media"), because
a scan that found nothing must not look like a click that did nothing. See
[docs/ASSETS.md](docs/ASSETS.md#scan-media-added-by-hand).

### Media Library — search on top, and large / medium / list views

The search box was an 80px input wedged at the end of the wrapping filter row — the last place you look,
at the narrowest it could be, for the control that answers *"where is that file"*. It is now the **first
row under the title and spans the full width of the column**, with a clear (×).

The grid was a hard `grid-cols-2`: two absurd tiles when the browser column was wide, two cramped ones
when it was narrow. Tiles now **auto-fill** the available width, and a switch at the right of the filter
row picks the density — **large icons / medium icons / list**, as in Explorer. List view trades
thumbnails for names, which is what you want when the show has two hundred files. The choice persists in
prefs (`WorkspaceLayout.mediaView`), so the density you picked for your screen is still there tomorrow.

Also added: `useLayoutValue(sel)` — subscribe to ONE layout key. `layoutStore.set()` fires per pointer
tick during a resize drag, so an always-mounted sidebar reading the whole layout object would re-render
(and rebuild its usage index) all the way through someone dragging the dock.

## v0.23.0

> **Also carries everything under v0.22.0 below.** That version was prepared — package.json bumped, its
> changelog section written — but never tagged, so no v0.22.0 build was ever distributed. The last
> released version is **v0.21.0**; a v0.23.0 release would be the first to carry either set of changes.

### ⚠ BEHAVIOUR CHANGE — the editor is context-driven; layout presets are gone

The editor was one fixed three-region layout, and every feature added since (projector outputs,
calibration, the timeline, scenes/cues, audio, tracking, show-control) had to be bolted on as **a modal
or a dock tab**. Half the app was reachable only from a menu, the right-hand panel showed the same
section list whatever you were doing, and a plugin could contribute exactly one thing: a modal.

The shell is now built from **workspace contexts** — one active workbench at a time, chosen from a 48px
rail down the far left, each declaring its *whole* shell: browser column, viewport, dock tabs, parameter
sections and action bar. A context is a **manifest of panel ids** and owns no components, which is what
lets `contextRegistry.extend()` give a plugin the viewport of a context it does not own.
Canonical doc: **[docs/WORKSPACE.md](docs/WORKSPACE.md)**.

**Eleven contexts, four clusters.** Build: `timeline` · `mapping` · `3d` — Align: `project` · `calib` —
Show: `scenes` · `machine` · `audio` · `tracking` · `show` — App: `settings`.

**What happens to your layout.** `activePreset` migrates on first launch: `edit`→`mapping`,
`perform`→`show`, `calibrate`→`calib`. The `map`/`led` contexts merged into `mapping` and `media` was
retired into `timeline`, so a saved *active* context id pointing at one of those is remapped too — the
rail never boots with nothing selected. (Their banked panel sizes are simply left unused; nothing else
carries over from them.) Each context now keeps its **own** sizes, so switching restores that
workbench's ergonomics instead of carrying the last one's. Getting around: click the rail, `Ctrl+1..9`, `Ctrl+Tab`, the new **Context** menu (in both the
React and the native menu), or `Ctrl+K` for a command palette that searches every context *and* every
action any context declares — and switches context for you before running one.

**Almost every modal became a workbench.** `OutputsPanel`, `RoutingModal`, `StateGraphEditor`,
`AudioBedPanel`, both calibration wizards, `ShowControlPanel` and `Preferences` are contexts or panels
now; `AssetManager` was deleted outright (its detail pane folded into `MediaPanel`, whose library is the
Timeline context's browser column). Still modal, deliberately, because they are global and momentary:
About, the update notice, the audio-engine warning, and MediaPipe's floor calibration.

Three contexts have their viewport supplied by a **plugin** (`calib`, `audio`, `show`). With the plugin
disabled the host's declared viewport is the fallback, so the rail never carries a dead entry. This also
closes the ROADMAP 2b seam: `App.tsx` no longer mounts the calibration wizards or holds their state.

---

**Timeline replaced "Media & Content", and got the NLE shape.** A context may name one panel for a
**full-width bottom region** below everything else — the browser and parameter columns both stop above
it. Lanes squeezed between two side columns are too narrow to cut in. Above them sits a live **program
monitor**; its measured cost is *none* (60 fps with it open vs 61 without) because it only blits a
composite the engine already builds. The `project` context gained an **Output Preview**: one live tile
per enabled projector output, which for a surface spanned across several projectors shows what each
machine is actually putting on its screen, side by side.

**The Show context absorbed the tablet remote's whole feature set.** Schedule and project Playlist were
reachable *only* from the served PWA, so an operator at the machine could arm an unattended venue from a
phone but not from the app in front of them. The desktop Show context now carries the scene/cue/transport
deck, the wall-clock **Schedule**, the multi-project **Playlist**, and live engine/render/system
**metrics**. See [docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md).

**Preferences is a context, laid out as a mosaic.** It began as a 460px dialog over output protocol and
engine and grew into appearance, the unattended watchdog, GPU probing and every plugin's own
`SettingsSection` — a screen you read and *compare* (Engine FPS against the watchdog's render-stall
threshold; the DMX target against the OSC bind address), which a single scrolling column made impossible.
Each section is now a card, packed by CSS multi-column: 4 columns at 1392px, 3 at 1000, 2 at 700, 1 at
420. The count follows the width the shell actually gave the viewport rather than a viewport breakpoint,
because the window is also UI-scaled 80–200%. Eleven sections fit in roughly one screen instead of
~1300px of scrolling. `Ctrl+,`, the TopBar gear and the Context menu all land on it.

**Cues shows you the show, not the globals.** The `scenes` context's left column carries a program
preview and a timing monitor (both clocks) instead of the global parameter sidebar. **Tracking** got its
own parameter section in the 3D context.

### Every control now answers the pointer

Counted across `src/renderer` + `plugins`: **267** hand-rolled `<button>` elements, **193** with no
`hover:` class, and **267** — every single one, plus both kit primitives — with **no pressed state at
all**. Fixing that per site across 54 files would have drifted again by the next feature, so hover and
press are now a **floor**: one base-layer rule pair in `styles/index.css` films every `<button>`,
`[role="button"]`, `<summary>` and `.pressable`.

It is a film, not a background swap, so a selected cue pad or a toggled-on `IconButton` keeps its accent
tint and merely brightens — a blanket `background-color` would have wiped it and made *hovered* read as
*deselected*. That is what fixes the `sel ? tint : hover-classes` pattern used throughout this UI, whose
selected branch never had a hover. The strengths reproduce the palette's own steps: 5% white over
`surface-2` (`#1e1e1e`) computes to `#292929`, which *is* `surface-3`. Measured after: **642** enabled
controls across all 11 contexts, **0** not reached. Conventions:
[docs/UI-UX-AUDIT.md](docs/UI-UX-AUDIT.md) → Interaction states.

### Fixed — LED fixtures could not be selected in the 3D scene

Clicking a fixture in the 3D viewport did nothing, or worked exactly once. **Four independent causes**,
each of which alone was enough:

1. The 3D canvas mounted at 0×0 when its context was hidden, which leaves r3f's raycaster dead. It is
   now **lazy-but-sticky**.
2. `THREE.InstancedMesh` caches `boundingSphere` from the **first** raycast, and
   `instanceMatrix.needsUpdate` does not invalidate it — so `InstancedLeds` froze its pickable region and
   every later layout change (moving a fixture, editing its 3D position) made it unpickable. Hence
   "works once, then never".
3. **The actual blocker.** Venue screens are big planes and LEDs are 12mm spheres sitting *on* them, so a
   screen is almost always nearer the camera, and `PlaneObject`/`ModelObject` called `stopPropagation()`
   unconditionally — **648 of 649** probe clicks selected a screen. A model or plane now **yields** when
   an LED is in the same intersection list (`Simulator3D/pickPriority.ts`) and r3f carries the click
   through.
4. Selecting a fixture never cleared `selectedModelId`, and `Simulator3D` gates the gizmo on
   `!selectedModelId` — so the click landed with no visible effect.

A 12mm sphere is also not a target anyone can hit, so a fixture now has a **body**: one slim housing
each, drawn behind the LED line as a single `InstancedMesh` sharing one unit-cylinder geometry, so
hundreds of fixtures still cost one draw call.

### Build — the invariants these bugs kept breaking are now mechanical

`npm run verify` = **`verify:invariants` + typecheck**, and `npm run package` runs it first.
`scripts/verify-invariants.cjs` holds **10** checks, each carrying the bug it came from — the class where
the code compiles, the app boots, nothing throws, and the symptom is "I can't select my fixtures" or
"Art-Net stopped". It reads source, so it is instant. Guarded: `Stage`/`TimelinePanel` mounted exactly
once (unmounting `Stage` stops Art-Net mid-show); context switches go through `goToContext()` so a
shipped layout change actually reaches an operator who already opened that context; one 3D scene; the
`InstancedMesh` bounding-sphere recompute; backdrop objects yielding picks; fixture/model selection
staying symmetric; `EditorData` memoized; and the interaction floor staying `:where()`-wrapped so
components can still override it. **When you fix a bug of that shape, add a check** — and prove it fails
by breaking the invariant on purpose first.

## v0.22.0

### ⚠ BEHAVIOUR CHANGE — the installer is now per-machine, and provisions the PC itself

Installing on a second machine produced an app with **no NDI and no projector calibration**, silently.
Every native module degrades gracefully by design — a missing runtime logs one line to the main-process
console, disables its feature and never crashes — and a packaged app has no visible console, so a
half-provisioned machine is indistinguishable from a working one until someone reaches for the feature
mid-show.

Three build inputs are gitignored and were therefore absent from **every released installer**:
`native/calib/opencv_world4110.dll` (CI never ran `build:calib`), the NDI Runtime redistributable
(never bundled — the `customInstall` macro was a documented no-op), and the MediaPipe WASM + BlazePose
models (CI never ran `assets:mediapipe`). They went missing *silently* because electron-builder
resolves an `extraResources` source path as a **glob**: a literal path matching nothing is a skip, not
an error. The build stayed green and the failure surfaced at the venue.

**The installer now provisions the machine.** On first install and on every electron-updater update, it
installs the **NDI Runtime** and the **VC++ 2015-2022 x64 runtime** silently when absent, adds Windows
Firewall rules (Art-Net 6454/UDP, sACN 5568/UDP, OSC 10000/UDP, show-control 8788/TCP), and writes a
diagnostic report to `%APPDATA%\artlux\preflight.json`. Uninstall removes the rules and the watchdog
Scheduled Task, and deliberately leaves the two shared redistributables alone.

**`nsis.perMachine` is now `true`.** All of the above needs elevation, and a per-user one-click install
never prompts for UAC — `netsh` and both redistributable installers would have failed silently, which
is the exact failure mode this release exists to remove. ArtLux now installs to `%ProgramFiles%\ArtLux`
for all users.

> ⚠ **Existing per-user installs are NOT upgraded in place.** Windows treats the two scopes as different
> products, so the new installer will sit *beside* the old one. Uninstall the old
> `%LOCALAPPDATA%\Programs\artlux` first — step-by-step in **[docs/INSTALL.md](docs/INSTALL.md)**.
> Settings and LiDAR takes in `%APPDATA%\artlux` are untouched by either.

### A dependency preflight, and a build that cannot ship a missing resource

**`scripts/preflight.ps1`** — one dependency checker, two modes, no dependencies of its own.
`-Mode runtime` audits a venue PC: the VC++ runtime, the NDI Runtime, the installed `resources/`
against the full expected file set, GPU/driver, audio endpoints, firewall and network profile, port
availability. `-Mode dev` audits a build machine: Node/Rust/MSVC/CMake, the optional OpenCV + LLVM +
NDI SDK toolchains, and every artifact a correct `npm run package` needs. `-Json`/`-OutFile` for a
machine-readable report, `-Fix` to winget-install the two redistributables.

The check that pays for itself reads the **PE import table** of every `.node` rather than trusting
that the file exists — so `calib.node` present but with no `opencv_world4110.dll` beside it reports as
a failure instead of looking fine. It accounts for the directories the app injects itself
(`ensureNdiOnPath()`), so a correctly-installed NDI Runtime is not a false positive.

**`scripts/verify-package-resources.cjs`** re-reads the same `extraResources` declarations
electron-builder will use and **hard-fails** if a declared source is missing or zero-length. It runs in
`package`, `package:dir` and CI ahead of electron-builder, which is what makes this class of bug
impossible rather than merely fixed once.

**`npm run fetch:redist` / `npm run fetch:opencv`** stage the gitignored inputs at package time, so a
fresh clone produces a correct installer. Obtaining `opencv_world4110.dll` needs no OpenCV/LLVM/MSVC
toolchain — it is an unmodified redistributable, and the fetched file is byte-identical (SHA256) to
what `build:calib` produces. CI stages all three, then runs the verifier.

New **[docs/INSTALL.md](docs/INSTALL.md)**: build-PC and venue-PC walkthroughs, first install,
verification and troubleshooting. `NOTICE` gains a "redistributed verbatim" section — it previously
stated the NDI runtime was not bundled, which stopped being true here.

### One picture across several projectors — and a soft edge that actually blends

**Spanning.** Outputs ▸ **Spans** cuts a surface into a grid of overlapping **slices**, each routed to
its own projector. A slice is an ordinary Surface whose content is a cropped region of another
(`SourceType.SLICE`), so every piece keeps the full correction stack it always had — corner-pin and
Bézier homography, soft edge, gamma, colour gain, black lift, NDI send, NVAPI scanout warp,
structured-light calibration — while the source is decoded **once** no matter how many projectors it
feeds. Cols × rows × one overlap number derives every crop *and* every feather together; the map draws
the cut over the live picture and the pieces can be dragged. **Align span** puts the alignment grid up
on the whole wall at once. Spanning the **Timeline** surface spans the entire show composite.

Slicing resolves in `services/surfaceMedia.getDrawable`, the single seam the Stage composite, the
WebGPU LED sampler, the projector frame pump and the projector window all pass through — so the
output layer, the projector IPC, the SDK, the calibration plugin, NVAPI and NDI are untouched, and no
project migrates. The frame pump now ships each output an already-cropped, slice-sized `ImageBitmap`,
so a spanned wall costs *less* IPC traffic than one full-frame output, not more.

### ⚠ BEHAVIOUR CHANGE — soft-edge seams were inverted, and are now correct

`ProjectorGL`'s blend ramp was `alpha^γ` with γ defaulting to 2.2. A projector emits `signal^γ`, so
for two overlapping projectors' **light** to sum across the seam the signal must be `alpha^(1/γ)` —
the exponent was upside down. The middle of every soft edge emitted about **7%** of full light instead
of 100%: a black band exactly where the blend was supposed to be invisible. Fixed in the GLSL path and
mirrored in the NVAPI intensity map (`nvwarpApply.buildIntensity`, which also multiplied the
calibration plugin's partition-of-unity blend map in the wrong space).

`SoftEdge.gamma` keeps its name, its 2.2 default and its place in the file — it is now documented as
what it always had to be, **the projector's gamma**, measurable per machine with Outputs ▸
Auto-measure (camera). Nothing migrates, but **a show already using soft edge will look different**
(correct) on the first launch after updating.

### ⚠ BEHAVIOUR CHANGE — video clips now play their own soundtracks, in EVERY project

A video clip on a timeline plays the audio track inside its own `.mp4`/`.mov`, on that clip's playhead,
through the audio engine — the master chain, the commissioned speaker patch, the meters. There is nothing to
link and nothing to import: placement is derived from the video clip itself, so a move/trim/blade/slip/undo
carries the sound with the picture. It works the same for a HAP `.mov`, a WebCodecs `.mp4` and a plain
`<video>` file, because the sound comes from the *container*, not the codec.

**This changes what existing projects do.** `enabled` is absent in every project authored before this
existed, and **absent means audible** — so a show that has been silent for a year can start playing whatever
its masters happen to carry (a scratch take, room tone off a camera mic) on the first launch after updating.
That is deliberate, not an oversight. Three ways to stop it, coarsest first:

- **Preferences ▸ Audio ▸ Video clip audio — off.** The venue's switch: silences every video clip on the
  machine, with no document edit and no re-save, and it does not travel with the project.
- The **speaker button** on a track header — note this is *not* the `M` beside it, which is the picture flag
  for the Program composite. Hiding a layer does not silence it and silencing it does not hide it.
- **Audio ▸ On** in a clip's inspector, per clip.

Sound is **conformed, not decoded live**: the soundtrack is decoded once, at import, into a WAV cached in
`userData/audio-conform/` (keyed by path + mtime + size), so what plays in a venue is a plain WAV and no
decoder ever runs on the audio thread. The cache is derivable machine state — never in the `.artlux`, never
in `assets/`; delete it and it rebuilds, and a project handed to a venue conforms on first open. Multichannel
soundtracks are **downmixed** (ITU-R BS.775), not truncated to channels 1–2, which would drop the centre
channel — the dialogue. Lipsync trims live in Preferences ▸ Audio (per machine) and the clip inspector (per
clip); they add. Full detail: [docs/AUDIO.md](docs/AUDIO.md).

### ⚠ BREAKING (project files) — a project no longer reconfigures the machine that opens it

`AppSettings` — the audio output device, the Art-Net target, the OSC listen port — is the **machine**, not
the show, and is **no longer written into `.artlux` files** (it already persisted per-machine in
`Prefs.appSettings`). Previously, opening a show authored on another computer overwrote the local audio and
network configuration and made it stick: a project authored in binaural/2 ch would flip an octagon/8 ch venue
rig to a headphone mix the instant it loaded, with no dialog, and the machine stayed that way afterward.

**What happens to an existing project:** it **loads** unaffected. The file's old `settings` key, if present,
is still readable but is now deliberately **ignored on load** — this machine's own configuration is never
overwritten by a project's copy. The one show-scoped field that key used to carry —
`reserveLockedRanges`, the DMX patch policy — has moved into the project file proper
(`ProjectData.reserveLockedRanges`) and is **migrated automatically** from the legacy key on first load.
Nothing is lost and no action is needed. Nothing else about the file changes.

### ⚠ BREAKING (project files) — `Scene.timeline` is now REQUIRED

A Scene could once have **no** `timeline` and fall back to the shared global one. **That shape is gone.**
It was never reachable from the UI (nothing could create one), and it was the root of **two
automation-clock blockers**: a lane copied into a scene got retagged to the *scene* clock **and** shadowed
the genuine base lane by `targetPath` — so a house fade on `audio.master.gain` **snapped +9.6 dB in one
frame on every GO**, and the wrong value was persisted to disk. No fix inside the engine could work: by the
time it ran, the impostor lane was byte-identical to one the operator had drawn. So the *state* was deleted,
which makes two of the three writers that could break the invariant **structurally impossible**.

**What happens to an existing project:** it **loads**. A timeline-less scene is given an **empty** timeline
by the loader. It does **not** fall back to the global one — so such a scene now recalls to a **black
output** instead of silently playing the global timeline. **Delete the scene, or give it content.** Nothing
else about the file changes, and nothing is lost on save.

*(Also breaking, from Wave B: asset paths are now written per-container — every scene's timeline and the
audio bed included — which makes a saved project **forward-incompatible** with builds before Wave 3.)*

---

**Timeline transport — Length bounds playback again (Wave A).** Reverts the v0.12.0 unbounded-clock
change: `Timeline.duration` (the **Length** field) is once more the end of the timeline, and the
transport bar gains **Stop**, **Set In**, **Set Out**, and draggable loop-region handles on the ruler.

- **Length bounds playback.** `start = inPoint ?? 0`, `end = outPoint ?? duration`. With **Loop** on,
  playback wraps `[start, end)` — including with **no in/out region set**, in which case it loops the
  whole timeline (previously Loop needed a region, settable only via the undocumented `I`/`O` keys).
  With Loop off, the playhead now **stops and holds on the last frame** at the end (instead of running
  on unbounded into black), and the engine emits a `pause` transport intent — App remains the sole
  writer of `playing`. Seeking past the end is still allowed; only *playback* is bounded.
- **New state-machine trigger: `onTimelineEnd`.** Fires once when the bound timeline reaches its end
  while playing and not looping; a loop wrap does not fire it. This is what lets a scene auto-advance
  unattended — see [docs/STATE-MACHINE.md](docs/STATE-MACHINE.md).
- **`onClipEnd` narrowed — re-author affected projects.** Because the playhead now parks *inside* the
  final clip at the end-stop (so the output holds a picture instead of cutting to black), a clip that
  runs all the way to the end of the timeline never opens a gap, and `onClipEnd` no longer fires for it.
  **If a project used `onClipEnd` on a final, full-length clip as its "show over" signal, that
  transition will stop firing — switch it to `onTimelineEnd`.** A clip that ends *before* the timeline
  does is unaffected.
- **Transport bar:** new **Stop** (returns to the in-point, not hard 0), **Set In**, **Set Out**
  buttons; the loop region's edges are now draggable on the ruler.

> Old projects may hold clips past their Length (legitimate under the old unbounded rule).
> `normalizeTimeline` raises `duration` to the content end **at load**, once, so none of them truncate —
> it never lowers a deliberately long Length. No project-file migration; the change is purely in
> playback semantics. See [docs/TIMELINE.md](docs/TIMELINE.md).

> ⚠ **If you opened AND saved a project with a pre-release Wave A build, check its Length fields.**
> Those builds re-ran the back-compat raise on *every* load and then saved the raised value, so a
> **deliberately short Length** (e.g. 8 s over a 20 s ambient bed) was silently rewritten to the content
> end and persisted. The authored number is gone from the file — nothing can recover it, and no fix in
> this release can. Re-enter the intended Length once; from this build on it round-trips (the timeline
> now carries a `boundedDuration` marker, so the raise runs at most once per document, on files that
> predate it).

**Audio scoping — the bed no longer restarts on every scene recall (Wave B).** *One transport, two playheads.*

- **The show clock.** The global audio bed (`ProjectData.audio`) and the global timeline's automation now
  ride a second derived time, `showTime`, which a scene recall does **not** reset. A five-minute ambient
  bed plays continuously across every GO while the picture restarts. There is still exactly one transport
  (one `playing`, one rAF, one `<video>` pool) — see [docs/TIMELINE.md](docs/TIMELINE.md) for the full
  reset table. **Leaving a scene reconverges**: the playhead snaps to the show clock, so the picture
  rejoins the bed. (Clicking the scene pill back to Global used to *stop the transport* and kill the bed.)
- **The global timeline's Length is the SHOW's length.** The bed is bounded by it: with the global Loop on,
  the bed wraps with the show; **with it off, the bed ends at the global Length and stays silent** until
  you Stop and Play (or press Play again, or lengthen the timeline). **Set the global Length to cover your
  show.** ⚠ And note the edit case: **shortening the global Length below where the show has already
  reached ends the show immediately — the bed hard-cuts and stops.** That is honest ("you just told the
  show it is 60 s long, and it is now over"), but it is not a no-op, and it happens with **no dialog**.
- **Audio lanes.** Audio is authored on a timeline lane — drag, trim, blade, snap, waveforms, and **fadeIn /
  fadeOut corner handles** (which the driver now honours; the two fields have been persisted and silently
  ignored since Wave 3). The Audio Bed panel's `@ N s` numeric placement field is **removed** — the lane
  replaces it. **`AudioTrack.solo` is honoured too** (also silently ignored until now).
- **`Timeline.audio` — every timeline gets its own audio.** Additive, normalize-defaulted. It rides the
  **playhead** and restarts with its timeline — unlike the bed. The clock follows the *container*, not the
  ruler the lane is drawn next to.
- **The Audio Bed panel is now a mixer**: track faders + mute/solo, the master strip, and a clip inspector
  that follows the timeline selection.
- **Scenes and cues can recall audio params, with a fade** (`audio.master.gain`, clip/track gains, spatial
  position, effect params — continuous leaves only). **An automation lane always wins over a scene fade**,
  and disabling the lane hands the param to the fade, not back to the authored value. A manual fader move
  is a **takeover** — it releases that path's fade, so the mixer never goes dead after a recall.
- **Fixed: `Collect Assets` shipped a broken project.** `mapAssetPaths` never visited `data.scenes[]` or
  `data.audio`, so a file referenced only from a scene or only from the bed was **not copied, not rewritten,
  and not even reported as missing** — Collect said "copied 12" and the venue machine played nothing.
- **Fixed: the cue picker could not add an audio param at all** (`captureEntry` bailed on the `undefined`
  that `getByPath` returns for any `audio.*` path), and `labelForPath` rendered `audio.master.gain` as
  `fix · gain`.

> ⚠ **FORWARD-COMPAT:** a project saved by this build **will not fully load on an older one.** Scene and
> audio-bed asset paths are now relativized on save (they were written absolute, baked to the authoring
> machine); an older build's `resolveAssets` does not visit them and will never make them absolute again —
> so on an older build those scenes/bed clips resolve to nothing and play silence/black. **No schema
> version distinguishes the two** — `ProjectData.version` is *written* (`'1.2'`) but **read by nothing**,
> so there is no guard and no warning: the old build just opens the file and quietly comes up short.
> Back up before downgrading. Backward-compat is unaffected: old projects load exactly as they do today
> (absolute paths still resolve) and are converted on the first save.

## v0.21.0

- **New: In-app Docs & Tutorials browser + illustrated example tutorials (`src/main/docs.ts`, `src/renderer/components/DocsBrowser.tsx`).** A **Help ▸ Docs & Tutorials** viewer — a dockable right-side panel that **detaches into its own window** — renders the shipped example/tutorial sets and the **illustrated user guide** as in-app markdown, with sibling **images loaded inline** (a main-side reader hands the sandboxed renderer image bytes over a traversal-guarded IPC, which wraps them in blob URLs) and **"open example"** links that load the `.artlux` straight into the editor. Bundled into packaged builds via `extraResources` (examples + user guide). Ships two openable **tutorial courses** — **LiDAR blob tracking** (feed → calibrate → replay, driven by a bundled synthetic emitter, no hardware) and the **state machine** (looping show → triggers → interactive installation) — each now illustrated with **self-contained SVG diagrams** (state graph, hub-and-spoke, tracking zones, merge-people). Adds new reference docs (**STATE-MACHINE, EFFECTS, CODECS, SPOUT**) and a **`plans/`** folder of implementation plans (incl. the native audio engine) with a dev-sequencing guide. `tsc` + `npm run build` clean; all 23 doc image references validated (resolve + read), docs-scan + traversal guard exercised, in-app visual test confirmed.
- **New: Unattended self-healing watchdog (`src/main/watchdog.ts`).** Keeps a broadcast/show install
  alive without a human. **Two tiers:** Tier-1 (in-app, main process) detects renderer crash
  (`render-process-gone`), GPU crash (`child-process-gone` type GPU), an unresponsive window, a **frozen
  render loop** (no `render:stats` heartbeat), and **sustained Art-Net output loss** (`fps==0` after the
  wire was live), and recovers with a **full leak-safe relaunch** into `--broadcast --project=…` (the same
  clean-process pattern the playlist scheduler uses — no media/GPU/undo leaks). Tier-2 is a **Windows
  Scheduled Task** (logon + every-minute; `scripts/{install,uninstall}-watchdog-task.ps1` +
  `watchdog-check.ps1`) that relaunches the app if the whole process is gone (hard crash / reboot). A
  **crash-loop circuit breaker** (`maxRelaunchesPerHour`, persisted across relaunches) writes a tripped
  marker and stops rather than storming — **both tiers honor it**. A new **single-instance lock**
  guarantees the two tiers never run two copies. Every detection/recovery is written to a persistent,
  **tail-on-boot** JSONL event log (`userData/artlux-watchdog.log`) surfaced in **Preferences → Unattended
  / Watchdog** and the tablet **Metrics** tab, so an overnight run is auditable. **Off by default; arms
  only in `--broadcast`** (or `unattended.always`) so it never surprises a developer in the editor. Config
  lives on `Prefs.unattended`. `tsc` + `npm run build` clean; on-hardware unattended validation pending.
  See [docs/WATCHDOG.md](docs/WATCHDOG.md).
- **New: Show Control — tablet remote + scheduler + project playlist (`plugins/show-control`).** A
  cross-process first-party plugin: an embedded **HTTP + Server-Sent-Events** server (main) serves a
  self-contained tablet **PWA** (any phone/tablet browser, zero install) with tabs for **Control**
  (scenes / cue columns / transport), **States** (drive the state machine — enable, fire manual
  transitions, jump to any state; works in **broadcast** mode where the tablet is the only UI),
  **Schedule** (in-project time-of-day triggers), **Projects** (scan a folder, build a time-of-day
  playlist), and **Metrics** (the Grafana series — output fps/pps/universes, **renderer** fps/frame-p99/
  work-p99/long-frames, and system CPU/RSS/heap/event-loop-lag — live with sparklines, no Grafana
  needed). Secured by **PIN pairing** + per-device tokens with an operator **Lock**/kick; a **QR code**
  on the operator panel (View ▸ Show Control) encodes a `?pin=` URL so scanning opens the PWA and
  **auto-pairs**. Commands reuse the existing `cueBus`/`timeline` buses via a new **`host.show`** SDK
  service (no show-model coupling, **zero project migration** for triggers); adds `ProjectData.schedule`
  and a `ctx.onRenderStats` context hook. Two scheduler layers: in-project `ScheduleEntry` (renderer
  tick — this app disables renderer timer throttling, so it runs in broadcast) and a machine-global
  **project playlist** that switches whole projects unattended by **relaunch-per-project** (a fresh
  process each switch — no media/GPU leaks over days; stateless across relaunch, loop-guarded). Transport
  is SSE (zero deps, native `EventSource` reconnect — a tablet self-heals across a broadcast relaunch);
  the PWA + QR encoder are embedded (no second build, no CDN). `tsc` + `npm run build` +
  `verify:plugins` clean; server/pairing/command/SSE/scan + a live 3-series metrics frame verified
  end-to-end against the dev app, and the QR Reed–Solomon core asserted against the QR-spec test vector.
  On-hardware validation (physical tablet + a real broadcast project switch) pending. See
  [docs/SHOW-CONTROL.md](docs/SHOW-CONTROL.md).
- **New: Augmenta optical tracking (`plugins/augmenta`).** An [Augmenta](https://augmenta.tech) box +
  camera as a *tracking source* — each tracked object streamed over **OSC v2 / Fusion** becomes a
  normalized position that maps onto a surface like a LiDAR blob, from a self-contained pre-calibrated
  sensor. Standalone **renderer-only** plugin (own store + `SourceType.AUGMENTA`) that **shares the
  host's single OSC listener** — no main-process half, no native crate, no transport changes: point the
  box at the app's OSC port and the `/au/…` messages fall through the control router to the plugin. Adds
  an Augmenta content source (GPU markers / heading / trails, the LiDAR look), a projector
  snapshot+render channel, a 3D field-and-objects scene overlay, an **Augmenta Monitor** debug modal
  (View menu) for validating the wire on hardware, and an **Augmenta Tracking** Preferences section. The
  3D viz places objects at their real-world field position directly (the box reports field size in
  metres), so there is no floor-calibration wizard. `scripts/augmenta-emitter.cjs` drives the whole
  pipeline in dev without the box; parser + emitter→`oscManager`→store verified end-to-end. The exact
  `/au/` address/arg schema is finalized on hardware via the Monitor. See [docs/AUGMENTA.md](docs/AUGMENTA.md).

## v0.20.0

- **New: per-scene timelines + per-state authoring loop.** Each **Scene** may now own its own
  **Timeline** (its own tracks/clips/playhead). Recalling a scene **warm-swaps** the playback engine to
  that timeline; scenes without one fall back to the shared global timeline (additive, **zero project
  migration**). The engine holds **pool-keyed per-layer decoders per scene** (one active at a time —
  `warmPool`/`swap`/`releasePool`) with a **clean first-frame restart** on every trigger, and a tiered
  **preloader** (`services/timelinePreloader.ts`: ACTIVE / ≤`MAX_WARM` WARM / COLD, LRU + FSM
  look-ahead) keeps swaps hitless — steady-state load stays that of a single-timeline app, and only the
  active scene holds live NDI/camera/Spout receivers (one transport at a time). The timeline **editor
  binds to the current scene** (initial-state scene on load, and follows GO/cueBus/FSM), so "just
  editing" attaches to a real scene instead of Global; `buildSceneSnapshot` is now **look-only** so
  "Update Scene" never clobbers a scene's timeline; projector windows receive the current scene's
  timeline. UX: a Timeline **scene/state pill** + author strip (Prev/Save/Next), empty-timeline CTA,
  per-state **accent** identity, state-graph build-status badges + "Edit timeline", and a Scenes/Cues
  cell **Edit** + hover-preload. Verified end-to-end via `scripts/test-scene-timelines.cjs` (CDP,
  10/10). See [docs/SCENE-TIMELINES.md](docs/SCENE-TIMELINES.md).
- **New: camera pose tracking (`plugins/mediapipe`).** A webcam + Google MediaPipe **BlazePose** as a
  *tracking source* — each detected person becomes a normalized position that maps onto a surface like
  a LiDAR blob, so body-driven interactive mapping works with no specialized sensors. Standalone
  renderer-only plugin (own store + `SourceType.MEDIAPIPE`), inference runs **in-renderer via WASM +
  WebGL GPU delegate** (no native crate). Adds a MediaPipe content source (GPU markers / skeleton /
  trails), a projector snapshot+render channel, a 3D scene overlay, a **Pose Monitor** debug modal
  (View menu), and a **Pose Tracking (MediaPipe)** Preferences section (camera / model / delegate /
  max-people / confidence). Model + WASM assets are staged offline with `npm run assets:mediapipe`;
  when absent the feature logs and no-ops (graceful degrade). See [docs/MEDIAPIPE.md](docs/MEDIAPIPE.md).
- **New: MediaPipe floor calibration + real-world position preview.** For a camera pointed at a floor, a
  **Pose Floor Calibration** wizard (View menu) relates the video feed to real space with a 4-point
  homography — drag four handles onto a known floor rectangle, enter its width × depth (metres), save.
  The 3D scene then previews each person at their mapped real-world position on the floor (foot
  ground-contact mapped through the homography), mirroring the LiDAR floor viz. Calibration persists per
  project in `Scene3D.mediapipeFloor`. Display-only for now (content stays image-space). Reuses the
  projector corner-pin math (`squareToQuad`/`applyH`); no camera-intrinsics solve — a plane needs 4
  points. See [docs/MEDIAPIPE.md](docs/MEDIAPIPE.md).

## v0.19.2

- **Fix: packaged app started with no window at all.** On some packaged builds/GPU configs the
  window's `ready-to-show` event never fired, so the editor window (created hidden) was never
  revealed — the process ran but nothing appeared on screen (looked headless; not broadcast). Dev was
  unaffected. The editor window is now revealed on `did-finish-load` (which always fires) plus a
  backstop timer, in addition to `ready-to-show`, so it can never launch with no visible window.

## v0.19.1

- **Fix: packaged app no longer launches hidden.** On machines that set `ELECTRON_RUN_AS_NODE=1` in the
  environment (common with Python/ML tooling), a double-clicked packaged ArtLux inherited it and the
  Electron binary ran as plain Node — the process started but **no window was ever created**, looking
  like a stuck headless run. The Electron **`runAsNode` fuse is now disabled** in packaging, so the
  binary ignores that variable and always starts as the real app. (Dev was unaffected.)

## v0.19.0

- **A performance pass across the render/output loop — steady framerate under load.** Groundwork for
  demanding features (e.g. sound spatialization) that need frames to never drop.
  - **Frame-time instrumentation.** A rolling-window monitor of the renderer loop — both the
    inter-frame interval (jank / dropped frames) and in-frame work time (headroom) — surfacing fps,
    p50/p99, and a dropped-frame count. Read it via an editor debug HUD (**Ctrl/Cmd+Alt+P** or
    `?perf=1`) or the new **`artlux_render_*` Prometheus gauges**, so broadcast/headless shows (no
    on-screen chrome) finally have a frame-health signal next to the native output pacer.
  - **Leaner frame loop.** Hoisted the per-LED / per-channel allocations out of universe packing,
    precomputed a controller→fixture map (was a linear scan per fixture per frame), cached the 2D
    context + reused the surface sort; broadcast/headless **skip the redundant composite** (fixtures
    sample per-surface there); Art-Net send is **throttle-first**, so frames dropped by the ~44 Hz cap
    allocate nothing.
  - **Surface atlas (multi-projector fix).** The WebGPU mapper now composes all surfaces into one
    atlas texture and does a **single upload + compute pass** instead of one per surface. Per-surface
    uploads were each stalling the main thread on the GPU process when projector output windows
    contend for it — a heavy 12,800-LED / 12-surface / 4-projector show went from **~16 fps to a
    locked 60**, scaling to 24 surfaces. Output is byte-identical to the previous mapper.

## v0.18.0

- **Plugin architecture — features become first-party plugins.** A new in-process, contribution-based
  plugin foundation: an npm-workspaces monorepo with an internal `@artlux/sdk`, host contribution
  registries, and a generic plugin IPC bridge. **LiDAR tracking** and **NDI** are the first two features
  extracted into self-contained plugins (`@artlux/plugin-lidar-tracking`, `@artlux/plugin-ndi`) — same
  behavior, cleaner boundaries — laying the groundwork for the rest of the app (next: projector
  calibration; see [docs/ROADMAP.md](docs/ROADMAP.md)).
- **State machine — a project-level "Show" graph.** An always-available finite-state graph over scenes:
  each state binds a scene (recalled on entry) and/or runs transport actions, driven on a standalone
  wall clock. Triggers cover **manual / after-delay / at-time / on-marker / on-clip-end**, with an
  **AutomataUI** node editor (per-state lock time + per-transition fade time, curved bézier edges,
  grouping regions).
- **Drop images straight onto timeline lanes** — with a thumbnail preview and one-step import into the
  project's asset library.
- **Contributor docs** — a full `CLAUDE.md` entry point (build/run, repo map, plugin conventions,
  documentation index) plus the `docs/ROADMAP.md` plugin-architecture roadmap.

## v0.17.0

- **Timeline = a full content + compositing system.** Two big additions on one shared model:
  - **Any source type as a clip.** A timeline clip can now carry a full content source — **Camera,
    Image, DMX-in, Spout, NDI, Effect, Tracking** — not just video. Right-click a lane to pick a type
    (the same source picker used by surfaces, now shared) and place a clip; a clip inspector configures
    it. Live sources are **scheduled** (a clip routes the live feed onto its layer only while the
    playhead is inside it) via a shared, refcounted receiver registry, so a feed runs when either a
    surface or a clip needs it. Overlapping Spout/NDI clips that want different senders show a conflict
    badge (single-sender, last-one-wins). Existing video/HAP clips and projects are unaffected.
  - **Layered Program output.** The timeline now **composites all of its layers** (top track in front,
    per-layer **opacity + blend mode**, with **enabled/solo/mute** finally gating the output) into one
    Program image each frame. A surface can route to the **whole Timeline (Program)** in addition to a
    single **Layer**; projector outputs stream it through the existing path. Per-layer opacity/blend
    live in a track-header popover.
- **The timeline Program on a 3D screen.** A 3D scene screen (plane or mesh) can display the whole
  composited timeline, not just one layer — via a **★ Timeline (Program)** binding (dropdown or a
  one-click **TL** toggle).
- **One unified 3D scene.** The detached "3D Scene" window is gone; the **split-view 3D pane** now
  carries the full toolset — object import/add (GLB + screen planes), per-object transform, the
  lighting/tracking controls, and Save — plus a **collapse** toggle and a **maximize-3D** button.
  Removing the second renderer process and its MessagePort bridge (per-LED pixel copies, frame
  streaming, tracking fan-out) is also a real performance win.

## v0.16.0

- **Pro calibration workspace (big RGB camera ⟷ 3D)** — the calibration camera now fills a large
  viewport in the left pane, side-by-side with the 3D scene, with **wheel-zoom, drag-pan, and a
  magnifier loupe** for sub-pixel point picking. The feed is now **true RGB** for both the OpenCV
  (DirectShow) and browser sources — previously it was reduced to grayscale before display — via a new
  native `camera_grab_rgba` colour path (the grayscale path is unchanged for detection/decode). A
  collapsible **Camera parameters** panel exposes the full set: exposure/gain/gamma/brightness/contrast
  plus white balance, focus, saturation, hue, sharpness, zoom, and resolution/fps, capability-gated per
  source.
- **Edit placed anchor points** — already-placed camera↔model correspondences are now editable. Select
  one from the camera marker, the 3D sphere, or the list; **drag or arrow-nudge** its camera point and
  **click the model** to re-place its 3D point. The pose re-solves automatically after each edit.
- **Camera-measured projector gamma + colour** — an **Auto-measure (camera)** button per output projects
  a grayscale level ramp, samples the camera RGB in the projector's lit footprint, fits the per-channel
  response, and writes the output's **gamma** + **colour gain** (white-point match). Applied through the
  existing GLSL/NVAPI uniforms.
- **Auto-Align: anchor markers** — each placed camera↔model correspondence now shows a numbered marker
  in **both** views: a cyan crosshair + number on the camera preview (with a dashed orange ring for the
  pending point awaiting its model match) and a matching numbered marker in the 3D scene. Same colour +
  number on both sides so pairs are easy to verify; the 3D markers appear as you place them (no longer
  only after a full solve) and aren't hidden behind the model.
- **3D models: independent per-axis scale + numeric transform** — models can now be scaled
  **non-uniformly** (X/Y/Z independent), via the gizmo's per-axis handles or exact numeric entry. The
  main editor's 3D view gained a **transform inspector** (Position / Rotation / per-axis Scale) for the
  selected model, and the Scene window's Scale field is now per-axis. Numeric fields are buffered (type
  decimals/values freely, commit on Enter or blur). Data model: `SceneModel.scaleXYZ` supersedes the
  uniform `scale` when set; existing projects keep their uniform scale until edited.

## v0.15.0

- **Markerless camera auto-align (projection mapping)** — a new **Auto-Align wizard** (Outputs →
  Calibrate → *Board → Auto-Align*) calibrates a projector against the loaded venue 3D model **without a
  checkerboard**: anchor a few camera↔model points, scan Gray-code, optionally **self-calibrate the
  camera lens from the scan**, raycast the venue mesh, and resection the projector. A **residual
  heatmap** flags model/scale mismatches. The scene then renders from the recovered viewpoint (true
  projection mapping). See [docs/AUTO-ALIGN.md](docs/AUTO-ALIGN.md).
- **Hardware warp + edge-blend via NVIDIA NVAPI** — on **Quadro / RTX-pro** GPUs, ArtLux can apply each
  projector's geometry **warp** and **edge blend** at the GPU **scanout** (content-agnostic, persistent)
  instead of in GLSL. New native addon `native/nvwarp` (Rust/napi over an NVAPI C++ shim), per-output
  **Hardware warp/blend** toggle, and a panic **Ctrl/Cmd+Shift+W clear-all** + clear-on-quit so a warp is
  never left stuck. Built and validated on an **RTX 6000 Ada**; GLSL is the automatic fallback on every
  other GPU. See [docs/NVWARP.md](docs/NVWARP.md).
- **World-space multi-projector blend** — `blendCompute` computes a per-projector alpha map on the actual
  3D surface (partition of unity → seamless overlaps), feeding both the NVAPI intensity map and GLSL blend.
- **MPCDI export/import** — projector calibration round-trips through the **MPCDI** interchange format.
- **Calibration: black-camera hint** — if a camera opens but delivers all-black frames (almost always
  another app — Teams, the NDI Webcam tool, OBS — holding the device, or a USB hiccup), the wizard now
  says so ("Camera opened but the image is black…") with a close-it / replug / Restart prompt, instead
  of a silent black preview.

## v0.14.7

- **Projector calibration: PS3 Eye / OpenCV camera support** — the calibration wizard's Camera step
  now has a **Capture via** toggle: **Browser** (any `getUserMedia` webcam, as before) or **OpenCV
  (DShow)** for cameras the browser can't drive. The **PlayStation 3 Eye** and similar non-UVC
  cameras deliver frames to OpenCV's DirectShow backend but throw `NotReadableError` in Chromium's
  `getUserMedia`; ArtLux now captures those natively in the calibration addon (`VideoCapture` +
  `CAP_DSHOW`, MJPG 1280×720) and streams the frames into the same board-detect / structured-light
  pipeline — bypassing the browser entirely. OpenCV addresses DirectShow devices by **index**, so the
  wizard shows a **Device index** picker (try 0–5) instead of a name list, with the live board-detect
  overlay on a native preview. See [docs/CALIBRATION.md](docs/CALIBRATION.md) for PS3 Eye driver setup.
- **Camera start more robust** — the browser camera path now progressively relaxes the requested
  resolution (720p → 480p → any) so a limited camera that can't start at 720p is no longer misreported
  as "busy".

## v0.14.6

- **Tracking: robust person tracking** — the venue LiDAR feed flickers heavily (per-blob ids change
  ~8×/second), so the simple merge re-assigned person ids constantly. The merge now runs a small
  **predictive multi-object tracker** (velocity prediction + association gate + hit-confirmation to
  reject flicker + coasting through dropouts), giving each person a **stable id and steadier motion**.
  Validated against an on-site 3–4-person recording: distinct person-ids over 34 s dropped from ~152
  to ~23, with the count holding at 3–4 (median id now lives ~3.6 s, up to ~20 s). Default merge
  radius raised to 0.8 m. Off by default.

## v0.14.5

- **Tracking: merge blobs into people** — the venue LiDAR emits ~2 blobs per person on the floor
  (each with its own id). A new **"Merge people (2 blobs → 1)"** toggle (+ **Merge radius** slider) in
  the 3D Scene tracking controls clusters a surface's blobs within the radius into one centroid
  "person", feeding the 3D viz and projector outputs (raw OSC feed + recorded takes untouched).
  People get **temporally stable ids** (matched frame-to-frame by proximity, surviving the underlying
  blobs dropping/reacquiring). Off by default. See [docs/TRACKING_SYNC.md](docs/TRACKING_SYNC.md).

## v0.14.4

- **Custom single-line title bar** — the editor window is now frameless with its own VS Code-style
  top strip: the ArtLux logo, the `File/Edit/View/Window/Help` menus (app-styled dropdowns; all
  keyboard shortcuts unchanged), the toolbar action icons (3D Scene · Outputs · Routing · DMX
  Monitor · Preferences · Help), and the window min/maximize/close controls — all on one row. The
  separate toolbar row and the center play/pause button were removed (playback lives in the timeline
  panel + Space); the toolbar buttons are now icon-only with 3D Scene grouped on the right.
- **Dockable bilingual Help panel (EN/FR)** — a resizable right-side help panel (open with **F1**,
  the **?** toolbar button, or **Help ▸ Help Panel**). It shows contextual help for whatever control
  you hover/focus and a browsable set of topic guides (Getting Started, Surfaces, Outputs, OSC/LiDAR
  Tracking, Timeline, Shortcuts). An **EN/FR** toggle switches all help text and is remembered across
  sessions. Hover hints are now bilingual; the rest of the UI stays English.

## v0.14.3

- **Dark menu bar** — the native Windows menu bar (File/Edit/View/Window/Help) now renders dark
  instead of following the system light theme. Forced via `nativeTheme.themeSource = 'dark'` at
  startup.

## v0.14.2

- **OSC Monitor (sniffer)** — **View ▸ OSC Monitor** (`Ctrl+Shift+M`) opens a live view of the raw
  incoming OSC stream for testing the LiDAR feed: a receiving/listening status dot with live msg/s,
  per-surface blob cards (`active/total` + zone size, green when active), and an address table with
  per-address rate (Hz), count and last value, plus filter, pause, clear and a raw-message log. It
  taps the stream directly, so it shows the raw wire — including live blobs during take replay — and
  adds no load when closed. Ships `scripts/lidar-emitter.cjs` to drive it with synthetic blobs when
  no tracker is present. See [docs/OSC.md](docs/OSC.md).

## v0.14.1

- **Fix (tracking takes):** replayed takes now show on **fullscreen projector** and **3D Scene**
  outputs, not just the main canvas. The blob bridge's stale-frame filter was dropping a recorded
  take's original timestamps; applied snapshots are now stamped fresh so they survive the bridge.

## v0.14.0

**Record & replay LiDAR takes, and a managed media library.**

- **LiDAR take recording & replay** — capture the live LiDAR blob feed into reusable *takes* and
  place them on a dedicated **tracking lane** of the timeline, so a show can be simulated and
  rehearsed with no tracker present. Record from the timeline's Takes bin (independent of the
  transport), drop a take on the tracking lane, then play or scrub to replay the recorded blobs
  into the 3D Scene and projector outputs. While a take plays it drives the blobs and the live OSC
  feed is suppressed (global simulation override); past the clip the live tracker resumes. Takes are
  stored as compact `.lblob` sidecars.
- **Asset library + Asset Manager** — a new **Media** tab in the left sidebar manages all project
  media — video, image, 3D model, and take — in one place: import (files are copied into the
  project's `assets/` folder), thumbnails/previews, search + type filters, and *used / unused /
  missing* badges. Drag a tile onto a Stage surface or a timeline lane to place it. A full-screen
  **Asset Manager** adds per-asset usage (jump to where it's used), relink, reveal-in-folder,
  remove, and one-click **Consolidate**. **New Project** now always creates a project folder
  (prompts for a location and saves immediately), so imported and recorded media always has a home.
- **Monitoring (Prometheus + Grafana)** — ArtLux now exposes a Prometheus metrics endpoint from the
  main process at `http://127.0.0.1:9464/metrics` (output FPS/packets/universes/up, plus CPU, memory and
  event-loop lag). Pull-based and near-zero cost on the show machine: nothing is pushed and the page is
  only generated when scraped. Loopback-only by default; `ARTLUX_METRICS=0` disables it,
  `ARTLUX_METRICS_HOST`/`ARTLUX_METRICS_PORT` move it. Ships a ready local stack in `monitoring/`
  (Docker Compose with an auto-provisioned Grafana dashboard) and a guide in `docs/MONITORING.md`.

## v0.12.0

**Pro timeline — infinite, navigable, programmable.** The video-layer timeline becomes a full-screen
editing surface with a control layer. Clip editing stays UX-only; per-LED compositing is unchanged.

- **Infinite timeline** — the playhead now advances unbounded: place clips end-to-end to build long
  sequences and play right past the old fixed length. Where no clip sits under the playhead the output
  is black. Looping is now opt-in: toggle **Loop** (Shift+L) to wrap over the in/out region.
- **Mouse zoom & pan** — the mouse wheel zooms toward the cursor, **Shift+wheel** scrolls horizontally,
  and **middle-button drag** pans the timeline in any direction. The view grows as you explore.
- **Maximize** — drag the timeline dock's top edge to resize it, or press **F** (or the maximize
  button) to expand the timeline to fill the whole window; press again to restore.
- **State-machine control layer** — an always-present, optional logic layer that can drive the
  transport (play / pause / stop / seek / loop / jump-to-marker). Build a graph of states and
  transitions in the **Edit logic** editor; transitions fire manually (buttons on the state lane) or
  automatically after a delay, at a time, on a marker, or when a clip ends. Disabled by default; turn
  it off any time to return to manual control.

> No native rebuild required. Old projects load unchanged (new fields default in). Note: projects that
> previously looped at their set length now play unbounded unless you enable Loop.

## v0.11.0

**DaVinci-style timeline** — the video-layer timeline is reworked into a proper NLE editing surface.
Editing UX only; playback and per-LED compositing are unchanged.

- **Filmstrip thumbnails** — clips now show video-frame thumbnails along their length. Frames are
  decoded asynchronously into an LRU cache (a dedicated offscreen path for normal video, and a
  one-shot HAP decode on its own GPU context) so the strip never disturbs live playback.
- **Pro track headers** — per-track mute / solo / lock / show-hide, a color label, drag-to-reorder,
  and drag-to-resize track height. Lock blocks edits and drops on that lane. (Mute/solo/hide are
  visual aids — the output engine still shows the topmost clip per track.)
- **Blade, snapping & ripple** — a Blade tool splits clips at the cursor or playhead; magnetic
  snapping aligns drags to clip edges, the playhead, markers and the in/out range with a live guide;
  ripple-delete closes the gap left behind.
- **Frame-accurate timecode, markers & in/out** — an `HH:MM:SS:FF` ruler and readout at a settable
  project frame rate, colored timeline markers (add / seek / delete / note), and an in/out range band.
- **Keyboard shortcuts** — Space play/pause, L/K/J, B blade, V select, S/N snapping, M marker,
  I/O in/out, C blade-at-playhead, Delete ripple-delete, +/- zoom, Home/End — scoped to the timeline
  panel and suppressed while typing.

> No native rebuild required. Old projects load unchanged (new fields default in).

## v0.10.0

**Smoother HAP playback** — the HAP player is reworked for glitch-free, display-synced playback,
tuned for high-refresh output on high-end GPUs.

- **Vsync-locked cadence** — playback time is now derived from a single drift-free monotonic clock
  (instead of accumulating per-frame deltas) and the source frame is chosen by nearest-sample. On a
  display whose refresh is a multiple of the clip's rate (e.g. 30 fps on 120 Hz) each frame is held
  for an even beat, which removes the judder that came from uneven frame repeats.
- **No periodic hitch** — fullscreen projector outputs phase-lock their clock to the transport with a
  gentle continuous correction instead of a hard periodic resync, so the recurring stutter is gone.
- **Decode-ahead ring** — the decoder now keeps a short rolling buffer of upcoming frames decoded
  ahead of the playhead (and pre-warms the loop point), so the exact frame is ready in time instead
  of showing a stale/repeated one when decode briefly falls behind under load.
- **In-place GPU upload** — decoded blocks update the existing GPU texture in place rather than
  reallocating it every frame, removing per-frame allocation churn the driver could hitch on.

> Playback only — Art-Net output and per-LED sampling are unchanged. No native rebuild required.

## v0.9.0

**HAP video** — GPU-decompressed HAP playback. HAP-coded `.mov` clips now play natively: decoded
once in the main process (CPU/SIMD — no hardware video-decode session) and decompressed on the GPU,
so they run smoothly on timeline layers and video surfaces without the browser's H.264 decode limits.

- **HAP decoder** — new native addon (`native/hap`) parses the MOV container and the Snappy/chunked
  HAP sections; supports Hap (DXT1), Hap Alpha (DXT5), Hap Q (scaled YCoCg) and Hap 7 (BC7).
- **GPU decompression** — the renderer uploads the compressed DXT/BC blocks as an `s3tc` compressed
  texture (~8× less data over IPC than RGBA) and the GPU does the decompression.
- **Frame-accurate** — HAP is all-intra, so scrubbing decodes the exact frame; a small prefetch ring
  keeps playback smooth.
- **Drop-in** — assign a HAP `.mov` to a Video surface or drop it on a timeline layer; non-HAP `.mov`
  falls back to the browser `<video>`.
- **Broadcast** — fullscreen projector outputs decode HAP locally at full speed, so playback stays
  smooth even though the editor window is hidden.

Supporting changes: video sources are now decoded once in the main window and streamed to the
Scene/projector windows (avoids exhausting the GPU's concurrent hardware-decode sessions); a
broadcast-mode startup crash (eager auto-updater init) and a View-menu / DevTools crash are fixed.

## v0.8.0

Full-HD output in **Broadcast mode**. The low-res caps that keep the editor light now lift to
**1080p** when the app runs in `--broadcast` (show) mode, so projector outputs and NDI streams
carry full-HD quality; the editor keeps the lighter caps for responsive preview.

- **NDI send** — published projector outputs go out at up to **1080p** in Broadcast mode (≤720p in
  the editor).
- **NDI input** — received NDI sources are kept at up to **1080p** in Broadcast mode (≤720p in the
  editor), so they stay sharp on the projector and over NDI send.
- **Spout input** — received Spout sources are kept at up to **1080p** (aspect-preserving) in
  Broadcast mode (512² in the editor).

> The per-LED sampling resolution is unchanged — Art-Net output is identical; this only affects the
> projector display and NDI image quality. Lifting the NDI/Spout input caps requires the rebuilt
> native addons.

## v0.7.0

NDI® (network video) — the cross-platform counterpart to Spout.

- **NDI source** — receive an NDI stream as a Surface's content: pick **NDI** in the Inspector's
  Content section, choose a source, and it drives the surface (and the fixtures sampling it).
- **NDI send** — publish each **projector output** (the final corner-pin / Bézier-warped result) as
  its own NDI source (**“ArtLux — <surface>”**), so media servers / recorders / other software can
  receive the mapped output over the network. Toggle **Send as NDI** per output in the Outputs gear.
- Requires the free **NDI Runtime / NDI Tools** (<https://ndi.video>); ArtLux degrades gracefully and
  shows an install hint when it isn't present. NDI® is a registered trademark of Vizrt NDI AB.

> Note: NDI is **Windows-first**. Building the native NDI addon requires the NDI 6 SDK (`npm run
> build:ndi`); without it the app builds with NDI inactive.

## v0.6.1

- **Consistent quit**: **Ctrl/Cmd+Shift+Q** now quits from both the editor and broadcast mode —
  including when a frameless fullscreen projector window is focused (where the app menu can't be
  reached). The editor's File ▸ Quit shows the shortcut. Quitting always closes every projector
  window cleanly.
- Fixed **Launch in Broadcast Mode** when running unpacked/from source (the relaunch dropped the app
  path and opened Electron's default window). Packaged builds were unaffected.

## v0.6.0

Projection mapping — send each surface to a real projector — plus a broadcast (show) mode.

### Projector outputs
- **Send any surface to a physical display** as its own **fullscreen output** (projector). Open the
  **Outputs** panel (top bar), enable a surface, and pick a connected display — the output opens
  frameless-fullscreen on it while the editor keeps focus. Outputs are saved with the project and
  re-bind to a display by label across replug/reboot.
- **Corner-pin** alignment: click **Align** to drag the four corners onto the real projection surface
  directly on the projector (arrow-keys nudge, Shift ×10, **R** reset, **Esc** done), with a
  perspective-correct calibration grid.
- **Bézier warp**: enable per output for curved/irregular surfaces — a bicubic patch with 16 draggable
  control points (corners + curve handles) and a live curved calibration grid.
- **Soft-edge blend** (per-edge feather + blend gamma) for overlapping projectors, and a **per-screen
  gamma** control.
- **Anti-aliasing** (MSAA) on the warped output, and a **Performance mode** that caps projector output
  frame-rate (Off / 60 / 30 / 24).
- Outputs render content at native resolution; live camera / Spout / DMX-in sources are streamed to
  their output as well.

### Broadcast (show) mode
- Launch with **`--broadcast [--project=path]`** to run with **no editor interface** — only the
  fullscreen projector outputs and the Art-Net sender, from a saved project (falls back to the
  last-opened one). Controlled from a **system-tray icon** (Quit) and a global **Ctrl/Cmd+Shift+Q**
  hotkey.
- Or use **File → Launch in Broadcast Mode** in the editor to save the current project and relaunch
  straight into the show.

## v0.5.0

### Portable projects (project folders + Collect Assets)
- A project can now be a **folder** (`project.artlux` + `assets/{video,models,images}/`) instead of a
  lone file, so it's self-contained and shareable.
- New File menu items: **New Project Folder…** (Ctrl/Cmd+Shift+N), **Open Project Folder…**
  (Ctrl/Cmd+Shift+O), and **Collect Assets…**.
- **Collect Assets** copies every referenced video, 3D model, and image into the project's `assets/`
  tree (de-duped by name + size) and rewrites references to the local copies; a summary reports copied
  / skipped / missing counts. Asset paths inside a project folder are stored **relative to the folder**,
  so moving or copying the whole folder keeps every asset linked.
- **Surface videos/images now persist**: they're stored by file path instead of a temporary in-memory
  reference, so they survive reloads and are collected with everything else. (Previously surface
  video/image content was lost on reload.)
- Single `.artlux` files still open; run **Collect Assets** on one to migrate it into a folder. Project
  format bumped to `1.1`.
- Note: `.glb` collects cleanly; a `.gltf` referencing external `.bin`/textures won't have those
  companions collected — prefer GLB for portability.

### Fixed
- **CI release publishing**: the duplicate `builder-debug.yml` emitted per OS runner collided on a single
  asset name and failed the GitHub Release step (red CI since v0.4.1). It's now excluded from the release
  upload, so tagged releases publish cleanly.

## v0.4.1

- **Check for updates in About**: the About dialog now has a **Check for updates** button with inline
  status (checking / up-to-date / download / restart & install), so the updater is discoverable without
  the Help menu. (Auto-update still also runs on launch + Help → Check for Updates.)

## v0.4.0

A dedicated 3D Scene window and a video-layer timeline.

### 3D Scene window
- The **3D** view is now its own window (open from the top-bar **Scene** button) — put it on a second
  monitor while you map in the main window. It mirrors the live fixtures + LED colors over a fast
  renderer-to-renderer bridge.
- **Load GLB/glTF venue models** (multiple), each selectable in an **outliner** and transformable
  (**move / rotate / scale** gizmo, pivot at the mesh centre). Identical meshes are instanced; **Auto-fit**
  scales a model to a real-world size; per-object scale/position/rotation.
- **Real-time venue lighting**: each fixture casts a light coloured by its live LED output; plus
  environment ambient, exposure, a configurable grid, and an optional **reflective floor**.
- **Save** from the Scene window persists the scene into the project.

### Video-layer timeline
- A new **Timeline** dock tab: an NLE with **tracks** and **clips** — **drag-and-drop MP4s** onto a track,
  move/trim clips, scrub the playhead. The top-bar **Play** is the unified transport.
- Assign a **track (layer) to a surface** (Inspector → Content → **Layer**) so the surface (and the
  fixtures sampling it) show that track's video.
- Add **screen planes** in the 3D Scene and assign a **layer** to simulate a projection — the plane plays
  the track's video in sync with the main window.
- The timeline (tracks + clips), surface layer bindings, and plane assignments are saved with the project.

### UI / fixes
- **Slimmer top bar**: removed the logo/wordmark, undo/redo, save/open, and the Media/Map/Fixtures module
  buttons (those still live in the File/Edit menu + shortcuts). Added the **Scene** button.
- **No background throttling**: the engine, timeline, and DMX output keep running full-speed when the
  other window has focus (fixes video flicker / stutter while working in the Scene window).

## v0.3.1

- **Auto-update** (Windows / Linux): the app checks GitHub Releases on launch and from
  **Help → Check for Updates…**, then shows an in-app prompt. Nothing downloads or installs without
  your consent — you click **Download**, then **Restart & Install**. macOS shows a prompt linking to the
  Releases page instead (Squirrel.Mac needs a Developer ID signature, which these builds don't have).
  Note: auto-update works between releases that both ship the update metadata, so it takes effect for
  upgrades **from v0.3.1 onward** (install v0.3.1 manually once).

## v0.3.0

Workspace rework, content-aware surfaces, and an Art-Net output fix.

### Workspace UI
- **Three-region layout**: left outliners + sliders, center stage + dock, **right Inspector/properties**
  panel (toggle from the status bar). Left-panel sections are **independently collapsible**, and
  **Surfaces / Fixtures grow** to fill the panel.
- **Dock fixture workspace**: the Fixture Editor tab now also holds fixture **Create** (add / auto-patch)
  and the **Library**, and the dock opens there by default.
- **Multi-select fixtures** for grouping — click / ctrl·cmd-toggle / shift-range in the outliner and on
  the stage; "Master Layer" or **Ctrl·Cmd+A** selects all. Group create / add-to-group act on the whole
  selection.
- **Smooth sliders**: dragging commits React state only on release; master brightness drives a
  render-free live preview, so sliders no longer stutter.

### Canvas & surfaces
- **Square (1:1) UV canvas** with a **mid-grey backdrop** and a **configurable layout grid**
  (toggle + divisions); surfaces and fixtures **snap to the grid** when snapping is on.
- **Surfaces keep their content's aspect ratio** — a surface fits its media's aspect on load, and the
  corner handle **scales uniformly** (no distortion). Move / scale / rotate every surface in the square.
- **Move surfaces by mouse**: fixed a layering bug where the fixtures layer swallowed all clicks.

### Fixes
- **Camera / live input**: the main process now grants the `media` permission, so Camera surfaces work
  (`getUserMedia` was silently denied).
- **Art-Net dropped-packets warning**: the sequence number is now **per universe** (was a single global
  counter, which monitors read as missing packets) — in both the native engine and the TS fallback.
- **Preview fidelity**: surface preview renders at full opacity; the DMX Monitor folds the RGBW white
  channel back into RGB so whites display. (Output was always correct — these were preview-only.)

## v0.2.1

- **macOS dmg fix**: the app is now **ad-hoc signed** during packaging (`afterPack` hook), so it runs
  on Apple Silicon instead of failing with *"ArtLux is damaged and can't be opened."* It is still not
  notarized (no Apple Developer account), so first launch needs a one-time Gatekeeper bypass:
  **right-click → Open → "Open Anyway"**, or `xattr -dr com.apple.quarantine "/Applications/ArtLux.app"`.
  (Builds are arm64 / Apple Silicon.)

## v0.2.0

The **Surfaces** release — a MadMapper-class content/mapping/routing model, plus app polish.

### Surfaces engine
- **Surfaces** as content carriers: each surface (cyan on stage) holds its own content — video,
  image, camera, Spout, DMX-in, or a 2D **shader effect** (Solid / Rainbow / Palette Flow / Wave /
  Fire). Create/select/transform from the browser or on-canvas (move/resize/rotate).
- **Strict per-surface sampling**: each fixture is **linked to one surface** and samples only it,
  regardless of overlap (WebGPU per-surface compute dispatch; WebGL fallback = composite).
- **Fixture library**: save a fixture as a reusable template (LED definition), stored across projects.
- **Controllers + automatic patch**: define physical output devices; universes/addresses are packed
  automatically per controller (lock a fixture to patch it manually).
- **Routing spreadsheet**: manage controllers and patch every fixture in one grid
  (TopBar network icon or File → Routing).

### Features
- Persistence: native Save/Open (`.artlux`), auto-restore on launch, recent files, `.artrig` rig
  export/import.
- Art-Net **device discovery** (ArtPoll) and **ArtSync** synchronous output.
- **Headless mode** (`--headless --project=…`) — run the GPU compute + output with no UI.
- **Spout** receiver (Windows) as a content source.

### App
- Teal "A" app icon, native File/Edit/View/Window/Help menu, About dialog, fixed play/pause,
  source-aspect stage.

### Engine (since 0.1.0 baseline)
- Native Rust (napi-rs) Art-Net + sACN output engine, WebGPU compute mapper, 2D matrix/ledmap/
  color-order/RGBW/gamma, 3D simulator, groups & scenes.

## v0.1.0
- Initial release: Electron + WebGPU pixel mapper + native Art-Net/sACN output; Windows/macOS/Linux
  installers via CI.
