# ArtLux — Development Sequencing & Execution Plan

The canonical order in which the 11 limitation-lift plans and the [audio engine](audio-engine.md) get
built, and the git workflow around them. **Point me at this file** (e.g. *"execute Wave 1 per
plans/SEQUENCING.md"*) and I will do the plans in the right order, on the right branch, with the
verification gate — see **Execution protocol** below.

Derived from a verified cross-plan file-overlap + dependency analysis (each plan's §4/§5/§7). The
governing rule: **audio is a dependency *sink*** — several cheap plans harden the exact code audio builds
on, so audio lands last, and doing it first would force every other plan to rebase onto it.

## Git workflow (one branch per wave)

- Each wave is developed on its **own branch cut from up-to-date `main`**: `wave-<n>-<slug>`.
- Plans within a wave are implemented as **small, scoped, `tsc`-clean commits** (repo convention).
- When the wave is complete and **you have tested it**, it is **merged back to `main`**, the branch is
  deleted, and the **next wave branches from the new `main`**. One wave in flight at a time.
- **I branch / commit / merge / push only on your explicit go** (operating rule). I never merge a wave
  myself — I implement + self-verify, hand it to you to test, and merge only when you say so.

## Dependency graph (the hard "land-after" edges)

```
webgl-strict ──▶ content-source-region
            └──▶ projector-blend-preview
dmx-io-fidelity ──▶ autopatch-collision-detection
cue-authoring ──▶ audio-engine        (audio reuses recall/cue path + paramPath.setIn)
headless-plugin-host ──▶ audio-engine (headless phase; headless-plugin-host retires HeadlessRunner)
transport-wave-A ──▶ transport-wave-B (the bounded clock + the scene/global binding it rides on)
asset-paths ──▶ transport-wave-B      (see below — a HARD edge, added 2026-07-12)
timeline-undo ──▶ renderer-error-containment
                                      (containment's reload rung can only recover to the LAST GOOD DOCUMENT
                                       if document-wide history exists; otherwise it recovers to an EMPTY one
                                       and the rung gets built twice — Wave 4, added 2026-07-12)
```
Everything else is independent. **Hottest shared file:** `Stage.tsx` (6 plans) — sequence its editors
before audio's additive apply-hook. `types.ts` (5 plans) and `paramPath.ts` (3) overlap too, but additively.

**Why `asset-paths ──▶ Wave B` is hard, not cosmetic.** Wave B adds `Timeline.audio` — a new
path-bearing container on **every** timeline (the global one *and* each scene's).
[asset-paths-scenes-and-audio](archive/asset-paths-scenes-and-audio.md) restructures `projectFolder.mapAssetPaths`
from an inline walker into per-container visitors applied to both the top level and each scene. Build
Wave B first and the audio path field gets added to the one branch that exists today
(`projectFolder.ts:67`, which also **skips an audio-only timeline entirely**), scene timelines stay
invisible, and the extraction then has to re-remember it — precisely the failure that plan exists to
kill. It is also **already broken, today, on `wave-3-audio`**: `data.audio` (the bed, shipped in P1–P4)
is never visited at all, so bed paths save absolute and Collect Assets neither copies nor reports them.

## The waves

### Wave 0 — Quick isolated wins · branch `wave-0-quick-wins`
Zero shared-file overlap with anything; fast confidence-builders.
1. [watchdog-relaunch-throttle](archive/watchdog-relaunch-throttle.md) — `watchdog.ts`, `Preferences.tsx` (isolated)
2. [show-control-tablet-parity](archive/show-control-tablet-parity.md) — `plugins/show-control/*` only (isolated)

### Wave 1 — Foundation hardening · branch `wave-1-foundation`
Each hardens code a later wave (or audio) builds on. Suggested intra-wave order minimizes `Stage.tsx` churn:
1. [webgl-strict-per-surface-sampling](webgl-strict-per-surface-sampling.md) — render backend parity *(unblocks Wave 2 render plans)*
2. [dmx-io-fidelity](archive/dmx-io-fidelity.md) — `Stage.tsx` dest/wire path *(unblocks autopatch)*
3. [cue-authoring-robustness](archive/cue-authoring-robustness.md) — fixes `paramPath.setIn` + recall/cue path *(unblocks audio)*
4. [asset-ops-safety](archive/asset-ops-safety.md) — hardens `projectFolder.ts` asset pipeline *(unblocks audio asset category)*
5. [headless-plugin-host](archive/headless-plugin-host.md) — restructures the headless entry *(unblocks audio headless phase)*

### Wave 2 — Render & output build-out · branch `wave-2-render-output`
Consume Wave 1's hardened render/dest paths.
1. [fixture-segments-finish](archive/fixture-segments-finish.md) — render-path; no hard dep but co-located to batch `Stage.tsx`/`WebGPUMapper` churn
2. [content-source-region](content-source-region.md) — **after** webgl-strict
3. [projector-blend-preview](projector-blend-preview.md) — **after** webgl-strict
4. [autopatch-collision-detection](archive/autopatch-collision-detection.md) — **after** dmx-io-fidelity

### Wave 3 — Audio subsystem · branch `wave-3-audio` (large — the whole wave lives on one long-running branch)
The [audio engine](audio-engine.md), landed on the now-hardened foundations. **Two plans govern this wave:**
`audio-engine.md` for P0–P4 and P6, and
[timeline-transport-and-audio-scoping](archive/timeline-transport-and-audio-scoping.md), which **supersedes P5**
and prepends a net-new **Wave A** (the transport work P5 turned out to be blocked on). The revised
internal order — *the ✅ phases are on the branch, unmerged*:

1. ✅ **P0 spike** — JUCE + libspatialaudio C++ N-API addon builds & plays a file in Electron 42
2. ✅ **P1** — core audio types + audio asset category + stereo playback (global timeline) + device settings
3. ✅ **P2** — ambisonic bus + libspatialaudio (binaural first, then speaker decode) + spatial UI
4. ✅ **P3** — effect chains (juce_dsp) + effect params
5. ✅ **P4** — the core **automation-curve engine** + timeline automation lanes
6. ✅ **Wave A** *(net-new — [transport plan](archive/timeline-transport-and-audio-scoping.md))* — the transport bar,
   `Length` becomes a real end, `Loop` works on first press, the `onTimelineEnd` FSM trigger, global-vs-scene
   legibility + the OSC loop bug. **Live-tested on hardware 2026-07-12 — passed.**
7. ⏳ **asset-paths** *(net-new — [asset-paths plan](archive/asset-paths-scenes-and-audio.md))* — `mapAssetPaths` becomes
   per-container visitors applied to the top level **and each scene**, and starts visiting the bed.
   **Sequenced here deliberately: it is a hard prerequisite for Wave B** (see the dependency graph above),
   and it fixes a portability bug the already-shipped P1–P4 bed introduced.
8. ⏳ **Wave B** *(supersedes P5)* — WS-B1 the show clock · WS-B2 audio lanes in the timeline ·
   WS-B3 the Audio Bed panel becomes the mixer · WS-B4 `audio.*` scene/cue binding (core `paramPath` +
   `StateView` + the cue picker).
9. ⏳ **P6** — multichannel hardening (ASIO, speaker layouts) + headless audio wiring + packaging/CI/licensing

> **Correction to `audio-engine.md` (§WS6), recorded here because it changes the cost of Wave B:** P5's claim
> that scene/state audio binding needs *"no new recall plumbing"* is **false**. The *recall* path is reusable,
> but the *param model* is not extensible: `paramPath.ts` has zero occurrences of "audio", its grammar is
> hardwired to `<head>.<id>.<leaf>`, `StateView` is a closed interface, and — the real trap —
> `automationOverlay.owns()` is a **core-only** Map that the audio plugin's own override map is invisible to,
> so "an automation lane always wins over a scene fade" **cannot be enforced across the plugin boundary today**.
> Wave B has to open that seam.

### Wave 4 — Renderer robustness · branch `wave-4-robustness`
**Surfaced by Wave B's adversarial review, which passed the branch but named these two as structural gaps that
belong in their own wave rather than being smuggled into an audio wave.** Neither is an audio problem; both are
the *structural* answer to a class of defect we have now fixed one instance at a time, three times.

1. [timeline-undo](timeline-undo.md) — **first, because of the edge below.** A history system already exists
   (`useHistory.ts:13`, instantiated once at `App.tsx:109-125`) but its `T` is `Fixture[]`, so
   `handleTimelineChange` (`App.tsx:914-917`) calling `recordHistory()` would deep-clone the *fixtures* array
   and undo nothing. **There is no undo for any timeline edit** — which is what made two Wave B CRITICALs
   lethal rather than merely annoying. Also fixes the **3am line**, which is already half-sprung:
   `handleRecallScene` (`:792`) and `applyCues` (`:980`) *do* call `recordHistory()`, and they are reached by
   the FSM, OSC, the tablet and the scheduler — so an unattended install pushes history entries for changes
   **no human made**, on an **uncapped** stack.
2. [renderer-error-containment](renderer-error-containment.md) — there is **no ErrorBoundary anywhere in the
   renderer**, so every load-path data bug is a white screen. But the thesis is not the boundary: **the
   watchdog is structurally blind to the failure it exists to catch.** `watchdog.ts:143` arms only once
   `lastRenderAt > 0`, and the sole heartbeat emitter is `App.tsx:358` — so a **first-render** throw (exactly
   what a corrupt project file causes) means the heartbeat never fires once and the watchdog **never arms**.
   An unattended install sits dead-white until someone drives to the venue. WS1/WS2 (a renderer-fault IPC
   channel + seeding the watchdog from `did-finish-load`) come *before* any boundary, because alone they turn
   "silently dead forever" into "relaunches, trips the breaker, writes an audit line".

> **The hard edge, and why undo goes first:** error-containment's recovery ladder has a rung that reloads the
> renderer. With document-wide history in place that rung can recover to **the last good document**; without
> it, it can only recover to an **empty** one. Landing containment first means building that rung twice.

**Both plans found live pre-existing bugs while grounding, neither of which is in scope for either:**
`IPC.WINDOW_COMMAND` is **sender-blind** (`ipc.ts:145` calls `getWindow()`), so **the docs window's close
button closes the main editor window** — on the exact channel the recovery ladder rides; and the two
hand-mirrored menus have **already diverged** (`MenuBar.tsx:80-84` lists four plugin panels `menu.ts:78` does
not), which is the cross-cutting hazard the README warns about, already realised.

## Independent track — Docs browser (parallel-safe)

[docs-browser](archive/docs-browser.md) — an in-app, detachable markdown viewer for the examples/tutorials + user
guide. It touches **no wave subsystem** (build config, a new window entry, a markdown dep, additive
menu/IPC), so it can be built on its own branch `feat-docs-browser` **in parallel with any wave** and
merged whenever tested. Recommended alongside Wave 0/1 so the tutorials become viewable in-app early.

## Independent track — MIDI control (parallel-safe)

[midi-control](midi-control.md) — a renderer-only `plugins/midi` (MIDI-learn + remappable bindings) that
drives scenes / cues / states / transport and continuous params through the **same buses OSC uses**. It
touches **no wave subsystem**: two tiny core touches (a Web-MIDI permission grant in `src/main/index.ts`,
and an additive `ProjectData.midiBindings?`), otherwise plugin-local — so it builds on its own branch
`feat-midi-control` **in parallel with any wave**. Pairs naturally with **show-control** (Wave 0), both
being external-control front-ends; its continuous-CC → param path also gains audio targets once Wave 3's
`audio.*` `paramPath` namespace lands (a synergy, not a dependency).

## Independent track — Transport prev/next edit point (small; land after Wave 3)

[transport-edit-point-navigation](transport-edit-point-navigation.md) — the `⏮`/`⏭` buttons from the transport
sketch. **Not a bug: a gap between two plans.** The sketch
([timeline-transport-and-audio-scoping.md:98](archive/timeline-transport-and-audio-scoping.md)) drew four transport
buttons; Wave A's execution plan opened with *"add the three controls that never had a button: Stop, Set In,
Set Out"* and the two skip buttons never entered the task list. Wave A then passed its own acceptance, because
it did everything **its** plan asked. Found 2026-07-13 while running the Wave 3 acceptance script.

It is half a day and 🟢 low risk, but it **must not be smuggled onto `wave-3-audio`**: that branch is mid-
acceptance (Session 2 — *the bed never restarts* — passed 2026-07-13), it touches the same
`TimelineToolbar.tsx`, and nothing about it came out of the audio work. Land it on `feat-transport-skip`
**after** Wave 3 merges. Two hard constraints from the plan's §4, both of which are Wave-3-shaped:

- the seek **must** go through `engine.seek()`, so it inherits the show-clock identity (a seek moves the bed
  **only** while the global doc is bound) rather than reintroducing that bug in a new place;
- the **bed's** clips are **not** edit points — the bed rides the show clock, not the playhead, so seeking the
  playhead to a bed clip edge is a category error that looks right on Global and is nonsense inside a scene.

## Tutorials & docs (interleaved with the waves)

The example/tutorial sets mostly **shadow a wave** — each documents a subsystem a wave changes, so it is
written *after* its wave lands (documenting the fixed behavior, and doubling as that wave's acceptance
test). Only the wave-independent ones are written ahead.

| Tutorial set | Write after | Why |
|---|---|---|
| **LiDAR blobs without a LiDAR** | **now** (wave-independent) | touches OSC/tracking/takes — no plan modifies these |
| Media-Free Motion Graphics (core) | now / after Wave 2 | video story stable; add an audio+automation chapter after Wave 3 |
| Operator Remote · Ship It (watchdog) | Wave 0 | show-control tablet parity · watchdog throttle |
| MIDI control (map a controller) | after the MIDI plugin | learn + remap a pad/fader to scenes/params — wave-independent |
| Cue Deck · Patch & Prove (DMX) · Pack & Hand Off · Composite Stage · Ship It (headless) | Wave 1 | cue-authoring · dmx-io · asset-ops · webgl-strict · headless-plugin-host |
| Wiring Rescue · Hello Projector · Patch & Prove (autopatch) | Wave 2 | fixture-segments · content-source + projector-blend · autopatch |
| Audio tutorial · Motion-Graphics audio chapter | Wave 3 | the audio subsystem |

## ⛔ THE WAVE 3 MERGE GATE — what must be true before `wave-3-audio` → `main`

Wave 3 is the largest wave to date and the only one that adds a **non-Rust native module**. It is fully
implemented and adversarially reviewed, and **it is not mergeable yet.** Six things must be true. Nothing
else is on the critical path; everything else is post-merge.

> ⚠ **This table was written before the merge review existed, and gate 6 is the one it could not know
> about.** A 16-agent adversarial review of the full `main...wave-3-audio` diff (2026-07-14) confirmed
> **39 findings, 7 of them blockers** — including two that would snap the house volume on every GO. Read
> gate 6 before you trust the five rows above it. **Gate 2 was also marked ✅ and was not** (see its row).

| # | Gate | Why it blocks the merge | Status |
|---|------|--------------------------|--------|
| **1** | **The build system builds the audio engine** | `npm run build:native` was **cargo-only**. The JUCE addon had only ever been built by hand (`npx cmake-js build`). CI ran `build:native`, so it didn't build it either — and `extraResources` didn't ship it. The loader **graceful-degrades silently**, so the app started, the whole audio UI rendered, and there was no sound and no error. **CI fires on `v*` tags and its release job publishes installers: tagging would have shipped a complete audio UI with no sound in it.** | ✅ **landed `a7ba256`** — new `build:audio` (`scripts/build-audio.cjs`), a `--check` gate on packaging, the CI step, and `extraResources`. **Confirm in Session 0.1/0.2 of the acceptance script.** |
| **2** | **It is documented** | `docs/DEVELOPMENT.md:32,:41` and `CLAUDE.md:55` all said `build:native` "builds both Rust crates" — wrong twice over (there are three, and the JUCE engine is not one of them). A fresh clone got a silent app and no way to know why. Must also carry the two traps: `cargo` is not on PATH by default, and **the dev app must be CLOSED for any native rebuild** (a running app locks `audio_engine.node`, the link fails with LNK1104, and it *silently leaves the stale `.node` in place*, so a working fix looks broken). | ✅ **landed `a7ba256`** — `DEVELOPMENT.md` + `CLAUDE.md` corrected, both traps documented, plus a "no sound?" troubleshooting entry. ⚠ **Then silently re-broken by `473d259` and re-fixed 2026-07-14 (`7f3e1a1`).** That commit made `npm run package` *build* the engine (dropping `--check`) and left `DEVELOPMENT.md:99` describing the old contract — *"packaging does not rebuild the engine"* — so the document told you to do something unnecessary and, worse, told you the build worked in a way it no longer did. **This row said ✅ the whole time.** A gate whose subject is "the docs are true" cannot be closed once and left; the merge review is what caught it. |
| **3** | **The manual acceptance script passes** | Wave B is code-complete, all four gates green, and adversarially reviewed to a verdict of *sound for an unattended installation* — but **no human has run it.** ▶ **[docs/superpowers/2026-07-12-wave-3-acceptance.md](../docs/superpowers/2026-07-12-wave-3-acceptance.md)** — 13 sessions (~8 h, splittable), **34 [BLOCKER] tests**, every test traced to the defect it guards. Sessions 0–5 + 10 are the merge-deciding subset if only one evening is available. The one that matters most: a long bed + three scenes, GO between them, **the bed must not restart**. | ⏳ **user** |
| **4** | **The JUCE / libspatialaudio licensing call is made** | JUCE is free under **$20k/yr revenue**; above it, **$800 perpetual Indie** — otherwise it is **AGPL, which is viral**. libspatialaudio is **LGPL-2.1** (dynamic-link or comply). This does not block the *merge*; it blocks the **first tag after audio is packaged**, which gate 1 makes possible. Decide it before it ambushes a release. Record the obligations in `README.md` / `NOTICE`. | ⏳ **user** |
| **5** | **FX + spatial on a SCENE's audio clips** *(added 2026-07-13 — found by the user in live testing)* | **A hole in Wave B.** Wave B shipped a second audio container (`Timeline.audio`) in which **neither of the engine's two headline features can be used**. The engine has exactly two insert points and one of them is *the clip* — so this is not a missing control, it is half the engine absent from half the containers. The cause is not the engine (`AudioClip.effects`/`.spatial` are persisted for both containers and the driver already pushes both): the **mixer is a plugin and the SDK gave it no writer for a core timeline document**, so the inspector hard-disabled itself for a timeline selection. And because `timelineBedProp` is undefined under a bound scene, **the inspector was inert for 100% of the time the feature is used**. ⚠ Ships with a driver fix it makes audible: clip ids are **byte-identical across scenes** (Capture Scene deep-clones), so the FX/spatial push-cache is never invalidated on a recall and a clip would sound **with the outgoing scene's reverb and position on every GO**. | ✅ **landed** `f335263`…`8904682` — the write path (SDK `patchTimelineClip` → App's owner-router → the inspector), the stale-chain fix, scene-prefixed track names (**drawn, never stored** — baking them in goes stale on rename and is actively wrong after Capture Scene's deep-clone), and the mixer hardened against the two clip fields nobody normalizes. Adversarial pass: **sound to test on hardware.** |
| **6** | **The merge review's blockers are fixed** *(added 2026-07-14 — and this is the gate the five rows above did not know existed)* | A **16-agent adversarial review of the full merge diff** (`main...wave-3-audio` — 100 commits, 72 code files, ~11k lines) confirmed **39 findings: 7 blockers, 21 majors, 11 minors**, verified 3-lens (default REFUTED; a majority had to refute to kill one). The two that decide the merge are **automation-clock blockers**: `compileAutomation` picked a lane's clock by *document identity*, which held only under an unstated invariant that **three separate writers broke** — so a house fade on `audio.master.gain` was retagged to the scene clock, shadowed the real base lane by `targetPath`, and **snapped the master from 0.32 to 0.97 in one frame (+9.6 dB) on every GO, then persisted it to disk.** No fix inside `timeline.ts` could work: by the time it ran, the impostor lane was byte-identical to one the operator had drawn. The cure was to **delete the state** — `Scene.timeline` is now required, which makes two of the three writers structurally impossible. ▶ **[the plan](../docs/superpowers/plans/2026-07-14-wave-3-merge-blockers.md)** (14 tasks). Everything else → Wave 4 (see `plans/README.md`). | ✅ **ALL 14 TASKS LANDED** (`9607ce1`…`5eb821d`, 2026-07-14) — atomic save · junk-`effects` crash-on-load · **New Project** · the Length edit that split the two clocks · `Scene.timeline` required · Capture Scene stealing the global lanes · the global lane now **visible** under a bound scene (dimmed, badged, read-only, struck through when overridden) · effect surfaces on the **show clock** · **the mixer's faders show what is SOUNDING, not what the document says** · a dragged keyframe shows its value · `prepareToPlay` off the audio lock · a dead output device is seen, said and recoverable. **Automated gates + 9 sims green, including `build:audio`.** **EVERY MERGE-DECIDING TEST HAS NOW BEEN RUN BY HAND AND PASSED (2026-07-14). NONE IS OUTSTANDING.** **4.7** (the master must not snap on a GO after Capture Scene — *the* blocker) · **4.7b** (the GLOBAL badge) · **2.8b** (pause freezes the picture) · **2.8c** (New Project goes silent — it **failed** first time and turned up two further defects, including that *every* New Project ever made had been written to disk with the previous show's audio bed in it) · **2.9** (the bed across ten GOs — **no click**) · **2.10** (kill the output device mid-show — the badge appeared, Preferences stopped claiming the engine was active, Reconnect restored sound with no restart). ⚠ **2.10 nearly shipped unverified**, on a written-out argument that the change was *"a strict no-op while a device is alive"* — sound reasoning, and no substitute for running it. It turned out to **need no hardware at all**: Windows ▸ Sound ▸ *Don't allow* drives `getCurrentAudioDevice()` to `nullptr` down the identical path. *"I don't have the hardware"* was never the blocker; not looking for a way to fake it was. ⚠⚠ **And two of the 14 tasks were found by the USER, in the app, AFTER the 16-agent review had passed the branch** — the mixer's faders drew the document while the engine played the automation, and New Project left the outgoing show's whole timeline behind (the review saw a third of it). **A review that reads code cannot hear a room, and cannot watch a slider fail to move.** |

**What is NOT a merge blocker** (deliberately — do not let these grow into one):
- **Wave 4** (undo → error containment). Pre-existing gaps, not Wave 3 regressions.
- **P6** (multichannel/ASIO hardening, speaker layouts, headless audio wiring). Wave 3 ships stereo + binaural.
- The two loose bugs Wave 4's grounding found (`IPC.WINDOW_COMMAND` is sender-blind → **the docs window's close
  button closes the main editor window**; the two menus have already diverged).
- The webgl-strict **Phase 2** decision (long-standing, gates two Wave 2 plans).

### After the merge, in this order
1. **Wave 4 — renderer robustness** (`timeline-undo` → `renderer-error-containment`). **The highest-value item
   in the entire backlog for an unattended install: the watchdog cannot see a white screen.** A first-render
   throw means the heartbeat never fires, so the watchdog never arms, and the venue sits dead until someone
   drives there.
2. **P6** — multichannel hardening (ASIO, speaker layouts) + headless audio wiring.
3. The two loose bugs above, and the webgl-strict Phase 2 decision.
4. **[Transport prev/next edit point](transport-edit-point-navigation.md)** (`feat-transport-skip`) — half a day,
   🟢 low. Held only because it touches `TimelineToolbar.tsx`, which Wave 3 is still sitting on.
5. **MIDI control** (independent, parallel-safe at any point).

## Verification gate (what "done, ready to test" means, per wave)

Before I hand a wave to you:
- `npx tsc -p tsconfig.json --noEmit` clean across the whole tree.
- `npm run build` succeeds (main + preload + renderer); `npm run build:native` if a native module changed.
- `npm run dev` smoke test + **each plan's own §8 verification** exercised (e.g. dgram ArtDmx listener for
  output plans, a `.artlux` fixture for render/cue plans, forced-crash for the watchdog, the JUCE spike +
  audible playback/meters for audio).
