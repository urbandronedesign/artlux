// THE UV CHECKER, KEPT TRUE TO THE PROJECT (suite plan Phase 3, decision 13).
//
// A UV-checker surface (content.uvChecker, shaderId 'uv-checker') runs GENERATED code that names the
// surface and draws, where each one lands, every Blender screen bound to it — @artlux/plugin-shader's
// uvChecker.ts writes that code; this decides what goes in it and rewrites it when the project changes:
// a surface renamed, a screen bound or unbound, the venue re-saved in Blender (its .glb rewritten).
//
// The screens' extents are measured from the venue's own mesh: the UV bounds of every mesh under a
// `screen…` object (modelScreens.findScreens — the one screen rule), flipped to the surface's v-up
// convention (glTF's v is 0 at the top — see modelScreens.flippedUv). The file is read through main
// (readModel), the same door the calibration plugin's headless venue loader uses, and measured once
// per file version: a re-export keeps the path, so the cache key includes the model's revision.
//
// A rewrite is DERIVED, not authored: it goes straight to the surfaces state, never through the undo
// history — an operator's undo must not step through "the checker noticed the rename".

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { uvChecker } from '@artlux/plugin-shader/renderer';
import { findScreens } from '@/components/Simulator3D/modelScreens';
import type { Scene3D, SceneModel } from '../../../shared/protocol';
import type { Surface } from '../types';

type Extent = { u0: number; v0: number; u1: number; v1: number };
const loader = new GLTFLoader();
// model path → screen name → UV extent (v up). A promise, so concurrent asks share one load.
const measured = new Map<string, Promise<Map<string, Extent>>>();

// A BLENDER SAVE REWRITES THE .glb UNDER THE SAME PATH (main/blendImport.ts), so the path alone would
// keep a stale measurement forever — the same trap useModelUrls handles for the 3D view. Drop the file's
// entry and tell whoever is syncing to run again.
const venueChanged = new Set<() => void>();
window.artlux?.onBlendUpdated?.((r) => {
  if (!r.ok || !measured.has(r.glbPath)) return;
  measured.delete(r.glbPath);
  venueChanged.forEach((f) => f());
});
/** Called when a venue file the checkers measured has been re-exported — run the sync again. */
export function onVenueChanged(cb: () => void): () => void { venueChanged.add(cb); return () => { venueChanged.delete(cb); }; }

function measure(m: SceneModel): Promise<Map<string, Extent>> {
  const key = m.path!;
  const hit = measured.get(key);
  if (hit) return hit;
  const p = (async () => {
    const out = new Map<string, Extent>();
    const bytes = await window.artlux?.readModel?.(m.path!);
    if (!bytes) return out;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const gltf = await loader.parseAsync(buf, '');
    for (const [name, meshes] of findScreens(gltf.scene)) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (const mesh of meshes) {
        const uv = (mesh.geometry as THREE.BufferGeometry).getAttribute('uv');
        if (!uv) continue;
        for (let i = 0; i < uv.count; i++) {
          const u = uv.getX(i), v = 1 - uv.getY(i); // glTF v-down → the surface's v-up
          if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
        }
      }
      if (u1 > u0 && v1 > v0) out.set(name, { u0, v0, u1, v1 });
    }
    return out;
  })().catch((e) => { console.warn(`[uv-checker] could not measure the screens of ${m.path}:`, e); return new Map<string, Extent>(); });
  measured.set(key, p);
  return p;
}

/** The screens bound to `surfaceId`, with where each lands on it. */
async function screensOn(surfaceId: string, scene: Scene3D): Promise<uvChecker.UvCheckerScreen[]> {
  const out: uvChecker.UvCheckerScreen[] = [];
  for (const m of scene.models ?? []) {
    const bound = Object.entries(m.screens ?? {}).filter(([, b]) => b.surfaceId === surfaceId && !b.layerId);
    if (!bound.length || !m.path) continue;
    const ext = await measure(m);
    for (const [name] of bound) {
      const e = ext.get(name);
      if (e) out.push({ name, ...e });
    }
  }
  return out.sort((a, b) => a.u0 - b.u0 || b.v1 - a.v1);
}

/** Is this surface a UV checker (generated, kept in sync)? */
export const isUvChecker = (s: Surface): boolean =>
  s.content?.type === 'SHADER' && s.content.shaderId === uvChecker.UV_CHECKER_ID && !!s.content.uvChecker;

/**
 * Regenerate every UV checker whose code no longer matches the project. `apply` receives only the
 * surfaces whose source changed — nothing at all when everything is current, so this is safe to call on
 * every project change. A newer call supersedes an older one still measuring (`isCurrent`).
 */
export async function syncUvCheckers(
  surfaces: Surface[], scene: Scene3D,
  apply: (sources: Map<string, string>) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const changed = new Map<string, string>();
  for (const s of surfaces) {
    if (!isUvChecker(s)) continue;
    const src = uvChecker.buildUvCheckerSource({
      size: s.content.uvChecker!.size,
      title: s.name,
      screens: await screensOn(s.id, scene),
    });
    if (src !== s.content.shaderSource) changed.set(s.id, src);
  }
  if (changed.size && isCurrent()) apply(changed);
}
