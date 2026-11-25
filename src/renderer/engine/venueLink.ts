import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { modelBindings, type Scene3D, type SceneModel, type ProjectorCalibration } from '../../../shared/protocol';
import { recenterClone, applyModelTransform } from '../components/Simulator3D/venuePlacement';
import { engineContent } from '../components/Simulator3D/engineView';
import { usesProjectedUv, usesProjectedOcclusion, DEFAULT_BIAS_M } from '../components/Simulator3D/projectedMapping';
import { cameraPose, glProjectionMatrix, PROJECTOR_NEAR, PROJECTOR_FAR, VENUE_LIGHTS } from '@artlux/plugin-calibration/playback';

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

/**
 * E6f: a venue mesh bound to a TIMELINE LAYER. The projector window textures it from getLayerDrawable(layerId) (the
 * program composite for PROGRAM_LAYER_ID) — App streams it as a `layerFrame` — and that is exactly what a LAYER
 * (PROGRAM) surface draws (surfaceMedia: "a single-track surface draws exactly timeline.getLayerDrawable"). So the
 * engine is handed one hidden surface per bound layer, `venuelayer:<id>` (nativeLink adds them), which it composites
 * as any timeline surface; the mesh names it as its source.
 */
export const venueLayerSurface = (layerId: string) => `venuelayer:${layerId}`;

/** Every timeline layer a visible model of the scene shows — its own binding and its named screens' (modelBindings,
 *  layerId winning — App's layerFrame pump walks the same). */
export function venueLayers(scene: Scene3D): string[] {
  const ids = new Set<string>();
  for (const m of scene.models ?? []) {
    if (!m.visible) continue;
    for (const b of modelBindings(m)) if (b.layerId) ids.add(b.layerId);
  }
  return [...ids].sort();
}

/**
 * A mesh's OWN material as three lights it in the projector window — or why the engine cannot. E6f: the window
 * lights a venue file's own materials with an ambient and a hemisphere light and NO environment map, and there three's
 * MeshStandardMaterial reduces to irradiance × diffuse × (1 − metalness) / π + emissive (calib3d.rs OWN). What that
 * reduction does not cover is refused: any texture but the two below (normal, AO, emissive, metalness… — each changes
 * the sum), vertex colours, transparency / alpha test, flat shading, a mesh without normals, any other material type (a
 * KHR_materials_* extension makes a MeshPhysicalMaterial; unlit a MeshBasicMaterial).
 */
// E6i step 4: the BASE-COLOUR map is drawn (diffuseColor ×= texel — the engine reads the image from the GLB itself, as
// GLTFLoader does, and mipmaps it as WebGL does), and a ROUGHNESS map is harmless (roughness only shapes specular, and
// with no environment map and no direct light there is none). Only a map three uses plainly: UV set 0, no transform
// (KHR_texture_transform), not flipped (glTF's), sRGB, no anisotropy.
const MAPS = ['normalMap', 'aoMap', 'emissiveMap', 'metalnessMap', 'alphaMap', 'lightMap', 'bumpMap', 'displacementMap', 'envMap'] as const;
function plainMap(t: THREE.Texture): string | null {
  if (t.channel !== 0) return `a map on UV set ${t.channel}`;
  if (t.offset.x !== 0 || t.offset.y !== 0 || t.repeat.x !== 1 || t.repeat.y !== 1 || t.rotation !== 0) return 'a transformed map';
  if (t.flipY) return 'a flipped map';
  if (t.colorSpace !== THREE.SRGBColorSpace) return 'a map not in sRGB';
  if (t.anisotropy > 1) return 'an anisotropic map';
  if ((t as THREE.CompressedTexture).isCompressedTexture) return 'a compressed map';
  return null;
}
// A map that is not a PNG is decoded by CHROMIUM for three and by the engine's own decoder otherwise — and JPEG decoders
// differ (measured: up to 4 levels on 90 198 pixels, chroma upsampling). So the engine gets the APP's decode instead:
// the picture three uploads, shipped once as a raster `vmap:<texture uuid>` (nativeLink.shipVenueMaps). PNG is
// lossless and decodes the same everywhere: the engine reads it from the file (measured identical).
const venueMaps = new Map<string, CanvasImageSource>();
/** The map pictures the engine takes from the app (key → three's own decoded image). */
export function venueMapImages(): ReadonlyMap<string, CanvasImageSource> { return venueMaps; }
function ownMaterial(o: THREE.Mesh): { color: number[]; metalness: number; emissive: number[]; side: number; map?: { wrapS: number; wrapT: number; mag: number; min: number; raster?: string } } | { why: string } {
  const m = o.material as THREE.MeshStandardMaterial | THREE.Material[];
  if (Array.isArray(m)) return { why: 'several materials on one mesh' };
  if (m.type !== 'MeshStandardMaterial') return { why: `a ${m.type}` };
  const map = MAPS.find((k) => (m as unknown as Record<string, unknown>)[k]);
  if (map) return { why: `a material with a ${map}` };
  const bad = m.map ? plainMap(m.map) : null;
  if (bad) return { why: bad };
  let raster: string | undefined;
  if (m.map && (m.map.userData as { mimeType?: string } | undefined)?.mimeType !== 'image/png') {
    const img = m.map.image as (CanvasImageSource & { width?: number; height?: number }) | null;
    if (!img || !img.width || !img.height) return { why: 'a map whose picture has not loaded' };
    raster = `vmap:${m.map.uuid}`;
    venueMaps.set(raster, img);
  }
  if (m.vertexColors) return { why: 'vertex colours' };
  if (m.transparent || m.alphaTest > 0 || m.alphaHash) return { why: 'a transparent material' };
  if (m.flatShading || !o.geometry.getAttribute('normal')) return { why: 'flat shading' };
  if (m.wireframe) return { why: 'a wireframe material' };
  // The uniforms as three uploads them: diffuse = color, emissive = emissive × emissiveIntensity (linear, its
  // working space), metalness; the side decides the culling and the double-sided normal flip.
  return { color: [m.color.r, m.color.g, m.color.b], metalness: m.metalness, emissive: m.emissive.clone().multiplyScalar(m.emissiveIntensity).toArray(), side: m.side,
    ...(m.map ? { map: { wrapS: m.map.wrapS, wrapT: m.map.wrapT, mag: m.map.magFilter, min: m.map.minFilter, ...(raster ? { raster } : {}) } } : {}) };
}

