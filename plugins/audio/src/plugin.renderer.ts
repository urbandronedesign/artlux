// audio — renderer activation. Registers the Audio settings section + the 'audio' clip-kind (every
// window), and — in the main window only — configures the native engine and runs the playhead-driven
// GLOBAL AUDIO BED player.
//
// The native engine owns sample-accurate playback; this driver is a SCHEDULER. Each frame it reconciles
// which bed clips should be sounding for the current transport playhead and starts/stops/re-syncs them.
// onPlayhead fires every frame INCLUDING WHILE PAUSED (the playhead just freezes), so pause is detected
// by polling host.show.getStatus().playing — never by "the callback stopped". Big seeks (playhead jumps
// beyond wall-clock expectation) hard-resync; small seeks + live retime/gain edits are caught per-clip by
// comparing each sounding clip's desired vs estimated source offset. Bus effects, solo, fades and spatial
// are later phases; C4 does flat clip×track gain + mute.

import type { RendererPlugin, RendererPluginContext, RendererHostServices } from '@artlux/sdk/renderer';
import { setIpc, audioClient } from './audioClient';
import { AudioSettings } from './AudioSettings';
import type { ClipMeta } from './audioManager';

interface AudioPluginCfg { outputChannels?: number }

// Minimal structural view of the persisted bed the driver reads (host.audio.getMix()). The concrete
// AudioMix lives in the host types; we only read these fields, so a local shape avoids a cross-package import.
interface BedClip { id: string; trackId: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean }
interface BedTrack { id: string; gain?: number; mute?: boolean }
interface Bed { tracks: BedTrack[]; clips: BedClip[] }

const SEEK_THRESHOLD = 0.2;  // s — tick-level playhead jump beyond wall-clock expectation ⇒ hard resync
const SYNC_THRESHOLD = 0.05; // s — per-clip source-offset drift (retime / missed small seek) ⇒ re-seek

let unsubTick: (() => void) | null = null;
let unsubMix: (() => void) | null = null;

function readBed(host: RendererHostServices): Bed {
  const mix = (host.audio.getMix() as Partial<Bed>) ?? {};
  return { tracks: Array.isArray(mix.tracks) ? mix.tracks : [], clips: Array.isArray(mix.clips) ? mix.clips : [] };
}

