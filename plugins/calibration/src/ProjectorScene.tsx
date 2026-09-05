import React, { forwardRef, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { isWebGPURenderer } from '@/components/Simulator3D/renderer3d'; // host module — which renderer THIS window built
import { useGLTF } from '@react-three/drei';
import { EffectComposer } from '@react-three/postprocessing';
import { Effect } from 'postprocessing';
import * as THREE from 'three';
import type { Scene3D, SceneModel, ProjectorCalibration, ProjectorBlend, SoftEdge } from '../../../shared/protocol';
import { modelScaleXYZ } from '../../../shared/protocol';
import { cameraPose, glProjectionMatrix } from './cvCamera';
import { useLayerTexture } from '@/components/Simulator3D/useLayerTexture'; // host hook — transitional seam
import { blankMap } from '@/components/Simulator3D/blankMap'; // host helper — transitional seam
import { useStreamedSurfaceTexture } from './useStreamedSurfaceTexture';
import { makeProjectedMaterial, usesProjectedUv, usesProjectedOcclusion, DEFAULT_BIAS_M, type ProjectedMaterial, type ProjectedBasicMaterial } from '@/components/Simulator3D/projectedMapping'; // host module — the ONE projection definition
import { ProjectorDepthPass, registerDepthCaster, unregisterDepthCaster, setDepthRequest } from '@/components/Simulator3D/projectorDepth'; // host module — the ONE depth pass
import { recenterClone } from '@/components/Simulator3D/venuePlacement';   // host helper — same seam
import { FrameRateCap } from '@/components/Simulator3D/FrameRateCap';      // host module — the ONE rate cap
import { SOFT_EDGE_GLSL } from '@/projector/blendGlsl';                     // the ONE soft-edge ramp

const DEG = Math.PI / 180;
const NEAR = 0.05, FAR = 200;

/** How the venue is drawn from the projector: its materials, its crease edges, or every triangle. */
export type MeshLook = 'shaded' | 'edges' | 'wireframe';


// Hands this Canvas's DOM element to the projector window's base GL stage, so an operator can put a
// residual warp on the calibrated render — a solve is never perfect in a real venue, and the warp
// handles live in the host, not here. Lives INSIDE the Canvas on purpose: `useThree` sees the real
// element, and an effect gives a genuine unmount hook. An `onCreated` callback would say when the
// canvas appears and never when it goes away, leaving the host warping a dead element.
const PublishCanvas: React.FC<{ onCanvas: (c: HTMLCanvasElement | null) => void }> = ({ onCanvas }) => {
  const el = useThree((s) => s.gl.domElement) as HTMLCanvasElement;
  useEffect(() => { onCanvas(el); return () => onCanvas(null); }, [el, onCanvas]);
  return null;
};

// Renders the venue 3D scene from the matched virtual projector (true projection mapping). The camera
// is driven exactly from the calibration (position/orientation + an exact intrinsic projection matrix
// — see cvCamera), and a fullscreen post-pass applies the recovered lens distortion so the projected
// image matches the real optics. Mounted by ProjectorApp only for calibrated outputs in 'render' mode;
// otherwise the existing 2D-warp path is used. Models are placed identically to Simulator3D (recenter
// to bbox + transform) so world coords match the pose solve.

// How far two faces must diverge before their shared edge counts as a real edge of the object.
// 25° keeps a curved surface's tessellation quiet while every chamfer, panel seam and corner survives.
const CREASE_DEG = 25;

// THE CONTENT MATERIAL, shared by every kind of venue object.
//
// A screen and a GLB differ in exactly one thing — where the geometry comes from (generated vs loaded
// from `path`). Content binding, the authored/projected material pair, the ImageBitmap flip and the
// projector uniforms are identical, so they live here once rather than being written twice. The
// `kind` field stays in the project file as the geometry selector; only BEHAVIOUR is unified.
// ProjectedBasicMaterial, not MeshBasicMaterial: the projected twin is a MeshBasicNodeMaterial on the
// WebGPU path — a sibling class, not a subclass. Both satisfy what a mesh and this file actually need.
function useContentMaterial(model: SceneModel): { material: ProjectedBasicMaterial; hasContent: boolean } {
  const layerMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  // Born WITH a map — blankMap.ts. This window is on WebGL today, so it is not the one that froze; the
  // rule is kept identical in both because `renderer3d` is one flag away from putting it on WebGPU too,
  // and because assigning null back to a WATCHED map throws inside three's render loop.
  if (!layerMatRef.current) layerMatRef.current = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false, side: THREE.DoubleSide, map: blankMap() });
  // The projected-UV twin, from the SAME shared module the editor uses — one definition of the
  // projection maths and of the V convention, so the two windows cannot disagree.
  const projMatRef = useRef<ProjectedMaterial | null>(null);
  // This window builds its OWN WebGL renderer, so it must say so — inferring from module state is
  // what turned the projector output black once the TSL modules began preloading. See
  // makeProjectedMaterial.
  const glNodes = isWebGPURenderer(useThree((st) => st.gl));
  if (!projMatRef.current) projMatRef.current = makeProjectedMaterial(glNodes);
  const projected = usesProjectedUv(model);

  const applyTex = (tex: THREE.Texture | null) => {
    for (const mat of [layerMatRef.current!, projMatRef.current!.material]) {
      mat.map = tex ?? blankMap(); mat.color.set(tex ? '#ffffff' : '#161616'); mat.needsUpdate = true;
    }
    // Fragment-computed UVs bypass three's vertex-stage texture matrix, which is where
    // matchBitmapOrientation's ImageBitmap flip compensation lives. Mirror it into the uniforms or the
    // content lands upside down ON THE REAL PROJECTOR with the geometry perfectly aligned.
    projMatRef.current!.syncMapTransform(tex);
  };
  useLayerTexture(model.layerId, applyTex);

  // SURFACE binding: ANY surface, not just this window's own. Main streams a render-active output
  // exactly what its visible geometry references (see App's frame pump) — the output's own surface is
  // simply one more entry in that set, and it stays free because the base canvas is already sent it.
  // A layer binding wins when both are somehow set, and the hook is inert without an id, so exactly
  // one of the two ever writes the map. Mirrors ModelObject's pair in the editor.
  const wantsSurface = !model.layerId && !!model.surfaceId;
  useStreamedSurfaceTexture(wantsSurface ? model.surfaceId : undefined, applyTex);

  // The projecting camera arrives already resolved on the `scene` message (App runs
  // resolveProjectedScene — a projector window holds only its OWN calibration and could never resolve
  // another output's). So this is an effect, not a useFrame: it changes at operator rate.
  useEffect(() => {
    if (!projected) return;
    const pm = projMatRef.current!;
    pm.setProjector(new THREE.Matrix4().fromArray(model.uvProjView!),
      new THREE.Vector3(...(model.uvProjEye ?? [0, 0, 0])));
    pm.setLook(model.uvProjSoft ?? 0, !!model.uvProjCull);
    // Keyed on the projection FIELDS, not on the model object: a re-render that only moved the mesh
    // must not rebuild uniforms, and nothing here should depend on the caller keeping model identity
    // stable. resolveProjectedScene returns models by identity when unchanged, so these are stable.
  }, [projected, model.uvProjView, model.uvProjEye, model.uvProjSoft, model.uvProjCull]);

  // OCCLUSION — ask the depth pass for this projector's map. The CASTING half is registered by the
  // geometry components below, because only they hold the object; this half is the same in both.
  // The pass is the host's, so the wall and the editor shadow identically — the same reason the
  // projection maths itself is imported rather than re-typed.
  useEffect(() => {
    const pm = projMatRef.current!;
    const bias = model.uvProjBias ?? DEFAULT_BIAS_M;
    if (!usesProjectedOcclusion(model)) {
      setDepthRequest(model.id, null);
      pm.setOcclusion(null, bias);
      return;
    }
    setDepthRequest(model.id, {
      viewProj: model.uvProjView!,
      accept: (tex) => pm.setOcclusion(tex, model.uvProjBias ?? DEFAULT_BIAS_M),
    });
    return () => setDepthRequest(model.id, null);
  }, [model.id, projected, model.uvProjView, model.uvProjOccludeOff, model.uvProjBias]);

  useEffect(() => () => { layerMatRef.current?.dispose(); projMatRef.current?.dispose(); }, []);

  return {
    material: projected ? projMatRef.current!.material : layerMatRef.current!,
    hasContent: !!model.layerId || wantsSurface,
  };
}

