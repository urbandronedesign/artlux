# One colour per fixture on the timeline — the colour track

> **Status: P0–P3 BUILT. Shape decided with the owner 2026-09-25.** P4 (shadow reporting) and
> P5 (group colour) remain.
>
> `src/renderer/services/colorEngine.ts` ships the solver, the per-mode capability, the colour
> spaces and the memo — pure, no UI, nothing wired to playback yet. Guarded by a new invariant (the
> emitter table has one owner and the inverse reads *that* copy) and by
> `scripts/test-color-engine.cjs`, now part of `npm run verify`: it drives **all 791 additive mixing
> modes in the shipped library** through the solver AND back through `resolveFixture`, and every one
> reproduces all 13 reference colours within 2% (worst 1.3%).
>
> Goal, in the owner's words: *"every params of a fixture is exposed on the timeline so 3 or 4
> channels for colors, it is not easy to work like this. Instead I would like to have a track for the
> color and a visual feedback of the chosen color. I need also a way to interpolate with various
> modes bezier etc. The fixtures are usually rgb or rgbw so the track must adapt to each."*

Companion to [fixture-super-track.md](fixture-super-track.md) (what the per-channel track is, and the
address-space decision that shipped) and [lighting-rework-status.md](lighting-rework-status.md). Read
the traps in the first one; they all still apply and are not repeated here except where colour
changes them.

---

## What is wrong today

A colour is **one decision** and the super track makes it three or four unrelated numbers. For an
RGBW head the COLOUR group is four rows of `0..1`, nothing on screen says what colour they add up to,
and each row interpolates independently — which is why a red→blue fade passes through dark muddy
intermediates instead of the path anyone meant. The fixture *does* publish a resolved colour
(`FixtureState.r/g/b`, what the 3D beam is drawn with); the timeline just never shows it.

**This is the volume case, not an edge case.** Measured over the 1662 shipped modes: 224 RGBW,
172 RGB, plus 203 more with a fourth/fifth emitter (RGBA, RGBWA, RGBWA+UV).

---

## The three questions, and what the measurements say

### 1. What does the track OFFER? — the control is FIXTURE-DERIVED, not just the fan-out

The obvious reading of *"the track must adapt"* is "drive 3 channels or 4". That is the easy half.
The half that decides whether this feature is honest is **what the operator is allowed to author**.

A feasibility probe solved 12 reference colours per emitter family with a box-constrained NNLS, drove
the real `resolveFixture` with the result, and compared the rendered colour back (probe kept in the
scratchpad; re-derive with `src/renderer/services/fixtureSignal` + the library JSON):

| Emitter set | Worst hue error over 12 colours |
|---|---|
| RGB · RGBW · RGBA · RGB+WW | **0%** — exact |
| RGBWA+UV (hex) | ≤ 1% |
| **CW/WW** | **up to 100%** |

The CW/WW row is not a solver defect: **a tuneable-white fixture cannot make green.** Give it a hue
wheel and every colour outside the warm↔cold line is a value the operator authored and the rig will
never produce — the exact "it looked right and the heads never changed" failure the CMY bridge was
written for. So the control adapts:

| The mode has | The row offers | Modes |
|---|---|---|
| red+green+blue (± white/amber/UV/lime/indigo) | hue + saturation picker, solved onto every emitter | ~600 |
| **`colorTemp` fader only** | **warm ↔ cold slider** (normalised — see trap H) | **247** |
| coldWhite + warmWhite | warm ↔ cold slider, driving the two emitters | 13 |
| cyan/magenta/yellow, no primaries (discharge head) | hue + saturation, through the existing CMY bridge | 62 |
| `colorWheel` | **slot picker with swatches** — discrete, snaps (1422 of 2152 slots carry a hex) | 135 + 54 combined |
| nothing | **no colour row at all** | 372 |

### 2. What does it STORE? — the one real decision in this plan

**DECIDED 2026-09-25 (owner): a first-class colour lane**, `fixtures.<id>.color`, holding colour
keyframes. The cheaper view-over-lanes route was offered and declined, knowing the cost below.

The alternative — a *view* that writes the existing per-channel `fixtures.<id>.dmx.<key>` lanes — is
cheaper, needs no persisted format, and matches the address-space decision that shipped for the super
track. It buys the swatch and the single control immediately. **It cannot deliver the interpolation
half**, and that is what rules it out as the destination: four independent scalar lanes interpolate
per channel by construction, so a colour path through HSV or a perceptual space is unreachable
without baking dense keys nobody can then edit. It also breaks on retarget — channel keys are
fixture-specific, a colour is not.

Costs, stated up front: a new persisted shape; a precedence rule against per-channel lanes on the
same channels (trap A); and the solver runs at playback (cheap — 3 equations, ≤7 unknowns, memoised
per mode+colour, and it is only re-solved when the colour changes).

