import { useEffect, useId, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { acquireSurfaceTexture, releaseSurfaceTexture } from './surfaceTextureCache';

// Keeps a THREE.Texture bound to a SURFACE's live picture — the sibling of useLayerTexture, for a
// venue mesh textured by `SceneModel.surfaceId`.
//
// Why a surface and not only a timeline layer: a layer is one track of the NLE, but the thing an
// operator actually routes to a projector is a SURFACE, and its content may be a video, an image, a
// camera, NDI, Spout, an effect, a timeline layer or the whole program composite. Binding the mesh
// to the surface therefore covers every source in one path — including the case that motivated it,
// "show what this projector is playing, on the object it is aimed at".
//
// THE TEXTURE ITSELF IS NO LONGER OWNED HERE. It belongs to surfaceTextureCache, keyed by surface, so
// three meshes showing one surface cost ONE upload per frame instead of three — see that file for why
// the pixel mapper's atlas cannot be reused for this. This hook is now just the binding: it borrows
// per frame, reports identity changes, and releases on unmount.
//
// `onTexture` still fires only when the texture IDENTITY changes, so the consumer reassigns
// material.map rarely and never per frame.
export function useSurfaceTexture(
  surfaceId: string | undefined | null,
  onTexture: (tex: THREE.Texture | null) => void,
): void {
  const cbRef = useRef(onTexture);
  cbRef.current = onTexture;
  const lastTex = useRef<THREE.Texture | null>(null);
  const heldId = useRef<string | null>(null);
  // A stable per-consumer identity for the refcount. useId is stable across renders and unique per
  // component instance, which is exactly what "one borrower" means here.
  const consumer = useId();

  // Release on unmount, and whenever the bound surface changes — otherwise a mesh re-pointed at
  // another surface would hold the old one's texture alive forever.
  useEffect(() => () => {
    if (heldId.current) releaseSurfaceTexture(heldId.current, consumer);
    heldId.current = null;
    lastTex.current = null;
  }, [consumer]);

  useFrame(() => {
    // Resolve per frame rather than caching the Surface: content is edited live (a new video picked,
    // a source retyped) and the store hands out a new object each time, so a held one goes stale.
    const id = surfaceId || null;

    if (heldId.current && heldId.current !== id) {
      releaseSurfaceTexture(heldId.current, consumer);
      heldId.current = null;
    }

    const tex = id ? acquireSurfaceTexture(id, consumer) : null;
    if (id && tex) heldId.current = id;

    if (tex !== lastTex.current) {
      lastTex.current = tex;
      cbRef.current(tex);
    }
  });
}
