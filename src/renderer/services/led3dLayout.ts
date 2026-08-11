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

export function effectiveRot(f: Fixture): THREE.Euler {
  const r = effectiveRotObj(f);
  return new THREE.Euler(r.pitch * DEG, r.yaw * DEG, r.roll * DEG, 'XYZ');
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
