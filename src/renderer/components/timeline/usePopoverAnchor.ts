// Viewport placement for a timeline popover that has been PORTALLED to document.body.
//
// WHY EVERY POPOVER IN HERE IS PORTALLED — this is the trap, and it has now been walked into three
// times in this one directory. The timeline is a lattice of stacking contexts: each track row's gutter
// is `sticky left-0 z-20` (Timeline.tsx), the ruler row is `sticky top-0 z-30`, and the maximised
// timeline is wrapped in a `fixed inset-0 z-50`. `position: sticky`/`fixed` WITH a z-index creates a
// stacking context, so a panel written the obvious way — `absolute … z-50` next to its anchor — is
// sealed inside one. Its z-index stops meaning anything globally: the track-header opacity/blend panel
// collapsed to z-20 and painted UNDER the next track's header (same z, later sibling, same 188px
// gutter column), and AutomationTargetPicker's backdrop lost to the maximised wrapper outright, so the
// menu could not be dismissed and the dismissal click fell through onto the timeline and scrubbed.
//
// None of that throws. The panel is in the DOM, at correct geometry, with correct innerText — only the
// pixels are wrong, which is why it survives every DOM assertion and only a screenshot finds it.
//
// So: portal to document.body, sit on the `popover` tier, and place from the anchor's MEASURED rect.
// The scroller's overflow-auto can no longer clip it either.
import { useLayoutEffect, useState, type RefObject } from 'react';

export interface PopoverPos { left: number; top: number; }

interface Opts {
  /** Panel width in px — must match the panel's own w-* class. */
  width: number;
  /** Used for the flip decision before the panel has been measured. */
  estHeight?: number;
  /** Measured once mounted, so the flip uses the real height on every reposition after the first. */
  boxRef?: RefObject<HTMLElement | null>;
  /** Keep this far from every viewport edge. */
  margin?: number;
  /** Escape closes. Omit to opt out. */
  onDismiss?: () => void;
}

/**
 * Returns fixed-position coords for `open` popovers, or null before the first measurement — render
 * the panel `visibility: hidden` until then, or it flashes at 0,0 in the window corner.
 *
 * Placement prefers BELOW the anchor and flips above when there isn't room, which is the common case
 * here: the timeline is a bottom drawer, so its controls sit near the bottom of the window.
 */
export function usePopoverAnchor(open: boolean, anchorRef: RefObject<HTMLElement | null>, opts: Opts): PopoverPos | null {
  const { width, estHeight = 120, boxRef, margin = 8, onDismiss } = opts;
  const [pos, setPos] = useState<PopoverPos | null>(null);

  // Reset on close so the next open measures fresh rather than flashing at the old spot — the anchor
  // may well have moved (a track reorder, a scroll, a context switch) while we were shut.
  useLayoutEffect(() => { if (!open) setPos(null); }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const h = boxRef?.current?.offsetHeight || estHeight;
      const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin));
      const below = r.bottom + 4;
      const top = below + h + margin <= window.innerHeight ? below : Math.max(margin, r.top - h - 4);
      // Only write when it actually moved: this runs on every scroll event of every scroller in the
      // window, and the timeline repaints per-frame during playback.
      setPos(p => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    // CAPTURE phase: the anchor rides the timeline's own inner scroller, and a scroll event on a
    // non-window element does not bubble to window. Without `true` the panel detaches from its button.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss?.(); };
    if (onDismiss) window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      if (onDismiss) window.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef, boxRef, width, estHeight, margin, onDismiss]);

  return pos;
}
