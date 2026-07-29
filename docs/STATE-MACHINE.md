# State machine — the project-level "Show" graph

The **state machine** (a.k.a. the *Show machine* / FSM) is an optional, always-available **finite-state
graph over your Scenes**. Each **state** binds a Scene (recalled on entry) and/or runs transport
actions; **transitions** move between states when a **trigger** fires (a delay elapses, the playhead
crosses a time/marker, a clip ends, the timeline reaches its end, or you fire it by hand/OSC). It turns
a pile of looks into a **show that runs itself** — a timed sequence, an unattended attract loop, or a
live-triggered installation.

It is modelled on **AutomataUI** (nodes = looks, edges = transitions, a "lock time" dwell and a
"transition time" crossfade, resizable "region" group-boxes), adapted so **a node *is* a Scene**.

> **New here? Do the tutorial first.** [`examples/state-machine/tuto/`](../examples/state-machine/tuto/README.md)
> is a hands-on, three-project walkthrough; [`examples/state-machine/`](../examples/state-machine/) ships the
> matching `.artlux` files you can open and watch. This doc is the **reference** behind that tutorial.

> **Read alongside:** [SCENES.md](SCENES.md) (what a Scene captures + the `recallScene`/`fireCue`
> actions), [SCENE-TIMELINES.md](SCENE-TIMELINES.md) (each state can own its own timeline),
> [TIMELINE.md](TIMELINE.md) (the NLE + the original control-layer notes), and [OSC.md](OSC.md)
> (remote triggering).

---

## Mental model in one breath

- A **state** is a node. It usually **binds one Scene** (`sceneId`) — entering the state **recalls
  that Scene** (the whole look: surfaces, fixtures, brightness, groups, 3D, projector outputs, and —
  if the Scene owns one — its timeline). *A node is a look.*
