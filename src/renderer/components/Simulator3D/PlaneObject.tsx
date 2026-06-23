import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { SceneModel } from '../../../../shared/protocol';
import { timeline as engine } from '../../services/timeline';
import { ModelTransform } from './ModelObject';

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
  const texRef = useRef<THREE.Texture | null>(null);
  const curVid = useRef<HTMLVideoElement | null>(null); // identity of the bound <video> (back-compat path)
  const controls = useRef<any>(null);

  useEffect(() => {
    group.position.set(model.position.x, model.position.y, model.position.z);
    group.rotation.set(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG);
    group.scale.setScalar(model.scale > 0 ? model.scale : 1);
  }, [group, model.position, model.rotation, model.scale]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !selected) return;
    const onDown = () => onRecordHistory();
    const onUp = () => onCommit(model.id, {
      position: { x: group.position.x, y: group.position.y, z: group.position.z },
      rotation: { x: group.rotation.x / DEG, y: group.rotation.y / DEG, z: group.rotation.z / DEG },
      scale: Math.max(0.0001, group.scale.x),
    });
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('mouseUp', onUp);
    return () => { c.removeEventListener('mouseDown', onDown); c.removeEventListener('mouseUp', onUp); };
  }, [selected, group, model.id, onCommit, onRecordHistory]);

  useEffect(() => () => { texRef.current?.dispose(); }, []);

  // Bind the layer's live frame to the plane each frame. The drawable is a streamed
  // ImageBitmap in the Scene window (decoded once in main) or a <video> on the legacy path.
  useFrame(() => {
    const mat = matRef.current;
    if (!mat) return;
    const d = engine.getLayerDrawable(model.layerId);

    if (!d) {
      if (texRef.current || curVid.current) {
        texRef.current?.dispose(); texRef.current = null; curVid.current = null;
        mat.map = null; mat.color.set('#161616'); mat.needsUpdate = true;
      }
      return;
    }

    if (d instanceof HTMLVideoElement) {
      if (d !== curVid.current) {
        curVid.current = d;
        texRef.current?.dispose();
        const t = new THREE.VideoTexture(d);
        t.colorSpace = THREE.SRGBColorSpace;
        texRef.current = t;
        mat.map = t; mat.color.set('#ffffff'); mat.needsUpdate = true;
      }
      texRef.current!.needsUpdate = true;
    } else {
      // Streamed ImageBitmap: reuse one plain texture, swap its image each frame (a new
      // transferred bitmap arrives per frame, so always mark it dirty). Match VideoTexture's
      // filtering — no mipmaps, linear — so the per-frame upload is cheap and NPOT-safe.
      curVid.current = null;
      let t = texRef.current;
      if (!t || t instanceof THREE.VideoTexture) {
        t?.dispose();
        t = new THREE.Texture();
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        texRef.current = t;
        mat.map = t; mat.color.set('#ffffff'); mat.needsUpdate = true;
      }
      t.image = d;
      t.needsUpdate = true;
    }
  });

  if (!model.visible) return null;

  return (
    <>
      <primitive object={group} onClick={(e: any) => { e.stopPropagation(); onSelect(model.id); }}>
        <mesh>
          <planeGeometry args={[16 / 9, 1]} />
          <meshBasicMaterial ref={matRef} side={THREE.DoubleSide} toneMapped={false} color="#161616" />
        </mesh>
      </primitive>
      {selected && <TransformControls ref={controls} object={group} mode={mode} size={0.8} />}
    </>
  );
};
