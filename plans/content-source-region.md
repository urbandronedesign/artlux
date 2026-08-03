# Content Source-Region (Crop) for Surfaces

> **Status:** Draft · **Lifts:** Tutorial Set #5 (Hello Projector) — two projector outputs can each carry a *different sub-rect* of the same source instead of the identical full field; also unblocks picture-in-picture and multi-output splits · **Placement:** Core · **Risk:** Medium · **Breaking changes:** None (additive optional persisted field + normalize default)

## 1. The limitation today

Content has no crop / source-region anywhere in the data model, so every consumer that draws a surface's content stretches the **whole** drawable across the target rect. Verified against current code:

- **`SurfaceContent` has no crop field.** `src/renderer/types.ts:162-194` — the interface carries `type`, `url`, effect params, and TRACKING transform toggles (`flipH/flipV/rotate` at `:184-186`) but nothing describing a sub-rectangle of the source.
- **`VideoClip` (timeline) carries no transform/crop.** `src/renderer/types.ts:220-235` — a clip's `content?: SurfaceContent` (`:229`) inherits whatever `SurfaceContent` has, so clips can't crop either.
- **`SurfaceEffect.render()` generates the full 96×96 field** with no surface-rect / sub-rect awareness (`src/renderer/gpu/surfaceFx.ts:37-71`). (Note: effects are procedural, so "crop" here means sampling a sub-window of the generated field — same UV remap as any other source.)
- **The three draw sites all stretch the full drawable:**
  - Editor 2D preview: `src/renderer/components/Stage.tsx:302-313` — `ctx.drawImage(d, x, y, w, h)` with no source rect.
  - WebGPU atlas composite (per-fixture sampling): `src/renderer/gpu/WebGPUMapper.ts:483-492` — `drawImage(d, x0, y0, SOURCE_SIZE, SOURCE_SIZE)` blits the whole drawable into the surface's atlas cell.
  - Projector output: `src/renderer/projector/ProjectorGL.ts:146-171` (`buildGeometry`) emits UVs spanning the full `0..1` for both the corner-pin quad and the Bézier mesh; `draw()` (`:174-182`) uploads the entire source texture.
- **Projector windows AND `ProjectorOutput`s are keyed 1:1 by `surfaceId`.** `src/main/projector.ts:15` (`const windows = new Map<string, …>()`) and the renderer's `projectorOutputs.find(o => o.surfaceId === …)` (e.g. `src/renderer/App.tsx:369,413,1369`), plus `defaultProjectorOutput(surfaceId)` in `shared/protocol.ts:407`. **A surface can therefore drive at most one projector window today.** This is the decisive constraint for how the limitation must be lifted (see §3).

**Tuto chapter forced to caveat:** Set #5 "Hello Projector" currently has to tell users that pointing two projectors at one wide LED wall means both show the *entire* source; there is no way to say "left projector = left half, right projector = right half." Multi-projector edge-blending (already supported via `SoftEdge`) is only useful for *overlap*, not for *tiling a source across displays*.

## 2. What "lifted" looks like

Add an **optional normalized source-region** `{ sx, sy, sw, sh }` (all `0..1`, default full `{0,0,1,1}`) to `SurfaceContent`. Every consumer samples only that sub-rect and stretches it across the surface rect / projection quad / atlas cell / clip.

