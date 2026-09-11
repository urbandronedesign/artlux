import * as THREE from 'three';

// HOW BIG IS A METRE, ON SCREEN, RIGHT NOW — the one ladder the floor grid, the origin gnomon and the
// grid numbers all read. Pure arithmetic plus one published frame; imports no React, knows nothing
// about what draws.
//
// THE NUMBER AND THE LINE MUST COME FROM ONE PLACE. A "2 m" printed over a line that is actually 1 m
// away is not a cosmetic bug — it is a lie an operator will scale an imported model by, and nothing
// throws. So the grid solves the frame once per tick and publishes it; the gnomon and the labels read
// it. Two components deriving the same step separately is the failure this module exists to prevent
// (verify-invariants guards it).
//
// WHY PIXELS PER METRE AND NOT ORBIT DISTANCE. Distance is only a proxy for screen density: it ignores
// the pane height (the dock resizes freely), it ignores fov, and under `Scene3D.viewFrom` the camera's
// own `fov` is STALE because ProjectorView overwrites `projectionMatrix` wholesale. Measuring a metre
// through the LIVE projection matrix is correct under both cameras — and it lets the ladder's
// threshold and the labels' anti-collision gap be the SAME constant instead of two that drift apart.

/**
 * The smallest a section may get on screen, in css px — and, being the same number, the closest two
 * labels may sit. Modelled on `chooseTickStep(pxPerSec, minPx = 76)` in the timeline ruler
 * (components/timeline/geometry.ts): the floor is that same problem against a different unit.
 */
export const GRID_MIN_PX = 64;

/** What the grid, the gnomon and the labels each need, solved once per frame. */
export interface GridFrame {
  /** Metres between the counted (labelled) lines — a 1·2·5 × 10ⁿ step. */
  section: number;
  /** Fine lines per section. Always a round division of the decade — see `cellDivFor`. */
  cellDiv: number;
  /** Where the grid sits, snapped to a whole section so every line stays on a round coordinate. */
  originX: number;
  originZ: number;
  /** css px one world metre subtends at the reference point. The labels reuse it for decimation. */
  pxPerMetre: number;
}

// A 1·2·5 ladder rather than pure decades: decades alone jump 10x and spend most of a zoom at the
// wrong density. Anything finer than 1-2-5 starts producing steps nobody counts in.
const MANTISSA = [1, 2, 5];

/** Decade exponent of `v` (v > 0). */
const decadeOf = (v: number) => Math.pow(10, Math.floor(Math.log10(v)));

// Ladder values are exact decades times 1/2/5, so they are short — but floating point turns 0.3 into
// 0.30000000000000004, and a ruler must never show that.
const trim = (v: number) => String(Math.round(v * 1e6) / 1e6);

/**
 * The smallest 1·2·5 × 10ⁿ metre step that still subtends at least `minPx` on screen.
 * Same shape as the timeline's `chooseTickStep`, deliberately.
 */
export function chooseGridStep(pxPerMetre: number, minPx: number = GRID_MIN_PX): number {
  if (!(pxPerMetre > 0) || !Number.isFinite(pxPerMetre)) return 1;
  const target = minPx / pxPerMetre;            // the smallest acceptable section, in metres
  const d = decadeOf(target);
  for (const m of MANTISSA) if (m * d >= target - 1e-12) return m * d;
  return 10 * d;                                // past 5 in this decade means the next one's 1
}

// How far past its threshold the incumbent rung may drift before we switch. Without this the whole
// floor re-steps at the exact boundary and blinks between two decades during a slow dolly, which reads
// as a rendering fault rather than as a ruler. 15% absorbs a scroll wheel's smallest notch.
const HYST = 0.15;
// The widest a chosen section gets, as a multiple of minPx: consecutive 1-2-5 rungs are at most 2.5x
// apart (2 → 5), so a rung chosen at minPx has grown to at most 2.5x minPx before the next takes over.
const RUNG_SPAN = 2.5;

/**
 * `chooseGridStep` with a dead band around the switch, so a slow zoom does not flicker the floor.
 * `prev` is last frame's section; pass 0/undefined on the first frame.
 */
export function stickyGridStep(pxPerMetre: number, prev?: number, minPx: number = GRID_MIN_PX): number {
  const next = chooseGridStep(pxPerMetre, minPx);
  if (!prev || !(prev > 0) || next === prev) return next;
  const prevPx = prev * pxPerMetre;
  // Keep the incumbent while it is still inside a tolerant version of the band that chose it.
  if (prevPx >= minPx * (1 - HYST) && prevPx < minPx * RUNG_SPAN * (1 + HYST)) return prev;
  return next;
}

/**
 * Fine lines per section — chosen so the CELL is also a round number.
 *
 * This is why the ladder cannot keep a fixed subdivision. The grid used to be a hardcoded 4 cells per
 * 1 m section (0.25 m). On a 1-2-5 ladder that same 4 turns rung 5 into 1.25 m cells, which is a
 * number nobody counts in. Per-mantissa divisions keep every cell at 0.1, 0.5 or 1.0 of the decade.
 */
