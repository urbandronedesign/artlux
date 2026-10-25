import { useEffect, useRef, useState } from 'react';
import { useGLTF } from '@react-three/drei';
import type { SceneModel } from '../../../../shared/protocol';

// Loads each unique mesh GLB path once → a shared Blob URL, mapping every model id to its path's URL
// (duplicate meshes reuse one load). Revokes URLs + clears the GLTF cache for paths no longer
// referenced. Shared by the main window (embedded Simulator3D) and the detached Scene window so both
// load models the same way. Pass scene3D.models (stable ref unless models change).
export function useModelUrls(models: SceneModel[] | undefined): Record<string, string> {
  const [modelUrls, setModelUrls] = useState<Record<string, string>>({});
  const urlCache = useRef<Record<string, string>>({});
  // A .blend saved in Blender is re-exported OVER the same .glb path (main/blendImport.ts), so a cache
  // keyed on the path would keep the old geometry forever. Drop that entry and run the load again: the
  // fresh Blob URL is a new useGLTF key, so ModelObject re-parses and every binding follows by name.
  //
  // ⚠ RETIRE THE OLD URL ONLY ONCE NOTHING SHOWS IT. Clearing useGLTF's cache and revoking the blob
  // here, at the moment of the update, left the mounted ModelObject holding a URL whose parse was gone:
  // its next render re-suspended, fetched the revoked blob, and threw — "venue model failed to load …
  // Failed to fetch" plus an uncaught global error on every Blender save, and the model blinked out
  // until the new URL arrived (measured on the installed v0.34.0). The old URL now stays loadable until
  // a published `modelUrls` no longer references it (the effect at the bottom).
  const [reloads, setReloads] = useState(0);
  const retiring = useRef<string[]>([]);
  useEffect(() => window.artlux?.onBlendUpdated?.((r) => {
    const url = r.ok ? urlCache.current[r.glbPath] : undefined;
    if (!url) return;
    retiring.current.push(url);
    delete urlCache.current[r.glbPath];
    setReloads((n) => n + 1);
  }), []);
  useEffect(() => {
    if (!retiring.current.length) return;
    const shown = new Set(Object.values(modelUrls));
    retiring.current = retiring.current.filter((u) => {
      if (shown.has(u)) return true;            // still on screen — the new load has not landed yet
      try { useGLTF.clear(u); } catch { /* ignore */ }
      URL.revokeObjectURL(u);
      return false;
    });
  }, [modelUrls]);

  useEffect(() => {
    const list = models ?? [];
    let alive = true;
    (async () => {
      const meshes = list.filter(m => m.kind !== 'plane' && m.path);
      const paths = Array.from(new Set(meshes.map(m => m.path)));
      for (const path of paths) {
        if (urlCache.current[path]) continue; // already loaded
        const bytes = await window.artlux?.readModel?.(path);
        if (!alive) return;
        if (!bytes) continue;
        urlCache.current[path] = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
      }
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const m of meshes) { const u = urlCache.current[m.path]; if (u) next[m.id] = u; }
      setModelUrls(next);
      // Free paths no longer referenced by any mesh.
      const used = new Set(meshes.map(m => m.path));
      for (const path of Object.keys(urlCache.current)) {
        if (!used.has(path)) {
          try { useGLTF.clear(urlCache.current[path]); } catch { /* ignore */ }
          URL.revokeObjectURL(urlCache.current[path]);
          delete urlCache.current[path];
        }
      }
    })();
    return () => { alive = false; };
  }, [models, reloads]);

  return modelUrls;
}
