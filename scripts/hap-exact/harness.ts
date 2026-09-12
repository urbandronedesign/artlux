import * as hapGL from '@hapgl';
import type { HapFrame } from '@haptypes';

const { ipcRenderer } = require('electron');

// Upload one real HAP frame through the REAL hapGL and ask the question the native layer cannot
// answer: does this file's alpha survive as far as a DRAWABLE? The bake reads exactly that drawable
// (surfaceMedia.getDrawable), so whatever is true here is what a render writes — which makes this the
// deciding measurement for whether a HAP surface can be baked with transparency at all.
ipcRenderer.on('frame', (_e: unknown, f: (HapFrame & { data: ArrayBufferLike }) | null) => {
  if (!f) { ipcRenderer.send('gl', { error: 'main sent no frame' }); return; }
  try {
    const frame = { ...f, data: new Uint8Array(f.data) } as unknown as HapFrame;
    const cv = hapGL.uploadFrame('probe', frame);
    if (!cv) { ipcRenderer.send('gl', { error: 'uploadFrame returned null (no WebGL2?)' }); return; }

    // Read it back the way the compositor would: drawn onto a TRANSPARENT 2D canvas. Anything that
    // loses alpha between the GL canvas and here loses it for the bake too, so this path is the test.
    const w = Math.min(128, f.width), h = Math.min(128, f.height);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const g = out.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!g) { ipcRenderer.send('gl', { error: 'no 2D context' }); return; }
    g.clearRect(0, 0, w, h);
    g.drawImage(cv as CanvasImageSource, 0, 0, w, h);

    const px = g.getImageData(0, 0, w, h).data;
    let min = 255, max = 0, below = 0;
    for (let i = 3; i < px.length; i += 4) {
      const a = px[i];
      if (a < min) min = a;
      if (a > max) max = a;
      if (a < 250) below++;
    }
    ipcRenderer.send('gl', {
      alphaMin: min, alphaMax: max, pixelsBelow250: below,
      // Deliberately the SAME test bakeRunner.hasTransparency() applies, so this harness and the panel
      // can never disagree about what counts as transparent.
      alphaReachesDrawable: min < 250,
      format: f.format, width: f.width, height: f.height,
    });
  } catch (e) {
    ipcRenderer.send('gl', { error: String((e as Error)?.message || e) });
  }
});
