import type { ChannelRole, LightingCurve, LightingTake, LightingTakePart } from '../types';
import * as fixtureSignal from './fixtureSignal';
import * as lightingOverlay from './lightingOverlay';
import { reduceCurve, reductionEpsilon } from './lightingTake';

// Recording a light show: capture what the operator is doing to the selected fixtures, live, and
// turn it into a reusable take.
//
// Modelled on the LiDAR take recorder (plugins/lidar-tracking/trackingRecorder), and for the same
// reason: you busk a look while watching the rig, and only afterwards decide where it belongs on the
// timeline. So capture is INDEPENDENT OF THE TRANSPORT — the playhead can be stopped, and usually is.
//
// It records the RESOLVED fixture signal (the packer's own output), not the raw channel values, so a
// take comes out in the same role space it will be replayed in: pan/tilt in degrees, everything else
// 0..1. That is what lets the recording be assigned to other fixtures later — see docs/LIGHTING-SHOW.md.

/** Roles worth recording. Deliberately narrow: a take is movement and look, not maintenance. */
const CAPTURED: readonly ChannelRole[] = ['pan', 'tilt', 'dimmer', 'red', 'green', 'blue', 'white', 'zoom'];

interface Track {
  fixtureId: string;
  /** role → the raw per-frame samples, reduced only at stop. */
  curves: Map<ChannelRole, { t: number[]; v: number[] }>;
}

let tracks: Track[] | null = null;
let startMs = 0;
let unsub: (() => void) | null = null;
const subs = new Set<() => void>();

const notify = (): void => {
  subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[lighting-recorder] sub error', e); } });
};

export function isRecording(): boolean { return tracks != null; }
export function getElapsed(): number { return tracks ? (performance.now() - startMs) / 1000 : 0; }
export function trackCount(): number { return tracks?.length ?? 0; }

/** UI re-renders its REC indicator off this (start/stop only; elapsed is polled by a timer). */
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/**
 * Begin capturing the given fixtures, in the order given — THAT ORDER BECOMES THE TAKE'S PARTS, and
 * therefore the order a phase spread will run along when it is replayed. Selection order is the show.
 *
 * Returns false if it could not start.
 */
export function start(fixtureIds: string[]): boolean {
  if (tracks) return false;
  if (!fixtureIds.length) return false;
  // A lighting clip currently driving the rig would be recorded back into a new take, and placing
  // that take would then play a copy of a copy. Same guard trackingRecorder uses against recording
  // its own replay.
  if (lightingOverlay.isActive()) return false;

  tracks = fixtureIds.map((fixtureId) => ({ fixtureId, curves: new Map() }));
  startMs = performance.now();

  unsub = fixtureSignal.subscribe((states) => {
    if (!tracks) return;
    const t = (performance.now() - startMs) / 1000;
    for (const track of tracks) {
      const st = states.get(track.fixtureId);
      if (!st) continue;
      for (const role of CAPTURED) {
        const value = roleValue(st, role);
        if (value === undefined) continue;
        let curve = track.curves.get(role);
        if (!curve) { curve = { t: [], v: [] }; track.curves.set(role, curve); }
        curve.t.push(t);
        curve.v.push(value);
      }
    }
  });

  notify();
  return true;
}

function roleValue(st: fixtureSignal.FixtureState, role: ChannelRole): number | undefined {
  switch (role) {
    case 'pan': return st.pan;
    case 'tilt': return st.tilt;
    case 'dimmer': return st.intensity;
    case 'red': return st.r;
    case 'green': return st.g;
    case 'blue': return st.b;
    case 'zoom': return st.zoomDeg;
    default: return undefined;
  }
}

/**
 * Stop and build the take. Returns null if nothing usable was captured.
 *
 * TWO THINGS HAPPEN HERE, and both matter more than they look.
 *
 * 1. EVERY CURVE IS REDUCED. A three-minute capture at 60 fps is ~11,000 samples per role per
 *    fixture, almost all of them on a straight line between their neighbours.
 *
 * 2. A ROLE THAT NEVER MOVED IS DROPPED. This is the important one. Playback only writes the roles a
 *    take carries, so a take that recorded a static dimmer would PIN that dimmer wherever it happened
 *    to be — and a movement-only clip would then silently fight a colour clip layered under it. A
 *    pan-only busk must produce a pan-only take, so that clips compose the way a console's effects do.
 */
export function stop(name: string): LightingTake | null {
  const captured = tracks;
  tracks = null;
  unsub?.();
  unsub = null;
  notify();
  if (!captured) return null;

  const duration = Math.max(0, (performance.now() - startMs) / 1000);
  const parts: LightingTakePart[] = [];

  for (const track of captured) {
    const channels: Partial<Record<ChannelRole, LightingCurve>> = {};
    for (const [role, raw] of track.curves) {
      if (raw.t.length < 2) continue;
      const epsilon = reductionEpsilon(role);
      // "Never moved" is measured against the SAME tolerance the reduction uses, so the two agree:
      // anything the reducer would flatten to a straight line is not a movement.
      const min = Math.min(...raw.v), max = Math.max(...raw.v);
      if (max - min <= epsilon) continue;
      channels[role] = reduceCurve(raw, epsilon);
    }
    parts.push({ channels });
  }

  // A take where nothing moved on any fixture is not a take.
  if (!parts.some((p) => Object.keys(p.channels).length)) return null;

  return { version: 1, id: crypto.randomUUID(), name, duration, parts };
}

/** Abandon a capture without producing anything. */
export function cancel(): void {
  tracks = null;
  unsub?.();
  unsub = null;
  notify();
}
