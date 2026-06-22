import React, { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { Scene3D } from '../../../../shared/protocol';
import { effectivePos } from '../../services/led3dLayout';
import { dmxSignal } from '../../services/dmxSignal';

// Real-time venue lighting: one point light per fixture, colored by the average of that
// fixture's live LED colors (folding the RGBW white channel) and scaled by luminance.
// WebGL forward-renders every light per fragment, so this is capped LOW — too many real
// lights blows the frame budget and the driver resets the GL context (model flickers out).
// LEDs themselves stay self-lit (+ bloom) so the rig still reads with many fixtures.
const MAX_LIGHTS = 12;

export const FixtureLights: React.FC<{ fixtures: Fixture[]; scene3D: Scene3D }> = ({ fixtures, scene3D }) => {
  // Per-fixture LED offset into the global pixel buffer + world position.
  const items = useMemo(() => {
    const out: { id: string; start: number; count: number; pos: THREE.Vector3 }[] = [];
    let cur = 0;
    for (const f of fixtures) {
      out.push({ id: f.id, start: cur, count: f.ledCount, pos: effectivePos(f) });
      cur += f.ledCount;
    }
    return out.slice(0, MAX_LIGHTS);
  }, [fixtures]);

  const pixelsRef = useRef<Uint8Array | null>(null);
  useEffect(() => dmxSignal.subscribe(({ pixels }) => { pixelsRef.current = pixels; }), []);

  const refs = useRef<(THREE.PointLight | null)[]>([]);
  useFrame(() => {
    const px = pixelsRef.current;
    const gain = scene3D.lightIntensity ?? 1;
    for (let i = 0; i < items.length; i++) {
      const L = refs.current[i];
      if (!L) continue;
      if (!px) { L.intensity = 0; continue; }
      const { start, count } = items[i];
      let r = 0, g = 0, b = 0, n = 0;
      for (let k = 0; k < count; k++) {
        const s = (start + k) * 4;
        if (s + 3 >= px.length) break;
        const w = px[s + 3];
        r += Math.min(255, px[s] + w); g += Math.min(255, px[s + 1] + w); b += Math.min(255, px[s + 2] + w); n++;
      }
      if (n === 0) { L.intensity = 0; continue; }
      r /= n * 255; g /= n * 255; b /= n * 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      L.color.setRGB(r, g, b);
      L.intensity = lum * gain * 6;
    }
  });

  return (
    <>
      {items.map((o, i) => (
        <pointLight
          key={o.id}
          ref={(el) => { refs.current[i] = el; }}
          position={[o.pos.x, o.pos.y, o.pos.z]}
          distance={8}
          decay={2}
          intensity={0}
        />
      ))}
    </>
  );
};
