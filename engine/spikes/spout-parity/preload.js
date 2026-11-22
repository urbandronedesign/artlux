// The app's shared-texture relay (src/preload/index.ts, "SHARED GPU TEXTURES"), the same calls in the same
// order: the imported texture → a VideoFrame → window.postMessage → our references closed. It lives inline
// in the app's preload, so it is mirrored here rather than imported; keep the two in step.
const { sharedTexture } = require('electron');
sharedTexture.setSharedTextureReceiver(async (data, ...args) => {
  const channel = typeof args[0] === 'string' ? args[0] : '';
  const meta = args[1];
  const imported = data?.importedSharedTexture;
  if (!imported) return;
  try {
    const frame = imported.getVideoFrame();
    window.postMessage({ kind: 'artlux:shared-texture', channel, meta, frame }, '*');
    frame.close();
  } catch { /* a dropped frame */ } finally {
    imported.release();
  }
});
