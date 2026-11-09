// Pure geometry for the camera INTERACTION AREA — no DOM, no stores, so it is testable on its own and
// shared by the runtime (poseArea.ts), the calibration wizard (QuadPicker) and the floor tab.
//
// SPACES. Everything here is normalized and BOTTOM-LEFT origin, Y up — the pose store's convention:
//   image space — the camera frame, 0..1 (what BlazePose landmarks are in after poseEngine's flip)
//   area space  — the marked quad, 0..1, where trigger zones live (u right, v up)
// A quad is [tl, tr, br, bl] as the OPERATOR sees them in the camera image: tl is the top-left corner
// on screen, so in bottom-left space it has the HIGH y.

import { squareToQuad, applyH, type Mat3 } from '@/projector/homography'; // transitional @/ seam (pure util)
import { invert } from './poseHomography';
import type { PoseLandmark } from './poseStore';

export type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** The inset rectangle a fresh calibration starts from — clearly a placeholder, never a guess. */
export const DEFAULT_QUAD: Quad = [[0.2, 0.8], [0.8, 0.8], [0.8, 0.2], [0.2, 0.2]];

const pin = (q: Quad) => ({ tl: q[0], tr: q[1], br: q[2], bl: q[3] });

// ── VALIDATION — a quad the homography can trust, or the reason it can't ──────────────────────────
// Every way a 4-point pick goes wrong produces a matrix that LOOKS fine and maps people to nonsense:
// two corners dragged past each other (a bow-tie), corners clicked in the wrong order, three corners
// on a line, a sliver. So Save is refused with the reason instead of silently storing it.
export const MIN_AREA = 0.02; // of the image — below this a pixel of landmark jitter is a zone's width

export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) { const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % 4]; a += x0 * y1 - x1 * y0; }
  return a / 2; // signed: NEGATIVE for tl→tr→br→bl clockwise on screen (y up)
}

export function validateQuad(q: Quad): string | null {
  for (const p of q) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return 'A corner has no position.';
  // Convex + consistently wound: every turn the same way. A sign change = a dent or a crossing.
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return 'Three corners are in a line — spread them out.';
    if (cross > 0) pos++; else neg++;
  }
  if (pos && neg) return 'The corners cross or dent inwards — drag them back into a clean four-sided shape.';
  if (pos === 4) return 'The corners are in the wrong order — TL, TR, BR, BL must go clockwise. Use Mirror to flip the area instead.';
  if (Math.abs(quadArea(q)) < MIN_AREA) return 'The area is too small — make it cover more of the picture.';
  return null;
}

// ── IMAGE → AREA ──────────────────────────────────────────────────────────────────────────────────
// squareToQuad sends square (0,0)(1,0)(1,1)(0,1) to tl,tr,br,bl — i.e. the square's t runs DOWN the
// quad. Inverted, an image point gives (s,t) with t = 0 on the top edge, so area v = 1 - t.
// Returns null for an invalid quad — the caller treats that as "not calibrated", never as identity.
export function imageToArea(q: Quad): Mat3 | null {
  if (validateQuad(q)) return null;
  return invert(squareToQuad(pin(q)));
}

export function mapToArea(h: Mat3, x: number, y: number, mirror?: boolean): [number, number] {
  const [s, t] = applyH(h, x, y);
  return [mirror ? 1 - s : s, 1 - t];
}

/** Area → image (for drawing a grid or zones back over the camera picture). */
export function areaToImage(q: Quad, u: number, v: number, mirror?: boolean): [number, number] {
  return applyH(squareToQuad(pin(q)), mirror ? 1 - u : u, 1 - v);
}

// ── BODY PARTS ────────────────────────────────────────────────────────────────────────────────────
// BlazePose's 33 landmarks reduced to what an operator assigns to a zone. Left/right are the PERSON's
// own sides (BlazePose's labelling) — the mirror toggle flips where they are drawn, never which is which.
export const PARTS = [
  { id: 'handL', label: 'Left hand' },
  { id: 'handR', label: 'Right hand' },
  { id: 'footL', label: 'Left foot' },
  { id: 'footR', label: 'Right foot' },
  { id: 'head', label: 'Head' },
  { id: 'body', label: 'Body' },
] as const;
export type PartId = (typeof PARTS)[number]['id'];

const VIS = 0.5; // below this BlazePose is guessing — an occluded hand must not "touch" a pad
const NOSE = 0, WRIST_L = 15, WRIST_R = 16, INDEX_L = 19, INDEX_R = 20, HIP_L = 23, HIP_R = 24;
const HEEL_L = 29, HEEL_R = 30, FOOT_L = 31, FOOT_R = 32;

export interface PartPoint { part: PartId; x: number; y: number }

export function extractParts(lm: PoseLandmark[] | undefined): PartPoint[] {
  if (!lm || lm.length < 33) return [];
  const out: PartPoint[] = [];
  const ok = (i: number) => lm[i] && lm[i].visibility >= VIS;
  // A HAND is between the wrist and the index knuckle — where a palm presses a wall. Either alone is
  // accepted (a fist hides the index), both averaged when both are seen.
  const hand = (part: PartId, w: number, ix: number) => {
    if (ok(w) && ok(ix)) out.push({ part, x: (lm[w].x + lm[ix].x) / 2, y: (lm[w].y + lm[ix].y) / 2 });
    else if (ok(w)) out.push({ part, x: lm[w].x, y: lm[w].y });
    else if (ok(ix)) out.push({ part, x: lm[ix].x, y: lm[ix].y });
  };
  const foot = (part: PartId, tip: number, heel: number) => {
    const i = ok(tip) ? tip : ok(heel) ? heel : -1;
    if (i >= 0) out.push({ part, x: lm[i].x, y: lm[i].y });
  };
  hand('handL', WRIST_L, INDEX_L);
  hand('handR', WRIST_R, INDEX_R);
  foot('footL', FOOT_L, HEEL_L);
  foot('footR', FOOT_R, HEEL_R);
  if (ok(NOSE)) out.push({ part: 'head', x: lm[NOSE].x, y: lm[NOSE].y });
  if (ok(HIP_L) && ok(HIP_R)) out.push({ part: 'body', x: (lm[HIP_L].x + lm[HIP_R].x) / 2, y: (lm[HIP_L].y + lm[HIP_R].y) / 2 });
  return out;
}

/** Points just outside the area are kept (to MARGIN) so a hand ON the edge does not blink in and out. */
export const MARGIN = 0.05;
export const inArea = (u: number, v: number): boolean =>
  u >= -MARGIN && u <= 1 + MARGIN && v >= -MARGIN && v <= 1 + MARGIN;
