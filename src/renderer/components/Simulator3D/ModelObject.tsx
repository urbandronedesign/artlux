import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { SceneModel } from '../../../../shared/protocol';

const DEG = Math.PI / 180;

export interface ModelTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number }; // degrees
  scale: number;
}

interface Props {
  model: SceneModel;
  url: string;
  selected: boolean;
  mode: 'translate' | 'rotate' | 'scale';
  onSelect: (id: string) => void;
  onCommit: (id: string, t: ModelTransform) => void;
  onRecordHistory: () => void;
  /** Reports the model's intrinsic longest dimension (in GLB units) once loaded — for Auto-fit. */
  onNaturalSize?: (id: string, maxDim: number) => void;
}

// A single GLB mesh with its own move/rotate/scale gizmo when selected. The container
// group is STABLE (useMemo) — TransformControls attaches to it via `object`, so selecting
// never remounts/resets the transform. Each instance clones the shared loaded scene so the
// same file can be placed many times (clones share geometry + materials = cheap).
export const ModelObject: React.FC<Props> = ({ model, url, selected, mode, onSelect, onCommit, onRecordHistory, onNaturalSize }) => {
  const { scene } = useGLTF(url);
  const group = useMemo(() => new THREE.Group(), []);
  const controls = useRef<any>(null);

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => { o.frustumCulled = false; }); // never cull out at odd camera angles
    // Recenter so the group origin (and thus the gizmo) sits at the mesh's bounding-box
    // centre rather than the GLB's authored origin.
    const center = new THREE.Box3().setFromObject(c).getCenter(new THREE.Vector3());
    c.position.sub(center);
    return c;
  }, [scene]);

  // Mount the cloned mesh into the stable group.
  useEffect(() => {
    group.add(cloned);
    return () => { group.remove(cloned); };
  }, [group, cloned]);

  // Report intrinsic (scale-1) size once for Auto-fit.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) onNaturalSize?.(model.id, maxDim);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, model.id]);

  // Keep the group transform synced to the model record.
  useEffect(() => {
    group.position.set(model.position.x, model.position.y, model.position.z);
    group.rotation.set(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG);
    group.scale.setScalar(model.scale > 0 ? model.scale : 1);
  }, [group, model.position, model.rotation, model.scale]);

  // Record history on drag start, commit the new transform on drag end.
  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const onDown = () => onRecordHistory();
    const onUp = () => {
      onCommit(model.id, {
        position: { x: group.position.x, y: group.position.y, z: group.position.z },
        rotation: { x: group.rotation.x / DEG, y: group.rotation.y / DEG, z: group.rotation.z / DEG },
        scale: Math.max(0.0001, group.scale.x),
      });
    };
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('mouseUp', onUp);
    return () => { c.removeEventListener('mouseDown', onDown); c.removeEventListener('mouseUp', onUp); };
  }, [selected, group, model.id, onCommit, onRecordHistory]);

  if (!model.visible) return null;

  return (
    <>
      <primitive object={group} onClick={(e: any) => { e.stopPropagation(); onSelect(model.id); }} />
      {selected && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
