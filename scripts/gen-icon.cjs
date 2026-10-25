// Rasterizes build/icon.svg into the app icons (PNG + multi-size ICO) and a
// renderer favicon. Run once via `npm run gen:icon`; the outputs are committed,
// so packaging needs no tooling at build time.
const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIcoMod = require('png-to-ico');
const pngToIco = typeof pngToIcoMod === 'function' ? pngToIcoMod : pngToIcoMod.default;

(async () => {
  const buildDir = path.join(__dirname, '..', 'build');
  const svg = fs.readFileSync(path.join(buildDir, 'icon.svg'), 'utf-8');

  const render = (size) =>
    new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

  // Master PNG (electron-builder + BrowserWindow icon).
  fs.writeFileSync(path.join(buildDir, 'icon.png'), render(1024));

  // Multi-size Windows ICO.
  const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(render));
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);

  // Renderer favicon (Vite public dir → copied to the build root as /icon.png).
  const publicDir = path.join(__dirname, '..', 'src', 'renderer', 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'icon.png'), render(256));

  // ── ArtLux Calibrator's mark (suite plan Phase 3, decision 12: derived from this one) ─────────────
  // The SAME tile and A, inverted — white tile, black A — so the two apps read as one family and differ
  // at 16 px in a taskbar, where a corner badge alone would be three pixels. A thin outline keeps the
  // white tile's edge on a light taskbar, and a crosshair badge (the calibration mark) is added for the
  // sizes that can carry it. ArtLux Show keeps the original mark untouched: an installed "ArtLux"
  // updates into Show in place, and Windows caches shell icons per exe path anyway (INSTALL.md).
  const tile = svg.match(/<rect [^>]*\/>/)[0];
  const glyph = svg.match(/<path [^>]*\/>/)[0];
  const calibSvg = (badge) => [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
    tile.replace('fill="#000000"', 'fill="#ffffff" stroke="#000000" stroke-width="40"'),
    glyph.replace('fill="#ffffff"', 'fill="#000000"'),
    badge ? '<circle cx="808" cy="808" r="150" fill="#000000"/><circle cx="808" cy="808" r="78" fill="none" stroke="#ffffff" stroke-width="30"/><path d="M808 690v72M808 854v72M690 808h72M854 808h72" stroke="#ffffff" stroke-width="30"/>' : '',
    '</svg>',
  ].join('\n');
  const renderC = (size) => new Resvg(calibSvg(size >= 48), { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(buildDir, 'icon-calibrator.svg'), calibSvg(true) + '\n');
  fs.writeFileSync(path.join(buildDir, 'icon-calibrator.png'), renderC(1024));
  fs.writeFileSync(path.join(buildDir, 'icon-calibrator.ico'), await pngToIco([16, 24, 32, 48, 64, 128, 256].map(renderC)));
  fs.writeFileSync(path.join(publicDir, 'icon-calibrator.png'), renderC(256));

  console.log('[gen-icon] wrote build/icon.png, build/icon.ico, src/renderer/public/icon.png');
  console.log('[gen-icon] wrote build/icon-calibrator.{svg,png,ico}, src/renderer/public/icon-calibrator.png');
})().catch((e) => { console.error(e); process.exit(1); });
