import type {
  ChannelRole, Fixture, FixtureGroup, LightingKey, LightingPose, LightingSequence, VideoClip, VideoLayer,
} from '../types';
import type { FixtureState } from './fixtureSignal';
import { isLight } from './fixtureKind';

// STORE KEY — the verb that closes the authoring loop.
//
//   select a light → place it in 3D → position it → change its parameters → STORE THE KEY
//
// Everything before the last step is the fixture/3D work. This is the last step, and it is one
// question: what does the group look like RIGHT NOW, and where on the timeline does that go?
//
// Pure on purpose: it decides, and the caller mutates. That makes the three-case table below
// checkable without a timeline, a rig, or a running transport.

/** Roles a key stores. The same narrow set the recorder captures — a look, not maintenance. */
export const STORABLE: readonly ChannelRole[] = ['pan', 'tilt', 'dimmer', 'red', 'green', 'blue', 'white', 'zoom'];

export interface StoreKeyInput {
  playhead: number;
  /** Every clip on the timeline (lighting ones are picked out here). */
  clips: VideoClip[];
  layers: VideoLayer[];
  groups: FixtureGroup[];
  fixtures: Fixture[];
  /** Live resolved role values — fixtureSignal.snapshot(). */
  states: ReadonlyMap<string, FixtureState>;
  /** The operator's current fixture selection, IN SELECTION ORDER. */
  selectedFixtureIds: string[];
  /** A group selected outright, if any — it wins over a raw fixture selection. */
  selectedGroupId?: string;
  /** Store every role the profile resolves, not just the moved ones. */
  allRoles?: boolean;
}

export type StoreKeyPlan =
  | { kind: 'refused'; reason: string; detail?: string }
  /** Write into an existing sequence on an existing clip. `replaceAt` = an existing key's time. */
  | { kind: 'write'; clipId: string; sequenceId: string; key: LightingKey; replaceAt?: number; warning?: string }
  /** Nothing to write into yet: make the lane and/or clip and/or sequence first. */
  | {
      kind: 'create';
      /** Absent ⇒ create a lighting lane too. */
      layerId?: string;
      groupId: string;
      /** A group that must be created first (from the selection, in selection order). */
      newGroup?: FixtureGroup;
      clipStart: number;
      sequence: LightingSequence;
      warning?: string;
    };

/** Two keys within this many seconds are the same moment — a click cannot mean two of them. */
const SAME_KEY_EPS = 1 / 30;

