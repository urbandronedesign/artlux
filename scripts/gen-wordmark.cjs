// Authors the ArtLux brand marks by cutting REAL glyph outlines out of the app's own typeface
// (IBM Plex Sans 700, already bundled via @fontsource) and freezing them as vector paths.
//
// Why generate instead of hand-drawing: the app shipped TWO independent marks that had already
// drifted apart — build/icon.svg was a hand-written teal "A" while MenuBar/About each hand-rolled
// their own CSS gradient tile in a completely different blue. A logo that is redrawn per use site
// is a logo that is wrong somewhere. So there is now ONE source (this script + the font) and every
// consumer reads its output.
//
// Why NOT ship `<text>` in the SVG: an SVG `<text>` element renders in whatever font the host
// happens to resolve — the installer's icon rasteriser, a browser on the operator's tablet, and a
// README on GitHub would each pick a different one. Outlined paths render identically everywhere
// and carry no font dependency at build or run time.
//
// Run: `npm run gen:brand` (this, then gen-icon.cjs). Outputs are COMMITTED, so packaging needs
// no font tooling — same contract as gen-icon.cjs.
//
//   build/wordmark.svg        the ARTLux wordmark, fill=currentColor (docs / README / external use)
//   build/icon.svg            the square app-icon tile, consumed by gen-icon.cjs → .png/.ico/favicon
//   shared/brandMarks.ts      the same geometry as data, for main + renderer + plugins to inline
//
const fs = require('node:fs');
const path = require('node:path');
const opentype = require('opentype.js');
const { Resvg } = require('@resvg/resvg-js');

const ROOT = path.join(__dirname, '..');
const FONT = path.join(
  ROOT, 'node_modules', '@fontsource', 'ibm-plex-sans', 'files', 'ibm-plex-sans-latin-700-normal.woff',
);

// ── Design parameters ────────────────────────────────────────────────────────────────────────────
const TEXT = 'ARTLux';
// Optical tightening, in font units (unitsPerEm = 1000). Text-sized Plex is spaced for reading at
// 13px; at logo size that spacing reads loose, so pull it in ~1%. Small on purpose — the wordmark is
// the typeface, not a redesign of it.
const TRACKING = -10;

// Icon tile: a black ground with a white "A". Deliberately NOT the accent teal the app uses
// everywhere else — the icon is the one mark that never sits on ArtLux chrome, so it answers to the
// OS shell (taskbar, Explorer, installer) rather than to the palette. Flat, not a ramp: at 16px a
// gradient is three indistinguishable greys, and the tile is carrying nothing but contrast for the
// glyph. White-on-black is the highest contrast that square can produce.
const TILE = 1024;
const TILE_RADIUS = 224;
const TILE_BG = '#000000';
const GLYPH_INK = '#ffffff';
// Cap height of the "A" inside the tile. 560/1024 ≈ 55% — matches the outgoing icon's optical
// weight. Bigger looks cramped against the corner radius; smaller disappears at 16px.
const ICON_CAP = 560;

const font = opentype.parse(fs.readFileSync(FONT));
const upm = font.unitsPerEm;

/**
 * Lay out `text` as a single outlined path at font-size `size`.
 *
 * opentype's own `font.getPath(text)` would do this in one call, but it bakes in its own advance
 * loop and gives no seam to apply tracking — so the advance is walked here. Kerning is applied
 * explicitly for the same reason (getPath does it for free; this loop has to ask), and it matters:
 * "ARTLux" contains A→R and T→L, both kerned pairs in Plex. Dropping kerning would leave a visible
 * gap under the T that no amount of tracking fixes.
 */
function layout(text, size) {
  const p = new opentype.Path();
  const glyphs = [...text].map((ch) => font.charToGlyph(ch));
  let x = 0;
  glyphs.forEach((glyph, i) => {
    if (i > 0) x += (font.getKerningValue(glyphs[i - 1], glyph) / upm) * size;
    p.extend(glyph.getPath(x, 0, size));
    x += (glyph.advanceWidth / upm) * size + (TRACKING / upm) * size;
  });
  return p;
}

/** Translate a path so its ink bounding box starts at (0,0), and report the resulting box. */
function normalise(p) {
  const bb = p.getBoundingBox();
  const dx = -bb.x1;
  const dy = -bb.y1;
  for (const c of p.commands) {
    if (c.x !== undefined) { c.x += dx; c.y += dy; }
    if (c.x1 !== undefined) { c.x1 += dx; c.y1 += dy; }
    if (c.x2 !== undefined) { c.x2 += dx; c.y2 += dy; }
  }
  return { width: bb.x2 - bb.x1, height: bb.y2 - bb.y1 };
}

// ── The wordmark ─────────────────────────────────────────────────────────────────────────────────
// Emitted at a 1000-unit em so the numbers in the path data stay human-scale, then normalised to a
// tight ink box. Tight (rather than cap-height or em) box is what a consumer wants: `height: 18px`
// then means 18px of actual ink, and the surrounding layout owns the padding.
const wordPath = layout(TEXT, 1000);
const word = normalise(wordPath);
const wordD = wordPath.toPathData(2);

