// Effect catalog (ids must match the switch in WebGPUMapper's WGSL effectColor).
// Stateless, palette-driven effects for now; stateful effects (e.g. fire2012)
// are a planned follow-up.
export const EFFECT_NAMES: string[] = [
  'Solid',        // 0 — palette color at `intensity`
  'Rainbow',      // 1 — palette swept along the strip, scrolling by speed
  'Palette Flow', // 2 — palette scaled by intensity, scrolling by speed
  'Wave',         // 3 — palette with a travelling brightness sine
  'Fire',         // 4 — stateful fire2012 (heat sim -> palette)
];
