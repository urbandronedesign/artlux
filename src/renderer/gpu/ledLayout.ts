import { type Fixture, type Surface, type PixelSource, LedShape, RGBWMode } from '../types';

// THE LED LAYOUT — the CPU half of LED sampling: where every LED samples (surface-local UV), which
// segment it belongs to, which surface it reads, and how the surfaces' cells pack into one atlas.
//
// Extracted VERBATIM from gpu/WebGPUMapper.ts (E1b-2, plans/native-engine.md §9c) so it has a seam: pure
// functions the native engine's Rust port (engine/artlux-engine/src/layout.rs) is held to BIT FOR BIT by
// scripts/test-sampling-parity.cjs. WebGPUMapper calls these; nothing about its output changed in the move.

export const SOURCE_SIZE = 512;      // fallback cell size (uniform-grid fallback + the legacy updateSource path)
// --- Adaptive atlas sizing -----------------------------------------------------------------------
// A surface's atlas cell used to be a fixed 512² square for everyone. That is simultaneously too
// coarse for a dense matrix (a 64-wide matrix on half a surface wants ~256 columns of real detail)
// and pure waste for a 60-LED strip. Sampling is normalized, so cell size/shape is a QUALITY and
// COST decision only — never a correctness one (docs/ARCHITECTURE.md). So: size each cell from the
// LED density actually mapped onto that surface, and pack the differently-sized cells.
export const OVERSAMPLE = 2;         // texels per LED along each axis (Nyquist-ish; degraded on overflow)
export const MIN_CELL = 64;          // floor — a sparse surface still needs enough to look sane in preview
export const MAX_CELL = 1024;        // ceiling per axis, before packing limits apply
export const ceilPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export interface AtlasRect { x: number; y: number; w: number; h: number } // pixels within the atlas

export interface SegLike { start: number; stop: number; off?: boolean; source?: PixelSource; effectId?: number; paletteId?: number; speed?: number; intensity?: number; }

export function fixtureSegments(f: Fixture): SegLike[] {
  if (f.segments && f.segments.length) return f.segments;
  return [{ start: 0, stop: f.ledCount, source: f.source, effectId: f.effectId, paletteId: f.paletteId, speed: f.speed, intensity: f.intensity }];
}

// Build the segParams buffer contents: 2x vec4 per segment + 1 trailing "off" entry.
export function buildSegParams(fixtures: Fixture[]): Float32Array {
  const segs: { s: SegLike; f: Fixture }[] = [];
  for (const f of fixtures) for (const s of fixtureSegments(f)) segs.push({ s, f });
  const out = new Float32Array((segs.length + 1) * 8);
  segs.forEach(({ s, f }, k) => {
    const base = k * 8;
    // S3: every fixture samples its linked surface's texture (media). Per-fixture
    // effects are retired — effects live on surfaces now. An off segment outputs black:
    // mode -2 is already the WGSL "off" path (mode < -1.5), same as the trailing gap entry.
    out[base + 0] = s.off ? -2 : -1; // -2 off (gap) / -1 media
    out[base + 4] = f.rgbwMode === RGBWMode.NONE ? 1 : 0;
  });
  // trailing off-segment for gap LEDs
  out[segs.length * 8 + 0] = -2;
  return out;
}

export function countSegments(fixtures: Fixture[]): number {
  let n = 0;
  for (const f of fixtures) n += fixtureSegments(f).length;
  return n;
}

/** Surfaces referenced by ≥1 fixture, in surface order. A surface's pass index is its position here. */
export function surfaceOrderOf(fixtures: Fixture[], surfaces: Surface[]): string[] {
  return surfaces.filter(s => fixtures.some(f => f.surfaceId === s.id)).map(s => s.id);
}

