import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

// PROJECTOR DEPTH — the pass that makes projected mapping OCCLUDE.
//
// projectedMapping.ts throws content onto venue geometry from a projector's viewpoint, but on its own
// it lights every fragment inside the frustum: a nearer surface did not shadow a farther one. A
// concave venue therefore sprayed content onto walls the projector physically cannot see, and a
// closed mesh got the picture on its far side. (The optional back-face cull is only a convex-object
// approximation of the same thing — it can answer "is this face turned away?", never "is something
// else in the way?".) This is the depth pass that lived in the plans as "Phase 6, deliberately
// unbuilt", and until it existed the shader's own comment was the only place the defect was recorded.
//
// HOW IT WORKS — a shadow map, with the projector standing in for the light:
//   1. Every venue object registers as a CASTER. The pass enables one extra render layer on its
//      meshes; they keep layer 0, so the main camera, the raycaster and the pick priority rules are
//      untouched.
//   2. Every material that wants occlusion registers a REQUEST carrying its projector matrix.
//      Requests are GROUPED BY THAT MATRIX, so twenty meshes projected from one projector cost one
//      pass, not twenty.
//   3. Per group we render the casters — and only the casters, via the layer mask — from the
//      projector, with an override material that packs the LINEAR distance to the projector into
//      RGBA8. Each requesting material gets the result as `uProjDepth`.
//
// WHY LINEAR DISTANCE AND NOT THE HARDWARE DEPTH BUFFER. A calibrated projector's GL matrix runs
// near=0.05 to far=200 (see the calibration plugin's projectedScene.ts), so hardware depth at venue
// range is squeezed into the last thousandth of [0,1] and a workable bias would be a number with six
// leading zeros — untunable by a human, and different for every venue. Packing `clip.w`, which for a
// perspective projection IS the distance along the projector's view axis, makes the bias A DISTANCE
// IN METRES. That is what the operator sets in the panel, and what they can reason about when a
// surface self-shadows.
//
// WHY A SEPARATE MODULE from projectedMapping.ts: that file is the ONE definition of the projection
// maths and is guarded as such. This is the ONE definition of the depth map, and it owns the packing
// convention both halves share (DEPTH_PACK_GLSL) — a second copy of a packing convention drifts, and
// the symptom would be content occluding at the wrong distance, which reads as a bad calibration.

/**
 * Render layer the depth pass draws. Casters are ADDED to it and keep layer 0, so enabling it changes
 * nothing about how anything else sees them. Nothing else in the app uses layers at all.
 */
const DEPTH_LAYER = 7;

/**
 * Metres. The range the packed distance is normalised over — NOT a clip plane, and deliberately not
 * derived from the projector matrix: "projected from view" bakes carry a viewer camera's far plane,
 * a calibrated projector carries 200, and the packing must mean the same thing in both. Geometry
 * beyond this reads as "nothing there", which is the safe direction (it occludes nothing).
 */
export const DEPTH_FAR = 250;

/**
 * One depth map is 1024² × RGBA8 = 4 MB. At a 4K projector that is roughly one depth texel per two
 * output pixels, which the metric bias absorbs; the alternative (2048²) quadruples both the memory
 * and the fill cost of a pass that may run for several projectors at once. Raise it if a silhouette
 * edge looks stepped rather than soft.
 */
const DEPTH_SIZE = 1024;

/**
 * Re-render a group at most this many frames after its last render, whatever the change detector
 * concluded. The detector watches caster world matrices and registration, which covers everything an
 * operator does — but it cannot see a geometry swapped underneath a stable object (the calibration
 * window's shaded/edges look does exactly that). Half a second of staleness in a case nobody hits,
 * against a pass that would otherwise run 60×/s for nothing.
 */
const REFRESH_FRAMES = 30;

/**
 * ONE definition of the depth packing, interpolated into BOTH the pass that writes it and the
 * projected-UV shader that reads it.
 *
 * A cleared texel is white, which unpacks to slightly MORE than 1.0 — i.e. beyond DEPTH_FAR. That is
 * the whole reason the clear colour is white and not black: an empty texel must mean "the projector
 * sees nothing here, so nothing is in the way". Black would unpack to zero and shadow the entire
 * scene, and the failure would look like the content had simply stopped working.
 */
