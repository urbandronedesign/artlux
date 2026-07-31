import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { ledUnderPointer } from './pickPriority';
import { SceneModel, modelScaleXYZ } from '../../../../shared/protocol';
import { ModelTransform } from './ModelObject';
import { useLayerTexture } from './useLayerTexture';

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
  onCalibPick?: (world: [number, number, number]) => void;
}

// A flat screen/projection plane that displays a timeline video layer (model.layerId).
// Mirrors ModelObject's stable-group + gizmo pattern. The texture is bound to whatever
// <video> the timeline engine currently drives for that layer (null when no clip is live).
export const PlaneObject: React.FC<Props> = ({ model, selected, mode, onSelect, onCommit, onRecordHistory, calibPickMode, onCalibPick }) => {
  const group = useMemo(() => new THREE.Group(), []);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const controls = useRef<any>(null);

  // Bind the layer's live frame to the plane's material (shared with GLB meshes via the hook).
  useLayerTexture(model.layerId, (tex) => {
    const mat = matRef.current;
    if (!mat) return;
    mat.map = tex;
    mat.color.set(tex ? '#ffffff' : '#161616');
    mat.needsUpdate = true;
  });

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
          if (calibPickMode && onCalibPick) { onCalibPick([e.point.x, e.point.y, e.point.z]); return; }
          onSelect(model.id);
        }}
      >
        <mesh>
          <planeGeometry args={[16 / 9, 1]} />
          <meshBasicMaterial ref={matRef} side={THREE.DoubleSide} toneMapped={false} color="#161616" />
        </mesh>
      </primitive>
      {/* Hidden while calibrating — the gizmo sits over the very surface being picked and would eat
          the clicks. Mirrors ModelObject. */}
      {selected && !calibPickMode && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