// A flat screen. Geometry and sizing lifted verbatim from the editor's PlaneObject — the 16:9 base
// times the per-axis scale IS the convention, so re-deriving it would land a different size here than
// the operator sees in the 3D view. DoubleSide because a screen viewed from behind should still show.
// No material restore: a plane has no authored materials to put back.
const ProjectorPlane: React.FC<{ model: SceneModel; meshLook?: MeshLook }> = ({ model, meshLook = 'shaded' }) => {
  const { material } = useContentMaterial(model);
  const groupRef = useRef<THREE.Group>(null);
  const wireMatRef = useRef<THREE.LineBasicMaterial | null>(null);
  if (!wireMatRef.current) wireMatRef.current = new THREE.LineBasicMaterial({ color: '#00ffaa', toneMapped: false });
  // A screen casts into the depth map: it is usually the nearest thing to the projector, so without
  // it content would land on the wall behind a screen that is physically blocking the light.
  useEffect(() => {
    const g = groupRef.current;
    if (!g || !model.visible) return;
    registerDepthCaster(model.id, g);
    return () => unregisterDepthCaster(model.id);
  }, [model.id, model.visible, meshLook]);
  // A screen's four borders are a genuinely useful alignment reference — it is already a first-class
  // calibration pick target — so the verify looks must not leave a hole where the screen is.
  const border = useMemo(() => new THREE.EdgesGeometry(new THREE.PlaneGeometry(16 / 9, 1)), []);
  useEffect(() => () => { border.dispose(); wireMatRef.current?.dispose(); }, [border]);

  if (!model.visible) return null;
  return (
    <group
      ref={groupRef}
      position={[model.position.x, model.position.y, model.position.z]}
      rotation={[model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG]}
      scale={modelScaleXYZ(model)}
    >
      {meshLook === 'shaded'
        ? <mesh material={material}><planeGeometry args={[16 / 9, 1]} /></mesh>
        : <lineSegments geometry={border} material={wireMatRef.current!} />}
    </group>
  );
};

