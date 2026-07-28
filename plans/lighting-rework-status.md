# LED / light fixtures + the lighting encoding — where this stands

> **Status: BUILT AND UNPUSHED — 2026-07-27.** On local `main`, ahead of `origin/main`.
> **Deliberately not pushed: this feature set is expected to be reworked.** Treat every decision below
> as revisable; treat the *findings* as facts about the codebase that will still be true afterwards.
>
> ⚠ `main` also carries commits from **other sessions** (calibration, build fixes), so it is no longer
> only this work. Use `git log --grep` on the subjects below rather than assuming a contiguous range.

Companion status doc for [fixture-kinds.md](fixture-kinds.md) and
[lighting-keyframes.md](lighting-keyframes.md). Those two say what was *planned*; this says what was
*built*, **how it was proved**, and what a rework should know before touching it.

---

## The commits

The two plans, in build order. **Four more landed afterwards** and are described further down:
the Fixture Editor shrink, the role-vocabulary de-duplication, the degrees display transform, and
the lane-shadow badge.

```
31e7bbf  feat(lighting): recordings land as editable eased keys, not a polyline   E4/E5
2fbf4c3  feat(lighting): pose cues — fire a stored look with no timeline involved E6
a214364  feat(lighting): Store Key — the verb that closes the authoring loop      E3
44a7425  feat(lighting): pose sequences — a look you can author                   E2
1fbc92c  refactor(lighting): one curve format — a take stores keyframes           E1
85cdfee  feat(fixtures): groups, templates and the docs learn the two kinds       Wave D
17ced62  feat(patch): auto-patch stops sending moving heads to the LED node       Wave C
f0d0674  feat(fixtures): a light fixture lives in the 3D scene, not the 2D canvas Wave B′
96f6503  feat(fixtures): an LED strip and a moving head stop sharing one inspector Wave B
541bf01  fix(shell): appliesTo was dead under the dockable workspace              (bug found)
e7b7cfd  feat(fixtures): one owner for "what KIND of fixture is this?"            Wave A
ffe3bd3  docs(plans): the app has one Fixture type for two devices on two wires   the plans
```

Each builds and typechecks on its own — the waves were split hunk-by-hunk and re-verified at every
stage, not committed as one lump and sliced afterwards. `npm run verify` went 57 → **71** checks
across all of it.

---

## What is actually proved, and by what

The habit worth keeping: **nothing here is claimed on the strength of a green typecheck.** Every
load-bearing behaviour was measured, either in the running app over CDP or off the wire with a UDP
listener.

| Claim | How it was proved |
|---|---|
| A moving head no longer offers pixel controls | CDP: selecting a head reports `LED Count: false`, `Reverse: false`, `Start Addr: true`, +4 channel sliders |
| Lights are off the 2D canvas | CDP: a 3-fixture rig draws **2** stage rects |
| Click-to-place works | CDP: after one click, `Y = 1.725` — exactly `DEFAULT_TRIM_HEIGHT` — with X/Z at the clicked point, not the spawn row |
| Kind-aware patching is byte-identical when `drives` is unset | A golden of `autoPatch` over five rigs, captured **before** the change and diffed after: identical |
| Kind-aware patching fixes the rig when `drives` is set | Both controller orderings give the same answer — strips on the node (@1, @181), heads on the widget (@1, @15) |
| E1 did not change the wire | The four-MAC capture from docs/LIGHTING-SHOW.md, reproduced: ranges `113,113,113,113`, correlation `-0.06, **-1.00**, 0.06`, span **DMX 71..184** |
| A legacy `{t,v}` take still replays | Hand-built legacy-shape project → DMX **210** on all four heads = 444.7° on a 540° head |
| The sparse per-role rule is right | 19 hand-computed checks (role skipping a key and interpolating *across* it, per-role curve overrides, slot wrapping) |
| A sequence drives the rig | Headless, no UI: pan 150°→390° landed on **DMX 71..184**, phase stagger `173/144/116/88` ≈ 28.25 predicted |
| Store Key's three-case table | CDP from a project with no lane, no group, no clip: refusal creates nothing; one press builds lane+group+clip+sequence+1 diamond; second press → 2 diamonds |
| A pose cue beats a running clip | On the wire: `[71,71]` → fire → `[184,184]` |
| The cue layer's semantics | 18 hand-computed checks (slot wrap, fade-from-held, re-target, unresolved drives nothing, clear-as-release) |
| The fitter is faithful | Round-trip through the real sampler; ascending keys; no NaN in any field |

