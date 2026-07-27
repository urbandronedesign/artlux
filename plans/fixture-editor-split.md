# Fixture Editor — two categories, and the duplication behind them

> **Status:** Draft — 2026-07-27. **BLOCKED ON A DECISION (below). Not started.** **Core**. Risk 🟢 Low.
> Follow-on to [fixture-kinds.md](fixture-kinds.md) / [lighting-rework-status.md](lighting-rework-status.md).
> Two independent problems in one plan because the second is what the first keeps tripping over.

---

## ⛔ DECIDE THIS FIRST — is the Fixture Editor dock still worth having?

**Undecided as of 2026-07-27, deliberately.** Part 1 below assumes the dock stays and gets split by
kind. That assumption may be wrong, and building it before answering would be building the expensive
version of a thing that might be deleted.

Since Wave B, **almost everything in the dock exists somewhere else**:

| Dock card | Also lives in |
|---|---|
| Create | the Mapping action bar (*Add Surface / Add Fixture / Auto-patch*) |
| Patch | `core.inspector.fixture.patch` — both kinds, already kind-aware |
| Pixel Type · Geometry · Wiring | `core.inspector.fixture.output` / `.mapping` / `.segments` — pixel-gated |
| — | `core.inspector.fixture.profile` / `.channels` / `.position` (lights) |
| **Library** | **nowhere else** — the DMX profile picker + the operator's LED templates |
| **Ledmap** | **nowhere else** — import/export, serpentine bake |

So the three live options:

- **A · Split it by kind** (Part 1 as written). Keeps a familiar surface; accepts that most of it is a
  second rendering of the inspector, and pays the drift risk forever.
- **B · Shrink it to what is unique** — a *Library* dock (profiles + templates) and a *Ledmap* dock.
  Everything else is already in the parameter column, kind-gated and guarded. Smallest surface, least
  duplication; costs the "one place to build a fixture" feel.
- **C · Leave it alone for now.** The pixel cards are noisy on a light but no longer dangerous —
  `pinLedCount` closed the field that corrupted the rig, and `fixtureFootprint` ignores the rest.
  Nothing here is a bug; it is all clarity.

**Part 2 (the duplication) is independent of this decision and can proceed on its own.** It is a
real correctness item — three copies of `roleValue()` and a dead flag — and it does not care what
happens to the dock.

---

## Part 1 — the Fixture Editor still thinks every fixture is a pixel run

Wave B split the **inspector** by kind (`appliesTo: ['fixture.pixel' | 'fixture.light']`, guarded).
It never touched the **Fixture Editor dock**, which is where an operator actually builds a rig — and
that dock is seven cards, of which **five are pixel-only** and none say so:

| Card | Applies to |
|---|---|
| Create | both |
| Library | both — but its two tabs are already the split, by accident |
| Patch | both |
| **Pixel Type** | LED only (`channelsPerPixel`, colour order, RGBW mode) |
| **Geometry** | LED only (Line/Matrix, cols/rows, serpentine) |
| **Wiring** | LED only (reverse, segments) |
| **Ledmap** | LED only (import/export, serpentine bake) |

Select a moving head and four cards describe something it does not have. They are not *dangerous*
any more — `pinLedCount` clamps the one field that corrupted the rig, and `fixtureFootprint` ignores
the rest for a light — but they are noise in the one place a rig gets built, and they teach the
wrong model: that a light is a pixel fixture with extra bits.

### The route: TWO CATEGORIES, not two docks

**Not a second dock, and not a second workspace context.** The house rule is to question the shell's
shape before adding to it, and a "Light Fixture Editor" tab beside a "LED Fixture Editor" tab would
be a second place to look for one job. The dock already has a natural spine — *what am I adding?* →
*where is it on the wire?* → *what is it?* — and only the last third differs by kind.

So: **one dock, a kind segmented control at the top, and the card set follows it.**

```
┌ Fixture Editor ─────────────────────────────────────────────┐
│  [ LED Fixtures | Light Fixtures ]        ← follows selection │
│                                                              │
│  Create        Library            Patch                      │
│  ── LED ─────────────────────  or  ── LIGHT ───────────────  │
│  Pixel Type  Geometry              Profile & Mode            │
│  Wiring      Ledmap                Channels                  │
│                                    Position                  │
└──────────────────────────────────────────────────────────────┘
```

- The segmented control **follows the selection** (select a head → Light) and can also be driven by
  hand to browse the other side without changing what is selected. Selection wins on change.
- **Create** and **Library** become kind-aware rather than kind-agnostic: in LED mode the library
  shows templates and *Add fixture* makes a pixel fixture; in Light mode it shows the DMX profile
  picker and *Add* arms click-to-place (which already exists — `handleAddFixtureFromProfile`).
- **Patch** stays in both and is unchanged.
- The light column is not new UI: `FixtureProfilePanel`, `FixtureChannelsPanel` and
  `FixturePositionPanel` already exist and already declare their kinds. The dock should **render the
  registry panels**, not fork them — anything else immediately drifts from the inspector.

### Why the dock cannot simply reuse `appliesTo`

`appliesTo` is filtered by the shell for `mount: 'inspector'` panels against the live selection. The
Fixture Editor is a single `mount: 'dock'` panel that draws its own body, so it gets no filtering. Two
options, and the cheaper one is right:

- ✅ **Have the dock ask the same rule.** `appliesToSelection` is already exported from
  `host/registries.ts` (that is the bugfix from `541bf01`). The dock can resolve the fixture
  inspector panel ids itself and render the ones that apply, so the two surfaces cannot disagree.
