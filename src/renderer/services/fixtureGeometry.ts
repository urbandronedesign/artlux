import { Fixture, LedShape } from '../types';
import { isPixel } from './fixtureKind';

// ── DEFAULT FIXTURE GEOMETRY — the created rect IS the fixture's shape, not a placeholder ──────
//
// A pixel fixture used to spawn as a hardcoded 0.2×0.2 square, which tells the operator nothing:
// a 150-LED bar and an 8×8 matrix looked identical until hand-resized. The created rect now comes
// from what the fixture says it physically is — a strip is one cell tall and ledCount cells wide,
// a matrix is matrixWidth × matrixHeight cells — so the canvas shape reads as the device.
//
// Units: fixture geometry is normalized 0–1 over the stage document, and the document is a unit
// square drawn at a 512px base box (Stage.tsx stageW/stageH, contentAspect 1). "One cell = 4px"
// therefore means 4 document-pixels at 100% zoom — the only zoom-independent pixel there is.
//
// Why 4: it divides 512 exactly, so a default strip covers ledCount/128 of a full-document
// surface and the atlas demand WebGPUMapper.cellSizes derives from that coverage
// (ledCount ÷ fraction × 2 oversample = 256) lands exactly on its power-of-two step with zero
// round-up waste. (5px rounds up to the same 256 — the pow2 clamp flattens the difference — so
// this is tidiness, not a measured win; the real atlas driver is how much of its surface the
// operator stretches the fixture over afterwards.)
const DOC_PX = 512;      // Stage base box — keep in sync with Stage.tsx stageW/stageH
const CELL_PX = 4;       // one LED cell, both axes
// A long strip stops growing at 80% of the document instead of running off it — the per-LED pitch
// gives way, the one-cell height does not. A matrix shrinks uniformly so its aspect (which is the
// information) survives the clamp.
const MAX_FRAC = 0.8;

/** The rect a fixture's own pixel description implies, in normalized document units. */
export function derivedFixtureRect(
  f: Pick<Fixture, 'ledCount' | 'shape' | 'matrixWidth' | 'matrixHeight'>,
): { width: number; height: number } {
  const cell = CELL_PX / DOC_PX;
  if (f.shape === LedShape.MATRIX) {
    let w = Math.max(1, f.matrixWidth ?? 1) * cell;
    let h = Math.max(1, f.matrixHeight ?? 1) * cell;
    const over = Math.max(w, h) / MAX_FRAC;
    if (over > 1) { w /= over; h /= over; }
    return { width: w, height: h };
  }
  return { width: Math.min(MAX_FRAC, Math.max(1, f.ledCount) * cell), height: cell };
}

const EPS = 1e-6;

/**
 * Re-derive the rect after a pixel-description edit (ledCount / shape / matrix dims) — but ONLY
 * while the rect is still exactly what derivation produced from the OLD description. The moment
 * the operator resizes by hand the geometry is theirs and this never touches it again; moving
 * the fixture doesn't break the tracking (the re-derived rect keeps the operator's center).
 * No persisted flag, no migration: a project saved before this feature holds a 0.2×0.2 square,
 * which matches no derivation, so existing rigs are untouched by construction.
 */
export function retrackDerivedRect(prev: Fixture, next: Fixture): Fixture {
  if (!isPixel(next)) return next;
  const changed =
    prev.ledCount !== next.ledCount || prev.shape !== next.shape ||
    prev.matrixWidth !== next.matrixWidth || prev.matrixHeight !== next.matrixHeight;
  if (!changed) return next;
  const old = derivedFixtureRect(prev);
  if (Math.abs(prev.width - old.width) > EPS || Math.abs(prev.height - old.height) > EPS) return next;
  const d = derivedFixtureRect(next);
  return {
    ...next,
    width: d.width,
    height: d.height,
    x: prev.x + (prev.width - d.width) / 2,
    y: prev.y + (prev.height - d.height) / 2,
  };
}
