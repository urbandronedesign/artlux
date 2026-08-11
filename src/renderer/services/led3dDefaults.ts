import { Fixture, Layout3D, defaultLayout3D } from '../types';

// Three-free effective 3D values (used by non-lazy UI like the Inspector so that
// three.js stays out of the main bundle — only the lazy Simulator3D pulls three).
// When a fixture lacks explicit 3D data these are derived from its 2D layout.

export const STAGE_W = 4;
export const STAGE_H = 2.25;

export function effectiveLayout(f: Fixture): Layout3D {
  if (f.layout3D) return f.layout3D;
  const base = defaultLayout3D();
  base.ledSpacing = (f.width * STAGE_W) / Math.max(1, f.ledCount);
  return base;
}

// The 2D→3D fallback. DELIBERATELY KEPT, and deliberately only a fallback: for a project authored
// before light fixtures left the 2D canvas, the rect IS a true record of where the operator put the
// fixture, so deriving from it is the right answer and needs no migration. What changed is that new
// LIGHT fixtures are created WITH a position (see spawnPosition3D), so nothing important is derived
// from a rectangle nobody will ever see.
export function effectivePosObj(f: Fixture): { x: number; y: number; z: number } {
  if (f.position3D) return { ...f.position3D };
  return {
    x: (f.x + f.width / 2 - 0.5) * STAGE_W,
    y: (0.5 - (f.y + f.height / 2)) * STAGE_H,
    z: 0,
  };
}

/** Metres above the stage centre-line that a newly created light hangs at. A head is rigged on a
 *  truss, not stood on the floor, so dropping one at floor level is wrong in the common case. */
export const DEFAULT_TRIM_HEIGHT = STAGE_H / 2 + 0.6;

/**
 * Where the Nth new light goes when the operator has not placed it by hand.
 *
 * `n` is how many lights already exist. The old behaviour was a hardcoded 2D rect that mapped to
 * the world ORIGIN for every fixture, so adding ten heads stacked ten in one spot and the only way
 * to separate them was the 2D canvas or the Arrange panel. A spread row is not a rig — the operator
 * still places them — but it is honest about there being ten of them.
 */
export function spawnPosition3D(n: number): { x: number; y: number; z: number } {
  const PER_ROW = 6, SPACING = 0.8;
  const col = n % PER_ROW;
  const row = Math.floor(n / PER_ROW);
  return {
    x: (col - (PER_ROW - 1) / 2) * SPACING,
    y: DEFAULT_TRIM_HEIGHT,
    z: -row * SPACING,       // extra rows step upstage rather than overlapping
  };
}

export function effectiveRotObj(f: Fixture): { pitch: number; yaw: number; roll: number } {
  return f.rotation3D ? { ...f.rotation3D } : { pitch: 0, yaw: 0, roll: f.rotation || 0 };
}

// THE ONE PLACE THAT DECIDES HOW BIG A FIXTURE IS — same doctrine as fixtureKind and fixtureFootprint.
//
// A fixture carries two scale fields: the legacy uniform `scale3D` that every project on disk has, and
// the per-axis `scaleXYZ` that the gizmo now writes. Per-axis wins when present. Nothing outside this
// function may ask which is set: a call site that reads `f.scale3D` directly silently ignores a
// stretched fixture, and it does so by drawing something plausible — a bar at the wrong length is not
// an error anyone notices until they measure the rig.
//
// The axes are the FIXTURE's own, applied before its rotation: X runs along the LED line (and the
// matrix columns), Y across the rows, Z through the housing. That is what makes "stretch this panel
// wider" mean the same thing whatever angle it hangs at.
export function effectiveScale3(f: Fixture): { x: number; y: number; z: number } {
  const s = f.scaleXYZ;
  if (s) return { x: pos(s[0]), y: pos(s[1]), z: pos(s[2]) };
  const u = f.scale3D && f.scale3D > 0 ? f.scale3D : 1;
  return { x: u, y: u, z: u };
}

/** One number for the few things that genuinely cannot take three (a beam cone, a light's reach).
 *  The mean, so a fixture that has never been stretched reports exactly its old uniform scale. */
export function meanScale(f: Fixture): number {
  const s = effectiveScale3(f);
  return (s.x + s.y + s.z) / 3;
}

/** A scale of 0 collapses a fixture to a point it can never be dragged back out of. */
function pos(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 1;
}
