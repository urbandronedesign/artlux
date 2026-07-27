# Fixture kinds — dissociating **LED fixtures** from **Light fixtures**

> **Status: ALL WAVES BUILT — 2026-07-27, on `main`, NOT PUSHED.** Rework expected before release; see
> **[lighting-rework-status.md](lighting-rework-status.md)** for what is verified, what is open, and
> where to resume. **Core** (no plugin). Risk 🟡 Med.
>
> Waves A, B, B′, C and D are implemented and verified in the running app. The §10 open questions
> below are answered in the status doc, including two where building revised the plan's own
> recommendation.

## Context — why this, and the decided route

ArtLux has two physically different things called "Fixture", driven by two different wires:

| | **LED fixture** (pixel) | **Light fixture** (profiled) |
|---|---|---|
| What it is | tape, panel, pixel bar — an array of RGB/W cells | moving head, wash, beam, PAR — named DMX parameters |
| Driven by | **sampled pixels** off its `surfaceId`, on the GPU | **authored channel values** in role space (pan/tilt in degrees) |
| Footprint | `ledCount × channelsPerPixel` | the **mode's** footprint |
| Typical wire (this rig) | **Art-Net → LED controller** | **USB-DMX widget (ENTTEC, `protocol: 'enttec'`)** |
| Show encoding | effects/palettes on surfaces, video | `LightingTake` on an ordered group, phase spread |
| 3D | `InstancedLeds` + `FixtureBodies` | `MoverBodies` + `MoverLights` + `Beams` |

**The engine already knows the difference. The app does not.** The frame loop, the footprint owner and
the 3D scene all branch correctly; the *data model*, the *UI*, and the *patch* treat them as one type
with some optional fields. The result is a moving head that offers you a serpentine toggle and a
ledmap upload, and a new head that auto-patches onto the Art-Net node because it happened to be
`controllers[0]`.

**Decided route:** make the kind a **derived first-class concept with one owner** — exactly the shape
`fixtureFootprint()` already has — then push it through selection, the inspector, the browser and the
patch. **No new persisted field on `Fixture`**: `profileId` is already the truth, and a second copy
would be free to drift from it. One *optional* persisted field is added to `Controller` (§WS5),
because "what does this box drive" is genuinely new information no existing field carries.

## Requirements this must satisfy

1. **Zero project migration.** Every `.artlux` on disk loads unchanged and outputs identically.
2. **One owner for the kind predicate**, guarded by `verify:invariants` — the same rule that already
   protects the footprint formula.
3. An operator can tell, **from the browser list without selecting anything**, which fixtures are LED
   and which are lights, and how many of each.
4. A light fixture **never shows a pixel control**, and an LED fixture never shows a channel strip.
5. **A light fixture never appears on the 2D canvas.** It is placed, positioned and driven in the 3D
   scene, and its whole authoring loop — select ▸ place ▸ position ▸ set params ▸ store a key —
   happens without leaving that workbench.
6. A new light fixture **lands on the USB-DMX controller by default**; a new LED fixture lands on the
   Art-Net controller — without the operator repatching by hand every time.
7. Routing/patch must **report** a cross-kind patch, not forbid it (movers over Art-Net is legitimate).
8. Nothing in the frame loop changes. This is a model + UI + patch change; the wire is already right.

## Architecture at a glance

```
services/fixtureKind.ts        ← NEW. The ONE owner.
  type FixtureKind = 'pixel' | 'light'
  fixtureKind(f)               → 'light' iff f.profileId is set        (cheap, no profile map)
  isLight(f) / isPixel(f)
  lightState(f, profiles)      → 'pixel' | 'light' | 'light-unresolved' (the THREE-way truth)
  KIND_LABEL / KIND_ICON       → the user-facing words, in one place

state/EditorStore.tsx  buildSelection()  → emits 'fixture.pixel' / 'fixture.light' alongside 'fixture'
packages/sdk/src/renderer.ts  SelectionKind  += 'fixture.pixel' | 'fixture.light'   (additive)
                              ↓ the shell's existing appliesTo filter needs NO change
contexts/index.tsx     panels re-declared with the narrow appliesTo
services/addressing.ts autoPatch  → kind-aware default controller
renderer/types.ts      Controller.drives?: FixtureKind      (optional ⇒ back-compat)

components/Stage.tsx   renderFixturesList → .filter(isPixel)      ← lights leave the 2D canvas
App.tsx applyProfile   drops surfaceId, writes an explicit position3D
Simulator3D            placement raycast (reuses pickPriority, adds no new rule)
                              ↓
                       …and the loop ends in lighting-keyframes.md §E3 "store the key"
```

