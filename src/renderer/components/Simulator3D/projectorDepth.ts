import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { nodes, isWebGPURenderer } from './renderer3d';

// The pass runs on whichever renderer the Canvas was given. Both expose setRenderTarget/render/
// autoClear/clear-colour, which is everything it borrows — so it is typed by what it USES rather than
// by WebGLRenderer, and the WebGPU renderer satisfies it without a cast.
// Written out structurally rather than Pick<WebGLRenderer, ...> so the render target is the
// renderer-agnostic THREE.RenderTarget. WebGLRenderer's own signature demands a WebGLRenderTarget,
// which would drag the WebGL type back in through the one member that has to be shared.
// Declared as METHODS (not function-typed properties) so TS's bivariance lets both real renderers
// satisfy it; `render` covers WebGPURenderer returning a promise.
export type DepthRenderer = {
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
  getRenderTarget(): THREE.WebGLRenderTarget | null;
  render(scene: THREE.Scene, camera: THREE.Camera): void | Promise<void>;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  getSize(target: THREE.Vector2): THREE.Vector2;
  autoClear: boolean;
};

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
/**
 * Targets waiting to be freed, with a frame countdown.
 *
 * A render target may NOT be disposed while a submitted command buffer still references it — WebGPU
 * rejects the whole submit with "Destroyed texture used in a submit", and the frame is dropped. That
 * happens routinely here: the pass writes a map and the very next frame can drop the request (an
 * operator toggling a model off projected UVs), which freed the texture out from under work already
 * queued. WebGL's driver silently kept it alive, so this only ever showed up on WebGPU.
 *
 * Two frames is enough — the queue is at most one frame deep — and a 4 MB target lingering for 33 ms
 * costs nothing.
 */
const graveyard: Array<{ rt: THREE.WebGLRenderTarget; ttl: number }> = [];
function retire(rt: THREE.WebGLRenderTarget): void { graveyard.push({ rt, ttl: 2 }); }
function reapGraveyard(): void {
  for (let i = graveyard.length - 1; i >= 0; i--) {
    if (--graveyard[i].ttl > 0) continue;
    graveyard[i].rt.dispose();
    graveyard.splice(i, 1);
  }
}

/** WebGPU pipeline warm-up for the depth material — see renderProjectorDepth. */
let warm: 'cold' | 'warming' | 'ready' = 'cold';
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
  if (prev) detachProxies(prev.object);
  casters.set(id, { object, seen: new Float32Array(16) });
  casterEpoch++;
}

/**
 * The venue objects currently registered as casters — the same set this pass shadows from, reused by
 * the one-shot bake (projectorBake.ts) so a calibration file describes exactly the geometry the
 * editor occludes against. Two registries would drift, and the symptom would be a baked map that
 * disagrees with the preview about what is in front of what.
 */
export function registeredCasters(): THREE.Object3D[] {
  return [...casters.values()].map((c) => c.object);
}

export function unregisterDepthCaster(id: string): void {
  const c = casters.get(id);
  if (!c) return;
  // MUST clear the layer, not just forget the object. The pass renders the whole scene filtered by
  // the layer mask, so a stale object left on the layer would keep casting a shadow from geometry the
  // operator has already hidden or deleted.
  detachProxies(c.object);
  casters.delete(id);
  casterEpoch++;
}

/** Marks a mesh as one of ours, so re-registering a caster never proxies a proxy. */
const PROXY_FLAG = 'artluxDepthProxy';

/**
 * Give every mesh under `root` a depth-only PROXY: a sibling mesh sharing its geometry, carrying the
 * depth material, living on DEPTH_LAYER *only*. The main camera renders layer 0 and therefore never
 * sees them; the depth camera renders layer 7 and sees nothing else.
 *
 * WHY A PROXY, AND NOT `scene.overrideMaterial` (nor swapping each mesh's material and putting it
 * back): on a WebGPURenderer, rendering the scene a second time with DIFFERENT materials on its
 * objects leaves the whole scene unable to draw — every object disappears, including ones this pass
 * never touched, with no error and no warning. Bisected three ways: render the casters with their OWN
 * materials and the viewport is fine; swap in any other material — even a bare MeshBasicNodeMaterial
 * with no colorNode — and the next frame is black. A proxy never mutates an existing object, so the
 * question does not arise, and the pass stops borrowing scene state it has to remember to give back.
 *
 * Parented to the caster mesh, so the world matrix tracks for free — no mirroring, and it stays true
 * for a GLB whose parts move independently.
 */
