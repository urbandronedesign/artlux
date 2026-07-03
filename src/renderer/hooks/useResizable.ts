import React, { useRef } from 'react';

interface ResizeOpts {
  axis: 'x' | 'y';
  min: number;
  /** Upper clamp; function form for a dynamic bound (the dock uses `window.innerHeight - 120`). */
  max: number | (() => number);
  /** Panel grows as the pointer moves toward it (dock top edge, help left edge). */
  invert?: boolean;
  /** 'delta' (default): add pointer movement to `value` (px sizes). 'ratio': value = pointer position
      as a fraction of `containerRef`'s box (the split divider). */
  mode?: 'delta' | 'ratio';
  /** Starting size for mode 'delta' (the current px value). */
  value?: number;
  /** Container box for mode 'ratio'. */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Live, every pointer move. */
  onChange: (next: number) => void;
  /** On pointer release (optional — layoutStore already debounce-persists). */
  onCommit?: (next: number) => void;
}

// One drag-resizer replacing the three copy-pasted pointer handlers (split divider, dock top edge,
// help left edge). Returns an onPointerDown to spread on the handle element. Reproduces the existing
// idiom (pointerdown → window pointermove/pointerup → clamp → callback) and adds a body cursor/select
// lock during the drag so text isn't selected and the cursor stays consistent off the thin handle.
export function useResizable(opts: ResizeOpts): (e: React.PointerEvent) => void {
  const ref = useRef(opts);
  ref.current = opts;

  return (e: React.PointerEvent) => {
    const o = ref.current;
    e.preventDefault();
    const clampMax = () => (typeof o.max === 'function' ? o.max() : o.max);
    const startPos = o.axis === 'x' ? e.clientX : e.clientY;
    const base = o.value ?? 0;
    let last = base;

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = o.axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const move = (ev: PointerEvent) => {
      let next: number;
      if (o.mode === 'ratio' && o.containerRef?.current) {
        const r = o.containerRef.current.getBoundingClientRect();
        next = o.axis === 'x' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      } else {
        const cur = o.axis === 'x' ? ev.clientX : ev.clientY;
        next = base + (cur - startPos) * (o.invert ? -1 : 1);
      }
      next = Math.min(clampMax(), Math.max(o.min, next));
      last = next;
      o.onChange(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      o.onCommit?.(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}
