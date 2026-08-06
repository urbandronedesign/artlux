import type { ContextActionLive } from '@artlux/sdk/renderer';
import { nextNumberedName } from '@artlux/sdk/renderer';
import { trackingRecorder, trackingTake } from '@artlux/plugin-lidar-tracking';
import * as lightingRecorder from './lightingRecorder';
import type { Timeline } from '../types';

// THE ONE OWNER OF A RECORDED TAKE.
//
// Two recorders exist — `services/lightingRecorder` (the selected fixtures' movement) and the LiDAR
// plugin's `trackingRecorder` (the live blob feed) — and both are already UI-agnostic singletons that
// say in their own headers that capture is INDEPENDENT OF THE TRANSPORT. Neither needs the timeline.
//
// Only the COMMIT did, and only because a finished take is stored on the timeline document
// (`lightingTakes` inline, `trackingTakes` as refs to .lblob files on disk). That is why the whole
// record UI was marooned in a drawer: the commit logic lived inside `Timeline.tsx`, so the button had
// to live there too. It is here now, so a dock panel, an action-bar button, a status chip and a
// keyboard shortcut can all reach the same function.
//
// WHAT THIS IS NOT: a door for the show. Every writer of a bound timeline that is NOT a human gesture
// (an FSM entry action, an OSC message, a cue GO, the scheduler) must keep calling setScenes/setTimeline
// directly — see the comment on App.handleTimelineChange. Routing a show event through here would fill
// an unattended install's undo stack with changes nobody made. Nothing in this module may be called
// from oscController, cueBus or the FSM action table.

/**
 * What the service needs from App, as live readers rather than captured values.
 *
 * Every method reads a ref that App reassigns on render, which is exactly what `Timeline.tsx` already
 * did with `timelineRef` / `onChangeRef` / `docKeyRef`. So this is behaviour-preserving, INCLUDING the
 * staleness window it does not close: a value read here describes the binding as of the last render.
 * That is safe for this caller and only this caller, because starting and stopping a take is always a
 * human gesture dispatched from an event handler — never a synchronous call inside the frame in which
 * a scene recall merely QUEUED setActiveSceneId (the case App.tsx:375-379 warns about).
 */
export interface TakeHost {
  /** The BOUND document — the active scene's timeline, else the global one. */
  timeline(): Timeline;
  /** The write target's identity. `activeSceneId ?? '__global__'` — the same string handleTimelineChange routes on. */
  docKey(): string;
  /** Commit a whole timeline as ONE undo entry (App.handleTimelineChange). */
  commit(next: Timeline): void;
  /** Project folder, when there is one — enables the copy-in of a .lblob into assets/tracking. */
  projectPath(): string | null;
  /** The lighting recorder's target. THE ORDER IS THE SHOW — it becomes the take's part order. */
  selectedFixtureIds(): string[];
  /** Operator-visible refusal. Replaces the console.warn nobody ever saw. */
  notify(kind: 'error' | 'warn' | 'info', title: string, detail?: string): void;
  /** Names the destination on the REC chip ("→ Act 2" / "→ Global"). */
  destinationName(): string;
}

let host: TakeHost | null = null;

export function setHost(h: TakeHost): void { host = h; }

// ── Live state ───────────────────────────────────────────────────────────────────────────────────
// A CACHED object, reassigned only when a boolean actually flips. Every reader here goes through
// useSyncExternalStore, which compares with Object.is — a fresh literal per call is an infinite render
// loop. Same discipline as services/telemetry.

export interface RecState { lighting: boolean; tracking: boolean }

let rec: RecState = { lighting: false, tracking: false };
const subs = new Set<() => void>();

const emit = (): void => {
  subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[take-recorder] sub error', e); } });
};

// Fan the two recorders' start/stop notifications into one. Both notify on start/stop ONLY (elapsed is
// polled), so this wakes subscribers twice per take and never per frame.
const refresh = (): void => {
  const lighting = lightingRecorder.isRecording();
  const tracking = trackingRecorder.isRecording();
  if (rec.lighting === lighting && rec.tracking === tracking) return;
  rec = { lighting, tracking };
  emit();
};
lightingRecorder.subscribe(refresh);
trackingRecorder.subscribe(refresh);

