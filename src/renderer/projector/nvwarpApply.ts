// Convert a ProjectorOutput's corner-pin / Bézier warp + soft-edge blend into the buffers the native
// NVAPI scanout-warp addon expects (see src/main/nvwarpManager.ts, native/nvwarp). Pure functions (no
// React / IPC / three.js) so they unit-test in plain node, the same way blendCompute.ts does.
//
// The warp is emitted as a DENSE triangle-list grid with Q=1 — the destination positions come from the
// SAME math the GLSL path uses (evalBezier for a Bézier warp, the corner-pin homography otherwise), so
// hardware and GLSL agree to sub-pixel. A dense grid sidesteps the XYUVRQ per-vertex perspective divide
// (no guessing NVAPI's homogeneous-texcoord convention); the grid density carries the perspective,
// exactly as ArtLux's existing GLSL Bézier render already does.
//
// NVAPI scanout warp is a 2D framebuffer resample — geometry for 3D mapping comes from the calibrated
// 3D render; here NVAPI's job is the final 2D warp (lens distortion / corner-pin) + edge blend.

import type { ProjectorOutput, DisplayInfo } from '../../../shared/protocol';
import { defaultCornerPin } from '../../../shared/protocol';
import type { BlendMap } from '@artlux/plugin-calibration/renderer';
import { evalBezier } from './warp';
import { squareToQuad, applyH, type Mat3 } from './homography';

type P = [number, number];

// ── Hardware tunables ───────────────────────────────────────────────────────────────────────────
// These encode NVAPI conventions that can only be confirmed on a real Quadro/RTX-pro display. Each is
// isolated here so a first-run fix is a one-line change (the doc flags struct/convention spellings as
// pending on-hardware validation).
const WARP_TESS = 24;        // grid subdivisions per axis (matches GLSL RENDER_TESS in ProjectorApp)
const NV_FLIP_Y = false;     // flip destination Y? false = top-left origin (matches display space 0..1)
const NV_FLIP_V = false;     // flip texcoord V? false = top-left (matches GLSL content uv)
const INTENSITY_W = 64;      // intensity/blend map width in cells (NVAPI upsamples to the raster)

// Normalized [0,1] display-space destination point for a content texcoord (u,v) — the warped position
// the GLSL renderer would place that texel at. Bézier warp supersedes the corner-pin when present.
function destFn(out: ProjectorOutput): (u: number, v: number) => P {
  if (out.warp && out.warp.points.length === 16) {
    const w = out.warp;
    return (u, v) => evalBezier(w, u, v);
  }
  const m: Mat3 = squareToQuad(out.cornerPin ?? defaultCornerPin());
  return (u, v) => applyH(m, u, v);
}

// True when the output applies no 2D geometry change (default corner-pin, no Bézier warp). A flat grid
// is still emitted (a harmless pass-through) so an hwWarp output is always fully defined.
export function isIdentityWarp(out: ProjectorOutput): boolean {
  if (out.warp && out.warp.points.length === 16) return false;
  const c = out.cornerPin ?? defaultCornerPin();
  const d = defaultCornerPin();
  const eq = (a: P, b: P) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  return eq(c.tl, d.tl) && eq(c.tr, d.tr) && eq(c.br, d.br) && eq(c.bl, d.bl);
}

// Build the NVAPI warp vertex buffer: a WARP_TESS×WARP_TESS triangle LIST, 6 floats/vert
// [X, Y, U, V, R, Q]. X,Y = warped destination in normalized display space; U,V = content texcoord;
// R = 1, Q = 1 (dense grid → no per-vertex perspective divide). Triangle decomposition + winding match
// ProjectorGL.buildGeometry's Bézier branch exactly.
export function buildWarpVerts(out: ProjectorOutput, n = WARP_TESS): number[] {
  const dest = destFn(out);
  // Precompute lattice nodes (n+1)² so each is evaluated once.
  const node: P[] = new Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const [dx, dy] = dest(i / n, j / n);
      node[j * (n + 1) + i] = [dx, NV_FLIP_Y ? 1 - dy : dy];
    }
  }
  const verts: number[] = [];
  const push = (i: number, j: number) => {
    const p = node[j * (n + 1) + i];
    const u = i / n, v = j / n;
    verts.push(p[0], p[1], u, NV_FLIP_V ? 1 - v : v, 1, 1);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // two triangles per cell: (00,10,11) then (00,11,01) — same winding as the GLSL path
      push(i, j); push(i + 1, j); push(i + 1, j + 1);
      push(i, j); push(i + 1, j + 1); push(i, j + 1);
    }
  }
  return verts;
}

// The source desktop rect (physical px) the warp texcoords index into: this display's own scanout rect.
export function warpSrcRect(display: DisplayInfo): [number, number, number, number] {
  const sf = display.scaleFactor || 1;
  return [
    Math.round(display.bounds.x * sf),
    Math.round(display.bounds.y * sf),
    Math.round(display.bounds.width * sf),
    Math.round(display.bounds.height * sf),
  ];
}

