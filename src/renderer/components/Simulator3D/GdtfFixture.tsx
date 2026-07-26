import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Fixture, FixtureProfile } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';
import * as fixtureSignal from '../../services/fixtureSignal';
import { rigMetrics } from '../../services/profileRig';

// A fixture drawn from its REAL GDTF geometry, articulated by its live pan/tilt.
//
// A GDTF does not ship one mesh: every geometry node has its own model file, and the tree says how
// they hinge. That is the whole point — a single baked mesh could not move. So this builds a real
// three.js hierarchy (Body → Yoke → Head → Beam), parents each node's mesh under it, and rotates the
// nodes the DMX channels identified as pan and tilt.
//
// ROTATIONS ARE DELTAS FROM THE FIXTURE'S HOME POSE, not absolute angles. The mesh as authored IS the
// fixture at pan-centre/tilt-centre, so applying (value − mid) means the model never has to be
// reconciled with an absolute frame — which matters because GDTF describes a HANGING device whose
// beam points down, while the procedural bodies point forward. Same rule MoverBodies already uses.
//
// Fallback is not an error state: no geometry, or a mesh that will not load, and the caller keeps
// drawing the procedural body. A rig will always contain a fixture nobody has a GDTF for.

const DEG = Math.PI / 180;

interface Props {
  fixture: Fixture;
  profile: FixtureProfile;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Told when the meshes could not be used, so the caller can fall back to a procedural body. */
  onUnavailable?: (id: string) => void;
}

/** Cache by absolute mesh path: a rig of twenty identical heads must load each mesh once. */
const meshCache = new Map<string, Promise<THREE.Group | null>>();

function loadMesh(path: string): Promise<THREE.Group | null> {
  const hit = meshCache.get(path);
  if (hit) return hit;
  const job = (async () => {
    try {
      const bytes = await window.artlux?.readModel?.(path);
      if (!bytes) return null;
      const loader = new GLTFLoader();
      const buffer = (bytes as Uint8Array).buffer.slice(
        (bytes as Uint8Array).byteOffset,
        (bytes as Uint8Array).byteOffset + (bytes as Uint8Array).byteLength,
      ) as ArrayBuffer;
      const gltf = await loader.parseAsync(buffer, '');
      return gltf.scene;
    } catch (e) {
      console.warn(`[gdtf] mesh unavailable: ${path}`, e);
      return null;
    }
  })();
  meshCache.set(path, job);
  return job;
}

export const GdtfFixture: React.FC<Props> = ({ fixture, profile, selected, onSelect, onUnavailable }) => {
  const geometry = profile.geometry;
  const [root, setRoot] = useState<THREE.Group | null>(null);
  // The nodes that move, resolved once so the frame loop is a couple of quaternion writes.
  const joints = useRef<Array<{ obj: THREE.Object3D; axis: 'pan' | 'tilt' }>>([]);
  const scratch = useMemo(() => ({ q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0) }), []);

  useEffect(() => {
    let alive = true;
    if (!geometry?.nodes.length) { onUnavailable?.(fixture.id); return; }

    (async () => {
      // Build the hierarchy first, then hang meshes off it — so a node whose mesh is missing still
      // exists as a pivot and its children stay attached in the right place.
      const group = new THREE.Group();
      const byName = new Map<string, THREE.Object3D>();
      for (const n of geometry.nodes) {
        const o = new THREE.Object3D();
        o.name = n.name;
        if (n.offset) o.position.set(n.offset.x, n.offset.y, n.offset.z);
        byName.set(n.name, o);
      }
      for (const n of geometry.nodes) {
        const o = byName.get(n.name)!;
        (n.parent ? byName.get(n.parent) ?? group : group).add(o);
      }

      const meshes = await Promise.all(
        geometry.nodes.map(async (n) => ({ n, scene: n.modelPath ? await loadMesh(n.modelPath) : null })),
      );
      if (!alive) return;

      let attached = 0;
      for (const { n, scene } of meshes) {
        if (!scene) continue;
        // Clone rather than reuse: three objects live in one place in one scene graph, and twenty
        // fixtures sharing a mesh instance would all snap to the last one's transform. A clone still
        // shares the underlying geometry and material buffers, which is where the memory is.
        byName.get(n.name)?.add(scene.clone(true));
        attached++;
      }
      if (!attached) { onUnavailable?.(fixture.id); return; }

      joints.current = geometry.nodes
        .filter((n) => n.kind === 'axis' && n.axis)
        .map((n) => ({ obj: byName.get(n.name)!, axis: n.axis! }));

      setRoot(group);
    })();

    return () => { alive = false; };
  }, [geometry, fixture.id, onUnavailable]);

  useFrame(() => {
    if (!joints.current.length) return;
    const st = fixtureSignal.snapshot().get(fixture.id);
    if (!st) return;
    const m = rigMetrics(profile);
    const { q, up, right } = scratch;
    for (const j of joints.current) {
      // Delta from the home pose — see the note at the top on why this is not an absolute angle.
      const delta = (j.axis === 'pan' ? st.pan - m.panMid : st.tilt - m.tiltMid) * DEG;
      q.setFromAxisAngle(j.axis === 'pan' ? up : right, delta);
      j.obj.quaternion.copy(q);
    }
  });

  if (!root) return null;

  const pos = effectivePos(fixture);
  const rot = effectiveRot(fixture);
  const scale = fixture.scale3D && fixture.scale3D > 0 ? fixture.scale3D : 1;

  return (
    <group
      position={pos}
      rotation={rot}
      scale={scale}
      onClick={(e) => { e.stopPropagation(); onSelect(fixture.id); }}
    >
      <primitive object={root} />
      {/* Selection is shown as a wire box rather than by tinting the meshes: a GDTF model carries the
          manufacturer's own materials, and recolouring them makes a selected fixture look lit — the
          one signal the beam is supposed to own. */}
      {selected && <box3Helper args={[new THREE.Box3().setFromObject(root), new THREE.Color('#27b6c4')]} />}
    </group>
  );
};
