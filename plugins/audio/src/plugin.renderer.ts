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
import { setAudioHost } from './audioHost';
import { AudioSettings } from './AudioSettings';
import { AudioBedPanel } from './AudioBedPanel';
import type { AudioEffectSpec, ClipMeta, OutputMode, SpeakerLayout } from './audioManager';
import { MASTER_BUS_ID } from './effectDefs';
import {
  audioAutomationProvider, autoGain, autoTrackGain, autoMasterGain,
  applyClipOverrides, applyBusOverrides, hasOverride, takeDirty,
} from './automationTargets';

interface AudioPluginCfg { outputChannels?: number; outputMode?: OutputMode; speakerLayout?: SpeakerLayout }

// Minimal structural view of the persisted bed the driver reads (host.audio.getMix()). The concrete
// AudioMix lives in the host types; we only read these fields, so a local shape avoids a cross-package import.
interface BedClip { id: string; trackId: string; path: string; start: number; duration: number; inPoint: number; gain?: number; mute?: boolean; spatial?: { x: number; y: number; z: number }; effects?: AudioEffectSpec[] }
interface BedTrack { id: string; gain?: number; mute?: boolean }
interface BedBus { id: string; gain?: number; effects?: AudioEffectSpec[] }
interface Bed { tracks: BedTrack[]; clips: BedClip[]; buses: BedBus[] }

const SEEK_THRESHOLD = 0.2;  // s — tick-level playhead jump beyond wall-clock expectation ⇒ hard resync
const SYNC_THRESHOLD = 0.05; // s — per-clip source-offset drift (retime / missed small seek) ⇒ re-seek

let unsubTick: (() => void) | null = null;
let unsubMix: (() => void) | null = null;

function readBed(host: RendererHostServices): Bed {
  const mix = (host.audio.getMix() as Partial<Bed>) ?? {};
  return {
    tracks: Array.isArray(mix.tracks) ? mix.tracks : [],
    clips: Array.isArray(mix.clips) ? mix.clips : [],
    buses: Array.isArray(mix.buses) ? mix.buses : [],
  };
}

