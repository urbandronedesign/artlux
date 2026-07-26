# ArtLux — DMX fixture library (profiles)

How ArtLux knows what a **moving head** is, where that knowledge comes from, and how to regenerate it.

## The problem this solves

A `Fixture` ([types.ts](../src/renderer/types.ts)) has always been a **pixel array**: `ledCount` cells
of RGB/W occupying `ledCount × channelsPerPixel` channels from `startAddress`. That describes LED tape
and panels and nothing else. A wash, a beam, a moving head has *named* channels — Pan, Tilt, Gobo,
Shutter — some of them 16-bit pairs, some of them discrete slot lists, arranged differently in each of
the fixture's **modes**. None of that could be expressed, so none of it could be patched or driven.

A **`FixtureProfile`** ([shared/protocol.ts](../shared/protocol.ts)) is that description.

## The model

| Type | What it is |
|---|---|
| `FixtureProfile` | one product: manufacturer, model, aliases, channels, modes, physical data, provenance |
| `ProfileChannel` | one named parameter: `role`, `resolution` (1–3 bytes), `default`, physical `min`/`max`/`unit`, optional discrete `ranges` |
| `ProfileMode` | one personality: a `footprint` and a flat `slots` array, **indexed by DMX offset** |
| `ChannelRole` | what a channel *means* (`pan`, `dimmer`, `goboWheel`, … or `unknown`) |
| `ProfileGeometry` | GDTF only — the real meshes plus the pan/tilt axis tree (see *GDTF* below) |

Three fields on `Fixture` opt into it, all optional so **every existing project loads unchanged**:
`profileId`, `profileMode`, `dmx` (authored channel values, keyed by channel key, normalised 0..1).

### Two decisions worth knowing

**`ProfileMode.slots` is a flat array, not a map.** Index = offset from `startAddress`, so emitting a
frame is a loop with no lookup and no runtime ordering decision. `null` is a channel the manufacturer
reserves but does not use — it still *occupies* its slot and is written as 0. The invariant
`slots.length === footprint` is enforced at build time, and a profile that violates it is dropped:
a mode whose slot array is shorter than its footprint mis-addresses every fixture patched after it.

**Pan/tilt ranges are stored in DEGREES.** Not raw DMX. That is what lets a recorded movement replay
correctly on a head with a different total sweep (a 540° take on a 630° head — consoles call this
*head morphing*), and what lets the 3D scene aim a beam at a point in the room.

## Where the footprint comes from — one owner

`fixtureFootprint(fixture, profiles?)` in
[services/addressing.ts](../src/renderer/services/addressing.ts) is the **only** place that answers
"how many channels does this fixture occupy?". It was open-coded in seven places before profiles
existed; a profiled fixture's footprint is its *mode's*, and the pixel product is simply wrong for it.

`verify:invariants` fails the build if any file outside `addressing.ts` multiplies `ledCount` by
`channelsPerPixel`. Miss one site and nothing throws — auto-patch overlaps two fixtures, or the
collision detector promises a clean patch while the packer writes over its neighbour.

An **unresolved** profile (a `profileId` with no profile behind it) returns footprint **0**, not the
pixel fallback. Falling back would hand back a plausible wrong span and mis-patch the rig around it.

## Regenerating the library

```bash
npm run build:fixtures                 # from the pinned upstream HEAD
npm run build:fixtures -- --ref <sha>  # from a specific commit
```

