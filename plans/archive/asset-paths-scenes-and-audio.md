# Asset paths: `mapAssetPaths` is blind to scenes and to the audio bed

> **Deliverable:** this document, saved as `plans/asset-paths-scenes-and-audio.md` and indexed in `plans/README.md`.
> **Status:** Draft · **Placement:** **Core** (`src/main/projectFolder.ts`) · **Risk:** 🟠 Medium — small diff, but it sits on the save/load/collect path that every project passes through · **Breaking changes:** none to the schema; **one forward-compat break** (a project saved by the fixed build will not fully load on an older build)

## Context — the bug, stated plainly

`src/main/projectFolder.ts:38-86` declares itself:

```ts
// ---- The single source of truth for where asset paths live in a project ----------
function mapAssetPaths(data: ProjectData, map: (path: string) => string): ProjectData
```

It is not. It visits exactly four places:

| Visited | Line |
|---|---|
| `data.surfaces[].content.url` (VIDEO/IMAGE) | [:45-53](../../src/main/projectFolder.ts#L45) |
| `data.scene3D.models[].path` | [:56-62](../../src/main/projectFolder.ts#L56) |
| `data.timeline.clips[].path` + `.content.url`, `data.timeline.trackingTakes[].path` | [:66-78](../../src/main/projectFolder.ts#L66) |
| `data.assets[].path` (the managed library) | [:81-83](../../src/main/projectFolder.ts#L81) |

**It never visits `data.scenes[]`, and it never visits `data.audio`.** Both hold asset paths:

- **`Scene`** ([types.ts:801-813](../../src/renderer/types.ts#L801)) carries its own **`surfaces?: Surface[]`** (each with `content.url`), its own **`scene3D?: Scene3D`** (models with `path`), and its own **`timeline?: Timeline`** (clips with `path` / `content.url`, plus `trackingTakes`). Every one of those is a collectable asset reference, and every one is invisible to the visitor.
- **`ProjectData.audio`** ([protocol.ts:555](../../../shared/protocol.ts#L555)) is an `AudioMix` whose clips carry **`path`** ([types.ts:648](../../src/renderer/types.ts#L648)) — a field whose own comment reads *"audio file (absolute in memory, **relative on disk — like every asset path**)"*. **That comment is false.** Nothing relativizes it. The audio bed shipped in Wave 3 (P0–P4) and its paths have never been on the portability path at all.

Three consumers ride this one function, so all three inherit the hole:

| Consumer | Call site | What breaks |
|---|---|---|
| `relativizeAssets` — **on save** | [persistence.ts:76](../../src/main/persistence.ts#L76) | Scene and audio paths are **never made relative**, so they are saved **absolute**, baked to the authoring machine. |
| `resolveAssets` — **on load** | [persistence.ts:93,100](../../src/main/persistence.ts#L93) | A relative scene/audio path is never made absolute. (Latent today only because nothing writes one — see below.) |
| `collectInto` — **Collect Assets** (in place + to a folder) | [ipc.ts:86,88](../../src/main/ipc.ts#L86) → [projectFolder.ts:202-256](../../src/main/projectFolder.ts#L202) | Scene-only and audio-only assets are **not copied**, and — the sharp part — **not rewritten either**. |

### The failure that actually bites

**Collect Assets reports success and still ships a broken project.**

`collectInto` runs `mapAssetPaths` twice: a discovery pass that copies each unique source into `assets/` ([:212-229](../../src/main/projectFolder.ts#L212)), then a rewrite pass that repoints references at the copies ([:232](../../src/main/projectFolder.ts#L232)). Because the managed library **is** visited, a file that has a library entry **does get copied** into `assets/`. But the scene's own clip — the thing that actually plays it — is never visited, so it is **never repointed**. The result:

- Collect says *"copied 12"*. The file is genuinely sitting in `assets/video/`.
- The scene's clip still points at `D:\stock\loop.mp4` on the author's machine.
- Hand the folder to the venue. The library looks perfect. **The scene plays nothing.**

And a file that was *never* in the library (dragged straight onto a scene's lane, or whose library entry was deleted) is not even copied — it is simply absent, and `CollectResult.missing` never mentions it, because `missing` is populated from the same blind visitor.

### The second failure: the project folder is not portable

Because scene paths are saved absolute, **moving a project folder breaks scenes but not the global timeline** — the same asset, referenced from two places, survives in one and dies in the other:

```
project/
  assets/video/loop.mp4
  project.artlux
      timeline.clips[0].path   = "assets/video/loop.mp4"   ← relativized ✓ survives the move
      scenes[2].timeline.clips[0].path
                               = "D:/old/project/assets/video/loop.mp4"   ← absolute ✗ dies
```

That asymmetry is the worst kind of bug: it is silent, it is partial, and it looks like a media problem rather than a path problem.

### Why now

Wave A ([timeline-transport-and-audio-scoping.md](timeline-transport-and-audio-scoping.md)) just fixed the **sibling** of this bug twice, in the renderer:

- `usageForPath` counted a single timeline, so an asset used only inside a scene reported as **unused** — and the delete confirmation read from a different, global-only count and deleted with **no warning at all**. Now `ProjectRefs` scans every timeline, every scene's look snapshot, and the audio bed.
- `handleRelinkAsset` rewrote only the live surfaces + the global timeline, so a relink was **silently reverted on the next scene recall**. It now rewrites every scene.

So the renderer now knows that asset paths live in scenes and in audio. **The main process still does not.** Relink and the usage badge are scene-aware; save, load and Collect are not. That inconsistency is now the most confusing thing in the asset system, and it is the one that reaches a venue.

## Requirements this must satisfy

1. Every asset path in a project — wherever it lives — is relativized on save, resolved on load, and copied + rewritten by Collect Assets.
2. `CollectResult.missing` reports a scene-only or audio-only asset that has gone missing.
3. A project folder is **portable**: move it, and every scene and the audio bed still play.
4. There is exactly **one** place that knows where asset paths live — the fix must not create a second list that can drift from the first.
5. No schema change, no `ProjectData.version` bump, and old projects load unchanged.

## Architecture at a glance

The whole fix is a change of shape in one function: stop hard-coding the *top-level* fields, and instead express "a container that holds asset paths" once, then apply it everywhere such a container occurs.

```
                       ┌──────────────────────────────────────────┐
                       │  mapAssetPaths(data, map)                │
                       │  the ONE source of truth                 │
                       └────────────────┬─────────────────────────┘
                                        │ applies the SAME three visitors
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
        mapSurfaces(s[])        mapScene3D(s3d)        mapTimeline(tl)
        content.url             models[].path          clips[].path
        (VIDEO/IMAGE)                                  clips[].content.url
                 │                      │              trackingTakes[].path
                 │                      │                      │
    ┌────────────┴──────────────────────┴──────────────────────┴────────────┐
    │                                                                        │
    ▼                                                                        ▼
 TOP LEVEL                                                    EVERY SCENE (data.scenes[])
 data.surfaces      ← already done                            scene.surfaces      ← NEW
 data.scene3D       ← already done                            scene.scene3D       ← NEW
 data.timeline      ← already done                            scene.timeline      ← NEW
 data.assets        ← already done (library)
 data.audio.clips   ← NEW (the bed — mapAudio)
```

**The DRY point is the whole point.** Today the timeline walker is written inline once. The moment scenes need it too, an inline copy would be a second list of "where paths live" — and the next field added to `Timeline` (Wave B adds `Timeline.audio`) would be remembered in one and forgotten in the other. Extracting `mapSurfaces` / `mapScene3D` / `mapTimeline` / `mapAudio` and calling them from both places is what makes the function's own docstring true.

## Design / approach — workstreams

### WS1 · Extract the container visitors (`src/main/projectFolder.ts`)

Four pure helpers, each taking its container and the `map` callback and returning a shallow-cloned copy:

- `mapSurfaces(surfaces: unknown[], map)` — the existing `:45-53` body, lifted verbatim.
- `mapScene3D(scene3D: unknown, map)` — the existing `:56-62` body.
- `mapTimeline(tl: unknown, map)` — the existing `:66-78` body (clips `path`, clips `content.url`, `trackingTakes[].path`).
- `mapAudio(audio: unknown, map)` — **new.** `AudioMix.clips[].path`. Guard with `isFilePath` like everything else.

Keep the existing `any`-cast style: the main process deliberately does not import renderer types (`ProjectData.scenes` is `unknown[]`, `audio` is `unknown`), and the file already casts. **Every helper must be total over garbage input** — a non-array `scenes`, a `null` scene, a scene whose `timeline` is a string. `mapAssetPaths` runs on every load of a possibly hand-edited file and must never throw. (The renderer's `normalizeTimeline` learned this the hard way during Wave A: four separate crash-on-load paths, each found by an adversarial review, each reproduced by actually running the expression.)

### WS2 · Visit the scenes and the bed

In `mapAssetPaths`, after the existing top-level work:

```ts
// Scenes: each is a full look snapshot with its OWN surfaces, scene3D and timeline — every one of
// them carrying collectable paths. Missing this is why Collect Assets shipped a folder whose scenes
// pointed at the author's D: drive.
if (Array.isArray(out.scenes)) {
  out.scenes = out.scenes.map((sc: any) => {
    if (!sc || typeof sc !== 'object') return sc;
    const next = { ...sc };
    if (Array.isArray(sc.surfaces)) next.surfaces = mapSurfaces(sc.surfaces, map);
    if (sc.scene3D) next.scene3D = mapScene3D(sc.scene3D, map);
    if (sc.timeline) next.timeline = mapTimeline(sc.timeline, map);
    return next;
  });
}
// The global audio bed (Wave 3). AudioClip.path's own comment claims it is "relative on disk — like
// every asset path"; until this landed, nothing made it so.
if (out.audio) out.audio = mapAudio(out.audio, map);
```

**Aliasing is already safe, and it is worth knowing why.** `buildSceneSnapshot` stashes `surfaces` **by reference** and `handleCaptureScene` does `structuredClone(activeTimeline)` — so the *same path string* legitimately appears in a dozen places, and a scene's `timeline` may even be the *same object* as the global one. That is fine on all three consumers:
- `collectInto`'s `remap` is keyed by **path string**, so a file referenced twelve times is copied **once** ([:213](../../src/main/projectFolder.ts#L213)).
- Every `map` in play is **idempotent**: `relativize` no-ops on an already-relative path (`isAbsolute` is false), `resolve` no-ops on an already-absolute one, and the collect-rewrite's `remap.get(p) ?? p` no-ops on a path already pointing into `assets/`.
So visiting the same object twice cannot double-apply. (It does mean the *output* holds two distinct objects where the input held one shared reference — irrelevant, since the value is immediately serialised to JSON.)

### WS3 · Make `missing` honest

`CollectResult.missing` ([protocol.ts:567](../../../shared/protocol.ts#L567)) is populated inside the discovery pass ([:219](../../src/main/projectFolder.ts#L219)), so widening the visitor fixes it for free — a scene-only asset that has vanished from disk will now be reported. **Verify this explicitly** rather than assuming it; the renderer surfaces `missing` to the user and it is the only signal they get.

### WS4 · Correct the lying comment

[types.ts:648](../../src/renderer/types.ts#L648) — `AudioClip.path`'s *"relative on disk — like every asset path"* becomes true only when WS2 lands. Until then it is a trap for the next reader. Land them together.

## ⚠️ Breaking changes (warn loudly)

- **FORWARD-COMPAT, and it is the only real one: a project saved by the fixed build will not fully load on an older build.** Once scene/audio paths are relativized on save, an older ArtLux (whose `resolveAssets` does not visit them) will read those relative strings and never make them absolute — so its scenes and its bed will point at nonexistent relative paths. This is inherent: the whole point is to start writing relative paths where absolute ones used to be written. **No schema version distinguishes the two**, so a downgrade is silently broken.
  - *Mitigation options (§Open questions):* accept it and note it in the changelog; or bump `ProjectData.version` purely as a legibility marker (note: **`version` is currently read by nothing** — Wave A established this by grep — so a bump is documentation, not a gate); or write absolute paths for one release and only relativize from the next.
- **Backward-compat: none.** Old projects have absolute scene/audio paths; `resolveAssets` keeps an absolute path as-is, so they load exactly as they do today. The first save under the fixed build converts them, in place, to relative — which is the fix.
- **No schema change.** Nothing is added to `ProjectData`, `Scene`, `Timeline` or `AudioMix`. This is purely a change to which fields a visitor walks.

## Risk evaluation — 🟠 **Medium**

The diff is small and confined to one file, but that file is on the path of **every project save, every project load, and both Collect variants**. A bug here does not break a feature — it rewrites every asset path in the user's project. Specifically:

1. **A wrong `map` application corrupts paths at rest.** The three consumers pass three different callbacks; a helper that mutates rather than clones, or that maps a field it shouldn't, writes the damage to disk on the next save. `mapAssetPaths` is pure today (shallow-clones into `out`) and must stay pure.
2. **`mapAssetPaths` must never throw.** It runs on every load, on data that may be hand-edited, plugin-written, or partially truncated. `ProjectData.scenes` is typed `unknown[]`. Wave A found **four** separate crash-on-load paths in the renderer's equivalent (`normalizeTimeline`) — non-array `clips`, a `null` clip, non-array `markers`/`trackingTakes`, a non-finite `duration` — every one reproduced by actually executing the expression. **Assume the same class of garbage here and guard for it.**
3. **The double-visit in `collectInto` is load-bearing.** The discovery pass and the rewrite pass must walk the *same* set of paths, or a file gets copied and never repointed (which is precisely today's bug, one level up). Both go through `mapAssetPaths`, so they stay in step by construction — do not "optimise" one of them into a bespoke walk.
4. **Scale.** With N scenes each holding a full surfaces + timeline snapshot, the visitor now walks ~N× more objects, twice per Collect. This is a save-time operation on data already being serialised to JSON; not a concern, but do not add a per-path `statSync` inside the visitor.

Blast radius, grepped: `relativizeAssets`/`resolveAssets` ([persistence.ts:76,93,100](../../src/main/persistence.ts#L76)), `collectAssets`/`collectAssetsToFolder` ([ipc.ts:86,88](../../src/main/ipc.ts#L86)), and the renderer's two Collect entry points ([App.tsx:1036,1051](../../src/renderer/App.tsx#L1036)). No plugin consumes any of them.

## Migration & back-compat

No migration needed and none possible: an old project's absolute scene paths remain valid absolute paths and load unchanged. They are converted to relative on the next save, silently and correctly, provided the asset lives inside the project folder. An asset *outside* the folder stays absolute (that is `relativizeAssets`'s existing contract, [:97-99](../../src/main/projectFolder.ts#L97)) until the user runs Collect.

## Verification (repo patterns — no unit runner)

Gates: `npx tsc -p tsconfig.json --noEmit`, `npm run build`, `npm run verify:plugins`.

**Because there is no test runner, this needs a real fixture and a real folder move.** Build a project that puts an asset in each blind spot — that is the whole point:

1. **Fixture.** One project with four assets, each referenced from exactly ONE place:
   - `a.mp4` — only on the **global timeline** (the control: this already works).
   - `b.mp4` — only on a **scene's own timeline** (capture a scene, then remove it from the global doc).
   - `c.png` — only on a **scene's look snapshot** (`scene.surfaces[].content.url`; set a surface's content, capture the scene, then change the live surface to an Effect).
   - `d.wav` — only on the **audio bed**.
   Keep all four *outside* the project folder.
2. **Collect Assets → a fresh folder.** Expected: **all four** are copied into `assets/`, and — the part that is broken today — **every reference is rewritten** to point inside. Inspect the written `project.artlux` JSON directly: `scenes[].timeline.clips[].path`, `scenes[].surfaces[].content.url` and `audio.clips[].path` must all begin with `assets/`.
3. **The portability test — this is the one that matters.** Move the collected folder to a different directory (or another machine). Open it. Press GO on the scene. **Expected: it plays.** Play the bed. **Expected: it plays.** Today, both are black/silent.
4. **`missing` is honest.** Delete `b.mp4` from disk, run Collect. Expected: it is named in the "missing" report.
5. **Idempotence.** Run Collect twice. Expected: the second run copies 0, skips all, and does not mangle any path.
6. **Corrupt-input safety.** Hand-edit the saved JSON to make `scenes` a `{}`, a scene `null`, a scene's `timeline` a string, and `audio.clips` a number. Reopen. **Expected: it loads (degraded), and does not crash.** This is not paranoia — Wave A's adversarial review found four real crash-on-load paths of exactly this shape in the renderer's sibling function.
7. **Regression: the control still works.** `a.mp4` (global timeline) behaves exactly as before.

## Effort & phasing — **S/M**, one pass

- **WS1** extract the four container visitors (a refactor with no behaviour change — verify the control case still passes before going further).
- **WS2** visit `scenes[]` and `audio`.
- **WS3** confirm `missing` now covers them.
- **WS4** fix the `AudioClip.path` comment.
Then the fixture + the folder-move test, which is the only thing that actually proves it.

## Open questions

1. **How do we handle the forward-compat break?** Accept + changelog is the honest minimum. Is a `ProjectData.version` bump worth it *purely* as a marker, given nothing reads it today? Or do we care about downgrade at all?
2. **Can a `CueEntry` carry an asset path?** `CueEntry.value` is `number | string | boolean | null` ([types.ts:822-823](../../src/renderer/types.ts#L822)) and its `path` is a `paramPath` dot-path. If `surfaces.<id>.content.url` is reachable through `setByPath` and offerable by the cue picker, then **cues are a fifth blind spot** and belong in this fix. The cue picker enumerates numeric/fadeable leaves, so it is *probably* unreachable — **verify before closing this out** rather than assuming.
3. **Plugin-contributed content types.** `SurfaceContent.type` is an open union ([types.ts:174](../../src/renderer/types.ts#L174)) and `mapSurfaces` only maps `VIDEO`/`IMAGE`. A plugin content type carrying a file path is not collected. Pre-existing and out of scope here, but it is the same class of bug and the registry gives us somewhere to put a seam if a plugin ever needs one.
4. **`Timeline.audio` (Wave B).** The [timeline/audio scoping plan](timeline-transport-and-audio-scoping.md) adds a per-timeline audio container. `mapTimeline` must grow to visit it when it lands — one more reason the timeline walker must exist in exactly one place. Leave a comment there pointing at it.