Shape, reusing `Keyframe`'s time axis so **everything already true of a keyframe stays true**
(`t`, `curve: linear | hold | bezier`, `cx1/cy1/cx2/cy2`):

```ts
interface ColorKey extends Omit<Keyframe, 'v'> {
  /** Authored colour, fixture-independent. Hue/sat for a mixing head; 0..1 warm→cold for a CCT head. */
  c: { h: number; s: number } | { cct: number } | { slot: number };
}
```

The *brightness* axis is deliberately absent: the dimmer already owns it, on its own row, and a
colour that also carried intensity would fight it. That is the same separation `resolveFixture`
already makes (`intensity` vs `r/g/b`).

### 3. Where does a colour become channels? — `frameEngine`'s `roleOverride`

There are three candidate seams; one is already doing this job. `frameEngine.ts:660-684` builds a
`RoleOverride` that is called **per channel**, is handed the `ProfileChannel`, and already answers a
question about a *different* role than the one it was asked about — that is exactly what
`CMY_FROM_RGB` is. It is also the only seam that knows the target fixture's profile and mode, which
is what the solver needs. `lightingPlayback` and `lightingSequence.compile` both lack profile access
and would have to have it threaded in.

**The colour track therefore generalises the CMY bridge rather than adding a second mechanism.**

---

## Interpolation — three gaps, and only one of them is "a new feature"

`sampleLane` (`services/automation.ts:95`) is the **single sampler** in the app: automation lanes and
lighting takes both go through it, and it offers `linear` / `hold` / `bezier` (+ a `log` axis). So
"various modes" is partly *already built and simply not reachable*:

| Gap | State today |
|---|---|
| **Per-key mode on a LIGHTING key** | `LightingKey.curve` and `LightingKey.roleCurves` **exist in the type, are honoured by the compiler** (`lightingSequence.ts:71-77`) and **have no UI writer anywhere** — `grep` finds only the declaration, the consumer and one doc line. A pose key can only ever be `linear`. |
| **Editable bezier** | `bezier` is one fixed CSS-style ease (`BEZ_DEFAULT = .42,0,.58,1`). **There is no handle-dragging UI** — handles only ever come from that constant or from the busk fitter. So "bezier" today means one shape, not a curve you can shape. |
| **Colour path** | Genuinely absent. Four scalar lanes lerp independently, which *is* RGB interpolation. |

**DECIDED 2026-09-25 (owner): all three**, in this order of cheapness — note that (2) is not a colour
feature at all and lands for every lane in the app:

