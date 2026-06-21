import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { dmxSignal } from '../../../services/dmxSignal';

// Subscribes to the live DMX pixel stream and writes per-instance colors into the
// InstancedMesh every frame, with zero React re-renders. RGBW is folded to RGB
// for display (white added to each channel, clamped).
export function useLedColors(meshRef: React.MutableRefObject<THREE.InstancedMesh | null>, count: number) {
  const latest = useRef<Uint8Array | null>(null);
  const dirty = useRef(false);

  useEffect(() => {
    return dmxSignal.subscribe(({ pixels }) => {
      latest.current = pixels;
      dirty.current = true;
    });
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || !mesh.instanceColor || !dirty.current || !latest.current) return;
    const px = latest.current;
    const arr = mesh.instanceColor.array as Float32Array;
    const n = Math.min(count, Math.floor(px.length / 4));
    for (let i = 0; i < n; i++) {
      const s = i * 4, d = i * 3;
      const w = px[s + 3] / 255;
      arr[d] = Math.min(1, px[s] / 255 + w);
      arr[d + 1] = Math.min(1, px[s + 1] / 255 + w);
      arr[d + 2] = Math.min(1, px[s + 2] / 255 + w);
    }
    mesh.instanceColor.needsUpdate = true;
    dirty.current = false;
  });
}
