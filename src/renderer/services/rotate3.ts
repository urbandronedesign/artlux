import type { Vec3, Euler3 } from '../types';

// TURNING THINGS ABOUT A WORLD AXIS, WITHOUT three.
//
// Why this exists at all: the Inspector must not pull three into the main bundle (the same reason
// led3dDefaults holds the three-free `effective*` helpers), but "rotate this row of heads 15° about
// its centre" is a rig-building gesture that belongs in a typed field as much as on a gizmo handle.
// Doing it with Euler arithmetic — `yaw += 15` — is exact ONLY for a fixture whose pitch and roll are
// zero, and silently wrong for every head already tilted on a truss. So the composition is done as
// quaternions here, by hand, in about forty lines.
//
// The conventions are three's, deliberately and to the letter: XYZ Euler order, and the same
// quaternion→matrix→Euler path three's own Euler.setFromQuaternion takes. That is what lets the gizmo
// (which composes with real THREE.Quaternions) and these typed fields land a fixture on the same
// numbers instead of on two answers that differ in the third decimal. Verified against three itself.

export type Axis = 'x' | 'y' | 'z';

const DEG = Math.PI / 180;

/** A point rotated `angleDeg` about a world axis through `pivot`. */
export function rotateAbout(v: Vec3, pivot: Vec3, axis: Axis, angleDeg: number): Vec3 {
  const a = angleDeg * DEG;
  const c = Math.cos(a), s = Math.sin(a);
  const x = v.x - pivot.x, y = v.y - pivot.y, z = v.z - pivot.z;
  // Right-handed, matching three: +Y turns +Z towards +X.
  if (axis === 'x') return { x: v.x, y: pivot.y + y * c - z * s, z: pivot.z + y * s + z * c };
  if (axis === 'y') return { x: pivot.x + x * c + z * s, y: v.y, z: pivot.z - x * s + z * c };
  return { x: pivot.x + x * c - y * s, y: pivot.y + x * s + y * c, z: v.z };
}

/**
 * An orientation with a world-axis rotation applied ON TOP of it — the world rotation composed
 * BEFORE the fixture's own, which is what "turn this fixture 15° about the room's vertical" means.
 */
export function turnBy(r: Euler3, axis: Axis, angleDeg: number): Euler3 {
  const half = angleDeg * DEG * 0.5;
  const s = Math.sin(half);
  const q = {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w: Math.cos(half),
  };
  return quatToEuler(mulQuat(q, eulerToQuat(r)));
}

interface Quat { x: number; y: number; z: number; w: number }

/** three's Quaternion.setFromEuler for the 'XYZ' order. */
function eulerToQuat(r: Euler3): Quat {
  const x = r.pitch * DEG, y = r.yaw * DEG, z = r.roll * DEG;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

function mulQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** three's Euler.setFromQuaternion for 'XYZ', via the rotation matrix it builds on the way. */
function quatToEuler(q: Quat): Euler3 {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);

  const yaw = Math.asin(Math.min(1, Math.max(-1, m13)));
  // At the pole (looking straight along the axis) pitch and roll describe the same turn, so three
  // hands the whole rotation to pitch and zeroes roll rather than splitting it arbitrarily.
  const gimbal = Math.abs(m13) >= 0.9999999;
  const pitch = gimbal ? Math.atan2(m32, m22) : Math.atan2(-m23, m33);
  const roll = gimbal ? 0 : Math.atan2(-m12, m11);
  return { pitch: pitch / DEG, yaw: yaw / DEG, roll: roll / DEG };
}
