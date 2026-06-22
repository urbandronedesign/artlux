# ArtLux — Surfaces engine (design & roadmap)

The app's core/"final" logic, MadMapper-style:
**create a Surface → feed it content (video / live / image / Spout / shader effect) → create & save
a Fixture → place it & link it to a Surface → it samples only that surface**, with automatic
universe/address allocation and a multi-controller routing spreadsheet.

## Concepts
- **Surface** — a rectangle on the stage carrying one content source. On-canvas it's **cyan**.
  `Surface { id, name, x, y, width, height, rotation, zIndex, content }` (rect normalized 0..1).
- **SurfaceContent** — `{ type: NONE | VIDEO | IMAGE | CAMERA | SPOUT | DMX_IN | EFFECT, url?,
  spoutName?, effectId?, paletteId?, speed?, intensity? }`.
- **Fixture** — an LED layout (red on-canvas). Gains `surfaceId` (link), and later `controllerId`,
  `patchLocked`. When linked, its placement is interpreted in the surface's local space (S3).
- **Controller** (S5) — a physical output device `{ id, name, protocol, ip, broadcast, priority?,
  startUniverse? }`. Fixtures are assigned to one and auto-patched.

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
- **S6 — Routing spreadsheet modal (DONE).** `RoutingModal.tsx` (TopBar Network button / File →
  Routing…): a Controllers sub-panel + a fixtures patch grid (name · surface · controller · universe ·
  start · channels · LEDs · span · lock); inline edit, lock-to-edit-address, Auto-patch.

**Surfaces engine S1–S6 complete.**

## Key files
`src/renderer/types.ts` (Surface/SurfaceContent/Controller), `src/renderer/services/surfaceMedia.ts`,
`src/renderer/components/Stage.tsx` (composite + per-surface dispatch in S3), `src/renderer/gpu/
{WebGPUMapper,GPUMapper}.ts` (S3), `src/renderer/gpu/surfaceFx.ts` (S2),
`src/renderer/services/addressing.ts` (S5), `src/renderer/components/RoutingModal.tsx` (S6),
`ScenePanel`/`InspectorPanel` (browser + inspectors).
