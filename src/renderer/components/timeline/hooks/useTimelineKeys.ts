import { useEffect, useRef } from 'react';

// DaVinci-style keyboard shortcuts, scoped to when the timeline panel is hovered or focused, and
// suppressed while typing in an input. Handlers are read from a ref so the listener attaches once.
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
      const k = e.key;
      switch (k) {
        case ' ': e.preventDefault(); h.togglePlay(); break;
        case 'l': case 'L': h.play(); break;
        case 'k': case 'K': h.pause(); break;
        case 'j': case 'J': h.pause(); break; // engine has no reverse; pause for now (TODO: reverse)
        case 'b': case 'B': h.setBladeTool(); break;
        case 'v': case 'V': h.setSelectTool(); break;
        case 'Escape': h.setSelectTool(); break;
        case 's': case 'S': case 'n': case 'N': h.toggleSnap(); break;
        case 'm': case 'M': h.addMarker(); break;
        case 'i': case 'I': h.setIn(); break;
        case 'o': case 'O': h.setOut(); break;
        case 'Delete': case 'Backspace': e.preventDefault(); h.deleteSelected(!e.shiftKey); break;
        case '+': case '=': e.preventDefault(); h.zoom(1.5); break;
        case '-': case '_': e.preventDefault(); h.zoom(1 / 1.5); break;
        case 'Home': e.preventDefault(); h.seekHome(); break;
        case 'End': e.preventDefault(); h.seekEnd(); break;
        default:
          if ((k === 'c' || k === 'C') && !e.ctrlKey && !e.metaKey) h.bladeAtPlayhead();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