- ❌ Registering each card as its own inspector panel. That is a bigger refactor and would put
  ledmap import into the parameter column, where it does not fit.

### Work

1. **`FixtureEditor` takes a kind** — derived from the selection via `fixtureKind`, overridable by a
   segmented control, held in component state (a view preference, not project data).
2. **Card visibility by kind**; the four pixel cards render only in LED mode.
3. **A light column** built from the existing registry panels (profile / channels / position) so the
   dock and the inspector cannot drift.
4. **Create + Library follow the kind** — templates vs profiles, and the two Library tabs collapse
   into the category (they were doing this job informally already).
5. **Invariant**: the dock must call `appliesToSelection` (or `fixtureKind`) — the same class of check
   as *every fixture inspector section declares a kind*, so the dock cannot regress to one flat list.

---

## Part 2 — the duplication (this is the "duplicate in the enum")

**There is no duplicate inside any enum.** All of them were scanned — `SourceType`, `ColorOrder`,
`RGBWMode`, `LedShape`, `PixelSource`, `OutputProtocol`, `CurveKind`, `CueTransition` and the
`ChannelRole` union: **no duplicate key and no duplicate value anywhere.** (Two look duplicated in a
`grep -A` because the output bleeds into the next enum — `PixelSource` is `MEDIA|EFFECT` only.)

What **is** duplicated is the *role vocabulary*, three times over, and it is mostly mine:

### 2a · `roleValue()` exists THREE times, identical

| File | Line |
|---|---|
| `services/lightingRecorder.ts` | 81 |
| `services/lightingStoreKey.ts` | 57 |
| `services/lightingCue.ts` | 115 |

Same seven-arm switch mapping a `FixtureState` to a role's number. This is precisely the shape
`fixtureKind.ts` and `fixtureFootprint` exist to prevent — one question, three answers that are free
to drift. **Add an eighth role and two of the three silently ignore it.**

→ One owner: `fixtureSignal.roleValue(state, role)`, beside the `FixtureState` it reads. Guarded.

### 2b · The captured-role LIST is duplicated, and a third list disagrees

```
lightingRecorder.CAPTURED = ['pan','tilt','dimmer','red','green','blue','white','zoom']
lightingStoreKey.STORABLE = ['pan','tilt','dimmer','red','green','blue','white','zoom']   ← identical
LightingClipInspector.ROLES = ['pan','tilt','dimmer','zoom','focus','iris','colorWheel','goboWheel']
```

The first two are byte-identical under two names. The third is a *different* set — the roles a
generated effect may drive — and the overlap makes it look like the same list drifting.

→ Name them for what they are, in one place: `ROLES_CAPTURED` (what a busk records / a key stores)
and `ROLES_GENERATABLE` (what an effect can drive). Two lists, two reasons, one home.

### 2c · A dead flag — `allRoles` does nothing

```ts
// services/lightingStoreKey.ts:155
const roles = allRoles ? STORABLE : STORABLE;
```

Both branches are the same expression. `StoreKeyInput.allRoles` is documented as the *"Store all
roles"* modifier and is wired to nothing — a real bug, introduced in E3, and exactly the class this
project kills on sight: **the UI (and the type) claims something the engine is not doing.**

Two honest fixes, and the choice matters:

- **Delete `allRoles`** until the modifier has a key binding and a button. A flag nothing sets is a
  promise nothing keeps.
- **Or implement it**: `allRoles ? everyRoleTheProfileResolves(f) : ROLES_CAPTURED`.

→ Recommend **delete now, implement with the UI**. It is the smaller lie to remove.

---

## ⚠️ Breaking changes

None. Part 1 is view-only (a component-state view preference; no persisted field, no `layoutRev`
bump — the dock's *identity* does not change, only its body). Part 2 is internal refactoring plus the
removal of an unused optional field on a non-persisted interface.

## Risk — 🟢 **Low**

The only way to get this wrong is to fork the light column instead of rendering the registry panels,
which would put the dock and the inspector back on separate drift paths — hence the invariant.

## Verification

1. `npm run verify` — the new dock-kind check must fail on a deliberately reverted fix, then pass.
2. **Pure**: `roleValue` returns identically for all eight roles from all three former call sites
   (capture a table before the merge, diff after — same technique as the autoPatch golden).
3. **In the app** (CDP, the harness in [lighting-rework-status.md](lighting-rework-status.md)):
   select an LED strip → Pixel Type / Geometry / Wiring / Ledmap present; select a head → absent, and
   Profile / Channels / Position present instead; flip the segmented control with nothing selected and
   confirm both sides are browsable.
4. **Regression**: record a lighting take and confirm the captured roles are unchanged after the list
   is renamed (it is the same eight; the point is proving the rename moved nothing).

## Open questions

1. **Does the segmented control belong in the dock header or the card row?** Header reads better but
   the dock's header is shell chrome; the shell would need a `HeaderActions` on a dock panel, which
   only browser/inspector mounts have today. Card row is free.
2. **Should `Patch` show the light's mode footprint inline?** It already does in the inspector's
   Patch section; duplicating it in the dock is either helpful or the same drift risk in miniature.
3. **Is the Fixture Editor dock still the right home at all,** now that the inspector covers both
   kinds and the 3D workbench covers the light loop? Its unique value is the *library* and the
   *ledmap* — everything else exists twice. Worth asking before investing in it, per the house rule
   about questioning the shell rather than adding to it.
