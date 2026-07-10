# WebGL fallback: strict per-surface sampling (or explicit degradation)

> **Status:** Draft · **Lifts:** Tuto Set #1 (Composite Stage / SURFACES.md S1→S3) — the WebGL fallback bleeds a front surface into back-linked fixtures instead of sampling each fixture strictly from its linked surface · **Placement:** Core · **Risk:** Medium · **Breaking changes:** None (additive optional interface members + one UI-only warning state)

## 1. The limitation today

Strict per-surface sampling (S3) is implemented **only** on the WebGPU backend. The WebGL fallback ignores surface linkage entirely and samples the on-screen composite, so a fixture linked to a *back* surface picks up whatever surface is composited *on top* of it at the same stage location. That inverts the S3 demo (front bleeds into back-linked fixtures).

Verified against current code:

- `src/renderer/services/PixelMapper.ts:7-9` — the interface contract states it outright: *"`surfaces` lets the WebGPU backend sample each fixture from its linked surface (strict per-surface). The WebGL fallback ignores it and samples the composite."* `perSurface` (`:14`) and `renderSurfaces` (`:16`) are **optional** members.
- `src/renderer/services/GPUMapper.ts:119` — `updateMapping(fixtures: Fixture[])` takes **no** `surfaces` argument. It builds a map texture of world-space UVs `(u = cx+rx, v = cy+ry)` in stage-normalized 0–1 coords (`:148-192`) and the fragment shader samples the single composite `u_source` at that UV (`:66-67`). There is no notion of "which surface owns this LED," so a back-linked fixture whose rectangle sits under a higher-`zIndex` surface reads the front surface's pixels.
- `GPUMapper` implements **none** of the per-surface protocol: no `perSurface`, no `renderSurfaces`, no `updateParams`. It only has `updateSource` (`:207`), which uploads the composite canvas.
- `src/renderer/gpu/WebGPUMapper.ts` is the reference implementation: `perSurface = true` (`:186`), `updateMapping(fixtures, surfaces)` inverse-transforms each LED's world point into its linked surface's local UV (`:299-363`), packs the surface index into `ledMeta.w` (`:366`), and `renderSurfaces` composes one atlas (a `SOURCE_SIZE` cell per active surface, `:466-500`) that the compute shader samples per-cell with a half-texel inset guard (`ATLAS_INSET`, `:21`, `:125-127`). Unlinked LEDs go black (`:106`).
- `src/renderer/components/Stage.tsx:162-196` — backend selection. WebGPU is tried first; on failure it silently `new GPUMapper(512,512)` and only `console.log('[Stage] Using WebGL mapper (fallback)')` (`:175`). **There is no UI signal** that the render path just lost per-surface correctness. The only on-screen error state, `webglError` (`:108`, `:875-881`), fires exclusively when *both* backends fail to construct.
- `Stage.tsx:283-333` — the per-frame branch: `perSurface = !!(mapper.current.perSurface && mapper.current.renderSurfaces)` (`:283`). Because `GPUMapper` has neither, it takes the `else` branch (`:332`) and feeds the composite via `updateSource(canvasRef.current)`.

Which tuto it forces a caveat in: **SURFACES.md marks S3 "DONE" (`docs/SURFACES.md:42`)** but that is only true on WebGPU. The doc even says so in passing — `docs/SURFACES.md:46`: *"WebGL fallback keeps composite sampling (degraded; not strict on overlap)."* The gap is therefore **not** that the limitation is undocumented; it is that the **running app gives no signal**. Anyone reproducing the S3 "front/back surface linking" walkthrough on a machine that silently fell back to WebGL sees the opposite of the documented result with nothing on screen to explain it. (Note also that `docs/SURFACES.md:43-44` describes the *old* one-compute-pass-per-surface implementation; the current `WebGPUMapper` uses the single-atlas pass this plan ports — §1 above reflects the code, not the stale doc.)

**Is WebGL even reachable under Electron's bundled Chromium?** Yes. WebGPU is normally present, but `WebGPUMapper.create()` returns `null` (→ fallback) when `navigator.gpu` is absent or `requestAdapter()`/`requestDevice()` fails (`WebGPUMapper.ts:232-244`). In practice that happens on: software/`SwiftShader` rendering, remote-desktop / RDP sessions, blocklisted GPUs or drivers, an OS GPU reset, or a prior WebGPU device-loss relaunch (see `src/main/watchdog.ts:76-81`, which explicitly treats WebGPU device loss as an app event). So the fallback is a real, reachable path — not dead code — and today it degrades **silently and incorrectly**.

