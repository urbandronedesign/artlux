// THE UV CHECKER — a procedural test source for aligning projectors (suite plan Phase 3, decision 13).
//
// A shader, like the templates' calibration test card, so it needs no media file and renders at any size
// on any output. What makes it a CHECKER rather than a pattern is that every point says where it is:
//   - square cells, sized for the chosen resolution (Full HD or 4K) — the column/row count follows the
//     surface's aspect live (iAspect), so a 10:3 panorama gets more columns, not stretched squares;
//   - every cell is LABELLED: its column letter and row number (A1 top-left, like a spreadsheet) and
//     the U/V of its centre, so a mis-mapping is read off the wall as "C4 landed where F2 should be";
//   - the four corners are colour-coded (top-left red, top-right green, bottom-right blue, bottom-left
//     yellow — the templates' test-card convention) and an arrow points up: orientation and mirroring
//     read at a glance;
//   - it ADAPTS TO THE PROJECT: the surface's name is printed, and each Blender screen bound to this
//     surface gets its outline, its name and its U/V range drawn where it lands — so a mapping error
//     points at the screen it belongs to. Those come from the project, so the source is GENERATED; the
//     host regenerates it when they change (src/renderer/services/uvCheckerSync.ts).
//
// Text is a 3×5 bitmap font baked into the shader as an int array (GLSL ES 3.00): no texture, no
// asset, the same picture in the editor, on every projector and in an exported image.

export type UvCheckerSize = 'fhd' | '4k';
/** The shaderId a UV-checker surface carries — also a starter, so it renders on a build with no sync. */
export const UV_CHECKER_ID = 'uv-checker';
/** The Detail each size asks for. A projector draws at its own raster anyway (docs/SHADERS.md). */
export const UV_CHECKER_RES: Record<UvCheckerSize, number> = { fhd: 1080, '4k': 2160 };

export interface UvCheckerScreen {
  /** The screen's name in the venue file (`screen_left`). */
  name: string;
  /** Its extent on THIS surface, in the surface's own UV (v = 0 at the bottom). */
  u0: number; v0: number; u1: number; v1: number;
}

export interface UvCheckerSpec {
  size: UvCheckerSize;
  /** Printed at the top: the surface's name. */
  title?: string;
  screens?: UvCheckerScreen[];
}

// ── The font: 3×5, rows top to bottom, 3 bits each (left = high bit) ───────────────────────────────
const GLYPHS: Record<string, string> = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111', 4: '101101111001001',
  5: '111100111001111', 6: '111100111101111', 7: '111001010010010', 8: '111101111101111', 9: '111101111001111',
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101110100110101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', _: '000000000000111', '.': '000000000000010', '-': '000000111000000', ':': '000010000010000',
  '/': '001001010100100', ' ': '000000000000000',
};
const ORDER = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_.-:/ ';
const FONT = [...ORDER].map((c) => parseInt(GLYPHS[c], 2));
const SPACE = ORDER.indexOf(' ');
const code = (c: string): number => { const i = ORDER.indexOf(c.toUpperCase()); return i < 0 ? SPACE : i; };
const codes = (s: string, max = 48): number[] => [...s.slice(0, max)].map(code);
const f2 = (x: number): string => Math.min(1, Math.max(0, x)).toFixed(2);

/** One baked string: a const array and a function that draws it centred on `c`, glyph height `h`. */
function strFn(name: string, text: string): string {
  const cs = codes(text);
  if (!cs.length) return `float ${name}(vec2 p, vec2 c, float h) { return 0.0; }`;
  return [
    `const int ${name}_S[${cs.length}] = int[${cs.length}](${cs.join(', ')});`,
    `float ${name}(vec2 p, vec2 c, float h) {`,
    `  float w = ${cs.length}.0 * h * 0.8 - h * 0.2;`,
    `  vec2 o = c - vec2(w * 0.5, h * 0.5);`,
    `  float a = 0.0;`,
    `  for (int i = 0; i < ${cs.length}; i++) a = max(a, ch(${name}_S[i], p, o + vec2(float(i) * h * 0.8, 0.0), h));`,
    `  return a;`,
    `}`,
  ].join('\n');
}

