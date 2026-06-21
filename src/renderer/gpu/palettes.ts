// WLED-style gradient palettes, expanded to a 256xN RGBA LUT texture that the
// compute shader samples by (colorIndex, paletteId). Gradient anchor format
// matches FastLED's DEFINE_GRADIENT_PALETTE: [pos(0-255), r, g, b, ...].

export interface GradientPalette {
  name: string;
  anchors: number[]; // [pos,r,g,b, pos,r,g,b, ...]
}

// "Rainbow" is generated procedurally (full-hue sweep); the rest are gradients.
const GRADIENTS: GradientPalette[] = [
  { name: 'Heat',   anchors: [0,0,0,0, 64,128,0,0, 160,255,80,0, 224,255,220,40, 255,255,255,255] },
  { name: 'Ocean',  anchors: [0,0,0,40, 64,0,60,140, 128,0,130,200, 192,40,200,210, 255,200,255,255] },
  { name: 'Forest', anchors: [0,0,40,0, 64,0,100,20, 128,40,160,40, 192,140,200,40, 255,220,255,120] },
  { name: 'Lava',   anchors: [0,0,0,0, 80,140,0,0, 160,255,70,0, 224,255,200,0, 255,255,255,200] },
  { name: 'Sunset', anchors: [0,120,0,0, 51,255,104,0, 135,100,0,103, 198,16,0,130, 255,0,0,160] },
  { name: 'Cyber',  anchors: [0,0,255,200, 80,0,120,255, 160,180,0,255, 220,255,0,160, 255,255,80,0] },
];

const SIZE = 256;

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

// Expand one gradient palette to 256 RGBA texels.
function expandGradient(anchors: number[], out: Uint8Array, rowOffset: number): void {
  const stops: { pos: number; r: number; g: number; b: number }[] = [];
  for (let i = 0; i < anchors.length; i += 4) {
    stops.push({ pos: anchors[i], r: anchors[i + 1], g: anchors[i + 2], b: anchors[i + 3] });
  }
  for (let x = 0; x < SIZE; x++) {
    // Find bracketing stops for this position.
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let s = 0; s < stops.length - 1; s++) {
      if (x >= stops[s].pos && x <= stops[s + 1].pos) { a = stops[s]; b = stops[s + 1]; break; }
    }
    const span = b.pos - a.pos || 1;
    const f = Math.min(1, Math.max(0, (x - a.pos) / span));
    const o = rowOffset + x * 4;
    out[o] = Math.round(a.r + (b.r - a.r) * f);
    out[o + 1] = Math.round(a.g + (b.g - a.g) * f);
    out[o + 2] = Math.round(a.b + (b.b - a.b) * f);
    out[o + 3] = 255;
  }
}

// Names in row order (row 0 = Rainbow, then the gradients).
export const PALETTE_NAMES: string[] = ['Rainbow', ...GRADIENTS.map(g => g.name)];

export interface PaletteLut {
  data: Uint8Array;  // width*height*4, row-major (row = paletteId)
  width: number;     // 256
  count: number;     // number of palettes (rows)
}

export function buildPaletteLut(): PaletteLut {
  const count = PALETTE_NAMES.length;
  const data = new Uint8Array(SIZE * count * 4);

  // Row 0: rainbow (HSV sweep).
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = hsvToRgb(x / SIZE, 1, 1);
    const o = x * 4;
    data[o] = Math.round(r); data[o + 1] = Math.round(g); data[o + 2] = Math.round(b); data[o + 3] = 255;
  }
  // Remaining rows: gradients.
  for (let i = 0; i < GRADIENTS.length; i++) {
    expandGradient(GRADIENTS[i].anchors, data, (i + 1) * SIZE * 4);
  }

  return { data, width: SIZE, count };
}
