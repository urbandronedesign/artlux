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

## The plans

| # | Plan | Lifts (tutorial set) | Placement | Risk | Breaking | Effort |
|---|------|----------------------|-----------|------|----------|--------|
| 1 | [Cue-authoring robustness](cue-authoring-robustness.md) | #4 Cue Deck | **Core** | 🟢 Low | None | S |
| 2 | [DMX I/O fidelity](dmx-io-fidelity.md) | #6 Patch & Prove | **Core** | 🟢 Low | None | S |
| 3 | [Asset-ops safety](asset-ops-safety.md) | #9 Pack & Hand Off | **Core** | 🟢 Low | None | S–M |
| 4 | [Watchdog relaunch throttle](watchdog-relaunch-throttle.md) | #10 Ship It | **Core** | 🟢 Low | Behavior + UI | S |
| 5 | [Finish fixture segments](fixture-segments-finish.md) | #3 Wiring Rescue | **Core** | 🟡 Med | Project-file (additive `Segment.off`) | M |
| 6 | [Content source-region (crop)](content-source-region.md) | #5 Hello Projector | **Core** | 🟡 Med | None (additive field) | M |
| 7 | [Auto-patch collision detection](autopatch-collision-detection.md) | #6 Patch & Prove | **Core** | 🟡 Med | Project-file (reservation re-addresses) | M |
| 8 | [WebGL strict per-surface sampling](webgl-strict-per-surface-sampling.md) | #1 Composite Stage | **Core** | 🟡 Med | None | L |
| 9 | [Show-control tablet parity](show-control-tablet-parity.md) | #7 Operator Remote | **Plugin** | 🟡 Med | Behavior (Kick hard-cuts SSE) | M |
| 10 | [Projector blend preview + phase-lock](projector-blend-preview.md) | #5 Hello Projector | **Hybrid** | 🟡 Med | IPC (additive transport field) | M–L |
| 11 | [Schedule/show engine under `--headless`](headless-plugin-host.md) | #10 Ship It | **Core** | 🟡 Med | Build-tooling / operational | M |

No plan is rated High risk, but three carry non-obvious blast radius — see **Cross-cutting hazards** below.

## Net-new subsystems (beyond limitation-lifts)

The plans above lift *existing* limitations. This one designs a whole new capability the app lacks entirely:

| Plan | Adds | Placement | Risk | Breaking |
|------|------|-----------|------|----------|
| [Native audio engine](audio-engine.md) | Spatial multichannel audio: JUCE + libspatialaudio (ambisonic bus → binaural-HRTF stereo or 8-ch speaker decode), effect chains, **timeline automation**, scene/state recall | **Hybrid** (core types + core automation-curve engine + core timeline lane; JUCE engine + spatial UI as `plugins/audio`) | 🔴 High | Project-file (additive) + **first C++/CMake native module** + JUCE/libspatialaudio licensing |
| [In-app docs browser](docs-browser.md) | Detachable in-app markdown viewer for the examples/tutorials + user guide, with interactive "open example" that loads the `.artlux` | **Core** | 🟡 Medium | Build/packaging (ships docs/examples) + new markdown dep + additive menu/IPC/window; no project-file change |

Two things make it heavier than any lift-plan: it introduces the **first non-Rust native module** (a JUCE C++ N-API addon alongside the Rust crates), and it requires building a **general time-keyframed automation-curve engine** — which does not exist today (scenes/cues are snapshot+fade only) and is itself a substantial core subsystem worth having beyond audio. It is gated behind a Phase-0 toolchain spike and the usual graceful-degrade loader, so the tree stays releasable throughout. Decided route: fully-native JUCE substrate, ambisonic-bus spatialisation, core-types + plugin-engine placement, and a global audio bed + per-scene one-shots.

## Recommended sequencing

**Wave 1 — low-risk correctness (do first; each is self-contained, none breaks the project file).**
`cue-authoring-robustness` (also fixes a real Stage **crash** when capturing a cue on a segmentless
fixture — highest value/effort ratio here), `dmx-io-fidelity`, `asset-ops-safety`, `watchdog-relaunch-throttle`.

**Wave 2 — core capability, additive schema (each ships "dark" until used).**
`fixture-segments-finish`, `content-source-region`, `autopatch-collision-detection`, `webgl-strict-per-surface-sampling`.
Order within the wave by need; `webgl-…` is the largest (it re-derives per-LED geometry in a second backend).

**Wave 3 — larger surface / more churn (plan the rollout carefully).**
`show-control-tablet-parity` (plugin-only, but the Kick→SSE fix touches the auth/streaming boundary),
`projector-blend-preview` (adds an IPC transport field + a new WebGL preview path),
`headless-plugin-host` (**most invasive** — the hardened plan retires `headless.html`/`headless.tsx`/
`HeadlessRunner` and routes `--headless` through the full App entry; it gains media decode and the
always-on show-control HTTP port as an operational/firewall surprise — read §7 before committing).

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
