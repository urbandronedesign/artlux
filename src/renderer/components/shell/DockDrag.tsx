import React from 'react';
import type { DockTree, DropZone } from '../../services/dockTree';
import { moveTab } from '../../services/dockTree';

// Dragging a panel by its tab, and the drop targets that go with it. Plan: §6 of
// plans/dockable-workspace.md.
//
// ── POINTER EVENTS, NEVER HTML5 DRAG-AND-DROP ───────────────────────────────────────────────────
// The `dragstart`/`drop` channel is already spoken for in this app: it carries
// `application/artlux-asset` and `application/artlux-take` between the media library, the lanes and the
// stage. Putting panel drags on the same channel would have every lane and every surface light up as a
// drop target while you rearrange your workbench. It also comes with Chromium's documented footgun —
// a file dropped anywhere the app does not handle NAVIGATES THE WINDOW, which in a venue means the
// editor is simply gone. Pointer events have neither problem and are the same idiom every other drag
// in this codebase already uses.
//
// ── THE OVERLAY IS DRAWN BY HAND, NOT BY REACT ──────────────────────────────────────────────────
// A drop indicator that lived in state would re-render the whole tree - and therefore every panel in
// it - on every pointer move. One element, positioned by direct style writes, same discipline as
// PersistentLayer and the splitters.

/** Fraction of a group's box that counts as an edge rather than its middle. */
const EDGE = 0.25;

export interface DragApi {
  /** Attach to a tab's onPointerDown. Starts only after the pointer actually travels. */
  startTabDrag: (e: React.PointerEvent, panelId: string) => void;
}

function zoneAt(rect: DOMRect, x: number, y: number): DropZone {
  const fx = (x - rect.left) / Math.max(1, rect.width);
  const fy = (y - rect.top) / Math.max(1, rect.height);
  // Nearest edge wins, and only if the pointer is actually IN that band; otherwise it is a tab drop.
  const d = [
    { z: 'left' as const, v: fx },
    { z: 'right' as const, v: 1 - fx },
    { z: 'top' as const, v: fy },
    { z: 'bottom' as const, v: 1 - fy },
  ].sort((a, b) => a.v - b.v)[0];
  return d.v < EDGE ? d.z : 'center';
}

/** The box an indicator should cover for a given zone — half the group for an edge, all of it for a tab. */
function zoneBox(rect: DOMRect, zone: DropZone): { x: number; y: number; w: number; h: number } {
  const half = 0.5;
  switch (zone) {
    case 'left': return { x: rect.left, y: rect.top, w: rect.width * half, h: rect.height };
    case 'right': return { x: rect.left + rect.width * half, y: rect.top, w: rect.width * half, h: rect.height };
    case 'top': return { x: rect.left, y: rect.top, w: rect.width, h: rect.height * half };
    case 'bottom': return { x: rect.left, y: rect.top + rect.height * half, w: rect.width, h: rect.height * half };
    default: return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }
}

export function useDockDrag(tree: DockTree, onTree: (t: DockTree) => void): { api: DragApi; overlay: React.ReactNode } {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  // Live values the window listeners read; nothing here is state, so nothing here re-renders.
  const treeRef = React.useRef(tree); treeRef.current = tree;
  const onTreeRef = React.useRef(onTree); onTreeRef.current = onTree;

  const startTabDrag = React.useCallback((e: React.PointerEvent, panelId: string) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    let target: { groupId: string; zone: DropZone } | null = null;

    const hide = () => {
      const o = overlayRef.current;
      if (o) o.style.display = 'none';
    };
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        // A threshold, so clicking a tab to select it is not a one-pixel drag that reorders the panel.
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
        dragging = true;
        document.body.style.cursor = 'grabbing';
      }
      // Hit-test by group box rather than by elementFromPoint: the overlay itself sits under the
      // pointer, and a pointer-events:none element is still not something to rely on for this.
      let best: { el: Element; rect: DOMRect } | null = null;
      for (const el of document.querySelectorAll('[data-dock-group]')) {
        const rect = el.getBoundingClientRect();
        if (ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom) continue;
        // Deepest match wins — groups do not nest today, but a smaller box is the more specific answer.
        if (!best || rect.width * rect.height < best.rect.width * best.rect.height) best = { el, rect };
      }
      if (!best) { target = null; hide(); return; }
      const groupId = best.el.getAttribute('data-dock-group') ?? '';
      const zone = zoneAt(best.rect, ev.clientX, ev.clientY);
      target = { groupId, zone };
      const box = zoneBox(best.rect, zone);
      const o = overlayRef.current;
      if (o) {
        o.style.display = 'block';
        o.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
        o.style.width = `${Math.round(box.w)}px`;
        o.style.height = `${Math.round(box.h)}px`;
      }
    };
    const done = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.cursor = '';
      hide();
      if (!commit || !dragging || !target) return;
      // moveTab declines a no-op and declines anything that would breach the tree's caps, so a drop
      // that cannot work leaves the arrangement exactly as it was rather than half-applying.
      const next = moveTab(treeRef.current, panelId, target.groupId, target.zone);
      if (next !== treeRef.current) onTreeRef.current(next);
    };
    const up = () => done(true);
    // pointercancel = the system took the gesture (a touchscreen pan takeover); pointerup never comes.
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, []);

  const overlay = (
    <div
      ref={overlayRef}
      aria-hidden
      className="fixed top-0 left-0 z-50 pointer-events-none border-2 border-accent bg-accent/20 rounded-sm"
      style={{ display: 'none' }}
    />
  );
  return { api: { startTabDrag }, overlay };
}