export const plugin: RendererPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'audio', title: 'Audio', Component: AudioSettings });
    // Audio clips carry no visual — keep them off the video-sync path and out of the PROGRAM composite.
    // MUST register in every window (main + projector), like tracking/mediapipe/augmenta.
    ctx.clipKinds.register({ kind: 'audio', excludeFromProgram: true, skipVideoSync: true });

    // Only the main editor/broadcast window drives the engine + bed playback.
    if (ctx.window !== 'main') return;

    const host = ctx.host as RendererHostServices;

    // Open the device once on startup (default device, persisted channel count). Idempotent engine-side.
    const s0 = host.settings.get() as { plugins?: Record<string, unknown> };
    const cfg = (s0.plugins?.['audio'] as AudioPluginCfg) ?? {};
    void audioClient.configure(cfg.outputChannels ?? 2).catch(() => { /* engine absent → no-op */ });

    // ── Global audio bed scheduler ────────────────────────────────────────────────────────────
    let bed: Bed = readBed(host);
    const loaded = new Map<string, ClipMeta>();   // clip source loaded in the engine
    const loading = new Set<string>();            // loads in flight (dedupe overlapping syncLoaded runs)
    const sounding = new Set<string>();           // clips the engine is currently playing
    const sentGain = new Map<string, number>();   // last gain pushed, per sounding clip
    const sentOffset = new Map<string, number>(); // last source offset seeked, per sounding clip
    const sentWallMs = new Map<string, number>(); // wall-clock (ms) at that seek — to estimate engine drift
    let prevPlaying = false;
    let prevPlayhead = 0;
    let prevWallMs = 0;

    const trackOf = (clip: BedClip) => bed.tracks.find((t) => t.id === clip.trackId);
    const effGain = (clip: BedClip) => (clip.gain ?? 1) * (trackOf(clip)?.gain ?? 1);
    const audible = (clip: BedClip) => !clip.mute && !trackOf(clip)?.mute && loaded.has(clip.id);

    const startClip = (clip: BedClip, srcOffset: number, nowMs: number) => {
      const g = effGain(clip);
      audioClient.playClip(clip.id, srcOffset, g); // playClip seek is a SOURCE offset
      sounding.add(clip.id); sentGain.set(clip.id, g); sentOffset.set(clip.id, srcOffset); sentWallMs.set(clip.id, nowMs);
    };
    const stopSounding = (id: string) => {
      audioClient.stopClip(id);
      sounding.delete(id); sentGain.delete(id); sentOffset.delete(id); sentWallMs.delete(id);
    };
    const stopAllSounding = () => {
      audioClient.stopAll();
      sounding.clear(); sentGain.clear(); sentOffset.clear(); sentWallMs.clear();
    };

    // Reconcile engine-resident sources with the bed. Removed clips are stopped+unloaded FIRST — a
    // fire-and-forget path that is never blocked by a slow load (so deleting a sounding clip silences it
    // immediately). New clips load behind an in-flight guard; a clip removed while its load is pending is
    // unloaded once the load resolves rather than orphaned in the mixer.
    const syncLoaded = async () => {
      const wanted = new Set(bed.clips.map((c) => c.id));
      for (const id of [...loaded.keys()]) {
        if (!wanted.has(id)) { if (sounding.has(id)) stopSounding(id); audioClient.unloadClip(id); loaded.delete(id); }
      }
      for (const clip of bed.clips) {
        if (loaded.has(clip.id) || loading.has(clip.id) || !clip.path) continue;
        loading.add(clip.id);
        try {
          const meta = await audioClient.loadClip(clip.id, clip.path);
          if (meta) {
            if (bed.clips.some((c) => c.id === clip.id)) loaded.set(clip.id, meta);
            else audioClient.unloadClip(clip.id); // removed while loading → don't leave it resident
          }
        } finally { loading.delete(clip.id); }
      }
    };

    const reconcile = (playhead: number, nowMs: number) => {
      for (const clip of bed.clips) {
        const inWindow = playhead >= clip.start && playhead < clip.start + clip.duration;
        const isSounding = sounding.has(clip.id);
        if (inWindow && audible(clip) && !isSounding) {
          startClip(clip, clip.inPoint + (playhead - clip.start), nowMs);
        } else if (isSounding && (!inWindow || !audible(clip))) {
          stopSounding(clip.id);
        } else if (isSounding) {
          // In-window, audible, already sounding — track live gain + re-lock after a retime / small seek.
          const g = effGain(clip);
          if (sentGain.get(clip.id) !== g) { audioClient.setClipGain(clip.id, g); sentGain.set(clip.id, g); }
          const desired = clip.inPoint + (playhead - clip.start);
          // Estimate where the engine's source cursor is now (it advanced in real time since the last seek).
          // During steady playback desired ≈ estimated (both derive from performance.now); a retime or a
          // small seek the tick-level detector missed makes them diverge → re-seek to re-lock to the playhead.
          const estimated = (sentOffset.get(clip.id) ?? desired) + (nowMs - (sentWallMs.get(clip.id) ?? nowMs)) / 1000;
          if (Math.abs(desired - estimated) > SYNC_THRESHOLD) {
            audioClient.playClip(clip.id, desired, g);
            sentOffset.set(clip.id, desired); sentWallMs.set(clip.id, nowMs);
          }
        }
      }
    };

    const tick = (playhead: number) => {
      const nowMs = performance.now();
      const playing = host.show.getStatus().playing;
      const expectedDelta = prevPlaying ? (nowMs - prevWallMs) / 1000 : 0;
      const seeked = Math.abs((playhead - prevPlayhead) - expectedDelta) > SEEK_THRESHOLD;

      if (prevPlaying && !playing) {
        stopAllSounding();                              // paused → freeze the bed
      } else if (playing && (seeked || !prevPlaying)) {
        stopAllSounding(); reconcile(playhead, nowMs);  // resume or big seek → hard resync at the new playhead
      } else if (playing) {
        reconcile(playhead, nowMs);                     // normal advance (+ live gain/retime/small-seek sync)
      }
      prevPlaying = playing; prevPlayhead = playhead; prevWallMs = nowMs;
    };

    void syncLoaded();
    unsubMix = host.audio.subscribe(() => { bed = readBed(host); void syncLoaded(); });
    unsubTick = ctx.onPlayhead(tick);
  },

  deactivate(): void {
    unsubTick?.(); unsubTick = null;
    unsubMix?.(); unsubMix = null;
    audioClient.stopAll();
  },
};
