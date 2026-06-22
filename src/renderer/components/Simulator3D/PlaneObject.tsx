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
  const texRef = useRef<THREE.VideoTexture | null>(null);
  const curVid = useRef<HTMLVideoElement | null>(null);
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

  // Bind the layer's live video to the plane each frame.
  useFrame(() => {
    const vid = engine.getLayerDrawable(model.layerId);
    if (vid !== curVid.current) {
      curVid.current = vid;
      texRef.current?.dispose();
      const mat = matRef.current;
      if (vid) {
        const t = new THREE.VideoTexture(vid);
        t.colorSpace = THREE.SRGBColorSpace;
        texRef.current = t;
        if (mat) { mat.map = t; mat.color.set('#ffffff'); mat.needsUpdate = true; }
      } else {
        texRef.current = null;
        if (mat) { mat.map = null; mat.color.set('#161616'); mat.needsUpdate = true; }
      }
    }
    if (texRef.current) texRef.current.needsUpdate = true;
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