export const DEPTH_PACK_GLSL = /* glsl */`
vec4 artluxPackDepth(float v) {
  // Clamped just below 1: fract(1.0 * 1.0) is 0, so an unclamped far fragment would pack as NEAR.
  vec4 artluxEnc = fract(clamp(v, 0.0, 0.999999) * vec4(1.0, 255.0, 65025.0, 16581375.0));
  artluxEnc -= artluxEnc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return artluxEnc;
}
float artluxUnpackDepth(vec4 p) {
  return dot(p, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
`;

// ── The caster registry ─────────────────────────────────────────────────────────────────────────

interface Caster {
  object: THREE.Object3D;
  /** Last world matrix this caster was rendered with — the change detector, see markGeometry(). */
  seen: Float32Array;
}

const casters = new Map<string, Caster>();
/** Bumped when the caster SET changes. */
let casterEpoch = 0;
/** Bumped when any caster has MOVED. */
let geomRev = 0;

/**
 * Add an object (and everything under it) to the depth pass. Register the object that carries the
 * geometry, not an outer wrapper: the pass compares its world matrix to decide whether anything
 * moved, and re-registering on a new object identity is what tells it a GLB finished loading.
 */
export function registerDepthCaster(id: string, object: THREE.Object3D): void {
  const prev = casters.get(id);
  if (prev?.object === object) return;
  if (prev) setDepthLayer(prev.object, false);
  casters.set(id, { object, seen: new Float32Array(16) });
  casterEpoch++;
}

export function unregisterDepthCaster(id: string): void {
  const c = casters.get(id);
  if (!c) return;
  // MUST clear the layer, not just forget the object. The pass renders the whole scene filtered by
  // the layer mask, so a stale object left on the layer would keep casting a shadow from geometry the
  // operator has already hidden or deleted.
  setDepthLayer(c.object, false);
  casters.delete(id);
  casterEpoch++;
}

function setDepthLayer(root: THREE.Object3D, on: boolean): void {
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    if (on) o.layers.enable(DEPTH_LAYER);
    else o.layers.disable(DEPTH_LAYER);
  });
}

// ── The request registry ────────────────────────────────────────────────────────────────────────

interface Request {
  /** Identity of the PROJECTOR, not of the model — this is what groups meshes onto one pass. */
  key: string;
  viewProj: number[];
  accept(tex: THREE.Texture | null): void;
  /** What `accept` was last given, so an unchanged map costs nothing per frame. */
  last: THREE.Texture | null;
}

const requests = new Map<string, Request>();

/**
 * Ask for (or stop asking for) a depth map matching `viewProj`. Pass null to withdraw — the consumer
 * is responsible for clearing its own uniform, because withdrawing happens on unmount and calling
 * back into a disposed material would be the one path that can throw here.
 */
export function setDepthRequest(
  id: string,
  req: { viewProj: readonly number[]; accept(tex: THREE.Texture | null): void } | null,
): void {
  if (!req || req.viewProj.length !== 16) { requests.delete(id); return; }
  const key = req.viewProj.join(',');
  const prev = requests.get(id);
  // Keep `last` across an update that did not change the projector, so a re-render of the consuming
  // component does not re-push an identical texture into the material.
  requests.set(id, {
    key,
    viewProj: [...req.viewProj],
    accept: req.accept,
    last: prev?.key === key ? prev.last : null,
  });
}

// ── The pass ────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  rt: THREE.WebGLRenderTarget;
  viewProj: number[];
  casterEpoch: number;
  geomRev: number;
  age: number;
}

// Keyed by RENDERER: a render target belongs to one GL context, and the editor window and a
// calibration projector window each mount their own Canvas. A single module-level cache would hand
// one window's texture to the other's renderer, which fails silently as a black (= fully occluding)
// map rather than as an error.
const perRenderer = new WeakMap<THREE.WebGLRenderer, Map<string, Entry>>();

let depthMaterial: THREE.ShaderMaterial | null = null;
let depthCamera: THREE.Camera | null = null;