export const plugin: RendererPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'audio', title: 'Audio', Component: AudioSettings });
    // Audio clips carry no visual — keep them off the video-sync path and out of the PROGRAM composite.
    // MUST register in every window (main + projector), like tracking/mediapipe/augmenta.
    ctx.clipKinds.register({ kind: 'audio', excludeFromProgram: true, skipVideoSync: true });
    // Audio Bed authoring panel (global bed → ProjectData.audio). Modal, toggled from View ▸ Audio Bed.
    ctx.panels.register({ id: 'audio-bed', mount: 'modal', menuAction: 'audio-bed', title: 'Audio Bed', Component: AudioBedPanel });

    // Only the main editor/broadcast window drives the engine + bed playback.
    if (ctx.window !== 'main') return;

    const host = ctx.host as RendererHostServices;
    setAudioHost(host); // let the Audio Bed panel reach host.audio/host.show
    ctx.automationTargets.register(audioAutomationProvider); // the 'audio.*' namespace: bed gain/position/effect params

    // Open the device once on startup (default device, persisted channel count). Idempotent engine-side.
    const s0 = host.settings.get() as { plugins?: Record<string, unknown> };
    const cfg = (s0.plugins?.['audio'] as AudioPluginCfg) ?? {};
    void audioClient
      .configure(cfg.outputChannels ?? 2, cfg.outputMode ?? 'binaural', cfg.speakerLayout ?? 'stereo')
      .catch(() => { /* engine absent → no-op */ });

    // ── Global audio bed scheduler ────────────────────────────────────────────────────────────
    let bed: Bed = readBed(host);
    const loaded = new Map<string, ClipMeta>();   // clip source loaded in the engine
    const loading = new Set<string>();            // loads in flight (dedupe overlapping syncLoaded runs)
    const failed = new Set<string>();             // sources that failed to decode (don't retry every bed edit)
    const sounding = new Set<string>();           // clips the engine is currently playing
    const sentGain = new Map<string, number>();   // last gain pushed, per sounding clip
    const sentOffset = new Map<string, number>(); // last source offset seeked, per sounding clip
    const sentWallMs = new Map<string, number>(); // wall-clock (ms) at that seek — to estimate engine drift
    const sentSpatial = new Map<string, string>(); // last ambisonic position pushed ('' = non-spatial)
    const sentEffects = new Map<string, string>(); // last effect chain pushed, per clip (JSON)
    let sentMaster = '';                           // last master chain pushed (JSON)
    let sentMasterGain = NaN;                      // NaN ⇒ never pushed, so the first sync always lands
    let prevPlaying = false;
    let prevPlayhead = 0;
    let prevWallMs = 0;

    const trackOf = (clip: BedClip) => bed.tracks.find((t) => t.id === clip.trackId);
    // AUTOMATION READS THROUGH HERE. An automation lane writes to an override layer, not to the bed and
    // not to the engine — because reconcile() below re-reads the clip from the bed every frame, so a
    // value pushed straight to the engine would be overwritten with the AUTHORED one on the same frame,
    // 60 times a second. Every driver read of an automatable leaf therefore goes through `eff`/`effGain`.
    const effGain = (clip: BedClip) =>
      (autoGain(clip.id) ?? clip.gain ?? 1) * (autoTrackGain(clip.trackId) ?? trackOf(clip)?.gain ?? 1);
    /** The clip as it should SOUND: authored, with any automated leaves laid over it. */
    const eff = (clip: BedClip): BedClip => (hasOverride(clip.id) ? applyClipOverrides(clip) : clip);
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
        if (!wanted.has(id)) {
          if (sounding.has(id)) stopSounding(id);
          audioClient.unloadClip(id);
          loaded.delete(id);
          // The engine dropped the source AND its chain — forget what we pushed, so a clip that comes
          // back (undo, re-add) gets its position and effects re-sent rather than assumed still applied.
          sentSpatial.delete(id);
          sentEffects.delete(id);
        }
      }
      for (const id of [...failed]) if (!wanted.has(id)) failed.delete(id); // a re-added clip gets another try
      for (const clip of bed.clips) {
        if (loaded.has(clip.id) || loading.has(clip.id) || failed.has(clip.id) || !clip.path) continue;
        loading.add(clip.id);
        try {
          const meta = await audioClient.loadClip(clip.id, clip.path);
          if (meta) {
            if (bed.clips.some((c) => c.id === clip.id)) {
              loaded.set(clip.id, meta);
              // Push THIS clip's position + effects immediately, before awaiting the next load. The
              // moment it lands in `loaded` it becomes audible() — and the playhead tick is rAF-driven,
              // so reconcile() can start it on the very next frame. Deferring the push to the end of the
              // pass would let it begin life dry and dead-centre while the rest of the bed decodes.
              pushClipParams(eff(clip)); // eff(), not the raw clip — a lane may already own some of its leaves
            } else {
              audioClient.unloadClip(clip.id); // removed while loading → don't leave it resident
            }
          }
        } catch {
          // Undecodable / missing source (loadClip rejects). Skip it and remember: one bad clip must never
          // abort the pass (that would silence every clip after it) nor retry-storm on every bed edit.
          failed.add(clip.id);
          console.warn('[audio] clip failed to load:', clip.path);
        } finally { loading.delete(clip.id); }
      }
    };

    // Push one clip's ambisonic position (or clear it back to non-spatial), and its insert chain. Both
    // are change-detected: dragging a source around the pad must not spam IPC, and EVERY setClipEffects
    // takes the audio lock, so re-sending an unchanged chain would tax the audio thread for nothing.
    // Only a LOADED clip can be pushed — the engine attaches these to a source it holds, so a push for an
    // id it hasn't loaded is silently dropped.
    const pushSpatial = (clip: BedClip) => {
      const s = clip.spatial;
      const key = s ? `${s.x},${s.y},${s.z}` : '';
      if (sentSpatial.get(clip.id) === key) return;
      if (s) audioClient.setClipSpatial(clip.id, s.x, s.y, s.z);
      else audioClient.clearClipSpatial(clip.id);
      sentSpatial.set(clip.id, key);
    };
    const pushEffects = (clip: BedClip) => {
      const fx = clip.effects ?? [];
      const key = JSON.stringify(fx);
      if (sentEffects.get(clip.id) === key) return;
      audioClient.setClipEffects(clip.id, fx);
      sentEffects.set(clip.id, key);
    };
    // Spatial BEFORE effects: flipping a clip spatial changes its chain's channel count (the engine runs
    // a spatial source's chain in mono), which forces a rebuild — effects-first would just throw it away.
    const pushClipParams = (clip: BedClip) => { pushSpatial(clip); pushEffects(clip); };

    const syncMaster = () => {
      const authored = bed.buses.find((b) => b.id === MASTER_BUS_ID);
      const master = authored ? applyBusOverrides(authored) : undefined;
      const mfx = master?.effects ?? [];
      const mkey = JSON.stringify(mfx);
      if (sentMaster !== mkey) { audioClient.setMasterEffects(mfx); sentMaster = mkey; }
      const mgain = autoMasterGain() ?? master?.gain ?? 1;
      if (sentMasterGain !== mgain) { audioClient.setMasterGain(mgain); sentMasterGain = mgain; }
    };
    const syncClips = () => {
      for (const clip of bed.clips) if (loaded.has(clip.id)) pushClipParams(eff(clip));
      syncMaster();
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
      // The automation sampler ran moments ago, in the same frame (timeline.ts calls it just before it
      // notifies its subscribers, of which this is one — so a curve's value reaches the engine on the
      // frame it was sampled, not the next). Push whatever it moved. Only the owners it actually touched:
      // an unchanged value never gets here, because the sampler gates on a half-step epsilon and every
      // push costs an acquisition of the engine's audio lock.
      const moved = takeDirty();
      if (moved.size > 0) {
        for (const clip of bed.clips) if (moved.has(clip.id) && loaded.has(clip.id)) pushClipParams(eff(clip));
        if (moved.has(MASTER_BUS_ID)) syncMaster();
      }
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

    void syncLoaded().then(syncClips);
    unsubMix = host.audio.subscribe(() => { bed = readBed(host); void syncLoaded().then(syncClips); });
    unsubTick = ctx.onPlayhead(tick);
  },

  deactivate(): void {
    unsubTick?.(); unsubTick = null;
    unsubMix?.(); unsubMix = null;
    audioClient.stopAll();
  },
};
