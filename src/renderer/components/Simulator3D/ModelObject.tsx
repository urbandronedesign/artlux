import React, { useEffect, useMemo, useRef } from 'react';
import { useGLTF, TransformControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { ledUnderPointer } from './pickPriority';
import { snapToVertex, updateSnapHover, setSnapHover } from './vertexSnap';
import { SceneModel } from '../../../../shared/protocol';
import { useLayerTexture } from './useLayerTexture';
import { useSurfaceTexture } from './useSurfaceTexture';
import { recenterClone, applyModelTransform } from './venuePlacement';
import { makeProjectedMaterial, usesProjectedUv, type ProjectedMaterial } from './projectedMapping';
import { registerVenueMesh, unregisterVenueMesh } from '@artlux/plugin-calibration/renderer';

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
  /** `source` names the surface the ray actually landed on — see the call site for why it matters. */
  onCalibPick?: (world: [number, number, number], source?: string) => void;
}

// A single GLB mesh with its own move/rotate/scale gizmo when selected. The container
// group is STABLE (useMemo) — TransformControls attaches to it via `object`, so selecting
// never remounts/resets the transform. Each instance clones the shared loaded scene so the
// same file can be placed many times (clones share geometry + materials = cheap).
export const ModelObject: React.FC<Props> = ({ model, url, selected, mode, onSelect, onCommit, onRecordHistory, onNaturalSize, calibPickMode, onCalibPick }) => {
  const { scene } = useGLTF(url);
  const size = useThree((s) => s.size); // css pixels — the snap gate is a SCREEN distance
  const group = useMemo(() => new THREE.Group(), []);
  const controls = useRef<any>(null);

  // Recentred so the group origin (and thus the gizmo) sits at the mesh's bounding-box centre rather
  // than the GLB's authored origin. Shared with the calibration render + raycast paths — see
  // venuePlacement.ts for why a private copy here would be a silent metric error.
  const cloned = useMemo(() => recenterClone(scene), [scene]);

  // Optional timeline-layer texturing: when model.layerId is set, override every mesh's material
  // with one shared MeshBasicMaterial fed by the layer's live frame (UV-mapped via the GLB's own
  // UVs); restore the original GLB materials when cleared. Shares the binding path with planes.
  const layerMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  if (!layerMatRef.current) layerMatRef.current = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false });
  // The projected-UV twin. A SECOND instance rather than a patch toggled on the one above — see
  // makeProjectedMaterial for why (three's program cache would otherwise hand back the wrong shader).
  const projMatRef = useRef<ProjectedMaterial | null>(null);
  if (!projMatRef.current) projMatRef.current = makeProjectedMaterial();
  const origMats = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map());

  const projected = usesProjectedUv(model);
  const applyTex = (tex: THREE.Texture | null) => {
    for (const mat of [layerMatRef.current!, projMatRef.current!.material]) {
      mat.map = tex;
      mat.color.set(tex ? '#ffffff' : '#161616');
      mat.needsUpdate = true;
    }
    // The projected path computes its UV in the FRAGMENT stage and so bypasses the texture matrix
    // three would normally apply in the vertex stage — including matchBitmapOrientation's flip
    // compensation. Mirror it into the uniforms here, right where the texture identity changes.
    projMatRef.current!.syncMapTransform(tex);
  };
  // Two sources, one material. A layer binding wins when both are somehow set (see SceneModel), and
  // each hook is inert when its own id is absent — so exactly one of them ever writes the map.
  useLayerTexture(model.layerId, applyTex);
  useSurfaceTexture(model.layerId ? undefined : model.surfaceId, applyTex);

  useEffect(() => {
    const layered = !!model.layerId || !!model.surfaceId;
    const want = projected ? projMatRef.current!.material : layerMatRef.current!;
    cloned.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      if (layered) {
        if (!origMats.current.has(mesh.uuid)) origMats.current.set(mesh.uuid, mesh.material);
        mesh.material = want;
      } else {
        const orig = origMats.current.get(mesh.uuid);
        if (orig) { mesh.material = orig; origMats.current.delete(mesh.uuid); }
      }
    });
  }, [cloned, model.layerId, model.surfaceId, projected]);

  useEffect(() => () => { layerMatRef.current?.dispose(); projMatRef.current?.dispose(); }, []);

  // Mount the cloned mesh into the stable group.
  useEffect(() => {
    group.add(cloned);
    return () => { group.remove(cloned); };
  }, [group, cloned]);

  // Projected UVs, in the SHADER — see projectedMapping.ts for the maths and for why the V flip and
  // the ImageBitmap compensation both live there. Drives the same chunks the projector window
  // interpolates, so the editor and the wall cannot disagree.
  //
  // This replaced a per-vertex bake that wrote a `uv` attribute onto a private geometry clone (the
  // clone existed only so the loader's SHARED geometry was never poisoned). The shader needs no clone,
  // no revert bookkeeping, handles vertices behind the projector — which the bake mirror-smeared —
  // and RE-PROJECTS LIVE, so moving the mesh or re-solving the projector updates the mapping instead
  // of leaving it glued to wherever things were at bake time.
  useEffect(() => {
    if (!usesProjectedUv(model)) return;
    const pm = projMatRef.current!;
    pm.setProjector(new THREE.Matrix4().fromArray(model.uvProjView!),
      new THREE.Vector3(...(model.uvProjEye ?? [0, 0, 0])));
    pm.setLook(model.uvProjSoft ?? 0, !!model.uvProjCull);
    // Keyed on the projection FIELDS, not the model object — moving the mesh must not rebuild
    // uniforms, and this must not depend on the caller keeping model identity stable.
  }, [projected, model.uvProjView, model.uvProjEye, model.uvProjSoft, model.uvProjCull]);

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

  // Keep the group transform synced to the model record (per-axis scale). In place, not rebuilt:
  // TransformControls attaches to `group`, so its identity must survive a re-render.
  useEffect(() => {
    applyModelTransform(group, model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, model.position, model.rotation, model.scale, model.scaleXYZ]);

  // Record history on the first real drag movement, commit the new transform on drag end. Scale is
  // per-axis — the gizmo's X/Y/Z handles scale each axis independently and we persist all three.
  // Latch on `objectChange`, not `mouseDown` (which fires on a grab that never drags), so a click on a
  // handle no longer pushes a junk undo entry. Mirrors the Stage drag latch. See plans/timeline-undo.md.
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
        onClick={(e: any) => {
          // Yield to a fixture under the same pointer — see pickPriority.ts. NOT while calibrating:
          // a pose pick wants the point on the MESH, which is the whole purpose of that mode.
          if (!calibPickMode && ledUnderPointer(e)) return;
          e.stopPropagation();
          if (calibPickMode && onCalibPick) {
            // AN ORBIT IS NOT A CLICK. r3f fires onClick on any press/release pair over the object,
            // however far the pointer travelled in between — so every drag that orbited the camera
            // while starting and ending on the venue dropped an anchor nobody asked for. r3f hands us
            // the travel in `delta` (css px) and leaves the threshold to the caller; it never applied
            // one of its own. This is the whole reason moving the camera placed points.
            if (e.delta > 2) return;
            // Snap to the nearest vertex when the cursor is on one — see
            // vertexSnap.ts. Report WHICH surface carried the hit, and whether it snapped: an anchor
            // that lands somewhere unexpected is otherwise undiagnosable, because a world point alone
            // cannot tell you whether you hit the venue mesh, a screen plane in front of it, or a
            // stray sub-mesh of the GLB.
            const snap = snapToVertex(e, size.width, size.height);
            setSnapHover(null);
            const where = `${model.name || model.id}${e.object?.name ? ` / ${e.object.name}` : ''}`;
            onCalibPick(snap.point, `${where}${snap.snapped ? ' ▸ vertex' : ''}`);
            return;
          }
          onSelect(model.id);
        }}
        // Only while calibrating: a move handler makes r3f raycast this mesh on every pointer move,
        // which is not a cost a venue GLB should carry when nobody is placing anchors.
        onPointerMove={calibPickMode ? ((e: any) => { e.stopPropagation(); updateSnapHover(e, size.width, size.height); }) : undefined}
        onPointerOut={calibPickMode ? (() => setSnapHover(null)) : undefined}
      />
      {selected && !calibPickMode && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
