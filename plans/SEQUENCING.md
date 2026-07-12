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
```
Everything else is independent. **Hottest shared file:** `Stage.tsx` (6 plans) — sequence its editors
before audio's additive apply-hook. `types.ts` (5 plans) and `paramPath.ts` (3) overlap too, but additively.

**Why `asset-paths ──▶ Wave B` is hard, not cosmetic.** Wave B adds `Timeline.audio` — a new
path-bearing container on **every** timeline (the global one *and* each scene's).
[asset-paths-scenes-and-audio](asset-paths-scenes-and-audio.md) restructures `projectFolder.mapAssetPaths`
from an inline walker into per-container visitors applied to both the top level and each scene. Build
Wave B first and the audio path field gets added to the one branch that exists today
(`projectFolder.ts:67`, which also **skips an audio-only timeline entirely**), scene timelines stay
invisible, and the extraction then has to re-remember it — precisely the failure that plan exists to
kill. It is also **already broken, today, on `wave-3-audio`**: `data.audio` (the bed, shipped in P1–P4)
is never visited at all, so bed paths save absolute and Collect Assets neither copies nor reports them.

## The waves

### Wave 0 — Quick isolated wins · branch `wave-0-quick-wins`
Zero shared-file overlap with anything; fast confidence-builders.
1. [watchdog-relaunch-throttle](watchdog-relaunch-throttle.md) — `watchdog.ts`, `Preferences.tsx` (isolated)
2. [show-control-tablet-parity](show-control-tablet-parity.md) — `plugins/show-control/*` only (isolated)

### Wave 1 — Foundation hardening · branch `wave-1-foundation`
Each hardens code a later wave (or audio) builds on. Suggested intra-wave order minimizes `Stage.tsx` churn:
1. [webgl-strict-per-surface-sampling](webgl-strict-per-surface-sampling.md) — render backend parity *(unblocks Wave 2 render plans)*
2. [dmx-io-fidelity](dmx-io-fidelity.md) — `Stage.tsx` dest/wire path *(unblocks autopatch)*
3. [cue-authoring-robustness](cue-authoring-robustness.md) — fixes `paramPath.setIn` + recall/cue path *(unblocks audio)*
4. [asset-ops-safety](asset-ops-safety.md) — hardens `projectFolder.ts` asset pipeline *(unblocks audio asset category)*
5. [headless-plugin-host](headless-plugin-host.md) — restructures the headless entry *(unblocks audio headless phase)*

### Wave 2 — Render & output build-out · branch `wave-2-render-output`
Consume Wave 1's hardened render/dest paths.
1. [fixture-segments-finish](fixture-segments-finish.md) — render-path; no hard dep but co-located to batch `Stage.tsx`/`WebGPUMapper` churn
2. [content-source-region](content-source-region.md) — **after** webgl-strict
3. [projector-blend-preview](projector-blend-preview.md) — **after** webgl-strict
4. [autopatch-collision-detection](autopatch-collision-detection.md) — **after** dmx-io-fidelity

### Wave 3 — Audio subsystem · branch `wave-3-audio` (large — the whole wave lives on one long-running branch)
The [audio engine](audio-engine.md), landed on the now-hardened foundations. **Two plans govern this wave:**
`audio-engine.md` for P0–P4 and P6, and
[timeline-transport-and-audio-scoping](timeline-transport-and-audio-scoping.md), which **supersedes P5**
and prepends a net-new **Wave A** (the transport work P5 turned out to be blocked on). The revised
internal order — *the ✅ phases are on the branch, unmerged*:

1. ✅ **P0 spike** — JUCE + libspatialaudio C++ N-API addon builds & plays a file in Electron 42
2. ✅ **P1** — core audio types + audio asset category + stereo playback (global timeline) + device settings
3. ✅ **P2** — ambisonic bus + libspatialaudio (binaural first, then speaker decode) + spatial UI
4. ✅ **P3** — effect chains (juce_dsp) + effect params
5. ✅ **P4** — the core **automation-curve engine** + timeline automation lanes
6. ✅ **Wave A** *(net-new — [transport plan](timeline-transport-and-audio-scoping.md))* — the transport bar,
   `Length` becomes a real end, `Loop` works on first press, the `onTimelineEnd` FSM trigger, global-vs-scene
   legibility + the OSC loop bug. **Live-tested on hardware 2026-07-12 — passed.**
7. ⏳ **asset-paths** *(net-new — [asset-paths plan](asset-paths-scenes-and-audio.md))* — `mapAssetPaths` becomes
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

## Independent track — Docs browser (parallel-safe)

[docs-browser](docs-browser.md) — an in-app, detachable markdown viewer for the examples/tutorials + user
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
| — | `feat-midi-control` | midi-control (independent, parallel-safe) | ☐ not started (Draft — plan written) |
| — | (content, no branch gate) | LiDAR + state-machine tutorial sets | ☑ drafted; **SVG diagrams added** (state-graph, hub-and-spoke, tracking-zones, merge-people) — all 23 doc image refs resolve + read, 4/4 SVGs valid; needs in-app open test |

*Update the Status cell to `☐ in progress (branch cut)` → `☑ merged <date>` as each wave lands. As of
2026-07-12: Waves 0–2 are merged to `main`; **Wave 3 is in flight on `wave-3-audio` and is NOT merged** —
P0–P4 and Wave A are on that branch, live-tested but unmerged, and asset-paths → Wave B → P6 remain.
Still Draft: midi-control, and the webgl-strict / content-source-region / projector-blend Phase-2 render work.*
