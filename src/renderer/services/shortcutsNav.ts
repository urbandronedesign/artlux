// Open-request bus for the full-page Keyboard Shortcuts editor — a one-liner twin of helpNav.
//
// Anything that wants to open the editor (a Preferences button, a menu item) calls openShortcuts();
// the ShortcutsEditor overlay subscribes and self-owns its open state, exactly the way HelpBrowser
// self-owns its Shift+F1 overlay. App needs no new state, and there is no IPC.
type Cb = () => void;

const listeners = new Set<Cb>();

export const shortcutsNav = {
  open(): void { listeners.forEach((l) => l()); },
  subscribe(cb: Cb): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
};

/** Open the Keyboard Shortcuts editor. */
export const openShortcuts = (): void => shortcutsNav.open();
