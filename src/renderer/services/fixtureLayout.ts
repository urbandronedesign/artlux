import type { Fixture, Vec3, Euler3 } from '../types';
import { effectivePosObj, effectiveRotObj } from './led3dDefaults';
import { rotateAbout, turnBy } from './rotate3';

// Laying out a SELECTION of fixtures in 3D — align, distribute, spread on a line or arc, and fan.
//
// This is how a rig is actually built. Nobody places twelve heads on a truss by dragging each one to
// a hand-typed coordinate; they drop twelve, select them, and say "in a row, evenly, aimed outward".
// Without it the multi-fixture gizmo only moves a clump around — useful, but still not rig-building.
//
// Every function here is PURE: selection in, `{id, position3D, rotation3D}` out, with no opinion
// about history or state. The caller commits the whole array as ONE change, so any of these is a
// single undo step.
//
// ORDER IS THE OPERATOR'S. The array is used exactly as given — that is the selection order, and on
// a lighting console the selection order is what a spread runs along. Sorting it here would quietly
// re-shuffle a deliberately built order.

export type Axis = 'x' | 'y' | 'z';
export interface LayoutUpdate { id: string; position3D?: Vec3; rotation3D?: Euler3 }

const pos = (f: Fixture): Vec3 => effectivePosObj(f);
const rot = (f: Fixture): Euler3 => effectiveRotObj(f);

/** Put every fixture on the same coordinate along one axis — the mean of the selection. */
export function align(fixtures: Fixture[], axis: Axis): LayoutUpdate[] {
  if (fixtures.length < 2) return [];
  const mean = fixtures.reduce((n, f) => n + pos(f)[axis], 0) / fixtures.length;
  return fixtures.map((f) => ({ id: f.id, position3D: { ...pos(f), [axis]: mean } }));
}

/**
 * Even out the spacing along one axis, keeping the two extremes where they are.
 *
 * Distribute sorts by POSITION, not by selection order — "even out what I see" is a spatial
 * statement, and using selection order here would teleport fixtures past each other.
 */
export function distribute(fixtures: Fixture[], axis: Axis): LayoutUpdate[] {
  if (fixtures.length < 3) return [];   // two fixtures are already evenly spaced
  const sorted = [...fixtures].sort((a, b) => pos(a)[axis] - pos(b)[axis]);
  const first = pos(sorted[0])[axis];
  const last = pos(sorted[sorted.length - 1])[axis];
  const step = (last - first) / (sorted.length - 1);
  return sorted.map((f, i) => ({ id: f.id, position3D: { ...pos(f), [axis]: first + step * i } }));
}

/**
 * Lay the selection out on a straight line, in SELECTION ORDER, centred on its own centroid.
 * `spacing` is in metres between neighbours.
 */
export function line(fixtures: Fixture[], axis: Axis, spacing: number): LayoutUpdate[] {
  if (fixtures.length < 2) return [];
  const n = fixtures.length;
  const c = centroid(fixtures);
  const start = -((n - 1) * spacing) / 2;
  return fixtures.map((f, i) => ({
    id: f.id,
    position3D: { ...c, [axis]: c[axis] + start + i * spacing },
  }));
}

/**
 * Lay the selection out on an arc of `radius` metres sweeping `sweepDeg`, centred on the centroid
 * and lying in the horizontal (XZ) plane — the shape of a truss curve or a semicircle of heads.
 *
 * `aimOutward` also turns each fixture to face along its own radius, which is almost always what is
 * wanted and is tedious to do by hand.
 */
export function arc(fixtures: Fixture[], radius: number, sweepDeg: number, aimOutward: boolean): LayoutUpdate[] {
  if (fixtures.length < 2) return [];
  const n = fixtures.length;
  const c = centroid(fixtures);
  const sweep = (sweepDeg * Math.PI) / 180;
  const start = -sweep / 2;
  const stepAngle = n > 1 ? sweep / (n - 1) : 0;
  return fixtures.map((f, i) => {
    const a = start + stepAngle * i;
    const p = { x: c.x + Math.sin(a) * radius, y: c.y, z: c.z + Math.cos(a) * radius };
    const update: LayoutUpdate = { id: f.id, position3D: p };
    if (aimOutward) update.rotation3D = { ...rot(f), yaw: (a * 180) / Math.PI };
    return update;
  });
}

/**
 * FAN — spread one rotation axis linearly across the selection, from `-amountDeg/2` to `+amountDeg/2`
 * in selection order, about the middle of the selection's current values on that axis.
 *
 * This is the console gesture: select a row, fan tilt, and the beams open into a wedge. It is the
 * rotational twin of `line`, and it is why selection order is preserved everywhere in this module.
 */
export function fan(fixtures: Fixture[], axis: keyof Euler3, amountDeg: number): LayoutUpdate[] {
  if (fixtures.length < 2) return [];
  const n = fixtures.length;
  const base = fixtures.reduce((sum, f) => sum + rot(f)[axis], 0) / n;
  const start = -amountDeg / 2;
  const step = amountDeg / (n - 1);
  return fixtures.map((f, i) => ({
    id: f.id,
    rotation3D: { ...rot(f), [axis]: base + start + step * i },
  }));
}

/**
 * MOVE THE WHOLE SELECTION by an exact offset, in metres, on the world axes.
 *
 * The typed twin of dragging the gizmo, and the reason it is worth having: a drag can be snapped to a
 * grid but it cannot be told "250 mm, that way, from wherever this happens to be now". Shape is
 * preserved exactly — every fixture takes the same vector, so a row stays a row.
 */
export function offset(fixtures: Fixture[], d: Vec3): LayoutUpdate[] {
  if (!fixtures.length) return [];
  if (!d.x && !d.y && !d.z) return [];
  return fixtures.map((f) => {
    const p = pos(f);
    return { id: f.id, position3D: { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z } };
  });
}

/**
 * TURN THE WHOLE SELECTION about its own centre, on a world axis — positions orbit AND each fixture
 * turns with them, which is what makes a row of heads swing round without also scrambling their aim
 * relative to each other. Exactly the gizmo's rotate, driven by a typed angle.
 *
 * The orientation half goes through `turnBy` rather than adding degrees to yaw/pitch/roll: that shortcut
 * is exact only for a fixture whose other two angles are zero, and quietly wrong for every head already
 * tilted on a truss. See services/rotate3.ts.
 */
export function orbit(fixtures: Fixture[], axis: Axis, angleDeg: number): LayoutUpdate[] {
  if (fixtures.length < 1 || !angleDeg) return [];
  const c = centroid(fixtures);
  return fixtures.map((f) => ({
    id: f.id,
    position3D: rotateAbout(pos(f), c, axis, angleDeg),
    rotation3D: turnBy(rot(f), axis, angleDeg),
  }));
}

/** The mean position of a selection — the anchor every layout here is built around. */
export function centroid(fixtures: Fixture[]): Vec3 {
  const c = { x: 0, y: 0, z: 0 };
  if (!fixtures.length) return c;
  for (const f of fixtures) { const p = pos(f); c.x += p.x; c.y += p.y; c.z += p.z; }
  return { x: c.x / fixtures.length, y: c.y / fixtures.length, z: c.z / fixtures.length };
}