- Graceful-degrade checks for any native change (rename the `.node`, confirm no crash).
Then **you** test end-to-end; on your go, I merge to `main`.

## Execution protocol (instructions to Claude — follow exactly)

When told *"execute Wave N"* (or "continue Wave N"):
1. **Check prerequisites:** confirm Wave N−1 is merged to `main` (git log / the Status tracker below). If a
   hard-dependency plan isn't on `main` yet, stop and flag it — do not build on unmerged code.
2. **Branch:** from up-to-date `main`, create `wave-<n>-<slug>` (only on the user's go to start the wave).
3. **Implement** the wave's plans **in the listed order**, each as its own small `tsc`-clean commit,
   following that plan's §4 design and reusing the functions/files it names.
4. **Verify:** run the wave gate above; report results (what passed, what you exercised, anything skipped).
5. **Stop before merging.** Hand off for the user's testing. Do **not** merge, push, or start the next wave.
6. **On the user's "merge Wave N" go:** merge to `main`, delete the wave branch, tick the Status tracker in
   this file, and stop until told to start the next wave.
Keep `main` buildable + `tsc`-clean at all times. Never push to a remote or skip hooks without an explicit ask.

## Status tracker

| Wave | Branch | Plans | Status |
|---|---|---|---|
| 0 | `wave-0-quick-wins` (merged, deleted) | watchdog, show-control-tablet-parity | ☑ **merged to main 2026-07-11** — **watchdog** minRelaunchGapSec pacing (first relaunch instant, 2nd+ deferred-not-dropped) + Preferences field; **show-control** tablet multi-bank + per-cue fire + Kick hard-cuts SSE. tsc+build+verify:plugins + adversarial review clean. |
| 1 | `wave-1-foundation` (merged, deleted) | webgl-strict, dmx-io, cue-authoring, asset-ops, headless-plugin-host | ☑ **merged + pushed 2026-07-11** — cue-authoring, dmx-io, asset-ops, headless-plugin-host landed + adversarially reviewed (headless NVAPI-gate finding fixed). **webgl-strict = Phase 1 only** (reduced-mode banner + `forceWebGL` localStorage flag + GPU settings section); **Phase 2 (GPUMapper per-surface parity) DEFERRED** pending multi-machine testing. |
| 2 | `wave-2-render-output` (merged, deleted) | fixture-segments, content-source-region, projector-blend, autopatch | ◑ **partially merged + pushed 2026-07-11** — **fixture-segments** (segment gap/off; **verified live on-wire** — middle third → 0) + **autopatch** (collision detector always-on + opt-in locked-range reservation) landed. **content-source-region + projector-blend HELD behind webgl-strict Phase 2**; autopatch **Phase C (split-brain write-back) deferred**. |
| 3 | `wave-3-audio` (in flight, unmerged) | audio-engine (P0→P6) + transport-and-scoping (supersedes P5) + asset-paths | ◑ **in progress** — **P0–P4 shipped** (JUCE/libspatialaudio addon, bed, ambisonic + spatial UI, juce_dsp FX, the core automation-curve engine). **Wave A shipped + live-tested 2026-07-12** (bounded clock, working Loop, Stop/in/out, `onTimelineEnd`, scene-vs-global legibility) — 4 blockers + an 11-item punch list found by adversarial review and fixed. **Next: asset-paths → Wave B → P6.** |
| — | `feat-docs-browser` | docs-browser (independent, parallel-safe) | ☑ **shipped v0.21.0** — reader + detachable window + inline user-guide images + tutorial SVG diagrams; bundled into packaged builds via `extraResources` (23/23 image refs validated, tsc+build clean, in-app visual test confirmed). Getting-started fold-in still pending. |
| 4 | `wave-4-robustness` | timeline-undo → renderer-error-containment | ☐ not started (Drafts — both plans written 2026-07-12, surfaced by Wave B's adversarial review). **`timeline-undo` first** (the last-good-document edge). Highest-value single item in the whole backlog for an unattended install: **the watchdog cannot see a white screen.** |
| — | `feat-transport-skip` | transport-edit-point-navigation | ☐ not started (Draft — plan written 2026-07-13). The `⏮`/`⏭` buttons were **in the Wave A sketch and never entered the Wave A plan**; the capability (prev/next edit point) does not exist at all. Held until `wave-3-audio` merges — same file. |
| — | `feat-midi-control` | midi-control (independent, parallel-safe) | ☐ not started (Draft — plan written) |
| — | (content, no branch gate) | LiDAR + state-machine tutorial sets | ☑ drafted; **SVG diagrams added** (state-graph, hub-and-spoke, tracking-zones, merge-people) — all 23 doc image refs resolve + read, 4/4 SVGs valid; needs in-app open test |

*Update the Status cell to `☐ in progress (branch cut)` → `☑ merged <date>` as each wave lands. As of
2026-07-12: Waves 0–2 are merged to `main`; **Wave 3 is in flight on `wave-3-audio` and is NOT merged** —
P0–P4 and Wave A are on that branch, live-tested but unmerged, and asset-paths → Wave B → P6 remain.
Still Draft: midi-control, and the webgl-strict / content-source-region / projector-blend Phase-2 render work.*
