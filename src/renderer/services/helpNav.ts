// Deep-link bus for the searchable Help Page — a one-liner twin of helpBus.
//
// A tooltip's "?" link calls openHelp(id); the HelpBrowser overlay subscribes and, on an id, opens
// itself, selects that entry and scrolls to it. openHelp() with no id opens the browser at the top for
// free browsing. This is renderer-only (no IPC) and self-owned by HelpBrowser exactly the way
// CommandPalette self-owns Ctrl+K — App needs no new state.
type Cb = (id: string | null) => void;

const listeners = new Set<Cb>();

export const helpNav = {
  /** Fire an open request. `null` = open at the top; an id = open focused on that entry. */
  open(id: string | null) {
    listeners.forEach((l) => l(id));
  },
  subscribe(cb: Cb): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/** Open the Help Page, optionally focused on a registry entry id. */
export const openHelp = (id?: string) => helpNav.open(id ?? null);