The leverage point is `WorkspaceShell.tsx:187`:

```ts
(p) => !p.appliesTo || p.appliesTo.some((k) => selection.kinds.includes(k))
```

It is already a plain set-membership filter. Widening `SelectionKind` and emitting the narrow kinds
from `buildSelection` makes every inspector gate declarative, with **no shell change and no `if
(f.profileId) return null` sprinkled through panel bodies**.

## The evaluation — what is and is not dissociated today

### Already dissociated (do not rebuild)

| Seam | Where |
|---|---|
| DMX footprint | `services/addressing.ts:48` `fixtureFootprint` — single owner, invariant-guarded |
| Universe packing | `engine/frameEngine.ts:595` — `profilePack.packProfiled` vs the pixel/gamma path, and profiled deliberately **skips the gamma LUT** |
| Role/degree state for the 3D scene | `services/fixtureSignal.ts`, published only for profiled |
| 3D rendering | `Simulator3D.tsx:120` splits `pixelFixtures`; `MoverBodies`/`MoverLights`/`Beams` filter the other way |
| Show encoding | `LightingTake` is role-space and only means anything for profiled |
| Wire kinds | `Controller.protocol: 'artnet' | 'sacn' | 'enttec'`, `universeCapacity()`, `destKey()` folding the COM port, `patchOverflow` |
| Library UI | `FixtureEditor`'s **DMX Fixtures / My Templates** tabs — the one place the split is visible today |

### Not dissociated — the findings

**F1 · There is no owner for the kind, and two different predicates are in use.**
Ten files re-derive it. Some test `f.profileId` (`addressing.ts:49`, `frameEngine.ts:595`,
`DMXMonitor.tsx:193`, `automationTargets.core.ts:63`). Others test `f.profileId &&
profiles.has(f.profileId)` (`Simulator3D.tsx:120`, `MoverBodies.tsx:69`, `Beams.tsx:136`,
`MoverLights.tsx:34`). **Those are different questions.** A fixture whose profile did not resolve
(`profileId` set, profile missing — the exact case `fixtureFootprint` returns **0** for, and which
`FixtureProfilePanel:94` already renders a warning for) is *profiled* to the packer and *pixel* to the
3D scene, where it draws as a stray LED sphere. Nothing names this third state.

**F2 · The inspector shows pixel controls on a light fixture — and one of them corrupts the rig.**
Of the eight fixture inspector panels, exactly **one** gates on kind (`FixtureChannelsPanel:157`,
`if (!f?.profileId) return null`). The rest render unconditionally, so a selected moving head offers:

- `FixtureMappingPanel` (`inspector.tsx:274`) — **an editable "LED Count"** ⚠
- `FixtureMappingPanel` — "Surface" (a light does not sample one; `frameEngine` `continue`s first) and
  "Reverse Direction"
- `FixtureOutputPanel` (`:405`) — Line/Matrix, Cols/Rows, Serpentine, colour order, RGBW mode
- `FixtureSegmentsPanel` (`:295`) — segment layout
- `FixtureLayout3DPanel` (`:551`) — LED spacing / arc sweep for a one-emitter fixture

**The LED Count field is a live silent-corruption bug**, not a cosmetic one. `types.ts:129` states
`ledCount` is *pinned to 1* for a profiled fixture, but nothing enforces it: `applyProfile`
(`App.tsx:921`) sets it and `handleUpdateFixture` (`App.tsx:979`) has no clamp. Raise it to 8 on a
mover and:
- the mover's DMX output is **unchanged** (footprint comes from the mode), so nothing looks wrong at
  the head — and
- `frameEngine.ts:607` does `offset += f.ledCount`, so **every fixture patched after it shifts 7 pixels
  in the canonical buffer**. The DMX monitor's pixel strip and the 3D LED colours misalign for the
  whole rest of the rig, with correct Art-Net still on the wire. It is also in `REPATCH_KEYS`, so it
  fires a full auto-patch on the way.
- `Simulator3D` then draws 8 LED spheres inside one housing — the exact thing the `types.ts` comment
  says pinning exists to prevent.

**The inspector is not the only door.** `RoutingModal.tsx:213` has an editable **LEDs** column and
`:208` a **Channels (RGB/RGBW)** column, both rendered for every row including a moving head. So F2
has two independent entry points, which is precisely why the fix cannot be "gate the panels" alone —
the `handleUpdateFixture` clamp in WS3 is the actual cure, and the gating is the ergonomics.

