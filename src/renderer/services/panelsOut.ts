// WHICH PANELS ARE OUT IN A PANEL WINDOW (E5 — the detached timeline), as main reports them to the editor
// (main/panelWindows.ts announceOut). Most detachable panels do not care: their docked copy stays, like
// any second view of the document. The TIMELINE does: the drawer is a fixed place in every context, and
// while the operator has moved the timeline to another screen the drawer shows where it went instead of
// a second copy (App.tsx, VIEWPORT_TIMELINE).
//
// Main is the one that knows: a window's tabs move by drag between windows, close, or go back to the
// editor, and every one of those reaches main as a tree report. Asked for once at load (a reload of the
// editor would otherwise miss every change before it) and then pushed on each change.
import { useSyncExternalStore } from 'react';

let out: readonly string[] = [];
const subs = new Set<() => void>();
let started = false;

function set(ids: string[]): void {
  const next = [...new Set(ids)].sort();
  if (next.length === out.length && next.every((id, i) => id === out[i])) return;
  out = next;
  for (const cb of [...subs]) cb();
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const api = window.artlux;
  if (!api?.onPanelWindowsOut) return;   // a show mode, or a window with no panel windows: nothing is ever out
  api.onPanelWindowsOut(set);
  api.panelWindowsOut?.().then(set).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  start();
  subs.add(cb);
  return () => { subs.delete(cb); };
}

/** Is this panel out in a panel window right now? */
export function usePanelOut(id: string): boolean {
  return useSyncExternalStore(subscribe, () => out.includes(id));
}
