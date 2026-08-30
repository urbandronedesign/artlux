import * as THREE from 'three';
import { Fixture } from '../types';
import { effectiveLayout, effectivePosObj, effectiveRotObj, effectiveScale3 } from './led3dDefaults';

// three-based 3D layout (only imported by the lazy Simulator3D components).
// Produces per-LED world positions; the 3D analog of GPUMapper.updateMapping.

const DEG = Math.PI / 180;

export { effectiveLayout, effectiveScale3, meanScale } from './led3dDefaults';

/** The fixture's own scale as a three-vector — for the 3D components, which all want it that way. */
export function effectiveScale(f: Fixture): THREE.Vector3 {
  const s = effectiveScale3(f);
  return new THREE.Vector3(s.x, s.y, s.z);
}

export function effectivePos(f: Fixture): THREE.Vector3 {
  const p = effectivePosObj(f);
  return new THREE.Vector3(p.x, p.y, p.z);
}

/**
 * The operator's OWN pitch/yaw/roll, as an Euler — what the Position fields show and what a gizmo
 * gesture writes back. NOT what anything draws: see effectiveRot.
 */
export function authoredRot(f: Fixture): THREE.Euler {
  const r = effectiveRotObj(f);
  return new THREE.Euler(r.pitch * DEG, r.yaw * DEG, r.roll * DEG, 'XYZ');
}

/**
 * The base orientation a MOUNT implies — and it is an INVERSION, not a tip.
 *
 * A fixture's own frame is a floor-standing head: the BASE sits at the origin, the yoke stacks up its
 * local +Y, the head sits on top of that, and the beam leaves along local −Z. So:
 *   floor   → identity. The base is already flat on the floor with the fixture standing on it.
 *   ceiling → 180° about Z. Local +Y becomes world −Y, so the base is on TOP and the yoke and head
 *             hang beneath it — a fixture bolted upside down under a truss, which is what hanging is.
 *             The beam axis (−Z) is untouched, so the head still aims horizontally at tilt centre and
 *             TILT is what takes it down to the stage, exactly as on the real fixture.
 *
 * ⚠ IT WAS ±90° ABOUT X, AND THAT IS THE MISTAKE THIS COMMENT EXISTS TO PREVENT. Pitching the fixture
 * 90° does point the beam up or down, but it points the whole BODY there too: the base ends up
 * standing on its edge and the fixture lies on its back on the floor. A mounting is about which way
 * the housing is bolted; where the light goes is pan and tilt's job.
 *
 * Absent ⇒ identity, which is every project written before this existed.
 */
const Z_AXIS = new THREE.Vector3(0, 0, 1);
export function mountRot(f: Fixture): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (f.mount === 'ceiling') q.setFromAxisAngle(Z_AXIS, 180 * DEG);
  return q;
}

/**
 * WHERE THE FIXTURE ACTUALLY POINTS — the mounting, then the operator's trim on top of it. Every
 * renderer reads this, so a mounted head's body, beam, cone and spotlight cannot disagree.
 *
 * ⚠ THE ORDER IS LOAD-BEARING, and it is what keeps the gizmo simple. `authored ∘ mount` means a
 * WORLD-space gesture d gives `authored' = d ∘ authored` — the composition the gizmo and the nudge
 * keys already compute — so neither of them has to know a mount exists. Written the other way round
 * (`mount ∘ authored`) the write-back would need conjugating by the mount at both sites, and the
 * first one anybody forgot would bake −90° into the fixture the first time it was nudged.
 */
export function effectiveRot(f: Fixture): THREE.Euler {
  if (!f.mount) return authoredRot(f);
  const q = new THREE.Quaternion().setFromEuler(authoredRot(f)).multiply(mountRot(f));
  return new THREE.Euler().setFromQuaternion(q, 'XYZ');
}

// Per-LED world positions as a flat Float32Array (xyz triples), in fixture LED order.
export function computeLedPositions(f: Fixture): Float32Array {
  const n = Math.max(0, f.ledCount | 0);
  const out = new Float32Array(n * 3);
  if (n === 0) return out;

  const L = effectiveLayout(f);
  const pos = effectivePos(f);
  const euler = effectiveRot(f);
  const local: THREE.Vector3[] = [];

  if (L.type === 'matrix') {
    const cols = Math.max(1, L.matrixCols);
    const rows = Math.max(1, L.matrixRows);
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      let col = i % cols;
      if (L.serpentine && row % 2 === 1) col = cols - 1 - col;
      const x = (col - (cols - 1) / 2) * L.ledSpacing;
      const y = ((rows - 1) / 2 - row) * L.ledSpacing;
      local.push(new THREE.Vector3(x, y, 0));
    }
  } else if (L.type === 'arc') {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const a = (-L.arcAngle / 2 + t * L.arcAngle) * DEG;
      local.push(new THREE.Vector3(L.arcRadius * Math.sin(a), L.arcRadius * Math.cos(a) - L.arcRadius, 0));
    }
  } else { // line
    for (let i = 0; i < n; i++) {
      local.push(new THREE.Vector3((i - (n - 1) / 2) * L.ledSpacing, 0, 0));
    }
  }

  if (f.reverse) local.reverse();

  // Per-axis, and applied BEFORE the rotation — the scale is in the fixture's own frame, so stretching
  // a panel wider means the same thing whatever angle it hangs at. See effectiveScale3.
  const s = effectiveScale3(f);
  const scale = new THREE.Vector3(s.x, s.y, s.z);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    v.copy(local[i]).multiply(scale).applyEuler(euler).add(pos);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  return out;
}
