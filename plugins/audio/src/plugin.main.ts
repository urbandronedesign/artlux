// audio — main-process activation. Owns the native JUCE engine (via audioManager) and exposes it to
// the renderer over the generic plugin bridge:
//   renderer → main : audio:configure/getDevices/getMeters/loadClip (invoke, need a reply)
//                     audio:unloadClip/playClip/stopClip/setClipGain/setTestTone/stopAll (send, fire-and-forget)
// The engine graceful-degrades: if the .node is missing every handler is a harmless no-op.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as engine from './audioManager';
import {
  conformAppend, conformFinish, conformFrames, conformRewind, conformStart, pruneCache,
} from './conform.main';

// Ceiling for the conform cache, swept after each conform lands. Generous on purpose: a conform is 16-bit
// at the source rate (~10 MB/minute stereo), and re-conforming a show's media because the cache was
// trimmed too eagerly costs an operator minutes at exactly the wrong moment. Derivable either way.
const CONFORM_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

export const plugin: MainPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;

    // Reply channels (renderer invoke). configure/loadClip may throw in the addon → the invoke rejects.
    // configure(cfg) — the WHOLE setup in one object (type, device, channels, rate, buffer, mode, layout).
    // Returns what was ACTUALLY opened, which can differ from what was asked.
    ipc.handle('audio:configure', (cfg) => engine.configure((cfg ?? {}) as engine.DeviceCfg));
    ipc.handle('audio:getDevices', () => engine.getDevices());
    ipc.handle('audio:getMeters', () => engine.getMeters());
    // Is the native engine actually loaded? `available` was exported and unconsumed — the renderer had to
    // INFER unavailability from configure() returning an empty device name. Mirrors calib:available and
    // ndi:available. A missing engine is silent by construction; this is the only way to see it.
    ipc.handle('audio:available', () => engine.available);
    ipc.handle('audio:loadClip', (id, path) => engine.loadClip(String(id), String(path)));

    // Fire-and-forget control (renderer send).
    ipc.on('audio:unloadClip', (id) => engine.unloadClip(String(id)));
    ipc.on('audio:playClip', (id, seek, gain) => engine.playClip(String(id), Number(seek) || 0, gain == null ? 1 : Number(gain)));
    ipc.on('audio:stopClip', (id) => engine.stopClip(String(id)));
    ipc.on('audio:setClipGain', (id, gain) => engine.setClipGain(String(id), gain == null ? 1 : Number(gain)));
    ipc.on('audio:setClipSpatial', (id, x, y, z) => engine.setClipSpatial(String(id), Number(x) || 0, Number(y) || 0, Number(z) || 0));
    ipc.on('audio:clearClipSpatial', (id) => engine.clearClipSpatial(String(id)));
    // Effect chains. The addon parses the specs defensively (an unknown type or a malformed param is
    // skipped, never thrown) — these arrive fire-and-forget, so there is nobody to reject to.
    ipc.on('audio:setClipEffects', (id, fx) => engine.setClipEffects(String(id), Array.isArray(fx) ? (fx as engine.AudioEffectSpec[]) : []));
    ipc.on('audio:setMasterEffects', (fx) => engine.setMasterEffects(Array.isArray(fx) ? (fx as engine.AudioEffectSpec[]) : []));
    ipc.on('audio:setMasterGain', (g) => engine.setMasterGain(g == null ? 1 : Number(g)));
    // Commissioning tone. deviceChannel < 0 turns it off; see audioManager.setTestTone.
    ipc.on('audio:setTestTone', (ch, g) => engine.setTestTone(ch == null ? -1 : Number(ch), g == null ? 0.5 : Number(g)));
    ipc.on('audio:stopAll', () => engine.stopAll());

    // ── The conform (a video file's soundtrack → a cached WAV the engine can already open) ──────────
    // ALL invokes, no sends: every step is an awaited round trip, which is both the ordering guarantee
    // (an append must never overtake the finish on a different IPC channel) and the back-pressure that
    // keeps a fast decoder from outrunning the disk. See conform.main.ts for the branch matrix.
    ipc.handle('audio:conformStart', (src) => conformStart(String(src ?? '')));
    ipc.handle('audio:conformFrames', (token) => conformFrames(String(token ?? '')));
    ipc.handle('audio:conformRewind', (token) => { conformRewind(String(token ?? '')); return true; });
    ipc.handle('audio:conformAppend', (token, pcm, channels, rate) => conformAppend(
      String(token ?? ''),
      // Structured-clone hands a TypedArray back as one; a plain object would mean a protocol change
      // upstream, and writing its `length` bytes of nothing is how a conform ends up silent.
      pcm instanceof Int16Array ? pcm : new Int16Array(0),
      Math.max(1, Number(channels) || 2),
      Math.max(1, Number(rate) || 48000),
    ));
    ipc.handle('audio:conformFinish', (token, ok) => {
      const wav = conformFinish(String(token ?? ''), ok !== false);
      if (wav) pruneCache(CONFORM_CACHE_BYTES);
      return wav;
    });
  },

  deactivate(): void {
    engine.close();
  },

  // Reported on the startup splash, and this is THE one that needed saying: without audio-engine.node
  // the whole audio UI renders, every transport control works, meters read zero, and nothing ever
  // makes a sound — silently, by design (`npm run build:audio` only WARNS on failure). `available` is
  // "did the addon load", NOT "is there a device"; a device is a later, separate question.
  status: () => engine.available
    ? { state: 'ok', detail: 'JUCE engine loaded' }
    : { state: 'degraded', detail: 'native engine missing — nothing will play (npm run build:audio)' },
};
