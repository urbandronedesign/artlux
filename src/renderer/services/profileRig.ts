import type { FixtureProfile } from '../types';

// Per-profile constants the 3D scene needs EVERY FRAME, computed once per profile.
//
// The bodies, the beams and the spotlights each need the same four numbers for every fixture on
// every frame: the pan and tilt mid-points (a head's centre position), the beam half-angle and the
// body height. Deriving them meant `profile.channels.find(...)` twice per fixture per component per
// frame — at 200 movers that is 1,200 linear scans of an 11-element array every frame, in three
// separate files, for values that never change while a project is open.
//
// Cached on the profile object itself, so a reloaded project (new objects) recomputes and a stale
// entry cannot survive.

export interface RigMetrics {
  /** Degrees. The centre of the pan range — a head at this value faces straight ahead. */
  panMid: number;
  /** Degrees. The centre of the tilt range. */
  tiltMid: number;
  /** Degrees. Beam half-angle from the fixture's lens, when it declares one. */
  lensHalf: number;
  /** Metres. Body height, from the profile's physical dimensions. */
  bodyH: number;
  /**
   * Metres. Where the beam actually leaves the fixture, in its local frame.
   *
   * For a GDTF profile this is the real <Beam> geometry node's offset — the manufacturer's own lens
   * position, which on a hanging fixture is BELOW the body, not above it. For a procedural body it
   * is the top of the yoke, matching where MoverBodies pivots the head.
   */
  lens: { x: number; y: number; z: number };
  /** @deprecated kept as the Y component for call sites that only need height. */
  lensY: number;
}

const cache = new WeakMap<FixtureProfile, RigMetrics>();

export function rigMetrics(profile: FixtureProfile): RigMetrics {
  const hit = cache.get(profile);
  if (hit) return hit;

  const mid = (role: 'pan' | 'tilt', fallback: number) => {
    const c = profile.channels.find((ch) => ch.role === role);
    return c?.min !== undefined && c?.max !== undefined ? (c.min + c.max) / 2 : fallback;
  };

  const d = profile.physical?.dimsMm;
  const bodyH = d ? Math.max(0.08, d[1] / 1000) : 0.45;
  const lensMin = profile.physical?.lensDegMin;
  const lensMax = profile.physical?.lensDegMax;

  const proceduralLensY = bodyH * 0.30 * 0.5 + bodyH * 0.40;
  // A GDTF carries the real lens position; prefer it over the procedural guess.
  const beamNode = profile.geometry?.nodes.find((n) => n.kind === 'beam');

  const m: RigMetrics = {
    panMid: mid('pan', 0),
    tiltMid: mid('tilt', 0),
    // A middling spot when the profile carries no optics — so the fixture still reads as a beam
    // rather than a needle or a floodlight.
    lensHalf: lensMin !== undefined && lensMax !== undefined
      ? Math.max(0.5, ((lensMin + lensMax) / 2) / 2)
      : 7,
    bodyH,
    // Must match MoverBodies' head pivot, or the beam leaves from somewhere the head is not.
    lensY: proceduralLensY,
    lens: beamNode?.offset ?? { x: 0, y: proceduralLensY, z: 0 },
  };
  cache.set(profile, m);
  return m;
}

/**
 * How far to lift the whole body so its MOUNTING FACE — not its centre — sits at `position3D`.
 *
 * The base box is drawn centred on the fixture's origin, which is invisible until you mount one:
 * an operator who types Y = 0 for a floor light gets a fixture buried to its waist in the floor, and
 * one who hangs a head at the trim height gets a base sticking up through the truss. Neither is what
 * the number they typed meant. With a mount declared, that number is the FLOOR (or the truss), and
 * this is the half-base-height that makes it so.
 *
 * ONE OWNER, because two consumers need it and they are in different files: the body stacks from it
 * (MoverBodies) and the beam leaves from a lens measured off the same stack (Beams, MoverLights).
 * Returns 0 for an unmounted fixture, so nothing that existed before this moves.
 */
export function mountShift(mount: 'floor' | 'ceiling' | undefined, m: RigMetrics, scaleY = 1): number {
  if (!mount) return 0;
  // The base is 30% of the body height (MoverBodies.dims), so half of it is what clears the surface.
  const halfBase = m.bodyH * 0.30 * 0.5 * scaleY;
  return mount === 'ceiling' ? -halfBase : halfBase;
}

/** Beam half-angle in degrees: a live zoom channel overrides the fixture's fixed lens. */
export function halfAngle(m: RigMetrics, zoomDeg?: number): number {
  return zoomDeg !== undefined && zoomDeg > 0 ? Math.max(0.5, zoomDeg / 2) : m.lensHalf;
}