function getDepthMaterial(): THREE.ShaderMaterial {
  if (depthMaterial) return depthMaterial;
  depthMaterial = new THREE.ShaderMaterial({
    // DoubleSide, and this matters: a venue GLB is very often an open single-sided shell. Culling its
    // back faces here would let the projector "see through" the shell and record the wall behind it,
    // so the shell would not shadow anything and the whole pass would silently do nothing on exactly
    // the geometry that needs it most.
    side: THREE.DoubleSide,
    uniforms: { uInvFar: { value: 1 / DEPTH_FAR } },
    // No skinning/morph chunks: a venue is static geometry. A skinned mesh would cast from its bind
    // pose — wrong, but it is also not a thing anyone projection-maps onto.
    vertexShader: /* glsl */`
      varying float vArtluxDist;
      void main() {
        vec4 artluxClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // clip.w of a perspective projection is the distance along the projector's view axis, which
        // is exactly what the fragment shader compares vProjPos.w against.
        vArtluxDist = artluxClip.w;
        gl_Position = artluxClip;
      }`,
    fragmentShader: /* glsl */`
      uniform float uInvFar;
      varying float vArtluxDist;
      ${DEPTH_PACK_GLSL}
      void main() { gl_FragColor = artluxPackDepth(vArtluxDist * uInvFar); }`,
  });
  return depthMaterial;
}

// A bare Camera whose PROJECTION matrix is the projector's whole world→clip matrix and whose view is
// left at identity. That is the trick that keeps this honest: `uvProjView` is already proj × view,
// and three renders with projectionMatrix × matrixWorldInverse, so a camera parked at the origin
// reproduces the exact matrix the fragment shader uses. Decomposing it into a position and an
// orientation would be a SECOND definition of the projector's pose — and an impossible one for a
// "projected from view" bake, which has a matrix and no pose at all.
function getDepthCamera(): THREE.Camera {
  if (depthCamera) return depthCamera;
  depthCamera = new THREE.Camera();
  depthCamera.layers.set(DEPTH_LAYER);
  return depthCamera;
}

