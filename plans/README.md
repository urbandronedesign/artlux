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

## Shipped & merged (archived)

Seven plans have landed on `main` and moved to [`archive/`](archive/). Full per-wave record in
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

## Active plans

| Plan | Lifts (tutorial set) | Placement | Risk | Status |
|------|----------------------|-----------|------|--------|
| [Watchdog relaunch throttle](watchdog-relaunch-throttle.md) | #10 Ship It | **Core** | 🟢 Low | Wave 0 — not started |
| [Show-control tablet parity](show-control-tablet-parity.md) | #7 Operator Remote | **Plugin** | 🟡 Med | Wave 0 — not started |
| [Content source-region (crop)](content-source-region.md) | #5 Hello Projector | **Core** | 🟡 Med | held behind webgl-strict Phase 2 |
| [Projector blend preview + phase-lock](projector-blend-preview.md) | #5 Hello Projector | **Hybrid** | 🟡 Med | held (loosely gated on webgl-strict) |
| [WebGL strict per-surface sampling](webgl-strict-per-surface-sampling.md) | #1 Composite Stage | **Core** | 🟡 Med | **Phase 1 shipped** (banner + force-WebGL + GPU settings); **Phase 2 deferred — open GitHub decision issue** |
| [MIDI controller support](midi-control.md) | (net-new) | **Plugin** | 🟡 Med | not started (Draft) |
| [Native audio engine](audio-engine.md) | (net-new, Wave 3) | **Hybrid** | 🔴 High | **P0–P4 shipped** on `wave-3-audio` (bed, spatial, FX, automation); **P5 superseded** by the plan below |
| [Timeline transport + global/scene scoping + audio scene binding](timeline-transport-and-audio-scoping.md) | (net-new, Wave 3) | **Hybrid** | 🟠 Med-High | **Wave A shipped** on `wave-3-audio` (awaiting live test); Wave B next |
| [Asset paths: scenes + audio bed](asset-paths-scenes-and-audio.md) | #9 Pack & Hand Off | **Core** | 🟠 Med | Draft — **Collect Assets ships a broken folder** (surfaced by Wave A's review) |

## Net-new subsystems (beyond limitation-lifts)

Two active plans design whole new capabilities (both in the Active table above):
[MIDI controller support](midi-control.md) and the [Native audio engine](audio-engine.md). Audio is by far
the heaviest — it introduces the **first non-Rust native module** (a JUCE C++ N-API addon alongside the Rust
crates) and a **general time-keyframed automation-curve engine** that doesn't exist today (scenes/cues are
snapshot+fade only). It is gated behind a Phase-0 toolchain spike and the graceful-degrade loader, so the tree
stays releasable throughout. (The [in-app docs browser](archive/docs-browser.md) was the third net-new plan —
shipped in v0.21.0.)

## Sequencing

Build order + git workflow live in **[SEQUENCING.md](SEQUENCING.md)** — the canonical source. Waves 1 + 2 are
shipped (see the archived plans above); **Wave 0** (watchdog + show-control tablet parity) and **Wave 3**
(audio) remain, plus the webgl-strict **Phase 2** decision that gates content-source-region + projector-blend.

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
