import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Scene3D, SceneModel, ProjectorCalibration } from '../../../shared/protocol';
import { recenterClone, applyModelTransform } from '../components/Simulator3D/venuePlacement';
import { engineContent } from '../components/Simulator3D/engineView';
import { usesProjectedUv, usesProjectedOcclusion, DEFAULT_BIAS_M } from '../components/Simulator3D/projectedMapping';
import { cameraPose, glProjectionMatrix, PROJECTOR_NEAR, PROJECTOR_FAR } from '@artlux/plugin-calibration/playback';

// E6f — RENDER-FROM-PROJECTOR, DESCRIBED FOR THE NATIVE ENGINE (engine half: engine/artlux-engine/src/calib3d.rs).
//
// A calibrated output in render mode shows the VENUE drawn from the solved projector (the calibration plugin's
// ProjectorScene, in the projector window's own three.js). The engine draws it instead while it owns the outputs —
// and it must draw the SAME picture, so nothing here is re-derived on the other side:
//   - the venue is placed by the editor's own functions (recenterClone + applyModelTransform — ProjectorScene's
//     ProjectorModel / ProjectorPlane place with exactly these), on GLBs loaded by three's own GLTFLoader;
//   - the camera is CalibCamera's: cameraPose + glProjectionMatrix, through a three.js camera — so its view
//     matrix is three's matrixWorldInverse;
//   - EVERY MESH'S MODEL-VIEW is computed HERE, in f64, as three's renderer computes `modelViewMatrix` per object
//     (camera.matrixWorldInverse × object.matrixWorld) before uploading it as f32 — the engine multiplies
//     P × (MV × p) in its vertex stage as three's does. A world matrix composed again on the other side would
//     differ in the last bits, and that moves a triangle edge across an MSAA sample;
//   - what each mesh wears is engineContent (the editor's E4a+ rule: a bound named screen its surface, every
//     other mesh the model's) — mesh i of the file in three's traversal order, the order the engine's loader
//     walks the file in.
//
// It does NOT need the editor's 3D view: in --broadcast no Simulator3D is mounted (the calibration plugin's
// venueRegistrar has the same reason to load the GLBs itself). Loaded once per file, geometry only.
//
// What the engine does not draw yet comes back as a REASON (the app then keeps every output — all or nothing):
// a timeline-layer binding, a mesh wearing its own (lit) material, a screen with nothing bound, projected mapping
// with occlusion. The output-level ones (distortion, blend pass, residual warp, NDI) are nativeLink's.

const loader = new GLTFLoader();
type Loaded = { state: 'loading' } | { state: 'ok'; scene: THREE.Object3D } | { state: 'error'; why: string };
const files = new Map<string, Loaded>();
let gen = 0;
let changed: () => void = () => {};

/** Called when a file finishes loading (or fails): the document must be built again. */
export function onVenueChange(cb: () => void): void { changed = cb; }
/** Bumped when a file lands — part of the document's change key. */
export function venueGen(): number { return gen; }

// A .blend re-exported over its .glb keeps the same path: forget it, so the next document loads it again.
try {
  window.artlux?.onBlendUpdated?.((r) => { if (r.ok && files.delete(r.glbPath)) { gen++; changed(); } });
} catch { /* no bridge (a test page) */ }

function load(path: string): Loaded {
  const hit = files.get(path);
  if (hit) return hit;
  const entry: Loaded = { state: 'loading' };
  files.set(path, entry);
  void (async () => {
    let next: Loaded;
    try {
      const bytes = await window.artlux?.readModel?.(path);
      if (!bytes) next = { state: 'error', why: `the venue model ${path} could not be read` };
      else {
        const gltf = await loader.parseAsync((bytes as Uint8Array).buffer.slice(0) as ArrayBuffer, '');
        next = { state: 'ok', scene: gltf.scene };
      }
    } catch (e) {
      next = { state: 'error', why: `the venue model ${path} did not load (${(e as Error).message})` };
    }
    if (files.get(path) !== entry) return;   // forgotten meanwhile
    files.set(path, next);
    gen++;
    changed();
  })();
  return entry;
}