// One GLB venue mesh, placed to match Simulator3D exactly; optional timeline-layer texture (Phase A)
// or SURFACE texture — see `surfaceFrame`, which is this window's own streamed picture.
const ProjectorModel: React.FC<{ model: SceneModel; url: string; meshLook?: MeshLook }> = ({ model, url, meshLook = 'shaded' }) => {
  const { scene } = useGLTF(url);
  const { material, hasContent } = useContentMaterial(model);
  // One material for both looks: LineSegments and a wireframe Mesh both draw lines from it.
  const wireMatRef = useRef<THREE.MeshBasicMaterial | null>(null);
  if (!wireMatRef.current) wireMatRef.current = new THREE.MeshBasicMaterial({ color: '#00ffaa', wireframe: true, toneMapped: false });
  // Vertex dots on the wire look: the 3D-side pick snaps to vertices, so lighting the vertices on the
  // REAL object shows the operator exactly which physical spots have a model counterpart to aim at.
  const ptsMatRef = useRef<THREE.PointsMaterial | null>(null);
  if (!ptsMatRef.current) ptsMatRef.current = new THREE.PointsMaterial({ color: '#ffcc00', size: 5, sizeAttenuation: false, toneMapped: false });

  // Same recentre as ModelObject → identical world coords, because it is literally the same function.
  const cloned = useMemo(() => recenterClone(scene), [scene]);

  // Casts into the projector depth map. Unconditional, and independent of whether THIS mesh reads
  // one: a mesh with no content of its own still stands in front of one that has some, and must
  // shadow it. `cloned` rather than the outer group, so re-registering on a GLB swap is what tells
  // the pass to redraw. (In the wire verify looks `cloned` is hidden, so nothing casts — correct:
  // those looks draw edges, not content, and there is nothing to occlude.)
  useEffect(() => {
    if (!model.visible) return;
    registerDepthCaster(model.id, cloned);
    return () => unregisterDepthCaster(model.id);
  }, [model.id, model.visible, cloned]);

  // The verify look, drawn INSTEAD of the shaded mesh. Materials are legitimately near-black here —
  // a bound content layer isn't streamed to render-mode windows, and metallic CAD GLBs go dark
  // without an environment — and verify is about edges landing on edges, which bright lines show
  // regardless of what the mesh is made of.
  //
  // 'edges' (the default) draws only CREASE edges — the object's actual silhouette and panel lines.
  // A full wireframe of a tessellated CAD mesh is a haze of triangles you cannot align anything to;
  // the outline is what the eye matches against the real object. 'wireframe' keeps the old look for
  // meshes so coarse that every triangle IS an edge.
  //
  // Built as a flat group of line objects with each source mesh's matrix baked in, rather than a
  // clone with swapped materials: EdgesGeometry replaces the geometry, so there is nothing to swap.
  // The matrix is accumulated down from `cloned` (NOT matrixWorld) because this group is mounted as
  // its sibling — matrixWorld would apply the outer model transform a second time.
  const wireClone = useMemo(() => {
    if (meshLook === 'shaded') return null;
    const root = new THREE.Group();
    const walk = (obj: THREE.Object3D, parentMat: THREE.Matrix4) => {
      const mat = parentMat.clone().multiply(obj.matrix);
      const m = obj as THREE.Mesh;
      if ((m as { isMesh?: boolean }).isMesh && m.geometry) {
        const geo = meshLook === 'edges'
          ? new THREE.EdgesGeometry(m.geometry as THREE.BufferGeometry, CREASE_DEG)
          : null;
        const line = geo
          ? new THREE.LineSegments(geo, wireMatRef.current!)
          : new THREE.Mesh(m.geometry, wireMatRef.current!);
        line.applyMatrix4(mat);
        root.add(line);
        // Dots on the CREASE endpoints, not on every vertex. Drawing a point per mesh vertex is a
        // few hundred thousand sprites per frame on a real CAD venue — it was the single most
        // expensive thing on screen, and it also drew a dot on every tessellation vertex in the
        // middle of a flat panel, which is not a point anybody picks. The crease set IS the corners.
        // (Wireframe mode gets none: every vertex is already an edge junction there.)
        if (geo) {
          const dots = new THREE.Points(geo, ptsMatRef.current!);
          dots.applyMatrix4(mat);
          root.add(dots);
        }
      }
      for (const c of obj.children) walk(c, mat);
    };
    walk(cloned, new THREE.Matrix4());
    return root;
  }, [cloned, meshLook]);

  // EdgesGeometry allocates per mesh — release the ones this look built when it changes/unmounts.
  // Points SHARE the LineSegments' geometry, so dispose once per line and never per point.
  useEffect(() => () => {
    wireClone?.traverse((o) => {
      const l = o as THREE.LineSegments;
      if ((l as { isLineSegments?: boolean }).isLineSegments) l.geometry.dispose();
    });
  }, [wireClone]);

  // Swap in the content material — and swap the GLB's own materials BACK when the binding clears.
  // The restore half was missing: clearing a binding left the mesh on the flat #161616 material for
  // the rest of the session. Invisible while bindings were static, immediately visible now that an
  // operator can change one and watch the projector. Mirrors ModelObject's origMats.
  const origMats = useRef<Map<string, THREE.Material | THREE.Material[]>>(new Map());
  useEffect(() => {
    cloned.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      if (hasContent) {
        if (!origMats.current.has(mesh.uuid)) origMats.current.set(mesh.uuid, mesh.material);
        mesh.material = material;
      } else {
        const orig = origMats.current.get(mesh.uuid);
        if (orig) { mesh.material = orig; origMats.current.delete(mesh.uuid); }
      }
    });
  }, [cloned, hasContent, material]);

  useEffect(() => () => { wireMatRef.current?.dispose(); ptsMatRef.current?.dispose(); }, []);

  if (!model.visible) return null;
  return (
    <group
      position={[model.position.x, model.position.y, model.position.z]}
      rotation={[model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG]}
      scale={modelScaleXYZ(model)}
    >
      <primitive object={cloned} visible={meshLook === 'shaded'} />
      {wireClone && <primitive object={wireClone} />}
    </group>
  );
};