export function getRec(): RecState { return rec; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
export function elapsed(kind: 'lighting' | 'tracking'): number {
  return kind === 'lighting' ? lightingRecorder.getElapsed() : trackingRecorder.getElapsed();
}
export function isRecording(): boolean { return rec.lighting || rec.tracking; }
/** Where a take stopped RIGHT NOW would land. Display only. */
export function destination(): string { return host?.destinationName() ?? 'Global'; }

// ── Lighting takes ───────────────────────────────────────────────────────────────────────────────

export function startLighting(): boolean {
  if (!host) return false;
  const ids = host.selectedFixtureIds();
  if (!ids.length) {
    host.notify('error', 'Nothing to record', 'Select the light fixtures first — their selection order becomes the take.');
    return false;
  }
  if (!lightingRecorder.start(ids)) {
    // start() also refuses while a lighting clip is driving the rig, which would record a copy of a
    // copy. Naming that here is the difference between "the button did nothing" and a fixable state.
    host.notify('error', 'Cannot record now', 'A lighting clip is driving these fixtures. Stop the transport, or move the playhead off the clip.');
    return false;
  }
  return true;
}

export function stopLighting(): void {
  if (!host) return;
  const tl = host.timeline();
  const take = lightingRecorder.stop(nextNumberedName('Move', tl.lightingTakes ?? []));
  // stop() returns null when NO role moved past its reduction tolerance. That is not an error — it is
  // an empty take, and committing one would put a chip in the library that drives nothing.
  // stop() also returns null when the selection held no LIGHT fixtures at all — a pixel strip has no
  // resolved role signal to capture — so name that case rather than only the "you held still" one.
  if (!take) { host.notify('warn', 'Nothing moved', 'No take was recorded — none of the selected lights changed. (An LED fixture has no movement to capture; a take records moving heads.)'); return; }
  host.commit({ ...tl, lightingTakes: [...(tl.lightingTakes ?? []), take] });
}

export function toggleLighting(): void {
  if (lightingRecorder.isRecording()) stopLighting(); else startLighting();
}

/** Abandon a lighting capture without producing anything. */
export function cancelLighting(): void { lightingRecorder.cancel(); }

export function removeLightingTake(id: string): void {
  if (!host) return;
  const tl = host.timeline();
  host.commit({
    ...tl,
    lightingTakes: (tl.lightingTakes ?? []).filter((t) => t.id !== id),
    // A clip pointing at a deleted take would silently drive nothing; drop it back to a generated
    // movement so the clip stays meaningful instead of becoming an invisible no-op.
    clips: tl.clips.map((c) => (c.kind === 'lighting' && c.lighting?.takeId === id
      ? { ...c, lighting: { ...c.lighting, takeId: undefined, effect: c.lighting.effect ?? { form: 'sine' as const, role: 'pan' as const, centre: 270, amplitude: 60, periodSec: 4 } } }
      : c)),
  });
}

export function renameLightingTake(id: string, name: string): void {
  if (!host) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const tl = host.timeline();
  host.commit({ ...tl, lightingTakes: (tl.lightingTakes ?? []).map((t) => (t.id === id ? { ...t, name: trimmed } : t)) });
}

export function addLightingLane(): void {
  if (!host) return;
  const tl = host.timeline();
  if (tl.layers.some((l) => l.kind === 'lighting')) return;
  host.commit({ ...tl, layers: [...tl.layers, { id: crypto.randomUUID(), name: 'Lighting', kind: 'lighting', color: '#f5a623', enabled: true }] });
}

// ── Tracking takes ───────────────────────────────────────────────────────────────────────────────

export function startTracking(): boolean {
  if (!host) return false;
  if (!trackingRecorder.start()) {
    host.notify('error', 'Cannot record now', 'A tracking take is already playing under the playhead — its blobs would be recorded back into a new take.');
    return false;
  }
  return true;
}

/**
 * Stop, write the .lblob, copy it into the project, and commit the ref.
 *
 * ⚠ THE COMMIT RUNS AFTER TWO AWAITS — a disk write and an asset import — and the world moves under it.
 * A take recorded against Global, or against scene A, would otherwise land its `trackingTakes` entry AND
 * a synthesized 'tracking' layer in whatever document an FSM / scheduler / OSC recall bound while the
 * file was being written. So: capture the doc key BEFORE the awaits and drop the commit if it moved.
 * The take file itself stays on disk (an orphan file is harmless; a document that lies is not), and the
 * putCache is INSIDE the guard because it would otherwise keep a whole take's samples alive under a path
 * no document can reach.
 */
export async function stopTracking(): Promise<void> {
  if (!host) return;
  const tk = trackingRecorder.stop();
  // null means the tracker never sent a single frame — almost always "nothing is connected", which is
  // the most likely way an operator meets this. The mirror of the lighting recorder's "nothing moved":
  // a recorder you can arm from a keyboard shortcut must never just shrug.
  if (!tk) {
    host.notify('warn', 'Nothing was captured', 'No blobs arrived while recording — check the tracker is connected and sending.');
    return;
  }
  // Named off the doc as it stands BEFORE the awaits — the same doc `recDocKey` pins below, so the name
  // and the commit guard agree on which document this take belongs to. (Numbered from what is TAKEN,
  // not from the count: takes are the most-deleted list in the app — you record five and keep one.)
  tk.name = nextNumberedName('Take', host.timeline().trackingTakes ?? []);
  const recDocKey = host.docKey();
  let path = await window.artlux?.saveTrackingTake?.(tk.id, trackingTake.serialize(tk));
  if (!path) { host.notify('error', 'Take not saved', 'The recorded blob file could not be written to disk.'); return; }
  // Copy-in policy: relocate the take into the project's assets/tracking when we have a folder.
  const projectPath = host.projectPath();
  if (projectPath) {
    const entry = await window.artlux?.importAssetFile?.(projectPath, path, 'take', tk.name);
    if (entry?.path) path = entry.path;
  }
  if (host.docKey() !== recDocKey) return;   // recalled mid-write → the take is not this document's
  trackingTake.putCache(path, tk);           // so replay/sparkline don't re-read disk
  const tl = host.timeline();
  host.commit({
    ...tl,
    trackingTakes: [...(tl.trackingTakes ?? []), { id: tk.id, name: tk.name, path, duration: tk.duration, fps: tk.fps }],
    // The lane is created in the SAME commit so it is one undo entry, and from the freshly-read `tl`
    // rather than a boolean captured before the awaits.
    layers: tl.layers.some((l) => l.kind === 'tracking')
      ? tl.layers
      : [...tl.layers, { id: crypto.randomUUID(), name: 'Tracking', kind: 'tracking' as const, color: '#7ed321', enabled: true }],
  });
}

export function toggleTracking(): void {
  if (trackingRecorder.isRecording()) void stopTracking(); else startTracking();
}

/** Abandon a tracking capture without producing anything (and without touching the disk). */
export function cancelTracking(): void { trackingRecorder.cancel(); }

export function removeTrackingTake(id: string): void {
  if (!host) return;
  const tl = host.timeline();
  host.commit({ ...tl, trackingTakes: (tl.trackingTakes ?? []).filter((t) => t.id !== id) });
}

export function renameTrackingTake(id: string, name: string): void {
  if (!host) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const tl = host.timeline();
  host.commit({ ...tl, trackingTakes: (tl.trackingTakes ?? []).map((t) => (t.id === id ? { ...t, name: trimmed } : t)) });
}

export function addTrackingLane(): void {
  if (!host) return;
  const tl = host.timeline();
  if (tl.layers.some((l) => l.kind === 'tracking')) return;
  host.commit({ ...tl, layers: [...tl.layers, { id: crypto.randomUUID(), name: 'Tracking', kind: 'tracking', color: '#7ed321', enabled: true }] });
}

// ── Both ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the status chip's button calls. Once a recording can be STARTED from a keyboard shortcut in a
 * context that has no timeline drawer, a light you cannot switch off is a trap.
 */
export function stopAll(): void {
  if (lightingRecorder.isRecording()) stopLighting();
  if (trackingRecorder.isRecording()) void stopTracking();
}

// ── Action-bar descriptors ───────────────────────────────────────────────────────────────────────
// Exported ready-made so `contexts/index.tsx` stays a manifest of ids and labels rather than growing a
// subscription. The `get()` objects are cached for the Object.is reason at the top of this file.

const LIGHT_ON = { active: true, label: 'Stop Recording', enabled: true };
const LIGHT_OFF = { active: false, label: 'Record Lighting Take' };
const TRACK_ON = { active: true, label: 'Stop Recording', enabled: true };
const TRACK_OFF = { active: false, label: 'Record Tracking Take' };

const fmt = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export const lightingActionLive: ContextActionLive = {
  subscribe,
  // `enabled: true` while armed is the whole point: the action's own `enabled` asks for a fixture
  // selection, and deselecting mid-take would otherwise disable the only stop button while capture ran on.
  get: () => (rec.lighting ? LIGHT_ON : LIGHT_OFF),
  text: () => (rec.lighting ? fmt(lightingRecorder.getElapsed()) : ''),
};

export const trackingActionLive: ContextActionLive = {
  subscribe,
  get: () => (rec.tracking ? TRACK_ON : TRACK_OFF),
  text: () => (rec.tracking ? fmt(trackingRecorder.getElapsed()) : ''),
};
