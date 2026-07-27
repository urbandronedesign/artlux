import React from 'react';
import * as slots from '../../services/viewportSlots';

// The persistent viewports, drawn over whatever slot currently claims them. Plan: §4 of
// plans/dockable-workspace.md.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// A dock tree may put a panel anywhere, but `Stage`, `Simulator3D` and `TimelinePanel` are ELEMENTS App
// created, and a React element lives at exactly one position. So the tree renders empty `<ViewportSlot>`s
// and the real elements live here, at fixed positions in the React tree, absolutely positioned over the
// winning slot's rect. Nothing about them remounts, ever — the arrangement changes, their coordinates
// change, and that is all.
//
// ── WHY IT WRITES STYLES INSTEAD OF SETTING STATE ───────────────────────────────────────────────
// Following a rect through a splitter drag is a per-frame job. Doing it in React state would re-render
// the shell — and therefore the timeline, the 3D scene and every panel — sixty times a second, which is
// precisely the class of cost the engine-decoupling programme just finished removing (WP-0.5 took 177
// ms/s out of the idle editor for exactly this reason). So the follow loop writes `transform`/`width`/
// `height` directly and React is not involved.
//
// ── WHY NOT PORTALS ─────────────────────────────────────────────────────────────────────────────
// `createPortal` into the winning slot would be less code and is the obvious idea. It physically MOVES
// the DOM node on every layout change: a canvas that is re-parented loses its contents and a WebGL
// context can be lost outright, and moving `TimelinePanel` would re-run the effects whose single
// registration the whole design depends on. Position, don't reparent.
//
// ── THE LOOP IS ARMED, NOT ALWAYS-ON ────────────────────────────────────────────────────────────
// An unconditional rAF would be a second frame loop in the renderer. Instead it wakes on the things that
// actually move a rect — a structural change, a ResizeObserver hit, a pointer drag, a CSS transition —
// and stops once the rects have been still for a moment. Idle cost is zero, which is the number the
// editor now sits at and must keep.

/**
 * Read once at module load, and never re-evaluated — the same discipline as `UI_PROFILING_ENABLED`.
 * Flipping this at runtime would change the element type at the Stage/3D/timeline positions and REMOUNT
 * them: a lost WebGL context and a doubled keyboard hook, from a debug toggle. Set it and reload.
 */
export const PERSISTENT_LAYER_ENABLED: boolean = (() => {
  try {
    if (new URLSearchParams(window.location.search).get('slots') === '1') return true;
    return localStorage.getItem('artlux.persistentLayer') === '1';
  } catch {
    return false;
  }
})();

/** How long the follow loop keeps running after the last rect change, in ms. */
const SETTLE_MS = 400;

interface SlotProps {
  id: string;
  /** Ties break high-first — see ViewportSlot.priority (the maximized timeline is the reason). */
  priority?: number;
  /** False parks the element rather than moving it here. */
  visible?: boolean;
  className?: string;
}

/**
 * An empty box that says "the viewport with this id belongs here". Renders nothing itself; the layer
 * draws over it. Cheap enough that a tree can mount one per pane without thinking about it.
 */
export const ViewportSlot: React.FC<SlotProps> = ({ id, priority = 0, visible = true, className }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const slotRef = React.useRef<slots.ViewportSlot | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const slot: slots.ViewportSlot = { id, el, priority, visible: true };
    slotRef.current = slot;
    return slots.register(slot);
    // `visible` is applied by the effect below so that toggling it does not unregister and re-register
    // the slot — which would make the layer briefly see no winner and park a live viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, priority]);
  React.useEffect(() => {
    if (slotRef.current) slots.setVisible(slotRef.current, visible);
  }, [visible]);
  return <div ref={ref} data-slot-id={id} className={className ?? 'absolute inset-0'} aria-hidden />;
};

interface LayerProps {
  /** id → element, owned and mounted by App. */
  viewports: Record<string, React.ReactNode>;
}

export const PersistentLayer: React.FC<LayerProps> = ({ viewports }) => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const hosts = React.useRef(new Map<string, HTMLDivElement>());
  // Ids come from App, not from the slot registry: an element with no slot right now must still be
  // MOUNTED (parked off-screen), or the 3D scene would be torn down every time you leave its context.
  const ids = React.useMemo(() => Object.keys(viewports).sort(), [viewports]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let raf = 0;
    let stopAt = 0;
    // Last written box per id, so a frame that changes nothing touches no style.
    const last = new Map<string, string>();

    const place = (): boolean => {
      const rootBox = root.getBoundingClientRect();
      let moved = false;
      for (const id of ids) {
        const host = hosts.current.get(id);
        if (!host) continue;
        const slot = slots.winnerFor(id);
        if (!slot) {
          // PARKED, NOT UNMOUNTED, and never at 0x0: r3f caches its raycaster against a zero-sized
          // canvas and then never picks anything again. Keep a real size, just out of sight.
          const key = 'parked';
          if (last.get(id) !== key) {
            host.style.visibility = 'hidden';
            host.style.pointerEvents = 'none';
            host.style.transform = 'translate(-10000px, 0px)';
            last.set(id, key);
            moved = true;
          }
          continue;
        }
        const b = slot.el.getBoundingClientRect();
        const key = `${Math.round(b.left - rootBox.left)},${Math.round(b.top - rootBox.top)},${Math.round(b.width)},${Math.round(b.height)}`;
        if (last.get(id) === key) continue;
        host.style.visibility = 'visible';
        host.style.pointerEvents = 'auto';
        host.style.transform = `translate(${Math.round(b.left - rootBox.left)}px, ${Math.round(b.top - rootBox.top)}px)`;
        host.style.width = `${Math.round(b.width)}px`;
        host.style.height = `${Math.round(b.height)}px`;
        last.set(id, key);
        moved = true;
      }
      return moved;
    };

    const tick = () => {
      const moved = place();
      // Keep going while things are still settling; a transition or a drag re-arms as it goes.
      if (moved) stopAt = Math.max(stopAt, performance.now() + SETTLE_MS);
      if (performance.now() < stopAt) raf = requestAnimationFrame(tick);
      else raf = 0;
    };
    const arm = (ms = SETTLE_MS) => {
      stopAt = Math.max(stopAt, performance.now() + ms);
      if (!raf) raf = requestAnimationFrame(tick);
    };

    // Structural changes: a slot mounted, unmounted, or changed visibility.
    const offSlots = slots.subscribe(() => arm());
    // Size changes: columns resizing, the window resizing, the drawer opening.
    const ro = new ResizeObserver(() => arm());
    ro.observe(root);
    // A drag moves rects without resizing this root, so watch the pointer for its duration. Capture
    // phase, because a splitter handler may stop propagation.
    const onDown = () => arm(1200);
    const onUp = () => arm();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('resize', onUp);
    // The side columns animate with `transition-all`, so their final rect arrives well after the click.
    window.addEventListener('transitionend', onUp, true);

    place();
    arm();
    return () => {
      offSlots();
      ro.disconnect();
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('resize', onUp);
      window.removeEventListener('transitionend', onUp, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids]);

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none z-10" aria-hidden={false}>
      {ids.map((id) => (
        <div
          key={id}
          ref={(el) => { if (el) hosts.current.set(id, el); else hosts.current.delete(id); }}
          data-viewport-id={id}
          className="absolute top-0 left-0 overflow-hidden"
          // Parked until the first placement, rather than flashing at 0,0 for one frame.
          style={{ visibility: 'hidden', transform: 'translate(-10000px, 0px)', width: 320, height: 240 }}
        >
          {viewports[id]}
        </div>
      ))}
    </div>
  );
};
