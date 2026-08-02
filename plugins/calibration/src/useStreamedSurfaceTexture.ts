import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { matchBitmapOrientation } from '@/components/Simulator3D/bitmapFlip'; // host helper — transitional seam
import { getSurfaceFrame } from './surfaceFrameChannel';

// Keeps a THREE.Texture bound to a SURFACE's live picture inside a PROJECTOR window — the mirror-window
// sibling of the host's useSurfaceTexture, which resolves a surface's drawable directly and only works
// where the media actually lives (the main window). Here the picture arrives as ImageBitmaps over the
// bridge, so this polls the frame channel instead.
//
// Polled in useFrame rather than pushed through props/state on purpose: frames land ~30×/s and a
// setState per frame would re-render the whole projector tree to deliver a value only the render loop
// reads. `gen` is what makes a repeat cheap — identity alone can repeat.
//
// `onTexture` fires when the bound texture's IDENTITY changes (created, or cleared to null) so the
// caller can (re)assign material.map; the per-frame dirty flag is handled here.
export function useStreamedSurfaceTexture(
  surfaceId: string | undefined | null,
  onTexture: (tex: THREE.Texture | null) => void,
): void {
  const texRef = useRef<THREE.Texture | null>(null);
  const lastGen = useRef(-1);
  const cbRef = useRef(onTexture);
  cbRef.current = onTexture;

  // A binding change must not leave the previous surface's picture on the mesh.
  useEffect(() => {
    lastGen.current = -1;
    return () => {
      texRef.current?.dispose();
      texRef.current = null;
    };
  }, [surfaceId]);

  useFrame(() => {
    if (!surfaceId) {
      if (texRef.current) { texRef.current.dispose(); texRef.current = null; lastGen.current = -1; cbRef.current(null); }
      return;
    }
    const f = getSurfaceFrame(surfaceId);
    if (!f || f.gen === lastGen.current) {
      // No frame for this surface at all (nothing streamed yet, or the pump stopped) — drop any
      // texture we hold so a stale picture never outlives its source. A repeat generation is "no news".
      if (!f && texRef.current) { texRef.current.dispose(); texRef.current = null; lastGen.current = -1; cbRef.current(null); }
      return;
    }
    lastGen.current = f.gen;
    if (!f.bitmap) {
      // The source went idle (clip ended, live source dropped) — better black than the last frame
      // frozen on the object for the rest of the show.
      if (texRef.current) { texRef.current.dispose(); texRef.current = null; cbRef.current(null); }
      return;
    }
    let t = texRef.current;
    if (!t) {
      t = new THREE.Texture();
      t.colorSpace = THREE.SRGBColorSpace;
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
      texRef.current = t;
      cbRef.current(t);
    }
    t.image = f.bitmap as unknown as HTMLImageElement;
    // Streamed frames are ImageBitmaps, and three drops flipY for those — without this the content is
    // upside down on the REAL PROJECTOR while the editor's 3D view (fed the canvas directly) is the
    // right way up. See bitmapFlip. Guarded by verify:invariants.
    matchBitmapOrientation(t);
    t.needsUpdate = true;
  });
}
