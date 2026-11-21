import React from 'react';
import type { DockTree, DropZone } from '../../services/dockTree';
import { moveTab, addPanel, closePanel, findGroupOf } from '../../services/dockTree';
import { panelRegistry } from '../../host/registries';
import { isPanelWindow } from '../../services/windowRole';

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

/** The group and zone under a point (client px) — the hit-test both a local and a cross-window drag use. */
function hitGroup(x: number, y: number): { groupId: string; zone: DropZone; rect: DOMRect } | null {
  // Hit-test by group box rather than by elementFromPoint: the overlay itself sits under the pointer,
  // and a pointer-events:none element is still not something to rely on for this.
  let best: { el: Element; rect: DOMRect } | null = null;
  for (const el of document.querySelectorAll('[data-dock-group]')) {
    const rect = el.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    // Deepest match wins — groups do not nest today, but a smaller box is the more specific answer.
    if (!best || rect.width * rect.height < best.rect.width * best.rect.height) best = { el, rect };
  }
  if (!best) return null;
  return { groupId: best.el.getAttribute('data-dock-group') ?? '', zone: zoneAt(best.rect, x, y), rect: best.rect };
}

/**
 * A panel ARRIVING from another window, placed at a group + zone. If this tree already shows it (the
 * editor's docked copy of a panel that was also out in a window), it is moved there instead — one copy
 * per tree, the same rule moveTab keeps within a window.
 */
export function placeFromOutside(tree: DockTree, panelId: string, groupId: string, zone: DropZone): DockTree {
  if (findGroupOf(tree, panelId)) return moveTab(tree, panelId, groupId, zone);
  const added = addPanel(tree, panelId, groupId);
  if (added === tree || zone === 'center') return added;
  const moved = moveTab(added, panelId, groupId, zone);
  return moved === added ? added : moved;
}

// ── ACROSS WINDOWS (E5/W5l) ──────────────────────────────────────────────────────────────────────────
// A drag that leaves its window is routed by main (main/panelWindows.ts — it alone knows which window is
// under the cursor). This window may be the TARGET of someone else's drag: main says where the tab is
// (hover) and asks it to take the panel (drop). ONE dock tree per window answers — the most recently
// mounted — so a drop is placed once, never once per renderer.
type TargetHandler = { hover: (x: number, y: number) => void; leave: () => void; drop: (panelId: string, x: number, y: number) => boolean };
let target: TargetHandler | null = null;
let listening = false;
function listenForOtherWindows(): void {
  if (listening || !window.artlux?.onDockDragHover) return;
  listening = true;
  window.artlux.onDockDragHover((h) => { if (!h) target?.leave(); else target?.hover(h.x, h.y); });
  window.artlux.onDockDragDrop((d) => {
    let ok = false;
    try { ok = !!target?.drop(d.panelId, d.x, d.y); } catch (e) { console.warn('[dock] drop from another window failed', e); }
    window.artlux.dockDragDone(d.req, ok);
  });
}

/** May this panel go into another window? Only a detachable one: a panel window can hold nothing else. */
const crossable = (panelId: string): boolean => !!panelRegistry.get(panelId)?.detachable && !!window.artlux?.dockDrag;

export function useDockDrag(tree: DockTree, onTree: (t: DockTree) => void): { api: DragApi; overlay: React.ReactNode } {
  const overlayRef = React.useRef<HTMLDivElement>(null);
  // Live values the window listeners read; nothing here is state, so nothing here re-renders.
  const treeRef = React.useRef(tree); treeRef.current = tree;
  const onTreeRef = React.useRef(onTree); onTreeRef.current = onTree;

  const hide = React.useCallback(() => {
    const o = overlayRef.current;
    if (o) o.style.display = 'none';
  }, []);
  const show = React.useCallback((rect: DOMRect, zone: DropZone) => {
    const box = zoneBox(rect, zone);
    const o = overlayRef.current;
    if (o) {
      o.style.display = 'block';
      o.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
      o.style.width = `${Math.round(box.w)}px`;
      o.style.height = `${Math.round(box.h)}px`;
    }
  }, []);

  // This tree as the target of a tab from another window.
  React.useEffect(() => {
    listenForOtherWindows();
    const me: TargetHandler = {
      hover: (x, y) => { const h = hitGroup(x, y); if (h) show(h.rect, h.zone); else hide(); },
      leave: hide,
      drop: (panelId, x, y) => {
        hide();
        const p = panelRegistry.get(panelId);
        // A panel window holds only detachable panels; the editor anything it has registered.
        if (!p || (isPanelWindow() && !p.detachable)) return false;
        const h = hitGroup(x, y);
        if (!h) return false;
        const next = placeFromOutside(treeRef.current, panelId, h.groupId, h.zone);
        if (next === treeRef.current) return false;
        onTreeRef.current(next);
        return true;
      },
    };
    target = me;
    return () => { if (target === me) target = null; };
  }, [hide, show]);

  const startTabDrag = React.useCallback((e: React.PointerEvent, panelId: string) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const el = e.currentTarget as Element;
    const pointerId = e.pointerId;
    let dragging = false;
    let localTarget: { groupId: string; zone: DropZone } | null = null;
    // Outside this window: main routes it (once per frame at most — the next move supersedes).
    let outside = false;
    let pending = false;
    const outOfWindow = (ev: PointerEvent) => ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;

    const move = (ev: PointerEvent) => {
      if (!dragging) {
        // A threshold, so clicking a tab to select it is not a one-pixel drag that reorders the panel.
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
        dragging = true;
        document.body.style.cursor = 'grabbing';
        // Keep receiving the pointer once it leaves this window — that is what lets the drag go on
        // over another window (main does the rest).
        try { el.setPointerCapture(pointerId); } catch { /* the element went; the drag stays local */ }
      }
      if (outOfWindow(ev) && crossable(panelId)) {
        localTarget = null;
        hide();
        outside = true;
        if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; if (outside) void window.artlux.dockDrag('move', panelId); }); }
        return;
      }
      if (outside) { outside = false; void window.artlux?.dockDrag?.('end', panelId); }
      const h = hitGroup(ev.clientX, ev.clientY);
      if (!h) { localTarget = null; hide(); return; }
      localTarget = { groupId: h.groupId, zone: h.zone };
      show(h.rect, h.zone);
    };
    const done = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      try { if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId); } catch { /* gone */ }
      document.body.style.cursor = '';
      hide();
      if (outside) {
        outside = false;
        // Released over ANOTHER window: ask it to take the panel; remove the tab here only on yes, so a
        // drop nobody takes (the desktop, a window that refuses) leaves everything where it was.
        if (!commit || !dragging) { void window.artlux.dockDrag('end', panelId); return; }
        void window.artlux.dockDrag('drop', panelId).then((r) => {
          if (!r?.ok) return;
          const next = closePanel(treeRef.current, panelId);
          if (next !== treeRef.current) onTreeRef.current(next);
        }).catch(() => {});
        return;
      }
      if (!commit || !dragging || !localTarget) return;
      // moveTab declines a no-op and declines anything that would breach the tree's caps, so a drop
      // that cannot work leaves the arrangement exactly as it was rather than half-applying.
      const next = moveTab(treeRef.current, panelId, localTarget.groupId, localTarget.zone);
      if (next !== treeRef.current) onTreeRef.current(next);
    };
    const up = () => done(true);
    // pointercancel = the system took the gesture (a touchscreen pan takeover); pointerup never comes.
    const cancel = () => done(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  }, [hide, show]);

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
