// THE NAMED SCREENS a loaded 3D model carries (`screen…` objects in its file), and which one the
// operator last clicked in the 3D view — runtime knowledge about a file, not project state: nothing here
// is saved, and a binding whose name is absent from the list is how the Model card says "renamed or
// deleted in Blender".
//
// Split out of components/Simulator3D/modelScreens.ts (E5/W5h), which is the 3D view's and imports
// three.js: the Model card (contexts/panels/scene3d.tsx) can open in a panel window, which may carry
// neither. The 3D view PUBLISHES here (ModelObject, once the GLB has loaded) — in the editor only. A
// panel window MIRRORS the editor's copy (live/sceneRemote.ts → the 'scene3d.screens' stream), and its
// clicks on a screen row are sent back to the editor's 3D view (setFocusSink).

import { useSyncExternalStore } from 'react';

export type ScreenFocus = { modelId: string; name: string } | null;
const names = new Map<string, string[]>();
let focus: ScreenFocus = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
/** Fires on any change of a model's screen list or of the focus. */
export const subscribeScreens = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const NONE: string[] = [];

export function publishModelScreens(modelId: string, list: string[] | null): void {
  const prev = names.get(modelId);
  if (!list) { if (prev) { names.delete(modelId); emit(); } return; }
  if (prev && prev.length === list.length && prev.every((n, i) => n === list[i])) return;
  names.set(modelId, list);
  emit();
}

function setFocusHere(modelId: string, name: string | null): void {
  const next = name ? { modelId, name } : null;
  if (focus?.modelId === next?.modelId && focus?.name === next?.name) return;
  focus = next;
  emit();
}
// Where a focus goes: here, in the editor (the 3D view reads it); to the editor, in a panel window.
let sink: (modelId: string, name: string | null) => void = setFocusHere;
export function setFocusSink(fn: (modelId: string, name: string | null) => void): void { sink = fn; }
export function focusScreen(modelId: string, name: string | null): void { sink(modelId, name); }

/** Everything, as plain data — what the editor sends a panel window. */
export function screensSnapshot(): { names: Record<string, string[]>; focus: ScreenFocus } {
  return { names: Object.fromEntries(names), focus };
}
/** A panel window: take the editor's copy as this window's. */
export function mirrorScreens(s: { names: Record<string, string[]>; focus: ScreenFocus }): void {
  names.clear();
  for (const [k, v] of Object.entries(s.names)) names.set(k, v);
  focus = s.focus;
  emit();
}

/** Screen names found in a model's loaded file — empty until it loads (or with none). */
export const useModelScreens = (modelId: string | null | undefined): string[] =>
  useSyncExternalStore(subscribeScreens, () => (modelId && names.get(modelId)) || NONE);

export const useFocusedScreen = (): ScreenFocus => useSyncExternalStore(subscribeScreens, () => focus);
