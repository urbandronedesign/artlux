# Effects & palettes — generative content reference

ArtLux ships **built-in generative effects** driven by **gradient palettes**. They render in two
places from the same catalog:

- **Per-LED** on the GPU pixel-mapper (`PixelSource.EFFECT` on a fixture/segment) — the WGSL
  `effectColor` in [`gpu/WebGPUMapper.ts`](../src/renderer/gpu/WebGPUMapper.ts) (WebGL fallback in
  `GPUMapper.ts`).
- **On a surface** as content (`SurfaceContent.type === 'EFFECT'`) — a small 2D field rendered by
  [`gpu/surfaceFx.ts`](../src/renderer/gpu/surfaceFx.ts) that fixtures then **sample**.

Effects are **stateless** except **Fire**, which evolves a persistent heat buffer (fire2012). They need
**no media files**, which makes them ideal for portable projects — see the
[state-machine examples](../examples/state-machine/README.md), whose every look is an effect.

## Effects (`gpu/effects.ts` — `EFFECT_NAMES`)

`effectId` indexes this list. Each effect reads a **palette** (`paletteId`), a **speed** (`0..1`) and an
**intensity** (`0..1`); `t` is the normalized position along the strip/field, `time` is the animation
clock.

| id | Name | What it does | `speed` | `intensity` |
|----|------|--------------|---------|-------------|
| 0 | **Solid** | one flat palette colour: `palette(intensity)` | — | **picks the colour** along the palette gradient (0 = start … 1 = end) |
| 1 | **Rainbow** | the whole palette laid along the strip, **scrolling** | scroll rate | (unused) |
| 2 | **Palette Flow** | palette **compressed/repeated** and scrolling | scroll rate | repeat count (`0.5 + 4·intensity` cycles) |
| 3 | **Wave** | palette with a travelling **brightness sine** | wave travel rate | wave frequency (`1 + 6·intensity`) |
| 4 | **Fire** | stateful **fire2012** heat sim → palette (heat indexes the palette) | flicker evolution | more sparks + less cooling as it rises |

Notes:
- **Solid** samples the palette at `intensity`, so a "solid colour" depends on the palette: e.g.
  `Solid` + a palette that is red near one end, with `intensity` tuned to that spot. To force **black**,
  set `intensity = 0` on a palette whose start is black (Heat/Lava/Forest) **or** set the scene's global
  brightness to 0.
- **Fire** is best read with a warm palette (**Heat**, **Lava**). It maintains a per-LED `heat` buffer,
  so it looks alive without external content.
- Multi-segment fixtures give **each segment** its own `effectId/paletteId/speed/intensity` (see
  `Segment` in [`types.ts`](../src/renderer/types.ts)); a fixture with no segments acts as one implicit
  segment.

## Palettes (`gpu/palettes.ts` — `PALETTE_NAMES`)

`paletteId` indexes this list. Row 0 is a procedural full-hue **Rainbow**; the rest are WLED/FastLED-style
gradients (`DEFINE_GRADIENT_PALETTE` anchor format `[pos,r,g,b,…]`), expanded to a **256×N RGBA LUT**
the shader samples by `(colorIndex, paletteId)`.

| id | Name | Character |
|----|------|-----------|
| 0 | **Rainbow** | full HSV hue sweep |
| 1 | **Heat** | black → red → orange → white |
| 2 | **Ocean** | deep blue → teal → pale cyan |
| 3 | **Forest** | dark green → lime → pale yellow-green |
| 4 | **Lava** | black → red → orange → yellow-white |
| 5 | **Sunset** | orange → magenta → deep red |
| 6 | **Cyber** | cyan/blue → magenta → yellow |

## Using effects

- **On a fixture (per-LED):** set `source = EFFECT`, then `effectId` / `paletteId` / `speed` /
  `intensity` (Fixture inspector). Output goes straight to the LEDs — no surface needed.
- **On a surface (content):** set the surface's content to an `EFFECT` with the same fields; fixtures
  that **sample** that surface (`source = MEDIA`, the default) pick up the rendered field. This is the
  canonical pixel-mapping path and what the example projects use:

  ```jsonc
  // a surface's content in a .artlux file
  "content": { "type": "EFFECT", "effectId": 4, "paletteId": 4, "speed": 0.75, "intensity": 1, "opacity": 1 }
  ```

- During a **scene crossfade** (`fadeSec`), fadeable numerics — **speed** and **intensity** — animate;
  **effectId** and **paletteId** are discrete and **snap**. Plan transitions accordingly (fade the
  brightness/intensity, accept the palette/effect change is instant). See [SCENES.md](SCENES.md).

## Adding a new effect or palette

- **New effect:** add its name to `EFFECT_NAMES` (`gpu/effects.ts`) — its index is the `effectId` — then
  handle that id in the WGSL `effectColor` switch in `gpu/WebGPUMapper.ts` (and mirror it in the WebGL
  `GPUMapper.ts` fallback and the 2D `surfaceFx.ts` if it should render on surfaces too). Stateful
  effects need a compute pass + a persistent buffer, like Fire's `heat`.
- **New palette:** append a `{ name, anchors }` gradient to `GRADIENTS` in `gpu/palettes.ts` (anchor
  format `[pos(0-255), r, g, b, …]`); it becomes the next `paletteId` and is baked into the LUT
  automatically. Row 0 (Rainbow) is generated procedurally.

## Source map

| File | Role |
|---|---|
| [`gpu/effects.ts`](../src/renderer/gpu/effects.ts) | `EFFECT_NAMES` catalog (ids ↔ names) |
| [`gpu/palettes.ts`](../src/renderer/gpu/palettes.ts) | gradient palettes → 256×N RGBA LUT |
| [`gpu/WebGPUMapper.ts`](../src/renderer/gpu/WebGPUMapper.ts) | WGSL `effectColor` + fire2012 compute (per-LED) |
| [`gpu/GPUMapper.ts`](../src/renderer/gpu/GPUMapper.ts) | WebGL2 fallback mapper |
| [`gpu/surfaceFx.ts`](../src/renderer/gpu/surfaceFx.ts) | 2D surface-content effect renderer |
