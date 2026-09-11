# Cross-project import — copying a show between projects

Bringing part of one `.artlux` into another: a state machine, some scenes, a cue bank, a pose library,
and everything those reach. The source project is read but never opened, and nothing about it changes.

The unit an operator picks is small; what it carries is not. `SmState.sceneId` names a `Scene`, and a
Scene is a full look snapshot owning its own `surfaces`, `fixtures`, `scene3D` and a **required**
`timeline` — which owns layers, clips, markers, tracking and lighting takes, pose sequences, automation
and its own audio, and escapes to project scope for `groups`, `lightingPoses` and `trackingZones`. So
importing "the state machine" is closer to merging two shows than to copying an object, and the design
question is not what to carry but **what must not travel**: the rig, the venue and the machine.

Sibling pages: [SCENES.md](SCENES.md) for what a Scene captures, [STATE-MACHINE.md](STATE-MACHINE.md)
for the graph, [ASSETS.md](ASSETS.md) for how media is copied and de-duplicated.

<!-- audience:operator -->

## Using it

**File ▸ Import from Project…** → choose a project → tick what you want → read the report → **Import**.

The left column lists what the other project offers, grouped: its show graph, its individual states,
its scenes, its cue banks and its lighting poses. The right column is the part worth reading — it fills in as you tick things and
tells you three separate things:

| The report says | It means |
|---|---|
| **This will add** | The full closure, not your selection. Ticking one state machine routinely brings scenes, surfaces, fixtures and media with it. |
| **Things to know** | Every rename and every dropped reference, each with the reason. |
| **References would not resolve** | Nothing should ever appear here. If it does, stop and report it — see *Why the report matters*. |

**The import is one undo.** Ctrl+Z afterwards removes the scenes, states, transitions, cue banks,
surfaces, fixtures and groups it added. It does **not** remove the media it copied in or the lighting
poses it added — those are outside the undo history — so a second thought leaves files in `assets/` and
rows in the pose library that you can delete by hand.

**Save before importing media.** An unsaved project has no folder, so there is nowhere to copy media
into; the import refuses rather than pointing your show at another project's disk. Save, then import.

### What travels, and what does not

| Travels | Stays behind |
|---|---|
| The chosen states, transitions, regions | Controllers and their addresses |
| Scenes, with their own timelines, surfaces, fixtures, 3D snapshot and bound audio | The global timeline and the audio bed (see below) |
| Cue banks and their cues, including pose entries | Projector calibration, camera masks, marker maps |
| Lighting poses, fixture groups (in order) | The 3D scene of the source project |
| Tracking zones a carried trigger watches | Preferences, output settings, display bindings |
| The DMX profiles the carried fixtures use | Anything identifying the source machine |

**The global timeline and the audio bed are not importable, on purpose.** There is exactly one of each
per project — the bed's whole identity is that it rides the show clock and survives a scene recall — so
they cannot be *added* to your project the way a scene can. Importing one could only replace or merge
what you already have, which is a decision about your show, not a copy. A scene's **own** timeline and
its own audio are unaffected: those travel with the scene.

### Taking one state rather than a whole show

States are listed individually as well as collectively, each labelled with the look it carries
(`look: Ember`). Ticking one brings that node **and its scene** — which is usually the point, since a
state on its own is a name and a position.

**Edges need both ends.** A transition is imported only when both of the states it joins are; take one
state out of a five-state ring and no edge comes with it. That is deliberate rather than a limitation:
an edge with one end missing would sit in your graph looking correctly wired and either never fire or
fire into nothing, and the show engine would never mention it. The count is reported once — *"8
transitions led to or from a state that was not imported"* — not once per edge.

Ticking the whole **Show graph** is exactly the same as ticking every state in it.

### Names change, and that is deliberate

If the other project has a scene called `Ember` and so do you, the imported one arrives as `Ember 1`.
This is not tidiness. Scene recall resolves by id and then **falls back to name**, so two scenes sharing
a name would reroute each other's recalls — an OSC message or an entry action would reach whichever came
first. Every rename is listed in the report.

### The rig

Two strategies, chosen per import.

