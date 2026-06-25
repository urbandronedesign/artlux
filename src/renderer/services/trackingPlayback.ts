// Replays recorded LiDAR-blob takes during timeline playback. Subscribes to the engine playhead
// (every frame, even when paused — so scrubbing works) and, when the playhead is over a tracking
// take clip, injects that take's frame into the tracking store. This reuses the store's existing
// snapshot bridge (App.tsx pumps trackingStore snapshots to the Scene + tracking projectors), so
// mirror windows need no extra wiring.
//
// Kept OUT of services/timeline.ts on purpose: the video engine must not couple to the tracking
// store (docs/TIMELINE.md). Main window only — App constructs this; mirror windows already receive
// the resulting snapshots over the bridge.
import { timeline as engine } from './timeline';
import * as trackingStore from './trackingStore';
import * as take from './trackingTake';
import type { Timeline, VideoClip } from '../types';

let data: Timeline | null = null;
let active = false;   // a tracking clip is currently driving the store
let started = false;

// Topmost tracking clip covering time t (later clips win on overlap — mirrors the engine's activeClip).
function topmostTrackingClip(t: number): VideoClip | null {
  if (!data) return null;
  let found: VideoClip | null = null;
  for (const c of data.clips) {
    if (c.kind !== 'tracking') continue;
    if (t >= c.start && t < c.start + c.duration) found = c;
  }
  return found;
}

// Feed the latest timeline; pre-load every placed take so the first play is instant.
export function setData(t: Timeline): void {
  data = t;
  for (const c of t.clips) if (c.kind === 'tracking' && c.path) void take.ensureLoaded(c.path);
}

export function start(): void {
  if (started) return;
  started = true;
  engine.subscribe((playhead) => {
    const clip = topmostTrackingClip(playhead);
    if (clip && clip.path) {
      const tk = take.getCached(clip.path);
      if (!tk) { void take.ensureLoaded(clip.path); return; } // not loaded yet — keep prior state briefly
      const local = playhead - clip.start + (clip.inPoint ?? 0);
      trackingStore.setReplaySource(true); // global simulation override: live OSC is suppressed
      trackingStore.applySnapshot(take.frameAt(tk, local));
      active = true;
    } else if (active) {
      // Left the last take clip: clear blobs (no frozen ghosts) and hand the store back to live OSC.
      trackingStore.setReplaySource(false);
      trackingStore.applySnapshot({ surfaces: [] });
      active = false;
    }
  });
}