function attachProxies(root: THREE.Object3D, material: THREE.Material): void {
  const add: Array<[THREE.Mesh, THREE.Mesh]> = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    if (mesh.userData[PROXY_FLAG]) return;                          // never proxy a proxy
    if (mesh.children.some((c) => c.userData[PROXY_FLAG])) return;  // already has one
    const proxy = new THREE.Mesh(mesh.geometry, material);
    proxy.userData[PROXY_FLAG] = true;
    proxy.layers.set(DEPTH_LAYER);   // ONLY layer 7 — invisible to the main camera and the raycaster
    proxy.raycast = () => { /* never pickable — see Simulator3D's pick-priority rules */ };
    proxy.frustumCulled = false;
    add.push([mesh, proxy]);
  });
  for (const [mesh, proxy] of add) mesh.add(proxy);
}

function detachProxies(root: THREE.Object3D): void {
  const kill: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.userData[PROXY_FLAG]) kill.push(o); });
  for (const o of kill) o.removeFromParent();
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
  /**
   * TWO targets, written alternately, and the material always samples the one written LAST FRAME.
   *
   * WebGPU forbids a texture being a render attachment and a sampled binding in the same
   * synchronization scope, and three batches this pass and the main render into one command encoder —
   * so publishing the map in the frame it was written invalidated the whole command buffer
   * ("usage includes writable usage and another usage in the same synchronization scope"). WebGL
   * tolerated exactly the same thing silently, which is why it never showed up before.
   *
   * The cost is 8 MB per projector group instead of 4, and one frame of latency on the map. The
   * latency is invisible: the pass is change-gated and re-renders the moment anything moves, and the
   * initial state — both targets cleared to white — already means "nothing is in the way", which is
   * the safe direction this file's clear colour was chosen for.
   */
  rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  write: 0 | 1;
  /** Written this frame; becomes `ready` at the start of the next call. */
  pending: THREE.WebGLRenderTarget | null;
  /** What consumers may safely sample. */
  ready: THREE.WebGLRenderTarget | null;
  viewProj: number[];
  casterEpoch: number;
  geomRev: number;
  age: number;
}

// Keyed by RENDERER: a render target belongs to one GL context, and the editor window and a
// calibration projector window each mount their own Canvas. A single module-level cache would hand
// one window's texture to the other's renderer, which fails silently as a black (= fully occluding)
// map rather than as an error.
const perRenderer = new WeakMap<object, Map<string, Entry>>();

let depthMaterial: THREE.Material | null = null;
let depthCamera: THREE.Camera | null = null;

/**
 * The override material for the pass. TWO implementations of one convention, chosen by renderer,
 * because a `NodeMaterial` cannot render on a plain `WebGLRenderer` and this module is mounted in BOTH
 * windows — the editor viewport (WebGPU when the spike flag is on) and the calibration projector
 * window (still WebGL). See artluxPackDepthTSL for how the two are held together.
 */
function getDepthMaterial(webgpu: boolean): THREE.Material {
  if (depthMaterial) return depthMaterial;
  depthMaterial = webgpu ? makeDepthNodeMaterial() : makeDepthShaderMaterial();
  return depthMaterial;
}

function makeDepthShaderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
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
}

/**
 * The WebGPU twin. Same maths, same packing, expressed as nodes.
 *
 * NO custom vertex stage is needed, and that is a consequence of getDepthCamera()'s design rather than
 * luck: the camera's projection matrix IS the projector's world→clip and its view is identity, so the
 * DEFAULT node transform already lands each fragment where the GLSL version put it.
 *
 * The distance is recomputed per fragment from `positionView` instead of being interpolated as a
 * varying. With an identity view, view space IS world space, so `projection × vec4(positionView, 1)`
 * has the same `.w` the GLSL path interpolates — and computing it per fragment is if anything the more
 * exact of the two.
 */
function makeDepthNodeMaterial(): THREE.Material {
  const mods = nodes();
  if (!mods) throw new Error('projectorDepth: node modules unavailable on a WebGPU renderer');
  const { MeshBasicNodeMaterial } = mods.webgpu;
  const { vec4, positionView, cameraProjectionMatrix, float } = mods.tsl;

  const mat = new MeshBasicNodeMaterial();
  mat.side = THREE.DoubleSide; // an open venue shell must still occlude — see the GLSL twin
  mat.toneMapped = false;      // the four bytes are DATA; a tone curve would corrupt the number
  mat.transparent = false;
  const clipW = cameraProjectionMatrix.mul(vec4(positionView, float(1))).w;
  mat.colorNode = artluxPackDepthTSL(mods.tsl, clipW.mul(float(1 / DEPTH_FAR)));
  return mat;
}

