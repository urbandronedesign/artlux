import { useCallback, useRef, useState } from 'react';

// Roving tabindex for a list of selectable rows. Fixes both failure modes the audit found: rows that
// were mouse-only <div>s (zero Tab stops → unreachable) and rows that each carried tabIndex={0}
// (hundreds of Tab stops on a big rig → "Tab hell"). With this, the list is ONE Tab stop and Up/Down
// (plus Home/End) move a roving focus between rows.
//
// Usage:
//   const roving = useRovingTabindex(rows.length);
//   <div ref={roving.containerRef} onKeyDown={roving.onKeyDown}>
//     {rows.map((r, i) => <div role="button" {...roving.getItemProps(i)} onClick={...}>…</div>)}
//
// getItemProps sets data-roving (so the hook can find the row to focus), the 0/-1 tabIndex, and an
// onFocus that keeps the active index in sync when focus arrives by click or Tab.
export function useRovingTabindex<T extends HTMLElement = HTMLDivElement>(count: number) {
  const containerRef = useRef<T>(null);
  const [active, setActive] = useState(0);

  const focusIndex = useCallback((i: number) => {
    const items = containerRef.current?.querySelectorAll<HTMLElement>('[data-roving]');
    if (!items || items.length === 0) return;
    const clamped = Math.max(0, Math.min(items.length - 1, i));
    setActive(clamped);
    items[clamped]?.focus();
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle navigation when a row itself is focused (not an inner action button/input).
    if ((e.target as HTMLElement)?.getAttribute?.('data-roving') == null) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusIndex(active + 1); break;
      case 'ArrowUp': e.preventDefault(); focusIndex(active - 1); break;
      case 'Home': e.preventDefault(); focusIndex(0); break;
      case 'End': e.preventDefault(); focusIndex(count - 1); break;
    }
  }, [active, count, focusIndex]);

  const getItemProps = useCallback((index: number) => ({
    'data-roving': true,
    tabIndex: index === active ? 0 : -1,
    onFocus: () => setActive(index),
  }), [active]);

  return { containerRef, onKeyDown, getItemProps };
}