**Append source rig** (the default) brings the other project's surfaces and fixtures along. They are
added **after** your rig, so nothing already patched changes address, and they arrive with no controller
assigned. Use it when the other project describes a different rig from yours.

**Map onto this rig** adds nothing; the imported looks bind to the fixtures and surfaces you already
have. Pairing is by **name** first — a head called `SL Wash 3` in both projects is the same head — and
then by **position among fixtures of the same profile and LED count**, so six movers renamed between
projects still line up. Each of your fixtures is claimed at most once.

**Anything with no counterpart is listed by name before you commit**, under *Onto this rig*, and its look
is not imported. That list is the reason to choose this mode deliberately: six unmatched fixtures means
six looks that will not arrive.

### When something is dropped

A dropped reference is always reported, never silent. The usual causes:

- **A cue parameter addressing a fixture you did not import** — the entry is removed, because a cue that
  silently does less than it says is worse than a smaller cue.
- **A scene's bound audio addressing the source's bed** — the bed is not imported, so there is nothing
  for it to land on.
- **A lighting clip whose group was not imported** — the clip would stay on the timeline reading as
  correctly configured and drive nothing, so its group binding is cleared instead.
- **A trigger whose marker or track was not imported** — the transition becomes `manual` rather than one
  that can never fire.

### Media

Every file the selection references is copied into your project's `assets/`, so the result stays
portable. Identical files are not duplicated; a file with the same *name* but different *contents* is
kept separately (`logo.png`, `logo-1.png`) — the comparison is byte-for-byte, never name-and-size.

A source file that is missing on disk is reported and imported as a reference: the clip will read as
undecodable until you relink it.

<!-- audience:contributor -->

## Why the report matters

**Every dangling reference in this app is silent by design.** `services/stateMachine.ts` `enter()` does
`if (s?.sceneId) ctx.recallScene(...)` — a state whose scene is missing recalls nothing and the show runs
on, reporting `playing: true`, all night. The same holds for `jumpMarker`, `onMarker`, `onClipEnd`, an
unregistered plugin trigger `source`, and `LightingKey.poseRef`. A broken import would therefore present
itself as a perfectly healthy show.

So `validateReferences()` runs over the *merged* document before anything is committed, and the dialog
shows the result. Nothing downstream will ever raise it.

## Where it lives

```
src/main/persistence.ts        peekProject / peekProjectPick — read a second project, no side effects
src/main/projectFolder.ts      importAssetPaths — bulk copy with byte-exact de-duplication
src/renderer/services/projectImport.ts
                               enumerateUnits, closureOf, planImport, applyAssetRemap,
                               validateReferences — the whole engine, React-free
src/renderer/services/paramPath.ts
                               pathOwner / withPathOwner — rewriting ids that live inside dot-paths
src/renderer/components/ImportFromProject.tsx   the dialog
src/renderer/App.tsx           handleImportProject — one recordHistory(), then append
scripts/test-project-import.ts        the pure test        (npm run test:import)
scripts/test-project-import-live.cjs  the live app test    (npm run test:import:live)
scripts/test-import-runs.cjs          does it RUN?         (npm run test:import:runs)
```

## Peek, don't open

`persistence.peekProject` reads, parses and calls `resolveAssets`, and does **nothing else**.

It is deliberately not `openProjectTimed`. That one declares the project it read to be *the* project: it
calls `mediaAccess.setProject`, which **clears the media allowlist and rebuilds it** from the document
just read. Peeking through it would have revoked the open show's media mid-session — and downstream a
refusal is indistinguishable from a file that will not decode (an image simply does not appear), so
nothing would have said so. It also retargets `thumbCache` and pushes a recent entry for a project the
operator never opened.

`resolveAssets` is the one part worth keeping: the caller compares and copies real files, so it needs
absolute paths, and relative ones would later resolve against the wrong root.

Both halves are asserted by `npm run test:import:live`: after a peek, the open project's media still
serves, and the peeked project's media is still refused.

## Rig strategies, in the code

The strategy decides only how `maps.surface` / `maps.fixture` are **seeded** — freshly minted ids under
`append`, existing destination ids under `map`. Every remap below that point is identical, which is why
`map` costs no second code path.

