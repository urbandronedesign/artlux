// Generates the printable calibration checkerboard SVG used by the projector-calibration wizard.
// Specs match the wizard's default board config (src/renderer/calib/calibController.ts defaultBoardConfig):
//   10 × 7 SQUARES  →  9 × 6 INNER corners  ·  25 mm squares.
// SVG units are millimetres, so printing at 100% / "Actual size" yields true 25 mm squares. A print-
// scale reference ruler is included so any scaling can be measured + entered into the wizard.
//
//   node scripts/gen-checkerboard.cjs   →   docs/checkerboard-9x6-25mm.svg
const fs = require('node:fs');
const path = require('node:path');

const COLS = 10, ROWS = 7, SQ = 25;     // squares; inner corners = (COLS-1)×(ROWS-1) = 9×6
const M = 12;                            // white quiet border (mm) — boards must not touch the edge
const patW = COLS * SQ, patH = ROWS * SQ;
const footerH = 30;
const W = patW + 2 * M, H = patH + 2 * M + footerH;

const rects = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    if ((c + r) % 2 === 0) rects.push(`<rect x="${M + c * SQ}" y="${M + r * SQ}" width="${SQ}" height="${SQ}" fill="#000"/>`);
  }
}

// 100 mm reference ruler in the footer (measure it after printing to verify 100% scale).
const rulerY = M + patH + 18;
const rulerX = M;
const ticks = [];
for (let i = 0; i <= 10; i++) {
  const x = rulerX + i * 10;
  ticks.push(`<line x1="${x}" y1="${rulerY}" x2="${x}" y2="${rulerY + (i % 5 === 0 ? 4 : 2.5)}" stroke="#000" stroke-width="0.3"/>`);
}

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>
  ${rects.join('\n  ')}
  <text x="${M}" y="${M + patH + 9}" font-family="Helvetica, Arial, sans-serif" font-size="4.2" fill="#000">ArtLux calibration checkerboard — 9 × 6 inner corners · 25 mm squares</text>
  <text x="${M}" y="${M + patH + 14.5}" font-family="Helvetica, Arial, sans-serif" font-size="3.2" fill="#444">Print at 100% / Actual size (A3, or A4 with Fit-to-page). Then MEASURE a square and enter that size in the wizard.</text>
  <line x1="${rulerX}" y1="${rulerY}" x2="${rulerX + 100}" y2="${rulerY}" stroke="#000" stroke-width="0.3"/>
  ${ticks.join('\n  ')}
  <text x="${rulerX + 100 + 3}" y="${rulerY + 3}" font-family="Helvetica, Arial, sans-serif" font-size="3.2" fill="#000">100 mm reference</text>
</svg>
`;

const out = path.join(__dirname, '..', 'docs', 'checkerboard-9x6-25mm.svg');
fs.writeFileSync(out, svg);
console.log(`[gen-checkerboard] wrote ${path.relative(process.cwd(), out)} — ${W}×${H} mm, ${COLS}×${ROWS} squares (9×6 inner), ${SQ} mm`);

// Also emit a PNG raster (~8 px/mm ≈ 200 DPI) beside the SVG for contexts that can't print SVG.
// Uses the resvg native dev-dependency; degrade gracefully if it isn't installed.
try {
  const { Resvg } = require('@resvg/resvg-js');
  const pngOut = out.replace(/\.svg$/, '.png');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: Math.round(W * 8) } }).render().asPng();
  fs.writeFileSync(pngOut, png);
  console.log(`[gen-checkerboard] wrote ${path.relative(process.cwd(), pngOut)} (PNG raster)`);
} catch (e) {
  console.warn('[gen-checkerboard] PNG raster skipped (@resvg/resvg-js unavailable):', e.message);
}
