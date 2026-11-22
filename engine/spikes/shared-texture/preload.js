// The ISOLATED variant (SPIKE_ISOLATED=1): the page runs as ArtLux's do — sandbox + contextIsolation, no
// Node. The preload owns the receiver and hands the page each VideoFrame across contextBridge; the page
// draws it and calls done(), and only then does the preload release the texture and free the slot.
const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
let onFrame = null;
contextBridge.exposeInMainWorld('engineFrames', {
  available: !!sharedTexture,
  onFrame(cb) { onFrame = cb; },
  drawn(slot, report, error) { ipcRenderer.send('drawn', { slot, report, error }); },
});
if (sharedTexture) {
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, meta) => {
    try {
      const vf = importedSharedTexture.getVideoFrame();
      if (onFrame) onFrame(vf, meta); else vf.close();
    } catch (e) {
      ipcRenderer.send('drawn', { slot: meta.slot, error: 'preload: ' + String(e && e.message || e) });
    } finally {
      importedSharedTexture.release();
    }
  });
}