export function cellDivFor(section: number): number {
  if (!(section > 0)) return 10;
  const m = Math.round(section / decadeOf(section));   // 1 | 2 | 5 (10 only through float slop)
  return m === 2 ? 4 : m === 5 ? 5 : 10;
}

/**
 * A ruler tick, written the way you would say it: `2 m`, `40 cm`, `5 mm`. Never `0.004 m`.
 *
 * NOT shared with the snap-step menu in the viewport header, and that is deliberate. That menu formats
 * a STEP (`250 mm` — how far this drag will move) and the user guide quotes its strings verbatim
 * (docs/user-guide/09-3d-scene.md:54,120). This formats a POSITION on a ruler, where centimetres read
 * far better than a three-digit millimetre count. One shared function would have to either uglify the
 * floor or falsify the guide.
 */
export function formatMetric(v: number): string {
  const a = Math.abs(v);
  if (a < 1e-9) return '0';
  const sign = v < 0 ? '-' : '';
  if (a >= 1) return `${sign}${trim(a)} m`;
  if (a >= 0.01) return `${sign}${trim(a * 100)} cm`;
  return `${sign}${trim(a * 1000)} mm`;
}

// ── Measuring the live camera ──────────────────────────────────────────────────────────────────────
// Module-scope scratch: this runs every frame, and allocating five Vector3s per tick is exactly the
// per-frame garbage the rest of this folder is careful about.
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _at = new THREE.Vector3();
const _up = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _vp = new THREE.Matrix4();

/**
 * css px that one world metre subtends at `at`, measured through the camera's LIVE projection matrix.
 *
 * Not `screenScale.worldPerPixel`, which derives from `cam.fov` — correct for the editor camera and
 * wrong under `viewFrom`, where the projection matrix is replaced by the projector's own refitted
 * intrinsics and the fov field no longer describes it.
 */
export function pixelsPerMetre(cam: THREE.Camera, heightPx: number, at: THREE.Vector3): number {
  if (!(heightPx > 0)) return 0;
  _vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  // One metre "up the screen" at that depth — a direction lying in the view plane, so the metre is not
  // foreshortened and the answer is the honest on-screen size.
  _up.setFromMatrixColumn(cam.matrixWorld, 1).normalize();
  _a.copy(at).applyMatrix4(_vp);                    // Vector3.applyMatrix4 does the perspective divide
  _b.copy(at).add(_up).applyMatrix4(_vp);
  return Math.abs(_b.y - _a.y) * 0.5 * heightPx;    // NDC span (-1..1) to pixels
}

/**
 * Solve this frame's grid. `prevSection` is last frame's, for the hysteresis band.
 * Returns null when the camera cannot be measured (zero-sized pane, degenerate matrix).
 */
export function solveGridFrame(cam: THREE.Camera, heightPx: number, prevSection?: number): GridFrame | null {
  if (!(heightPx > 0)) return null;
  _eye.setFromMatrixPosition(cam.matrixWorld);
  _dir.set(0, 0, -1).transformDirection(cam.matrixWorld);

  // THE REFERENCE POINT: where the camera is actually looking on the floor. Not the orbit target —
  // AdaptiveClipping reads that, and is mounted `off` under viewFrom precisely because OrbitControls is
  // disabled there, which leaves `controls.target` pointing at whatever was last orbited, possibly
  // metres BEHIND the projector. A forward ray works in both modes.
  let t = Number.NaN;
  if (Math.abs(_dir.y) > 1e-4) t = -_eye.y / _dir.y;
  if (t > 0 && Number.isFinite(t)) {
    _at.copy(_eye).addScaledVector(_dir, t);
    _at.y = 0;                                      // kill float drift; it IS the floor plane
  } else {
    // Looking along or above the horizon: there is no floor hit. Fall back to a point the camera's own
    // height in front of it — always in FRONT, so the projection stays valid (a point behind the camera
    // divides by a negative w and every number after it is nonsense).
    _at.copy(_eye).addScaledVector(_dir, Math.max(Math.abs(_eye.y), 1e-3));
  }

  const px = pixelsPerMetre(cam, heightPx, _at);
  if (!(px > 0) || !Number.isFinite(px)) return null;

  const section = stickyGridStep(px, prevSection);
  return {
    section,
    cellDiv: cellDivFor(section),
    pxPerMetre: px,
    // Snapped to a whole section: the grid FOLLOWS the view (so close work far from the world origin
    // still has a floor under it) while every line it draws stays on a round world coordinate, which is
    // what lets the labels tell the truth.
    originX: Math.round(_at.x / section) * section,
    originZ: Math.round(_at.z / section) * section,
  };
}

// ── The published frame ────────────────────────────────────────────────────────────────────────────
// ONE WRITER: GroundGrid, mounted exactly when the grid is visible, solving before the gnomon and the
// labels read it (r3f runs equal-priority useFrame subscribers in mount order). A module singleton is
// legal here for the same reason registerViewerCamera's is — verify-invariants asserts a single
// <Simulator3D> mount site. If that check ever goes, both registries break together.
let frame: GridFrame | null = null;

export function setGridFrame(f: GridFrame | null): void { frame = f; }

/** This frame's grid, or null when no grid is being drawn (hidden, or no 3D viewport mounted). */
export function getGridFrame(): GridFrame | null { return frame; }
