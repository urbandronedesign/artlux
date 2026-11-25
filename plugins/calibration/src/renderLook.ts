import type { ProjectorBlend, SoftEdge } from '../../../shared/protocol';

// What render-from-projector draws with, beyond the scene itself — PURE (no three, no React), so the host's
// native-engine link can ask the SAME questions ProjectorScene asks without pulling the scene in (E6f: the
// engine draws a calibrated output only where it draws exactly what this window would, and these two decide
// part of that). ProjectorScene imports them from here; the playback barrel re-exports them.

/** The calibrated camera's clip planes (metres) — ProjectorScene's CalibCamera, and the engine's twin of it. */
export const PROJECTOR_NEAR = 0.05;
export const PROJECTOR_FAR = 200;

export interface BlendLook {
  softEdge?: SoftEdge;
  colorGain?: [number, number, number];
  blackLift?: [number, number, number];
  blend?: ProjectorBlend | null;
}

// Does this output need the blend pass at all? A default output (no feather, unit gain, no lift, no
// solved blend) is identity, and mounting an EffectComposer for identity costs a full-screen pass on
// what may be a 4K projector.
export function needsBlendPass(look: BlendLook): boolean {
  const se = look.softEdge;
  if (look.blend) return true;
  if (se && (se.left > 0 || se.right > 0 || se.top > 0 || se.bottom > 0)) return true;
  const g = look.colorGain, l = look.blackLift;
  if (g && (g[0] !== 1 || g[1] !== 1 || g[2] !== 1)) return true;
  if (l && (l[0] !== 0 || l[1] !== 0 || l[2] !== 0)) return true;
  return false;
}

/** Does this calibration carry a lens distortion (the DistortionEffect pass)? */
export function hasDistortion(c: { distortion?: number[] }): boolean {
  return !!c.distortion?.some((v) => v !== 0);
}
