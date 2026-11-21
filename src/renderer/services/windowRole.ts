// WHICH WINDOW THIS IS, for the few panels that configure THE EDITOR'S OWN WINDOW (E5/W5k). Preferences
// carries settings that live in the editor's memory and shell — its workbench layout, its named
// workspaces, its 3D view's quality — which a panel window cannot change for it (its copies are its own,
// and the layout is never written from a window: services/layoutStore). panel.tsx marks the window;
// everything else is the editor. Pure.
let panel = false;
export function markPanelWindow(): void { panel = true; }
export function isPanelWindow(): boolean { return panel; }
