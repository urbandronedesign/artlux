# Multi-projector soft-edge blend — auto-calibrated (2 projectors, one screen)

> **Status:** Draft 2026-07-28 · **Answers:** "can a 2-projector soft-edge rig be auto-calibrated in the current app?" — **no, not end-to-end; four of the five pieces exist and none of them are connected** · **Placement:** Hybrid (the persisted blend field is Core by rule; the solve + apply are `plugins/calibration`) · **Risk:** 🟠 Medium-high · **Breaking changes:** project-file additive-optional, bridge additive-optional, no SDK break

---

## 1. The limitation today — the honest answer

Two questions hide inside "can it auto-calibrate a soft edge":

| Capability | State today |
|---|---|
| Two outputs, two displays, one picture split with an overlap | ✅ **works** — span wizard, 2×1 @ 12 % default (`services/outputSpan.ts:48-72`, `App.tsx:712-768`) |
| Soft-edge feather that is *light-linear* (the two halves sum to 1) | ✅ **works, hand-authored** — `ProjectorGL.ts:43-57`, `pow(a, 1/gamma)` |
| **Auto-calibrate each projector's geometry** onto 3D venue geometry | 🟡 **code-complete, unvalidated on hardware** — the Auto-Align wizard |
| **Auto-derive the blend** between the two calibrated projectors | ❌ **the solver exists and has zero callers** |
| **Apply any blend at all to a calibrated output** | ❌ **not even manually** — see the load-bearing gap below |

So: if the rig is **a flat screen or wall** and you are content to corner-pin by hand, a 2-projector soft edge works **today** and the blend math is correct. If the ask is *"point a camera at it and let the app solve the seam"*, that does not exist. And the last row is the one that hurts — **the moment an output turns on `useCalibration`, it stops being blendable by any means.**

### The gap chain, link by link

1. **The geometric prerequisite is satisfied, and this is the good news.** `solveGeometry` raycasts the loaded venue mesh for its object points and solves the projector pose in that frame (`markerlessController.ts:121-145`, `venueRaycast.ts`). Two projectors auto-aligned against the **same GLB** are therefore metrically co-registered in one world frame with no extra work. Nothing about the existing flow prevents running projector A, then projector B.
2. **`solveGeometry` already returns exactly the input the blend solver wants** — `denseMap: { proj, world }` (`markerlessController.ts:157`), the VIOSO-`.vwf` equivalent.
3. **…and the wizard throws it away.** `runScan` persists only K / dist / R / t / imageSize / RMS (`AutoAlignWizard.tsx:299-303`). `denseMap` lives in a React `useState` and dies on `onClose()`. `ProjectorCalibration` (`shared/protocol.ts:502-514`) has no field for it. **The two dense maps never coexist anywhere in the process.**
4. **`computeBlendMaps` has no caller.** `blendCompute.ts:63` — 154 lines of complete, correct partition-of-unity math (chamfer footprint-edge distance → world-voxel association across projectors → `α_i = d_i / Σd` → black-lift weights). The renderer barrel re-exports only the *type* `BlendMap` (`renderer.ts:27`). Nothing constructs a `ProjectorBlendInput`.
5. **THE LOAD-BEARING GAP — a calibrated output has no blend stage at all.** `useCalibration` puts the projector window into `calib mode:'render'` (`App.tsx:3139-3146`); `CalibProjector` then mounts `ProjectorScene` as a full-window overlay **on top of** the base GL canvas (`CalibProjector.tsx:150-153`, `ProjectorApp.tsx:405-410`, and the file header says so outright: *"the base warp/output loop never reads calib mode, so the overlays just sit above it"*). `ProjectorScene.tsx` contains **no alpha, no feather, no blend** — only a lens-distortion post-pass (`:126-130`). So `ProjectorGL`'s correct soft-edge shader is rendered dead for exactly the outputs that need it. Two auto-calibrated overlapping projectors today = **double brightness in the overlap with a hard boundary.**
6. **The NVAPI escape hatch is wired shut.** `App.tsx:3284` calls `outputToNvwarp(o, display)`; the third parameter is `blendMap: BlendMap | null = null` (`nvwarpApply.ts:184`), so the `if (blendMap) share *= sampleBlend(...)` branch (`:151`) and the spatial black-lift branch (`:160`) are dead in production. The comment on that line ("blendMap feed wired with multi-projector capture") is aspirational. And this path only exists on Quadro/RTX-pro with `hwWarp` on.
7. **No rig concept.** `calibWorkspace` holds a scalar `target: string | null` (`calibWorkspace.ts:44`), and `slCapture` / `calibController` are module-level singletons — one active scan at a time. Sequential A-then-B is fine; there is no object that means *"these N outputs are one screen."*
8. **MPCDI cannot close the loop either.** Export is wired but passes no blend (`AutoAlignWizard.tsx:322`); import parses (`main/mpcdi.ts:151`, preload `:68`) and has **no renderer caller** — nothing applies a parsed region.