function roleValue(st: FixtureState, role: ChannelRole): number | undefined {
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
 * What the group looks like now, as one pose per slot — COLLAPSED TO ONE when every fixture agrees.
 *
 * The collapse is where the encoding efficiency actually shows up: a forty-head unison look is one
 * entry, not forty, and it stays assignable to a group of a different size because one slot means
 * "the whole group".
 */
export function poseForGroup(
  members: Fixture[],
  states: ReadonlyMap<string, FixtureState>,
  roles: readonly ChannelRole[] = STORABLE,
): LightingPose[] {
  const slots: LightingPose[] = members.map((f) => {
    const st = states.get(f.id);
    const pose: LightingPose = {};
    if (!st) return pose;
    for (const role of roles) {
      const v = roleValue(st, role);
      if (v !== undefined && Number.isFinite(v)) pose[role] = v;
    }
    return pose;
  });
  if (slots.length <= 1) return slots;
  const first = JSON.stringify(slots[0]);
  return slots.every((p) => JSON.stringify(p) === first) ? [slots[0]] : slots;
}

/**
 * Decide what pressing Store key does.
 *
 * ── THE THREE CASES ────────────────────────────────────────────────────────────────────────
 *   a lighting clip under the playhead  → write the key into its sequence (replacing a coincident one)
 *   a lighting lane but no clip there   → create the clip + a sequence, write key 0
 *   no lighting lane at all             → create the lane too, then as above
 *
 * It NEVER silently does nothing. "I pressed it and nothing happened" is the failure this table
 * exists to prevent, and creating a lane is cheap and undoable — hunting for why a keypress was
 * ignored is not.
 *
 * The ONE refusal left is having no lights to store: a key for nobody is meaningless, and inventing
 * a target would be worse than declining.
 */
export function planStoreKey(input: StoreKeyInput): StoreKeyPlan {
  const {
    playhead, clips, layers, groups, fixtures, states,
    selectedFixtureIds, selectedGroupId, allRoles,
  } = input;

  const byId = new Map(fixtures.map((f) => [f.id, f]));

  // ── WHICH GROUP? ───────────────────────────────────────────────────────────────────────────
  // Follows the recorder's own convention: THEIR SELECTION ORDER BECOMES THE SHOW, because order is
  // the axis a phase spread runs along. Nothing here sorts.
  let group = selectedGroupId ? groups.find((g) => g.id === selectedGroupId) : undefined;
  let newGroup: FixtureGroup | undefined;

  if (!group) {
    const lights = selectedFixtureIds.map((id) => byId.get(id)).filter((f): f is Fixture => !!f && isLight(f));
    if (!lights.length) {
      return {
        kind: 'refused',
        reason: 'Select the lights first',
        detail: 'Store key records what a GROUP of light fixtures is doing. Select some in the 3D scene (or pick a group), then press it again.',
      };
    }
    // An existing group with exactly this membership IN THIS ORDER is reused rather than duplicated —
    // otherwise a second Store key on the same selection would mint "Group 2", "Group 3"…
    const key = lights.map((f) => f.id).join(',');
    group = groups.find((g) => g.fixtureIds.join(',') === key);
    if (!group) {
      newGroup = { id: crypto.randomUUID(), name: 'Lights', fixtureIds: lights.map((f) => f.id) };
      group = newGroup;
    }
  }

  const members = group.fixtureIds.map((id) => byId.get(id)).filter((f): f is Fixture => !!f);
  const lightMembers = members.filter(isLight);
  if (!lightMembers.length) {
    return {
      kind: 'refused',
      reason: 'That group holds no light fixtures',
      detail: 'A pose is authored in role space (pan in degrees, dimmer 0..1), which has nowhere to land on LED tape.',
    };
  }

  const roles = allRoles ? STORABLE : STORABLE;
  const slots = poseForGroup(members, states, roles);
  if (!slots.some((p) => Object.keys(p).length)) {
    return {
      kind: 'refused',
      reason: 'Those lights are not reporting anything yet',
      detail: 'A pose comes from the resolved fixture signal. Give them a profile and set some channels first.',
    };
  }

  // ── PHASE: A WARNING, NOT A BLOCK ──────────────────────────────────────────────────────────
  // With a spread running, fixture i is sampled at `t - phase*i`, so the pose you SEE is one curve
  // read at N different times — it is not what any single key means. Storing it anyway is still the
  // right behaviour (you are usually busking, and phase is normally added AFTER the looks exist);
  // what would be wrong is doing it silently, because playback then applies the spread a second time
  // on top of what you stored.
  const under = clips.filter(
    (c) => c.kind === 'lighting' && c.lighting
      && playhead >= c.start && playhead < c.start + c.duration,
  );
  const target = under.find((c) => c.lighting?.groupId === group!.id) ?? under[0];
  const phased = !!target?.lighting?.phase;
  const warning = phased
    ? 'This clip has a phase spread, so the stored pose is what you see now — the spread is applied again on playback.'
    : undefined;

  const key: LightingKey = { t: 0, slots };

  // CASE 1 — a lighting clip is under the playhead.
  if (target?.lighting) {
    const local = playhead - target.start + (target.inPoint ?? 0);
    key.t = Math.max(0, local);
    const seqId = target.lighting.sequenceId;
    if (seqId) {
      return { kind: 'write', clipId: target.id, sequenceId: seqId, key, warning };
    }
    // The clip plays a take or an effect and has no sequence yet: give it one, starting at this key.
    // The clip is NOT rewritten to drop its old source here — the caller sets sequenceId, and
    // sampleRole prefers the sequence, so the previous source stays as a recoverable fallback.
    return {
      kind: 'create',
      layerId: target.layerId,
      groupId: group.id,
      newGroup,
      clipStart: target.start,
      sequence: { version: 1, id: crypto.randomUUID(), name: 'Sequence', duration: Math.max(key.t, 1), keys: [key] },
      warning,
    };
  }

  // CASE 2/3 — a lighting lane with no clip here, or no lighting lane at all. The clip starts AT the
  // playhead, so the key it carries is key 0 of its own timeline.
  key.t = 0;
  const lane = layers.find((l) => l.kind === 'lighting');
  return {
    kind: 'create',
    layerId: lane?.id,
    groupId: group.id,
    newGroup,
    clipStart: playhead,
    sequence: { version: 1, id: crypto.randomUUID(), name: 'Sequence', duration: 4, keys: [key] },
    warning,
  };
}

/** Insert a key, replacing one at the same moment. Exported so the caller stays a one-liner. */
export function upsertKey(seq: LightingSequence, key: LightingKey): LightingSequence {
  const keys = seq.keys.filter((k) => Math.abs(k.t - key.t) > SAME_KEY_EPS);
  keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  // The sequence must be long enough to contain its own last key, or playback would wrap before
  // reaching it (`wrapIntoTake` folds on `duration`).
  const duration = Math.max(seq.duration, keys[keys.length - 1]?.t ?? 0);
  return { ...seq, keys, duration };
}