## 2. What "lifted" looks like

Target: the WebGL fallback produces the **same per-fixture output** as WebGPU for the S3 linkage demo — each fixture samples strictly from its linked surface, unlinked fixtures are black, and a front surface stacked over a back-linked fixture does **not** bleed into it.

Acceptance test (repurposes the S3 fixture; runnable headless):

1. Build a 2-surface project: surface A (back, `zIndex` low, red media) and surface B (front, `zIndex` high, blue media) overlapping in stage space. One fixture linked to A sits inside B's rectangle.
2. Force the WebGL path (see §9 — a dev flag that makes `WebGPUMapper.create()` return `null`).
3. Run `--headless --project=<fixture>` with a dgram listener parsing ArtDmx. **Pass:** the A-linked fixture's channels are red (its linked surface), not blue.
4. Run the identical project on WebGPU and byte-compare the fixture's RGBW output. **Pass:** WebGL matches WebGPU within a **backend-precision tolerance** — a fixed-source flat-color region should match to ≤1/255 (linear filtering + `toByte` half-up), but the tolerance must widen near cell edges / on machines lacking `OES_texture_float`, because the WebGL fragment shader is `precision mediump float` (`GPUMapper.ts:59`) and the atlas UVs live in a map texture that quantizes to RGBA8 when the float-texture extension is absent (`GPUMapper.ts:35-36`). Do **not** hard-code ≤1/255 as the gate on textured/edge pixels — see §7 precision sub-risk. Assert exact parity only on interior flat-color samples; assert *"linked surface, not the overlapping one"* (red-not-blue) on the S3 fixture regardless of precision.
5. Interim/if-parity-deferred acceptance: forcing the WebGL path raises a visible, dismissable **"Reduced rendering mode — per-surface sampling unavailable"** banner in the editor.

## 3. Placement: core or plugin (REQUIRED)

**Core.** Justification against the doctrine:

- The WebGPU compute mapper is named as **primary** and WebGL as its **fallback**, with "behavior parity between the two is a recurring risk axis" called out in CLAUDE.md. This is the render engine itself, not optional contribution-based behavior. A plugin cannot own half of the primary/fallback pair.
- **No persisted field is added.** Surface linkage (`Fixture.surfaceId`), surface geometry/`zIndex`, and `content.opacity` already exist in the core domain model and are already consumed by WebGPU. We are only teaching the fallback to honor data that is already core. By the "core stays core" rule there is nothing to migrate.
- **Barrel/singleton hazard: not triggered.** No new plugin, no new service singleton. `GPUMapper` and `WebGPUMapper` are plain classes instantiated once inside `Stage`'s init effect (`Stage.tsx:167-181`) and disposed on unmount. We add methods to an existing class; we do not introduce a new module that could be double-imported via alias+relative paths.
- The optional `IPixelMapper` members (`perSurface`, `renderSurfaces`, `updateParams`) exist **specifically** so a backend can advertise per-surface capability. Filling them in on `GPUMapper` is completing the core abstraction as designed.

If parity proves genuinely infeasible on a given machine (no float textures, tiny `MAX_TEXTURE_SIZE`), the honest fallback-of-the-fallback is the **explicit UI warning** — still Core (a Stage UI state), still no persisted field.

## 4. Design / approach

Two deliverables; ship in the phase order of §9.

### Phase 1 — Make the limitation explicit + detectable (renderer only)

`Stage.tsx`:
- Add state `const [reducedMode, setReducedMode] = useState(false)`. In the init effect (`:172-181`), when the WebGL branch is taken, `setReducedMode(true)` **and** keep the existing `console.log`.
- Render a non-blocking banner (distinct from the full-screen `webglError` overlay at `:875-881`) — a small top-of-stage strip: *"Reduced rendering mode: GPU compute unavailable, per-surface sampling is approximate. Fixtures may sample overlapping surfaces."* Dismissable; re-shows on next fallback.
- Optionally surface the same flag in `TopBar.tsx` (a badge) since headless/broadcast have no visible Stage; log-only remains the signal there.

No interface, IPC, schema, or SDK change. Pure additive UI state.

### Phase 2 — Implement strict per-surface parity in `GPUMapper` (renderer/gpu)