`docs/AUTO-ALIGN.md:45` states the same thing in one line: Phase 2 is *"code-complete; node-validated; **apply-to-outputs + multi-proj capture pending hardware**"*. This plan is that apply + capture.

---

## 2. What "lifted" looks like

**Acceptance test (hardware, the real one):**
1. Two projectors overlapping ~15 % on the venue geometry; venue GLB loaded; one camera position that sees **both** footprints.
2. Outputs ▸ Calibrate ▸ Auto-Align on projector A: anchor, scan, Apply. Repeat on projector B **from the same camera position** (ArUco one-click re-anchor if a marker map exists).
3. Outputs ▸ **Solve rig blend** → both outputs receive a `ProjectorBlend`.
4. Enable render-from-projector on both. **The seam is invisible**: no bright band, no dark band, no step in black level.
5. Save, quit, relaunch, open the project → the blend is still there, no rescan.
6. Move projector B 20 cm → its blend badges **stale**; re-run Auto-Align on B alone and re-solve; seam restored.

**Acceptance test (no hardware — what actually gates the merge):**
1. `node scripts/blend-check.cjs` — synthetic two-projector wall: `Σα = 1 ± 1e-3` over every associated voxel; each α monotonic toward its footprint edge; single-projector input returns all-1 interior and **no** `black` array; three-projector input still sums to 1.
2. **Blend Inspector** panel: per-output alpha heatmap + a **Σα coverage map** that paints red wherever the sum deviates from 1. This is the offline proof that the solve is right on *real captured* data, not just synthetic.
3. `npm run verify` clean, including two new invariants (§4, Phase A and E).

---

## 3. Placement — core or plugin

Split, per the `CLAUDE.md` doctrine (*persisted project types stay core; only behaviour moves*):

- **`ProjectorBlend` (the persisted result) → CORE**, `shared/protocol.ts`, as `ProjectorOutput.blend?`. It rides inside `.artlux`; that alone decides it. It is also read by `nvwarpApply.ts` (host) and the bridge, neither of which may depend on plugin internals for a persisted shape.
- **`computeBlendMaps`, the rig store, the solve orchestration → `plugins/calibration`.** Behaviour, camera-derived, already lives there. `BlendMap` (the in-memory compute type, `Float32Array`) stays plugin-side and is already exported from the renderer barrel — `nvwarpApply.ts:16` already imports it that way, which is the correct host↔plugin seam and must not regress into a relative import.
- **The GLSL blend stage → `plugins/calibration/src/ProjectorScene.tsx`**, because that is the only thing a calibrated output renders. But **the feather math itself must be shared with `ProjectorGL`** (extract the GLSL `feather()` + `pow(share, 1/g)` into one exported const in `src/renderer/projector/`), or hardware, GLSL-2D and GLSL-calibrated will silently drift into three different seams. Precedent: `plans/projector-blend-preview.md:117` makes the identical argument about `FRAG`.
- **Rejected: `ProjectorCalibration.denseMap`.** A stride-4 scan yields 10⁴–10⁵ points × 5 numbers. That is megabytes of regenerable scan data in every `.artlux`, for a value that is invalid the moment the projector moves. Persist the ~20 KB *derived* blend; keep the dense map session-scoped.

**Barrel/singleton hazard (this repo has shipped this bug):** `blendStore` is a module singleton. The host reaches it **only** through `@artlux/plugin-calibration/renderer`; the plugin's own files import it relatively. Verify with a unique string marker appearing exactly once per window bundle.

---

## 4. Design

### Phase A — a calibrated output can be blended at all *(no hardware; unblocks manual soft edge immediately)*

