import { SHORTCUT_DEFS, shortcutDef } from './registry';
import { matchChord } from './chord';
import type { Chord, ShortcutDef, ShortcutScope } from './types';

// The live keymap: default bindings from the registry, overlaid with the user's saved overrides. Every
// migrated keydown handler consults `keymap.matches(e, id)` instead of hardcoding `e.key`; the editor
// reads/writes bindings through here. Module-singleton pub/sub, mirroring layoutStore/helpBus.
//
// Persistence: only the OVERRIDES (the deltas from default) are stored, under Prefs.shortcuts — so
// shipping a new default binding reaches every install that never touched that action. Writes are
// debounced into one shallow Prefs.setPrefs, exactly like layoutStore.

// id → the user's chosen chords. Absent id = "use the default". An explicit [] means "unbound".
let overrides: Record<string, Chord[]> = {};
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void window.artlux?.setPrefs?.({ shortcuts: overrides }); }, 300);
}

function emit(): void { subs.forEach((f) => f()); }

export const keymap = {
  /** Boot: adopt saved overrides (does NOT persist). Safe to call with undefined. */
  hydrate(saved?: Record<string, string[]>): void {
    overrides = saved ? { ...saved } : {};
    emit();
  },

  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },

  /** Current bindings for an action — the override if present, else the registry default. */
  resolve(id: string): Chord[] {
    if (id in overrides) return overrides[id];
    return shortcutDef(id)?.defaultBinding ?? [];
  },

  /** True if the event matches ANY of an action's current bindings. The one call handlers make. */
  matches(e: KeyboardEvent, id: string): boolean {
    const binds = keymap.resolve(id);
    for (let i = 0; i < binds.length; i++) if (matchChord(e, binds[i])) return true;
    return false;
  },

  /** True if the action's bindings differ from its factory default (used to show a Reset affordance). */
  isOverridden(id: string): boolean { return id in overrides; },

  /** Rebind an action. Pass [] to unbind entirely. Persists. */
  setBinding(id: string, chords: Chord[]): void {
    overrides[id] = chords.slice();
    emit();
    persistSoon();
  },

  /** Restore one action to its factory default. Persists. */
  resetBinding(id: string): void {
    if (id in overrides) { delete overrides[id]; emit(); persistSoon(); }
  },

  /** Restore every action to factory defaults. Persists. */
  resetAll(): void {
    if (Object.keys(overrides).length === 0) return;
    overrides = {};
    emit();
    persistSoon();
  },

  /** First OTHER action in the same scope already bound to `chord`, or null. Drives the editor's
      block-duplicates rule: a timeline key may reuse a global key (different scope), but two timeline
      actions may not share one. */
  findConflict(chord: Chord, scope: ShortcutScope, excludeId: string): ShortcutDef | null {
    for (const d of SHORTCUT_DEFS) {
      if (d.scope !== scope || d.id === excludeId) continue;
      if (keymap.resolve(d.id).includes(chord)) return d;
    }
    return null;
  },
};
