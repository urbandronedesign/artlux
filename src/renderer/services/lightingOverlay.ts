import type { ChannelRole } from '../types';

// The live LIGHTING-CLIP layer: what the timeline's lighting clips are currently asking each fixture
// to do, in ROLE space.
//
// The twin of automationOverlay, and deliberately a separate one. automationOverlay addresses
// parameters by dot-path and lays them over the StateView; a lighting clip addresses a whole GROUP
// by role, and writing it as thousands of string paths per frame — forty fixtures × twenty roles,
// rebuilt every frame — would be pure garbage generation on the hot path. So this is a plain nested
// map, keyed by fixture id and role, rewritten wholesale each frame.
//
// ROLE SPACE, NOT CHANNEL SPACE. Values are in the role's own unit (degrees for pan/tilt, 0..1
// otherwise) exactly as a take stores them. The packer converts to a channel value using the target
// fixture's OWN profile — which is what lets one clip drive a mixed rig, and what makes replaying a
// take on a different head land at the same angle rather than the same fraction.
//
// ── PRECEDENCE ───────────────────────────────────────────────────────────────────────────────
//   profile default  <  authored Fixture.dmx  <  LIGHTING CLIP  <  automation lane  <  live override
//
// A clip ranks BELOW a hand-drawn automation lane on purpose. It matches the rule the rest of the
// app already follows ("a lane always wins"), so there is one precedence story across audio,
// surfaces and fixtures rather than two that have to be remembered separately. The packer enforces
// it by asking automationOverlay whether it owns a path before consulting this layer.

type RoleValues = Map<ChannelRole, number>;

let current = new Map<string, RoleValues>();
/** Rebuilt each frame, then swapped in — so readers never observe a half-written frame. */
let building = new Map<string, RoleValues>();
let active = false;

/** Start a frame. Reuses the previous frame's maps to avoid per-frame allocation. */
export function begin(): void {
  const swap = building;
  building = current;
  current = swap;
  for (const roles of building.values()) roles.clear();
}

/**
 * Contribute one fixture's role value.
 *
 * INTENSITY-LIKE ROLES MERGE HTP (highest takes precedence), everything else LTP (latest wins).
 * That is the console convention, and it is the one that makes overlapping looks behave: two clips
 * both raising a dimmer should not fight, but two clips aiming a head must not average into a
 * position neither asked for — the later one simply wins.
 */
export function set(fixtureId: string, role: ChannelRole, value: number): void {
  let roles = building.get(fixtureId);
  if (!roles) { roles = new Map(); building.set(fixtureId, roles); }
  if (HTP_ROLES.has(role)) {
    const prev = roles.get(role);
    if (prev !== undefined && prev >= value) return;
  }
  roles.set(role, value);
  active = true;
}

const HTP_ROLES: ReadonlySet<ChannelRole> = new Set<ChannelRole>([
  'dimmer', 'red', 'green', 'blue', 'white', 'warmWhite', 'coldWhite',
  'amber', 'uv', 'lime', 'indigo', 'cyan', 'magenta', 'yellow',
]);

/** Finish a frame: what was built becomes what is read. */
export function commit(): void {
  const swap = current;
  current = building;
  building = swap;
  active = false;
  for (const roles of current.values()) if (roles.size) { active = true; break; }
}

/** The value a lighting clip is asking of this fixture's role, if any. */
export function get(fixtureId: string, role: ChannelRole): number | undefined {
  return current.get(fixtureId)?.get(role);
}

/** True when any clip is driving anything — lets the packer skip the lookup entirely. */
export function isActive(): boolean { return active; }

/** Drop everything (project load, transport stop). */
export function clear(): void {
  current.clear();
  building.clear();
  active = false;
}
