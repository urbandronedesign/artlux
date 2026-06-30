// Records the live LiDAR blob stream into a take. Taps trackingStore.subscribe (already coalesced
// to one notification per animation frame) and captures a serializable snapshot per frame, stamped
// with wall-clock elapsed. Capture is INDEPENDENT of the timeline transport — you record a
// performance, then drag the finished take onto a tracking lane (see TakesBin / trackingPlayback).
import * as trackingStore from './trackingStore';
import { buildDensity, type TrackingTake, type TrackingTakeFrame } from './trackingTake';

let frames: TrackingTakeFrame[] | null = null;
let startMs = 0;
let unsub: (() => void) | null = null;
const subs = new Set<() => void>();
const notify = (): void => { subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[trackingRecorder] sub error', e); } }); };

export function isRecording(): boolean { return frames != null; }
export function getElapsed(): number { return frames ? (performance.now() - startMs) / 1000 : 0; }

// UI re-renders its REC indicator off this (start/stop only — the elapsed readout is read via a timer).
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

// Begin capturing. Refuses while a take is already driving the store (replay active), so we never
// record replayed data instead of the live feed. Returns false if it couldn't start.
export function start(): boolean {
  if (frames) return false;
  if (trackingStore.isReplaySource()) return false; // a placed take is playing under the playhead
  frames = [];
  startMs = performance.now();
  unsub = trackingStore.subscribe(() => {
    if (!frames) return;
    frames.push({ t: (performance.now() - startMs) / 1000, snap: trackingStore.snapshot() });
  });
  notify();
  return true;
}

// Finish capturing → a TrackingTake (or null if nothing was captured). Caller persists + names it.
export function stop(): TrackingTake | null {
  if (!frames) return null;
  unsub?.(); unsub = null;
  const f = frames;
  frames = null;
  notify();
  if (f.length === 0) return null;
  const duration = f[f.length - 1].t;
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: '',
    duration,
    fps: duration > 0 ? Math.round((f.length - 1) / duration) : undefined,
    frames: f,
    density: buildDensity(f),
  };
}

export function cancel(): void {
  if (!frames) return;
  unsub?.(); unsub = null;
  frames = null;
  notify();
}