/**
 * ⚠ THE SECOND EXPRESSION OF `DEPTH_PACK_GLSL`, and it must stay numerically identical to it.
 *
 * This module's own doctrine is that the packing convention has ONE definition, because two copies
 * drift and the symptom — content occluding at the wrong distance — reads as a bad calibration rather
 * than as a shader bug. That rule cannot be met literally once one window renders with GLSL and the
 * other with nodes, so the next best thing is done instead: the two live side by side, share the four
 * coefficients below, and `verify:invariants` fails if either drifts from the other.
 *
 * The reader half (`artluxUnpackDepth`) needs no twin: projectedMapping's node port calls its own
 * unpack built from these same constants.
 */
export const DEPTH_PACK_COEFFS = [1, 255, 65025, 16581375] as const;

function artluxPackDepthTSL(tsl: NonNullable<ReturnType<typeof nodes>>['tsl'], v: unknown) {
  const { vec4, fract, clamp, float } = tsl;
  const [a, b, c, d] = DEPTH_PACK_COEFFS;
  // Clamped just below 1 for the same reason as the GLSL: fract(1.0) is 0, so an unclamped far
  // fragment would pack as NEAR — the worst possible failure, since it occludes everything.
  const enc = fract(clamp(v as never, float(0), float(0.999999)).mul(vec4(a, b, c, d)));
  return enc.sub(enc.yzww.mul(vec4(1 / 255, 1 / 255, 1 / 255, 0)));
}

// A bare Camera whose PROJECTION matrix is the projector's whole world→clip matrix and whose view is
// left at identity. That is the trick that keeps this honest: `uvProjView` is already proj × view,
// and three renders with projectionMatrix × matrixWorldInverse, so a camera parked at the origin
// reproduces the exact matrix the fragment shader uses. Decomposing it into a position and an
// orientation would be a SECOND definition of the projector's pose — and an impossible one for a
// "projected from view" bake, which has a matrix and no pose at all.
class DepthCamera extends THREE.Camera {
  /**
   * MUST be a no-op, and must EXIST.
   *
   * `THREE.Camera` does not define `updateProjectionMatrix` — only PerspectiveCamera and
   * OrthographicCamera do, by recomputing the matrix from fov/near/far. WebGLRenderer never calls it,
   * so a bare Camera worked; WebGPURenderer calls it on every render, which threw here once per frame
   * and killed the pass.
   *
   * Defining it to recompute anything would be worse than the crash: this camera HAS no fov, near or
   * far. Its projection matrix is assigned wholesale in drawDepth from the projector's world→clip
   * matrix, which is the one definition of the projector's pose (see the comment above). Any
   * "recalculation" would silently replace it with a camera that does not exist, and the depth map
   * would be measured from the wrong place — visible only as content occluding where it should not.
   */
  // No `override`: the base class genuinely does not declare it (that IS the bug this fixes).
  updateProjectionMatrix(): void { /* intentionally empty — see drawDepth */ }
}

function getDepthCamera(): THREE.Camera {
  if (depthCamera) return depthCamera;
  depthCamera = new DepthCamera();
  depthCamera.layers.set(DEPTH_LAYER);
  return depthCamera;
}

