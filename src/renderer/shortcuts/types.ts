// Data model for the configurable keyboard-shortcut system.
//
// A `Chord` is the CANONICAL string form of one key combination, produced by chord.eventToChord and
// compared by chord.matchChord. Canonical form folds Ctrl/Meta together (so Cmd on macOS and Ctrl on
// Windows are the same binding), and carries letter case as an explicit `Shift` — because the timeline
// already distinguishes `l` (play) from `Shift+L` (toggle loop). Examples: "Space", "Ctrl+Z",
// "Ctrl+Shift+Z", "Shift+L", "Delete", "+".
export type Chord = string;

// The scope is the listener that owns a shortcut. Conflict detection is per-scope: a timeline-only key
// (active only when the timeline panel is focused) may legitimately reuse a global key, so the editor
// only blocks a duplicate WITHIN the same scope.
export type ShortcutScope = 'global' | 'timeline' | 'projector' | 'stategraph';

export interface ShortcutDef {
  /** Stable id, never shown to the user, never changed once shipped (it is the prefs key). */
  id: string;
  /** Human label for the editor row. */
  label: string;
  /** Grouping header in the editor (e.g. "Transport", "Editing", "Navigation"). */
  category: string;
  scope: ShortcutScope;
  /** Factory bindings. One action may have several (e.g. redo = Ctrl+Shift+Z or Ctrl+Y). */
  defaultBinding: Chord[];
  /** Optional one-liner shown on the detail pane. */
  description?: string;
}