`matchRig()` pairs source rig objects against the destination in two passes, and the order is the design:

| Pass | Rule | Why |
|---|---|---|
| 1 | exact name, case- and whitespace-insensitive | The only signal that carries operator intent, so it wins outright. |
| 2 | position within a `profileId` + `ledCount` bucket | Renamed but identical fixtures are the ordinary case; the bucket is what stops a 60-LED strip pairing with a moving head because both happened to be third in their list. |

A surface has no footprint to bucket on, so its second pass is positional over the whole remaining set.
Each destination object is claimed at most once, and `plan.rig` carries the whole correspondence so the
dialog can show it before anything is committed.

**Leaving an unmatched object UNMAPPED is load-bearing.** It is what makes the existing drop-and-warn
branches fire for it — the group filter, the dot-path drop, the scene-snapshot filter. Minting it a fresh
id instead would read as "matched" to every one of them, and would import a look for a fixture that does
not exist here, silently. For the same reason `remapFixture`, `remapScene3D` and `remapSurface` **clear**
`surfaceId` / `uvProjFrom` / `sliceOf` when the target is unmapped rather than falling back to the source
id: `surfaceId` is one of the fields a recall writes back, so a stale one would aim a real fixture at
nothing on every GO.

Under `append` every carried rig object is mapped by construction, so all of those branches pass
everything through unchanged.

## Ids

**Every carried id is re-minted**, and not because of collision probability. Most ids are
`crypto.randomUUID` and would never collide by chance. They collide *deterministically*:

- the shipped examples carry hand-authored ids (`st_attract`, `sc_ember`, `to_ember`, `rg_show` in
  `examples/state-machine/03-interactive-installation.artlux`), so two projects grown from the same
  example share every one;
- and project B is very often a Save-As copy of project A, in which case they share **all** of them.

Two id scopes, and conflating them is a bug:

| Scope | Namespaces | Mapped |
|---|---|---|
| **Project** | scene, state, transition, region, surface, fixture, group, pose, zone, model, cue, bank | once for the whole import |
| **Timeline-local** | layer, clip, marker, tracking take, lighting take, sequence, audio track, audio clip | **per timeline**, never shared |

The second row is load-bearing. Capture Scene deep-clones the bound timeline *ids and all*, so two
scenes in one project legitimately hold byte-identical clip ids — the app defends this by resolving a
clip id in the bound document **only** and treating a miss as a drop. A single global clip map would
fuse those two scenes' clips together.

**`profileId` is never re-minted.** A `FixtureProfile` is library data resolved
embedded → `userData` → bundled; a fresh id would resolve to nothing, and a fixture with an unresolved
profile has no known footprint, which silently shifts the patch of every fixture after it on the same
controller. Carried profiles are added with `fixtureProfiles.addEmbedded` — **add**, not `setEmbedded`,
which replaces and would drop the open project's own.

`effectId` and `paletteId` are numeric indices into `EFFECT_NAMES` / `PALETTE_NAMES` — build-coupled,
not project-coupled, so they carry across unchanged within one build.

## Ids that hide inside strings

`CueEntry.path`, `AutomationLane.targetPath` and `Scene.audio[].path` address their owner as **text**
(`surfaces.<id>.content.opacity`), where no object-graph walker will find them. They are rewritten
through `paramPath.withPathOwner` — the same grammar the app reads them with, never a regex, because the
audio forms put the id one segment deeper:

```
surfaces.<id>.<leaf…>        fixtures.<id>.<leaf…>        → owner at index 1
audio.clip.<id>.<leaf…>      audio.track.<id>.<leaf…>     → owner at index 2
audio.master.<leaf…>         globalBrightness             → no owner; left untouched
```

The leaf is left alone deliberately, including the audio effect id in `fx.<id>.<param>`: an
`AudioEffect` travels *inside* its clip or track, so its id never collides across projects and
re-minting it would only invalidate the lanes this is meant to keep pointing.

## The source arrives raw