### The harnesses (rebuild these first if you resume)

They were throwaways per DEVELOPMENT.md and are **deleted**. The patterns that made them work:

- **CDP UI probe** — `ARTLUX_CDP_PORT=<port>`, spawn `npx electron . --project=<file>`, connect
  `puppeteer-core`, find the `index.html` page, then *ask the DOM what it rendered*. Needs
  `NODE_PATH` pointing at the repo's `node_modules` if the script lives outside the repo.
- **Wire capture** — write `prefs.appSettings = { outputEnabled: true, artNetIp: '127.0.0.1',
  artNetPort: 6469 }` **before** launch, bind 6469, parse `Art-Net\0` + opcode `0x5000`.
- **Pure logic** — `npx esbuild test/x.ts --bundle --platform=node --format=esm` then `node`.
  `node --experimental-strip-types` does **not** work here: the services use extensionless imports.

### Three traps that cost real time

1. **Never bind 6454.** The app's own Art-Net *input* socket owns it, so a listener there sees
   nothing. Documented in DEVELOPMENT.md; it still cost a run.
2. **The app needs ~15 s before the first frame.** A 10 s capture window killed it mid-boot and
   reported "no frames".
3. **The workspace layout is banked per context.** A probe that assumes it opens in Mapping will
   silently read the wrong browser panel — click the rail entry first.

---

## Decisions where building contradicted the plan

Both plans still contain the original recommendation; these supersede them.

**Phase inversion on Store Key (lighting-keyframes §10.5).** The plan recommended inverting each
slot's offset. That does not work: inverting properly means writing slot *i* at curve time
`t - phase*i` — **N keys at N times, not one key** — so it does not round-trip either. What shipped:
store what you see, and *warn* that the spread will be applied again on playback. You are usually
busking when you store, and phase is normally added after the looks exist.

**Pose cue precedence (lighting-keyframes E6).** The plan's first instinct put cues in the
live-override layer. Wrong twice: it breaks *"a lane always wins"*, and that layer means something
specific — `livePreview`, a fader drag right now, which a scheduler-fired cue at 3 a.m. is not. It
shipped **between the clip and the lane**, and the ordering is invariant-guarded.

**The fitter's numbers (lighting-keyframes E4).** The plan estimated ~6 keys for a 10 s sine.
Measured: **17**. The estimate was optimistic by ~3×. The table in that plan should be replaced with
the measured one in the E4 commit message.

---

## Decided since

**Is the Fixture Editor dock still the right home? — ANSWERED 2026-07-27: option B, shrink it.**
It is now `Library` + `Wiring & Ledmap`; the other five cards were a second rendering of the
kind-gated inspector, and `core.dock.fixtureEditor` is retired (`layoutRev` 5).

The audit **found the plan had undercounted the unique cards**: it claimed two, there were three —
the wiring preview (`MatrixPreview` + the physical-index strip) is rendered nowhere else in the tree
and a literal reading of B would have deleted it. It shipped alongside the ledmap, because the
preview shows the physical pixel order and the ledmap remaps it. Guarded by *the fixture docks hold
only what exists nowhere else*.

**Part 2 of [fixture-editor-split.md](fixture-editor-split.md) — SHIPPED**, and it was more than
tidying. `roleValue()` existed three times identically, and it had **already drifted from its own
list**: both copies of the captured-role list named `white`, and no copy of the switch had a case for
it, because a white emitter is folded into r/g/b and never reaches `FixtureState` as its own field.
So every consumer silently dropped a role the list promised — a busk never recorded a white channel
and a pose key never stored one. The resolver and the list now sit adjacent in `fixtureSignal.ts` so
they cannot disagree, and the guard was proved by re-introducing `white` and watching it fail. The
effect-driveable list is `ROLES_GENERATABLE`, named for its own question; `allRoles` (`x ? A : A`) is
deleted.