// In 'demand' mode R3F draws only when asked. A new solve arrives as a prop, not as scene-graph
// churn, so ask explicitly — otherwise the underlay would freeze at whatever it last drew.
const RedrawOn: React.FC<{ dep: unknown }> = ({ dep }) => {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [dep, invalidate]);
  return null;
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
  /** Verify look: the venue's materials, its crease edges, or a full wireframe (see wireClone). */
  meshLook?: MeshLook;
  /** 'demand' renders only when something changes — correct for the PICKING underlay, whose picture
   *  moves only when the solve does (a few times a second while dragging, never while thinking).
   *  Render mode stays 'always': it plays content. Left as a prop rather than inferred, because
   *  getting it wrong in the show direction would freeze a projector. */
  frameloop?: 'always' | 'demand';
  /** The output's frame-rate ceiling (`ProjectData.projectorFpsCap`; 0 = uncapped), from the host's
   *  panel context. THIS is the expensive Canvas: the host's warp/blend stage already honoured the
   *  cap, but this scene did not, so "performance mode" throttled the cheap half and left a full venue
   *  render — plus the depth pass and two post effects — running at display rate. Measured on the dev
   *  laptop: a calibrated output open put the WHOLE app at 17.6 fps, including editor contexts drawing
   *  no 3D at all, against 60 with it closed. Ignored in 'demand' mode, which is already event-driven. */
  fpsCap?: number;
  /** Offer this Canvas to the projector window's base GL stage so a residual warp can be applied to
   *  the calibrated render (see PublishCanvas). Set ONLY for render mode — never for the crosshair
   *  underlay, whose pixels are an aiming reference that must stay in true projector raster. */
  onCanvas?: (c: HTMLCanvasElement | null) => void;
}> = ({ scene3D, modelUrls, calibration, look, meshLook, frameloop = 'always', fpsCap = 0, onCanvas }) => {
  // A screen authored as a projection PLANE used to be filtered out here entirely, so nothing bound
  // to one could ever appear on a calibrated output — on a venue built mostly of flat screens the
  // render was simply empty. `modelUrls` still gates meshes only: a GLB that has not loaded yet must
  // not mount, whereas a plane has no file to wait for.
  const meshes = (scene3D.models ?? []).filter(m => m.kind !== 'plane' && modelUrls[m.id]);
  const planes = (scene3D.models ?? []).filter(m => m.kind === 'plane');
  const hasDistortion = !!calibration.distortion?.some(v => v !== 0);
  const wantsBlend = !!look && needsBlendPass(look);
  // A cap only means anything on the loop that runs every frame. 'demand' already draws on change.
  const capped = frameloop === 'always' && fpsCap > 0;
  return (
    <Canvas
      frameloop={capped ? 'never' : frameloop}
      // preserveDrawingBuffer ONLY when the host may read this canvas. A WebGL drawing buffer is
      // cleared once presented to the compositor, and the host's loop and this Canvas run on two
      // INDEPENDENT rAFs with no ordering between them — without it the host intermittently samples a
      // cleared buffer and the projector flickers black, which reads as a dead producer rather than a
      // warp bug. It costs a stable copy, so it stays off on the path that is never read.
      gl={{ powerPreference: 'high-performance', antialias: true, preserveDrawingBuffer: !!onCanvas }}
      dpr={[1, 2]}
      style={{ width: '100%', height: '100%' }}
    >
      {onCanvas && <PublishCanvas onCanvas={onCanvas} />}
      {/* The host's shared driver — one implementation with the editor viewport, so a 30 fps cap does
          not silently deliver 20 in one window and not the other. See FrameRateCap.tsx. */}
      {capped && <FrameRateCap hz={fpsCap} />}
      {frameloop === 'demand' && <RedrawOn dep={calibration} />}
      <color attach="background" args={['#000']} />
      {/* Same rig as Simulator3D's Lighting (env look) — ambient alone left standard materials darker
          here than in the editor, which read as "the render shows nothing" on dim GLBs. */}
      <ambientLight intensity={0.8} />
      <hemisphereLight intensity={0.7} groundColor="#101010" />
      <CalibCamera calibration={calibration} />
      {/* Renders the depth maps that make projected mapping occlude — the host's pass, so the wall
          and the editor shadow identically. Only draws when the venue or a projector moved. */}
      <ProjectorDepthPass />
      {meshes.map(m => <ProjectorModel key={m.id} model={m} url={modelUrls[m.id]} meshLook={meshLook} />)}
      {planes.map(m => <ProjectorPlane key={m.id} model={m} meshLook={meshLook} />)}
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
