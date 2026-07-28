import React, { forwardRef, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { EffectComposer } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';
import type { Scene3D, SceneModel, ProjectorCalibration, ProjectorBlend, SoftEdge } from '../../../shared/protocol';
import { modelScaleXYZ } from '../../../shared/protocol';
import { cameraPose, glProjectionMatrix } from './cvCamera';
import { useLayerTexture } from '@/components/Simulator3D/useLayerTexture'; // host hook — transitional seam
import { recenterClone } from '@/components/Simulator3D/venuePlacement';   // host helper — same seam
import { SOFT_EDGE_GLSL } from '@/projector/blendGlsl';                     // the ONE soft-edge ramp

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

  // Same recentre as ModelObject → identical world coords, because it is literally the same function.
  const cloned = useMemo(() => recenterClone(scene), [scene]);

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

// ── Soft-edge / world blend ─────────────────────────────────────────────────────────────────────
//
// THE BUG THIS FIXES: render-from-projector draws this scene as an opaque overlay ON TOP of the
// projector window's base GL canvas, so ProjectorGL's soft-edge shader never touches the picture.
// Turning on `useCalibration` therefore SILENTLY DISABLED BLENDING — including the manual soft edge
// the operator had already set. Two calibrated overlapping projectors doubled up with a hard border.
// The ramp itself is imported, not re-typed, so this and ProjectorGL cannot drift (see blendGlsl.ts).
//
// TWO THINGS ABOUT SPACE, both load-bearing:
//
// 1. Why gl_FragCoord and not the `uv` argument. DistortionEffect is a `mainUv` effect, so in the
//    merged shader `uv` is the DISTORTED lookup coordinate — where to read the ideal render from.
//    The blend belongs in PHYSICAL raster space (which pixel of the panel is lit), because that is
//    what the blend map is indexed by: blendCompute's input comes from the Gray-code decode, whose
//    projector coordinates are literal framebuffer addresses (native/calib decode_dense). Deriving
//    the screen uv from gl_FragCoord makes this independent of every other effect in the chain.
// 2. Why y is flipped. gl_FragCoord's origin is bottom-left; the blend map, the projector raster and
//    ProjectorGL's feather all put v=0 at the TOP.
const blendFrag = /* glsl */`
uniform vec4 uSoft;        // left, right, top, bottom feather widths (0 = hard)
uniform float uBlendGamma; // the projector's gamma — the ramp is share^(1/g)
uniform vec3 uColorGain;
uniform vec3 uBlackLift;
uniform sampler2D uBlendTex;  // world-space partition-of-unity alpha (blendCompute), R8
uniform sampler2D uBlackTex;  // per-cell black-lift weight, R8
uniform float uHasBlend;      // 0 = analytic soft edge only (no rig blend solved)
${SOFT_EDGE_GLSL}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 suv = vec2(gl_FragCoord.x / resolution.x, 1.0 - gl_FragCoord.y / resolution.y);
  float share = softEdgeShare(suv, uSoft) * mix(1.0, texture2D(uBlendTex, suv).r, uHasBlend);
  float a = blendSignal(share, uBlendGamma);
  // Black floor. With a solved rig blend, use its per-cell weight — 1 where this projector sees the
  // LEAST overlap, because that is the region whose black must be raised to match the N-times black
  // of the deepest overlap. Without one, fall back to ProjectorGL's analytic (1 - a) so an output
  // with only a hand-set soft edge behaves exactly as it does on the 2D path — no silent change.
  float blackW = mix(1.0 - a, texture2D(uBlackTex, suv).r, uHasBlend);
  outputColor = vec4(inputColor.rgb * a * uColorGain + uBlackLift * blackW, inputColor.a);
}`;

export interface BlendLook {
  softEdge?: SoftEdge;
  colorGain?: [number, number, number];
  blackLift?: [number, number, number];
  blend?: ProjectorBlend | null;
}

// A ProjectorBlend's alpha grid as an 8-bit red texture. 1/255 of alpha is far below the visible
// threshold once it has been through share^(1/2.2) and an 8-bit panel, and UNSIGNED_BYTE is the one
// format whose LINEAR filtering is guaranteed everywhere — a float map sampled NEAREST would band
// visibly across the whole overlap, which is the opposite of the point.
function gridTexture(values: number[] | undefined, w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(Math.max(1, w * h));
  if (values) for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, values[i] ?? 0)) * 255);
  const tex = new THREE.DataTexture(data, Math.max(1, w), Math.max(1, h), THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
const WHITE_1X1 = (): THREE.DataTexture => gridTexture([1], 1, 1);

class BlendEffect extends Effect {
  constructor(look: BlendLook) {
    const se = look.softEdge, b = look.blend ?? null;
    const g = Math.max(0.1, se?.gamma ?? 2.2);
    const gain = look.colorGain ?? [1, 1, 1];
    const lift = look.blackLift ?? [0, 0, 0];
    super('BlendEffect', blendFrag, {
      uniforms: new Map<string, THREE.Uniform>([
        ['uSoft', new THREE.Uniform(new THREE.Vector4(se?.left ?? 0, se?.right ?? 0, se?.top ?? 0, se?.bottom ?? 0))],
        ['uBlendGamma', new THREE.Uniform(g)],
        ['uColorGain', new THREE.Uniform(new THREE.Vector3(gain[0], gain[1], gain[2]))],
        ['uBlackLift', new THREE.Uniform(new THREE.Vector3(lift[0], lift[1], lift[2]))],
        ['uBlendTex', new THREE.Uniform(b ? gridTexture(b.alpha, b.w, b.h) : WHITE_1X1())],
        ['uBlackTex', new THREE.Uniform(b ? gridTexture(b.black, b.w, b.h) : WHITE_1X1())],
        ['uHasBlend', new THREE.Uniform(b ? 1 : 0)],
      ]),
    });
  }

  override dispose(): void {
    for (const name of ['uBlendTex', 'uBlackTex']) {
      (this.uniforms.get(name)?.value as THREE.Texture | undefined)?.dispose();
    }
    super.dispose();
  }
}

const Blend = forwardRef<BlendEffect, { look: BlendLook }>(({ look }, ref) => {
  // Rebuilt (not mutated) when the look changes: the textures are sized by the blend map, so a new
  // solve is a new upload anyway, and a solve happens at most once per calibration — never per frame.
  const effect = useMemo(() => new BlendEffect(look), [look]);
  useEffect(() => () => effect.dispose(), [effect]);
  return <primitive object={effect} ref={ref} dispose={null} />;
});
Blend.displayName = 'Blend';

// Does this output need the blend pass at all? A default output (no feather, unit gain, no lift, no
// solved blend) is identity, and mounting an EffectComposer for identity costs a full-screen pass on
// what may be a 4K projector.
export function needsBlendPass(look: BlendLook): boolean {
  const se = look.softEdge;
  if (look.blend) return true;
  if (se && (se.left > 0 || se.right > 0 || se.top > 0 || se.bottom > 0)) return true;
  const g = look.colorGain, l = look.blackLift;
  if (g && (g[0] !== 1 || g[1] !== 1 || g[2] !== 1)) return true;
  if (l && (l[0] !== 0 || l[1] !== 0 || l[2] !== 0)) return true;
  return false;
}

export const ProjectorScene: React.FC<{
  scene3D: Scene3D;
  modelUrls: Record<string, string>;
  calibration: ProjectorCalibration;
  /** Soft edge / colour match / solved rig blend for THIS output. Absent = no blend pass. */
  look?: BlendLook;
}> = ({ scene3D, modelUrls, calibration, look }) => {
  const meshes = (scene3D.models ?? []).filter(m => m.kind !== 'plane' && modelUrls[m.id]);
  const hasDistortion = !!calibration.distortion?.some(v => v !== 0);
  const wantsBlend = !!look && needsBlendPass(look);
  return (
    <Canvas gl={{ powerPreference: 'high-performance', antialias: true }} dpr={[1, 2]} style={{ width: '100%', height: '100%' }}>
      <color attach="background" args={['#000']} />
      <ambientLight intensity={1} />
      <CalibCamera calibration={calibration} />
      {meshes.map(m => <ProjectorModel key={m.id} model={m} url={modelUrls[m.id]} />)}
      {/* Distortion FIRST, blend LAST. Distortion maps the ideal pinhole render onto the real optics,
          so only after it does the framebuffer hold physical raster pixels — which is the space the
          blend map is indexed in. Reversing these puts the ramp a few pixels off the footprint edge,
          worsening with lens distortion, exactly where you would blame the lens instead. */}
      {(hasDistortion || wantsBlend) && (
        <EffectComposer>
          <>
            {hasDistortion && <Distortion calibration={calibration} />}
            {wantsBlend && <Blend look={look!} />}
          </>
        </EffectComposer>
      )}
    </Canvas>
  );
};
