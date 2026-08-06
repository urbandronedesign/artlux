// Which slice of an asset grid is worth mounting, and how tall the spacers above and below it are.
//
// Pulled out of MediaPanel as a pure function because this arithmetic is the part that can be WRONG in
// ways nobody sees until a library is large: an off-by-one in `perRow` misplaces every spacer, and a
// window that never reaches the last row makes the final assets unreachable — a bug that looks like
// "the import didn't work". The DOM wiring around it is three lines; this is the part worth asserting.
//
// Why windowing at all: every chip that mounts schedules a thumbnail decode on the same hardware the
// show is using, so a 300-asset library queued 300 jobs the instant the tab opened, for tiles nobody
// had scrolled to.

export interface GridMetrics {
  /** How many items are in the (already filtered) list. */
  count: number;
  /** Measured width of the scroll container, px. */
  width: number;
  /** Measured height of the scroll container, px. */
  height: number;
  /** Current scrollTop, px. */
  scrollTop: number;
  /** Tile width the view asks for (`auto-fill` minimum), px. List view ignores it. */
  tileW: number;
  /** Row height, px. */
  rowH: number;
  /** Grid gap, px. */
  gap: number;
  /** Horizontal padding of the scroll container, px (p-2 → 8 each side). */
  padX: number;
  /** One item per row (list view). */
  single?: boolean;
}

export interface GridWindow {
  from: number;    // first item index to mount (inclusive)
  to: number;      // last item index to mount (exclusive)
  top: number;     // spacer height above, px
  bottom: number;  // spacer height below, px
  perRow: number;  // items per row, as the grid will actually lay them out
}

// Rows kept mounted beyond the viewport, each side, so a scroll reveals filled tiles rather than
// blanks. Two is enough at these row heights and costs a handful of decodes.
const OVERSCAN = 2;

export function gridWindow(m: GridMetrics): GridWindow {
  // `auto-fill, minmax(tileW, 1fr)` fits floor((avail + gap) / (tileW + gap)) columns — the trailing
  // column needs no gap after it. At least one, or a container narrower than a tile divides by zero.
  const avail = Math.max(0, m.width - m.padX);
  const perRow = m.single ? 1 : Math.max(1, Math.floor((avail + m.gap) / (m.tileW + m.gap)));
  const rows = Math.ceil(m.count / perRow);
  const step = m.rowH + m.gap;
  // ⚠ CLAMPED TO THE LAST ROW. `scrollTop` can legitimately exceed the content: type into the filter
  // while scrolled down and the list shrinks under a scroll position the browser has not corrected
  // yet. Unclamped, `first` runs past `rows` and the top spacer becomes enormous — measured in the
  // test at 99843px against 1380px of real content, which yanks the scrollbar to a nonsense size for
  // a frame. Clamping keeps top + mounted + bottom equal to the content height at every scrollTop.
  const first = Math.min(
    Math.max(0, Math.floor(m.scrollTop / step) - OVERSCAN),
    Math.max(0, rows - 1),
  );
  // `height || …` — before the first ResizeObserver callback the container measures 0, and a zero
  // viewport would mount only the overscan and look like an empty library on first paint.
  const visibleRows = Math.ceil((m.height || 400) / step) + OVERSCAN * 2;
  const last = Math.min(rows, first + visibleRows);
  return {
    from: Math.min(first * perRow, m.count),
    to: Math.min(last * perRow, m.count),
    top: first * step,
    // Never negative: `last` is clamped to `rows`, but a stale scrollTop after a filter shrinks the
    // list would otherwise push this below zero and collapse the scrollbar.
    bottom: Math.max(0, (rows - last) * step),
    perRow,
  };
}