This is worth landing on its own even if nothing else in this plan is built: it turns "a calibrated 2-projector rig cannot be blended by any means" into "a calibrated 2-projector rig can be hand-blended like every other output."

1. **`src/renderer/projector/blendGlsl.ts` (new).** Export the feather source as one const, and rewrite `ProjectorGL.ts:39-57` to interpolate it. Byte-identical text on both paths is the whole point.
   ```glsl
   float feather(float d, float w) { return w <= 0.0 ? 1.0 : clamp(d / w, 0.0, 1.0); }
   float softEdgeShare(vec2 uv, vec4 s) {
     return feather(uv.x, s.x) * feather(1.0 - uv.x, s.y)
          * feather(uv.y, s.z) * feather(1.0 - uv.y, s.w);
   }
   // signal = share^(1/gamma): the projector emits signal^gamma, so two halves sum to exactly 1.
   ```
2. **`ProjectorScene.tsx`:** add a `BlendEffect extends Effect` carrying `uSoft` (vec4), `uBlendGamma`, `uColorGain`, `uBlackLift`, and an optional `uBlendTex` / `uBlackTex` (`THREE.DataTexture`, `RedFormat`/`FloatType`, `LinearFilter` — the map is 80×45 and *must* interpolate). `mainImage` computes `share = softEdgeShare(uv, uSoft) * texture(uBlendTex, uv).r`, then `a = pow(share, 1.0/g)`, then `outputColor.rgb = outputColor.rgb * a * uColorGain + uBlackLift * blackWeight`. Exactly the composition `buildIntensity` uses (`nvwarpApply.ts:149-166`) so GPU and scanout agree.
3. **Ordering:** `<Distortion/>` **then** `<Blend/>`. The blend map is indexed by *decoded projector pixels* — physical raster coordinates that already contain the lens distortion — so it must be applied after the distortion remap. Mount the `EffectComposer` when `hasDistortion || needsBlend` (today it mounts only for distortion, `:126`).
4. **Getting the values into the window:** `CalibProjector`'s `ctx.onMessage` already receives *every* `MainToProjector` message and simply ignores `config` (`CalibProjector.tsx:43-55`). Add a `m.t === 'config'` branch reading `m.render.softEdge / colorGain / blackLift`. No bridge change needed for Phase A.
5. **Invariant (`scripts/verify-invariants.cjs`):** *"the calibrated render path applies the output's soft edge"* — assert `ProjectorScene.tsx` imports the shared feather const, and that `ProjectorGL.ts` no longer inlines its own copy. This encodes the exact bug being fixed: an overlay that covers the base canvas and drops its blend.

### Phase B — the rig session keeps the dense maps

1. **`plugins/calibration/src/blendStore.ts` (new)** — a pub/sub module singleton in the `calibWorkspace` idiom:
   ```ts
   interface RigScan { raster: [number, number]; denseMap: { proj: number[]; world: number[] }; capturedAt: string }
   put(surfaceId, scan) / get(surfaceId) / all() / clear(surfaceId) / subscribe(cb)
   ```
   Session-scoped, never persisted, cleared on project load.
2. **`AutoAlignWizard.runScan`** (`:298`) also calls `blendStore.put(surfaceId, { raster: r.calibration.imageSize, denseMap: r.denseMap })`. One line; everything else in the wizard is unchanged.
3. **`shared/protocol.ts` — the persisted result:**
   ```ts
   export interface ProjectorBlend {
     w: number; h: number;          // low-res grid (computeBlendMaps caps mapW at 80 → ≤ 80×45)
     alpha: number[];               // w*h, 0..1, row-major, rounded 4dp (Float32Array is not JSON)
     black?: number[];              // w*h spatial black-lift weight; absent when a single projector
     solvedAt: string;
     rigIds: string[];              // the surfaceIds solved together — drives staleness
   }
   ```
   plus `ProjectorOutput.blend?: ProjectorBlend`. ~3 600 numbers ≈ 20 KB per projector — the reason the *result* is persisted and the input is not.
4. **Staleness** (badge, never silent): a blend is stale when any `rigIds` member's `calibration.calibratedAt` is newer than `blend.solvedAt`, or when the set of currently-calibrated outputs differs from `rigIds`. A stale blend still renders — it is better than no blend — but the Outputs row says so.

### Phase C — solve and apply

