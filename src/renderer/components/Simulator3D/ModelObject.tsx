import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { SceneModel, modelScaleXYZ } from '../../../../shared/protocol';
import { useLayerTexture } from './useLayerTexture';
import { registerVenueMesh, unregisterVenueMesh } from '../../calib/venueRaycast';

const DEG = Math.PI / 180;

export interface ModelTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number }; // degrees
  scale?: number;                       // uniform (legacy)
  scaleXYZ?: [number, number, number];  // per-axis (independent) scale
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
  /** Projector pose-pick mode: clicks report the world hit point instead of selecting. */
  calibPickMode?: boolean;
  onCalibPick?: (world: [number, number, number]) => void;
}

// A single GLB mesh with its own move/rotate/scale gizmo when selected. The container
// group is STABLE (useMemo) — TransformControls attaches to it via `object`, so selecting
// never remounts/resets the transform. Each instance clones the shared loaded scene so the
// same file can be placed many times (clones share geometry + materials = cheap).
export const ModelObject: React.FC<Props> = ({ model, url, selected, mode, onSelect, onCommit, onRecordHistory, onNaturalSize, calibPickMode, onCalibPick }) => {
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

  // Optional timeline-layer texturing: when model.layerId is set, override every mesh's material
  // with one shared MeshBasicMaterial fed by the layer's live frame (UV-mapped via the GLB's own
  // UVs); restore the original GLB materials when cleared. Shares the binding path with planes.
  const layerMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  if (!layerMatRef.current) layerMatRef.current = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false });
  const origMats = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map());

  useLayerTexture(model.layerId, (tex) => {
    const mat = layerMatRef.current!;
    mat.map = tex;
    mat.color.set(tex ? '#ffffff' : '#161616');
    mat.needsUpdate = true;
  });

  useEffect(() => {
    const layered = !!model.layerId;
    const layerMat = layerMatRef.current!;
    cloned.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      if (layered) {
        if (!origMats.current.has(mesh.uuid)) origMats.current.set(mesh.uuid, mesh.material);
        mesh.material = layerMat;
      } else {
        const orig = origMats.current.get(mesh.uuid);
        if (orig) { mesh.material = orig; origMats.current.delete(mesh.uuid); }
      }
    });
  }, [cloned, model.layerId]);

  useEffect(() => () => { layerMatRef.current?.dispose(); }, []);

  // Mount the cloned mesh into the stable group.
  useEffect(() => {
    group.add(cloned);
    return () => { group.remove(cloned); };
  }, [group, cloned]);

  // Register the world-space group for the markerless calibration's batch raycaster (only while
  // visible). Lets the controller cast camera rays onto this venue geometry to sample 3D points.
  useEffect(() => {
    if (model.visible) registerVenueMesh(model.id, group);
    else unregisterVenueMesh(model.id);
    return () => unregisterVenueMesh(model.id);
  }, [group, model.id, model.visible]);

  // Report intrinsic (scale-1) size once for Auto-fit.
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) onNaturalSize?.(model.id, maxDim);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, model.id]);

  // Keep the group transform synced to the model record (per-axis scale).
  useEffect(() => {
    const [sx, sy, sz] = modelScaleXYZ(model);
    group.position.set(model.position.x, model.position.y, model.position.z);
    group.rotation.set(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG);
    group.scale.set(sx, sy, sz);
  }, [group, model.position, model.rotation, model.scale, model.scaleXYZ]);

  // Record history on drag start, commit the new transform on drag end. Scale is per-axis — the gizmo's
  // X/Y/Z handles scale each axis independently and we persist all three.
  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const onDown = () => onRecordHistory();
    const onUp = () => {
      onCommit(model.id, {
        position: { x: group.position.x, y: group.position.y, z: group.position.z },
        rotation: { x: group.rotation.x / DEG, y: group.rotation.y / DEG, z: group.rotation.z / DEG },
        scaleXYZ: [Math.max(0.0001, group.scale.x), Math.max(0.0001, group.scale.y), Math.max(0.0001, group.scale.z)],
      });
    };
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('mouseUp', onUp);
    return () => { c.removeEventListener('mouseDown', onDown); c.removeEventListener('mouseUp', onUp); };
  }, [selected, group, model.id, onCommit, onRecordHistory]);

  if (!model.visible) return null;

  return (
    <>
      <primitive
        object={group}
        onClick={(e: any) => {
          e.stopPropagation();
          if (calibPickMode && onCalibPick) onCalibPick([e.point.x, e.point.y, e.point.z]);
          else onSelect(model.id);
        }}
      />
      {selected && !calibPickMode && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
