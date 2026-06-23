# ArtLux — Ledmap (pixel remapping)

A **ledmap** remaps the order in which a fixture's pixels are addressed. It answers one
question for the renderer:

> For physical pixel **N** in the data stream, which **geometry position** does it light up?

This matches WLED's `ledmap.json` so maps exported from a WLED controller load as-is.

## Data model
- `Fixture.ledMap?: number[]` — `physical index → geometry index` (see [types.ts](../src/renderer/types.ts)).
  Optional; absent means identity (physical order == geometry order).
- Sampled in the GPU mapper: for output pixel `gi`, the geometry cell is
  `g = ledMap[gi] ?? gi` ([WebGPUMapper.ts](../src/renderer/gpu/WebGPUMapper.ts), the
  `// reverse- + ledmap-aware` block). `g` then drives matrix row/col or line position.
- Ordering of transforms: **reverse** flips the whole fixture first (`gi = reverse ? ledCount-1-i : i`),
  **then** the ledmap lookup, **then** serpentine column flip for matrices.

## Accepted file formats (import)
Parsed in `handleLedmapUpload` ([FixtureEditor.tsx](../src/renderer/components/FixtureEditor.tsx)).
Both are accepted:
1. Bare array — `[0, 1, 2, 3, ...]`
2. WLED object — `{ "map": [0, 1, 2, 3, ...] }`

The array length should equal the fixture's `ledCount`. Out-of-range / missing entries fall
back to identity (`?? gi`).

## How to produce a ledmap
The app currently **imports** ledmaps; it does not generate them. Options:

1. **From WLED** — WLED's 2D Configuration / LED Map writes `ledmap.json` to the controller.
   Download it (`http://<wled-ip>/edit`) and load it here directly.
2. **By hand** — for small/irregular fixtures, just list `physical → geometry`. An 8-px strip
   wired backwards: `{ "map": [7,6,5,4,3,2,1,0] }`.
3. **Generated** — e.g. a 16×16 serpentine panel:
   ```js
   const W=16,H=16,map=[];
   for (let y=0;y<H;y++) for (let x=0;x<W;x++){
     const col=(y%2===0)?x:(W-1-x);
     map.push(y*W+col);
   }
   // JSON.stringify({ map })
   ```

## When you don't need a ledmap
The common remappings already have dedicated controls in the Fixture editor:
- **Reverse** — flips the whole fixture's pixel order.
- **Serpentine** — zig-zag (boustrophedon) matrix wiring.

Use a ledmap only for layouts those can't express: irregular, hand-wired, or non-rectangular.

## UI — Ledmap card (Fixture editor)
Lives in the **Fixture editor** ([FixtureEditor.tsx](../src/renderer/components/FixtureEditor.tsx)),
as a **"Ledmap" card** next to Geometry/Wiring (moved here from the right-hand Inspector). It offers:
- **Load** — import a `ledmap.json` (array or `{map:[...]}`).
- **Status** — `Loaded: N pts` or `No ledmap (identity order)`, with an amber **length-mismatch
  warning** when `ledMap.length !== ledCount`.
- **Export** — download the current map, or an identity template sized to the fixture if none is set.
- **Clear** — remove the map (back to identity), shown only when one is loaded.
- **Generate serpentine** (matrix only) — bakes a serpentine map from cols/rows and **turns off the
  Serpentine toggle** so the engine doesn't apply the zig-zag twice (transform order is
  reverse → ledmap → serpentine).
