# Finish Fixture Segments: kill the dead per-segment effect UI, add a first-class gap/off affordance

> **Status:** Draft · **Lifts:** Tutorial Set #3 (Wiring Rescue) — removes the caveat that the Inspector's per-segment Effect/Palette/Speed/Intensity controls do nothing, and that a non-contiguous "dead-span" gap must be authored by hand-poking Start/Stop fields · **Placement:** Core (UI + one optional persisted field) · **Risk:** Medium · **Breaking changes:** Project-file (additive-only, mitigated) + UI-only

## 1. The limitation today

Two distinct half-implementations, both real, both verified against current code:

**(a) Per-segment effect controls are dead.** `WebGPUMapper.buildSegParams()` unconditionally forces every real segment to mode `-1` ("sample linked surface / media") and discards the segment's own `effectId/paletteId/speed/intensity`:

- `src/renderer/gpu/WebGPUMapper.ts:255-262` — the loop does `void s; out[base+0] = -1; out[base+4] = f.rgbwMode === RGBWMode.NONE ? 1 : 0;`. The comment at `:257-258` states "S3: every fixture samples its linked surface's texture (media). Per-fixture effects are retired — effects live on surfaces now."
- The WGSL `main` still contains a full effect path (`effectColor`, `FIRE`, `samplePalette`) at `WebGPUMapper.ts:49-62, 129-133`, plus the stateful `fire` compute pass at `:64-95`. **None of it is reachable** because `buildSegParams` never emits `mode >= 0`. It is dead GPU code.
- Yet `InspectorPanel.tsx:192-226` still renders the Media/Effect toggle and, when Effect is chosen, Effect/Palette dropdowns + Speed/Intensity sliders. `updateParams()` (`WebGPUMapper.ts:449-453`) dutifully re-uploads `buildSegParams` on every change — which still produces all `-1`. **The controls animate the UI and change the project file but produce zero visual change.** This is the Set #3 caveat: the panel lies.
- The live effect path now lives on **surfaces**, not fixtures: `SurfaceContent` carries `effectId/paletteId/speed/intensity` (`types.ts:175-178`) and `SurfaceEffect.render()` (`gpu/surfaceFx.ts:37-71`) draws them into a canvas that fixtures sample. `ContentEditor.tsx:104-110` is the *working* effect UI. So the fixture-side effect UI is a vestige of the pre-S3 "effects on fixtures" era.

**(b) Authoring a gap ("dead span") has no affordance.** The engine already supports gaps:

- Any LED not covered by a segment gets `segIndex = offSeg` (`WebGPUMapper.ts:319-320`), which points at the trailing "off" entry written with mode `-2` at `:263-264`.
- WGSL honors it: `let mode = fp0.x; ... if (mode < -1.5) { outBuf[i] = 0u; return; }` (`WebGPUMapper.ts:114,116`).

So the *engine* does gaps. But the *authoring* path does not:

- `enableSegments` (`InspectorPanel.tsx:136-144`) and `addSegment`/"+ Split" (`:145-153`) only ever produce **contiguous** coverage — split in half, split the last in half.
- The only way to open a hole is to hand-edit the `Start`/`Stop` `NumberInput`s (`InspectorPanel.tsx:186-187`) into a non-contiguous state (or delete a middle segment via `removeSegment` `:154-158`, which leaves the neighbours' ranges untouched → an incidental gap). There is no "insert gap" button, no visual indication that a hole exists, and no guard rails. That is the "hand-editing JSON" workaround the tuto has to warn about.

**WebGL fallback has none of this.** `services/GPUMapper.ts` ignores `segments` entirely, has no surface sampling, no gap/off mode, and samples one global composite (`GPUMapper.ts:119-205`). On the WebGL path a "gap" simply cannot exist. This is pre-existing degraded parity, not something this feature regresses — but it must be stated.

## 2. What "lifted" looks like

- The fixture Inspector no longer shows dead effect controls. A user who splits a fixture into segments sees only what actually does something: segment list, per-segment Start/Stop, and a clear **Gap / Off** toggle.
- Creating a dead span is a one-click affordance: select a segment (or a range) and mark it **Off**, or press **Insert gap** to punch a hole. The Stage overlay renders gap LEDs visibly dark/hatched so the author can see the dead span.
- **Acceptance test (runnable):** author a single 60-LED fixture linked to a video surface; split into 3 segments `[0,20) [20,40) [40,60)`; mark the middle one **Off**. Run `--headless --project=<fixture>.artlux` with a dgram listener parsing ArtDmx(0x5000): LEDs 20-39 must be `0,0,0(,0)` while 0-19 and 40-59 carry live video bytes. The same file reloaded in `npm run dev` shows the middle third dark in the Stage 2D view and the 3D simulator.
- Old projects that used per-segment effects still load and still render (they degrade to media sampling exactly as they do today — no visual change from current behaviour).

## 3. Placement: core or plugin (REQUIRED)

**Recommendation: Core.** This is not new behaviour bolted onto the app — it is *finishing* a core primitive (`Segment`, already in `renderer/types.ts:35-43`, already persisted in every `.artlux`) and *deleting* a core UI that lies. Per the doctrine "CORE STAYS CORE: persisted project types … stay in shared/protocol.ts / renderer/types.ts." A gap/off flag on `Segment` is a persisted project-model field, therefore **core by rule** regardless of where the behaviour sits. There is no behaviour worth isolating: the gap render already exists in the core WebGPU mapper, and the effect deletion is pure subtraction.

A plugin would be actively wrong here: it would have to reach into `Segment` (a core persisted type), into `WebGPUMapper` (the core primary render path), and into the core `InspectorPanel`. That is exactly the "core stays core" boundary the doctrine draws.

**Barrel/singleton hazard:** N/A — no plugin, no new service singleton, no new SDK surface. `WebGPUMapper`/`GPUMapper` remain the single mapper instances created in `Stage.tsx:167-174`. Nothing new crosses the package-alias/relative-import boundary that caused the prior duplication bug.

## 4. Design / approach

Two sub-decisions, each resolved:

### (a) Delete the dead per-segment effect UI — do NOT re-implement segment-local GPU effects

Re-implementing per-segment effects on the GPU would fight the S3 architecture the codebase deliberately moved to (effects on surfaces). It would resurrect the atlas-vs-effect ambiguity, double the authoring surface (effect on the surface AND on the segment), and re-introduce a per-frame `fire` compute pass that is currently dead weight. **Recommendation: delete the fixture/segment effect authoring UI; keep the `Segment` effect *fields* in the type as inert legacy data (for back-compat — see §5/§6).**

**renderer:**
- `InspectorPanel.tsx:192-226` — remove the Media/Effect toggle and the Effect/Palette/Speed/Intensity block. Keep the segment list (`:177-184`) and Start/Stop inputs (`:185-188`). Rename the section from "Effect" to "Segments" (icon `Slash`/`Scissors` instead of `Sparkles`).
- `InspectorPanel.tsx:116-158` — the `vals`/`setVals` machinery (`:120-135`) currently threads effect params; trim it to only what the gap/off affordance needs (see (b)). `enableSegments`/`addSegment`/`removeSegment` stay.
- **Optional GPU cleanup (separate, low-priority commit):** the WGSL `effectColor`/`fire`/`samplePalette` and the `firePipeline`/`fireBind`/`heatBuffer` (`WebGPUMapper.ts:34,64-95,129-133,207,386-387,436-445`) are now provably dead for fixtures. Removing them shrinks the shader and drops a per-mapping buffer. **Do this in a follow-up, not in the same PR** — it touches the render path and the palette LUT is shared with `surfaceFx.ts`. Behaviour is identical whether or not this cleanup lands, so gate it separately.

### (b) First-class gap/off affordance

The engine already renders a gap two ways: an *uncovered* index (mode `-2` via `offSeg`) OR — the new, explicit way — a *covered* segment that declares itself off. Add an explicit off-segment so a gap is a real, named, visible object rather than an implicit hole.

**shared / types (core):**
- `renderer/types.ts` `Segment` — add `off?: boolean;` (optional, additive). `off === true` ⇒ this segment's LEDs output black. Because the WGSL already treats mode `< -1.5` as off, we just make `buildSegParams` emit `-2` for an off segment (see below). No new enum, no new GPU binding.

**gpu (core render path — WebGPU):**
- `WebGPUMapper.ts` `buildSegParams` (`:251-266`) — inside the per-segment loop, branch: `out[base+0] = s.off ? -2 : -1;`. One line. The trailing global off-entry (`:263-264`) stays as the fallback for uncovered indices. `SegLike` (`:147`) gains `off?: boolean`; `fixtureSegments` (`:149-152`) passes it through (the implicit whole-fixture segment is never off).
- No WGSL change: mode `-2` is already handled at `:114,116`.
- `updateParams` (`:449-453`) already re-uploads `buildSegParams` on param change and is gated by `countSegments` equality — toggling `off` does not change segment *count*, so it takes the cheap path. **But** `Stage.tsx:219-224` `fixtureParamSignature` must include `off` or the toggle won't trigger `updateParams`. Add `s.off` to the `segp` join at `Stage.tsx:222`. (Structural start/stop edits already go through `fixtureLayoutSignature` at `:203`.)

**renderer (Inspector affordance):**
- Replace the dead effect block with a per-segment **Off** checkbox and an **Insert gap** button. "Off" sets `off: true` on the selected segment (covered dead span — preferred, visible in the list). "Insert gap" splits the selected segment and marks the new middle third `off: true`, so authors get a hole without arithmetic.
- Show off segments distinctly in the segment list (`:179-184`) — e.g. strikethrough + "OFF" tag.

**renderer (visualization) — WebGPU only:**
- `Stage.tsx` 2D overlay draws fixtures from the read-back buffer already; off LEDs read back as 0 so they render black automatically. Add an optional hatch overlay for segments with `off` so a *dark video frame* is distinguishable from a *dead span*. `FixtureLights.tsx` (3D) already averages the live buffer (`:41-46`) → off LEDs contribute 0 → correct with no change.

**WebGL parity (`services/GPUMapper.ts`):** the fallback has no segment/surface concept at all. Cheapest honest parity: after `read()`, or inside `updateMapping`, zero the output bytes for LED indices that fall in an `off` segment (or any uncovered range). This is a small CPU post-pass over `pixelBuffer` keyed by a flattened off-mask built from `fixtures[].segments`. It will NOT give per-surface sampling (that's a separate, larger gap) but it *will* honor dead spans, which is the feature in scope. If we choose not to touch WebGL, we must document that gaps are WebGPU-only (acceptable: WebGPU is primary; WebGL is an init-failure fallback per `Stage.tsx:167-175`).

**Data flow unchanged:** `App.updateFixture` → `fixtures` state → `Stage` signatures → `mapper.updateParams/updateMapping` → GPU → `read()` → `dmxSignal`/native output. The only new bit flowing through is `Segment.off`.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**Persisted `.artlux` schema — additive, back-compat safe, BUT read carefully:**
- `Segment.off?: boolean` is **new and optional**. Old files have no `off` → `undefined` → falsy → segment is "on" → identical behaviour. New files with `off:true` opened by an **older app build**: the flag itself is **NOT lost from the file** — the loader spreads `...f` (`App.tsx:803`) so `off` round-trips through load→save intact even on an old build. What breaks is only *rendering*: the older `buildSegParams` never reads `off` (it hard-emits `-1`), so the dead span disappears and those LEDs light up on that old build; re-saving preserves the flag, so a subsequent upgrade renders the gap again. **This is a forward-compat rendering regression on downgrade, not a persisted data loss.** Mitigation: bump nothing structurally, but document "gaps render only on app ≥ this version"; optionally also punch a real *uncovered* hole (adjust start/stop) so even an old build renders the gap. That belt-and-suspenders is the safest authoring output and is worth doing.

- **DELETING the effect UI does NOT delete the fields.** `Segment.source/effectId/paletteId/speed/intensity` remain in the type and in saved files. If we *also* removed them from the `Segment` interface we would break:
  - `services/paramPath.ts:40` and `:160` — cue/fade paths `fixtures.<id>.segments.<n>.speed|intensity` are enumerated as **fadeable cue targets**. A saved `Cue`/`CueEntry` (`types.ts:476-492`) or `SmAction recallScene` may already reference `segments.0.speed`. Dropping the field would strand those paths (the `setPath`/`getPath` in `paramPath.ts` would write/read `undefined`). **Therefore: keep the fields, just stop rendering their controls.** No cue breakage.
  - `App.tsx:544` (copy-look) and `App.tsx:903` (export-rig destructure) reference `speed/intensity/segments` — both keep compiling since the fields remain.
  - `Stage.tsx:222` reads `s.source,s.effectId,...` for the param signature — keep it working (or trim to `s.off,s.start,s.stop`); either compiles.

**IPC contract (`shared/protocol.ts`):** **none.** `Segment` lives in `renderer/types.ts`, not `protocol.ts`; grep confirms no `segment` symbol in `src/shared/`. Nothing crosses the IPC boundary. Rig export/import (`App.tsx:901-909`) strips `segments` entirely, so the rig JSON is unaffected.

**@artlux/sdk surface:** **none.** No SDK type re-exports `Segment`.

**Saved prefs / keybindings:** **none.**

**UI-only breaking change:** users who (believe they) configured per-segment effects lose those *controls*. Since the controls never did anything, no rendered output changes — but the panel will look different. Communicate as a bugfix ("removed non-functional controls"), not a feature removal.

## 6. Migration & back-compat

- **No version bump required.** The change is a single additive optional field plus UI subtraction. The existing loader path (`App.applyProjectData` → `data.fixtures.map(f => ({...f, colorData:[], surfaceId: ...}))`, `App.tsx:803`) spreads unknown/new fields through untouched, so `off` round-trips with zero migration code. This is the same additive mechanism as every prior optional `Fixture`/`Segment` field.
- There is **no `normalizeSegment` helper today** (segments are spread as-is at `App.tsx:803`; `normalizeTimeline`/`normalizeStateMachine` cover other subtrees). We do **not** need one: `off` defaults correctly via falsy `undefined`. If future segment fields need defaulting, that is when to add one.
- **Forward compat:** new file → old app = `off` **persists** but is **ignored by the old render path**, so the gap lights up on that build (see §5 — it is NOT a file-level data loss). **Backward compat:** old file → new app = perfect (no `off` ⇒ on). Recommend the "also open a real uncovered hole" belt-and-suspenders so authored gaps *render* on a downgrade.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius — every consumer of the touched symbols (grepped, not guessed):**
- `Segment` type / segment effect fields: `WebGPUMapper.ts:147-152,255-262`; `InspectorPanel.tsx:116-190`; `Stage.tsx:203,222`; `App.tsx:544,903`; `paramPath.ts:40,159-160`. All keep compiling because we *add* `off` and *retain* the effect fields.
- `buildSegParams`: called from `updateMapping` (`WebGPUMapper.ts:372`) and `updateParams` (`:452`). One-line branch, both call sites unaffected structurally.
- `updateParams` (interface `PixelMapper.ts:11`, optional): callers `Stage.tsx:186,227`. Signature unchanged.
- GPU buffers: **no binding changes.** `segParams` layout (2×vec4/segment + trailing off) is untouched; we only change which mode value a segment writes. `heatBuffer`/`firePipeline` are only touched if the optional §4(a) cleanup lands — keep that in a separate commit precisely to keep this PR's blast radius at "one float + one checkbox."
- Visualization consumers of the read-back buffer: `FixtureLights.tsx:41-46` (3D) and `Stage.tsx` 2D — both already handle 0-valued LEDs; no change needed for correctness, only the optional hatch overlay.

**Regression surface:**
1. **WebGPU vs WebGL parity** — the single most likely thing to "look broken": a gap works in WebGPU (primary) and, unless we add the CPU off-mask post-pass, does *nothing* on the WebGL fallback. Decide explicitly and document.
2. **Param-signature miss** — if `Stage.tsx:222` is not updated to include `off`, toggling Off will not re-upload segParams and the gap won't appear until an unrelated structural edit. Easy to miss, easy to test.
3. **Cue/fade paths** — only breaks if someone also deletes the effect fields from `Segment`. The plan explicitly forbids that. Keep §5's guard.

Projector MessagePort bridge and headless entry are unaffected — they consume the same read-back RGBW bytes; off LEDs are just zeros in that stream.

**Overall: Medium.** Low intrinsic complexity (one optional field, one WGSL-free GPU line, UI subtraction), but it touches the primary render path and the cue-path type surface, and it exposes the pre-existing WebGPU/WebGL parity cliff. The top-3 things most likely to break in practice: (1) forgetting `off` in the Stage param signature; (2) a downgrade silently dropping authored gaps; (3) someone "cleaning up" by deleting the segment effect fields and stranding cue paths.

## 8. Test / verification plan

- **Type:** `npx tsc -p tsconfig.json --noEmit` — proves the `off` addition and UI trim compile with all listed consumers.
- **Headless acceptance (the objective proof):** the §2 fixture (`60 LEDs, 3 segments, middle Off`) run via `--headless --project=<file>.artlux` with a dgram listener parsing ArtDmx(0x5000). Assert middle-third channels are 0 and the outer thirds carry live media bytes. Toggle `off` back off in the file and re-run → all lit. This exercises `buildSegParams` → GPU → native output end-to-end.
- **dev + exercise:** `npm run dev`; split a fixture, mark a segment Off; confirm the 2D Stage shows the dead span (hatch), the 3D simulator's point light dims for that fixture's average, and native output (if enabled) matches. Toggle Off live and confirm the cheap `updateParams` path repaints without a full remap (watch for no fl; verify via the Perf dock that no realloc storm occurs).
- **Regression — old file:** load an existing `.artlux` that used the old per-segment "effect" settings; confirm identical output to the current build (media sampling) and that no controls throw.
- **Regression — cues:** load a project whose Cue references `segments.0.speed`; fire it; confirm no console error from `paramPath` (fields retained).
- **WebGL fallback:** force the WebGL path (e.g. block WebGPU) and confirm the documented behaviour (gap honored via CPU mask if implemented, else explicitly no-gap) — no crash either way.

## 9. Effort & phasing

**Size: S–M.** The core change is genuinely small (one optional field, one `buildSegParams` branch, one Stage signature line, a UI swap). The M comes from the WebGL parity decision and the optional dead-GPU cleanup.

**Rollout order:**
1. Add `Segment.off` + `buildSegParams` branch + `Stage.tsx:222` signature; wire the Inspector **Off** checkbox and **Insert gap** button; ship the WebGPU-only gap. Fast, safe, self-contained.
2. Delete the dead effect UI block (`InspectorPanel.tsx:192-226`); keep the fields. Cosmetic, reversible.
3. (Optional, separate PR) WebGL CPU off-mask for parity.
4. (Optional, separate PR, gated) strip the dead WGSL effect/fire path + `heatBuffer`/`firePipeline` from `WebGPUMapper`.

No feature flag needed — steps 1-2 have no behavioural risk to existing files. If nervous, hide the **Off**/**Insert gap** buttons behind an "experimental" setting for one release; the persisted `off` field is harmless either way.

## 10. Open questions / decision points

1. **WebGL parity: implement the CPU off-mask, or document WebGPU-only?** (Recommend: implement — it's a small post-pass and avoids a "works on my machine" support burden.)
2. **Gap representation: covered off-segment (`off:true`) vs uncovered hole (adjust start/stop) vs both?** (Recommend: author both — an explicit `off` segment for visibility/editability, plus leave the range genuinely uncovered so old builds still render the gap.)
3. **Do we ship the dead-GPU-code cleanup at all, or leave the effect path dormant** in case per-segment effects are ever revived? (Recommend: leave it dormant for now; deleting it is a separate reversible call and buys only shader size.)
4. **Should the retired `Segment` effect fields be formally marked `@deprecated`** in `types.ts` so no one re-wires the UI to them, while keeping them for cue/back-compat? (Recommend: yes — a doc-comment, not a removal.)
5. **Does any existing shipped `.artlux` in `examples/` rely on per-segment effects** such that removing the UI would surprise a tutorial author? (None found — verified: no `.artlux` under `examples/` contains a `"segments"` key.)

**Review note (§5 correction):** the original draft claimed a downgrade would **silently drop** `off` from the file ("data-loss-of-intent"). Verified against `App.tsx:803`: the loader spreads `...f`, so `off` round-trips through load→save on an old build too — the field is **not** lost. The real (and lesser) downgrade issue is purely a *render* regression: the old `buildSegParams` ignores `off`, so the gap lights up until the file is reopened on a new build. §5/§6 corrected accordingly; the belt-and-suspenders uncovered-hole recommendation still stands as the fix for the render regression.