Key enabler: **in S3, per-fixture effects are retired — effects live on surfaces and are baked into each surface's drawable** (`WebGPUMapper.buildSegParams` hard-codes media, `WebGPUMapper.ts:257-262`; `surfaceMedia.getDrawable` returns the fully-composed surface). So the fallback does **not** need to reimplement effects/palettes/fire — it only needs to sample each fixture's linked-surface **media** at the correct UV. That collapses the WGSL compute shader down to a plain texture sample, which WebGL can match exactly.

Port the WebGPU atlas strategy to WebGL:

1. **`GPUMapper.updateMapping(fixtures, surfaces?)`** — accept the surfaces arg (the interface already allows it). Reuse WebGPU's per-LED math verbatim (`WebGPUMapper.ts:292-367`): compute each LED's world point (rotation/matrix/serpentine/reverse/ledMap aware), inverse-transform into the linked surface's local UV `(uu,vv)`, and determine `surfIdx` from a `surfaceOrder` list (surfaces referenced by ≥1 fixture). Size a near-square atlas grid (`cols=ceil(sqrt(n))`, `rows=ceil(n/cols)`) exactly as `WebGPUMapper.ts:406-408`.
2. **Map texture** — extend the per-LED map data from `(u,v,0,0)` to the **atlas UV** plus a validity flag: precompute on CPU `auv = ((cellCol + inset(uu)) / cols, (cellRow + inset(vv)) / rows)` with the same `ATLAS_INSET = 0.5/SOURCE_SIZE` half-texel guard (`WebGPUMapper.ts:125-127`); pack a 4th channel = `1.0` if linked else `0.0`. Keep the existing V-flip (`GPUMapper.ts:185`) — note WebGL uploads with `UNPACK_FLIP_Y_WEBGL=true` (`:211`) whereas WebGPU uses `flipY:false`, so the atlas-cell V must be flipped once here; verify against the WebGPU output during the byte-compare test.
3. **`renderSurfaces(getDrawable, getOpacity)`** — new method; set `perSurface = true`. Compose the atlas on an internal scratch canvas exactly like `WebGPUMapper.renderSurfaces` (`:466-500`): black fill, then each surface's drawable drawn into its cell at `globalAlpha = opacity`. Upload that scratch canvas via the existing `updateSource` path (it already handles a `HTMLCanvasElement`).
4. **Fragment shader** — sample `u_source` (the atlas) at the precomputed atlas UV; if the validity flag is `0`, output all-zero (unlinked → black), matching `WebGPUMapper.ts:106`. Keep the existing RGBW min-subtraction + brightness (`GPUMapper.ts:65-78`). Optional parity nicety: honor `RGBWMode.NONE` per fixture (WebGPU does at `:137`) by threading a per-LED mode flag; low priority since it only affects the W channel and the demo doesn't hinge on it — call it out as a known minor gap if deferred.
5. **`Stage.tsx`** — no change needed to the render branch: once `GPUMapper` advertises `perSurface`+`renderSurfaces`, the existing `:283`/`:326` logic routes it through `renderSurfaces` and (in broadcast/headless) skips the dead composite (`:284`). This means Phase 2 also **frees the fallback from the composite dependency**, matching WebGPU's `showPreview=false` optimization.

Data flow after Phase 2 is identical in shape to WebGPU: `surfaces → atlas canvas → single texture upload → per-LED atlas-cell sample → RGBW readback`, differing only in compute (WebGL fragment draw + `readPixels` vs WebGPU compute + `mapAsync`).

**Parity checklist to hold both backends to:** LED geometry (reverse/ledMap/matrix/serpentine), surface inverse-transform (rotation sign, `w/h` normalization), atlas cell indexing + half-texel inset, unlinked→black, brightness, opacity-toward-black, V orientation, RGBW conversion.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**None that break any persisted or cross-process contract. Proof, surface by surface:**