// How many texels each surface's cell wants, from the LED density mapped onto it. A fixture whose
// 32 LEDs span half the surface implies the FULL surface needs ~64 columns to resolve them, so the
// LED count is divided by the fraction of the surface the fixture covers. Max over its fixtures.
export function cellSizes(surfaceOrder: string[], fixtures: Fixture[], surfaces: Surface[], oversample: number): { w: number; h: number }[] {
  return surfaceOrder.map((sid) => {
    const s = surfaces.find((x) => x.id === sid);
    const sw = Math.max(1e-6, s?.width ?? 1);
    const sh = Math.max(1e-6, s?.height ?? 1);
    let needU = 0, needV = 0;
    for (const f of fixtures) {
      if (f.surfaceId !== sid) continue;
      let lu: number, lv: number;
      if (f.shape === LedShape.MATRIX) {
        lu = Math.max(1, f.matrixWidth ?? 1);
        lv = Math.max(1, f.matrixHeight ?? 1);
      } else if (f.width >= f.height) { lu = Math.max(1, f.ledCount); lv = 1; }
      else { lu = 1; lv = Math.max(1, f.ledCount); }
      // A rotated fixture's chain runs across BOTH surface axes; without an exact projection just
      // demand the larger count on each axis rather than under-resolving the diagonal.
      const rot = Math.abs((f.rotation || 0) % 180);
      if (rot > 1 && rot < 179) { const m = Math.max(lu, lv); lu = m; lv = m; }
      // Fraction of the surface this fixture covers, capped at 1 so a fixture larger than its
      // surface can't *reduce* the demand.
      const fu = Math.min(1, Math.max(1e-3, (f.width || 0) / sw));
      const fv = Math.min(1, Math.max(1e-3, (f.height || 0) / sh));
      needU = Math.max(needU, lu / fu);
      needV = Math.max(needV, lv / fv);
    }
    const clamp = (n: number): number => Math.min(MAX_CELL, Math.max(MIN_CELL, ceilPow2(n * oversample)));
    // No linked fixture shouldn't happen (surfaceOrder is filtered to linked surfaces) but a
    // surface can be re-linked live, so it still gets a usable cell rather than a zero-sized one.
    return { w: clamp(needU || MIN_CELL), h: clamp(needV || MIN_CELL) };
  });
}

// Shelf packer: sort by height desc, fill rows left→right, start a new shelf when the row is full.
// Deterministic and more than good enough for the handful of surfaces a show has. Returns null if
// the result won't fit the device's max texture dimension.
export function packAtlas(sizes: { w: number; h: number }[], maxDim: number): { rects: AtlasRect[]; w: number; h: number } | null {
  if (!sizes.length) return { rects: [], w: 1, h: 1 };
  const area = sizes.reduce((a, s) => a + s.w * s.h, 0);
  const widest = sizes.reduce((a, s) => Math.max(a, s.w), 0);
  if (widest > maxDim) return null;
  // Start near-square, grow the shelf width until the stack fits (or we run out of texture).
  for (let width = Math.min(maxDim, Math.max(widest, ceilPow2(Math.sqrt(area)))); width <= maxDim; width *= 2) {
    const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h);
    const rects: AtlasRect[] = new Array(sizes.length);
    let x = 0, y = 0, shelfH = 0, ok = true;
    for (const i of order) {
      const { w, h } = sizes[i];
      if (x + w > width) { x = 0; y += shelfH; shelfH = 0; }   // next shelf
      if (y + h > maxDim) { ok = false; break; }
      rects[i] = { x, y, w, h };
      x += w;
      if (h > shelfH) shelfH = h;
    }
    // Round the stack height up to a power of two, but never past the device limit (maxDim is 8192
    // — a power of two — on every device seen so far, but don't bet the texture creation on it).
    if (ok) return { rects, w: width, h: Math.min(maxDim, ceilPow2(y + shelfH)) };
    if (width === maxDim) break;
  }
  return null;
}

/**
 * Size each surface's cell from its LED density and pack the cells — degrading rather than failing:
 * halve the oversample, then fall back to minimum cells. `usedOversample` 0 means minimum cells;
 * `packed` null means even those overflowed (the caller warns and samples nothing).
 */
export function planAtlas(surfaceOrder: string[], fixtures: Fixture[], surfaces: Surface[], maxDim: number): { packed: { rects: AtlasRect[]; w: number; h: number } | null; usedOversample: number } {
  let packed: { rects: AtlasRect[]; w: number; h: number } | null = null;
  let usedOversample = OVERSAMPLE;
  for (const os of [OVERSAMPLE, OVERSAMPLE / 2, OVERSAMPLE / 4]) {
    packed = packAtlas(cellSizes(surfaceOrder, fixtures, surfaces, os), maxDim);
    if (packed) { usedOversample = os; break; }
  }
  if (!packed) {
    packed = packAtlas(surfaceOrder.map(() => ({ w: MIN_CELL, h: MIN_CELL })), maxDim);
    usedOversample = 0;
  }
  return { packed, usedOversample };
}

/** UV rects for the shader, half-texel inset inside each rect's OWN pixels so linear filtering can
 *  never reach the neighbouring surface packed beside it. */
export function atlasRectData(rects: AtlasRect[], atlasW: number, atlasH: number): Float32Array {
  const rectData = new Float32Array(Math.max(1, rects.length) * 4);
  rects.forEach((r, i) => {
    rectData[i * 4 + 0] = (r.x + 0.5) / atlasW;
    rectData[i * 4 + 1] = (r.y + 0.5) / atlasH;
    rectData[i * 4 + 2] = Math.max(0, r.w - 1) / atlasW;
    rectData[i * 4 + 3] = Math.max(0, r.h - 1) / atlasH;
  });
  return rectData;
}