**F3 · The browser list is kind-blind.** `FixturesPanel` (`browser.tsx:125`) renders every fixture as
`<Box size={12} />` with the same green "Patched" dot, one flat list under "Master Layer", with a
single count. A 5-channel Mac Aura and a 144-LED strip are visually identical. No filter, no grouping,
no footprint, no mode name, no per-kind count. `patchOverflow` — which only a USB-DMX widget produces
— is not surfaced here at all.

**F4 · The Fixture Editor dock is entirely pixel-shaped and does not gate.**
`FixtureEditor.tsx` is ledmap import/export, matrix preview, serpentine bake, colour order,
channels/pixel, LED count. For a selected light fixture the whole right-hand side of that dock is
inapplicable. Its **Library** card is the good part and should survive as-is.

**F5 · The patch actively mixes the two wires — this is the operator-visible one.**
`autoPatch`'s `defaultControllerId` parameter is passed `undefined` at **all nine call sites**
(`App.tsx:902, 930, 946, 966, 972, 983, 988, 1000, 1014`), so an unassigned fixture falls to
`controllers[0]` (`addressing.ts:157`, `:187`) — *the first controller in the array, regardless of what
it drives*. In the target rig (one Art-Net LED node + one ENTTEC widget) **every new moving head is
patched onto the Art-Net node** and must be moved by hand. Nothing in the model connects "this is a
light fixture" to "it belongs on the DMX widget", and nothing warns when they diverge.

**F6 · Routing has no kind axis.** `RoutingModal` and `FixtureRoutingPanel` list controllers and
fixtures flat. There is no "assign all lights to COM3" operation, no per-controller kind badge, and no
cross-kind warning. Auto-patch on a rig with both kinds is a per-fixture manual job.

**F7 · Groups and templates are kind-blind.** `FixtureGroup` (`types.ts:1267`) is `{ id, name,
fixtureIds }` — nothing stops a group holding both, and a `LightingTake` instanced onto such a group
has role-space values with nowhere to land on the pixel members. `FixtureTemplate` (`:1527`) is
pixel-only *by construction* (`ledCount`, `shape`, `matrixWidth`, `colorOrder`, `channelsPerPixel`) but
is never labelled as such; "Save as Template" is offered for a selected moving head and produces a
meaningless template.

**F8 · No shared vocabulary.** The tree says *fixture*, *profiled fixture*, *mover*, *head*, *DMX
fixture*, *pixel fixture*, *LED fixture*, *light*. `docs/LEDMAP.md` is titled for one kind and says so
only in a parenthetical; `docs/FIXTURE-LIBRARY.md` opens by explaining that `Fixture` "has always been
a pixel array". There is no user-facing word pair, so no label can be consistent yet.

**F10 · A light fixture lives on the 2D canvas, and its 3D position is DERIVED from that.**
This is the one the operator named, and it is structural rather than cosmetic.

- `Stage.tsx:730` renders **every** fixture as a draggable, hit-testable rect on the 2D stage. A
  moving head has no meaningful 2D extent — it is a point in a room — so its rect is a lie you can
  drag.
