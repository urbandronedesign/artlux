# Implementation plans — lifting ArtLux's software limitations

This folder holds one **critical implementation plan per liftable limitation** surfaced while writing the
tutorial/example sets (`examples/`). Each plan targets a gap that exists **purely because of missing or
half-done implementation** — not a physics/OS reality — and answers three questions the codebase forces on
every change:

1. **Where does it live — core or a plugin?** (per the `CLAUDE.md` doctrine: persisted types stay core; only
   behavior moves to a plugin).
2. **What breaks?** — every backward-incompatible surface, called out loudly (§5 of each plan).
3. **What's the risk to the codebase?** — the real blast radius, grepped consumer by consumer (§7).

Every plan follows the same 10-section template and carries a one-line `> **Status:**` header.

> **▶ Build order & git workflow:** [SEQUENCING.md](SEQUENCING.md) is the canonical execution plan — the dependency-ordered waves (one branch each, merged to `main` after testing) and the protocol for executing them.

### How these were produced (and how much to trust them)

Each plan was **drafted by an agent reading the actual code**, then **adversarially hardened** by a second
pass that re-verified every `file:line`, grepped for missed consumers, and edited the plan in place. The
hardening pass was not cosmetic — it caught real errors in the drafts, e.g.:

- **auto-patch** had the destination-key precedence *inverted* (would have made the collision UI report
  "no conflict" while hardware collided) — now fixed to match `Stage.tsx`'s `f.output → controller → global`.
- **content-source-region** claimed "exactly one call site" for `renderSurfaces`; it's actually three
  (the `IPixelMapper` interface, the WebGPU impl, and the `Stage.tsx` caller).
- **watchdog** missed that the show-control plugin consumes `WatchdogEvent.action`, and that the drafted
  defer-loop would flood the audit log ~30 lines per pacing window.

Treat them as **well-grounded proposals, not merged specs** — each still has an §10 "Open questions"
block with decisions a human must make before building.

---

## Shipped (archived)