// Still WebGLRenderTarget, and that is correct on BOTH backends despite the name: it is a two-line
// subclass of THREE.RenderTarget that adds an `isWebGLRenderTarget` marker and nothing else, so the
// WebGPU renderer takes it as the plain RenderTarget it is. Using the base class instead would satisfy
// WebGPU and stop typechecking against WebGLRenderer, for no runtime gain.
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
export function renderProjectorDepth(gl: DepthRenderer, scene: THREE.Scene): void {
  // WEBGPU: THE PIPELINE MUST EXIST BEFORE THE PASS USES IT.
  //
  // WebGPU compiles render pipelines asynchronously. `renderer.render()` is therefore only
  // synchronous for a material it has already compiled — for a brand-new one it returns while the
  // work is still pending, and this pass then runs `endPass` underneath it, putting the render target
  // and clear colour back before the render that needed them has happened. The canvas went black from
  // the next frame on, scene-wide, with no error and no WebGPU validation message.
  //
  // Ruled out first, each by measurement rather than argument: the depth camera (a separate crash,
  // fixed above), `scene.overrideMaterial` (replaced by proxies — no change), mutating existing
  // meshes' materials (proxies never touch them — no change), and the packed-depth node graph itself
  // (a bare MeshBasicNodeMaterial with no colorNode blacks it too). Rendering to a target is fine on
  // its own: with the casters' OWN — already-compiled — materials the pass runs and the viewport is
  // perfect. "Already compiled" is the whole difference, which is what points here.
  //
  // So: attach the proxies, compile them once, and draw nothing until that finishes. One or two
  // frames without a depth map at startup is invisible; the map is change-gated and re-rendered the
  // moment anything moves.
  if (isWebGPURenderer(gl)) {
    if (warm === 'cold') {
      warm = 'warming';
      const depth = getDepthMaterial(true);
      for (const c of casters.values()) attachProxies(c.object, depth);
      const compiler = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown> };
      const done = () => { warm = 'ready'; };
      // No compileAsync (older three) → go straight to ready rather than never rendering at all.
      if (compiler.compileAsync) void compiler.compileAsync(scene, getDepthCamera()).then(done, done);
      else done();
    }
    if (warm !== 'ready') return;
  }

  let store = perRenderer.get(gl);
  if (!store) { store = new Map(); perRenderer.set(gl, store); }

  if (requests.size === 0 || casters.size === 0) {
    reapGraveyard();
    if (store.size) { for (const e of store.values()) for (const rt of e.rts) retire(rt); store.clear(); }
    for (const r of requests.values()) {
      if (r.last !== null) { r.last = null; r.accept(null); }
    }
    return;
  }

  reapGraveyard();

  // Last frame's write becomes this frame's readable map — see Entry.rts.
  for (const e of store.values()) if (e.pending) { e.ready = e.pending; e.pending = null; }

  if (casterMatricesChanged()) geomRev++;

  const wanted = new Map<string, number[]>();
  for (const r of requests.values()) if (!wanted.has(r.key)) wanted.set(r.key, r.viewProj);

  let rendered = 0;
  for (const [key, viewProj] of wanted) {
    let e = store.get(key);
    if (!e) { e = { rts: [makeTarget(), makeTarget()], write: 0, pending: null, ready: null, viewProj, casterEpoch: -1, geomRev: -1, age: REFRESH_FRAMES }; store.set(key, e); }
    if (e.casterEpoch === casterEpoch && e.geomRev === geomRev && e.age < REFRESH_FRAMES) { e.age++; continue; }
    e.casterEpoch = casterEpoch; e.geomRev = geomRev; e.age = 0;
    if (rendered === 0) beginPass(gl, scene);
    rendered++;
    drawDepth(gl, scene, e.rts[e.write], viewProj);
    e.pending = e.rts[e.write];
    e.write = e.write === 0 ? 1 : 0;
  }
  if (rendered > 0) endPass(gl, scene);


  for (const r of requests.values()) {
    const tex = store.get(r.key)?.ready?.texture ?? null;
    if (r.last !== tex) { r.last = tex; r.accept(tex); }
  }
  // Release maps nobody asks for any more — an operator switching a mesh from one projector to
  // another would otherwise leak 4 MB per switch for the life of the window.
  for (const [k, e] of store) if (!wanted.has(k)) { for (const rt of e.rts) retire(rt); store.delete(k); }
}

// Renderer + scene state we borrow for the pass, restored by endPass. Module-level rather than
// returned, because the pass runs strictly between begin and end on one thread.
let saved: {
  target: THREE.WebGLRenderTarget | null;
  clear: THREE.Color;
  clearAlpha: number;
  autoClear: boolean;
  background: THREE.Scene['background'];
} | null = null;

function beginPass(gl: DepthRenderer, scene: THREE.Scene): void {
  saved = {
    target: gl.getRenderTarget(),
    clear: gl.getClearColor(new THREE.Color()),
    clearAlpha: gl.getClearAlpha(),
    autoClear: gl.autoClear,
    background: scene.background,
  };
  const depth = getDepthMaterial(isWebGPURenderer(gl));
  for (const c of casters.values()) attachProxies(c.object, depth);
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

function drawDepth(gl: DepthRenderer, scene: THREE.Scene, rt: THREE.WebGLRenderTarget, viewProj: number[]): void {
  const cam = getDepthCamera();
  cam.projectionMatrix.fromArray(viewProj);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  gl.setRenderTarget(rt);
  gl.render(scene, cam);
}

function endPass(gl: DepthRenderer, scene: THREE.Scene): void {
  if (!saved) return;
  scene.background = saved.background;
  gl.setRenderTarget(saved.target);
  gl.setClearColor(saved.clear, saved.clearAlpha);
  gl.autoClear = saved.autoClear;
  // WEBGPU: re-assert the canvas size after the render-target detour. Measured, via the device's
  // `uncapturederror` channel: the canvas pass came back with a 300x150 depth attachment — the size of
  // an unsized HTML canvas — against a 494x217 colour attachment, which invalidates the command buffer
  // and is why the whole viewport went black with a clean console. Re-setting the size makes three
  // rebuild the canvas render context's depth texture at the real size.
  if (isWebGPURenderer(gl)) { const s2 = gl.getSize(new THREE.Vector2()); gl.setSize(s2.x, s2.y, false); }
  saved = null;
}

/** Drop every map held for this renderer — its Canvas is going away. */
export function releaseProjectorDepth(gl: THREE.WebGLRenderer): void {
  const store = perRenderer.get(gl);
  if (!store) return;
  for (const e of store.values()) for (const rt of e.rts) rt.dispose(); // window teardown: nothing is in flight
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
