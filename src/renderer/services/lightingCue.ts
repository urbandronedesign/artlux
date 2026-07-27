import type {
  ChannelRole, CueTransition, Fixture, FixtureGroup, LightingCueEntry, LightingPose, NamedPose,
} from '../types';
import * as fixtureSignal from './fixtureSignal';

// POSE CUES — firing a stored look at a group, with no timeline involved.
//
// Keyframes are the STORAGE of a light show: scrubbable, seekable, spreadable. What they cannot do
// is fire a named look from OUTSIDE a timeline — from the cue grid, the show-control tablet, an OSC
// GO, or a state's entry action. That is what this is, and it works because both models share one
// atom: a POSE. Cues and keys are two ways to invoke the same stored look.
//
// ── ITS OWN PRECEDENCE LAYER, BETWEEN THE CLIP AND THE LANE ──────────────────────────────────
//
//   profile default < authored dmx < lighting clip < POSE CUE < automation lane < live override
//
// Putting it at the TOP was the first instinct and it is wrong twice. It would break "a lane always
// wins" — the single precedence story this app keeps across audio, surfaces and fixtures — and the
// top layer means something specific: livePreview, the render-free channel a fader drag writes to.
// A cue fired by the scheduler at 3 a.m. with nobody in the building is not a live override.
//
// Between clip and lane is what the console model and this codebase's own rule both say: a fired cue
// beats a clip that happens to be running, an explicitly drawn lane still beats the cue, and your
// hand on a fader beats everything.
//
// RENDER-FREE, like every other overlay here: the fade animates at frame rate by being SAMPLED, not
// by pushing React state.

const EASES: Record<CueTransition, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  damper: (t) => 1 - Math.pow(1 - t, 3),
  none: () => 1,
};

interface Leg {
  fixtureId: string;
  role: ChannelRole;
  from: number;
  to: number;
  startMs: number;
  durMs: number;
  ease: (t: number) => number;
}

let legs: Leg[] = [];
/** Resolved values, rebuilt each frame while anything is running. */
let current = new Map<string, Map<ChannelRole, number>>();
let active = false;

/** True when any pose cue is driving anything — lets the packer skip the lookup entirely. */
export function isActive(): boolean { return active; }

export function get(fixtureId: string, role: ChannelRole): number | undefined {
  return current.get(fixtureId)?.get(role);
}

/** Drop everything (project load, transport stop, an explicit release). */
export function clear(): void {
  legs = [];
  current.clear();
  active = false;
}

/**
 * Fire a pose at a group.
 *
 * The FROM value is the fixture's CURRENT resolved role value, so a cue fades from whatever is
 * actually on stage — including from another cue mid-fade, which is what makes two cues fired in
 * quick succession glide rather than jump.
 *
 * A leg RE-TARGETS: firing a second cue that names the same fixture+role replaces that leg instead
 * of racing it. Same rule transitions.ts learned the hard way, where one fade slot meant an
 * unrelated cue snapped a running 20-second duck to its endpoint mid-sentence.
 */
export function fire(
  entries: readonly LightingCueEntry[],
  poses: readonly NamedPose[],
  groups: readonly FixtureGroup[],
  fixtures: readonly Fixture[],
  nowMs: number,
): void {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const states = fixtureSignal.snapshot();

  for (const entry of entries) {
    const pose = poses.find((p) => p.id === entry.poseId);
    const group = groups.find((g) => g.id === entry.groupId);
    // An unresolved pose or group drives NOTHING. Never a fallback: a cue that cannot be described
    // must go quiet, not fire a different look.
    if (!pose || !group || !pose.slots.length) continue;

    const members = group.fixtureIds.map((id) => byId.get(id)).filter((f): f is Fixture => !!f);
    const durMs = Math.max(0, (entry.fadeSec ?? 0) * 1000);
    const ease = EASES[entry.transition ?? 'linear'] ?? EASES.linear;

    members.forEach((f, i) => {
      // ONE SLOT DRIVES THE WHOLE GROUP — the same index-wraps axis a take's parts and a key's slots
      // use, so a pose authored for four heads applies to eight, and one authored for one applies
      // to forty.
      const slot: LightingPose = pose.slots[i % pose.slots.length];
      const st = states.get(f.id);
      for (const [role, to] of Object.entries(slot) as Array<[ChannelRole, number]>) {
        if (!Number.isFinite(to)) continue;
        const held = get(f.id, role);
        const from = held ?? roleValue(st, role) ?? to;
        legs = legs.filter((l) => !(l.fixtureId === f.id && l.role === role));
        legs.push({ fixtureId: f.id, role, from, to, startMs: nowMs, durMs, ease });
      }
    });
  }
  active = legs.length > 0;
}

function roleValue(st: fixtureSignal.FixtureState | undefined, role: ChannelRole): number | undefined {
  if (!st) return undefined;
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
 * Advance every running fade. Called once per frame by the engine.
 *
 * A COMPLETED LEG IS KEPT, not dropped — it holds its endpoint. That is the difference between a cue
 * and a clip: a clip releases when it ends (lightingPlayback publishes one empty frame for exactly
 * that), but a fired cue is a STATE, and the look must stay on stage until something else changes
 * it. `clear()` is the release.
 */
export function tick(nowMs: number): void {
  if (!legs.length) { active = false; return; }
  const next = current;
  for (const roles of next.values()) roles.clear();

  for (const leg of legs) {
    const t = leg.durMs <= 0 ? 1 : Math.min(1, (nowMs - leg.startMs) / leg.durMs);
    const v = leg.from + (leg.to - leg.from) * leg.ease(t);
    let roles = next.get(leg.fixtureId);
    if (!roles) { roles = new Map(); next.set(leg.fixtureId, roles); }
    roles.set(leg.role, v);
  }
  current = next;
  active = true;
}