**User-observable acceptance test (buildable as a Set #5 template):**

1. One 3840×1080 video asset. Create two surfaces, both `VIDEO` pointing at it (or both `LAYER` bound to one timeline track — see §7 perf note).
2. Surface A content crop `{sx:0, sy:0, sw:0.5, sh:1}`; Surface B crop `{sx:0.5, sy:0, sw:0.5, sh:1}`.
3. Route Surface A to projector on Display 1, Surface B to projector on Display 2.
4. **Expected:** Display 1 shows the left half full-frame, Display 2 the right half full-frame — a seamless 2-projector span. Fixtures linked to each surface sample only their half. The editor 2D preview shows each surface rect filled with its half.
5. Set crop back to `{0,0,1,1}` (or delete it) → identical to today's behaviour (regression guard).

Bonus acceptance (PiP): a small surface with `{sx:0.6, sy:0.6, sw:0.4, sh:0.4}` over a full-frame surface shows a corner blow-up.

## 3. Placement: core or plugin (REQUIRED)

**Recommendation: Core.** Two independent reasons, both dispositive under the doctrine:

1. **It is a persisted field → core by rule.** The doctrine is explicit: "persisted project types … stay in `shared/protocol.ts` / `renderer/types.ts`. Only BEHAVIOR moves into a plugin." A crop stored on `SurfaceContent` rides inside `ProjectData.surfaces` (`shared/protocol.ts:531`) and inside `VideoClip.content` in the timeline. The type must be core.
2. **No plugin seam exists for the composite.** The three draw sites (`Stage.tsx`, `WebGPUMapper.renderSurfaces`, `ProjectorGL.buildGeometry`) are all core render code. Unlike a *content source* (which has the `contentSourceRegistry` extension point), a *crop* is a property of how any source maps into its rect — there is no registry to contribute it through, and inventing one would be over-engineering for four numbers.

**Barrel/singleton hazard:** N/A — no new plugin, no new service singleton. `contentSource.ts` and `surfaceMedia.ts` stay single-instance exactly as today.

**Where on the model — `SurfaceContent` vs `Surface` vs `ProjectorOutput`? (the seed's central question)**

- **Reject `ProjectorOutput` (the "simpler per-output UV offset").** It is *not actually simpler and does not lift the stated limitation.* Because projector windows are keyed 1:1 by `surfaceId` (`src/main/projector.ts:15`; bridge tags ports by `surfaceId` at `:52-53`; the renderer's `projectorPortsRef` map is keyed by `surfaceId`), **one surface can only ever open one projector window.** A UV offset on `ProjectorOutput` would still need *two* outputs on *one* surface to produce two windows — which requires rekeying the entire projector-window map, the MessagePort bridge, and every `find(o => o.surfaceId === …)` call site from "by surface" to "by output id." That is a far larger, breaking refactor. And even then, a ProjectorOutput-only crop would not reach the editor 2D preview, the WebGPU fixture sampling, or a timeline clip. So this option is both **more** work and **less** capable.
- **Reject `Surface`.** A `Surface`-level crop reaches surfaces but **not** `VideoClip.content` (timeline clips carry a `SurfaceContent`, not a `Surface`). Putting crop on content lets a clip crop over time (animated PiP) for free.
- **Choose `SurfaceContent`.** It reaches both surfaces and timeline clips through one field; it matches the existing precedent that content-space transforms (`flipH/flipV/rotate`, `types.ts:184-186`) already live on `SurfaceContent`; and it is carried to the projector automatically inside the `surface` object of the existing `{ t: 'config' }` bridge message (`src/renderer/App.tsx:1373-1390`) — **zero new IPC.**

The two-projector split is then achieved with **two surfaces sharing one source, each with a different crop, each routed to its own projector** — which fits the existing 1-surface-per-projector architecture with no rekeying.

## 4. Design / approach

### shared / core types (`src/renderer/types.ts`)
- Add to `SurfaceContent` (after the TRACKING transform block, ~`:186`):
  ```ts
  // Normalized source sub-rectangle sampled from the content (0..1, origin top-left). Absent ⇒ full
  // frame {0,0,1,1}. Lets two surfaces show different halves of one source (multi-projector split),
  // or a small surface show a blown-up region (picture-in-picture).
  srcRegion?: { sx: number; sy: number; sw: number; sh: number };
  ```
- Add a tiny normalizer + clamp helper (co-located with `normalizeTimeline`):
  ```ts
  export const FULL_REGION = { sx: 0, sy: 0, sw: 1, sh: 1 };
  export const effectiveRegion = (c: SurfaceContent) => {
    const r = c.srcRegion; if (!r) return FULL_REGION;
    const sx = clamp01(r.sx), sy = clamp01(r.sy);
    return { sx, sy, sw: clamp01(Math.min(r.sw, 1 - sx)), sh: clamp01(Math.min(r.sh, 1 - sy)) };
  };
  ```
  Surfaces load as `data.surfaces as Surface[]` with **no per-surface normalizer today** (`src/renderer/App.tsx:798`), so the field simply defaults to `undefined` ⇒ `FULL_REGION`. No loader change strictly required; `effectiveRegion` centralizes the default.

### renderer — draw sites (WebGPU + WebGL parity)
1. **Editor 2D preview — `src/renderer/components/Stage.tsx:302-313`.** Switch to the 9-arg `drawImage(d, srcX, srcY, srcW, srcH, dx, dy, dw, dh)`. **Both** branches take it — the non-rotated blit (`:313`) *and* the rotated `save()`/`rotate()` blit (`:306-311`, whose drawImage is at `:310`). Source rect = `effectiveRegion(s.content)` × the drawable's intrinsic size. Intrinsic size differs by drawable (`videoWidth/Height`, `naturalWidth/Height`, canvas `width/height`, `ImageBitmap.width/height`) and is `0` before ready — add a small `intrinsicSize(d: CanvasImageSource)` helper (co-located with `surfaceMedia.getAspect`, which already special-cases these) and wrap the blit in the same `try/catch` the atlas uses (see §7.2).
   - **WebGL fallback (`GPUMapper`) inherits the crop for free.** The WebGL backend has no `renderSurfaces`/`perSurface` — it samples the whole 2D composite via `updateSource(canvasRef.current)` (`Stage.tsx:332`), and that composite canvas is exactly the one this 2D-preview blit fills. So cropping the preview blit crops the WebGL fixture sampling automatically, with **no `GPUMapper.ts` change**. This is what keeps the doctrine's WebGPU-vs-WebGL parity honest: the WebGL path is downstream of the same cropped composite.
2. **WebGPU atlas composite — `src/renderer/gpu/WebGPUMapper.ts:483-492`.** Same 9-arg `drawImage` into the cell: source rect = region × intrinsic size, dest = the `SOURCE_SIZE` cell. Applying the crop **here** (at the composite) means per-fixture surface sampling automatically sees the cropped region, staying consistent with the projector. This adds an **optional third `getRegion?(id)` callback** to `renderSurfaces` — which means editing **three** sites, not one: the shared interface `IPixelMapper.renderSurfaces` (`src/renderer/services/PixelMapper.ts:16`), the WebGPU implementation (`WebGPUMapper.ts:466`), and the single call site (`Stage.tsx:327`, fed from `effSurfaces`). The `getDrawable`/`getOpacity` callback signatures are unchanged; `getRegion` mirrors the existing `getOpacity` optional-callback pattern and defaults to `FULL_REGION` when absent (so the WebGL backend, which never passes it, is untouched).
3. **Projector — `src/renderer/projector/ProjectorGL.ts` + `ProjectorApp.tsx`.**
   - Add `srcRegion?: {sx,sy,sw,sh}` to `DrawOpts` (`ProjectorGL.ts:9-18`).
   - In `buildGeometry` (`:146-171`) remap every emitted `u,v`: `u' = sx + u*sw`, `v' = sy + v*sh` (applies identically to the corner-pin quad path and the Bézier mesh path — **one change covers both warps**). The perspective `q` is unchanged. This is the cleanest site because UVs are already normalized — **no intrinsic-size math needed** on the GPU path.
   - `ProjectorApp.tsx`: read `surfaceRef.current.content.srcRegion` (already present — the whole `surface` arrives in `{ t: 'config' }`) and pass `effectiveRegion(...)` into the `opts` object built in the render loop (`ProjectorApp.tsx:179`). No bridge/message change.
   - Streamed sources (VIDEO/CAMERA/…): the full-frame `ImageBitmap` from main is uploaded whole and the crop is a UV window over it — correct and cheap. Self-render (IMAGE/EFFECT/TRACKING): same UV window over the locally-drawn source.

### renderer — UI (`src/renderer/components/ContentEditor.tsx`)
- Add four `Slider`s (or an X/Y/W/H numeric group) for `srcRegion`, gated to non-`NONE`/`LAYER`-agnostic types, wired through the existing `onChange` patch merge. Because `ContentEditor` is shared by the surface inspector **and** the timeline clip inspector, clips get crop UI for free. A "Reset to full" button writes `srcRegion: undefined`.

### Optional (cue-ability)
- `src/renderer/services/paramPath.ts:24` `SURFACE_FADEABLE` and `:113` builder could gain `content.srcRegion.sx/…` paths so crops animate via cues/state-machine. Additive; defer to phase 2.

### main / preload
- **No changes.** No new IPC channel, no `ArtluxApi` method, no persistence code — the field travels inside the already-serialized `surfaces` array and the already-sent `{ t: 'config' }` bridge message.

## 5. ⚠️ Breaking changes (REQUIRED — warn LOUDLY)

**Net: NONE.** This is an additive optional field with a normalize default. Proof, surface by surface:

- **Persisted `.artlux` schema:** `srcRegion` is optional. Old files omit it ⇒ `effectiveRegion` returns `FULL_REGION` ⇒ byte-identical render to today. New files written with a crop and opened by an **older** app version: the older app ignores the unknown field (it does `data.surfaces as Surface[]` with no schema validation, `App.tsx:798`) and renders full-frame — graceful degradation, no crash, no data loss (the field round-trips through save because the whole object is persisted as `unknown[]`). ✅ No version bump required.
- **`shared/protocol.ts` IPC contract:** untouched. `SurfaceContent` is a *renderer* type (`src/renderer/types.ts`); `ProjectData.surfaces` is `unknown[]` in protocol, so the IPC shape does not change. The `{ t: 'config' }` bridge message already carries the full `Surface` — adding a field to its content changes no message type. ✅
- **`@artlux/sdk` surface:** untouched. The SDK exposes `contentSourceRegistry`/`projectorChannelRegistry` contracts; none of them reference a crop. Plugin content sources keep working — their drawable is cropped by the host at the composite, transparently. ✅
- **Saved prefs:** untouched (crop is project data, not a pref). ✅
- **Plugin contracts:** `ProjectorChannel.renderSource` (the GPU-composited path, `ProjectorApp.tsx:182-187`) draws into the source FBO and the host warps it — the crop is a UV window applied in `buildGeometry`, so a plugin's composited content is cropped for free with no contract change. ✅
- **Keybindings / UI contracts:** new sliders are additive; no existing binding changes. ✅
- **Internal `IPixelMapper` interface (`src/renderer/services/PixelMapper.ts:16`):** `renderSurfaces` gains an **optional** third `getRegion?` callback. This is a *renderer-internal* interface implemented only by `WebGPUMapper` (WebGL `GPUMapper` doesn't implement `renderSurfaces` at all) — it is NOT an `@artlux/sdk` or plugin contract and crosses no process boundary. Additive-optional ⇒ non-breaking, but it is a real edit site (see §7). ✅

The only way this becomes breaking is if crop were put on `ProjectorOutput` and the window-keying were rekeyed off `surfaceId` — explicitly **rejected** in §3 for exactly this reason.

## 6. Migration & back-compat

- **Old → new:** no migration step. `srcRegion === undefined` ⇒ `FULL_REGION`. The `normalize*()` pattern isn't even strictly needed because there is no per-surface normalizer to thread through; `effectiveRegion(content)` is the single default site. (If a project-wide surface normalizer is later added for other reasons, defaulting `srcRegion` there is a one-liner — but not required now.)
- **New → old:** forward-compatible. Older app builds ignore the unknown key and render full-frame; the key survives a save (persisted as part of the opaque `surfaces` blob), so downgrading then re-upgrading loses nothing.
- **Version bump:** **not** needed. `ProjectData.version` stays `'1.1'`. (Bumping would be defensible only to *signal* the capability, but it buys nothing functional and risks a stricter future loader rejecting `'1.1'` files — skip it.)

## 7. Risk evaluation for the codebase (REQUIRED)

**Blast radius (grepped consumers of the touched types/functions):**

- `SurfaceContent` is imported across many files, but adding an **optional** field breaks no reader. Direct render-path consumers that must change: `Stage.tsx` (2D preview), `WebGPUMapper.renderSurfaces` (called only from `Stage.tsx:326-330`), `ProjectorGL.buildGeometry`/`ProjectorApp`. UI consumer: `ContentEditor.tsx` (shared by surface + clip inspectors).
- `renderSurfaces` has exactly **one** call site (`Stage.tsx:327`), but adding the `getRegion` callback touches **three** files: the shared interface (`PixelMapper.ts:16`), the WebGPU implementation (`WebGPUMapper.ts:466`), and that call site. All three are renderer-internal; the param is optional so the WebGL backend (which doesn't implement `renderSurfaces`) is unaffected — contained, but not a one-liner.
- `getDrawable`/`getAspect` in `surfaceMedia.ts`/`contentSource.ts` are **not** changed (crop is applied at draw, not at drawable production) — this deliberately keeps the refcounted live-receiver singletons and the `contentSourceRegistry` dispatch untouched.
- The `{ t: 'config' }` bridge and `main/projector.ts` window map are **not** changed.

**Regression surface & the top things most likely to break in practice:**

1. **WebGPU-vs-WebGL parity (highest risk).** Two *different* crop mechanisms run in parallel: a CPU 9-arg `drawImage` source-rect (Stage preview + WebGPU atlas cell) vs a GPU UV remap (projector). They must agree at the sub-pixel level or a fixture-mapped wall and its projector will disagree at crop edges. Mitigation: define crop **once** as normalized region × intrinsic size and unit-check that `drawImage` source-rect and the `u' = sx+u*sw` UV window land on the same texels; reuse the existing half-texel inset discipline the atlas already applies (`WebGPUMapper.ts:19-20`) to avoid cross-cell bleed at crop borders.
2. **Intrinsic-size fragility on the CPU path.** `drawImage`'s source rect is in *source pixels*, so the normalized region must be multiplied by the drawable's intrinsic dimensions, which differ across the `CanvasImageSource` union (video vs image vs canvas vs `ImageBitmap`) and are `0` before a video/image is ready. A wrong or zero size throws (`drawImage` with out-of-range source rect) — today's code already wraps the atlas `drawImage` in `try/catch` (`WebGPUMapper.ts:489-492`), so a bad frame is skipped, but the Stage path (`:306-313`) is **not** wrapped — add the same guard. The projector GPU path avoids this entirely (normalized UVs).
3. **Double-decode perf for the canonical two-projector case.** Two surfaces on the same VIDEO url decode the file twice (media is keyed by surface id in `contentSource.ts:22`), and the frame pump streams two full-frame bitmaps to the two projectors (`App.tsx:1340-1346`). At 30 fps this is real but bounded; the streamed bitmap is the *full* frame (crop happens in-projector), so no extra readback. **Mitigation to document in the tuto:** bind both surfaces to a single `LAYER` (one timeline decode) and crop each, or accept the double decode for two independent sources.

Minor: headless mode drives the same `WebGPUMapper` (it was a separate `headless.tsx` entry when this was written; that fork was **retired in P6** — headless is now `index.html?headless=1`); since crop threads through `renderSurfaces`, headless output honors crop automatically — verify no assumption of full-cell fill in the fixture-sampling WGSL (it samples surface-local UV `0..1`, which now maps to the cropped cell — correct).

**Overall risk: Medium.** The data-model change is trivially safe (additive optional); the *render parity across three sites* is where bugs live. It is contained (one call site for `renderSurfaces`, one UV-remap for both projector warps) and has clear guards, so it stays Medium rather than High.

## 8. Test / verification plan

Using the repo's actual patterns (`docs/DEVELOPMENT.md`):

- **`npx tsc -p tsconfig.json --noEmit`** — the optional field + `effectiveRegion` must typecheck across `Stage.tsx`, `WebGPUMapper.ts`, `ProjectorGL.ts`, `ProjectorApp.tsx`, `ContentEditor.tsx`.
- **`npm run dev` + exercise (2D + projector parity):** build the §2 acceptance fixture (a `.artlux` with two surfaces on one 3840×1080 asset, crops `{0,0,.5,1}` / `{.5,0,.5,1}`, each routed to a WINDOWED projector output so it's testable on one monitor). Confirm: each windowed projector shows its half; the editor 2D preview shows each surface rect filled with its half; fixtures linked to each surface sample only their half (check the DMX monitor / 3D sim).
- **Regression fixture:** open an **existing** pre-change `.artlux` (any tuto set fixture) and confirm pixel-identical output (no `srcRegion` ⇒ full frame). Delete-crop / reset-to-full must return to identical output.
- **`--headless --project=<fixture>` + a `dgram` listener** parsing ArtDmx(0x5000): capture the DMX frame for a cropped-surface fixture rig with crop present vs absent; the cropped run must sample different source pixels (values differ), the full run must match the pre-change baseline byte-for-byte.
- **Round-trip:** save the cropped project, reopen, confirm crop persists; open it in a pre-change build (or with the field stripped) and confirm graceful full-frame fallback.

## 9. Effort & phasing

**Size: M.** The type + normalizer is S; the render-parity work across three draw sites (with the intrinsic-size helper and the WebGPU/WebGL agreement check) is the bulk. UI is S (four sliders in an existing shared editor).

**Safe rollout order:**
1. Add the type + `effectiveRegion` + `intrinsicSize` helper (no behavior change; defaults to full).
2. Wire the **projector** UV remap first (`ProjectorGL.buildGeometry` + `ProjectorApp`) — lowest-risk site (normalized UVs, no intrinsic-size math), and it's the site the tuto limitation names. Verify with a windowed output.
3. Wire the **WebGPU atlas** + **Stage preview** `drawImage` source-rect; verify fixture/preview/projector agree.
4. Add `ContentEditor` sliders + reset.
5. (Phase 2, optional) `paramPath` cue-ability for animated crops/PiP.

No feature flag needed — the field is inert until a crop is set, so shipping it dark is automatic. If extra caution is wanted, gate the `ContentEditor` sliders behind a settings toggle until step 3 is validated.

## 10. Open questions / decision points (human decisions)

1. **Aspect handling.** Cropping a sub-rect and stretching it to a differently-shaped surface changes aspect. Do we (a) always stretch (simplest, matches today's full-frame stretch), or (b) offer a "preserve aspect / letterbox" mode? Recommend (a) for v1; the surface rect already controls shape.
2. **Crop origin/orientation vs TRACKING `flipH/flipV/rotate`.** For TRACKING content, crop composes with the existing flip/rotate. Decide order (crop-then-flip vs flip-then-crop). Recommend crop in *source* space (before flip/rotate) so the region always names source pixels.
3. **Should fixtures sampling a cropped surface see the crop?** This plan says **yes** (crop at the atlas composite) for projector/fixture consistency. Confirm that's the desired semantic — an alternative is "crop is projector-only," but that reintroduces the ProjectorOutput coupling rejected in §3.
4. **Handle-based crop editing** (drag a crop rect on the source thumbnail) vs numeric sliders — UX polish, defer.
5. **Version signalling.** Confirm we do *not* bump `ProjectData.version` (§6). If any downstream tool keys behavior off the version, revisit.
6. **Double-decode acceptance.** Confirm the tuto will steer users to the single-`LAYER`-two-crops pattern for the split case, or whether a shared-decode optimization (key media by url, not surface id) is worth a follow-up.