- **Persisted `.artlux` schema:** UNCHANGED. No new field read or written. `surfaceId`, surface `zIndex`, `content.opacity` already exist and are already persisted for WebGPU. Old and new files load identically.
- **`shared/protocol.ts` IPC contract:** UNTOUCHED. The mapper lives entirely in the renderer; nothing crosses IPC. `dmxSignal.publish` (`Stage.tsx:420`) is unchanged — it still receives linear RGBW bytes; only their *values* become correct on the fallback.
- **`@artlux/sdk` surface:** UNTOUCHED. Grep confirms **no** `packages/**` file imports `PixelMapper`/`GPUMapper`/`WebGPUMapper`. These are renderer-internal.
- **`IPixelMapper` interface:** additive only. `perSurface` and `renderSurfaces` are already declared **optional** (`PixelMapper.ts:14,16`); `updateMapping` already declares `surfaces?` (`:9`). `GPUMapper` moves from "doesn't implement the optionals" to "does" — no existing caller signature changes. The sole caller is `Stage.tsx` and it already branches on presence of these members.
- **Saved prefs / keybindings / plugin contracts / MessagePort projector bridge:** UNTOUCHED. The projector receives pixels over its bridge (`src/renderer/projector/bridge.ts`) from `dmxSignal`, not from a mapper instance; its input format is unchanged.
- **UI contract:** the Phase-1 banner is the only new user-visible element — a UI-only addition, no removed/renamed controls.

⚠️ The one behavior that *changes* for existing users: on machines currently on the WebGL fallback, **fixture output values will change** (from composite-bleed to correct per-surface). That is the fix, but flag it loudly: anyone who unknowingly "art-directed around" the bug — e.g. relying on the bleed to tint a fixture — will see different output after upgrade. Mitigation: the Phase-1 banner + CHANGELOG note; optionally gate Phase 2 behind the dev/settings flag (§9) for one release.

## 6. Migration & back-compat

- **No version bump required.** No schema field added → no `normalize*()` helper needed. `.artlux` version stays `'1.1'`.
- Forward/backward compatible: a project saved by the new build opens on the old build (no unknown fields) and vice-versa. The difference is purely runtime render behavior on the WebGL path.
- If Phase 2 is gated behind a persisted setting (see §9), that setting is an **additive optional pref** defaulting to the new behavior; old prefs files load with the default via the existing settings merge. If you prefer zero pref surface, use a non-persisted dev flag instead and skip even that.

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius (grepped, not guessed):**
- `GPUMapper` is instantiated in exactly one place: `Stage.tsx:174`. No other consumer (`packages/`, projector, headless all clear). `led3dLayout.ts`'s match is an unrelated comment.
- `IPixelMapper` is consumed only by `Stage.tsx` (the `mapper` ref) and implemented by `GPUMapper` + `WebGPUMapper`.
- `renderSurfaces`/`perSurface`/`updateSource` call sites: `Stage.tsx:283,326-332` only.
- `Stage` is mounted in exactly three hosts: broadcast/output (`App.tsx:1610`, `showPreview={false}` at `:1629`), editor (`App.tsx:1715`, `showPreview` defaults true), and headless (`HeadlessRunner.tsx:84`, `showPreview={false}` at `:102`). All three share this code path, so a regression in `GPUMapper` hits all three — but **only when WebGPU is unavailable**, which is precisely the currently-broken path. The two `showPreview={false}` hosts are also exactly where Phase 2's "skip the dead composite" behavior (§4 point 5) newly kicks in for the fallback.

**Regression surface:**
- **WebGPU path: zero risk in Phase 1** (only adds a `useState` + banner that never shows on WebGPU). Phase 2 touches only `GPUMapper` + a no-op-for-WebGPU shader/interface completion; WebGPU code is not edited.
- **Per-frame perf (WebGL only):** Phase 2 adds a scratch-canvas atlas compose + one texture upload per frame on the fallback, replacing the old composite upload — net roughly neutral (WebGPU proved the atlas approach *reduces* uploads). `readPixels` cost is unchanged. Editor already composites anyway.
- **Correctness sub-risks (top 3, most likely to bite):**
  1. **V-flip / orientation mismatch** between WebGL (`UNPACK_FLIP_Y_WEBGL=true`, `GPUMapper.ts:211`) and WebGPU (`flipY:false`). Getting the atlas-cell V wrong flips media vertically per cell. Caught by the WebGPU↔WebGL byte-compare test.
  2. **Atlas cell-boundary bleed** if the half-texel inset or `CLAMP_TO_EDGE` differs from WebGPU — reintroduces a subtler version of the original bug at cell seams.
  3. **Precision:** `OES_texture_float` may be unavailable (`GPUMapper.ts:35-36` already warns); atlas UVs in a low-precision map texture could quantize across a large atlas. May need to keep the float map texture or switch to a higher-precision encoding on machines that support it.
- **Singleton duplication / projector bridge / headless:** untouched (no new module, bridge format unchanged, headless just runs the same Stage).

