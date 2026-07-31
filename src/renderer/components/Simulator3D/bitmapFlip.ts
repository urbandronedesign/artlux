import * as THREE from 'three';

// THREE IGNORES Texture.flipY WHEN THE SOURCE IS AN ImageBitmap.
//
// In WebGLTextures the unpack flags — including UNPACK_FLIP_Y_WEBGL — are set inside
// `if (isImageBitmap === false)`, so a bitmap is uploaded unflipped no matter what the texture asks
// for. Everything else (a canvas, a <video>, an <img>) honours it.
//
// That splits the two windows apart, because they feed the SAME texture from different sources: the
// editor's 3D view samples the live canvas/video directly, while a projector window is streamed
// ImageBitmaps by the frame pump (decode once in main, transfer). The result was content the right
// way up in the editor and upside down on the real projector — geometry perfectly aligned, picture
// mirrored, which reads like a broken calibration and is not one.
//
// Fixed with the texture MATRIX, which applies to every source: sampling v from 1-v is exactly the
// upload flip that was skipped. Deliberately NOT fixed at the bitmap, i.e. by creating it with
// `imageOrientation: 'flipY'` — the same bitmap is also drawn by the projector's base 2D canvas and
// by the tracking background, and flipping it there would invert those instead.
export function matchBitmapOrientation(t: THREE.Texture): void {
  const isBitmap = typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap;
  const compensate = isBitmap && t.flipY; // a flip was asked for and will be silently dropped
  const y = compensate ? -1 : 1;
  if (t.repeat.y !== y) {
    t.repeat.y = y;
    t.offset.y = compensate ? 1 : 0;
  }
}
