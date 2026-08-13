// Turning the alignment-aid SVG into a texture, so the GL pass can bend it through the same warp as
// the picture (see AlignAids.tsx `warp`, ProjectorGL.setOverlay).
//
// ⚠ IT SERIALISES THE LIVE DOM NODE, and that is the whole design. The alternative — a second
// implementation of the patterns drawn with Canvas2D, or a server-rendered copy of the component — is
// two sources for one picture, and the day someone adds a pattern only one of them would learn about
// it. Here the warped aid is BY CONSTRUCTION the same markup the unwarped one paints: hide the DOM
// copy, serialise that exact node, rasterise, upload.
//
// The cost is a one-off per aid change (pattern, size, soft edge — NOT dim, which is a raster scrim
// and never reaches this file), so a Dim drag costs nothing and switching pattern costs one decode.

/** Clamp on the raster's longest side. Above this a texture is bigger than some GPUs will take, and
 *  an aid is hairlines and glyphs — there is nothing in it that 4K resolves and 8K would not. */
const MAX_PX = 4096;

/**
 * Rasterise `svg` at device resolution. Resolves to an image ready for texImage2D, or null if the
 * browser declined to decode it — in which case the caller keeps the DOM copy on screen rather than
 * showing nothing.
 */
export async function rasterizeAidSvg(
  svg: SVGSVGElement,
  w: number,
  h: number,
  dpr: number,
): Promise<HTMLImageElement | null> {
  if (w < 2 || h < 2) return null;
  // The element is authored in CSS pixels with no viewBox (it is positioned, not scaled). For the
  // texture we want DEVICE pixels, so the clone states the raster size and a viewBox carries the
  // original coordinate system into it — one attribute pair, no arithmetic on every child.
  const scale = Math.min(dpr, MAX_PX / Math.max(w, h));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  clone.setAttribute('width', String(Math.max(1, Math.round(w * scale))));
  clone.setAttribute('height', String(Math.max(1, Math.round(h * scale))));
  // Inline `position: absolute` is meaningless inside an SVG document and confuses nothing, but the
  // element is about to BE the document — drop it so the raster starts at its own origin.
  clone.removeAttribute('style');

  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.src = url;
    // load/error rather than decode(): decode() rejects on some Chromium versions for an SVG whose
    // intrinsic size comes from attributes, and this must degrade to "keep the DOM aid" not "throw".
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG rasterisation failed'));
    });
    return img;
  } catch (err) {
    console.warn('[projector] could not rasterise the alignment aid — keeping it in the raw raster', err);
    return null;
  } finally {
    // Safe here: the bitmap is decoded and held by the element, and revoking only drops the handle.
    URL.revokeObjectURL(url);
  }
}
