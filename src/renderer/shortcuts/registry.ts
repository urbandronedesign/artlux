import type { ShortcutDef, ShortcutScope } from './types';

// The single source of truth for every REBINDABLE renderer shortcut. Seeded verbatim from the bindings
// that were previously hardcoded in the handlers, so behaviour is unchanged on first run. Both the live
// dispatcher (keymapStore) and the editor UI read this — the registry IS the index, the same trick that
// makes HelpBrowser/CommandPalette nearly free.
//
// NOT in this list (kept hardcoded on purpose):
//  - The parametric Ctrl+1..9 context jumps in ContextRail — nine numeric variants of one behaviour, not
//    individual actions worth a row. (Ctrl+Tab / Ctrl+Shift+Tab cycling IS here.)
//  - Pure modal Escape-to-close (HelpBrowser, About, AudioEngineMissing, Tooltip, CommandPalette,
//    MenuBar) — closing a dialog with Esc is not a user-tunable action.
//  - Native File-menu accelerators (Ctrl+N/O/S, Ctrl+comma) — those live in the main-process menu and
//    are out of scope for v1 (renderer-only). (F1 left this list when help merged into one modal:
//    HelpBrowser owns it in its own keydown, the Ctrl+K pattern, so it could toggle.)

export const SHORTCUT_DEFS: ShortcutDef[] = [
  // ── Timeline (active only when the timeline panel is hovered/focused) ──────────────────────────────
  { id: 'timeline.togglePlay',     label: 'Play / pause',          category: 'Transport', scope: 'timeline', defaultBinding: ['Space'] },
  { id: 'timeline.play',           label: 'Play',                  category: 'Transport', scope: 'timeline', defaultBinding: ['L'] },
  { id: 'timeline.toggleLoop',     label: 'Toggle loop',           category: 'Transport', scope: 'timeline', defaultBinding: ['Shift+L'] },
  { id: 'timeline.pause',          label: 'Pause',                 category: 'Transport', scope: 'timeline', defaultBinding: ['K', 'J'] },
  { id: 'timeline.seekHome',       label: 'Seek to start',         category: 'Transport', scope: 'timeline', defaultBinding: ['Home'] },
  { id: 'timeline.seekEnd',        label: 'Seek to end',           category: 'Transport', scope: 'timeline', defaultBinding: ['End'] },
  { id: 'timeline.toggleMax',      label: 'Maximize timeline',     category: 'View',      scope: 'timeline', defaultBinding: ['F'] },
  { id: 'timeline.zoomIn',         label: 'Zoom in',               category: 'View',      scope: 'timeline', defaultBinding: ['+', '='] },
  { id: 'timeline.zoomOut',        label: 'Zoom out',              category: 'View',      scope: 'timeline', defaultBinding: ['-', '_'] },
  { id: 'timeline.bladeTool',      label: 'Blade tool',            category: 'Tools',     scope: 'timeline', defaultBinding: ['B'] },
  { id: 'timeline.selectTool',     label: 'Select tool',           category: 'Tools',     scope: 'timeline', defaultBinding: ['V'] },
  { id: 'timeline.toggleSnap',     label: 'Toggle snapping',       category: 'Tools',     scope: 'timeline', defaultBinding: ['S', 'N'] },
  { id: 'timeline.bladeAtPlayhead',label: 'Blade at playhead',     category: 'Editing',   scope: 'timeline', defaultBinding: ['C'] },
  { id: 'timeline.addMarker',      label: 'Add marker',            category: 'Editing',   scope: 'timeline', defaultBinding: ['M'] },
  { id: 'timeline.setIn',          label: 'Set in point',          category: 'Editing',   scope: 'timeline', defaultBinding: ['I'] },
  { id: 'timeline.setOut',         label: 'Set out point',         category: 'Editing',   scope: 'timeline', defaultBinding: ['O'] },
  { id: 'timeline.deleteSelected', label: 'Delete selected (ripple)', category: 'Editing', scope: 'timeline', defaultBinding: ['Delete', 'Backspace'], description: 'Hold Shift to lift (no ripple).' },

  // ── Global (active app-wide, suppressed while typing) ─────────────────────────────────────────────
  { id: 'global.undo',        label: 'Undo',                 category: 'Editing',    scope: 'global', defaultBinding: ['Ctrl+Z'] },
  { id: 'global.redo',        label: 'Redo',                 category: 'Editing',    scope: 'global', defaultBinding: ['Ctrl+Shift+Z', 'Ctrl+Y'] },
  { id: 'global.selectAll',   label: 'Select all fixtures',  category: 'Editing',    scope: 'global', defaultBinding: ['Ctrl+A'] },
  { id: 'global.perfDock',    label: 'Open Performance dock',category: 'View',       scope: 'global', defaultBinding: ['Ctrl+Alt+P'] },
  // The timeline is a tool you pull up inside whatever workbench you are in, not a place you go — this
  // is how you pull it up. Global on purpose: every context that names a bottom panel answers to it.
  { id: 'global.toggleBottom',label: 'Show / hide the timeline drawer', category: 'View', scope: 'global', defaultBinding: ['Ctrl+T'] },
  { id: 'global.clearNvwarp', label: 'Clear all NV warp/blend', category: 'View',    scope: 'global', defaultBinding: ['Ctrl+Shift+W'] },
  { id: 'global.nextContext', label: 'Next workspace',       category: 'Navigation', scope: 'global', defaultBinding: ['Ctrl+Tab'] },
  { id: 'global.prevContext', label: 'Previous workspace',   category: 'Navigation', scope: 'global', defaultBinding: ['Ctrl+Shift+Tab'] },
  // Recording is a PERFORMANCE gesture against the live rig, so it answers from every workbench —
  // including Calibration and Preferences, which have no timeline drawer and so had no route to a
  // recorder at all. NOT bare 'R', and NOT Ctrl+R: Ctrl+R is a registered main-process Reload
  // accelerator (main/menu.ts) that fires before the renderer sees the key — it would hard-reload the
  // app mid-take. Both toggle; refusals surface as a toast, never a silent no-op.
  { id: 'global.recordLighting', label: 'Record lighting take', category: 'Recording', scope: 'global', defaultBinding: ['Ctrl+Shift+R'], description: 'Toggles. Captures the SELECTED fixtures — their selection order becomes the take.' },
  { id: 'global.recordTracking', label: 'Record tracking take', category: 'Recording', scope: 'global', defaultBinding: ['Ctrl+Alt+R'], description: 'Toggles. Captures the live tracker feed, independent of the transport.' },

  // ── State-graph editor (active when the Show state-machine graph is focused) ──────────────────────
  { id: 'stategraph.deleteSelected', label: 'Delete state / transition / region', category: 'Editing', scope: 'stategraph', defaultBinding: ['Delete', 'Backspace'] },
  // The recovery gesture for the unbounded graph canvas — same job as the Stage's Fit button.
  { id: 'stategraph.fitView', label: 'Fit graph in view', category: 'View', scope: 'stategraph', defaultBinding: ['F'], description: 'Frames every state and region. The toolbar Fit button does the same; Alt-click it to reset the view to 1:1.' },

  // ── Projector warp editing (active only in a projector window's warp-edit mode) ───────────────────
  // The projector runs in its own renderer window (ProjectorApp); it hydrates the keymap from prefs on
  // mount, so these are live there. Esc-to-dismiss stays hardcoded (universal cancel).
  { id: 'projector.warpReset',      label: 'Reset warp handle',  category: 'Warp', scope: 'projector', defaultBinding: ['R'] },
  { id: 'projector.warpNudgeUp',    label: 'Nudge handle up',    category: 'Warp', scope: 'projector', defaultBinding: ['Up'] },
  { id: 'projector.warpNudgeDown',  label: 'Nudge handle down',  category: 'Warp', scope: 'projector', defaultBinding: ['Down'] },
  { id: 'projector.warpNudgeLeft',  label: 'Nudge handle left',  category: 'Warp', scope: 'projector', defaultBinding: ['Left'] },
  { id: 'projector.warpNudgeRight', label: 'Nudge handle right', category: 'Warp', scope: 'projector', defaultBinding: ['Right'], description: 'Hold Shift for a ×10 step.' },
];

const BY_ID = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

export function shortcutDef(id: string): ShortcutDef | undefined {
  return BY_ID.get(id);
}

export function defsByScope(scope: ShortcutScope): ShortcutDef[] {
  return SHORTCUT_DEFS.filter((d) => d.scope === scope);
}