- [led3dDefaults.ts:17](../src/renderer/services/led3dDefaults.ts#L17) `effectivePosObj` derives the
  **3D** position from the 2D rect whenever `position3D` is absent. **2D is the master and 3D is the
  shadow**, which is exactly backwards for a light.
- Both creation paths spawn at a hardcoded `x: 0.4, y: 0.4, width: 0.2, height: 0.2`
  (`App.tsx:896` and `:960`). Through `effectivePosObj` that is `((0.4+0.1)-0.5)×4 = 0`,
  `(0.5-(0.4+0.1))×2.25 = 0`, `z = 0` — **the world origin**. Add ten heads and all ten are stacked
  in one spot in 3D, and the only ways to separate them are the 2D canvas or the Arrange panel.
- Both paths also assign `surfaceId: selectedSurfaceId ?? surfaces[0]?.id`. For a light that link is
  **inert** — `frameEngine.ts:607` `continue`s before any sampling — but it is not harmless: the
  fixture *looks* bound to a surface, and `WebGPUMapper.ts:375` has **no `profileId` branch at all**,
  so it computes UVs and samples the surface for every light, every frame, and the result is
  discarded.

**F9 · No invariant guards any of this.** `verify:invariants` protects the footprint formula
(`scripts/verify-invariants.cjs:1437`) and nothing else about kinds. Nothing stops the next panel from
re-deriving the predicate, or from editing `ledCount` on a light.

## Design / approach — workstreams

### WS1 · `services/fixtureKind.ts` — the one owner  🟢 Low

New module, ~60 lines, no dependencies beyond `types.ts`. Mirrors `fixtureFootprint`'s doctrine
verbatim, including the comment explaining *why* it is one place.

```ts
export type FixtureKind = 'pixel' | 'light';
/** Cheap, profile-map-free. `profileId` set ⇒ light. This is the ONLY definition. */
export const fixtureKind = (f: Fixture): FixtureKind => (f.profileId ? 'light' : 'pixel');
export const isLight = (f: Fixture) => fixtureKind(f) === 'light';
export const isPixel = (f: Fixture) => fixtureKind(f) === 'pixel';

/** The THREE-way truth the 3D scene and the inspector actually need (see F1). */
export type FixtureKindState = 'pixel' | 'light' | 'light-unresolved';
export function lightState(f: Fixture, profiles?: ProfileMap): FixtureKindState;
```

Then **replace every ad-hoc test** with one of these three. Critically, the four 3D call sites
(`Simulator3D:120`, `MoverBodies:69`, `Beams:136`, `MoverLights:34`) become `lightState(...) ===
'light'` and stop silently disagreeing with the packer about the unresolved case. `Simulator3D`'s
`pixelFixtures` becomes `lightState(f) === 'pixel'`, and `'light-unresolved'` gets an explicit
placeholder body (WS6) instead of falling through to the LED path.

Also here: `KIND_LABEL: Record<FixtureKind, string>` and the icon pair, so §WS3/WS4 cannot drift.

### WS2 · Narrow the selection kinds  🟢 Low

- `packages/sdk/src/renderer.ts:309` — `SelectionKind |= 'fixture.pixel' | 'fixture.light'`. Purely
  additive; `'fixture'` stays and keeps meaning "any fixture".
- `state/EditorStore.tsx:227` — `buildSelection` takes the `fixtures` array (it currently takes ids
  only) and emits the narrow kinds *in addition to* `'fixture'`:
  ```ts
  if (ids.fixture?.length) {
    kinds.push('fixture');
    const sel = ids.fixture.map(id => byId.get(id)).filter(Boolean);
    if (sel.some(isPixel)) kinds.push('fixture.pixel');
    if (sel.some(isLight)) kinds.push('fixture.light');
  }
  ```
  A mixed multi-selection lights both, which is the documented `appliesTo` semantics ("a FILTER, not
  an XOR") and is the right behaviour for arrange/routing panels.
- **No `WorkspaceShell` change.** Verified: `:187` is already generic set membership.

### WS3 · Gate the inspector panels  🟡 Med — this fixes F2's corruption

Re-declare in `contexts/index.tsx:82-92`:

| Panel | `appliesTo` |
|---|---|
| `fixture.profile` (DMX Profile) | `['fixture']` — unchanged; it is *how you change the kind* |
| `fixture.channels` | `['fixture.light']` — and drop its internal `if (!f?.profileId) return null` |
| `fixture.mapping` | **split** (below) |
| `fixture.segments` | `['fixture.pixel']` |
| `fixture.output` (2D / Output) | `['fixture.pixel']` |
| `fixture.layout3d` | `['fixture.pixel']` |
| `fixture.routing` | `['fixture']` — the patch applies to both |
| `fixture.arrange` | `['fixture']` — rig-building is kind-agnostic |

**Split `FixtureMappingPanel`.** It currently mixes three unrelated things: the surface link
(pixel-only), LED Count + Reverse (pixel-only), and Universe/Start Addr (**both**). Becomes:

- `core.inspector.fixture.patch` — Universe / Start Addr / patch-locked, `appliesTo: ['fixture']`,
  ordered first. Shows the resolved footprint via `fixtureFootprint()` so the number an operator reads
  is the number the patch reserves. Badges `patchOverflow`.
- `core.inspector.fixture.mapping` — Surface, LED Count, Reverse, `appliesTo: ['fixture.pixel']`.

That alone removes the editable LED Count from every light fixture. **Belt and braces** (WS8 guards
this): `handleUpdateFixture` (`App.tsx:979`) clamps `ledCount` to 1 when `isLight(next)`, so no future
panel, plugin, OSC path or paste can reintroduce F2 through the back door.

Bump `layoutRev` on `mapping` and `3d` — their inspector lists change.

### WS4 · Browser list — show the split  🟢 Low

`FixturesPanel` (`browser.tsx:125`) grows two collapsible groups under Master Layer — **LED
Fixtures** (n) and **Light Fixtures** (n) — with a segmented All / LED / Light filter in the header,
banked in prefs, not in the project.

Per row: kind icon (`Box` / `Lightbulb`, from WS1 so it matches the inspector), and a right-aligned
secondary readout — `144px · 576ch` for LED, `Mac Aura · Mode 14 · 14ch` for light. Replace the
decorative always-green "Patched" dot with an honest state: **unresolved profile** and
**patchOverflow** both get a warning marker with a title, since those are exactly the two failures
that today are invisible in the list.

Shift-range selection must walk the *displayed* order once grouped, or range-select silently picks the
wrong span.

### WS5 · Kind-aware patching — the operator's actual goal  🟡 Med

**Model** (`renderer/types.ts`, `Controller`):

```ts
/**
 * What this device drives. Optional ⇒ 'any' ⇒ exactly today's behaviour, so every saved project
 * loads and patches identically. Set it and auto-patch stops mixing an LED node and a DMX widget.
 * A REPORT-not-a-block: patching a light onto an Art-Net node is legitimate and stays possible.
 */
drives?: FixtureKind;
```

Additive optional, defaulted at the read site — the `normalize*()` pattern named as a cross-cutting
hazard in `plans/README.md`. **No `ProjectData.version` bump.**

**Defaulting on create.** A controller created with `protocol: 'enttec'` defaults `drives: 'light'`;
`artnet`/`sacn` default `drives: 'pixel'`. A pre-existing controller has no `drives` and behaves as
`'any'` until the operator sets it — old projects must not silently repatch on load.

**And on protocol change.** `RoutingModal.tsx:119` lets an existing controller switch protocol
(Art-Net ↔ USB DMX). If `drives` still holds the *old* protocol's default, update it to the new one;
if the operator set it by hand, leave it alone. Without this, switching a node to a USB widget leaves
it advertising `drives: 'pixel'`, and every light auto-patches past it to the next candidate — the
same silent-wrong-bucket failure this workstream exists to remove, reintroduced through the one field
the operator is most likely to edit.

**`autoPatch` (`addressing.ts:142`).** Replace the two identical `controllers[0]` fallbacks
(`:157`, `:187` — they must stay identical, they are the reserve-bucket and the assign-bucket of the
same decision) with one helper:

```ts
const fallbackFor = (kind: FixtureKind) =>
  controllers.find(c => c.drives === kind)?.id      // a box that says it drives this
  ?? controllers.find(c => !c.drives)?.id           // an unclassified box (old projects)
  ?? controllers[0]?.id;                            // today's behaviour, last
```

`defaultControllerId` keeps precedence over all three (it is still never passed — leaving it in place
rather than deleting it, since the Routing UI in WS6 is where it finally gets a caller).

**Cross-kind report.** `addressing.ts` gains a pure `crossKindPatches(fixtures, controllers)` returning
`{fixtureId, controllerId}[]` where `ctrl.drives` is set and disagrees. Pure ⇒ provable with a
throwaway `tsc`-checked script, per DEVELOPMENT.md → Testing. Surfaced in WS6, never blocking.

### WS6 · Routing UI + the 3D unresolved placeholder  🟢 Low

- `RoutingModal` / `FixtureRoutingPanel`: per-controller **Drives: LED / Light / Any** selector; a kind
  badge on each controller row; the cross-kind warnings from WS5 listed, each with a one-click
  "move to <matching controller>"; and **"Patch all lights → <controller>"** / **"Patch all LEDs →
  <controller>"**, which is the bulk operation F6 is missing.
- Controller rows show `enttec` capacity honestly (1 universe) beside their assigned fixture count, so
  overflow is predictable *before* it happens rather than badged after.
- The **LEDs** (`:213`) and **Channels** (`:208`) columns disable for a light row, with a title saying
  the footprint comes from the mode. Cosmetic on top of WS3's clamp — but this grid is where an
  operator patches in bulk, so an input that silently does nothing is worse here than anywhere else.
- `Simulator3D`: `'light-unresolved'` draws a neutral placeholder housing with a warning tint, not a
  stray LED sphere (F1). Whatever mesh it gets, it must still be pickable by its **body** per the
  house rule, and `InstancedLeds` must `computeBoundingSphere()` if its instance count changes.

### WS7 · Groups, templates, and the words  🟢 Low

- `FixtureGroup` stays `{id, name, fixtureIds}` — **no persisted kind**. A derived `groupKind(g,
  fixtures)` → `'pixel' | 'light' | 'mixed'` in WS1; the Groups panel badges it, and the lighting-clip
  authoring path warns (does not block) on `'mixed'`, since role-space values have nowhere to land on
  the pixel members (F7).
- "Save as Template" is disabled with a reason for a light selection, and the templates list is
  labelled **LED templates**. A light fixture's reusable form is already a *profile* + mode; a second
  mechanism would be a worse one.
- **Vocabulary, fixed once** (F8): **LED fixture** / **Light fixture** in every user-facing string,
  `'pixel'` / `'light'` in every identifier. Both live in `KIND_LABEL` (WS1) so there is one edit if
  they ever change. FR strings alongside, matching the existing bilingual `hint`s.

### WS9 · The 3D scene is a light's only home  🟡 Med — this is the operator's ask

**The target loop, end to end.** This is the acceptance path, and it is the reason the workstream
exists:

> select a light in the fixture list → **click in the 3D scene to place it** → position it (gizmo or
> inspector) → set its channels → **store the key** into the timeline at the playhead.

The last step crosses into [lighting-keyframes.md](lighting-keyframes.md) §E3, which is where "store
the key" is specified. Everything before it is here.

**WS9a · The 2D stage stops drawing lights.** `Stage.tsx:519`'s `renderFixturesList` filters to
`isPixel`. Nothing else in Stage changes — drag, rotate, resize and hit-testing are all per-element
handlers, so removing the element removes every interaction with it. Lights **stay in the Mapping
context's browser list** (patching is a Mapping job — auto-patch, the routing dock, the DMX monitor);
they simply have no rectangle on the canvas.

**WS9b · `position3D` becomes the light's real position — without a migration.** Two options were
considered and the cheap one is right:

- ❌ Make `position3D` required for a light and write it in on load. That is a **migration**, and it
  would be the only one in either plan.
- ✅ **Keep `effectivePosObj`'s 2D derivation as the fallback, and fix the spawn.** For an existing
  project the derived value is a perfectly good answer to "where was this head" — it is where the
  operator put it. For a *new* light, creation writes an explicit `position3D` so nothing is derived
  from a rect nobody will ever see.

`applyProfile` (`App.tsx:913`) additionally **drops `surfaceId`**: a light samples nothing, and an
inert link that the mapper still honours (F10) is worse than no link. That also removes the wasted
per-frame sample with **no mapper change** — the mapper's existing no-surface path already handles it.

**WS9c · Placement is a click in the 3D scene.** Adding a light from the library **arms placement**:
the next click on the venue floor or a model drops it there, at that point, `z` at a sensible trim
height. Escape cancels; if the operator never clicks, it lands on a spread grid in front of the
camera — **never all at the origin** (F10), which is the concrete bug this fixes.

Placement rides the existing 3D picking rules, which are load-bearing and must not be re-derived: the
model/plane handlers already YIELD when an LED is in the same intersection list
(`Simulator3D/pickPriority.ts`), and a fixture is picked by its **body**, never its LEDs. A placement
raycast is a *new consumer of the same priority rule*, not a new rule.

**WS9d · Position, then parameters, in one column.** Wave B's WS3 already routes a light to
`fixture.profile` + `fixture.channels` + `fixture.patch` + `fixture.routing` + `fixture.arrange`. The
`3d` context declares all of those except `patch`/`routing` — add them, so the whole loop happens in
one workbench without a context switch, and bump its `layoutRev`.

`fixture.layout3d` stays **pixel-only**: it authors LED spacing and arc sweep for a *run* of LEDs,
which a one-emitter head does not have. What a light needs instead is plain position/rotation, which
the gizmo and `fixture.arrange` already give it.

### WS8 · Invariants + docs  🟢 Low

Three new checks in `scripts/verify-invariants.cjs`, each encoding a bug above:

1. **One owner.** No file outside `services/fixtureKind.ts` may test `.profileId` as a *kind*
   predicate. Allow-list the legitimate resolution sites (`fixtureProfiles.ts`, `addressing.ts`,
   `profilePack.ts`, `frameEngine.ts`'s packer, and the panels that *read* the profile) — same shape as
   the existing `ledCount * channelsPerPixel` check, which already carries a deliberate allow-list.
2. **`ledCount` is pinned.** `handleUpdateFixture` must clamp it for a light fixture (F2).
3. **Every fixture inspector panel declares a kind.** A panel registered with `appliesTo: ['fixture']`
   must be on a short reviewed list (profile / patch / routing / arrange); anything else must name
   `fixture.pixel` or `fixture.light`. This is what stops the next panel silently re-opening F2.
4. **`Stage` renders no light fixture.** Its fixture map must be filtered by `isPixel` (WS9a). The
   failure mode this guards is quiet: a refactor that drops the filter puts draggable phantom rects
   back on the canvas, and dragging one silently rewrites the 3D position of a head that is nowhere
   near it — through `effectivePosObj`'s derivation, for any fixture that has no explicit
   `position3D` (i.e. every one from an old project).

Docs: `docs/FIXTURE-LIBRARY.md` and `docs/LEDMAP.md` gain the vocabulary and cross-link; a new
**Fixture kinds** section in `docs/OUTPUTS.md` covers `Controller.drives` and kind-aware auto-patch;
`CLAUDE.md`'s conventions list gains the one-owner rule beside the footprint one.

## ⚠️ Breaking changes (warn loudly)

- **`SelectionKind` widens** (`packages/sdk/src/renderer.ts`). Additive — an exhaustive `switch` over
  it in plugin code would newly fail to compile. Grepped: no plugin switches on `SelectionKind` today.
  The SDK is internal + UNSTABLE, so this is a note, not a policy problem.
- **`buildSelection` signature changes** (needs `fixtures`). Internal to `EditorStore`/`App`.
- **`Controller.drives` is a new persisted field.** Optional + defaulted at read ⇒ old projects load
  unchanged, **but a project saved after this ships is not readable-with-full-fidelity by an older
  build** (the field is dropped, patching reverts to `controllers[0]`). Same class as the
  asset-paths change; worth a CHANGELOG line.
- **`FixtureMappingPanel` splits into two panel ids.** Any banked dock/inspector layout referencing
  the old id needs the `layoutRev` bump (WS3), or an operator who has already opened Mapping never
  sees the new sections — the exact failure `layoutRev` exists for.
- **Auto-patch results change** on a project where the operator sets `drives`. That is the point, but
  it means *"my addresses moved"* is an expected outcome of setting the field, and the UI must say so
  before it repatches.
- **Lights disappear from the 2D stage** (WS9a). Deliberate, and the operator asked for it — but for
  an existing project it is a visible change with no undo, so it belongs in the release notes. Their
  `x/y/width/height/rotation` are **not** deleted (that would be a migration): they stay on the
  record, unread for lights except by `effectivePosObj`'s fallback.
- **`applyProfile` drops `surfaceId`.** Converting a pixel fixture to a light therefore forgets which
  surface it sampled, and converting back leaves it unlinked. Acceptable — the reverse conversion
  already drops `profileId`/`profileMode`/`dmx` for the same "a stale field is worse than an absent
  one" reason — but it is a one-way loss and should be named in the confirm.

## Risk evaluation — 🟡 **Medium**

Blast radius, grepped:

- `profileId` appears in **15 files** (`App`, `DMXMonitor`, `FixtureEditor`, `FixtureProfilePicker`,
  4× `Simulator3D/*`, `inspector.tsx`, `frameEngine`, `addressing`, `automationTargets.core`,
  `fixtureProfiles`, `EditorStore`, `types`). WS1 touches most of them, but each edit is a mechanical
  predicate swap.
- **The frame loop is untouched.** `frameEngine.ts:595`'s branch stays exactly as written; only the
  *expression* becomes `isLight(f)`. No signature, no packing, no wire change. This is what keeps the
  risk at Med rather than High.
- **The real risk is the patch (WS5).** Auto-patch is the one thing here that can move addresses on a
  rig that was working. Mitigated by: `drives` absent ⇒ byte-identical behaviour; the fallback chain
  ending on today's `controllers[0]`; and the two fallback sites being replaced by **one** helper, so
  the reserve bucket and the assign bucket cannot diverge (they already carry a comment saying they
  must not — `addressing.ts:155`).
- **Second risk: the shift-range selection in a grouped list** (WS4). Cheap to get wrong, invisible in
  a screenshot, annoying in a venue.

## Migration & back-compat

No migration. `Fixture` gains nothing. `Controller.drives` is additive-optional with a read-site
default. Every existing `.artlux` loads, patches and outputs identically until someone sets `drives`.

## Verification (repo patterns — no unit runner)

1. `npm run verify` — the three new invariants must fail on a deliberately reverted fix, then pass.
2. **Pure logic, throwaway `tsc`-checked script**: `fixtureKind` / `lightState` over the three states;
   `autoPatch` fallback precedence (light+pixel fixtures × classified/unclassified/absent controllers)
   asserting *no change* when no controller declares `drives`; `crossKindPatches`.
3. **On the wire** — `--headless --project=<mixed rig>` + the `dgram` ArtDmx listener: a project with
   one Art-Net LED node and one ENTTEC controller must produce **byte-identical universes** before and
   after the whole change, with `drives` unset. This is the acceptance test for "the engine is
   untouched".
4. **F2 regression, explicitly**: patch a mover, then two strips after it. Note the strips' colours in
   the DMX monitor and the 3D scene. Attempt to raise the mover's LED Count (the field must be gone;
   drive `updateFixture` from the console to prove the clamp). Colours must not shift.
5. **In the app** (`npm run dev`): select a mover → Profile / Channels / Patch / Routing / Arrange
   only. Select a strip → Mapping / Segments / 2D-Output / 3D-Layout / Patch / Routing / Arrange.
   Select both → both sets.
6. Add a `enttec` controller, add a head from the library, confirm it patches to the widget, not the
   Art-Net node. Then repeat with `drives` cleared and confirm the old behaviour returns.
7. **The WS9 loop, in the app, as one take**: add three heads from the library → each is placed by a
   click in 3D and lands **where clicked, not at the origin** → drag one with the gizmo → set pan/tilt
   on the channel strip → the beam moves in the scene. Then confirm the 2D stage shows **no** rect for
   any of them, and that the surfaces and LED strips on it are untouched.
8. **F10 regression**: open a pre-change project containing a head, confirm it still sits where it did
   (the `effectivePosObj` fallback still fires for it), then move it in 3D and confirm the explicit
   `position3D` takes over permanently.
9. **Packaged-build check is not required** — nothing here touches window reveal.

## Effort & phasing — **M**

| Wave | Workstreams | Ships on its own? |
|---|---|---|
| **A — the model** | WS1 + WS2 + the WS8 one-owner invariant | Yes. No visible change; makes everything after it mechanical, and fixes the F1 3D/packer disagreement. |
| **B — the UI split** | WS3 + WS4 + WS7's vocabulary + the WS8 ledCount + panel invariants | Yes. Closes F2. |
| **B′ — lights leave 2D** | WS9 + the WS8 Stage invariant | Yes, and it is small. **Half of what the operator asked for**; the other half is E3 next door. |
| **C — the wire** | WS5 + WS6 | Yes. The Art-Net/USB-DMX separation. Highest risk, lands last, on top of a settled model. |
| **D — the rest** | WS7's groups/templates + docs | Yes. |
| **E — how a light show is encoded** | → **[lighting-keyframes.md](lighting-keyframes.md)** | Its own plan. |

**Wave E is a separate document** because it is a different subsystem: not *which* fixtures are lights,
but *how their show is stored*. It depends on this plan only through WS7's `groupKind` (a sequence must
not be pointed at a group holding LED tape — finding F7 here, L8 there). Everything else in it is
independent and can start as soon as Wave A lands.

B is independently valuable and can ship without C if the patch work needs more thought. C **must not**
ship before A, or the kind-aware fallback would be written against the ad-hoc predicate. **B′ needs
only A**, so if the operator's loop is the priority it can jump the queue ahead of B and C.

## Open questions / decisions

1. **The words.** This plan commits to **LED fixture** / **Light fixture** (the operator's own terms)
   over the console-native *Pixels* / *Fixtures*. Changing the mind later costs one `KIND_LABEL` edit
   — but only if WS1 lands first.
2. **Should `Controller.drives` allow an explicit `'any'`, or is `undefined` enough?** This plan uses
   `undefined ⇒ any`. An explicit `'any'` would let an operator *say* "this box is deliberately mixed"
   and distinguish that from "never configured", which matters for whether the cross-kind warning
   fires. Cheap to add later; adding it now costs nothing either.
3. **Two rail contexts, or one?** Deliberately **not** proposed here — per the house rule, a feature
   that seems to need a new place in the UI should first question the shell's shape. Mapping already
   holds both kinds and the split is a *filter + inspector* problem, not a workbench problem. Revisit
   only if WS4 lands and the list still reads badly.
4. **Should a light fixture keep `surfaceId` at all?** It is inert (`frameEngine` `continue`s before
   sampling) but not meaningless — a future "sample the surface to drive the head's colour mixing"
   feature would want exactly that link. This plan **hides** the control (WS3) rather than deleting the
   field. Deleting it would be a real migration.
5. **Where does a click-to-place light land on the Z axis?** A head is rigged on a truss, not on the
   floor, so dropping it at the raycast hit point puts every fixture on the ground. Options: a
   per-scene default trim height added to the hit; place on the floor and let the operator raise it;
   or snap to a truss model if one is under the cursor. **Recommended: a trim-height default**, with
   the number in the 3D scene's own settings — but it is a real decision and it shapes the loop.
6. **Should a light be selectable in the 2D stage at all?** This plan says no rect, no hit-test. An
   alternative is a small non-draggable marker so you can *see* where the rig is relative to the
   surfaces. Cheap to add later; deliberately not proposed, because a marker that cannot be dragged
   invites dragging.
7. **`FixtureTemplate` for lights.** Disabled here (WS7) on the argument that a profile+mode already is
   the template. If operators want "my house PAR, pre-aimed, with these gobo defaults", that is a
   *preset of `dmx` values*, which is a different (small) feature and should be named as one.
