import React, { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { computeLedPositions } from '../../services/led3dLayout';
import { useLedColors } from './hooks/useLedColors';
import { LED_PICK } from './pickPriority';
import { isPreviewing, previewRev, livePose, hasPreview, PREVIEW_LED_BUDGET } from './fixturePreview';

interface Props {
  fixtures: Fixture[];
  onSelectFixture: (id: string) => void;
}

// One InstancedMesh for ALL LEDs across all fixtures. instanceIndex matches the
// cumulative LED order used by the dmxSignal pixel buffer, so color updates need
// no per-fixture bookkeeping.
export const InstancedLeds: React.FC<Props> = ({ fixtures, onSelectFixture }) => {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  // Rebuild geometry layout only when something affecting positions changes.
  const layoutSig = useMemo(() => JSON.stringify(fixtures.map(f => ({
    c: f.ledCount, p: f.position3D, r: f.rotation3D, l: f.layout3D, rev: f.reverse, s: f.scale3D, sxyz: f.scaleXYZ,
    x: f.x, y: f.y, w: f.width, h: f.height, rot: f.rotation,
  }))), [fixtures]);

  // Per-instance positions + a global index -> fixtureId map. `starts` is the same walk's by-product:
  // where each fixture's run begins in the buffer, which is what lets a live drag rewrite ONLY the
  // fixtures it is moving instead of the whole rig.
  const { positions, total, indexToFixture, starts } = useMemo(() => {
    const arrays: Float32Array[] = [];
    const map: string[] = [];
    const at = new Map<string, number>();
    let count = 0;
    for (const f of fixtures) {
      const p = computeLedPositions(f);
      arrays.push(p);
      at.set(f.id, count);
      for (let i = 0; i < f.ledCount; i++) map.push(f.id);
      count += f.ledCount;
    }
    const all = new Float32Array(count * 3);
    let o = 0;
    for (const a of arrays) { all.set(a, o); o += a.length; }
    return { positions: all, total: count, indexToFixture: map, starts: at };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSig]);

  // Apply instance matrices + initialize colors when layout changes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || total === 0) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < total; i++) {
      dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, BLACK);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // MUST recompute, or the fixtures stop being clickable in the 3D view.
    //
    // THREE.InstancedMesh.raycast() early-outs against `boundingSphere`, which three computes lazily on
    // the FIRST raycast and then caches forever — `instanceMatrix.needsUpdate` does not invalidate it.
    // So the pickable region freezes at whatever the instance positions were the first time anyone
    // clicked, and every later layout change (moving a fixture, editing its 3D position, changing
    // spacing/rows) leaves the ray tested against a sphere that is no longer where the LEDs are.
    //
    // The symptom is exact and was reported as such: picking a fixture in the 3D scene works once, and
    // after that it is impossible. `key={total}` does not save us — it remounts only when the LED COUNT
    // changes, not when positions do.
    mesh.computeBoundingSphere();
  }, [positions, total]);

  // ── THE LIVE DRAG ─────────────────────────────────────────────────────────────────────────
  // While the transform gizmo is held, the dragged fixtures' LEDs follow it. Only THEIR index ranges
  // are rewritten, from the same delta the release will commit (see fixturePreview.ts / gizmoDelta.ts).
  //
  // Three things this deliberately does NOT do:
  //  · It does not recompute the bounding sphere. That is an O(total) walk over every LED in the rig,
  //    and it exists so a MOVED fixture stays clickable — nobody clicks mid-drag, and the committed
  //    layout effect above runs on release, which is when the pick geometry has to be right again.
  //  · It does not read React state. The channel is polled by revision, so an unchanged frame costs
  //    one integer compare and the drag never re-renders anything.
  //  · It does not preview an unbounded selection. Past the budget the bodies alone follow the handle
  //    (see FixtureBodies) — one instance per fixture rather than one per pixel.
  const appliedRev = useRef(-1);
  // WHOSE instances this component last wrote a preview into. The clearing frame needs it: by then the
  // channel is empty, so "which fixtures do I have to put back" is a question only this can answer.
  // Without it, a gesture that ends WITHOUT a commit (Escape, an unmount, the selection changing under
  // the drag) would leave the rig frozen wherever the handle was — the picture and the document
  // silently disagreeing, which is worse than not previewing at all.
  const dirty = useRef<string[]>([]);
  const scratch = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || total === 0) return;
    const rev = previewRev();
    if (rev === appliedRev.current) return;
    appliedRev.current = rev;
    const live = isPreviewing();

    // Past the budget the LEDs sit still and only the bodies follow the handle (see FixtureBodies).
    // Decided per frame off the CURRENT selection, so it cannot latch on from an earlier gesture.
    if (live) {
      let previewed = 0;
      for (const f of fixtures) if (hasPreview(f.id)) previewed += f.ledCount;
      if (previewed > PREVIEW_LED_BUDGET) { restore(mesh, fixtures, starts, dirty, scratch); return; }
    }

    const next: string[] = [];
    for (const f of fixtures) {
      const dragged = live && hasPreview(f.id);
      // Write a fixture when it is being dragged, and once more when it stops being dragged.
      if (!dragged && !dirty.current.includes(f.id)) continue;
      const base = starts.get(f.id);
      if (base == null) continue;
      writeRun(mesh, base, computeLedPositions(dragged ? livePose(f) : f), f.ledCount, scratch);
      if (dragged) next.push(f.id);
    }
    dirty.current = next;
    mesh.instanceMatrix.needsUpdate = true;
  });

  useLedColors(meshRef, total);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId == null) return;
    const id = indexToFixture[e.instanceId];
    if (id) onSelectFixture(id);
  };

  if (total === 0) return null;

  return (
    <instancedMesh
      key={total}                 // remount when count changes (resizes buffers)
      ref={meshRef}
      // Lets the screens/models yield this click to us when an LED is under the pointer — see
      // pickPriority.ts. Without it a fixture drawn on a screen is unpickable.
      userData={{ [LED_PICK]: true }}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, total]}
      onClick={handleClick}
    >
      {/* 20 triangles per LED, not 80. A UV sphere at 8×6 segments costs 80 triangles and 63 vertices,
          and this mesh is instanced across EVERY LED in the rig — 10k pixels was 800k triangles a frame
          for dots that are 12 mm across. The cost is not only vertex work: sub-pixel triangles are the
          rasterizer's worst case, because each one still shades a 2×2 quad, so the wasted fill scales
          with the triangle COUNT rather than the area covered.
          An icosahedron at detail 0 is 20 faces and 12 vertices, and at this size it is the same dot.
          (A camera-facing quad would be 2 triangles and rounder still, but billboarding needs a custom
          vertex stage — worth doing in TSL when the scene moves to WebGPU, not in GLSL that gets
          deleted then.) */}
      <icosahedronGeometry args={[0.012, 0]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
};

const BLACK = new THREE.Color(0, 0, 0);

/** Write one fixture's LED run into the shared instance buffer, starting at `base`. */
function writeRun(
  mesh: THREE.InstancedMesh, base: number, p: Float32Array, ledCount: number, dummy: THREE.Object3D,
): void {
  const n = Math.min(ledCount, (p.length / 3) | 0);
  for (let i = 0; i < n; i++) {
    dummy.position.set(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    dummy.updateMatrix();
    mesh.setMatrixAt(base + i, dummy.matrix);
  }
}

/** Put every fixture this component previewed back where the document says it is. */
function restore(
  mesh: THREE.InstancedMesh, fixtures: Fixture[], starts: Map<string, number>,
  dirty: React.MutableRefObject<string[]>, dummy: THREE.Object3D,
): void {
  if (!dirty.current.length) return;
  for (const id of dirty.current) {
    const f = fixtures.find((x) => x.id === id);
    const base = starts.get(id);
    if (!f || base == null) continue;
    writeRun(mesh, base, computeLedPositions(f), f.ledCount, dummy);
  }
  dirty.current = [];
  mesh.instanceMatrix.needsUpdate = true;
}