// ── The icon mark ────────────────────────────────────────────────────────────────────────────────
// The SAME "A" — laid out by the same function from the same font — so the tile and the wordmark can
// never disagree about what the letter looks like.
const aPath = layout('A', (ICON_CAP / font.tables.os2.sCapHeight) * upm);
const a = normalise(aPath);
// Centre the ink block, not the advance width: "A" has side bearings that would push it visibly
// left of centre in a square tile if the advance were used.
const aDx = Math.round((TILE - a.width) / 2);
const aDy = Math.round((TILE - a.height) / 2);
for (const c of aPath.commands) {
  if (c.x !== undefined) { c.x += aDx; c.y += aDy; }
  if (c.x1 !== undefined) { c.x1 += aDx; c.y1 += aDy; }
  if (c.x2 !== undefined) { c.x2 += aDx; c.y2 += aDy; }
}
const aD = aPath.toPathData(2);
// Ink-box geometry of the centred "A", re-exported so an in-app tile of ANY size can place the
// glyph identically without re-deriving the centring maths.
const aBox = { x: aDx, y: aDy, width: Math.round(a.width), height: Math.round(a.height) };

// ── Emit ─────────────────────────────────────────────────────────────────────────────────────────
const GEN = '<!-- GENERATED by scripts/gen-wordmark.cjs — do not edit; edit the script. -->';

fs.writeFileSync(path.join(ROOT, 'build', 'wordmark.svg'), `${GEN}
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${word.width.toFixed(2)} ${word.height.toFixed(2)}"
     fill="currentColor" role="img" aria-label="ARTLux">
  <path d="${wordD}"/>
</svg>
`);

fs.writeFileSync(path.join(ROOT, 'build', 'icon.svg'), `${GEN}
<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">
  <rect x="0" y="0" width="${TILE}" height="${TILE}" rx="${TILE_RADIUS}" ry="${TILE_RADIUS}" fill="${TILE_BG}"/>
  <path fill="${GLYPH_INK}" d="${aD}"/>
</svg>
`);

// A 180px raster of the tile, base64, for the show-control tablet PWA. That client is served as ONE
// self-contained document with zero external requests (so it works on a venue tablet with no route
// back to the app for assets), and iOS `apple-touch-icon` refuses SVG — so the home-screen tile has
// to travel inline as a PNG or not exist. It didn't exist: adding the remote to a tablet's home
// screen produced a blank tile. 180px is the largest size iOS asks for.
const touchPng = new Resvg(fs.readFileSync(path.join(ROOT, 'build', 'icon.svg'), 'utf-8'), {
  fitTo: { mode: 'width', value: 180 },
}).render().asPng();
const touchDataUri = `data:image/png;base64,${touchPng.toString('base64')}`;

// The code-level source. `build/*.svg` are files (packaging, docs, external hand-off); this module is
// what the app itself imports, because an inline <svg> is the only form where `fill="currentColor"`
// actually inherits — an <img src="…svg"> is an opaque document and cannot be recoloured by CSS.
// Lives in shared/ for the one reason shared/ exists: main, renderer and plugins can all reach it
// (the show-control tablet server inlines these strings into the HTML it serves).
fs.writeFileSync(path.join(ROOT, 'shared', 'brandMarks.ts'), `// GENERATED by scripts/gen-wordmark.cjs — do not edit; edit the script and re-run \`npm run gen:brand\`.
//
// The ArtLux marks as raw geometry: outlines cut from IBM Plex Sans 700, the app's own UI typeface.
// Both marks share their letterforms, so the tile's "A" and the wordmark's "A" are the same shape.
// Consumers inline these into an <svg> and colour it with \`fill: currentColor\` (or a tile colour for
// the icon). See src/renderer/components/brand/AppMark.tsx for the React wrapper.

/** The full "ARTLux" wordmark. viewBox is a TIGHT ink box — the caller owns any padding. */
export const WORDMARK = {
  width: ${word.width.toFixed(2)},
  height: ${word.height.toFixed(2)},
  path: '${wordD}',
} as const;

/** The square icon mark: the same "A", centred in a ${TILE}×${TILE} tile. */
export const ICON_MARK = {
  tile: ${TILE},
  radius: ${TILE_RADIUS},
  /** Ground of the tile. Flat — a ramp is three identical greys once the icon reaches 16px. */
  bg: '${TILE_BG}',
  /** Ink colour of the glyph sitting on that tile. */
  ink: '${GLYPH_INK}',
  /** Ink box of the centred glyph, for callers that want to re-place it at another size. */
  box: ${JSON.stringify(aBox)},
  path: '${aD}',
  /**
   * The tile rasterised to a 180px PNG data URI. ONLY for consumers that cannot use the vector:
   * the show-control tablet client is a single self-contained HTML document and iOS
   * \`apple-touch-icon\` rejects SVG. Prefer \`path\` + \`gradient\` everywhere else — this string is
   * ~${Math.round(touchDataUri.length / 1024)}kB and inlining it needlessly bloats whatever embeds it.
   */
  png180: '${touchDataUri}',
} as const;
`);

console.log(`[gen-wordmark] wordmark ${word.width.toFixed(1)}×${word.height.toFixed(1)} · icon A cap ${ICON_CAP}/${TILE} · touch png ${(touchDataUri.length / 1024).toFixed(1)}kB`);
console.log('[gen-wordmark] wrote build/wordmark.svg, build/icon.svg, shared/brandMarks.ts');