1. **`plugins/calibration/src/blendController.ts` (new):** `solveRig(surfaceIds)` → pull from `blendStore` → `computeBlendMaps(inputs)` → for each result, `storeBlend(surfaceId, toProjectorBlend(map, rigIds))`.
2. **`calibHost.ts`:** add `storeBlend(surfaceId, blend)` beside the existing `storeCalibration` — same host-services patch idiom (`calibHost.ts:52`).
3. **Bridge (`bridge.ts:54`):** extend the calib message additively —
   `| { t: 'calib'; mode: …; crosshair?; calibration?: ProjectorCalibration | null; blend?: ProjectorBlend | null; blendOwner?: 'gpu' | 'scanout' }`.
   One producer (`App.tsx:3139-3146`), one consumer (`CalibProjector.tsx:45-49`). Read as optional so a hot-reload version skew degrades to no-blend, never a crash.
4. **Refuse to solve mid-scan.** `slCapture` is a singleton; `solveRig` must no-op with a message while a scan is active.

### Phase D — the rig UI *(question the shell before adding to it)*

**No new workspace context.** Per `docs/WORKSPACE.md` and the standing rule, a feature that needs a place is first a reason to question the shape of the places that exist. The `calib` context is per-output by construction; the rig is a *project-level* fact about outputs. That is the Outputs panel.

- **`OutputsPanel` header strip (panel-level, not per-row):** *"Rig blend — 2 of 3 outputs scanned · **Solve rig blend** · Clear"*, disabled with a reason when fewer than two outputs have a scan. Per-row: a small blend badge (`solved` / `stale` / `—`).
- **`BlendInspector` panel (new, registered into the `project` and `calib` contexts):** per-output alpha heatmap, and the **Σα coverage map** — the only thing that proves the partition of unity on *real* captured data without two projectors on a wall. This is the verification tool, and it is the reason Phase D is not optional.
- **AutoAlignWizard ▸ Verify:** when ≥2 outputs have scans, the Apply step also offers *"Solve rig blend now"* so the operator never has to know where the button lives.

### Phase E — NVAPI feed, and the double-blend guard

1. `App.tsx:3284` → `outputToNvwarp(o, display, blendMapOf(o.blend))`.
2. **Blend must be applied exactly once.** If `hwOwnsGeometry(o)` the scanout carries the intensity, so the GLSL `BlendEffect` must be off — the exact mirror of the existing double-*warp* guard (`App.tsx:3116-3121`). Drive it with `blendOwner` on the calib message.
3. **Invariant:** assert that the calib message carries `blendOwner` wherever `calibration` is pushed, and that `ProjectorScene`'s blend is gated on it. A double blend is `α²` — a visible dark band that looks exactly like a mis-set gamma, which is the single hardest class of bug to diagnose on a wall at 2 a.m.

### Phase F — photometric match across the rig

Geometry is only half a seam; the other half is that the two projectors are different lamps.
- Extend `gammaController.measureGamma` from per-output to a **rig sweep** from one camera position: white point → per-output `colorGain`; black floor → per-output `blackLift`.
- **Write the measured gamma into `softEdge.gamma`.** `protocol.ts:486` instructs the operator to measure it with exactly this tool, and then nothing writes it — they hand-copy a number between two fields today.

### Phase G — the hardware session

In dependency order, because each step's failure mode masks the next:
1. Validate Phase 0 single-projector auto-align at all (`docs/AUTO-ALIGN.md:87`) — everything here is built on a pipeline that has **never run against a real projector**.
2. Scan A and B **from one camera position**. This matters more than it looks: two independent camera-pose solves give the two dense maps *uncorrelated* world error, and their overlap disagrees by the sum. One camera pose (or one shared ArUco marker map) makes the error **systematic and shared**, so the two footprints agree in the overlap even when both are slightly wrong in absolute terms. The wizard should say this on the Scan step.
3. **Pose nudge (build this before the hardware session, not during it).** A soft edge hides perhaps 1–2 px of geometric misalignment. Two RANSAC PnP solves will not agree to 1 px. A per-output translation/rotation trim (arrow keys against a live crosshatch on both projectors) is the difference between "the math is correct" and "the seam is invisible", and every commercial tool has one. Six new fields on `ProjectorCalibration`, applied in `CalibCamera` (`ProjectorScene.tsx:67-74`).
4. Then NVAPI intensity parity: confirm the GLSL and scanout blends agree by toggling `hwWarp` and looking for a step (`nvwarpApply.ts:155` is flagged UNVALIDATED for exactly this).
5. MPCDI import-apply, last — it is interchange, not a prerequisite for a working seam.