- A **transition** is a directed edge with a **trigger** — and optionally a **guard** (`requireEnd`:
  *not until this state's picture has finished* — see **hold at end**). While the machine is `enabled`, the runtime
  watches the **current state's outgoing** transitions and, when one fires, **enters** the target
  state (recall + entry actions + optional crossfade).
- Entering a state can also run **entry actions** (play / pause / stop / seek / loop / jump-to-marker /
  recall another scene / fire a cue) so the state controls the **transport**, not just the look.
- The machine lives at **project scope** and is driven **once per frame** by the engine — even while
  the transport is **stopped** (so a delay-driven show loops without pressing Play).

```
        afterDelay 6s              afterDelay 6s
   ┌──────────────────┐      ┌──────────────────┐
 ( Calm ) ───────────▶ ( Rise ) ───────────▶ ( Burn )
   ▲  binds sc_calm        binds sc_rise         │  binds sc_burn
   └───────────────────────────────────────────┘
                    afterDelay 8s
```

---

<!-- audience:contributor -->

## Data model (`src/renderer/types.ts`)

The whole machine is plain, persisted data on `ProjectData.stateMachine` — **zero migration** (it is
just JSON). Open a `.artlux` file in a text editor and you will see exactly these shapes.

```ts
StateMachine {
  enabled: boolean;              // master on/off — off = manual control only
  states: SmState[];
  transitions: SmTransition[];
  initialStateId: string | null; // entered on enable / when the current state vanishes
  regions?: SmRegion[];          // visual group-boxes (the "big OR")
}

SmState {
  id: string;
  name: string;
  x: number; y: number;          // node position in the graph editor
  entry: SmAction[];             // actions run when this state is entered
  sceneId?: string;              // Scene recalled on entry (the 1:1 look binding)
  lockSec?: number;              // "lock time": dwell before this state's afterDelay transitions fire
  regionId?: string;             // owning region (visual only)
}

SmTransition {
  id: string;
  from: string; to: string;      // SmState.id → SmState.id
  trigger: SmTrigger;
  fromAny?: boolean;             // a GLOBAL RULE — evaluated from every state (see below); `from` unused
  requireEnd?: boolean;          // GUARD: only once the source state's timeline is HELD (see below)
  fadeSec?: number;              // "transition time": scene crossfade applied on arrival at `to`
  c1?, c2?: {x,y};               // bezier control handles (curved edge — cosmetic)
}

SmTrigger { kind: 'manual'|'afterDelay'|'atTime'|'onMarker'|'onClipEnd'|'onTimelineEnd'|'plugin';
            seconds?, time?, markerId?, layerId?,
            source?, params? }      // 'plugin' — a plugin-owned condition (e.g. 'lidar.zone')

SmAction  { kind: 'play'|'pause'|'stop'|'seek'|'setLoop'|'jumpMarker'|'recallScene'|'fireCue';
            seekTo?, loopOn?, markerId?, sceneId?, cueId? }

SmRegion  { id, name, x, y, w, h, color? }   // resizable box that moves its member states
```

`defaultStateMachine()` is `{ enabled:false, states:[], transitions:[], initialStateId:null, regions:[] }`.
`normalizeStateMachine()` fills missing fields on load, so old/partial saves open cleanly.

---

<!-- audience:operator -->

## Triggers — when a transition fires

A transition fires when its trigger's condition becomes true *for the current state's outgoing edges*.
The runtime evaluates them in array order and fires **at most one per frame** (no cascades).

| Kind | Fires when… | Params | Clock |
|---|---|---|---|
| `manual` | you fire it — state-lane button, **Ctrl/Cmd+click the edge**, or **OSC** | — | — |
| `afterDelay` | `seconds` have elapsed since the state was entered | `seconds` | **wall clock** — advances even while the transport is **stopped** |
| `atTime` | the **playhead** crosses absolute `time` | `time` (s) | **playhead** — only while playing |
| `onMarker` | the **playhead** crosses timeline marker `markerId` | `markerId` | **playhead** |
| `onClipEnd` | the active clip on track `layerId` **ends** (a gap appears under the playhead) | `layerId` | **playhead** — **does not fire** for a clip that runs to the end of the timeline: the non-looping end-stop parks the playhead *inside* that clip (no gap ever opens), so a final, full-length clip never fires this. Use `onTimelineEnd` for "the show finished". |
| `onTimelineEnd` | the bound timeline reaches its **end** while playing and **not looping** | — | **playhead** — a loop wrap is **not** an end and does not fire it |
| `plugin` | a **plugin-owned** condition fires — today: a person enters/leaves a **LiDAR trigger zone**, a crowd threshold, a dwell ([TRACKING_SYNC.md](TRACKING_SYNC.md#trigger-zones--making-the-show-react-to-the-room)) | `source`, `params` | **the world** — evaluated every frame, transport or no transport |

### The dual-clock rule (the #1 gotcha)

There are **two clocks**, and which one a trigger uses decides whether you must press **Play**:

- **`afterDelay` runs off a standalone wall clock** (`ctx.nowSec`). It ticks **regardless of the
  transport** — so a delay-only graph loops the instant you open the project, no Play needed. This is
  why [template 1](../examples/state-machine/01-hello-state-machine.artlux) auto-runs.
- **`atTime` / `onMarker` / `onClipEnd` / `onTimelineEnd` follow the timeline playhead.** They only
  advance while the transport is **playing**, so a graph that uses them needs something to start
  playback — usually a `play` **entry action** on an upstream state (see [template 2](../examples/state-machine/02-triggers-and-actions.artlux)).
  One `play` on the state that starts the show is **enough**: see the auto-advance rule below.
  `onTimelineEnd` is the odd one out among these four: `atTime`/`onMarker`/`onClipEnd` are **crossing**
  tests over the `prev → current` playhead window, while a clean stop at the end crosses nothing — the
  engine hands `onTimelineEnd` a one-frame edge instead (`ctx.atEnd`), latched so it fires exactly once
  per end-stop.

### `onTimelineEnd` and the transport (auto-advance)

Reaching the end of a non-looping timeline normally **pauses** the transport. When an `onTimelineEnd`
transition fires on that same frame, it does not: the engine holds the pause back until the machine has
had its turn, and **cancels it if entering the destination state put the clock back in motion** — which
a state with a **bound scene** always does (the recall restarts its timeline at frame 0), and which a
scene-less state does if it carries a `play` **entry action**. So:

- **A → (onTimelineEnd) → B, both bound to scenes:** B's timeline simply plays on. The transport never
  stops, the timecode keeps running, and B's own `onTimelineEnd` fires in turn. **You do not need a
  `play` entry action on B** — a chain of scene-bound states auto-advances unattended off the single
  `play` that started it.
- **A → (onTimelineEnd) → C, where C has no bound scene:** give C a `play` entry action if you want the
  show to keep running; without one the transport pauses on A's last frame (which is the honest report:
  nothing restarted the clock). C's `play` re-seeks to the timeline's in-point and continues.
- **Loop ON never fires it.** A wrap is not an end. A state whose scene loops will sit there until some
  *other* trigger (`afterDelay`, `manual`, `atTime`, OSC) moves the machine on.

Playhead crossings use a `prev → current` window that survives loop/seek wraps; a deliberate `seek`
re-anchors `prev` so one jump doesn't fire every intermediate trigger along the way.

---

## The state that ends and waits — **hold at end** + `requireEnd`

A state normally ends by being *left*. An interactive show needs the other shape: **play the look to a
chosen point, freeze there, and wait for someone to walk in.** Two pieces do that, and they are
deliberately separate — one is a property of the *picture*, the other of the *edge*.

**1. `Timeline.holdAtEnd` — where the state ends.** Set the timeline's **out-point** where the state
should finish (the ruler handle, **O**, or the toolbar's **End state here**, which does both in one
click) and turn on **Hold at end** (the snowflake, next to Loop). The playhead then parks on that last
frame and **stays there with the transport still running**:

- the picture holds on the projectors and the LED output (it is the same park a stopped timeline does);
- the **audio bed and the global automation play straight through** — this is the entire difference
  from the plain end-stop, which emits `pause`, and `playing: false` freezes the show clock too. A
  room waiting for a visitor stays alive instead of going silent;
- the state machine is told: `SmContext.held` goes true and stays true for the whole hold.

**Loop wins** — a looping timeline never reaches an end, so `holdAtEnd` is ignored while Loop is on
(the toggle greys out and says why). `onTimelineEnd` still fires exactly once on the hold frame, so a
held state that *has* such an edge auto-advances as before.

**2. `SmTransition.requireEnd` — "only after the state has finished".** Tick **Only after the state has
finished** in the transition inspector and that edge cannot fire until its source state is held. It is
a **guard, not a trigger**: the trigger still has to fire, this only decides whether it may.

Without it, a live trigger cuts the picture: a visitor entering a zone three seconds into a twenty-second
film jumps the show. The guard binds the **automatic** path — a zone rule, an `afterDelay`, any trigger
that fires without a human — because that is the cut nobody chose.

**It does not bind a human.** A **manual** button (the state lane, Ctrl+click on an edge), OSC, and the
show-control tablet all fire regardless: an operator reaching for GO during a show has a reason the
machine cannot see, and a control that silently refuses reads as broken. So an early manual trigger is
**flagged, not blocked** — the state-lane button shows a dashed ⏱ border while the state is still
running — and the decision stays theirs. `requestEnter` (double-click a node, the tablet's state list)
remains the bypass that skips the graph entirely.

```
   ┌──────────── Attract ────────────┐        ┌──────────── Reaction ───────────┐
   │  timeline: 0 ──▶ out-point      │        │                                 │
   │  hold at end ▪ frozen last frame│──⏱ ▶──▶│  plays from its first frame     │
   └─────────────────────────────────┘        └─────────────────────────────────┘
         bed + global automation keep running throughout
         edge: automatic trigger (a zone, afterDelay, …) + requireEnd
               (a manual/OSC/tablet trigger fires anyway — flagged early, not blocked)
```

**Where you can see it:** a **HOLDING** chip in the state lane, a ⏱ prefix on every gated edge in the
graph, a snowflake badge on states that hold, a warn-coloured out-handle on the ruler, and
`host.show.getStatus().held` on the tablet. It has to be visible somewhere: a hold reports
`playing: true` with a frozen timecode, which from the back of a venue is exactly what a hung show
looks like.

### Idle reset — the unattended dead-man's switch (`StateMachine.idleResetSec`)

An installation runs itself, and the failure it must survive is the quiet one: a visitor triggers the
reaction, walks off before it ends, and the show freezes on the last frame of a look nobody is watching —
the picture is up, the transport is running, and the machine sits there **reporting itself perfectly
healthy** until someone notices hours later. `idleResetSec` is the machine-wide dead-man's switch for
exactly that: **if the current state reaches its end and holds with no transition firing for this many
seconds, force-return to `initialStateId`** (your idle / attract state) so the loop starts over.

- **It is machine-scoped, not per-edge.** One knob covers *every* interactive state without drawing a
  return edge from each — the same reason `fromAny` exists. Set it once in the graph editor's **Show
  machine** panel (*Auto-reset to initial after (min) — 0 = off*, shown in minutes, stored as seconds).
- **It measures from the hold, not from entry.** The clock starts when the state's picture *finishes*
  (`SmContext.held` goes true), so a 20 s clip that then holds for 5 minutes resets 5 minutes **after it
  froze** — the honest "nobody came" window. (`afterDelay` counts from entry; this does not.)
- **Only a held state can trigger it.** A state that loops, or has no **Hold at end** authored, never
  "reached its end", so it is never a stuck show to rescue — and the idle/attract state itself is
  **skipped** (it is the target), so a held attract loop never resets to itself.
- **Authored exits always win.** It is evaluated **after** the state's own edges and all global rules, so
  it can never pre-empt a real transition — it only fires on a frame where nothing else did. It resets
  cleanly on entry, so returning to idle re-arms the clock for the next visitor.
- **`0` / absent = off** — the behaviour of every project written before this field. A fired reset logs
  `[fsm] idle reset: held Ns with no transition → returning to initial state`.

This is the hard safety net that complements the *soft* one you may already author with tracking — the
canonical `Reaction ──[LiDAR zone: empty for 30s]──▶ Attract` edge returns the show when the sensor says
the room emptied; `idleResetSec` returns it even when **no sensor is configured, the tracker is down, or
the room-empty rule was never drawn**. Belt and braces.

### Lock time (dwell)

`SmState.lockSec` is a **minimum dwell**: the state's **`afterDelay`** transitions are held for
`lockSec` seconds after entry before they may fire. Use it to guarantee a look is shown for at least N
seconds. **Only `afterDelay` is gated** — `manual` and the playhead triggers ignore lock time. (In the
editor it is labelled *"Lock time (s) — dwell before auto transitions".*)

---

## Entry actions — what a state *does* on arrival

When a state is entered the runtime, **in this order**:

1. **Recalls the bound Scene** (`sceneId`), if any — crossfading over the **arriving transition's
   `fadeSec`** (see below).
2. **Runs the `entry` actions** in order.
3. Fires the "transition fired" pulse (editor edge flash) and notifies subscribers.

| Action | Effect | Field |
|---|---|---|
| `play` / `pause` / `stop` | drive the timeline transport | — |
| `seek` | jump the playhead to `seekTo` seconds | `seekTo` |
| `setLoop` | turn the loop region on/off | `loopOn` |
| `jumpMarker` | seek to marker `markerId` | `markerId` |
| `recallScene` | recall another Scene by id (in addition to the bound one) | `sceneId` |
| `fireCue` | fire a granular Cue by id | `cueId` |

Actions **emit intents**, they don't mutate state directly — see *Single transport writer* below. A
state with **no** `sceneId` and **no** entry actions is a harmless no-op waypoint.

---

## Scene binding & the transition crossfade

- **`SmState.sceneId`** is the **1:1 look binding**: entering the state recalls that Scene. This is the
  normal way a state changes what's on screen/output — you rarely need a `recallScene` action.
- **`SmTransition.fadeSec`** is the **scene crossfade** applied *when arriving at `to`*. Fadeable
  numeric params (global brightness, surface/fixture geometry, opacity, effect speed/intensity)
  **animate** over `fadeSec`; discrete params (effect id, palette, media, booleans) **snap**. `0` =
  instant. (This is the same fade engine Scenes use — see [SCENES.md](SCENES.md).)
- Because a Scene may own its **own timeline**, entering a state can also **warm-swap the playback
  engine** to that state's timeline. Details + the per-state authoring loop:
  [SCENE-TIMELINES.md](SCENE-TIMELINES.md).

Entry is **idempotent and repeatable**: re-entering the same state restarts it identically (its
timeline seeks to the first frame), which matters for shows that re-enter a state many times.

---

## Regions — organizing the graph (the "big OR")

An `SmRegion` is a **resizable group-box** that visually organizes related states (e.g. *Attract* vs
*Performances*). It is **purely organizational** — states inside carry its `regionId` and **move/resize
with it**, but regions have **no runtime effect** on transitions. Use them to keep large graphs
legible. See [template 3](../examples/state-machine/03-interactive-installation.artlux).

---

## Authoring — the state-graph editor

Open it from the **Show Machine** context, or from the timeline drawer's **state lane** ("Edit logic").
The editor
([`components/timeline/StateGraphEditor.tsx`](../src/renderer/components/timeline/StateGraphEditor.tsx))
is an AutomataUI-style node canvas + an inspector.

**Toolbar**
- **＋ State** — add a state at the canvas centre (or **double-click empty canvas**).
- **＋ Region** — add a group-box.
- **Build from scenes** — one node per existing Scene, each **pre-bound** to its Scene, laid out in a
  grid. The fastest way to seed a show graph.

**Canvas gestures**
- **Drag a node** to move it (drops it into whatever region it lands on).
- **Drag a node's right-edge nub** onto another node to **create a transition** (starts as `manual`).
- **Double-click a node** to **force-enter that state live** (enables the machine if needed) — great
  for previewing a look.
- **Ctrl/Cmd+click an edge** to **fire that transition manually** (if it leaves the current state).
- **Select an edge** to reveal its **bezier handles** (curve it for readability — cosmetic).
- **Middle-drag** pans; **Ctrl/Cmd+wheel** zooms toward the cursor.
- **Del/Backspace** deletes the selection.

**Inspector (state selected)** — Name · **Set as initial** (★) · **Scene (recalled on entry)** ·
**Edit timeline** (author this state's own timeline) · **Lock time** · **Entry actions** (add/remove;
each action edits its own params).

**Inspector (transition selected)** — the `from → to` label · **Trigger** kind + its params
(`afterDelay` seconds, `atTime` time, `onMarker` marker, `onClipEnd` track, `onTimelineEnd` — no
params, shown as an italic hint) · **Transition time** (`fadeSec`).

Live feedback: the **initial** state is the cyan *Init* node, the **current/active** state gets an
orange ring, and a firing edge **flashes red** — all driven render-free from the engine.

The **state lane** (in the Timeline panel) shows the live current state and **manual-trigger buttons**
for the current state's `manual` transitions, so you can drive the show without opening the editor.

---

<!-- audience:contributor -->

## Runtime semantics (`src/renderer/services/stateMachine.ts`)

A pure-ish module singleton, driven by the engine's frame loop (`services/timeline.ts` calls
`fsm.tick()` **once per frame, main window only** — mirror/projector windows receive the resulting
transport over the bridge, they don't run the FSM).

- **Enable rising-edge (re)initialization.** When `enabled` goes true — or the current state vanishes
  because you edited the graph — the machine enters `initialStateId` (or the first state). Editing a
  graph while it runs therefore doesn't reset a still-valid current state.
- **One transition per frame.** `tick()` evaluates the current state's outgoing transitions in order
  and returns after firing the first match — no same-frame cascades.
- **Forced enter.** `requestEnter(stateId)` (double-click a node; wired for future OSC/MIDI) queues a
  **force-enter** applied on the next tick, *before* re-init, so it survives the React→engine enable
  delay. It **bypasses the graph** (no trigger needed) — distinct from firing a transition.
- **Single transport writer.** Entry actions emit `TransportIntent`s (`play`/`pause`/`stop`/`seek`/
  `loop`); the FSM **never** sets `playing` itself. `App` subscribes and maps intents to React state,
  so **App stays the one source of truth** for transport and FSM-driven changes show in the play button
  and bridge to projector/mirror windows for free.
- **Scene recall via the bus.** States recall Scenes through `cueBus.requestRecall` (not a direct
  React write), which `App` resolves against the live Scene list — the same path manual **GO** and OSC
  use, so every trigger source funnels through one recall.
- **Introspection for the UI:** `subscribeState` (current state), `subscribeFired` (edge-flash pulse),
  `getStateElapsedSec` (time in state, standalone clock). Exposed on the engine as `subscribeSmState`
  / `subscribeSmFired` / `enterSmState` / `triggerSmTransition`.

---

<!-- audience:operator -->

## The cold start — the show waits for its content (`services/bootGate.ts`)

**Opening a project does not start the machine. Decoding the opening look does.**

Everything that loads content is fire-and-forget: `timeline.warmPool()` kicks blob reads, codec probes
and first-frame seeks and returns immediately; `contentSource.acquire()` does the same for a surface's
own media; the audio plugin conforms and loads on its own schedule. Before the gate existed, the FSM
initialized on the **very next frame** after `applyProjectData` — entered `initialStateId`, ran its
`play` entry action, and the transport ran over decoders that held nothing:

- a `<video>` below `readyState 2` is **undrawable**, and `buildProgram()` clears to black, so the
  opening seconds went out **black on the projectors and on the Art-Net output** alike;
- a bed clip is **silent** until the audio engine has loaded it (measured: ~6 s on a cold boot);
- an `afterDelay` on the opening state rides a **wall clock that started at entry**, so a 5 s dwell
  could expire before its content had ever appeared on stage.

So on every project open the machine is **held** (`timeline.setArmed(false)` — the *tick* is skipped)
while `bootGate` polls readiness at ~10 Hz, then armed. What it waits for:

| Waited on | Ready when |
|---|---|
| the opening scene's timeline pool (the frame each layer **starts** on) | the `<video>` is seeked and `readyState >= 2`, or the codec's `probed()` has answered |
| a codec layer's **decode-ahead buffer**, not just its first frame (`VideoCodec.preRoll`, 0.3 s) | the codec reports that much decoded — and the gate's polling is what fills it |
| the loaded surfaces' own `VIDEO` / `IMAGE` media | `surfaceMedia.getDrawable()` returns something |
| whatever a plugin registers (`host.boot.registerProbe`) — today the audio plugin's engine loads + conforms | the plugin says so |

**Never waited on:** live sources (camera / NDI / Spout / DMX-in / tracking), effects, `LAYER` /
`PROGRAM` / `SLICE` surfaces, and any layer with nothing under the timeline's start. A live feed may
legitimately never arrive; blocking on one would hold a venue dark because a sending machine was off.

**A first frame is not a buffer.** The gate originally armed as soon as each layer had *one* decoded
frame — and a decode-ahead codec starts empty, so the show opened by missing the next hundred: the
compositor paints the nearest decoded neighbour, which is a visible stutter for the first ten seconds
(measured on a 1080p60 HAP show: 167 ring misses in the first ten seconds, then ~none for the rest of
the run). `VideoCodec.preRoll(path, atSec, aheadSec)` closes that: it **tops up and reports**, so the
gate's own polling primes the ring. Codecs that don't implement it behave exactly as before.

**The gate also silences the housekeeping.** Filmstrips and waveforms decode media for looks, on the
same decoder, IPC bridge and GPU the show is trying to start on — see
[TIMELINE.md](TIMELINE.md#key-design-decisions-read-before-extending) for the three rules that bound
them. Together with the pre-roll, that took a real show's first run from *61 → 22 → 61 fps with 251 ring
misses* to **61 fps on every sample with 43 misses, all of them before the show started**.

**It always fails open.** After *Preferences ▸ Engine ▸ Preload wait* (`AppSettings.bootPreloadSec`,
default **15 s**, machine-scoped) the machine is armed regardless and the log names what never came:

```
[boot] content ready in 5.8s (2 item(s)) — arming the show
[boot] armed by TIMEOUT after 15.0s — 1 item(s) never became ready: Ghost: nope.png
```

### On the outputs: **PRELOADING SHOW**

A projector window is pointed at a *wall*, and half a look is worse than none — one layer parked on its
first frame while the rest are still black reads, from the floor of a venue, as *the show is broken*.
So while the gate holds, every open output window **draws nothing** and shows a dim, centred
**PRELOADING SHOW** sign naming its surface (`Front wall · 0/1`), which clears by itself. This is the
same in **broadcast and in the editor** — one `ProjectorApp`, one code path.

The state crosses the MessagePort as `{ t: 'boot', booting, ready, total }` ([bridge.ts](../src/renderer/projector/bridge.ts)),
pushed on every gate change **and** with the config, because a window can open *into* a preload —
broadcast opens its outputs from the very project load that started the wait. It is enforced at the
**draw** (`gl.draw(null, …)`, off a ref so the frame loop never waits for a React commit), so transport,
geometry and calibration overlays keep flowing underneath and the real picture is already there the
instant the gate arms.

Two consequences worth knowing:

- The sign is **DOM**, so an **NDI send** of that output carries the black, not the words. That is the
  right way round: an NDI consumer is another machine's input, not a person to be told things.
- **The LED output is not held.** The frame engine keeps sampling and publishing `dmx:frame` throughout
  (it runs on its own loop, independent of any component) — so fixtures show whatever the surfaces have
  during the wait, usually the opening frame or black. Blanking them for the hold would be a one-line
  change on the compositor's master brightness, deliberately not taken: it changes the most
  safety-critical path in the app for a case nobody has yet asked to be dark.

**And the show starts at the top.** When the gate releases *on its own* (ready or timed out), both clocks
are seeked back to their in-points before the machine's first tick. This is not belt-and-braces: the
transport is **running from launch** (`isVideoPlaying` starts `true`), so the playhead advances for the
whole hold — a project that took 11 s to preload used to start its show **11 seconds in**, with the bed
already playing under a picture that had not appeared. It is skipped when the gate was armed by the
OPERATOR (`armedBy: 'manual'` — someone reached past the wait and pressed Play); their playhead is
theirs. The seek runs synchronously inside the release, so it lands before the first FSM frame.

Also true of the hold:

- **It holds the machine, not the app.** `Stage` keeps compositing and publishing `dmx:frame`
  throughout (unmounting it would stop Art-Net), surfaces show whatever they already have, and the warm
  pool has each layer parked on its first frame — so the wall shows frame 0 held, then starts.
- **It is not `stateMachine.enabled`.** That flag is persisted project data; flipping it to wait would
  write the show back to disk disabled. The arm is engine state and is never saved.
- **A human outranks it.** Pressing Play (or an OSC/tablet transport command) during the hold arms it
  immediately — `App` is the single writer of `playing`, so that one seam covers every path.
- **Every cold start funnels through `applyProjectData`** — editor open, `--project=`, the watchdog's
  relaunch, the show-control playlist's next show — so one call site covers all of them, and a playlist
  switch simply restarts the wait against the incoming project.
- **The status bar says so** (a "Preloading n/m" chip), and so does the tablet: `host.show.getStatus()`
  carries `booting` + `bootPending`, because a preload and a stopped show otherwise look identical
  (`playing: false`, no current state) and an operator would press GO over a gate about to open.

---

## Global rules — a trigger that fires from **any** state

A transition normally leaves one source state. An installation usually has a few rules that must work
*whatever the show is doing* — *someone walks into the entrance → start the welcome* — and drawing that
edge from every state (and re-drawing it whenever a state is added) is how an installation quietly stops
responding in the one state somebody forgot.

Set **`fromAny`** and the transition is evaluated from every state. In the graph editor: the **⚡ Global
rule** button, a **Global rules** list in the inspector column, and a **⚡ badge** on any state a global
rule can reach. It is *listed*, never drawn as an edge — a rule with no source node is not an edge, and
drawing one from nowhere (or from everywhere) would misrepresent how it fires.

Three rules keep it predictable, all in `tick()`:

| | |
|---|---|
| **Explicit beats global** | the current state's own transitions are evaluated first, so a state can always override a house rule |
| **Never re-enters its own target** | a global whose `to` **is** the current state is skipped. Its condition is usually a *level* (somebody standing in a zone) and entry restarts the state's timeline — without this it would re-seek to frame 0 sixty times a second behind a frozen picture, reporting itself healthy |
| **Still one transition per frame** | globals join the same single-fire budget; no cascades |

`requireEnd` applies to a global exactly as to an edge, and a global `manual` rule appears as a button in
the **state lane** (and over OSC / the tablet) from wherever the show currently is.

## Plugin triggers — reacting to the room

`kind: 'plugin'` is **one** core trigger kind for every condition a plugin owns. The project stores
only the shape (`source` + opaque `params`); what the condition *means* lives in whichever plugin
registered that `source` (`SmTriggerContribution` — see [SDK.md](SDK.md)). So the next trigger source —
camera pose, Augmenta, a DMX level, an audio threshold — needs **no core change and no file
migration**, and a project naming a source this build has no plugin for is **inert**, never truthy.

Shipped today: **`lidar.zone`** — LiDAR trigger zones
([TRACKING_SYNC.md](TRACKING_SYNC.md#trigger-zones--making-the-show-react-to-the-room)). Pick
**LiDAR zone** in the transition inspector's trigger dropdown and the plugin's own editor appears
(zone · when · seconds/people). The edge label in the graph then describes the *rule* —
*Entrance: someone enters* — instead of just naming the destination.

The canonical interactive state combines all three pieces:

```
Attract ──[hold at end]──▶ frozen last frame, bed still playing
        ──[LiDAR zone: someone enters + ⏱ only after the state has finished]──▶ Reaction
Reaction ──[LiDAR zone: empty for 30s]──▶ Attract
        ⚡ global: [entrance ∧ ¬stage] ──▶ Welcome     (from wherever the show is)
```

### A trigger is evaluated even while its guard is closed

`tick()` asks a transition's trigger **every frame**, then lets `requireEnd` decide whether to act. The
order matters because a trigger source can be **stateful**: a zone rule remembers whether it has been
armed since the state was entered, and it only sees the frames on which it is asked.

Checking the guard first blinded it for exactly the window the guard exists to cover — a visitor walked
into the zone at t=3 while the film played, the guard swallowed the question, and when the hold opened at
t=12 the source was being asked for the first time. It saw somebody merely *standing* there, not
*arriving*, and the show never advanced: the visitor had to walk out and back in. **The guard suppresses
the action, not the evaluation.** Core triggers are stateless tests, so asking them under a closed guard
costs nothing. It is part of the `SmTriggerContribution` contract — see [SDK.md](SDK.md).

## Triggering from outside the app

### OSC (see [OSC.md](OSC.md))
Under the control prefix (default `/artlux`), fire a **transition by its id** — it only fires if that
transition leaves the **current** state:

```
/artlux/state/trigger   <s: transitionId>     # fire a named transition
/artlux/state/<id>                             # same, id in the address
```

So in [template 3](../examples/state-machine/03-interactive-installation.artlux) (OSC enabled, port
10000), `/artlux/state/to_ember` jumps Attract → Ember, `/artlux/state/black_return` releases the
blackout. Scenes and cues have their own addresses too (`/artlux/scene/<ref>/go`,
`/artlux/cue/<ref>/go`). **Give your transitions readable ids** and the OSC surface documents itself.

### Show-control tablet
The [show-control plugin](SHOW-CONTROL.md) serves a tablet PWA whose **States tab** lists states and
manual transitions for touch control, plus a scheduler that can drive the machine on a wall clock.

---

<!-- audience:contributor -->

## Persistence & migration

- Saved as `ProjectData.stateMachine` in the `.artlux` file (project scope). It's plain JSON — readable
  and hand-editable.
- **Legacy migration:** early builds nested the machine under `timeline.stateMachine`. The loader reads
  `data.stateMachine ?? data.timeline.stateMachine` and normalizes it, so old projects upgrade with no
  action. Everything used app-wide (types/enums) stays core, so there is **no project-file migration**.

---

<!-- audience:operator -->

## Worked patterns

| Pattern | Shape | Template |
|---|---|---|
| **Timed loop** | states chained by `afterDelay`, last → first | [01-hello-state-machine](../examples/state-machine/01-hello-state-machine.artlux) |
| **Trigger cookbook** | one linear tour of five of the six trigger kinds (all but `onTimelineEnd`) + entry actions | [02-triggers-and-actions](../examples/state-machine/02-triggers-and-actions.artlux) |
| **Hub-and-spoke installation** | an attract hub, manual/OSC spokes that auto-return after a dwell | [03-interactive-installation](../examples/state-machine/03-interactive-installation.artlux) |

**"From any state" transitions.** The FSM has no global/wildcard edge — a transition always leaves one
source state. To make (say) a **blackout** reachable everywhere, add a `manual` edge from each state to
it (or drive `requestEnter`/OSC). Regions group such states visually but don't wire them.

---

<!-- audience:contributor -->

## Source map

| File | Role |
|---|---|
| [`src/renderer/services/stateMachine.ts`](../src/renderer/services/stateMachine.ts) | FSM runtime — `tick`, `triggerManual`, `requestEnter`, subscriptions |
| [`src/renderer/services/timeline.ts`](../src/renderer/services/timeline.ts) | drives `fsm.tick()` per frame; builds `SmContext`; exposes engine methods |
| [`src/renderer/types.ts`](../src/renderer/types.ts) | `StateMachine` / `SmState` / `SmTransition` / `SmTrigger` / `SmAction` / `SmRegion` |
| [`src/renderer/components/timeline/StateGraphEditor.tsx`](../src/renderer/components/timeline/StateGraphEditor.tsx) | the node-graph authoring modal |
| [`src/renderer/components/timeline/StateLane.tsx`](../src/renderer/components/timeline/StateLane.tsx) | live current-state lane + manual buttons |
| [`src/renderer/services/cueBus.ts`](../src/renderer/services/cueBus.ts) | React-free bus the FSM recalls Scenes / fires Cues through |
| [`src/renderer/services/bootGate.ts`](../src/renderer/services/bootGate.ts) | the cold-start gate — holds the machine until the opening look is decoded |

## Verify

`npx tsc --noEmit` → `npm run build` → `npm run dev`. Open
[`examples/state-machine/01-hello-state-machine.artlux`](../examples/state-machine/01-hello-state-machine.artlux):
with **no** Play it should cycle Calm → Rise → Burn → Calm on the 2D stage and the LED strip. Then open
`02-triggers-and-actions.artlux`, press the state-lane **manual** button to leave *Idle*, press Play,
and watch it walk through `afterDelay` → `atTime` → `onMarker` → `onClipEnd` → loop.

**The cold-start gate:** open a project with real media and watch the status bar — a *Preloading n/m*
chip appears until the opening look is decoded, and the console logs `[boot] content ready in …`.
Point a surface at a file that does not exist and it instead logs `[boot] armed by TIMEOUT after 15.0s
— … Ghost: nope.png` and starts anyway. Both were verified against
`electron . --headless --project=<file>` (measured: ~6 s of genuine load on a cold boot, which is
exactly the window the show used to run through black and silent).

**The output sign:** give the project a projector output (a *windowed* output needs no second monitor)
and open it — the window reads `PRELOADING SHOW · <surface> · 0/1` over black, and clears itself when
the gate arms. Verified in broadcast with a windowed output: sign up at +5.9 s, gone at +20.9 s (the
15 s fail-open), with the output's centre pixel read back as `[0,0,0]` throughout the hold.
