// The PURE half of the drift check: given where the camera saw the probe dots and where the
// (freshly re-anchored) camera pose says those world points should appear, how far has the projection
// moved on the surface?
//
// Split out from driftCheck.ts deliberately. That file drives the projector and the camera, which
// means it pulls in the bridge and the capture singleton, which means it cannot be compiled and run
// on its own. This is the part whose wrong answer decides whether anybody gets woken up, so it has to
// be testable with nothing but node — the same reason blendCompute.ts imports nothing.

import { reproject } from './cvCamera';

export interface DriftScore {
  /** Probes whose dot was found in the camera image. */
  matched: number;
  expected: number;
  rmsPx: number;    // camera px
  p95Px: number;
  /** The number an operator can act on: how far off the SURFACE the projection has moved. */
  rmsMm: number;
  maxMm: number;
}

export const EMPTY_SCORE: DriftScore = {
  matched: 0, expected: 0, rmsPx: Infinity, p95Px: Infinity, rmsMm: Infinity, maxMm: Infinity,
};

export interface Blob { x: number; y: number; mass: number }

// Find bright blobs in (frame − reference) with intensity-weighted centroids. The black-reference
// subtraction is what makes this survive a venue's ambient light — an exit sign or a standby LED is
// bright but UNCHANGED, and only what changed when the dots were lit can be a dot.
export function findBlobs(
  frame: Uint8Array, black: Uint8Array, w: number, h: number,
  threshold = 40, minMass = 8,
): Blob[] {
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  const lit = (p: number) => frame[p] - black[p] >= threshold;
  for (let i = 0; i < w * h; i++) {
    if (seen[i]) continue;
    if (!lit(i)) { seen[i] = 1; continue; }
    let sx = 0, sy = 0, sm = 0, n = 0;
    stack.length = 0; stack.push(i); seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % w, py = (p / w) | 0;
      const d = frame[p] - black[p];
      sx += px * d; sy += py * d; sm += d; n++;
      if (px > 0 && !seen[p - 1] && lit(p - 1)) { seen[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && !seen[p + 1] && lit(p + 1)) { seen[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !seen[p - w] && lit(p - w)) { seen[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && !seen[p + w] && lit(p + w)) { seen[p + w] = 1; stack.push(p + w); }
    }
    if (n >= minMass && sm > 0) blobs.push({ x: sx / sm, y: sy / sm, mass: sm });
  }
  return blobs;
}

// Project a world point into the camera. A camera and a projector share the model — they differ only
// in which way the light travels — so this is the same reproject the projector residuals use.
function camProject(
  camK: number[], camDist: number[], camR: number[], camT: [number, number, number],
  X: [number, number, number],
): { u: number; v: number; z: number } | null {
  const p = reproject(camK, camDist, camR, camT, X);
  if (!p) return null;
  // Depth in the camera frame — what turns a pixel error into millimetres on the surface.
  const z = camR[6] * X[0] + camR[7] * X[1] + camR[8] * X[2] + camT[2];
  if (!(z > 0)) return null;
  return { u: p[0], v: p[1], z };
}

export interface ScoreInput {
  /** Probe world points, flat XYZ triples — only those LIT in this frame. */
  world: number[];
  blobs: Blob[];
  camK: number[]; camDist: number[]; camR: number[]; camT: [number, number, number];
  /** Match radius in camera px — beyond this a blob is not this probe. */
  searchPx?: number;
}

export interface Matches { errsPx: number[]; errsMm: number[]; expected: number }

// One frame's matching. Deliberately per-frame: the dots are time-multiplexed so that identity stays
// certain even when a projector really HAS drifted, and pooling every frame's blobs before matching
// would throw exactly that away.
export function matchProbes(inp: ScoreInput): Matches {
  const { world, blobs, camK, camDist, camR, camT } = inp;
  const searchPx = inp.searchPx ?? 40;
  const n = Math.floor(world.length / 3);
  const errsPx: number[] = [], errsMm: number[] = [];
  const fx = camK[0] || 1;
  for (let i = 0; i < n; i++) {
    const X: [number, number, number] = [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]];
    const exp = camProject(camK, camDist, camR, camT, X);
    if (!exp) continue;
    let bestD = Infinity;
    for (const b of blobs) {
      const d = Math.hypot(b.x - exp.u, b.y - exp.v);
      if (d < bestD) bestD = d;
    }
    if (!(bestD <= searchPx)) continue;
    errsPx.push(bestD);
    // px → mm on the surface: a pixel subtends z/fx metres at depth z.
    errsMm.push((bestD * exp.z / fx) * 1000);
  }
  return { errsPx, errsMm, expected: n };
}

/** Aggregate one or more frames' matches into the score a policy acts on. */
export function aggregate(parts: Matches[]): DriftScore {
  const errsPx = parts.flatMap((p) => p.errsPx);
  const errsMm = parts.flatMap((p) => p.errsMm);
  const expected = parts.reduce((s, p) => s + p.expected, 0);
  if (!errsPx.length) return { ...EMPTY_SCORE, expected, matched: 0 };
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const sortedPx = [...errsPx].sort((a, b) => a - b);
  return {
    matched: errsPx.length,
    expected,
    rmsPx: rms(errsPx),
    p95Px: sortedPx[Math.min(sortedPx.length - 1, Math.floor(sortedPx.length * 0.95))],
    rmsMm: rms(errsMm),
    maxMm: Math.max(...errsMm),
  };
}

/** Single-frame convenience. */
export const scoreDrift = (inp: ScoreInput): DriftScore => aggregate([matchProbes(inp)]);

// Pick a well-spread subset of a dense map as the persistent probe set. Grid-bucketed, not random:
// dots must be far enough apart that a blob can only plausibly belong to one, and they must cover the
// whole footprint or a rotation about the centre would score as no drift at all.
export function pickProbes(
  denseMap: { proj: number[]; world: number[] }, raster: [number, number], target = 160,
): { proj: number[]; world: number[] } {
  const [pw, ph] = raster;
  const cols = Math.max(2, Math.round(Math.sqrt(target * (pw / Math.max(1, ph)))));
  const rows = Math.max(2, Math.round(target / cols));
  const best = new Map<number, number>();
  const bestD = new Map<number, number>();
  const n = Math.floor(denseMap.proj.length / 2);
  for (let i = 0; i < n; i++) {
    const x = denseMap.proj[i * 2], y = denseMap.proj[i * 2 + 1];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x / pw) * cols)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y / ph) * rows)));
    const k = cy * cols + cx;
    const centreX = ((cx + 0.5) / cols) * pw, centreY = ((cy + 0.5) / rows) * ph;
    const d = Math.hypot(x - centreX, y - centreY);
    if (!bestD.has(k) || d < bestD.get(k)!) { bestD.set(k, d); best.set(k, i); }
  }
  const proj: number[] = [], world: number[] = [];
  for (const i of best.values()) {
    proj.push(denseMap.proj[i * 2], denseMap.proj[i * 2 + 1]);
    world.push(denseMap.world[i * 3], denseMap.world[i * 3 + 1], denseMap.world[i * 3 + 2]);
  }
  return { proj, world };
}

/** Split probes into frames whose lit dots are far enough apart to be unambiguous. */
export function groupProbes(proj: number[], raster: [number, number], groups = 4, dotRadius = 6): number[][] {
  const [pw] = raster;
  const cols = Math.max(1, Math.round(pw / (dotRadius * 12)));
  const out: number[][] = Array.from({ length: groups }, () => []);
  const n = Math.floor(proj.length / 2);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((proj[i * 2] / pw) * cols);
    out[(cx + i) % groups].push(i);
  }
  return out.filter((g) => g.length);
}
