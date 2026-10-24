import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

// NAMED SCREENS INSIDE A GLB — the ONE definition of what counts as a screen and of which material
// each mesh of a venue model wears. Read by the editor's ModelObject AND calibration's ProjectorScene:
// if the two ever disagreed about which meshes are a screen, a screen would look right in the 3D view
// and show the wrong picture on the real wall, which is the one place nobody is looking while editing.
// verify:invariants holds both renderers to this module.
//
// The convention is the modeller's: name an object `screen…` in Blender (`screen_left`, `SCREEN-02`,
// `Screen.001`) and export glTF. Case-insensitive, prefix only. The OBJECT name is what counts — on a
// multi-material object three makes the node a Group whose child meshes carry the mesh-DATA name, and
// a screen named on the object must still own all of them, so every mesh under a match belongs to it.
export const SCREEN_RE = /^screen/i;

// Screen name → its meshes, in traversal order. The name is the one three assigned on load, which is
// what SceneModel.screens is keyed by (see its comment for the sanitising). A screen nested under
// another screen is part of the outer one: the outer name already claimed every mesh below it, and
// splitting would hand one physical screen two bindings.
export function findScreens(root: THREE.Object3D): Map<string, THREE.Mesh[]> {
  const out = new Map<string, THREE.Mesh[]>();
  const walk = (o: THREE.Object3D, owner: string | null) => {
    const name = owner ?? (o !== root && SCREEN_RE.test(o.name) ? o.name : null);
    if (name && (o as { isMesh?: boolean }).isMesh) {
      const list = out.get(name) ?? [];
      list.push(o as THREE.Mesh);
      out.set(name, list);
    }
    for (const c of o.children) walk(c, name);
  };
  walk(root, null);
  return out;
}

// What assignContentMaterials swapped out and must be able to put back — one per model instance.
export interface ContentSwap {
  mats: Map<string, THREE.Material | THREE.Material[]>;            // mesh uuid → its authored material
  geos: Map<string, THREE.BufferGeometry>;                          // mesh uuid → its authored geometry
}
export const newContentSwap = (): ContentSwap => ({ mats: new Map(), geos: new Map() });
/** Forget a swap. The flipped geometries are NOT disposed: they are shared per source (see flippedUv). */
export function disposeContentSwap(s: ContentSwap): void {
  s.mats.clear();
  s.geos.clear();
}

// A glTF UV has v = 0 at the TOP of the image; ArtLux's content textures are uploaded with v = 0 at
// the BOTTOM (three's flipY, or bitmapFlip.ts's repeat/offset where flipY is ignored). Measured on
// the Blender test venue: a mesh unwrapped upright in Blender showed its content upside down — the
// named screen AND the whole model alike. The fix cannot live on the texture — it is the SAME texture
// a plane, the 2D stage and every other binding draw, all of which are correct — so it lives on the
// GEOMETRY: a twin with v → 1 − v, worn only while the mesh wears content. Its GLB material comes back
// with the authored geometry, so a texture the modeller painted on the mesh is never turned over.
// (The projected-UV material computes its UV from the vertex position and never reads this one.)
//
// The twin SHARES position, normal, index — every buffer but `uv` — so a CAD venue bound as a whole
// costs one extra UV array, not a second copy of its mesh. It is cached per SOURCE geometry: every
// clone of a GLB shares the loader's geometry, so the editor, each placement and each remount reuse
// one twin, and it lives exactly as long as the loaded file does. Never disposed for that reason —
// disposing a geometry makes the renderer release its attributes' GPU buffers, and those are shared.
const flippedCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
function flippedUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = flippedCache.get(g);
  if (hit) return hit;
  const c = new THREE.BufferGeometry();
  c.setIndex(g.index);
  for (const [name, attr] of Object.entries(g.attributes)) {
    if (name !== 'uv') { c.setAttribute(name, attr); continue; }
    const uv = (attr as THREE.BufferAttribute).clone();
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    c.setAttribute('uv', uv);
  }
  c.morphAttributes = g.morphAttributes;
  c.morphTargetsRelative = g.morphTargetsRelative;
  for (const grp of g.groups) c.addGroup(grp.start, grp.count, grp.materialIndex);
  c.drawRange = { ...g.drawRange };
  c.boundingBox = g.boundingBox?.clone() ?? null;
  c.boundingSphere = g.boundingSphere?.clone() ?? null;
  flippedCache.set(g, c);
  return c;
}

// Put the right material on every mesh of a model, and the authored one BACK when nothing claims it.
//
// One owner per model, deliberately. The whole-model binding and each screen's binding used to be
// candidates for separate effects each swapping materials, and two writers sharing one restore map
// is exactly how a cleared binding leaves a mesh stuck on the flat #161616 stand-in. Precedence:
// a BOUND screen wears its own material; everything else (screens without a binding included) wears
// the model's; with neither, the GLB's own materials come back.
export function assignContentMaterials(
  root: THREE.Object3D,
  screens: Map<string, THREE.Mesh[]>,
  modelMat: THREE.Material | null,
  screenMats: Record<string, THREE.Material>,
  swap: ContentSwap,
): void {
  const screenOf = new Map<string, string>();
  for (const [name, meshes] of screens) for (const m of meshes) screenOf.set(m.uuid, name);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const s = screenOf.get(mesh.uuid);
    const want = (s ? screenMats[s] : undefined) ?? modelMat;
    if (want) {
      if (!swap.mats.has(mesh.uuid)) swap.mats.set(mesh.uuid, mesh.material);
      mesh.material = want;
      // The geometry half — see flippedUv. Content is worn with glTF's v turned over to ArtLux's.
      if (!swap.geos.has(mesh.uuid)) swap.geos.set(mesh.uuid, mesh.geometry);
      mesh.geometry = flippedUv(swap.geos.get(mesh.uuid)!);
    } else {
      const orig = swap.mats.get(mesh.uuid);
      if (orig) { mesh.material = orig; swap.mats.delete(mesh.uuid); }
      const geo = swap.geos.get(mesh.uuid);
      if (geo) { mesh.geometry = geo; swap.geos.delete(mesh.uuid); }
    }
  });
}