/** The checker's GLSL for a surface — header, font, and the project's own labels baked in. */
export function buildUvCheckerSource(spec: UvCheckerSpec): string {
  const rows = spec.size === '4k' ? 16 : 8;                     // cell = 1/rows of the height
  const line = spec.size === '4k' ? 0.0022 : 0.0036;            // grid line, in picture heights
  const title = spec.title ? `${spec.title} - UV ${spec.size === '4k' ? '4K' : 'FHD'}` : `UV CHECKER ${spec.size === '4k' ? '4K' : 'FHD'}`;
  const screens = (spec.screens ?? []).slice(0, 8);

  const screenFns = screens.map((s, k) => [
    strFn(`scrName${k}`, s.name),
    strFn(`scrRange${k}`, `U ${f2(s.u0)}-${f2(s.u1)}  V ${f2(s.v0)}-${f2(s.v1)}`),
  ].join('\n')).join('\n');
  const screenDraw = screens.map((s, k) => `
  {
    // ${s.name}: where this Blender screen lands on the surface
    vec2 lo = vec2(${s.u0.toFixed(5)} * iAspect, ${s.v0.toFixed(5)});
    vec2 hi = vec2(${s.u1.toFixed(5)} * iAspect, ${s.v1.toFixed(5)});
    vec2 d = min(p - lo, hi - p);
    float inside = step(0.0, d.x) * step(0.0, d.y);
    col = mix(col, vec3(1.0), inside * step(min(d.x, d.y), line * 3.0));
    // The label sits in the screen's lower third: the centre is the test card's ring and arrow.
    vec2 c = vec2((lo.x + hi.x) * 0.5, lo.y + (hi.y - lo.y) * 0.3);
    float h = clamp((hi.y - lo.y) * 0.07, cell * 0.22, cell * 0.6);
    float t = scrName${k}(p, c + vec2(0.0, h * 0.8), h) + scrRange${k}(p, c - vec2(0.0, h * 0.8), h * 0.5);
    col = mix(col, vec3(0.0), inside * box(p, c - vec2(h * 6.0, h * 1.6), c + vec2(h * 6.0, h * 1.6)) * 0.55);
    col = mix(col, vec3(1.0), inside * min(t, 1.0));
  }`).join('');

  return `/*{
  "TITLE": "UV checker",
  "CATEGORIES": ["utility"],
  "DESCRIPTION": "Generated by ArtLux for projector alignment - regenerated when the project changes; save it to the library to keep an edited copy."
}*/
// THE UV CHECKER — GENERATED (plugins/shader/src/uvChecker.ts). Cells A1.. from the top-left, each with
// its U/V; corners red (top-left), green (top-right), blue (bottom-right), yellow (bottom-left).
const int FONT[${FONT.length}] = int[${FONT.length}](${FONT.join(', ')});
float glyphAt(int g, vec2 q) {
  if (q.x < 0.0 || q.y < 0.0 || q.x >= 3.0 || q.y >= 5.0) return 0.0;
  int col = int(q.x);
  int row = 4 - int(q.y);
  return float((FONT[g] >> (14 - (row * 3 + col))) & 1);
}
// One glyph with its bottom-left at o, h tall (a glyph is 3×5 units; the advance is 4).
float ch(int g, vec2 p, vec2 o, float h) { return glyphAt(g, (p - o) / (h / 5.0)); }
float box(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }
${strFn('titleStr', title)}
${screenFns}

vec4 shaderColor(vec2 uv) {
  vec2 p = vec2(uv.x * iAspect, uv.y);                 // picture-height units: x 0..iAspect, y 0..1
  float line = ${line};
  // Square cells: a fixed number of rows for the size, and as many columns as the aspect holds.
  float rows = ${rows}.0;
  float cols = max(1.0, floor(iAspect * rows + 0.5));
  vec2 cellSz = vec2(iAspect / cols, 1.0 / rows);
  float cell = cellSz.y;
  vec2 ci = floor(vec2(p.x / cellSz.x, (1.0 - p.y) / cellSz.y));   // column from the left, row from the TOP
  ci = clamp(ci, vec2(0.0), vec2(cols - 1.0, rows - 1.0));
  vec2 cuv = vec2((ci.x + 0.5) / cols, 1.0 - (ci.y + 0.5) / rows);  // the cell centre's U/V

  // Fill: a two-tone checker tinted by U (red) and V (green), so position reads even without the labels.
  float chk = mod(ci.x + ci.y, 2.0);
  vec3 col = mix(vec3(0.13), vec3(0.22), chk);
  col = mix(col, vec3(0.25 + 0.6 * cuv.x, 0.25 + 0.6 * cuv.y, 0.35), 0.28);

  // Grid lines.
  vec2 g = abs(fract(vec2(p.x / cellSz.x, p.y / cellSz.y) + 0.5) - 0.5) * cellSz;
  col = mix(col, vec3(0.62), step(min(g.x, g.y), line * 0.5));

  // The cell's label, top-left inside it: column letter(s) + row number, and U/V beneath.
  vec2 corner = vec2(ci.x * cellSz.x, 1.0 - ci.y * cellSz.y);          // the cell's TOP-left, in p units
  float h = cell * 0.16;
  vec2 o = corner + vec2(cell * 0.08, -cell * 0.08 - h);
  float t = 0.0;
  int c = int(ci.x);
  if (c < 26) { t = max(t, ch(10 + c, p, o, h)); o.x += h * 0.8; }
  else { t = max(t, ch(10 + c / 26 - 1, p, o, h)); o.x += h * 0.8; t = max(t, ch(10 + c - (c / 26) * 26, p, o, h)); o.x += h * 0.8; }
  int r = int(ci.y) + 1;
  if (r >= 10) { t = max(t, ch(r / 10, p, o, h)); o.x += h * 0.8; }
  t = max(t, ch(r - (r / 10) * 10, p, o, h));
  float hs = h * 0.62;
  vec2 o2 = corner + vec2(cell * 0.08, -cell * 0.08 - h - hs * 1.6);
  int u100 = clamp(int(cuv.x * 100.0 + 0.5), 0, 99);
  int v100 = clamp(int(cuv.y * 100.0 + 0.5), 0, 99);
  int uvs[9] = int[9](30, 37, u100 / 10, u100 - (u100 / 10) * 10, ${SPACE}, 31, 37, v100 / 10, v100 - (v100 / 10) * 10);
  for (int i = 0; i < 9; i++) t = max(t, ch(uvs[i], p, o2 + vec2(float(i) * hs * 0.8, 0.0), hs));
  col = mix(col, vec3(0.95), t);

  // Centre: a ring and a cross, and an arrow pointing UP.
  vec2 cc = p - vec2(iAspect * 0.5, 0.5);
  col = mix(col, vec3(1.0), step(abs(length(cc) - 0.17), line * 0.8));
  col = mix(col, vec3(1.0), step(min(abs(cc.x), abs(cc.y)), line * 0.6) * step(length(cc), 0.22));
  vec2 a = cc - vec2(0.0, 0.30);
  col = mix(col, vec3(1.0), step(0.0, a.y) * step(a.y, 0.08) * step(abs(a.x), (0.08 - a.y) * 0.75));

  // The surface's name, top centre, on a dark band so it reads over any cell.
  float th = cell * 0.32;
  vec2 tc = vec2(iAspect * 0.5, 1.0 - cell * 1.5);
  col = mix(col, vec3(0.0), box(p, tc - vec2(iAspect * 0.45, th), tc + vec2(iAspect * 0.45, th)) * 0.5);
  col = mix(col, vec3(1.0), titleStr(p, tc, th));
${screenDraw}

  // Corners: TOP-LEFT red, TOP-RIGHT green, BOTTOM-RIGHT blue, BOTTOM-LEFT yellow.
  float s = cell * 0.9;
  col = mix(col, vec3(0.95, 0.15, 0.15), box(p, vec2(0.0, 1.0 - s), vec2(s, 1.0)));
  col = mix(col, vec3(0.15, 0.85, 0.30), box(p, vec2(iAspect - s, 1.0 - s), vec2(iAspect, 1.0)));
  col = mix(col, vec3(0.20, 0.45, 1.00), box(p, vec2(iAspect - s, 0.0), vec2(iAspect, s)));
  col = mix(col, vec3(1.00, 0.85, 0.10), box(p, vec2(0.0, 0.0), vec2(s, s)));

  // The border, last: the line that lands on the screen's edges.
  float edge = min(min(p.x, iAspect - p.x), min(p.y, 1.0 - p.y));
  col = mix(col, vec3(1.0), step(edge, line * 1.5));
  return vec4(col, 1.0);
}
`;
}
