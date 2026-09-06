// Video-clip audio — the derivation, kept in its own module so it can be exercised by a throwaway
// `node --experimental-strip-types` script (there is no unit runner). It is pure: a Timeline in, a
// TimelineAudio-shaped view out, no DOM, no engine state.

import type { Timeline, TimelineAudio, VideoClip } from '../types';
import { isContentClip } from '../types';

// ── Video-clip audio: the THIRD audio container ──────────────────────────────────────────────────
//
// A video clip's own soundtrack, presented to the audio plugin in the SAME shape as `Timeline.audio` so
// the driver's one reconcile serves it with no new concepts — same clock (the playhead), same mute/solo
// scoping, same fades. See plans/video-clip-audio.md.
//
// DERIVED, NEVER LINKED, and that is the whole design. A "linked audio clip" (the Premiere model) would
// have to be maintained across every edit path there is — move, trim, blade, slip, ripple, delete, undo —
// and every path that forgot would leave sound playing under a clip that is no longer there. Recomputing
// from the video clip means placement is inherited BY CONSTRUCTION: there is nothing to keep in sync, so
// there is nothing to get out of sync.
//
// `path` is the SOURCE VIDEO's path, deliberately. The engine cannot open an mp4 — the audio plugin swaps
// in the conformed WAV (plugins/audio/conform.main.ts) on its way to the driver. Core does the document
// work; the plugin does the sound. Core never learns what a conform is.
//
// ⚠ MEMOISED ON IDENTITY, AND IT MUST STAY THAT WAY. This is read EVERY FRAME by the audio driver, whose
// orphan detector gates on the clip array's REFERENCE (plugin.renderer.ts pruneOrphans). A fresh array per
// call would defeat that gate and kick a full load/unload reconciliation pass — over IPC — 60 times a
// second, forever. Same promise EMPTY_TIMELINE_AUDIO makes one layer up, for the same reason.
const EMPTY_VIDEO_AUDIO: TimelineAudio = Object.freeze({
  tracks: Object.freeze([]) as unknown as TimelineAudio['tracks'],
  clips: Object.freeze([]) as unknown as TimelineAudio['clips'],
});
let vaMemoLayers: Timeline['layers'] | null = null;
let vaMemoClips: Timeline['clips'] | null = null;
let vaMemoOut: TimelineAudio = EMPTY_VIDEO_AUDIO;

/**
 * A clip contributes sound when it is a plain path-based video clip that has not been silenced. Tracking
 * lanes and generalized-content clips (Spout/NDI/camera/effects) have no file to conform, and a clip whose
 * `audio.enabled` is explicitly false has been switched off by the operator. Absent ⇒ audible.
 */
const clipHasAudio = (c: VideoClip): boolean =>
  c.kind !== 'tracking' && c.kind !== 'lighting' && !isContentClip(c) && !!c.path && c.audio?.enabled !== false;

export function videoAudioOf(t: Timeline): TimelineAudio {
  if (t.layers === vaMemoLayers && t.clips === vaMemoClips) return vaMemoOut;
  vaMemoLayers = t.layers; vaMemoClips = t.clips;

  const clips: TimelineAudio['clips'] = [];
  const usedLayers = new Set<string>();
  for (const c of t.clips) {
    if (!clipHasAudio(c)) continue;
    const a = c.audio;
    usedLayers.add(c.layerId);
    clips.push({
      // `va:` / `vl:` prefixes keep these clear of the authored AudioClip ids in the SAME bound document,
      // which is all that is required — the engine never holds two documents at once.
      id: `va:${c.id}`,
      trackId: `vl:${c.layerId}`,
      name: c.name,
      path: c.path,                       // the SOURCE; the audio plugin maps it to a conform
      start: c.start,
      duration: c.duration,
      // THE A/V TRIM IS FOLDED INTO inPoint. A derived clip may lie about its trim, so per-clip latency
      // compensation costs the driver nothing — it is simply a clip that starts a few ms further in. (The
      // MACHINE-wide default offset is added by the plugin: this is the document's half, that is the
      // venue's.)
      inPoint: c.inPoint + (a?.offsetMs ?? 0) / 1000,
      sourceDuration: c.sourceDuration,
      gain: a?.gain,
      mute: a?.mute,
      fadeIn: a?.fadeIn,
      fadeOut: a?.fadeOut,
      spatial: a?.spatial,
      effects: a?.effects,
    });
  }
  if (!clips.length) { vaMemoOut = EMPTY_VIDEO_AUDIO; return vaMemoOut; }

  // One track per contributing layer, so the layer's audio mute/solo/gain apply to everything on it —
  // and solo stays scoped to THIS container (soloing a video layer must not silence the bed).
  const tracks: TimelineAudio['tracks'] = [];
  for (const l of t.layers) {
    if (!usedLayers.has(l.id)) continue;
    // `effects` is the LAYER's insert chain, run per clip on it — see AudioTrack.effects for why that is
    // not the same thing as a bus, and why it is nevertheless the same sound here. Array.isArray, not
    // truthiness: layers carry no audio sanitizer, so this projection is where the shape guard lives.
    tracks.push({
      id: `vl:${l.id}`, name: l.name,
      gain: l.audio?.gain, mute: l.audio?.mute, solo: l.audio?.solo,
      effects: Array.isArray(l.audio?.effects) ? l.audio.effects : undefined,
      // The layer's position — a DEFAULT for the clips on it, not an override. See AudioTrack.spatial.
      spatial: l.audio?.spatial,
    });
  }
  vaMemoOut = { tracks, clips };
  return vaMemoOut;
}

