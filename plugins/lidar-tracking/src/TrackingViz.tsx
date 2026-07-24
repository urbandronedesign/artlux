import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line, Html } from '@react-three/drei';
import * as THREE from 'three';
import { Scene3D } from '../../../shared/protocol';
import * as tracking from './trackingStore';
import * as blobMotion from './blobMotion';
import * as zones from './zones';

// LiDAR tracking visualization for the 3D Scene. Reconstructs the venue's interactive zones at
// real-world dimensions and renders a smoothed, predicted, ID-labeled marker per tracked blob.
// Fed from trackingStore (bridged from the OSC-receiving main window). Render-free: marker matrices
// and label positions update in useFrame so high-rate tracking never triggers React re-renders —
// only the *set* of active ids (a few Hz) updates React state.
//
// Motion is smoothed + short-horizon predicted in services/blobMotion.ts (One-Euro + bounded
// constant-velocity). Identities are keyed by the stable tracking id, so up to 10 concurrent people
// are handled cleanly and a marker fades out when its track stops (no ghosts).
//
// Venue layout (per the 61fps plans): SOL = floor (horizontal, y=0), MUR = wall (vertical, z=0),
// sharing the edge along the x-axis at the origin. Default dims 5.825 × 3.125 m each; overridden
// live by each surface's specs/Scalex|Scaley when the tracking system sends them.

const DEF_W = 5.825;   // zone width (x), meters
const DEF_D = 3.125;   // floor depth (z), meters
const DEF_H = 3.125;   // wall height (y), meters
const R = 0.11;        // blob marker radius, meters
const MAX_BLOBS = 64;

const ZONE_COLOR = '#34d399';
const SURFACE_COLOR: Record<string, string> = { SOL: '#22d3ee', MUR: '#a855f7', SOL_MUR: '#f59e0b' };
const DEFAULT_BLOB = '#22d3ee';

interface Dims { W: number; D: number; H: number; }
interface LabelDesc { key: string; id: number; surface: string; }

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

const rect = (points: [number, number, number][]): [number, number, number][] => [...points, points[0]];

// TRIGGER ZONES, in the venue. The panel is where they are DRAWN (a normalized rect is a 2D gesture);
// this is where they are BELIEVED — seeing the rectangle on the floor next to the fixtures, lighting up
// as somebody walks into it, is what tells an operator the zone is where they think it is.
//
// Reuses blobPosition(), so a zone corner maps to 3D through the EXACT code path a blob does. That is
// deliberate rather than convenient: any disagreement between the two mappings would draw the zone
// somewhere the trigger does not actually test, and the error would only show up as a show that fires
// at the wrong moment.
const ZoneOutlines: React.FC<{ dims: Dims }> = ({ dims }) => {
  const [tick, setTick] = useState(0);
  const list = zones.getZones();
  // Occupancy is a low-rate event (a person arriving), so a 4 Hz poll is plenty and keeps the r3f
  // scene out of the high-rate blob path entirely.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, []);
  void tick;
  const p = useMemo(() => new THREE.Vector3(), []);
  const corner = (surface: string, u: number, v: number): [number, number, number] => {
    blobPosition(surface, u, v, dims, p);
    // Lift a hair off the surface so the outline is not z-fighting the zone plane it sits on.
    return [p.x, p.y + 0.002, p.z];
  };
  return (
    <group>
      {list.map((z) => {
        const u0 = Math.min(z.u0, z.u1), u1 = Math.max(z.u0, z.u1);
        const v0 = Math.min(z.v0, z.v1), v1 = Math.max(z.v0, z.v1);
        const st = zones.getState(z.id);
        const occupied = st?.occupied ?? false;
        // No state at all ⇒ this look does not listen to the zone (Scene3D.activeZoneIds). It still
        // belongs to the room and is still drawn — hiding it would make an operator think it was
        // deleted — but faintly, because nothing here can fire it.
        const inScene = !!st;
        const col = z.color || '#f5a623';
        const centre = corner(z.surface, (u0 + u1) / 2, (v0 + v1) / 2);
        return (
          <group key={z.id}>
            <Line points={rect([
              corner(z.surface, u0, v0), corner(z.surface, u1, v0),
              corner(z.surface, u1, v1), corner(z.surface, u0, v1),
            ])} color={col} lineWidth={occupied ? 3.5 : 1.4} dashed={!occupied} dashSize={0.12} gapSize={0.08}
              transparent opacity={inScene ? 1 : 0.35} />
            {/* THE MARKER. Positioned through the same blobPosition() mapping as the corners above, so
                the label can never drift from the rectangle it names. DOM via drei Html (offline-safe,
                uses the app's fonts) — the same pattern as the per-blob #id labels below. */}
            <group position={centre}>
              <Html center distanceFactor={11} zIndexRange={[18, 0]} prepend>
                <div style={{
                  pointerEvents: 'none', whiteSpace: 'nowrap', fontSize: '11px', fontWeight: 700,
                  lineHeight: 1.15, padding: '2px 6px', borderRadius: '4px', textAlign: 'center',
                  // Occupied is the state a trigger fires on, so it is the one that reads from across a
                  // venue: filled in the zone's colour. Otherwise it stays quiet against the 3D scene.
                  color: occupied ? '#0b0b0b' : col,
                  background: occupied ? col : 'rgba(0,0,0,0.55)',
                  border: `1px solid ${col}`,
                  opacity: inScene ? 1 : 0.4,
                  transform: 'translate(-50%, -50%)',
                }}>
                  {z.name}
                  {/* The live headcount, only while somebody is in it — a permanent "· 0" would be noise
                      on every zone in the room. */}
                  {!!st?.count && <span style={{ fontWeight: 500 }}> · {st.count}</span>}
                </div>
              </Html>
            </group>
          </group>
        );
      })}
    </group>
  );
};