**Twelve** plans are complete and have moved to [`archive/`](archive/). Full per-wave record in
[SEQUENCING.md](SEQUENCING.md#status-tracker).

| Plan | Lifts | Status |
|------|-------|--------|
| [Cue-authoring robustness](archive/cue-authoring-robustness.md) | #4 Cue Deck | ✅ merged (also fixed a Stage crash) |
| [DMX I/O fidelity](archive/dmx-io-fidelity.md) | #6 Patch & Prove | ✅ merged |
| [Asset-ops safety](archive/asset-ops-safety.md) | #9 Pack & Hand Off | ✅ merged |
| [Finish fixture segments](archive/fixture-segments-finish.md) | #3 Wiring Rescue | ✅ merged — gap/off verified on-wire |
| [Auto-patch collision detection](archive/autopatch-collision-detection.md) | #6 Patch & Prove | ✅ merged — detector + reservation (Phase C split-brain deferred) |
| [Schedule/show engine under `--headless`](archive/headless-plugin-host.md) | #10 Ship It | ✅ merged — schedule-fire runtime-verified |
| [In-app docs browser](archive/docs-browser.md) | (net-new) | ✅ shipped v0.21.0 |
| [Watchdog relaunch throttle](archive/watchdog-relaunch-throttle.md) | #10 Ship It | ✅ **merged 2026-07-11** (Wave 0) — `minRelaunchGapSec` pacing + the Preferences field. *(This row said "not started" until 2026-07-14, three days after it merged.)* |
| [Show-control tablet parity](archive/show-control-tablet-parity.md) | #7 Operator Remote | ✅ **merged 2026-07-11** (Wave 0) — tablet multi-bank + per-cue fire + Kick hard-cuts SSE. *(Same — this table was never updated when Wave 0 landed.)* |
| [Timeline transport + global/scene scoping + audio scene binding](archive/timeline-transport-and-audio-scoping.md) | (net-new, Wave 3) | ✅ **merged (`wave-3-audio`, 4541743, 2026-07-14).** Wave A live-tested on hardware; Wave B = the show clock, audio lanes, the mixer, audio on scenes/cues. **Superseded P5** of `audio-engine.md`. |
| [Asset paths: scenes + audio bed](archive/asset-paths-scenes-and-audio.md) | #9 Pack & Hand Off | ✅ **merged (`wave-3-audio`, 4541743, 2026-07-14).** `mapAssetPaths` → per-container visitors over the top level, **every scene**, and the bed. ⚠ Makes a saved project **forward-incompatible** with older builds. |
| [Video-clip audio](archive/video-clip-audio.md) | (net-new) | ✅ **shipped** (`c2eb46e`) — conform-first: a clip's audio track is conformed once to a WAV cache and the existing audio driver plays it on the clip's playhead, with zero native changes. `getVideoAudio` host service + `ClipAudioInspector`. |
| [Native audio engine](archive/audio-engine.md) | (net-new, Wave 3) | ✅ **all phases merged.** P0–P4 (bed, spatial, juce_dsp FX, the automation-curve engine), P5 as Wave B (the show clock + scene/cue binding), and **P6** (multichannel: device picker, speaker commissioning, off-lock decoder rebuild, ASIO-behind-a-flag, machine≠show) merged to `main` (`4541743` + `f37f341`, 2026-07-14/15). ⚠ P6 is a **synthetic pass** — venue verification + the JUCE licence election remain (tracked in SEQUENCING). |

> ### ⚠ Built but NOT pushed — the LED/light fixture split + the lighting encoding
> Twelve commits sit on local `main` ahead of `origin/main`, deliberately unpushed because the
> feature set is **expected to be reworked**. Read
> **[lighting-rework-status.md](lighting-rework-status.md)** before touching
> [fixture-kinds.md](fixture-kinds.md) or [lighting-keyframes.md](lighting-keyframes.md): it records
> what was verified and how, the harnesses to rebuild, the three traps that cost real time, the
> **one item that was not built** (the degrees display transform), and **three decisions where
> building contradicted the plan's own recommendation**.

## Active plans

> **[Fixture Editor — two categories, and the duplication behind them](fixture-editor-split.md)** — Draft 2026-07-27, 🟢 Low. The inspector was split by kind in Wave B; the **Fixture Editor dock was not**, and four of its seven cards are pixel-only with nothing saying so. Also records the duplication audit: **no enum has a duplicate** — but `roleValue()` exists three times identically, the captured-role list is duplicated under two names beside a third divergent one, and `allRoles` is a dead flag (`x ? A : A`).

| Plan | Lifts (tutorial set) | Placement | Risk | Status |
|------|----------------------|-----------|------|--------|
| [Content source-region (crop)](content-source-region.md) | #5 Hello Projector | **Core** | 🟡 Med | held behind webgl-strict Phase 2 |
| [Projector blend preview + phase-lock](projector-blend-preview.md) | #5 Hello Projector | **Hybrid** | 🟡 Med | held (loosely gated on webgl-strict) |
| [WebGL strict per-surface sampling](webgl-strict-per-surface-sampling.md) | #1 Composite Stage | **Core** | 🟡 Med | **Phase 1 shipped** (banner + force-WebGL + GPU settings); **Phase 2 deferred — open GitHub decision issue** |
| [MIDI controller support](midi-control.md) | (net-new) | **Plugin** | 🟡 Med | not started (Draft) |
| [Transport: prev/next edit point](transport-edit-point-navigation.md) | (net-new; Wave A leftover) | **Core** | 🟢 Low | Draft — the `⏮`/`⏭` buttons are **in the transport sketch and were never built**: Wave A's plan narrowed to "the three controls that never had a button" and the two skip buttons dropped out between the drawing and the plan. The *capability* is missing too — there is **no prev/next navigation of any kind** in the timeline. Land **after** `wave-3-audio` merges (it touches `TimelineToolbar.tsx`) |
| [Timeline undo](timeline-undo.md) | (net-new, Wave 4) | **Core** | 🟡 Med | Draft — **there is no undo for any timeline edit**, and the show engine (FSM/OSC/cues/scheduler) pushes history entries **no human made** onto an **uncapped** stack |
| [Renderer error containment](renderer-error-containment.md) | #10 Ship It | **Core** | 🟠 Med | Draft — **the watchdog is blind to a white screen.** A first-render throw means the heartbeat never fires, so the watchdog **never arms** and an unattended install sits dead until someone drives to the venue |
| [Engine decoupling (hybrid GPU)](engine-decoupling.md) | (net-new, architecture) | **Core** | 🟠 Med-high overall, staged 🟢/🟡 per WP | **Approved 2026-07-26** — the frame loop lives in a React effect and **Art-Net stops if a DOM node is missing** (`Stage.tsx:295`/`:414`), which is the root cause of "Stage must never unmount" and of every expensive workspace redesign. Extracts a UI-independent engine (main thread → Worker), keeps React panels so the SDK is untouched. **Carries its own WP tracker + session protocol — read it first, tick it as you go.** |
| [Fixture kinds — LED vs Light](fixture-kinds.md) | (net-new) | **Core** | 🟡 Med | ⚠ **BUILT, UNPUSHED 2026-07-27** — waves A/B/B′/C/D all shipped locally and verified in the running app; see [status](lighting-rework-status.md). — the app has *one* `Fixture` type for two physically different things on two different wires (pixel tape over Art-Net, moving heads over USB-DMX). The engine already branches correctly; the model, the UI and the patch do not. A selected moving head offers **an editable "LED Count"**, which shifts every fixture after it in the canonical pixel buffer while the wire stays correct — and `autoPatch`'s `defaultControllerId` is `undefined` at all nine call sites, so **every new head lands on the Art-Net node**. And a light is **drawn as a draggable rect on the 2D canvas** while its 3D position is *derived from* that rect — so both creation paths spawn every head at `x:0.4,y:0.4`, which maps to **the world origin**: add ten heads, get ten stacked in one spot. Gives the kind one owner, then pushes it through selection → inspector → browser → **the 3D scene as a light's only home** → patch. |
| [Lighting keyframes](lighting-keyframes.md) | (net-new) | **Core** | 🟡 Med | ⚠ **BUILT, UNPUSHED 2026-07-27** — E1–E6 shipped locally and wire-verified; the degrees display transform is the one item NOT built; see [status](lighting-rework-status.md). — companion to fixture-kinds. The app has a **good keyframe engine** (linear/hold/bezier, O(1) cursor sampler, a drawn editor — built for audio) and a **good group/role/spread engine** (degrees, head morphing, phase spread, HTP/LTP), and **they are not connected**. A light show can therefore be *recorded* or *generated*, never **authored**: `LightingCurve` is dense linear-only sampled arrays with **no editor anywhere in the tree**, while the real keyframe lane addresses one channel of one fixture in **0..1 instead of degrees** — and outranks the lighting clip. Adds pose keyframes over a group on one shared `Keyframe[]` format, and the **Store key** verb that closes the authoring loop *select ▸ place in 3D ▸ position ▸ set params ▸ store at the playhead*. Also settles **cues vs keyframes**: a pose is one atom, keyframes are the *storage* (scrubbable, seekable, spreadable) and **pose cues** are the *invocation* — the same stored look fired from the cue grid, the tablet, OSC or an FSM entry action as a live-override fade. |
| [Dockable workspace](dockable-workspace.md) | (net-new, architecture — engine-decoupling Phase 5) | **Core** | 🟡 Med | **Planned 2026-07-27** — let the operator arrange each workbench: drag panels into tabs and splits, add, close, reset, per context and persisted. Much cheaper than it was: Phase 1 deleted *Stage must never unmount*, which was the constraint that made every previous docking design expensive. **Zero SDK change** — the tree is compiled from the flat manifest contexts already declare. **Carries its own WP tracker — read it first.** |

## Net-new subsystems (beyond limitation-lifts)

[MIDI controller support](midi-control.md) is the one still-active net-new plan. The two that have shipped
were the heavier ones: the [Native audio engine](archive/audio-engine.md) — the **first non-Rust native
module** (a JUCE C++ N-API addon alongside the Rust crates) plus a **general time-keyframed automation-curve
engine** that didn't exist before (scenes/cues were snapshot+fade only), now fully merged through P6 — and
the [in-app docs browser](archive/docs-browser.md), shipped in v0.21.0. Audio stayed releasable throughout
via a Phase-0 toolchain spike and the graceful-degrade loader.

## Sequencing

Build order + git workflow live in **[SEQUENCING.md](SEQUENCING.md)** — the canonical source. **Waves 0–3
are all merged to `main`, and P6 (audio multichannel) merged on top** (`4541743` Wave 3 + `f37f341` P6,
2026-07-14/15) — the whole audio subsystem (P0–P6, the transport/Wave A/Wave B work, asset-paths) is
shipped. The remaining open item on the render side is the webgl-strict **Phase 2** decision, which still
gates content-source-region + projector-blend.

**Wave 4 — renderer robustness** ([timeline-undo](timeline-undo.md) → [renderer-error-containment](renderer-error-containment.md))
was **surfaced by Wave B's adversarial review**, which passed the branch but named both as structural gaps that
belong in their own wave rather than being smuggled into an audio one. They are the structural answer to a class
of defect this project has now fixed one instance at a time, three times: a data bug reaching a component that
renders unconditionally, and an edit landing somewhere it cannot be taken back from. Undo goes first — see the
[dependency graph](SEQUENCING.md#dependency-graph-the-hard-land-after-edges).

> **Wave B introduced a new engine invariant — *one transport, two playheads*.** The transport carries a
> second derived time (`showTime`, the SHOW clock) that a scene recall does **not** reset, so the audio bed
> plays through a GO while the picture restarts. The full reset table (every transport event × both clocks)
> is in **[docs/TIMELINE.md](../docs/TIMELINE.md#the-show-clock-wave-b--one-transport-two-playheads)**; read
> it before touching `mainSeek`, `swap()` or `frame()`.

### Wave 4's backlog, part 2 — the merge review's deferred findings (2026-07-14)

The **16-agent adversarial review of the full `wave-3-audio` merge diff** confirmed **39 findings**. The user
triaged the merge bar to *"Wave 3's own defects + the effect clock"* ([the merge-blocker
plan](../docs/archive/superpowers/plans/2026-07-14-wave-3-merge-blockers.md), gate 6 in
[SEQUENCING](SEQUENCING.md) ▸ *"The Wave 3 merge gate"*). **These are the ones that were deliberately left out.**
They are written down here so that "not a merge blocker" cannot quietly become "forgotten". Each is
*confirmed* — verified by three adversarial lenses that were told to default to REFUTED.

**Blocker, and PRE-EXISTING (not a Wave 3 regression — it is why it did not gate the merge):**
- `services/timeline.ts:876` — **a layer goes black forever after a scene round-trip.** `swap()` releases the
  contentSource for layers the incoming timeline lacks, but leaves the outgoing pool's `LayerVid.content`
  set. A pool promoted again refuses to re-acquire, because it believes it already holds the content. Recall
  scene A → scene B → scene A and a layer is simply gone, for the rest of the session.

**Unattended-install rot (the class this project keeps re-learning):**
- **THE AUDIO ENGINE DOES NOT RE-OPEN A DEAD DEVICE ON ITS OWN** *(opened 2026-07-14 by merge task 9 —
  deliberately, and it must not be mistaken for a leftover)*. That task made a dead output device **visible**
  (a `no output device` badge, an honest Preferences panel) and **recoverable** (a Reconnect button, plus the
  `opened`-guard invalidation that makes a re-configure actually re-open). It did **not** make it *automatic*:
  `configure()` is called from exactly two places — plugin activation and the Preferences panel — and nothing
  polls it. **In an attended show that is fine. In an unattended install nobody is there to press Reconnect,
  and the room is silent until someone visits — which is precisely the deployment this app exists for.**
  Auto-recovery is a real design (retry backoff; *which* device to re-open when the default has changed; what
  to do when it returns with a different channel count; how not to fight a device that is legitimately absent)
  and it needs one. `scratch/devicedeath-sim.mjs` asserts the gap so a passing badge cannot be read as a cure.
  ✅ **The foundation is verified.** Acceptance test **2.10** passed on 2026-07-14 (Windows ▸ Sound ▸ *Don't
  allow* — no USB interface needed; it drives `getCurrentAudioDevice()` to `nullptr` down the identical path):
  the badge appears, Preferences names the device it lost, and **Reconnect restores sound with no restart**.
  So the *detection* and the *manual recovery* both work, and an auto-recovery design can be built on them
  with confidence. **What is still missing is the "auto".**
- `hooks/useHistory.ts:47` — every **automated** GO (FSM, scheduler, OSC) and every cue fire pushes an
  **uncapped deep JSON copy of the entire project** onto the undo stack. Nobody pressed anything. Six hours
  unattended is a leak, and [timeline-undo](timeline-undo.md) is the plan that already owns this edge.
- `components/timeline/audioPeaks.ts:86/91` — waveform peaks decode the **whole** audio file in the renderer
  with **no size cap**; and a transient decode failure becomes a **permanent session-lifetime blacklist**
  with nothing on screen to say so.

**Silent corruption / silent wrong output:**
- `services/projectFolder.ts:365/374` — **Collect Assets** silently leaves any file whose extension is not in
  `ASSET_CATEGORIES` pointing at the authoring machine, and folds a **failed copy** into the same `skipped`
  counter as a deliberate no-op. The operator is told the project is portable. It is not.
- `components/timeline/Timeline.tsx:458/546` — **left-trim** clamps `start` at 0 but keeps growing
  `duration`, on both video and audio clips.
- `services/transitions.ts:136` — a **GO during a running core fade** snaps the output to the *outgoing*
  fade's endpoint for one frame.
- `native/audio-engine/src/engine.cpp:208` — non-spatial clips are summed into **every** device output
  channel.
- `native/audio-engine/src/engine.cpp:309` — `setMasterGain` clamps with `juce::jlimit`, which **passes NaN
  through unchanged.**

**The UI claims something the engine is not doing** — the house rule this codebase kills on sight, and the
merge fixed only two of its four instances:
- `App.tsx:285` — `compileAutomation` re-runs when the **audio** target set changes but never when the
  **core** one does, so **a lane the engine has DROPPED still renders with a full curve and a ticking
  readout, driving nothing.** The readout is a UI *re-computation*, not a report from the engine — which is
  the actual root cause, and the real cure: **the engine should report the value it applied.** *(Task 7 shipped
  the smaller UI fix the user chose. It does not cure this.)*
- `plugins/audio/src/AudioBedPanel.tsx` — **the same readback hole that Task 13 closed for the three gains is
  still open on `spatial.x/y/z` and on every FX param.** A lane on a reverb's wet mix, or on a source's
  position, moves the sound and does not move the control. Root cause and remedy are identical
  (`drivenSnapshot()` already exports what is needed; each site needs one `drivenOn(...)` read); the surfaces
  are `SpatialPad` and `EffectChain` rather than `Fader`, which is the only reason they were not done at once.

**Build / toolchain:**
- `package.json:24` — `npm run package` builds the **audio** engine but neither builds nor checks the **three
  Rust** addons. (Gate 2's disease, one script over.)
- **`tsconfig.json` has no `strict`.** `strictNullChecks` is **off**, so *no optional-prop design in this
  codebase has a compiler behind it.* This is not a style note: during Task 7, `tsc --noEmit` returned **0
  errors on code that would have crashed the timeline panel** — an optional `onChange` called as
  `undefined(...)`. Every read-only-by-absent-handler pattern in the tree is currently guarded by hand, or
  not at all. Turning `strict` on is a wave of its own; **until then, treat a green `tsc` as weaker evidence
  than it looks.**

## Cross-cutting hazards (every implementer must respect these)

- **Persisted-field normalize defaults.** Plans 5, 6, 7 (and optionally 10) add fields that ride inside the
  `.artlux` file. Old projects must load unchanged — each uses an **additive optional field + a default at
  the read site** (the `normalize*()` pattern in `renderer/types.ts`). No `ProjectData.version` bump is
  required for any of them.
- **WebGPU ↔ WebGL parity.** Plans 6 and 8 touch the render path. The WebGPU compute mapper is primary; the
  WebGL `GPUMapper` fallback must agree, and it runs at lower precision (`mediump`, RGBA8 map textures) on a
  path that *can't be exercised on a WebGPU dev machine without a force-fallback flag*. This is where the
  subtle bugs live.
- **Barrel/singleton hazard** (plan 9, and 11's plugin host under headless). Host imports a plugin only via
  its barrel; the plugin's files import each other relatively; `"sideEffects": false`. Mixing the alias with
  relative imports duplicates singletons.
- **The two hand-mirrored File menus** (plan 3): `src/main/menu.ts` **and** `src/renderer/components/MenuBar.tsx`
  must both change or the app ships divergent menus.
- **Signature invalidation** (plan 5): a new field that changes render output must be added to the relevant
  `*Signature` join in `Stage.tsx` or the change silently won't repaint until an unrelated edit.

## Scope boundary — what is *not* here (inherent, will-not-fix)

The tutorials also hit limits that **no implementation can lift**, so they get no plan:

- **True additive soft-edge blending across two separate desktop projector windows** (#5). Overlapping OS
  windows are opaque and composite *alpha-over*, never additive — the compositor, not ArtLux, owns this.
  Plan 10 lifts the *liftable* parts instead (a shared effect clock for phase-lock, and an on-screen
  **combined-region additive preview** so blending is verifiable on one screen), and marks the occlusion
  part as inherent.
- **Headless media rendering black without the fix** was a real gap (plan 11 lifts it); but headless having
  *no display surface* for projector windows is by design.

## Minor items folded in (not standalone plans)

- LiDAR emitter (`scripts/lidar-emitter.cjs`) never sends `id=0`, so #8's empty-slot rule can't be shown on
  the wire — a ~3-line companion-script tweak, tracked in the #8 tuto notes, not a core plan.
- Two stale comments in `renderer/types.ts` (EFFECT "shows nothing"; `fadeSec` "not applied in v1")
  contradict current code — a doc cleanup, not a feature.

---

*Generated from an adversarial code-reading survey of the ArtLux tree. Each plan is independently
buildable; cross-references between plans are noted inline where they share a file.*