1. expose the existing `curve` per key in the colour row (and, free, on pose keys — first writer);
2. **draggable bezier handles** in `CurveEditor`, which every lane in the app inherits;
3. a `space` field on the key — `rgb` (today's behaviour), `hsv` (round the wheel), `oklab`
   (perceptually even). Red→blue in `rgb` passes through dark, in `hsv` through magenta, in `oklab`
   holds its brightness. Default `oklab` for mixing heads; temperature rows interpolate in CCT.

---

## The traps

**A. A per-channel lane silently wins.** `frameEngine.ts:621` returns `undefined` from the role
override when `automationOverlay.owns('fixtures.<id>.dmx.<key>')`. An operator who once drew a Blue
lane gets a colour track that looks live and a head that never changes colour. **The colour row must
report the conflict per channel** ("Blue: overridden by a lane"), and offer to absorb it. Same
treatment the super track owes traps A/B.

**B. Solve once per colour, not once per channel per frame.** The override is invoked per channel;
solving inside it would run NNLS 4× per fixture per frame. Memoise on `(mode, authored colour)` — the
mode object is already a stable WeakMap key beside `colorModel`.

**C. Out-of-gamut must be visible, never silently clamped.** Even on a mixing head, a saturated
colour at full is often unreachable. The swatch shows authored vs achievable when they differ.

**D. Commit on release.** Dragging the picker must follow the rig through the **live** path and write
the document once, or every pointermove recompiles the timeline (`AutomationLane`'s existing rule).

**E. `--headless` / `--broadcast` must be unaffected.** Playback may not depend on any component
being mounted; the solver belongs in a service, not in the row.

**F. Solve against `emit` semantics, not the rendered fold.** `resolveFixture` peak-normalises
`r/g/b` when the sum exceeds 1 (`:306-307`), so a round trip through the fold is lossy while
`emit` is exact. The solver's objective is the unnormalised sum.

**G. `fixtureSignal` is invariant-guarded as the sole owner** of `colorModel`, `roleValue` and the
`SUBTRACTIVE` handling, with checks that match source **text**. A per-mode emitter-role set belongs
beside `colorModel` under the same cache — and expect `verify:invariants` to fire while you move.

**H. `colorTemp` has no physical range in the library** — measured: **0 of 145** `colorTemp` channels
declare `min`/`max`. A CCT control is therefore normalised 0..1 and must be *labelled* warm↔cold, not
"3200 K", until the library carries kelvin. Publishing a fake kelvin number is the `paletteId`
mistake again.

**I. The live swatch must never enter React state.** `Timeline` has a standing rule (`Timeline.tsx:504-513`,
`AutomationLane.tsx:41-45`): a clock in state cost a **measured 224 ms/s** and was removed, so lane
readouts subscribe and write the DOM directly. A swatch that follows the rig is a per-frame value —
it is `el.style.background` from a `fixtureSignal.subscribe`, not `setState`.

**J. The strip must be memoised or painted imperatively.** `AutomationLane` and `FixtureTrack` are
**deliberately not memoised** (measured: lanes 9.5 ms of a 341 ms drag; the ruler and toolbar were the
cost). So the gradient rebuilds on every Timeline render unless it is memoised on
`(keys, width, pxPerSec)` — the fix `AudioLane`'s waveform already needed. There is also **no
virtualisation anywhere** in the timeline, which is the other half of the complaint this plan answers:
four keyed emitter rows are 4 × 64 px of near-identical polylines, all rendered, always.

**K. The row set is a guarded agreement.** `FixtureTrack`'s rows come from `profilePack.modeChannels`,
not a local derivation, so the track and the inspector's channel strip cannot disagree — and that is
invariant-checked. A synthetic colour row is an addition *beside* that set, never a rewrite of it.

---

## What already exists to build on

Almost none of this is new machinery; the feature is mostly *assembly* plus the solver.

| Need | Existing thing |
|---|---|
| which channels are "colour" | `attributeOf(role) === 'Colour'` over `profilePack.modeChannels` — every emitter, `colorTemp` **and** `colorWheel` already map to `Colour` |
| per-frame sampling | `automation.sampleLane` — the single sampler, allocation-free, cursor-based |
| interpolation vocabulary | `CurveKind` + `BEZ_DEFAULT`, shared by lanes and takes |
| emitters → colour | `fixtureSignal.EMITTERS` / `colorModel` / `resolveFixture` |
| colour → emitters | **nothing** — only `CMY_FROM_RGB` (subtractive) and a pixel-only `rgbToRgbw` whose copy in `services/colorUtils.ts` is dead code. **This is the new part.** |
| live colour, render-free | `fixtureSignal.subscribe` + `AutomationLane`'s DOM-write idiom |
| swatch / hex control | `components/ui/ColorField.tsx` — already written, **currently unused anywhere** |
| stops → a 256-sample strip | `gpu/palettes.ts expandGradient` |
| painting a strip along a lane | canvas: `Filmstrip` / `BlobSparkline`; SVG: `AudioLane`'s waveform; CSS: `ClipBlock`'s image strip |
| clickable marks on a lane | `ClipBlock`'s key diamonds — `pointer-events-none` container, `pointer-events-auto` marks |
| per-key popover editor | `CurveEditor`'s portalled popover + `usePopoverAnchor` (an `absolute` popover is documented not to work here) |

---

## Phases

**P0 — `services/colorEngine.ts`, pure, no UI. ✅ DONE.** The per-mode `colorCapability` (which
control this fixture may be offered), the bounded least-squares fit, `hsv`/`oklab`, the wheel match
and the per-mode memo. Two findings worth carrying forward:

- **The iteration cap was a correctness knob, not a performance one.** At 600 iterations 262 of 791
  modes were >2% out and it read as a gamut limit; at 6000 every mode is within 2% **at the same
  cost** (8.2 µs), because the early-out fires immediately for easy cases and only a seven-emitter
  hex fixture crawls. "The fixture cannot make that colour" is a very comfortable wrong answer.
- **The folklore reason for colour spaces is wrong here, and the real one is narrower.** Straight-line
  RGB does *not* go dark in the middle — these are linear emitter values and the dimmer owns
  brightness. What it does is wash **complementary** pairs out to white (red→cyan midpoint: chroma
  0.000). `oklab` is the default because it changes at the most even perceived rate (worst step-ratio
  1.81 vs rgb 4.78, hsv 3.45); `hsv` is the deliberate choice when you want the fade to travel round
  the wheel.

**P1 — The seam. ✅ DONE.** `Timeline.colorLanes` + `normalizeColorLanes`, `services/colorOverlay`
(one colour per fixture, LTP — two sources asking for different colours do not compose),
`services/colorPlayback` (samples every frame even while paused, so scrubbing moves the rig), and the
fan-out in `frameEngine`'s role override, memoised per fixture per frame because the packer asks once
per CHANNEL. Proven on the wire by `scripts/test-color-lane.cjs` — headless, no CDP, so the broken
drag-and-drop step in the take harness is not in the way.

**It found a pre-existing show bug on the way.** The precedence check failed, and a CONTROL assertion
— a lane on a fixture with no colour lane at all — failed too, which is what told "precedence is
wrong" apart from "automation never ran". Fixture profiles load asynchronously, `compileAutomation`
runs before they arrive and drops every lane aimed at `fixtures.<id>.dmx.<key>`, and nothing
recompiled when they landed. In the editor it self-heals invisibly (the next edit of any kind calls
`setData`); **in headless / `--broadcast` nothing ever edits, so every automation curve on a moving
light was dead for the whole show.** One effect on `[fixtureProfiles]` fixes it, and the precedence
assertion then passed unchanged — the colour code had been right all along.

**P2 — The row. ✅ DONE.** `components/timeline/ColorRow.tsx`: the live swatch (a DOM write from a
`fixtureSignal` subscription — never state), the adaptive control, the gradient strip sampled through
the engine's own sampler, a diamond per key, and a portalled per-key editor carrying Ease and Path.
Emitter rows stay underneath and read **▲ Colour** while the row speaks for them.

Three things only a screenshot found, all of them "correct DOM, wrong pixels":
- a fixture whose ONLY authored thing was a colour got **no track at all** — `fixtureTracks` was
  built from automation lanes ∪ selection, so the colour played on the wire with nowhere to edit it;
- the empty-timeline hint card sat **over** the gradient, because `isEmpty` counted clips, automation
  and audio but not colour lanes — the same miss its own comment already describes for audio;
- the emitter rows read `Red 0%` while the fixture was visibly magenta (true — that is the *authored*
  value — and unreadable as anything but a bug).

And one honesty fix: the Path selector is hidden on a temperature, where two keys interpolate along
the warm-cold line and the colour space is ignored.

**P3 — Interpolation. ✅ DONE**, all three gaps:
- the **colour path** (`space`) and its picker landed with P2, and the strip is drawn through the
  engine's own sampler, so the fade on screen is the fade the rig plays;
- **bezier handles are draggable**, in `CurveEditor` — which means every lane in the app, not just
  colour. `bezier` had been one fixed shape (`BEZ_DEFAULT`) with no way to alter it. Handles are
  normalised into the segment's own unit box (the reason moving a neighbouring key never tears a
  curve), shown only for the selected key, and absent on a flat segment where `cy` would divide by
  zero and an ease would be invisible anyway;
- **a pose key's `curve` has a UI at last** — the first writer since the field was added. It was
  honoured by the compiler the whole time and settable by nothing, so every authored look eased
  linearly. `roleCurves` beneath it is still data-only: one control at a time.

Verified by driving the real app: selecting a bezier key reveals two handles, dragging one moves it
~90px and it **stays** there after release (which is what proves the commit, since the draft is
dropped on pointerup), and the drawn path changes. The first version of that check compared the
wrong SVG path in the document and reported "unchanged" while the screenshots plainly showed the
curve reshaping — the assertion was wrong, not the feature.

**P4 — Conflict reporting.** Trap A badges + "absorb this lane into the colour row".

**P5 — (separate decision) group colour.** The same authored colour on a lighting clip over an
ordered group, so one colour drives a mixed rig. Only after P1–P4 prove the shape.

---

## Verification

Pure-logic probes for P0 (solver error per emitter family, byte-level round trip through
`packProfiled`) — the pattern that caught the RGBW capture bug. Then the real app for P2/P3, because
a colour control is a thing you look at: **`scripts/test-lighting-take.cjs` is currently red at its
step 4** (a harness defect, diagnosed in its header on 2026-09-25) and wants fixing first if this
feature is to be proved end to end on the wire.

Usage docs ship in the same commits — [LIGHTING-SHOW.md](../docs/LIGHTING-SHOW.md) (authoring) and
[TIMELINE.md](../docs/TIMELINE.md) (the row), per the documentation gate in CLAUDE.md.

---

## Decisions and what is still open

**Settled with the owner, 2026-09-25:**

| Question | Answer |
|---|---|
| What a key stores | A **real colour**, solved onto the fixture's emitters at playback — not a view over the channel lanes |
| What "various modes" means | **All three**: expose the per-key curve, make bezier handles draggable, add colour-path modes |
| Colour row vs emitter rows | The colour row **sits above them, collapsed by default** — a channel you cannot see is a channel you cannot fix |

**Still open:**

1. **Group colour (P5).** One colour across an ordered group is a different feature from one colour on
   one fixture, and is where the phase-spread machinery lives. Not scoped here.
2. **Named colours.** There is no colour-palette concept for lights today (the `palettes.ts` gradients
   are pixel-effect LUTs, and `paletteId`-as-an-index is already flagged as fragile by the import
   code). A library of named looks exists only as `NamedPose`. Worth deciding before P2 draws a picker.