const featherWeight = (d: number, w: number) => (w <= 0 ? 1 : Math.max(0, Math.min(1, d / w)));

// Even-odd point-in-polygon (normalized content space). Used for the projector exclusion mask.
function pointInPoly(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 0 if (u,v) falls inside any projector-mask exclusion polygon (blacked out), else 1.
function maskWeight(out: ProjectorOutput, u: number, v: number): number {
  const polys = out.projMask?.polys;
  if (!polys?.length) return 1;
  for (const poly of polys) if (poly.length >= 3 && pointInPoly(u, v, poly)) return 0;
  return 1;
}

// Bilinear sample of a low-res w×h grid (row-major) at normalized (u,v) ∈ [0,1].
function sampleGrid(data: Float32Array, w: number, h: number, u: number, v: number): number {
  const fx = Math.max(0, Math.min(1, u)) * (w - 1);
  const fy = Math.max(0, Math.min(1, v)) * (h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = data[y0 * w + x0], bb = data[y0 * w + x1];
  const c = data[y1 * w + x0], dd = data[y1 * w + x1];
  return a * (1 - tx) * (1 - ty) + bb * tx * (1 - ty) + c * (1 - tx) * ty + dd * tx * ty;
}
const sampleBlend = (b: BlendMap, u: number, v: number): number => sampleGrid(b.data, b.w, b.h, u, v);

// Build the NVAPI intensity/blend texture: w*h*3 floats (RGB, 0..1). Replicates the GLSL fragment
// shader's soft-edge feather (product of the four edge ramps, taken to the inverse projector gamma) on a CPU grid,
// then multiplies in an optional world-space blend map (blendCompute.ts) for true multi-projector
// partition-of-unity blending. NOTE (MVP): the GLSL feather is defined in content space but NVAPI
// intensity is applied in screen space; for near-identity warps these coincide. Exact per-pixel parity
// under a strong warp is a later refinement.
export function buildIntensity(
  out: ProjectorOutput,
  blendMap: BlendMap | null,
  w = INTENSITY_W,
  h = Math.max(1, Math.round(INTENSITY_W * 9 / 16)),
): { w: number; h: number; rgb: number[] } {
  const se = out.softEdge ?? { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 };
  const g = Math.max(0.1, se.gamma ?? 2.2);
  const gain = out.colorGain ?? [1, 1, 1];     // per-channel white-point/brightness match
  const lift = out.blackLift ?? [0, 0, 0];      // per-channel additive black floor (overlap match)
  const rgb = new Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const v = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0;
      // LINEAR share of the light this projector owns here: the four edge ramps, times the
      // world-space partition-of-unity weight when a multi-projector blend map was solved.
      let share = featherWeight(u, se.left) * featherWeight(1 - u, se.right)
                * featherWeight(v, se.top) * featherWeight(1 - v, se.bottom);
      if (blendMap) share *= sampleBlend(blendMap, u, v);
      // …then to a SIGNAL, which is share^(1/g) because the projector emits signal^g. Both halves of
      // an overlap then emit exactly their share and the pair sums to 1. This mirrors the same fix in
      // ProjectorGL's FRAG (it read pow(share, g) here too, i.e. a dark seam in hardware as well).
      // ⚠ UNVALIDATED ON HARDWARE — like the other NVAPI conventions in this file, it needs a
      // Quadro/RTX-pro with two overlapping projectors to confirm against the GLSL path.
      let a = Math.pow(share, 1 / g);
      a *= maskWeight(out, u, v);               // projector exclusion mask (0 inside)
      // Spatial black-lift weight (where this projector sees the least overlap → lift its black most).
      const bw = blendMap?.black ? sampleGrid(blendMap.black, blendMap.w, blendMap.h, u, v) : 1;
      const i = (y * w + x) * 3;
      // NVAPI intensity is a per-channel multiply: colorGain applies exactly; the additive black lift
      // raises the floor by blackLift × spatial-weight, clamped to 1.
      rgb[i]     = Math.min(1, a * gain[0] + lift[0] * bw);
      rgb[i + 1] = Math.min(1, a * gain[1] + lift[1] * bw);
      rgb[i + 2] = Math.min(1, a * gain[2] + lift[2] * bw);
    }
  }
  return { w, h, rgb };
}

export interface NvwarpPayload {
  verts: number[];
  src: [number, number, number, number];
  intensity: { w: number; h: number; rgb: number[] };
}

// Full NVAPI payload for an output on a given display. Always returns a complete (warp, intensity) pair
// so applying hwWarp fully defines the display's scanout state (a default output → flat pass-through
// grid + all-1 intensity = visually identical to no warp). Caller pushes both, or clears to remove.
export function outputToNvwarp(
  out: ProjectorOutput,
  display: DisplayInfo,
  blendMap: BlendMap | null = null,
): NvwarpPayload {
  return {
    verts: buildWarpVerts(out),
    src: warpSrcRect(display),
    intensity: buildIntensity(out, blendMap),
  };
}
