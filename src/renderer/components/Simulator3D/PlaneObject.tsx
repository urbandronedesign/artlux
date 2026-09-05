import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { ledUnderPointer } from './pickPriority';
import { snapToVertex, updateSnapHover, setSnapHover } from './vertexSnap';
import { SceneModel, modelScaleXYZ } from '../../../../shared/protocol';
import { ModelTransform } from './ModelObject';
import { useLayerTexture } from './useLayerTexture';
import { useSurfaceTexture } from './useSurfaceTexture';
import { registerDepthCaster, unregisterDepthCaster } from './projectorDepth';
import { blankMap } from './blankMap';

const DEG = Math.PI / 180;

interface Props {
  model: SceneModel;
  selected: boolean;
  mode: 'translate' | 'rotate' | 'scale';
  onSelect: (id: string) => void;
  onCommit: (id: string, t: ModelTransform) => void;
  onRecordHistory: () => void;
  /** Projector pose-pick mode: clicks report the world hit point instead of selecting. */
  calibPickMode?: boolean;
  onCalibPick?: (world: [number, number, number], source?: string) => void;
}

// A flat screen/projection plane that displays a timeline video layer (model.layerId).
// Mirrors ModelObject's stable-group + gizmo pattern. The texture is bound to whatever
// <video> the timeline engine currently drives for that layer (null when no clip is live).
export const PlaneObject: React.FC<Props> = ({ model, selected, mode, onSelect, onCommit, onRecordHistory, calibPickMode, onCalibPick }) => {
  const size = useThree((s) => s.size); // css pixels — the snap gate is a SCREEN distance
  const group = useMemo(() => new THREE.Group(), []);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const controls = useRef<any>(null);

  // Bind the live frame to the plane's material — from a timeline layer or a whole surface (shared
  // with GLB meshes via the two hooks; a layer binding wins, and each hook is inert without its id).
  const applyTex = (tex: THREE.Texture | null) => {
    const mat = matRef.current;
    if (!mat) return;
    // NEVER null — see blankMap.ts. A material whose map was null when three's WebGPU observer first
    // snapshotted it stops monitoring `map` forever, and the plane freezes on its first frame.
    mat.map = tex ?? blankMap();
    mat.color.set(tex ? '#ffffff' : '#161616');
    mat.needsUpdate = true;
  };
  useLayerTexture(model.layerId, applyTex);
  useSurfaceTexture(model.layerId ? undefined : model.surfaceId, applyTex);

  // A screen CASTS into the projector depth map even though it never reads one (a plane has no
  // projected-UV mode of its own). It is usually the nearest thing to the projector, so leaving it
  // out would let content land on the wall behind a screen that is physically blocking the light.
  useEffect(() => {
    registerDepthCaster(model.id, group);
    return () => unregisterDepthCaster(model.id);
  }, [model.id, group]);

  useEffect(() => {
    group.position.set(model.position.x, model.position.y, model.position.z);
    group.rotation.set(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG);
    const [sx, sy, sz] = modelScaleXYZ(model);
    group.scale.set(sx, sy, sz);
  }, [group, model.position, model.rotation, model.scale, model.scaleXYZ]);

  // Latch history on the first real drag movement (objectChange), not on the gizmo grab (mouseDown),
  // so a click on a handle that never drags no longer pushes a junk undo entry, and skip the commit
  // when nothing moved. Mirrors the Stage drag latch. See plans/timeline-undo.md §5.1/§5.5.
  const moved = useRef(false);
  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const onDown = () => { moved.current = false; };
    const onChange = () => { if (!moved.current) { moved.current = true; onRecordHistory(); } };
    const onUp = () => {
      if (!moved.current) return; // pure click on a handle — nothing to record or commit
      onCommit(model.id, {
        position: { x: group.position.x, y: group.position.y, z: group.position.z },
        rotation: { x: group.rotation.x / DEG, y: group.rotation.y / DEG, z: group.rotation.z / DEG },
        scaleXYZ: [Math.max(0.0001, group.scale.x), Math.max(0.0001, group.scale.y), Math.max(0.0001, group.scale.z)],
      });
    };
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('objectChange', onChange);
    c.addEventListener('mouseUp', onUp);
    return () => { c.removeEventListener('mouseDown', onDown); c.removeEventListener('objectChange', onChange); c.removeEventListener('mouseUp', onUp); };
  }, [selected, group, model.id, onCommit, onRecordHistory]);

  if (!model.visible) return null;

  return (
    <>
      <primitive
        object={group}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          // Yield to a fixture under the same pointer: not stopping propagation lets r3f carry the
          // click through to the LED mesh behind this screen. See pickPriority.ts. NOT while
          // calibrating: a pose pick wants the point on the SURFACE, which is the purpose of that mode.
          if (!calibPickMode && ledUnderPointer(e)) return;
          e.stopPropagation();
          // A SCREEN IS A PICKABLE SURFACE TOO. Only ModelObject took the calibration pick, so a click
          // on a venue plane — which is usually the nearest thing to the camera and always stops
          // propagation — was consumed as a model selection: no anchor appeared, and nothing said why.
          if (calibPickMode && onCalibPick) {
            // An orbit is not a click — see ModelObject for why r3f needs this and does not do it.
            if (e.delta > 2) return;
            // A screen's four corners are the most nameable points on it, so it snaps like a mesh.
            const snap = snapToVertex(e, size.width, size.height);
            setSnapHover(null);
            onCalibPick(snap.point, `screen ${model.name || model.id}${snap.snapped ? ' ▸ vertex' : ''}`);
            return;
          }
          onSelect(model.id);
        }}
        onPointerMove={calibPickMode ? ((e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); updateSnapHover(e as unknown as ThreeEvent<MouseEvent>, size.width, size.height); }) : undefined}
        onPointerOut={calibPickMode ? (() => setSnapHover(null)) : undefined}
      >
        <mesh>
          <planeGeometry args={[16 / 9, 1]} />
          {/* `map` is set HERE, at construction, not only in applyTex — blankMap.ts explains why a
              material that is born mapless can never be given a live texture on WebGPU. */}
          <meshBasicMaterial ref={matRef} map={blankMap()} side={THREE.DoubleSide} toneMapped={false} color="#161616" />
        </mesh>
      </primitive>
      {/* Hidden while calibrating — the gizmo sits over the very surface being picked and would eat
          the clicks. Mirrors ModelObject. */}
      {selected && !calibPickMode && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
