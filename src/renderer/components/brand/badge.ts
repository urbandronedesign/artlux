import { WORDMARK, ICON_MARK } from '../../../../shared/brandMarks';

/**
 * E6f — THE WINDOWED OUTPUT'S BADGE as ONE BITMAP: the app mark, the wordmark and the output's name, top-left of a
 * windowed output (never a real projector — see ProjectorApp). It used to be DOM in the projector window; it is a
 * bitmap so that the app's window and the native engine's window of the same output show the SAME pixels: the app
 * draws this canvas, and nativeLink ships the very same bitmap to the engine, which composites it at BADGE's place
 * and opacity (outputs.rs). Text drawn twice — once by the DOM, once by a canvas — never agrees to the pixel.
 *
 * Geometry is the old DOM's: a row 20 px tall at (14, 12) — the 20 px tile, 9 px gap, the wordmark 16 px tall
 * (centred), 9 px gap + 2 px padding, then the name in 500 12px system-ui, 0.1em tracking, centred. The marks come
 * from shared/brandMarks (the one source of the logo — verify:invariants).
 */
export const BADGE = { left: 14, top: 12, opacity: 0.85 } as const;

const ROW = 20, ICON = 20, WORD_H = 16, GAP = 9;
const WORD_W = (WORD_H * WORDMARK.width) / WORDMARK.height;

function marksSvg(dpr: number): string {
  const s = ICON / ICON_MARK.tile, ws = WORD_H / WORDMARK.height, wx = ICON + GAP, wy = (ROW - WORD_H) / 2;
  const w = Math.ceil((wx + WORD_W) * dpr), h = Math.ceil(ROW * dpr);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w / dpr} ${h / dpr}">`
    + `<g transform="scale(${s})"><rect width="${ICON_MARK.tile}" height="${ICON_MARK.tile}" rx="${ICON_MARK.radius}" ry="${ICON_MARK.radius}" fill="${ICON_MARK.bg}"/>`
    + `<path d="${ICON_MARK.path}" fill="${ICON_MARK.ink}"/></g>`
    + `<g transform="translate(${wx} ${wy}) scale(${ws})"><path d="${WORDMARK.path}" fill="#eef1f5"/></g></svg>`;
}

const cache = new Map<string, Promise<ImageBitmap | null>>();
/** The badge for `name` at `dpr` device pixels per CSS pixel (cached: one per name and scale). */
export function badgeBitmap(name: string, dpr: number): Promise<ImageBitmap | null> {
  const key = `${dpr}|${name}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      if (typeof OffscreenCanvas === 'undefined') return null;
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(marksSvg(dpr))}`;
      try { await img.decode(); } catch { return null; }
      const probe = new OffscreenCanvas(1, 1).getContext('2d')!;
      const font = '500 12px system-ui';
      probe.font = font; probe.letterSpacing = '1.2px';
      const tx = ICON + GAP + WORD_W + GAP + 2;
      const cw = Math.ceil((tx + (name ? probe.measureText(name).width : 0) + 2) * dpr), ch = Math.ceil(ROW * dpr);
      const c = new OffscreenCanvas(cw, ch), g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      if (name) {
        g.scale(dpr, dpr);
        g.font = font; g.letterSpacing = '1.2px'; g.fillStyle = '#aeb4bd'; g.textBaseline = 'middle';
        g.fillText(name, tx, ROW / 2);
      }
      // CANONICAL BYTES: the engine receives this bitmap as STRAIGHT alpha (getImageData) and premultiplies it again
      // (Skia's rounding, compose.rs); a canvas keeps its own premultiplied pixels, which that round trip does not
      // always give back (measured: 621 edge pixels off by 1). Taking the round trip HERE, once, makes the bitmap the
      // app draws exactly the one the engine rebuilds.
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.putImageData(g.getImageData(0, 0, cw, ch), 0, 0);
      return c.transferToImageBitmap();
    })();
    cache.set(key, p);
  }
  return p;
}
