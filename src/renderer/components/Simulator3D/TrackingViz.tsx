import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import * as tracking from '../../services/trackingStore';

// LiDAR tracking visualization for the 3D Scene. Reconstructs the venue's interactive zones at
// real-world dimensions and renders a live marker per tracked blob, fed from the trackingStore
// (bridged from the OSC-receiving main window). Render-free: blob matrices update in useFrame so
// high-rate tracking never triggers React re-renders.
//
// Venue layout (per the 61fps plans): SOL = floor (horizontal, y=0), MUR = wall (vertical, z=0),
// sharing the edge along the x-axis at the origin. Default dims 5.825 × 3.125 m each; overridden
// live by each surface's specs/Scalex|Scaley when the tracking system sends them.
//   • blob u → x across the width (origin bottom-left → centered on x)
//   • blob v → up the zone (origin bottom-left): MUR v↑wall, SOL v→toward the wall edge
//   • SOL_MUR treats floor+wall as one plane: v 0..0.5 = floor, 0.5..1 = wall

const DEF_W = 5.825;   // zone width (x), meters
const DEF_D = 3.125;   // floor depth (z), meters
const DEF_H = 3.125;   // wall height (y), meters
const R = 0.11;        // blob marker radius, meters
const MAX_BLOBS = 64;

const ZONE_COLOR = '#34d399';
const SURFACE_COLOR: Record<string, string> = { SOL: '#22d3ee', MUR: '#a855f7', SOL_MUR: '#f59e0b' };
const DEFAULT_BLOB = '#22d3ee';

interface Dims { W: number; D: number; H: number; }

function computeDims(): Dims {
  const sol = tracking.getSurfaceTrack('SOL');
  const mur = tracking.getSurfaceTrack('MUR');
  const sm = tracking.getSurfaceTrack('SOL_MUR');
  const W = sol?.scaleX || mur?.scaleX || sm?.scaleX || DEF_W;
  const D = sol?.scaleY || (sm?.scaleY ? sm.scaleY / 2 : 0) || DEF_D;
  const H = mur?.scaleY || (sm?.scaleY ? sm.scaleY / 2 : 0) || DEF_H;
  return { W, D, H };
}

// Map a blob's normalized (u,v) on its surface to a 3D point (meters), offset just off the surface
// so the marker sits on top rather than embedded in the plane.
function blobPosition(surface: string, u: number, v: number, d: Dims, out: THREE.Vector3): void {
  const x = (u - 0.5) * d.W;
  if (surface === 'MUR') { out.set(x, v * d.H, R); return; }
  if (surface === 'SOL_MUR') {
    if (v <= 0.5) { const fv = v / 0.5; out.set(x, R, (1 - fv) * d.D); return; } // floor half
    const wv = (v - 0.5) / 0.5; out.set(x, wv * d.H, R); return;                 // wall half
  }
  // SOL (and any unknown surface) → floor: v=0 at the front edge, v=1 at the wall edge.
  out.set(x, R, (1 - v) * d.D);
}

// Rectangle outline (closed) for a zone in a given plane.
function rect(points: [number, number, number][]): [number, number, number][] {
  return [...points, points[0]];
}

const TrackingViz: React.FC = () => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);

  // Zone geometry depends on dims, which change only when the tracking system reports new specs.
  // Keep it in state (re-renders the lines/planes) while blob markers update render-free below.
  const [dims, setDims] = useState<Dims>(() => computeDims());
  const dimsRef = useRef(dims);
  dimsRef.current = dims;

  useEffect(() => {
    const unsub = tracking.subscribe(() => {
      const d = computeDims();
      setDims((prev) => (prev.W === d.W && prev.D === d.D && prev.H === d.H ? prev : d));
    });
    return unsub;
  }, []);

  // Instanced markers don't need to participate in picking (they'd steal clicks from fixtures).
  useEffect(() => { if (meshRef.current) meshRef.current.raycast = () => null; }, []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const d = dimsRef.current;
    const entries = tracking.getActiveEntries();
    const n = Math.min(entries.length, MAX_BLOBS);
    const pulse = 1 + 0.12 * Math.sin(state.clock.elapsedTime * 4); // gentle breathing
    for (let i = 0; i < n; i++) {
      const { surface, blob } = entries[i];
      blobPosition(surface, blob.u, blob.v, d, pos);
      dummy.position.copy(pos);
      dummy.scale.setScalar(pulse);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(SURFACE_COLOR[surface] ?? DEFAULT_BLOB));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  const { W, D, H } = dims;
  const floorRect = rect([[-W / 2, 0, 0], [W / 2, 0, 0], [W / 2, 0, D], [-W / 2, 0, D]]);
  const wallRect = rect([[-W / 2, 0, 0], [W / 2, 0, 0], [W / 2, H, 0], [-W / 2, H, 0]]);

  return (
    <group>
      {/* SOL — floor zone */}
      <Line points={floorRect} color={ZONE_COLOR} lineWidth={1.6} />
      <mesh position={[0, 0.001, D / 2]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[W, D]} />
        <meshBasicMaterial color={ZONE_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* MUR — wall zone */}
      <Line points={wallRect} color={ZONE_COLOR} lineWidth={1.6} />
      <mesh position={[0, H / 2, 0]} raycast={() => null}>
        <planeGeometry args={[W, H]} />
        <meshBasicMaterial color={ZONE_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* Live blob markers — unlit + bright (per-surface instanceColor) so the scene's bloom glows. */}
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_BLOBS]} frustumCulled={false}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={'#ffffff'} toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

export default TrackingViz;
