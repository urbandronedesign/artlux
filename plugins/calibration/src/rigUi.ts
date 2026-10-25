// The Calibrator's rig-level UI state (suite plan Phase 3, step 5) — which projector is in FOCUS, and
// which are soloed or muted. Authoring: only ArtLux Calibrator's panels use it.
//
// Focus is the one projector everything is about (the design's "one projector in focus": it is the
// only thing drawn in the accent). Solo and mute are a mixer's two verbs for the wall — mute blacks one
// projector, solo blacks every other — and they reach the real projectors through the host
// (projectors.setMuted), so what the operator toggles is what the room sees. Transient by design: a
// solo is a question asked of the wall, never a property of the show, so nothing here is saved.

import { getHost } from './calibHost';
import * as session from './calibSession';

interface RigUiState { focus: string | null; solo: string | null; muted: string[] }
// `focus` mirrors calibSession's (the host's 3D view reads it there); solo/mute live only here.
let state: RigUiState = { focus: session.getFocus(), solo: null, muted: [] };
const subs = new Set<() => void>();

function emit(patch: Partial<RigUiState>): void {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
  pushMute();
}

/** The outputs that must show black right now. */
function effectiveMuted(): string[] {
  const all = (getHost()?.projectorOutputs.list() as { surfaceId: string }[] | undefined) ?? [];
  if (state.solo) return all.map((o) => o.surfaceId).filter((id) => id !== state.solo);
  return state.muted;
}
function pushMute(): void { getHost()?.projectors.setMuted?.(effectiveMuted()); }

export function getState(): RigUiState { return state; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

export function setFocus(id: string | null): void { if (state.focus !== id) { session.setFocus(id); emit({ focus: id }); } }
export function toggleMute(id: string): void {
  emit({ muted: state.muted.includes(id) ? state.muted.filter((x) => x !== id) : [...state.muted, id] });
}
export function toggleSolo(id: string): void { emit({ solo: state.solo === id ? null : id }); }
/** Everything back on — called when the Calibrator leaves the rig (a hand-off must not carry a mute). */
export function clearSoloMute(): void { if (state.solo || state.muted.length) emit({ solo: null, muted: [] }); }
export const canMute = (): boolean => !!getHost()?.projectors.setMuted;
