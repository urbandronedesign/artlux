import type { ChannelRole, Keyframe, LightingPose, LightingSequence, NamedPose } from '../types';

// COMPILING POSE KEYS INTO CURVES.
//
// A `LightingSequence` is stored the way an operator thinks — a list of moments, each holding a
// POSE per slot of the group ("at 4 s, everything looks like this"). The engine wants the opposite
// shape: for one fixture and one role, a curve it can sample.
//
// ── WHY THIS IS COMPILED AND NOT FILTERED ────────────────────────────────────────────────────
// The sampling rule is "the nearest keys before and after that CARRY this role". Evaluated live
// that is a scan over every key, per fixture, per role, per frame — allocation and search on the
// exact hot path lightingOverlay exists to keep clean (it is a plain nested map for precisely this
// reason). So the rule is applied ONCE, on edit and on load, and the frame loop only ever calls
// `sampleLane` on a plain `Keyframe[]` that is already correct.
//
// The cache is a WeakMap on the sequence OBJECT. Every edit path in this app produces a new object
// (state is immutable), so a changed sequence misses the cache and recompiles by construction —
// there is no revision counter to forget to bump, and a dropped sequence is collected with its
// compilation.

/** Per-slot, per-role curves. `slots[i].get(role)` is what a fixture at group index i samples. */
export interface CompiledSequence {
  duration: number;
  /** Length = the widest key's slot count; a fixture at index i uses `slots[i % slots.length]`. */
  slots: Array<Map<ChannelRole, Keyframe[]>>;
  /** Every role the sequence drives at all — what `rolesOf` needs, without walking the keys again. */
  roles: ChannelRole[];
}

// The compilation is cached against the sequence AND the pose library it resolved `poseRef`s from —
// editing a library pose must not leave a key that references it frozen on the old look. Both are
// immutable state, so identity comparison is the whole check.
const cache = new WeakMap<LightingSequence, { out: CompiledSequence; poses?: readonly NamedPose[] }>();

export function compile(seq: LightingSequence, poses?: readonly NamedPose[]): CompiledSequence {
  const hit = cache.get(seq);
  if (hit && hit.poses === poses) return hit.out;

  // A key may REFERENCE a library pose instead of inlining its slots. Inline wins where both exist,
  // and an unresolved ref contributes NOTHING — never a fallback to a plausible other look, the same
  // rule fixtureFootprint follows by returning 0 for an unresolved profile.
  const slotsOf = (k: LightingSequence['keys'][number]): LightingPose[] => {
    if (k.slots.length) return k.slots;
    if (!k.poseRef) return [];
    return poses?.find((p) => p.id === k.poseRef)?.slots ?? [];
  };

  // Keys are sorted by the normalizer; sorting again here would hide a violation rather than fix it.
  const keys = seq.keys;
  // The widest key decides the slot count. Compiling to that width and wrapping each key's OWN array
  // gives exactly the same answer as wrapping per key at sample time — a 1-slot key contributes its
  // single pose to every compiled slot, which is what "one slot ⇒ the whole group" means.
  const width = keys.reduce((n, k) => Math.max(n, slotsOf(k).length), 0);
  const slots: Array<Map<ChannelRole, Keyframe[]>> = [];
  const roles = new Set<ChannelRole>();

  for (let s = 0; s < width; s++) {
    const byRole = new Map<ChannelRole, Keyframe[]>();
    for (const key of keys) {
      const keySlots = slotsOf(key);
      if (!keySlots.length) continue;
      const pose = keySlots[s % keySlots.length];
      if (!pose) continue;
      for (const [role, value] of Object.entries(pose) as Array<[ChannelRole, number]>) {
        if (!Number.isFinite(value)) continue;
        let arr = byRole.get(role);
        if (!arr) { arr = []; byRole.set(role, arr); }
        // A key that does not mention a role simply contributes nothing to that role's curve — which
        // IS the sparse rule: the previous and next keys that DO mention it become adjacent, so the
        // value interpolates across the keys in between rather than being reset by them.
        arr.push({
          t: key.t,
          v: value,
          curve: key.roleCurves?.[role] ?? key.curve ?? 'linear',
          cx1: key.cx1, cy1: key.cy1, cx2: key.cx2, cy2: key.cy2,
        });
        roles.add(role);
      }
    }
    slots.push(byRole);
  }

  const out: CompiledSequence = { duration: seq.duration, slots, roles: [...roles] };
  cache.set(seq, { out, poses });
  return out;
}

/** The curve a fixture at group index `i` samples for one role, or undefined if it is not driven. */
export function curveFor(c: CompiledSequence, index: number, role: ChannelRole): Keyframe[] | undefined {
  if (!c.slots.length) return undefined;
  return c.slots[index % c.slots.length].get(role);
}
