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
}

// A flat screen/projection plane that displays a timeline video layer (model.layerId).
// Mirrors ModelObject's stable-group + gizmo pattern. The texture is bound to whatever
// <video> the timeline engine currently drives for that layer (null when no clip is live).
export const PlaneObject: React.FC<Props> = ({ model, selected, mode, onSelect, onCommit, onRecordHistory }) => {
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

  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const onDown = () => onRecordHistory();
    const onUp = () => onCommit(model.id, {
      position: { x: group.position.x, y: group.position.y, z: group.position.z },
      rotation: { x: group.rotation.x / DEG, y: group.rotation.y / DEG, z: group.rotation.z / DEG },
      scaleXYZ: [Math.max(0.0001, group.scale.x), Math.max(0.0001, group.scale.y), Math.max(0.0001, group.scale.z)],
    });
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('mouseUp', onUp);
    return () => { c.removeEventListener('mouseDown', onDown); c.removeEventListener('mouseUp', onUp); };
  }, [selected, group, model.id, onCommit, onRecordHistory]);

  if (!model.visible) return null;

  return (
    <>
      <primitive
        object={group}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          // Yield to a fixture under the same pointer: not stopping propagation lets r3f carry the
          // click through to the LED mesh behind this screen. See pickPriority.ts.
          if (ledUnderPointer(e)) return;
          e.stopPropagation();
          onSelect(model.id);
        }}
      >
        <mesh>
          <planeGeometry args={[16 / 9, 1]} />
          <meshBasicMaterial ref={matRef} side={THREE.DoubleSide} toneMapped={false} color="#161616" />
        </mesh>
      </primitive>
      {selected && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
