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
  geos: Map<string, { orig: THREE.BufferGeometry; flipped: THREE.BufferGeometry }>;
}
export const newContentSwap = (): ContentSwap => ({ mats: new Map(), geos: new Map() });
/** Release the flipped geometries this swap built (never the originals — the loader shares those). */
export function disposeContentSwap(s: ContentSwap): void {
  for (const g of s.geos.values()) g.flipped.dispose();
  s.geos.clear();
}

// A glTF UV has v = 0 at the TOP of the image; ArtLux's content textures are uploaded with v = 0 at
// the BOTTOM (three's flipY, or bitmapFlip.ts's repeat/offset where flipY is ignored). Measured on
// the Blender test venue: a screen unwrapped upright in Blender showed its content upside down. The
// fix cannot live on the texture — it is the SAME texture a plane, the 2D stage and every other
// binding draw, all of which are correct — so it lives on the screen's GEOMETRY: a private copy with
// v → 1 − v, worn only while the screen wears its own content. Its GLB material comes back with the
// authored geometry, so a texture the modeller painted on the screen is never turned over.
//
// Only NAMED screens get this. The whole-model binding keeps the UVs exactly as before, because
// projects already exist whose content was authored against that orientation.
function flippedUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = g.clone();
  const uv = c.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (uv) { for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i)); uv.needsUpdate = true; }
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
    const own = s ? screenMats[s] : undefined;
    const want = own ?? modelMat;
    if (want) {
      if (!swap.mats.has(mesh.uuid)) swap.mats.set(mesh.uuid, mesh.material);
      mesh.material = want;
    } else {
      const orig = swap.mats.get(mesh.uuid);
      if (orig) { mesh.material = orig; swap.mats.delete(mesh.uuid); }
    }
    // The geometry half — see flippedUv. Built once per mesh, kept while the model lives.
    let g = swap.geos.get(mesh.uuid);
    if (own && !g) { g = { orig: mesh.geometry, flipped: flippedUv(mesh.geometry) }; swap.geos.set(mesh.uuid, g); }
    if (g) mesh.geometry = own ? g.flipped : g.orig;
  });
}

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