const els = (m: THREE.Matrix4) => Array.from(m.elements);

/** One projected or plain content source, as the engine's 3D view takes it (engineView's EngineSrc). */
function planeSrc(m: SceneModel) {
  return {
    surface: m.surfaceId!,
    proj: usesProjectedUv(m) ? {
      view: m.uvProjView!, eye: m.uvProjEye ?? [0, 0, 0], soft: m.uvProjSoft ?? 0, cull: !!m.uvProjCull,
      occlude: usesProjectedOcclusion(m), bias: m.uvProjBias ?? DEFAULT_BIAS_M,
    } : undefined,
  };
}

/**
 * The calibrated venue as the engine draws it for one output, or the reason it cannot. `scene` is the one App
 * hands the projector window (resolveProjectedScene applied). The surfaces it shows come back in `surfaces`.
 */
export function calibDoc(cal: ProjectorCalibration, scene: Scene3D): { doc: unknown; surfaces: string[] } | { why: string } {
  // CalibCamera, through a three.js camera: its matrixWorldInverse IS the view matrix three renders with.
  const cam = new THREE.PerspectiveCamera();
  const { position, quaternion } = cameraPose(cal.rotation, cal.translation as [number, number, number]);
  cam.position.set(position[0], position[1], position[2]);
  cam.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  cam.updateMatrixWorld(true);
  const mv = (o: THREE.Object3D) => els(new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, o.matrixWorld));
  const models: unknown[] = [];
  const surfaces = new Set<string>();
  for (const m of scene.models ?? []) {
    if (!m.visible) continue;
    const name = m.name || m.id;
    if (m.kind === 'plane') {
      // ProjectorPlane: a 16/9 × 1 PlaneGeometry in a group carrying the model's transform.
      if (m.layerId) return { why: `screen '${name}' shows a timeline layer` };
      if (!m.surfaceId) return { why: `screen '${name}' has nothing bound (drawn dark grey by the app)` };
      const src = planeSrc(m);
      if (src.proj?.occlude) return { why: `screen '${name}' is projected with occlusion` };
      const g = new THREE.Group();
      applyModelTransform(g, m);
      g.updateMatrixWorld(true);
      surfaces.add(m.surfaceId);
      models.push({ id: m.id, kind: 'plane', w: 16 / 9, h: 1, mv: mv(g), world: els(g.matrixWorld), src });
      continue;
    }
    if (!m.path) continue;   // ProjectorScene mounts a mesh only once it has a file
    const f = load(m.path);
    if (f.state === 'loading') return { why: `the venue model '${name}' is still loading` };
    if (f.state === 'error') return { why: f.why };
    // ProjectorModel: recenterClone inside a group carrying the model's transform.
    const cloned = recenterClone(f.scene, m.origin);
    const g = new THREE.Group();
    g.add(cloned);
    applyModelTransform(g, m);
    g.updateMatrixWorld(true);
    const content = engineContent(cloned, m, true);
    if (!content) return { why: `the venue model '${name}' shows its own materials (lit by three.js)` };
    if (content.mesh.some((i) => i < 0)) return { why: `a mesh of '${name}' shows its own material (lit by three.js)` };
    for (const s of content.src) {
      if (s.surface === null) return { why: `'${name}' shows a timeline layer` };
      if (s.proj?.occlude) return { why: `'${name}' is projected with occlusion` };
      surfaces.add(s.surface);
    }
    // Per mesh, in three's traversal order (engineContent's): its model-view and world matrix.
    const meshes: unknown[] = [];
    cloned.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push({ mv: mv(o), world: els(o.matrixWorld) }); });
    models.push({ id: m.id, kind: 'glb', path: m.path, meshes, content });
  }
  if (!models.length) return { why: 'the venue scene has no visible geometry' };
  return {
    doc: { proj: glProjectionMatrix(cal.intrinsics, cal.imageSize, PROJECTOR_NEAR, PROJECTOR_FAR), models },
    surfaces: [...surfaces],
  };
}
