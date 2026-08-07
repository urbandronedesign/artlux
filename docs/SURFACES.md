# ArtLux — Surfaces engine (design & roadmap)

The app's core/"final" logic, MadMapper-style:
**create a Surface → feed it content (video / live / image / Spout / shader effect) → create & save
a Fixture → place it & link it to a Surface → it samples only that surface**, with automatic
universe/address allocation and a multi-controller routing spreadsheet.

## Concepts
- **Surface** — a rectangle on the stage carrying one content source. On-canvas it's **cyan**.
  `Surface { id, name, x, y, width, height, rotation, zIndex, content }` (rect normalized 0..1,
  and **unbounded** — the unit square is a reference frame, not a fence: a surface placed outside
  it keeps its content, its preview and its outputs. Only reduced/WebGL rendering mode samples the
  0..1 document, and the Stage shows a document frame + a warning chip there).
- **SurfaceContent** — `{ type: NONE | VIDEO | IMAGE | CAMERA | SPOUT | DMX_IN | EFFECT, url?,
  spoutName?, effectId?, paletteId?, speed?, intensity? }`.
- **Slice** (`type: SLICE`) — a surface that shows a **cropped region of another surface**
  (`sliceOf`, `sliceRect`) instead of owning content. It borrows the source's picture, so N slices of
  one video cost **one** decode; because each slice is a normal Surface it gets its own projector
  output with its own homography, warp and soft edge. This is how one picture spans several
  projectors — see [OUTPUTS.md → Spanning](OUTPUTS.md). Slices don't nest, and a fixture may link to
  one (the LEDs beside projector 3 then sample exactly what projector 3 shows).
- **Fixture** — an LED layout (red on-canvas). Gains `surfaceId` (link), and later `controllerId`,
  `patchLocked`. When linked, its placement is interpreted in the surface's local space (S3).
- **Controller** (S5) — a physical output device `{ id, name, protocol, ip, broadcast, priority?,
  startUniverse? }`. Fixtures are assigned to one and auto-patched.

<!-- audience:contributor -->

## Decisions (locked)
1. **Strict per-surface textures** — a linked fixture samples ONLY its surface, regardless of overlap.
2. **Effects on surfaces** — an effect is a surface content type rendered 2D into the surface; the
   per-fixture "source = Effect" UI is retired (engine kept during migration).
3. **Standard routing spreadsheet** (no external reference).
4. **One live input at a time** in v1 (many video/image/effect surfaces, single camera OR Spout).

## Engine design (target, S3)
Per-surface render → per-surface sample, reusing the compute shader's normalized
`textureSampleLevel(srcTex, samp, uv)`:
- each surface renders its content into its own texture (media → 2D canvas; effect → 2D shader);
- `ledData` is grouped by `surfaceId` with **surface-local UVs**; for each surface, bind its texture,
  dispatch only its LEDs (`{base,count}` uniform), write `outBuf[base+i]`; one readback per frame;
- per-LED effect branches drop out of the main shader (effects come from the surface texture).

## Phases
- **S1 — Surfaces + compositing + UI (DONE).** `Surface`/`SurfaceContent` types; `services/
  surfaceMedia.ts` (per-surface media + single live camera/Spout/DMX); `Stage` composites surfaces in
  z-order (fixtures sample the composite for now); cyan on-canvas surfaces (move/resize/rotate);
  Surfaces browser; surface Content+Transform inspector; project persistence + default-surface
  migration.
- **S2 — Effect surfaces (DONE).** 2D generative effects (`gpu/surfaceFx.ts`: Solid/Rainbow/Palette
  Flow/Wave/Fire) rendered into a per-surface canvas from the palette LUT; surface-EFFECT inspector
  with effect/palette/speed/intensity.
- **S3 — Strict per-surface sampling + fixture↔surface linking (DONE).** `WebGPUMapper` stores
  surface-local UVs + per-LED surface index (`ledMeta.w`); `renderSurfaces(getDrawable)` runs one
  compute pass per surface (gate `surfIdx == params.p0`), clearing `outBuf` each frame so unlinked
  LEDs are black. Fixtures carry `surfaceId` (default-linked on add/load) + a Surface dropdown in the
  inspector. Per-fixture effects retired in the engine. WebGL fallback keeps composite sampling
  (degraded; not strict on overlap). Verified: a fixture linked to surface A still samples A with a
  black surface B composited on top.
- **S4 — Fixture library (DONE).** `FixtureTemplate` (LED definition only) saved to userData prefs;
  ScenePanel **Library** section (save selected / add instance / delete).
- **S5 — Controllers + auto-patch (DONE).** `Controller` type + `Fixture.controllerId`/`patchLocked`;
  `services/addressing.ts` `autoPatch` packs universes/addresses sequentially per controller
  (channelsPerPixel-aware, wraps at 512; `patchLocked` keeps manual). Auto-runs on add/remove/
  ledCount/channels/controller changes + a Re-patch button; `Stage` resolves each fixture's
  destination from its controller → per-fixture `output` override → global settings.
- **S6 — Routing spreadsheet modal (DONE).** `RoutingModal.tsx` (File → Routing…): a Controllers
  sub-panel + a fixtures patch grid (name · surface · controller · universe ·
  start · channels · LEDs · span · lock); inline edit, lock-to-edit-address, Auto-patch.

**Surfaces engine S1–S6 complete.**

## Key files
`src/renderer/types.ts` (Surface/SurfaceContent/Controller), `src/renderer/services/surfaceMedia.ts`,
`src/renderer/engine/frameEngine.ts` (owns the loop, the per-surface dispatch, the WebGL-only 512²
composite, and the Stage's per-surface preview canvases — `paintSurfacePreviews`),
`src/renderer/components/Stage.tsx` (the viewport: overlays, drag, and the lent preview canvases),
`src/renderer/gpu/{WebGPUMapper,GPUMapper}.ts` (S3), `src/renderer/gpu/surfaceFx.ts` (S2),
`src/renderer/services/addressing.ts` (S5), `src/renderer/components/RoutingModal.tsx` (S6),
`ScenePanel`/`InspectorPanel` (browser + inspectors).