const TrackingViz: React.FC<{ scene3D: Scene3D }> = ({ scene3D }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const labelPos = useMemo(() => new THREE.Vector3(), []);

  const showLabels = scene3D.trackingLabels !== false;

  // Push smoothing/prediction settings into the motion filter when they change.
  useEffect(() => {
    blobMotion.configure({ smoothing: scene3D.trackingSmoothing ?? 0.5, predictMs: scene3D.trackingPredictMs ?? 80 });
  }, [scene3D.trackingSmoothing, scene3D.trackingPredictMs]);

  // Feed the motion filter whenever new tracking data lands (filter gates duplicate samples itself).
  useEffect(() => {
    const unsub = tracking.subscribe(() => blobMotion.ingest(tracking.getActiveEntries(), performance.now()));
    return () => { unsub(); blobMotion.reset(); };
  }, []);

  // Zone geometry depends on dims, which change only when the system reports new specs.
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

  // Active id labels (only the set is React state; positions move render-free via the ref maps).
  const [labels, setLabels] = useState<LabelDesc[]>([]);
  const labelKeysRef = useRef('');
  const groupRefs = useRef(new Map<string, THREE.Group>());
  const labelEls = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => { if (!showLabels) { setLabels([]); labelKeysRef.current = ''; } }, [showLabels]);

  useEffect(() => { if (meshRef.current) meshRef.current.raycast = () => null; }, []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const now = performance.now();
    const d = dimsRef.current;
    const live = blobMotion.tick(now);
    const n = Math.min(live.length, MAX_BLOBS);
    const pulse = 1 + 0.1 * Math.sin(state.clock.elapsedTime * 4); // gentle breathing
    for (let i = 0; i < n; i++) {
      const tr = live[i];
      blobPosition(tr.surface, tr.u, tr.v, d, pos);
      dummy.position.copy(pos);
      dummy.scale.setScalar(pulse * (0.45 + 0.55 * tr.alpha)); // shrink as a track fades out
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.set(SURFACE_COLOR[tr.surface] ?? DEFAULT_BLOB));
      if (showLabels) {
        const g = groupRefs.current.get(tr.key);
        if (g) { labelPos.copy(pos); labelPos.y += R * 2.4; g.position.copy(labelPos); }
        const el = labelEls.current.get(tr.key);
        if (el) el.style.opacity = String(tr.alpha);
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Re-sync the label set only when the active ids change (enter/leave) — not every frame.
    if (showLabels) {
      const keys = live.slice(0, n).map((t) => t.key).join('|');
      if (keys !== labelKeysRef.current) {
        labelKeysRef.current = keys;
        setLabels(live.slice(0, n).map((t) => ({ key: t.key, id: t.id, surface: t.surface })));
      }
    }
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

      {/* Trigger zones — dashed while empty, solid + thick while occupied. */}
      <ZoneOutlines dims={dims} />

      {/* Live blob markers — unlit + bright (per-surface instanceColor) so the scene's bloom glows. */}
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX_BLOBS]} frustumCulled={false}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={'#ffffff'} toneMapped={false} />
      </instancedMesh>

      {/* Per-blob ID labels — DOM via drei Html (offline-safe; uses app fonts). Positioned each frame
          by moving each label's parent group (render-free). */}
      {showLabels && labels.map((l) => (
        <group key={l.key} ref={(g) => { if (g) groupRefs.current.set(l.key, g); else groupRefs.current.delete(l.key); }}>
          <Html center distanceFactor={9} zIndexRange={[20, 0]} prepend>
            <div
              ref={(el) => { if (el) labelEls.current.set(l.key, el); else labelEls.current.delete(l.key); }}
              style={{
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
                fontSize: '12px',
                fontWeight: 700,
                lineHeight: 1,
                padding: '2px 5px',
                borderRadius: '4px',
                color: '#0b0b0b',
                background: SURFACE_COLOR[l.surface] ?? DEFAULT_BLOB,
                boxShadow: '0 1px 4px rgba(0,0,0,0.5)',
                transform: 'translate(-50%, -160%)',
              }}
            >
              #{l.id}
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
};

export default TrackingViz;