**The degrees display transform + the lane-shadow badge — SHIPPED.** See the struck-through item
below; together they close L6.

**Should lighting be a plugin?** Asked and answered *no*, 2026-07-27, with the reasoning recorded in
the conversation and worth re-deriving if it comes up: the SDK has no fixture-kind / DMX-packing
contribution seam, the packing lives in the frame loop, and every shipped plugin wraps a native addon
or an optional input and graceful-degrades — lighting does neither. The plugin-shaped thing hiding in
that question is a **fixture-kind contribution**, worth designing only when a *second* implementation
(a laser, a media-server head) justifies it. GDTF import is the one genuinely separable piece.

## Open items, in the order they matter

> The list below is what remains. Item 1 is now DONE — kept, struck through, because the reasoning
> for where the map may and may not be read is still the live constraint.

1. ~~The degrees display transform~~ — **BUILT 2026-07-27**, with the lane-shadow badge that pairs
   with it. `AutomationTargetDef.display { unit, min, max }` maps storage onto the authored axis
   **linearly** (numbers, not closures — and general enough for an offset range like Zoom's 8..45°,
   which does not pass through the origin), so a Pan lane reads `270 deg` where it read `0.50`.
   `min`/`max` stay 0..1 because that is what `compileAutomation` clamps to and what reaches
   `write()` — publishing degrees there would let an operator draw to 540 and pin the head at its end
   stop. **Guarded:** the engine side (timeline, automationOverlay, automation, frameEngine) may not
   read the map at all. The clip inspector now also names any role a lane is already winning.
2. **No per-slot editing of an existing pose key.** The data supports it (a pose stores one slot per
   fixture when they differ) but there is no UI to change slot 3 of a stored key. Today you re-store
   the whole key, or keep that head in its own group. This is the most likely first request.
3. **`--project=` can be overridden by FSM autostart.** A project whose state machine recalls a scene
   on load replaces the rig with that scene's `fixtures[]` snapshot. Arguably correct per feature; the
   *interaction* is untested and it wasted a debugging session. Untouched.
4. **The 180 s sine only reaches 1.7× in the fitter** because part of it falls back to RDP at the
   depth cap. Correct (the fallback guarantees it is never worse than RDP) but not finished.
5. **`npm run package` still does not build the Rust addons** — pre-existing, noted in
   [README.md](README.md)'s hazard list, unrelated but it will bite a release.

## Forward-incompatibility to remember at release time

None of these need a `ProjectData.version` bump (all additive-optional with read-site defaults), but
a project saved by this build is **read incompletely by an older one**:

- `Controller.drives` → older build reverts that rig to `controllers[0]` patching.
- `LightingTakePart.channels` is now `Keyframe[]` → an older build sees a take that drives nothing.
- `ProjectData.lightingPoses`, `Timeline.lightingSequences`, `Cue.lighting` → silently ignored.

## Where the rules now live

The invariants are the durable part — each encodes a bug that shipped or nearly did:

- `fixture kind is decided only by fixtureKind.ts`
- `a light fixture's ledCount is pinned on the update funnel`
- `every fixture inspector section declares a kind`
- `appliesTo is applied by the dock renderer as well as the hand-built column`
- `the 2D stage renders no light fixture`
- `autoPatch resolves a fixture's bucket in ONE place, ending on the old behaviour`
- `a lighting take stores Keyframe[], and LightingCurve is read-only legacy`
- `pose sequences are compiled on edit, not resolved in the frame loop`
- `a pose cue sits between the lighting clip and the automation lane`

Prose lives in `CLAUDE.md` → *Two kinds of fixture*, `docs/FIXTURE-LIBRARY.md` → *Two kinds of
fixture*, `docs/OUTPUTS.md` → *What a controller drives*, and `docs/LEDMAP.md`'s header.
