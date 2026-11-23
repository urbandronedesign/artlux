// THE EDITOR'S SHELL, AS A PANEL ASKS FOR IT (E5/W5i) — the camera seam's pattern. "Edit this state's
// timeline" binds the scene and pulls up the EDITOR's timeline drawer under the graph. Drawn in a panel
// window, the graph must not reveal a drawer in its own shell (it has none): it asks the editor, whose
// drawer opens on the editor's screen while the graph stays in front of the operator.
//
// The editor installs contexts/nav's revealBottom (live/editorAccess.ts); a panel window installs a call
// to the editor ('shell.revealBottom', live/oscRemote.ts). This module imports nothing that runs.
let reveal: () => void = () => {};
export function setRevealBottom(fn: () => void): void { reveal = fn; }
/** Open the editor's timeline drawer (moving to a context that has one if the current does not). */
export function revealEditorBottom(): void { reveal(); }

// THE EDITOR'S WORKBENCH, by context (E5 — the detached timeline): the timeline's "Edit logic" goes to the
// Show Machine context. In a panel window there is no workbench to switch — the EDITOR's goes there, on
// the editor's screen. The editor installs contexts/nav's goToContext; a window, a call ('shell.goToContext').
let showContext: (id: string) => void = () => {};
export function setShowContext(fn: (id: string) => void): void { showContext = fn; }
/** Switch the EDITOR's workbench to a context (contexts/nav goToContext there). */
export function showEditorContext(id: string): void { showContext(id); }
