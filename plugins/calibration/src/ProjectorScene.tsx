import React, { forwardRef, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { EffectComposer } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';
import type { Scene3D, SceneModel, ProjectorCalibration } from '../../../shared/protocol';
import { modelScaleXYZ } from '../../../shared/protocol';
import { cameraPose, glProjectionMatrix } from './cvCamera';
import { useLayerTexture } from '@/components/Simulator3D/useLayerTexture'; // host hook — transitional seam

const DEG = Math.PI / 180;
const NEAR = 0.05, FAR = 200;

// Renders the venue 3D scene from the matched virtual projector (true projection mapping). The camera
// is driven exactly from the calibration (position/orientation + an exact intrinsic projection matrix
// — see cvCamera), and a fullscreen post-pass applies the recovered lens distortion so the projected
// image matches the real optics. Mounted by ProjectorApp only for calibrated outputs in 'render' mode;
// otherwise the existing 2D-warp path is used. Models are placed identically to Simulator3D (recenter
// to bbox + transform) so world coords match the pose solve.

// One GLB venue mesh, placed to match Simulator3D exactly; optional timeline-layer texture (Phase A).
const ProjectorModel: React.FC<{ model: SceneModel; url: string }> = ({ model, url }) => {
  const { scene } = useGLTF(url);
  const layerMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  if (!layerMatRef.current) layerMatRef.current = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false });

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((o) => { o.frustumCulled = false; });
    const center = new THREE.Box3().setFromObject(c).getCenter(new THREE.Vector3());
    c.position.sub(center); // same recentre as ModelObject → identical world coords
    return c;
  }, [scene]);

  useLayerTexture(model.layerId, (tex) => {
    const mat = layerMatRef.current!;
    mat.map = tex; mat.color.set(tex ? '#ffffff' : '#161616'); mat.needsUpdate = true;
  });

  useEffect(() => {
    const layered = !!model.layerId;
    cloned.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if ((mesh as { isMesh?: boolean }).isMesh && layered) mesh.material = layerMatRef.current!;
    });
  }, [cloned, model.layerId]);

  useEffect(() => () => { layerMatRef.current?.dispose(); }, []);

  if (!model.visible) return null;
  return (
    <group
      position={[model.position.x, model.position.y, model.position.z]}
      rotation={[model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG]}
      scale={modelScaleXYZ(model)}
    >
      <primitive object={cloned} />
    </group>
  );
};

// Drives the R3F camera from the calibration each frame (overrides R3F's fov/aspect projection with
// the exact intrinsic matrix).
const CalibCamera: React.FC<{ calibration: ProjectorCalibration }> = ({ calibration }) => {
  const camera = useThree((s) => s.camera);
  useFrame(() => {
    const { position, quaternion } = cameraPose(calibration.rotation, calibration.translation as [number, number, number]);
    camera.position.set(position[0], position[1], position[2]);
    camera.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    camera.updateMatrixWorld(true);
    camera.projectionMatrix.fromArray(glProjectionMatrix(calibration.intrinsics, calibration.imageSize, NEAR, FAR));
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  });
  return null;
};

// Lens-distortion post-pass (radial k1,k2,k3 + tangential p1,p2), applied to the sampling UVs. For
// zero distortion it is identity. The forward-distortion convention may need validation on hardware
// (a sign flip) — the geometry/pose is exact regardless.
const distortFrag = /* glsl */`
uniform vec2 uFocal;   // fx, fy (projector px)
uniform vec2 uCenter;  // cx, cy (projector px)
uniform vec3 uRadial;  // k1, k2, k3
uniform vec2 uTang;    // p1, p2
void mainUv(inout vec2 uv) {
  vec2 px = uv * resolution;
  vec2 nd = (px - uCenter) / uFocal;
  float r2 = dot(nd, nd);
  float radial = 1.0 + uRadial.x * r2 + uRadial.y * r2 * r2 + uRadial.z * r2 * r2 * r2;
  vec2 dt = vec2(2.0 * uTang.x * nd.x * nd.y + uTang.y * (r2 + 2.0 * nd.x * nd.x),
                 uTang.x * (r2 + 2.0 * nd.y * nd.y) + 2.0 * uTang.y * nd.x * nd.y);
  vec2 ndd = nd * radial + dt;
  uv = (ndd * uFocal + uCenter) / resolution;
}`;

class DistortionEffect extends Effect {
  constructor(calibration: ProjectorCalibration) {
    const K = calibration.intrinsics, d = calibration.distortion;
    super('DistortionEffect', distortFrag, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uFocal', new THREE.Uniform(new THREE.Vector2(K[0], K[4]))],
        ['uCenter', new THREE.Uniform(new THREE.Vector2(K[2], K[5]))],
        ['uRadial', new THREE.Uniform(new THREE.Vector3(d[0] || 0, d[1] || 0, d[4] || 0))],
        ['uTang', new THREE.Uniform(new THREE.Vector2(d[2] || 0, d[3] || 0))],
      ]),
    });
  }
}

const Distortion = forwardRef<DistortionEffect, { calibration: ProjectorCalibration }>(({ calibration }, ref) => {
  const effect = useMemo(() => new DistortionEffect(calibration), [calibration]);
  return <primitive object={effect} ref={ref} dispose={null} />;
});
Distortion.displayName = 'Distortion';

export const ProjectorScene: React.FC<{ scene3D: Scene3D; modelUrls: Record<string, string>; calibration: ProjectorCalibration }> = ({ scene3D, modelUrls, calibration }) => {
  const meshes = (scene3D.models ?? []).filter(m => m.kind !== 'plane' && modelUrls[m.id]);
  const hasDistortion = calibration.distortion?.some(v => v !== 0);
  return (
    <Canvas gl={{ powerPreference: 'high-performance', antialias: true }} dpr={1} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#000']} />
      <ambientLight intensity={1} />
      <CalibCamera calibration={calibration} />
      {meshes.map(m => <ProjectorModel key={m.id} model={m} url={modelUrls[m.id]} />)}
      {hasDistortion && (
        <EffectComposer>
          <Distortion calibration={calibration} />
        </EffectComposer>
      )}
    </Canvas>
  );
};
