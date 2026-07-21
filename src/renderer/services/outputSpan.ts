import type { OutputSpan, SoftEdge, SrcRect } from '../../../shared/protocol';

// The grid math behind spanning ONE picture across SEVERAL projectors.
//
// A span cuts a source surface into cols×rows overlapping tiles. Each tile becomes a SLICE surface
// (SurfaceContent.sliceOf + sliceRect) with its own ProjectorOutput, so it keeps its own homography,
// warp, gamma and colour match; the shared edges are feathered so the projectors sum to one picture.
//
// Pure functions — no React, no IPC, no DOM — for the same reason projector/nvwarpApply.ts and the
// calibration plugin's blendCompute.ts are: this is geometry that has to be RIGHT, and a pure module
// can be proven with a throwaway `tsc`-checked script instead of a projector rig.

export interface SpanTile {
  rect: SrcRect;                                                 // crop of the source picture
  soft: Pick<SoftEdge, 'left' | 'right' | 'top' | 'bottom'>;     // feather widths, fraction of THIS tile
  col: number;
  row: number;
}

const MAX_OVERLAP = 0.5; // beyond half a tile the neighbours' feathers cross and the ramp inverts

export const clampOverlap = (v: number): number => Math.max(0, Math.min(MAX_OVERLAP, v || 0));
export const clampCount = (v: number): number => Math.max(1, Math.min(16, Math.round(v || 1)));

// Tile width along one axis for `n` tiles sharing `ov` of ONE tile's width with each neighbour:
//
//   n·w − (n−1)·ov·w = 1   →   w = 1 / (n − (n−1)·ov)
//
// so the tiles cover exactly [0,1] with (n−1) overlaps of ov·w. n=1 ⇒ w=1 (no overlap, no feather).
export function tileSize(n: number, ov: number): number {
  const count = clampCount(n);
  const o = clampOverlap(ov);
  return 1 / (count - (count - 1) * o);
}

// Start of tile i: each step advances by the tile width MINUS the shared band.
export function tileStart(i: number, n: number, ov: number): number {
  return i * tileSize(n, ov) * (1 - clampOverlap(ov));
}

// Every tile of a span, row-major — the single source of truth for both the wizard and Regenerate.
//
// The feather widths come out in SoftEdge's own units ("fraction of this output's width", see
// shared/protocol SoftEdge), which is exactly `ov` — the shared band IS ov·w wide and the tile IS w
// wide. No conversion, and that is not a coincidence: it is why the overlap can be one number in the
// UI. A tile only feathers an edge it actually shares, so the outer border of the whole span stays
// hard (feathering it would fade the picture into black at the ends of the wall).
export function spanTiles(span: Pick<OutputSpan, 'cols' | 'rows' | 'overlapX' | 'overlapY'>): SpanTile[] {
  const cols = clampCount(span.cols);
  const rows = clampCount(span.rows);
  const ovX = clampOverlap(span.overlapX);
  const ovY = clampOverlap(span.overlapY);
  const w = tileSize(cols, ovX);
  const h = tileSize(rows, ovY);

  const tiles: SpanTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.push({
        col, row,
        rect: { x: tileStart(col, cols, ovX), y: tileStart(row, rows, ovY), w, h },
        soft: {
          left: col > 0 ? ovX : 0,
          right: col < cols - 1 ? ovX : 0,
          top: row > 0 ? ovY : 0,
          bottom: row < rows - 1 ? ovY : 0,
        },
      });
    }
  }
  return tiles;
}

// How many tiles a span describes (before its members exist).
export const spanTileCount = (span: Pick<OutputSpan, 'cols' | 'rows'>): number =>
  clampCount(span.cols) * clampCount(span.rows);

// Default member name — "WALL 2·1" reads as "second column, first row of WALL" and sorts sanely.
export const tileName = (sourceName: string, t: SpanTile, cols: number, rows: number): string =>
  rows > 1 && cols > 1 ? `${sourceName} ${t.col + 1}·${t.row + 1}`
    : `${sourceName} ${(rows > 1 ? t.row : t.col) + 1}`;

// Clamp a hand-dragged rect back into the source picture, keeping a sliver of width/height so a
// slice can never collapse to zero (a zero-area crop makes a zero-sized canvas, which throws).
const MIN_SIDE = 0.01;
export function clampRect(r: SrcRect): SrcRect {
  const w = Math.max(MIN_SIDE, Math.min(1, r.w));
  const h = Math.max(MIN_SIDE, Math.min(1, r.h));
  return {
    x: Math.max(0, Math.min(1 - w, r.x)),
    y: Math.max(0, Math.min(1 - h, r.y)),
    w, h,
  };
}
