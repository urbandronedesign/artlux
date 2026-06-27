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
  }, [models]);

  return modelUrls;
}
