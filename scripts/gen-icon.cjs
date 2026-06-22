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

  console.log('[gen-icon] wrote build/icon.png, build/icon.ico, src/renderer/public/icon.png');
})().catch((e) => { console.error(e); process.exit(1); });