---

## 5. ⚠️ Breaking changes

- **Project file (`.artlux`) — additive optional, no version bump.** `ProjectorOutput.blend?` follows the `normalize*()` pattern in `renderer/types.ts`; old projects load with `undefined` → no blend, which is today's behaviour exactly. New files opened by an older build ignore the unknown key (JSON superset). **Size:** ~20 KB/projector, ~40 KB for the 2-projector case — noted, not a concern.
- **Bridge `calib` message — additive, read as optional.** One producer, one consumer; TypeScript flags the producer, which is the intended safety net. `m.blend ?? null` keeps a hot-reload skew alive.
- **`ProjectorGL.ts` shader text is refactored, not changed.** The extracted GLSL must be **byte-identical**; the 2D warp path is show-critical and currently correct, including the `pow(a, 1/gamma)` fix documented at `protocol.ts:476-486`. Any drift here re-opens a bug this project has already shipped and fixed once.
- **Behavioural change, and it is the point:** a calibrated output that has a `softEdge` set today ignores it. After Phase A it obeys it. An operator who set a feather on a calibrated output, saw nothing happen, and left the value there will see their picture change on upgrade. Call it out in the changelog.
- **SDK — none.** `BlendMap` is already exported from the calibration renderer barrel; `storeBlend` is an additive host-service method.

---

## 6. Migration & back-compat

No migration. `blend` absent → the render path takes the same branch it takes today. `rigIds` on a blend written by this build is self-describing, so a future 3-projector rig re-solve invalidates a 2-projector blend automatically rather than blending against a projector that is no longer in the rig. The dense map is never persisted, so there is no format to migrate later when the scan changes.

---

## 7. Risk evaluation

**Blast radius — grepped, not guessed:**
- `ProjectorScene.tsx` — rendered **only** by calibrated outputs in `'render'` mode (`CalibProjector.tsx:149`). Small consumer set, but 100 % of the affected feature. Mounting `EffectComposer` unconditionally adds a fullscreen pass + copy at `dpr [1,2]` on what may be a 4K projector: **measure before/after frame time**; if it costs, mount only when `needsBlend`.
- `ProjectorGL.ts` — one instantiation (`ProjectorApp.tsx:168`), but it is the show-critical 2D path for every non-calibrated output. The shader extraction is the highest-consequence, lowest-complexity edit in this plan.
- `ProjectorOutput` (`shared/protocol.ts:517`) — wide: `OutputsPanel`, `App.tsx` (many), `nvwarpApply.ts`, `bridge.ts`, persistence. Additive-optional keeps every consumer compiling untouched.
- `App.tsx:3277-3294` (NVAPI reconcile) and `:3139-3146` (calib push) — two effects, both already keyed on `projectorOutputs`, so a `blend` change repaints correctly for free.
- `blendCompute.ts` — **zero existing callers**, so Phase C cannot regress anything. Its risk is the opposite kind: 154 lines of untested-in-tree math about to become load-bearing. `scripts/blend-check.cjs` is not optional.

**Regression surface, ranked by how likely it is to actually bite:**
1. **Double blend** (GLSL + scanout both applying) → `α²`, a dark seam that mimics a gamma error. Guarded in Phase E; add the invariant.
2. **Feather drift** between the extracted GLSL and NVAPI's CPU replica → a step at the seam that only appears when `hwWarp` toggles.
3. **Blend applied before distortion** → the ramp lands a few pixels off the physical footprint edge. Subtle, and it worsens with lens distortion, which is exactly where you'd blame the lens instead.
4. **`DataTexture` filtering:** an 80×45 map with `NearestFilter` produces visible blocky banding across the whole overlap. `LinearFilter`, and the upload must be flagged `needsUpdate` on every solve.
5. **Perf**: the composer pass on high-resolution projector windows.
6. **Everything downstream of a pipeline that has never met a projector.** Phase 0 is code-complete and unvalidated; if the pose solve is wrong, the blend will be beautifully computed nonsense on top of a picture that is in the wrong place. This is the dominant risk in the whole plan and no amount of blend work reduces it.

**Overall: 🟠 Medium-high** — driven almost entirely by (6) and by touching a show-critical shader, not by the new code, which is additive and independently verifiable offline.