[scripts/build-fixture-library.mjs](../scripts/build-fixture-library.mjs) shallow-clones the
[Open Fixture Library](https://github.com/OpenLightingProject/open-fixture-library) into a temp cache,
converts it, validates hard, and writes `resources/fixture-library/`. The output is **committed** — so
`npm run package` needs no network, and a change to a thousand channel tables is a reviewable diff.

**Idempotence is a requirement**: same source commit in ⇒ byte-identical output. Run it twice and
`git diff` must be empty. (`.gitattributes` pins the directory to LF so this holds on Windows too.)

### What it produces

| File | Contents |
|---|---|
| `index.json` | the catalogue — one small row per profile. ~270 KB, loaded eagerly |
| `<manufacturer>.json` | full profiles, fetched lazily when a fixture is actually patched |
| `gobos/` | gobo images referenced by `ProfileRange.goboKey` |
| `MANIFEST.json` | source commit, counts, and **the skip report** |
| `LICENSE-OFL.txt`, `NOTICE.txt` | attribution — see below |

Current output: **506 profiles**, 117 manufacturers, 1659 modes, 46 gobos.

### Read the skip report, not the profile count

`MANIFEST.json` lists every fixture that did **not** convert, with why. A conversion that quietly
dropped a third of the library still reports a big number. Today the skip list is exactly
**114 multi-cell (matrix) fixtures** and nothing else.

Multi-cell fixtures address per-pixel channels generated from templates — a second addressing model on
top of the flat one. They are also the *only* source of mode entries the converter cannot resolve
(verified: zero unresolvable entries among non-matrix fixtures), so skipping them costs no partial
correctness. The build **fails** if the skip rate exceeds 35%, which is how an upstream format change
announces itself here rather than in a venue.

### The five kinds of mode entry

Every entry in an upstream mode's channel list is one of these, and all five must be handled or
fixtures are silently mis-addressed:

| Entry | Handling |
|---|---|
| a channel name | the base channel → one slot, `byte: 0` |
| a **fine alias** (`"Pan fine"`) | folded into the base channel's `resolution`; slot gets `byte: 1`/`2` |
| a **switching-channel alias** — the mode says `"Gobo Rotation"` while the channel list has `"Gobo Rotation Angle"`/`"…Speed"` | resolved through the dependency channel's `switchChannels`; the default capability's target wins |
| `null` | reserved-but-unused → `slots[i] = null` |
| a matrix insert | fixture skipped (above) |

### Roles are mapped by TYPE, never by channel name

Two traps worth keeping in mind if you touch the converter, both of which bit the first version:

- **Wheels are classified from their slot types**, not from the channel's name — `'Color Gobo Wheel'`
  defeats name-sniffing, and many fixtures call the channel something like `'Effects Wheel'`.
- **The upstream `wheel` property is usually absent, and absent means "the channel's own name"**, not
  "no wheel". Missing that default is not cosmetic: colour wheels classify as gobo wheels, every range
  label degrades to the literal string `"WheelSlot"`, and every slot colour and gobo image is dropped.
- **A `defaultValue` is not necessarily expressed at the channel's own resolution.** `dmxValueResolution`
  overrides it, and a value may arrive as an explicit `[value, resolution]` pair. The MAC 250 Krypton
  declares Pan as 16-bit (it has a `Pan fine` alias) but writes `"dmxValueResolution": "8bit"` with
  `defaultValue: 128` — *centred*. Normalising that by 65535 instead of 255 gives 0.00195: the head
  powers up hard against its end stop, 269° out. 95 channels across 60 fixtures declare a resolution
  that differs from their own, so this is not an edge case — and it is invisible until you look at a
  fixture in degrees rather than at a 0..1 number.

`unknown` is an honest label, not a failure: ~8.5% of channels land there. Such a channel is still
addressed, still occupies its slot and is still controllable by hand — it just gets no role-aware
behaviour. What `unknown` must never mean is *dropped*. `Hue`/`Saturation` are deliberately left
unknown: upstream types them `Generic`, so the only signal is the name, and nothing consumes a hue
role yet.

## GDTF — the manufacturer's own file

The bundled library has the channels and **no meshes**. A `.gdtf` has both, so importing one is how a
fixture gets its real 3D model.

**Fixture picker → Import .gdtf.** It produces a complete user profile — channels, modes, defaults,
physical ranges, discrete slots *and* geometry — rather than bolting geometry onto an OFL profile,
which would mean reconciling two descriptions of the same fixture that nobody could verify. It is
marked `verified: true`: a GDTF is the manufacturer's own description, as authoritative as the
shipped library.

### A GDTF does not ship one mesh

Every geometry node has its **own** model file (`Body.glb`, `Yoke.glb`, …) and the tree says how they
hinge. That is the point — a single baked mesh could not articulate. `GdtfFixture` builds a real
three.js hierarchy, parents each node's mesh under it, and rotates the nodes the DMX channels
identified as pan and tilt.

Rotations are applied as **deltas from the home pose**: the mesh as authored *is* the fixture at
pan-centre/tilt-centre, so the model never has to be reconciled against an absolute frame.

### The coordinate convention, confirmed against the spec

Worth stating because getting it wrong renders every fixture on its side, and the sample file alone
was not enough to settle it:

- The transform is stored **row-major but is mathematically column-major**, so the translation is the
  **4th column** — the fourth number of each of the first three rows, *not* the fourth brace group
  (which is always `{0,0,0,1}`).
- GDTF is **Z-up** (X left→right, Y into the screen, Z bottom→top), a device is described **hanging**,
  and the beam "emits its light into negative Z" — downward.
- `Model` maps **Length→X, Width→Y, Height→Z**.

Sanity-checked on a real file: the sample PAR puts its Beam at Z −0.134 (13 cm below the body, at the
lens) and its Yoke at Z +0.161 (16 cm above, the bracket). Both correct for a hanging fixture.

**The meshes are not in that space.** glTF mandates Y-up, so an exporter converts the geometry while
the XML keeps GDTF coordinates — confirmed by measuring the sample's `Body.glb`, which comes out
X = Length, Y = Height, Z = Width. Only the XML offsets need converting; the meshes arrive Y-up.

### Which axis is pan?

GDTF declares an `<Axis>` per moving part but never says which is pan and which is tilt. It is
determined by **which DMX channel targets that geometry** — a `Pan` channel with `Geometry="Yoke"` is
what makes the yoke the pan axis. Get it backwards and the head yaws while the yoke tilts. When no
channel drives an axis, the import says so rather than leaving a fixture that mysteriously will not
move.

### Verified, and not

Against the real `BlenderDMX@LED_PAR_64_RGBW` file: 5 channels with exact roles, one 5-channel mode,
RGB defaults full and W zero, the three-node geometry tree with correct Y-up offsets, all three
meshes extracted, beam angle read from the file, and the no-axis case reported. Three imported PARs
then render in the 3D scene from userData at 59 fps.

**Articulation is implemented but NOT verified**, because the only GDTF available here is a PAR with
no pan or tilt channels — the importer correctly reports that nothing will articulate. Confirm the
pan/tilt hinging with a moving-head GDTF before relying on it.

## Resolution order at runtime

[src/main/fixtureLibrary.ts](../src/main/fixtureLibrary.ts) serves the library over
`fixtureLibrary:index` / `fixtureLibrary:get`. A `profileId` resolves, highest priority first:

1. **the project** — `ProjectData.fixtureProfiles`, embedded on save with only the profiles in use;
2. **the operator** — `userData/fixture-profiles/*.json` (imported or hand-authored), which **wins over
   the bundle** so a shipped profile can be corrected without editing a generated directory;
3. **the bundled library**.

Projects embed their profiles because a project is portable: copied to a venue PC whose library is
older, an unembedded profile is simply absent, and a fixture with no known footprint shifts the patch
for everything after it.

The renderer never imports the library — main reads it off disk (`process.resourcesPath` when packaged,
`resources/` in dev) and hands over the small index plus one manufacturer at a time. Several MB of JSON
does not belong in a bundle that hot-reloads.

## `verified: false` — drafts

A profile extracted from a supplier PDF, or authored by hand in a hurry, carries `verified: false`.
Such a draft is deliberately **usable** — you may need one at 2am in a venue — but never silently
trusted: it is badged everywhere it appears, and only a human review comparing it to the manual sets
`verified: true`. Everything generated from the upstream library is `verified: true`.

## Licence — load-bearing

The Open Fixture Library is **MIT**, repo-wide; the licence covers the fixture definitions and the
gobo images, so redistribution is fine **provided the notice travels with the data**. The build copies
`LICENSE-OFL.txt` and writes `NOTICE.txt` beside the generated files. **Do not remove them.**

Separately: **BlenderDMX is GPLv3.** It is the best open reference for beam and gobo rendering
technique, and its code must be read for *approach only, never copied* — copying it would relicense
ArtLux.

## Related

- [OUTPUTS.md](OUTPUTS.md) — controllers, patching, routing
- [LEDMAP.md](LEDMAP.md) — pixel remapping (**pixel fixtures only**; a profiled fixture has no ledmap)
- [ROADMAP.md](ROADMAP.md) — GDTF meshes, the show-encoding takes, Enttec USB output