// ── Projectors placed in the file ───────────────────────────────────────────────────────────────
//
// A camera named `projector…` is where the modeller put a real projector. Calibration starts from it
// (ManualWizard's Lens step): its lens gives the throw ratio, its placement a starting pose, and the
// operator's points then correct both against the real room. Same naming rule as screens, and the
// same reason for living here: the editor publishes what it found, the wizard reads it.
export const PROJECTOR_RE = /^projector/i;

/** A projector camera as it sits in the WORLD — after the recentre and the model's own transform. */
export interface FileProjector {
  modelId: string;
  modelName: string;
  name: string;
  /** Camera → world, column-major (THREE.Matrix4.elements). May carry the model's scale. */
  matrixWorld: number[];
  /** Vertical field of view, degrees, and the aspect it was authored at (glTF yfov + aspectRatio). */
  fovY: number;
  aspect: number;
}

export function findProjectors(root: THREE.Object3D): THREE.PerspectiveCamera[] {
  const out: THREE.PerspectiveCamera[] = [];
  root.traverse((o) => {
    if ((o as THREE.PerspectiveCamera).isPerspectiveCamera && PROJECTOR_RE.test(o.name)) out.push(o as THREE.PerspectiveCamera);
  });
  return out;
}

/** Spec-sheet throw ratio (throw distance ÷ image width) of a camera's lens. */
export const throwRatioOf = (p: Pick<FileProjector, 'fovY' | 'aspect'>): number =>
  1 / (2 * Math.tan((p.fovY * Math.PI) / 360) * p.aspect);

/**
 * The camera's placement as an OpenCV pose — R (world→camera, row-major 3×3) and t — the convention
 * every calibration solve stores. three looks down −Z with +Y up; OpenCV looks down +Z with +Y down,
 * so the camera's own axes map as (x, −y, −z). Axes are normalised, so a scaled model still yields a
 * rotation and the centre is where the camera really is.
 */
export function cvPoseOf(matrixWorld: number[]): { rotation: number[]; translation: number[] } {
  const e = matrixWorld;
  const axis = (i: number) => { const v = [e[i * 4], e[i * 4 + 1], e[i * 4 + 2]]; const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((x) => x / l); };
  const x = axis(0), y = axis(1), z = axis(2);
  const C = [e[12], e[13], e[14]];
  const R = [x[0], x[1], x[2], -y[0], -y[1], -y[2], -z[0], -z[1], -z[2]];
  const t = [0, 1, 2].map((r) => -(R[r * 3] * C[0] + R[r * 3 + 1] * C[1] + R[r * 3 + 2] * C[2]));
  return { rotation: R, translation: t };
}

const projectors = new Map<string, FileProjector[]>();
let projectorList: FileProjector[] = [];

export function publishModelProjectors(modelId: string, list: FileProjector[] | null): void {
  const prev = projectors.get(modelId);
  if (!list || list.length === 0) { if (!prev) return; projectors.delete(modelId); }
  else {
    if (prev && JSON.stringify(prev) === JSON.stringify(list)) return; // a handful of numbers, at operator rate
    projectors.set(modelId, list);
  }
  projectorList = [...projectors.values()].flat();
  emit();
}

/** Every projector placed in a loaded venue file, across all models. */
export const useFileProjectors = (): FileProjector[] => useSyncExternalStore(subscribe, () => projectorList);

// ── What the editor knows about the loaded file ─────────────────────────────────────────────────
//
// The Model card lists a model's screens, but the panel never holds the GLB — only ModelObject does,
// once the file has loaded. So ModelObject publishes the names it found here, and the panel reads
// them. Runtime knowledge about a file, not project state: nothing here is saved, and a binding whose
// name is absent from this list is how the panel says "renamed or deleted in Blender".
//
// `focus` is the screen the operator last clicked in the viewport, so the card can point at its row.

type Focus = { modelId: string; name: string } | null;
const names = new Map<string, string[]>();
let focus: Focus = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const NONE: string[] = [];

export function publishModelScreens(modelId: string, list: string[] | null): void {
  const prev = names.get(modelId);
  if (!list) { if (prev) { names.delete(modelId); emit(); } return; }
  if (prev && prev.length === list.length && prev.every((n, i) => n === list[i])) return;
  names.set(modelId, list);
  emit();
}

export function focusScreen(modelId: string, name: string | null): void {
  const next = name ? { modelId, name } : null;
  if (focus?.modelId === next?.modelId && focus?.name === next?.name) return;
  focus = next;
  emit();
}

/** Screen names found in a model's loaded file — empty until it loads (or with none). */
export const useModelScreens = (modelId: string | null | undefined): string[] =>
  useSyncExternalStore(subscribe, () => (modelId && names.get(modelId)) || NONE);

export const useFocusedScreen = (): Focus => useSyncExternalStore(subscribe, () => focus);

// The screen a 3D click landed on: walk up from the hit object to the first `screen…` ancestor below
// the model's own root. Null when the click hit ordinary venue geometry.
export function screenUnder(hit: THREE.Object3D | null | undefined, root: THREE.Object3D): string | null {
  let found: string | null = null;
  for (let o = hit; o && o !== root; o = o.parent) if (SCREEN_RE.test(o.name)) found = o.name; // outermost wins, as in findScreens
  return found;
}