`peekProject` does no normalization, while every shape in the app has been through
`applyProjectData`'s normalizers. `normalizeSource()` closes that gap, and it is a correctness
requirement rather than tidying: `examples/state-machine/03-interactive-installation.artlux` has scenes
with **no `timeline` key at all**, even though `Scene.timeline` is required in the type. Importing one
verbatim would recreate the timeline-less scene deleted on 2026-07-14 — the shape that materialised a
copy of the global doc on its first edit, retagged its automation from the show clock to the scene
clock, and made a house fade on `audio.master.gain` jump +9.6 dB on every GO.

## Traps worth knowing

- **`TrackingZone.surface` is `SOL` / `MUR` / `SOL_MUR`** — a `trackingStore` surface key, not a
  `Surface` id. Remapping it would point the zone at nothing.
- **`SceneModel.uvProjFrom` holds a `ProjectorOutput.surfaceId`** — a Surface id, so it *is* remapped.
- **`FixtureGroup.fixtureIds` order is the phase-spread axis.** Remap through the id list; filtering
  `fixtures` would silently re-sort the spread into fixture-list order.
- **`Scene3D.activeZoneIds` absent means "every zone is live"; `[]` means "listens to nothing".** A
  subscription that lost all its zones drops the field rather than becoming `[]`, which would deafen the
  scene.
- **`SurfaceContent.cameraDeviceId` is salted per machine and origin** — stripped, or the surface would
  be bound to a camera that cannot exist.
- **`DocSnapshot` covers ten slices.** `assets` and `lightingPoses` are outside it, so an undo of an
  import leaves copied media and imported poses in place. The dialog states this.

## Verify

```bash
npm run test:import        # pure: closure, remap, dot-paths, per-timeline ids, the validator
npm run test:import:live   # real Electron: peek has no side effects, media copies byte-exact
npm run test:import:runs   # the imported show BOOTS and cycles its scenes, watched on Art-Net
npm run verify             # invariants + docs + typecheck
```

`test:import` runs both against the shipped examples (real hand-authored ids) and against a synthetic
fixture built for the edges the examples never reach — cues, lighting, zones, automation, media, and two
scenes that deliberately share timeline-local ids.

`test:import:runs` answers the question the other two cannot: it imports a three-scene ring with the
real engine, boots the result `--headless`, and watches the wire. **A frozen level is the failure.** A
graph whose scenes did not survive would still enter its states on schedule, still output, and still
report `playing: true` — it would simply never change what it sends.

Its looks are authored **DMX on a light fixture**, not pixels sampled off a surface, and that is
deliberate: sampling needs a GPU, a decoded image and a composited frame, and
`scripts/test-engine-output.cjs` already records that a dark reading in this environment "is legitimate
and not a failure". A light's `dmx` values go straight into the universe, so the bytes on the wire are
exactly what the scene stored — the test asserts the three authored levels *arrive*, not merely that
something moves. It also sets `outputEnabled` in **prefs** (output is the machine, not the show) and
restores the operator's own prefs in a `finally`, including after a crash.

## Open items

- **The global timeline and the audio bed** are not importable — see above. What is missing is the
  replace-vs-merge decision, not the remapping.
- **The project-level 3D scene** does not travel; only each carried scene's own snapshot does. Its model
  media is therefore not collected either.
- **`map` matching is never interactive.** The two passes are good enough for a rig that was renamed or
  re-ordered, and every failure is named before commit — but an operator cannot currently correct a pair
  the matcher got wrong, only choose `append` instead. A per-row override belongs here if the automatic
  pairing turns out to be wrong often in practice; it has not been used on a real pair of shows yet.
- **`map` does not check that a matched fixture can actually take the look.** A source head paired by
  order with a destination head of the same profile and LED count will accept its `dmx` values, but two
  fixtures sharing a footprint are not necessarily the same instrument. Name matching sidesteps this;
  order matching trusts the bucket.

## See also

- [SCENES.md](SCENES.md) — what a Scene captures, and what a recall restores
- [STATE-MACHINE.md](STATE-MACHINE.md) — the graph, its triggers and its silence about dangling refs
- [ASSETS.md](ASSETS.md) — the media library, the allowlist, and byte-exact de-duplication
- [FIXTURE-LIBRARY.md](FIXTURE-LIBRARY.md) — profiles, and why an unresolved one shifts the patch