**Overall: Medium.** Phase 1 alone is **Low** (pure additive UI). Phase 2 is Medium because it re-derives exacting geometry/UV math in a second backend on a path that is, by definition, hard to exercise on the primary dev machine (which runs WebGPU) — the parity bugs won't show up unless you deliberately force the fallback. The math itself is a direct port, which caps the risk.

## 8. Test / verification plan

Using the repo's actual patterns:
- **`npx tsc -p tsconfig.json --noEmit`** — confirms `GPUMapper` satisfies the (now-exercised optional) `IPixelMapper` members and the `Stage` branch still type-checks.
- **`npm run dev` + exercise:** force the fallback (dev flag), load the §2 two-surface fixture, confirm the A-linked fixture reads red not blue in the monitor/3D view, and confirm the Phase-1 banner shows. Then run on WebGPU and eyeball identical output.
- **`--headless --project=<fixture>` + dgram ArtDmx listener:** the automated acceptance — byte-compare the A-linked fixture's channels between a WebGPU run and a forced-WebGL run; assert ≤1/255 divergence. This is the anti-regression gate.
- **Regression guard:** run an existing example project on WebGPU before/after to prove Phase 2 didn't perturb the primary path (it shouldn't touch WebGPU at all).
- Add the two-surface fixture to `examples/` as a permanent acceptance artifact.

## 9. Effort & phasing

- **Phase 1 (explicit + detectable): S.** A `useState` + a banner + one `setReducedMode(true)`. Ships the honesty fix immediately and is independently valuable even if Phase 2 slips.
- **Phase 2 (WebGL parity): M.** Porting the atlas + per-LED UV math is mechanical but exacting; the cost is verification, not lines. Bounded because effects are already baked into surface drawables (no shader effect port).

**Safe rollout order:**
1. Ship Phase 1 (banner) — users on the fallback now *know* and the S3 doc caveat is honest.
2. Land Phase 2 behind a flag that forces/allows the WebGL path (`localStorage`/dev setting) so it can be exercised on WebGPU dev machines and byte-compared.
3. Once the headless byte-compare passes, make Phase 2 the default; keep the banner but soften its wording (approximate → exact) or drop it when parity is proven for that machine.

## 10. Open questions / decision points

- **Full parity vs. explicit-warning-only.** Recommendation: do both (Phase 1 always, Phase 2 when green). A human must decide whether Phase 2 is worth the churn given how rare the WebGL path is in the target deployment. If ArtLux ships to controlled hardware that always has WebGPU, Phase 1 alone may be the correct *won't-fix-the-render, just-warn* stance — say so explicitly rather than carrying two divergent render paths.
- **How to force the WebGL path** for testing/gating: a `localStorage` dev flag read in `WebGPUMapper.create()`, a hidden setting, or a menu toggle? Needed before Phase 2 can be verified.
- **`RGBWMode.NONE` and any residual per-fixture params** on the fallback: port for exact parity, or accept a documented minor W-channel gap? (Low stakes; decide before calling parity "done.")
- **Precision floor:** on machines lacking `OES_texture_float`, is the quantized atlas UV acceptable, or should the fallback banner stay up as "approximate" there specifically?
- **Is the WebGL fallback worth maintaining at all,** or should a WebGPU-unavailable machine instead hard-fail into the existing `webglError` overlay (forcing a driver fix)? That is a product call about supported hardware, and it determines whether Phase 2 is built or deleted.

**Reviewer notes (verification pass):** The breaking-change, placement (Core), and migration (no `normalize*()` needed) claims were verified against the code and stand — `GPUMapper`/`IPixelMapper`/`renderSurfaces`/`perSurface`/`updateSource` have exactly one consumer, `Stage.tsx`; nothing crosses IPC, SDK, prefs, or the projector MessagePort bridge. Three accuracy fixes were applied and are **not** reversals of a wrong finding, just sharpenings: (a) §1 no longer claims the degradation is undocumented — `SURFACES.md:46` already states it; the real gap is the *silent running app*. (b) §2's acceptance tolerance was loosened off a flat ≤1/255 gate because the WebGL fragment shader is `mediump` and the atlas-UV map texture quantizes to RGBA8 without `OES_texture_float` (consistent with §7's own sub-risk). (c) §7's host list was corrected — there are two `<Stage>` mounts in `App.tsx` (1610 broadcast, 1715 editor) plus headless, not a separate third App mount.
