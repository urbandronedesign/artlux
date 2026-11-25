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

// ── The post pass's VALUES, one definition (E6f) ───────────────────────────────────────────────────
// ProjectorScene's DistortionEffect and BlendEffect build their uniforms from these, and the native engine's
// link hands the engine the same numbers (calib3d.rs draws the pass). Two copies of "d[4] is k3" or "a missing
// gamma is 2.2" would drift the first time either changed — and a lens or a blend a few pixels off on one path
// only is exactly the kind of fault that gets blamed on the calibration instead.

/** DistortionEffect's uniforms: fx, fy, cx, cy (K), k1, k2, k3, p1, p2 (OpenCV's order is k1 k2 p1 p2 k3). */
export function distortionValues(c: { intrinsics: number[]; distortion?: number[] }): number[] {
  const K = c.intrinsics, d = c.distortion ?? [];
  return [K[0], K[4], K[2], K[5], d[0] || 0, d[1] || 0, d[4] || 0, d[2] || 0, d[3] || 0];
}

/** A blend grid as the 8-bit texels its texture holds (absent values → 0, clamped, rounded). */
export function gridBytes(values: number[] | undefined, w: number, h: number): Uint8Array {
  const data = new Uint8Array(Math.max(1, w * h));
  if (values) for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, values[i] ?? 0)) * 255);
  return data;
}

export interface BlendValues {
  soft: [number, number, number, number];   // left, right, top, bottom
  gamma: number;
  gain: [number, number, number];
  lift: [number, number, number];
  /** The solved rig blend's two grids, or null (BlendEffect then binds white 1×1 textures and uHasBlend 0). */
  map: { w: number; h: number; alpha: Uint8Array; black: Uint8Array } | null;
}

/** BlendEffect's uniforms and textures for a look. */
export function blendValues(look: BlendLook): BlendValues {
  const se = look.softEdge, b = look.blend ?? null;
  return {
    soft: [se?.left ?? 0, se?.right ?? 0, se?.top ?? 0, se?.bottom ?? 0],
    gamma: Math.max(0.1, se?.gamma ?? 2.2),
    gain: [...(look.colorGain ?? [1, 1, 1])] as [number, number, number],
    lift: [...(look.blackLift ?? [0, 0, 0])] as [number, number, number],
    map: b ? { w: Math.max(1, b.w), h: Math.max(1, b.h), alpha: gridBytes(b.alpha, b.w, b.h), black: gridBytes(b.black, b.w, b.h) } : null,
  };
}

/**
 * The lights render-from-projector lights a venue mesh's OWN material with — ProjectorScene's <ambientLight> and
 * <hemisphereLight> (sky white, the ground this hex), the same rig as the editor's env look. The native engine
 * lights the same meshes from these numbers (E6f), so they live here, once.
 */
export const VENUE_LIGHTS = { ambient: 0.8, hemisphere: 0.7, ground: '#101010' } as const;