function makeTarget(): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(DEPTH_SIZE, DEPTH_SIZE, {
    // NEAREST, and this is not a quality compromise to revisit: the four bytes ARE one number.
    // Linear filtering would average the BYTES of two packed distances and unpack the average as a
    // distance somewhere between nonsense and the far plane — the classic packed-depth artefact,
    // which shows up as a shimmering halo along every silhouette.
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  // The bytes are DATA, not colour. An sRGB tag here would have the sampler decode them on read and
  // the packed number would come back wrong by a gamma curve.
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.generateMipmaps = false;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

/**
 * Did anything move? Cheap by construction — sixteen float compares per caster, and
 * updateWorldMatrix(true, false) walks only this object's ancestors rather than the whole scene.
 */
function casterMatricesChanged(): boolean {
  let changed = false;
  for (const c of casters.values()) {
    c.object.updateWorldMatrix(true, false);
    const e = c.object.matrixWorld.elements;
    for (let i = 0; i < 16; i++) {
      if (c.seen[i] !== e[i]) { c.seen.set(e); changed = true; break; }
    }
  }
  return changed;
}

/**
 * Render every requested depth map. Called once per frame from inside the Canvas, BEFORE the normal
 * render — but it only actually draws when something changed, so a static venue with a static
 * projector costs one matrix comparison per frame and nothing on the GPU.
 */
export function renderProjectorDepth(gl: THREE.WebGLRenderer, scene: THREE.Scene): void {
  let store = perRenderer.get(gl);
  if (!store) { store = new Map(); perRenderer.set(gl, store); }

  if (requests.size === 0 || casters.size === 0) {
    if (store.size) { for (const e of store.values()) e.rt.dispose(); store.clear(); }
    for (const r of requests.values()) {
      if (r.last !== null) { r.last = null; r.accept(null); }
    }
    return;
  }

  if (casterMatricesChanged()) geomRev++;

  const wanted = new Map<string, number[]>();
  for (const r of requests.values()) if (!wanted.has(r.key)) wanted.set(r.key, r.viewProj);

  let rendered = 0;
  for (const [key, viewProj] of wanted) {
    let e = store.get(key);
    if (!e) { e = { rt: makeTarget(), viewProj, casterEpoch: -1, geomRev: -1, age: REFRESH_FRAMES }; store.set(key, e); }
    if (e.casterEpoch === casterEpoch && e.geomRev === geomRev && e.age < REFRESH_FRAMES) { e.age++; continue; }
    e.casterEpoch = casterEpoch; e.geomRev = geomRev; e.age = 0;
    if (rendered === 0) beginPass(gl, scene);
    rendered++;
    drawDepth(gl, scene, e.rt, viewProj);
  }
  if (rendered > 0) endPass(gl, scene);

  for (const r of requests.values()) {
    const tex = store.get(r.key)?.rt.texture ?? null;
    if (r.last !== tex) { r.last = tex; r.accept(tex); }
  }
  // Release maps nobody asks for any more — an operator switching a mesh from one projector to
  // another would otherwise leak 4 MB per switch for the life of the window.
  for (const [k, e] of store) if (!wanted.has(k)) { e.rt.dispose(); store.delete(k); }
}

// Renderer + scene state we borrow for the pass, restored by endPass. Module-level rather than
// returned, because the pass runs strictly between begin and end on one thread.
let saved: {
  target: THREE.WebGLRenderTarget | null;
  clear: THREE.Color;
  clearAlpha: number;
  autoClear: boolean;
  override: THREE.Material | null;
  background: THREE.Scene['background'];
} | null = null;

function beginPass(gl: THREE.WebGLRenderer, scene: THREE.Scene): void {
  saved = {
    target: gl.getRenderTarget(),
    clear: gl.getClearColor(new THREE.Color()),
    clearAlpha: gl.getClearAlpha(),
    autoClear: gl.autoClear,
    override: scene.overrideMaterial,
    background: scene.background,
  };
  for (const c of casters.values()) setDepthLayer(c.object, true);
  scene.overrideMaterial = getDepthMaterial();
  // THE BACKGROUND WOULD DESTROY THE MAP. three paints scene.background into whatever target it is
  // rendering to, ignoring the clear colour — and the projector window's scene has a solid black
  // background. Black unpacks to zero, i.e. "a surface 0 m from the projector", so every fragment in
  // the venue would test as occluded and ALL projected content would vanish. There is no error and
  // no warning; it just goes dark.
  scene.background = null;
  gl.autoClear = true;
  // White = beyond DEPTH_FAR = nothing in the way. See DEPTH_PACK_GLSL.
  gl.setClearColor(0xffffff, 1);
}

function drawDepth(gl: THREE.WebGLRenderer, scene: THREE.Scene, rt: THREE.WebGLRenderTarget, viewProj: number[]): void {
  const cam = getDepthCamera();
  cam.projectionMatrix.fromArray(viewProj);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  gl.setRenderTarget(rt);
  gl.render(scene, cam);
}

function endPass(gl: THREE.WebGLRenderer, scene: THREE.Scene): void {
  if (!saved) return;
  scene.overrideMaterial = saved.override;
  scene.background = saved.background;
  gl.setRenderTarget(saved.target);
  gl.setClearColor(saved.clear, saved.clearAlpha);
  gl.autoClear = saved.autoClear;
  saved = null;
}

/** Drop every map held for this renderer — its Canvas is going away. */
export function releaseProjectorDepth(gl: THREE.WebGLRenderer): void {
  const store = perRenderer.get(gl);
  if (!store) return;
  for (const e of store.values()) e.rt.dispose();
  store.clear();
  perRenderer.delete(gl);
}

/**
 * Drives the pass. Mount ONE of these inside any Canvas that renders projected-UV content — the
 * editor's Simulator3D and the calibration plugin's ProjectorScene. Without it the registries fill
 * up and nothing ever renders, so occlusion silently stays off.
 */
export function ProjectorDepthPass(): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  // Priority -1. r3f hands the render loop over to a subscriber only when one asks for a POSITIVE
  // priority (see its `internal.priority + (priority > 0 ? 1 : 0)`), so a negative one keeps the
  // automatic render intact and merely guarantees this runs before it — the map must be one frame
  // fresh, not one frame stale, or a dragged mesh would shadow from where it used to be.
  useFrame(() => { renderProjectorDepth(gl, scene); }, -1);
  useEffect(() => () => releaseProjectorDepth(gl), [gl]);
  return null;
}
