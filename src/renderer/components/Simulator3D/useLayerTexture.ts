import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { timeline as engine } from '../../services/timeline';

// Keeps a THREE.Texture bound to a timeline layer's live frame — a streamed ImageBitmap in the Scene
// window (decoded once in main), or a <video> on the legacy path. `onTexture` fires whenever the
// bound texture's identity changes (new source kind, or cleared to null) so the consumer can
// (re)assign material.map; the per-frame dirty flag is handled here. Extracted from PlaneObject so
// both projection planes and GLB meshes texture from the timeline through one path.
export function useLayerTexture(
  layerId: string | undefined | null,
  onTexture: (tex: THREE.Texture | null) => void,
): void {
  const texRef = useRef<THREE.Texture | null>(null);
  const curVid = useRef<HTMLVideoElement | null>(null);
  const cbRef = useRef(onTexture);
  cbRef.current = onTexture;

  useEffect(() => () => { texRef.current?.dispose(); texRef.current = null; curVid.current = null; }, []);

  useFrame(() => {
    const d = layerId ? engine.getLayerDrawable(layerId) : null;

    if (!d) {
      if (texRef.current || curVid.current) {
        texRef.current?.dispose(); texRef.current = null; curVid.current = null;
        cbRef.current(null);
      }
      return;
    }

    if (d instanceof HTMLVideoElement) {
      if (d !== curVid.current) {
        curVid.current = d;
        texRef.current?.dispose();
        const t = new THREE.VideoTexture(d);
        t.colorSpace = THREE.SRGBColorSpace;
        texRef.current = t;
        cbRef.current(t);
      }
      texRef.current!.needsUpdate = true;
    } else {
      // Streamed ImageBitmap: reuse one plain texture, swap its image each frame (a new transferred
      // bitmap arrives per frame). Match VideoTexture filtering (no mipmaps, linear) — cheap + NPOT-safe.
      curVid.current = null;
      let t = texRef.current;
      if (!t || t instanceof THREE.VideoTexture) {
        t?.dispose();
        t = new THREE.Texture();
        t.colorSpace = THREE.SRGBColorSpace;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = false;
        texRef.current = t;
        cbRef.current(t);
      }
      t.image = d as unknown as HTMLImageElement;
      t.needsUpdate = true;
    }
  });
}