---

## 8. Test / verification plan

Repo patterns only (`docs/DEVELOPMENT.md` → Testing; there is no unit runner):
1. `node scripts/blend-check.cjs` (new, committed) — the synthetic assertions in §2. `computeBlendMaps` is pure, imports nothing, and needs no harness; the docs claim it was node-validated and **no such script is in the tree** — recreate it committed so the claim is checkable.
2. `npm run verify` — typecheck + the two new invariants.
3. `npm run dev`, one machine, two windowed outputs, no projectors: **Phase A regression** — a calibrated output with `softEdge` set now feathers to black at its edge (today it does not). This is directly visible on the desk.
4. **Blend Inspector Σα map** on a real captured pair — the offline proof.
5. **Two overlapping desktop windows cannot show the sum.** Opaque `BrowserWindow`s composite alpha-over, never additive — inherent, documented in `plans/README.md` §"Scope boundary" and `plans/projector-blend-preview.md:11-14`. The additive union preview in that plan's §4b is the honest on-desk substitute; **this plan does not depend on it, but they should land near each other** — it is the only way to see a seam without a venue.
6. Regression: a **non**-calibrated output's picture must be byte-identical after the shader extraction. Compare a screenshot before/after via `scripts/capture-docs.cjs`.
7. Headless (`--headless --project=…`) — no projector windows, no calib push; assert the Art-Net stream is untouched.

---

## 9. Effort & phasing

| Phase | Size | Hardware? | Ships value alone? |
|---|---|---|---|
| **A** — blend reaches the calibrated render path | **S–M** | no | ✅ **yes** — manual soft edge on calibrated outputs, today |
| **B** — rig store + `ProjectorBlend` persisted | S | no | no (enables C) |
| **C** — solve + apply | S | no | ✅ yes, with D |
| **D** — Outputs rig strip + Blend Inspector | M | no | ✅ yes — and it is the verification tool |
| **E** — NVAPI feed + double-blend guard | S | Quadro to confirm | no |
| **F** — rig photometric match | M | camera | ✅ yes |
| **G** — pose nudge + the hardware session | M | **yes** | ✅ yes — the nudge is useful with or without any of this |

**Build A–D blind, in order; they are all offline-verifiable.** E and F want hardware to confirm but not to write. G is the session where this either works or teaches you why not — and **build the pose nudge (G.3) before that session**, because discovering you need it while standing in front of two projectors costs a day.

**If only one thing gets built: Phase A.** It is small, it is a strict correctness fix, and it removes the sentence *"turning on calibration silently disables your blend."*

---

## 10. Open questions / decision points

- **Does the answer the user actually needs require any of this?** If the "2-screen soft edge" is a **flat screen**, the existing span + corner-pin route works today and is mathematically correct — the honest recommendation is to use it, and to treat auto-align as the thing you reach for when the surface is *not* flat. Confirm the surface geometry before committing to the whole plan.
- **Who owns the blend by default, GLSL or scanout?** Recommend **GLSL**: it works on every GPU, it is previewable, and the calibrated render is already GPU-side. NVAPI only when `hwWarp` is explicitly on. The alternative — scanout-always — is more "correct" (content-agnostic, survives an app crash) but it is Quadro-only and currently unvalidated.
- **Persist `alpha` as `number[]` or base64 `Float32Array`?** Recommend `number[]` at 4 dp: ~20 KB, and the `.artlux` stays diffable and hand-inspectable, which has repeatedly been worth more than bytes in this project.
- **Per-output `blend` vs a rig-level `ProjectData.blendRig`?** Per-output matches the existing shape and keeps every consumer local; `rigIds` supplies the grouping. Revisit only if a projector ever belongs to two rigs.
- **`mapW` default (80, `blendCompute.ts:68`)** — adaptive from sample count today. Is 80×45 enough resolution for the ramp on a 4K projector? Bilinear upsampling of a smooth ramp should be fine, but this is the first thing to look at if the seam bands.
- **Three or more projectors:** `computeBlendMaps` is already N-ary and the black-lift normalization assumes N. The UI in Phase D should not special-case 2. Untested beyond synthetic.
- **Should a stale blend keep rendering, or blank?** Recommend keep rendering + badge. A stale seam is a bad seam; no seam is a black hole in the middle of a show.