/** The window's two lights as WebGLLights uploads them for a camera with this view matrix. */
function venueLights(view: THREE.Matrix4) {
  const amb = new THREE.AmbientLight(); amb.intensity = VENUE_LIGHTS.ambient;
  const hemi = new THREE.HemisphereLight(); hemi.intensity = VENUE_LIGHTS.hemisphere; hemi.groundColor.set(VENUE_LIGHTS.ground);
  hemi.updateMatrixWorld(true);
  const dir = new THREE.Vector3().setFromMatrixPosition(hemi.matrixWorld).transformDirection(view);
  return {
    ambient: [amb.color.r * amb.intensity, amb.color.g * amb.intensity, amb.color.b * amb.intensity],
    sky: hemi.color.clone().multiplyScalar(hemi.intensity).toArray(),
    ground: hemi.groundColor.clone().multiplyScalar(hemi.intensity).toArray(),
    dir: dir.toArray(),
  };
}

/** One projected or plain content source, as the engine's 3D view takes it (engineView's EngineSrc). */
function planeSrc(m: SceneModel) {
  return {
    surface: m.layerId ? venueLayerSurface(m.layerId) : m.surfaceId!,
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
      if (!m.surfaceId && !m.layerId) return { why: `screen '${name}' has nothing bound (drawn dark grey by the app)` };
      const src = planeSrc(m);
      const g = new THREE.Group();
      applyModelTransform(g, m);
      g.updateMatrixWorld(true);
      surfaces.add(src.surface);
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
    // No binding at all: every mesh wears the file's own material (assignContentMaterials with no content).
    let count = 0;
    cloned.traverse((o) => { if ((o as THREE.Mesh).isMesh) count++; });
    const content = engineContent(cloned, m, true) ?? { src: [], mesh: new Array<number>(count).fill(-1) };
    for (const s of content.src) {
      if (s.surface === null) {
        if (!s.layer) return { why: `'${name}' shows a binding the engine cannot draw` };
        s.surface = venueLayerSurface(s.layer);
      }
      surfaces.add(s.surface);
    }
    // Per mesh, in three's traversal order (engineContent's): its model-view and world matrix — and, for a mesh in its
    // OWN material, that material and three's normalMatrix (getNormalMatrix of the f64 model-view).
    const meshes: unknown[] = [];
    let refused: string | null = null;
    let k = 0;
    cloned.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh || refused) return;
      const entry: Record<string, unknown> = { mv: mv(o), world: els(o.matrixWorld) };
      if ((content.mesh[k++] ?? -1) < 0) {
        const own = ownMaterial(o as THREE.Mesh);
        if ('why' in own) { refused = `a mesh of '${name}' shows its own material, ${own.why} (not drawn by the engine yet)`; return; }
        const mvm = new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, o.matrixWorld);
        entry.own = own;
        entry.nm = Array.from(new THREE.Matrix3().getNormalMatrix(mvm).elements);
      }
      meshes.push(entry);
    });
    if (refused) return { why: refused };
    models.push({ id: m.id, kind: 'glb', path: m.path, meshes, content });
  }
  if (!models.length) return { why: 'the venue scene has no visible geometry' };
  return {
    doc: { proj: glProjectionMatrix(cal.intrinsics, cal.imageSize, PROJECTOR_NEAR, PROJECTOR_FAR), models, lights: venueLights(cam.matrixWorldInverse) },
    surfaces: [...surfaces],
  };
}
