import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getDrawable, getDrawableGeneration, getSurface } from '../../services/surfaceMedia';
import { matchBitmapOrientation } from './bitmapFlip';

// Keeps a THREE.Texture bound to a SURFACE's live picture — the sibling of useLayerTexture, for a
// venue mesh textured by `SceneModel.surfaceId`.
//
// Why a surface and not only a timeline layer: a layer is one track of the NLE, but the thing an
// operator actually routes to a projector is a SURFACE, and its content may be a video, an image, a
// camera, NDI, Spout, an effect, a timeline layer or the whole program composite. Binding the mesh
// to the surface therefore covers every source in one path — including the case that motivated it,
// "show what this projector is playing, on the object it is aimed at".
//
// Same texture discipline as useLayerTexture: a <video> element becomes a VideoTexture (identity is
// stable, we only flag it dirty), anything else (canvas / ImageBitmap / image) rides one plain
// Texture whose `image` is swapped per frame. `onTexture` fires only when the texture IDENTITY
// changes, so the consumer reassigns material.map rarely and never per frame.
export function useSurfaceTexture(
  surfaceId: string | undefined | null,
  onTexture: (tex: THREE.Texture | null) => void,
): void {
  const texRef = useRef<THREE.Texture | null>(null);
  const curVid = useRef<HTMLVideoElement | null>(null);
  const lastGen = useRef<number | undefined>(undefined);
  const cbRef = useRef(onTexture);
  cbRef.current = onTexture;

  useFrame(() => {
    // Resolve per frame rather than caching the Surface: content is edited live (a new video picked,
    // a source retyped) and the store hands out a new object each time, so a held one goes stale.
    const s = getSurface(surfaceId);
    const d = s ? getDrawable(s) : null;

    if (!d) {
      if (texRef.current || curVid.current) {
        texRef.current?.dispose(); texRef.current = null; curVid.current = null;
        lastGen.current = undefined;
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
      curVid.current = null;
      // SKIP REPEATS. A canvas-backed source (a HAP/MP4 codec frame) hands back the SAME canvas
      // every frame and only repaints it when the decoder advances — but `needsUpdate` re-uploads
      // the whole texture regardless, so a 25 fps clip was paying a full-resolution GPU upload at
      // display rate, per view showing it. The generation is exactly the "has new pixels" signal the
      // projector frame pump already skips on; undefined means the source cannot say, so assume yes.
      const gen = getDrawableGeneration(s!);
      if (gen !== undefined && gen === lastGen.current && texRef.current) return;
      lastGen.current = gen;
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
      matchBitmapOrientation(t); // same source-dependent flip as useLayerTexture
      t.needsUpdate = true;
    }
  });
}
