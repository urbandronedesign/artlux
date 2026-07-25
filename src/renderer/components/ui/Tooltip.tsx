import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { helpEntry } from '../../help/registry';
import { openHelp } from '../../services/helpNav';

// A hoverable/focusable floating tooltip — the one thing native `title=` cannot do, because a native
// tooltip cannot hold a clickable link. It shows the control's one-liner and, when the control carries
// a registry id, a "? Learn more" link that deep-links into the searchable Help Page (openHelp).
//
// Why hoverable matters: the user has to be able to travel the pointer OFF the control and INTO the
// tooltip to click that link. So closing is delayed (~150ms) and cancelled if the pointer enters the
// panel — the delay itself bridges the small gap between anchor and panel.
//
// The child must be a HOST element (or a forwardRef component) — we clone it to attach a ref and our
// hover/focus handlers, composed over any the child already has (e.g. helpProps' onMouseEnter). If
// there is nothing to show (no id/content), the child is returned untouched: wrapping is always safe,
// and the native `title` still shows, so adoption is incremental.

interface TooltipProps {
  /** Registry id → renders `short` + the "? Learn more" deep-link. */
  id?: string;
  /** Ad-hoc one-liner when there is no registry id. */
  content?: string;
  children: React.ReactElement;
}

type Placement = 'top' | 'bottom';
interface Pos { top: number; left: number; placement: Placement; }

const OPEN_DELAY = 350;   // hover intent — don't flash on a pass-through
const CLOSE_DELAY = 150;  // long enough to travel into the panel and click the link
const PANEL_W = 260;
const GAP = 8;            // anchor↔panel offset; the close delay bridges it
const MARGIN = 8;         // keep the panel this far from the viewport edge

// Compose a handler onto whatever the child already declares for the same event.
function mergeHandler<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void) {
  return (e: E) => { theirs?.(e); ours(e); };
}

export const Tooltip: React.FC<TooltipProps> = ({ id, content, children }) => {
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

  const entry = id ? helpEntry(id) : undefined;
  const short = content ?? entry?.short;
  const uid = useRef(`tt-${Math.random().toString(36).slice(2)}`).current;

  const clearTimers = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = undefined;
  };

  const computePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // Prefer below; flip above when the panel would overflow the bottom. Height is unknown before
    // paint, so estimate generously (a two-line hint + link ≈ 120px) for the flip decision.
    const estH = 120;
    const placement: Placement = r.bottom + GAP + estH > vh && r.top - GAP - estH > 0 ? 'top' : 'bottom';
    let left = r.left + r.width / 2 - PANEL_W / 2;
    left = Math.max(MARGIN, Math.min(left, vw - PANEL_W - MARGIN));
    const top = placement === 'bottom' ? r.bottom + GAP : r.top - GAP;
    setPos({ top, left, placement });
  }, []);

  const scheduleOpen = useCallback(() => {
    if (!short) return;
    clearTimers();
    openTimer.current = window.setTimeout(() => { computePos(); setOpen(true); }, OPEN_DELAY);
  }, [short, computePos]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
  }, []);

  // Keyboard focus opens immediately (no hover-intent delay) so the "Learn more" link is available to
  // Tab into right away — the panel is portaled to <body>, so a delayed open would not exist yet when
  // the user presses Tab. See onKeyDown on the anchor below.
  const openNow = useCallback(() => {
    if (!short) return;
    clearTimers();
    computePos();
    setOpen(true);
  }, [short, computePos]);

  // Reposition on scroll/resize while open (the anchor moves with the layout), and close on ESC.
  useLayoutEffect(() => {
    if (!open) return;
    computePos();
    const onScroll = () => computePos();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, computePos]);

  useEffect(() => clearTimers, []);

  // Nothing to show → render the child untouched (native title still works).
  if (!short) return children;

  const childProps = children.props as Record<string, any>;
  const cloned = React.cloneElement(children, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      // Preserve the child's own ref, whether callback or object. In React 19 a ref rides on props;
      // older elements expose it as `element.ref`. Handle both so cloning never drops the child's ref.
      const r = (children as any).ref ?? childProps.ref;
      if (typeof r === 'function') r(node);
      else if (r && typeof r === 'object') (r as React.MutableRefObject<HTMLElement | null>).current = node;
    },
    'aria-describedby': open ? uid : childProps['aria-describedby'],
    onMouseEnter: mergeHandler(childProps.onMouseEnter, scheduleOpen),
    onMouseLeave: mergeHandler(childProps.onMouseLeave, scheduleClose),
    onFocus: mergeHandler(childProps.onFocus, openNow),
    onBlur: mergeHandler(childProps.onBlur, scheduleClose),
    // Tab from the focused control moves into the panel's "Learn more" link (which is portaled to
    // <body>, so it is otherwise unreachable). clearTimers first so the pending close doesn't fire.
    onKeyDown: mergeHandler(childProps.onKeyDown, (e: React.KeyboardEvent) => {
      if (e.key === 'Tab' && !e.shiftKey && open && entry) {
        const btn = panelRef.current?.querySelector('button');
        if (btn) { e.preventDefault(); clearTimers(); (btn as HTMLElement).focus(); }
      }
    }),
  } as any);

  const onLearnMore = () => {
    setOpen(false);
    openHelp(id);
  };

  return (
    <>
      {cloned}
      {open && pos && createPortal(
        <div
          ref={panelRef}
          id={uid}
          role="tooltip"
          // Hovering OR focusing the panel keeps it open (the bridge that lets pointer and keyboard
          // users reach the link); leaving it (blur to elsewhere) schedules the close.
          onMouseEnter={clearTimers}
          onMouseLeave={scheduleClose}
          onFocus={clearTimers}
          onBlur={scheduleClose}
          style={{
            position: 'fixed',
            top: pos.placement === 'bottom' ? pos.top : undefined,
            bottom: pos.placement === 'top' ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            width: PANEL_W,
          }}
          className="z-modal bg-surface-2 border border-line-2 rounded-md shadow-e3 text-fg-1 p-2.5 animate-overlay-in"
        >
          {entry?.title && <div className="text-mini font-semibold text-fg-1 mb-0.5">{entry.title}</div>}
          <p className="text-mini leading-relaxed text-fg-2">{short}</p>
          {entry && (
            <button
              type="button"
              onClick={onLearnMore}
              className="mt-2 inline-flex items-center gap-1 text-micro font-medium text-accent"
            >
              <HelpCircle size={11} /> Learn more
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};
