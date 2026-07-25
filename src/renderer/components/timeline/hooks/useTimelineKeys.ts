import { useEffect, useRef } from 'react';
import { keymap } from '../../../shortcuts/keymapStore';
import { eventToChord } from '../../../shortcuts/chord';

// DaVinci-style keyboard shortcuts, scoped to when the timeline panel is hovered or focused, and
// suppressed while typing in an input. Handlers are read from a ref so the listener attaches once.
// Bindings resolve through the keymap (registry defaults + user overrides) — see shortcuts/registry.ts
// (the `timeline.*` ids). preventDefault is applied per-action for the keys that would otherwise scroll
// or delete (Space, +/-, Home/End, Delete/Backspace).
export interface TimelineKeyHandlers {
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  setSelectTool: () => void;
  setBladeTool: () => void;
  bladeAtPlayhead: () => void;
  toggleSnap: () => void;
  addMarker: () => void;
  setIn: () => void;
  setOut: () => void;
  deleteSelected: (ripple: boolean) => void;
  zoom: (factor: number) => void;
  seekHome: () => void;
  seekEnd: () => void;
  toggleMax: () => void;
  toggleLoop: () => void;
}

export function useTimelineKeys(handlers: TimelineKeyHandlers, isActive: () => boolean): void {
  const ref = useRef(handlers); ref.current = handlers;
  const activeRef = useRef(isActive); activeRef.current = isActive;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (!activeRef.current()) return;
      const h = ref.current;
      const m = (id: string) => keymap.matches(e, id);
      // Escape still forces the select tool regardless of any rebinding — it is the universal "cancel".
      if (m('timeline.togglePlay')) { e.preventDefault(); h.togglePlay(); }
      else if (m('timeline.play')) h.play();
      else if (m('timeline.toggleLoop')) h.toggleLoop();
      else if (m('timeline.toggleMax')) h.toggleMax();
      else if (m('timeline.pause')) h.pause(); // engine has no reverse; pause for now (TODO: reverse)
      else if (m('timeline.bladeTool')) h.setBladeTool();
      else if (m('timeline.selectTool') || e.key === 'Escape') h.setSelectTool();
      else if (m('timeline.toggleSnap')) h.toggleSnap();
      else if (m('timeline.addMarker')) h.addMarker();
      else if (m('timeline.setIn')) h.setIn();
      else if (m('timeline.setOut')) h.setOut();
      // Delete is special: Shift is an ORTHOGONAL modifier (ripple vs lift), not part of the binding, so
      // match the binding with any leading Shift stripped and read e.shiftKey for the ripple flag.
      else if (keymap.resolve('timeline.deleteSelected').includes(eventToChord(e).replace(/^Shift\+/, ''))) {
        e.preventDefault(); h.deleteSelected(!e.shiftKey);
      }
      else if (m('timeline.zoomIn')) { e.preventDefault(); h.zoom(1.5); }
      else if (m('timeline.zoomOut')) { e.preventDefault(); h.zoom(1 / 1.5); }
      else if (m('timeline.seekHome')) { e.preventDefault(); h.seekHome(); }
      else if (m('timeline.seekEnd')) { e.preventDefault(); h.seekEnd(); }
      else if (m('timeline.bladeAtPlayhead')) h.bladeAtPlayhead();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
