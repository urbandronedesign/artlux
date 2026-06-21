import { Fixture, Layout3D, defaultLayout3D } from '../types';

// Three-free effective 3D values (used by non-lazy UI like the Inspector so that
// three.js stays out of the main bundle — only the lazy Simulator3D pulls three).
// When a fixture lacks explicit 3D data these are derived from its 2D layout.

export const STAGE_W = 4;
export const STAGE_H = 2.25;

export function effectiveLayout(f: Fixture): Layout3D {
  if (f.layout3D) return f.layout3D;
  const base = defaultLayout3D();
  base.ledSpacing = (f.width * STAGE_W) / Math.max(1, f.ledCount);
  return base;
}

export function effectivePosObj(f: Fixture): { x: number; y: number; z: number } {
  if (f.position3D) return { ...f.position3D };
  return {
    x: (f.x + f.width / 2 - 0.5) * STAGE_W,
    y: (0.5 - (f.y + f.height / 2)) * STAGE_H,
    z: 0,
  };
}

export function effectiveRotObj(f: Fixture): { pitch: number; yaw: number; roll: number } {
  return f.rotation3D ? { ...f.rotation3D } : { pitch: 0, yaw: 0, roll: f.rotation || 0 };
}