/**
 * Per LED: `led` = (u, v, t, segIndex), `meta` = (segStartGlobal, segLen, localIndex, surfaceIndex).
 * Unlinked LEDs carry surface index 65535 — never matched by a pass, left black.
 */
export function buildLedData(fixtures: Fixture[], surfaces: Surface[], surfaceOrder: string[], segCount: number): { led: Float32Array; meta: Float32Array; total: number } {
  const newTotal = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
  const OFF = 65535; // unlinked LEDs — never matched by a pass, left black
  const led = new Float32Array(newTotal * 4);   // (u, v, t, segIndex)
  const meta = new Float32Array(newTotal * 4);  // (segStartGlobal, segLen, localIndex, 0)
  let o = 0, m = 0;
  let ledBase = 0;   // global LED index of this fixture's first LED
  let segCursor = 0; // global segment index of this fixture's first segment
  const offSeg = segCount;

  fixtures.forEach((f) => {
    const segs = fixtureSegments(f);
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    const rads = (f.rotation || 0) * (Math.PI / 180);
    const cos = Math.cos(rads), sin = Math.sin(rads);

    // Linked surface → inverse transform a global point into surface-local UV.
    const surf = surfaces.find(s => s.id === f.surfaceId) || null;
    const sIdx = surf ? surfaceOrder.indexOf(surf.id) : OFF;
    const scx = surf ? surf.x + surf.width / 2 : 0;
    const scy = surf ? surf.y + surf.height / 2 : 0;
    const sr = surf ? -(surf.rotation || 0) * (Math.PI / 180) : 0;
    const scos = Math.cos(sr), ssin = Math.sin(sr);
    const sw = surf ? (surf.width || 1) : 1;
    const sh = surf ? (surf.height || 1) : 1;
    const isMatrix = f.shape === LedShape.MATRIX;
    const cols = Math.max(1, f.matrixWidth ?? 1);
    const rows = Math.max(1, f.matrixHeight ?? 1);
    const cells = cols * rows;
    const isHoriz = f.width >= f.height;

    for (let i = 0; i < f.ledCount; i++) {
      // which segment contains output index i
      let j = -1;
      for (let q = 0; q < segs.length; q++) { if (i >= segs[q].start && i < segs[q].stop) { j = q; break; } }
      let segIndex: number, segStartGlobal: number, segLen: number, local: number, tt: number;
      if (j < 0) {
        segIndex = offSeg; segStartGlobal = 0; segLen = 0; local = 0; tt = 0;
      } else {
        const s = segs[j];
        segIndex = segCursor + j;
        segStartGlobal = ledBase + s.start;
        segLen = s.stop - s.start;
        local = i - s.start;
        tt = segLen > 1 ? local / (segLen - 1) : 0;
        if (f.reverse) tt = 1 - tt;
      }

      // geometry (uv) from the geometry index g (reverse- + ledmap-aware).
      // Reverse flips the whole fixture's pixel order so output index i samples
      // the geometry of the opposite end (matches led3dLayout's local.reverse()).
      const gi = f.reverse ? f.ledCount - 1 - i : i;
      const g = f.ledMap ? (f.ledMap[gi] ?? gi) : gi;
      let relX = 0, relY = 0;
      if (isMatrix) {
        const gg = Math.min(g, cells - 1);
        const row = Math.floor(gg / cols);
        let col = gg % cols;
        if (f.serpentine && row % 2 === 1) col = cols - 1 - col;
        relX = (col + 0.5) * (f.width / cols) - f.width / 2;
        relY = (row + 0.5) * (f.height / rows) - f.height / 2;
      } else if (isHoriz) {
        const step = f.width / f.ledCount;
        relX = g * step + step / 2 - f.width / 2;
      } else {
        const step = f.height / f.ledCount;
        relY = g * step + step / 2 - f.height / 2;
      }
      const rx = relX * cos - relY * sin;
      const ry = relX * sin + relY * cos;
      const gx = cx + rx, gy = cy + ry;

      // Surface-local UV (clamped sampler handles out-of-range); falls back to
      // the global point when unlinked (those LEDs are off / cleared anyway).
      let uu = gx, vv = gy;
      if (surf) {
        const ddx = gx - scx, ddy = gy - scy;
        const lx = ddx * scos - ddy * ssin;
        const ly = ddx * ssin + ddy * scos;
        uu = lx / sw + 0.5; vv = ly / sh + 0.5;
      }

      led[o++] = uu; led[o++] = vv; led[o++] = tt; led[o++] = segIndex;
      meta[m++] = segStartGlobal; meta[m++] = segLen; meta[m++] = local; meta[m++] = sIdx;
    }
    ledBase += f.ledCount;
    segCursor += segs.length;
  });
  return { led, meta, total: newTotal };
}
