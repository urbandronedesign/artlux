# Keyboard shortcuts

ArtLux shortcuts are **configurable**. Every rebindable action lives in one registry, resolves through
one keymap the handlers consult, and the user's changes are saved to prefs. This replaced the old static
"Keyboard shortcuts" list that used to sit in the Help panel and drifted from the real bindings.

## For the user — rebinding a shortcut

1. Open **Help ▸ Keyboard Shortcuts…** (in the app title-bar menu; on macOS, the native Help menu).
2. The editor is a searchable, full-page **table** — one row per action, grouped by category. Search at
   the top narrows the rows.
3. **Click the shortcut cell** of the row you want and press the key combination — the cell records it
   automatically (no separate button). It applies and is **saved immediately**, and survives restarts.
   Press **Esc** while a cell is armed to cancel.
4. Hover a changed row and click its **↺** to reset that one action; **Reset all** (top-right) restores
   everything.

**Conflicts are blocked *within a scope*.** If you bind a key already used by another action *in the same
scope*, the editor refuses it and names the clash. Reusing a key across *different* scopes is allowed on
purpose: a **Timeline** shortcut only fires while the timeline panel is focused, so it can safely reuse a
key that also does something **Global**. Scopes: Global, Timeline, State graph, Projector.

Config is stored per machine in `userData/artlux-prefs.json` under `"shortcuts"` (only the actions you
changed are written; everything else follows the shipped defaults, so a future default reaches you).

### Not (yet) rebindable

Left hardcoded by design: the **File/Edit menu accelerators** (Ctrl+N/O/S, Ctrl+, …), the **Ctrl+1..9**
direct workspace jumps, and **Esc-to-cancel/close** everywhere. These are not shown in the editor.

(**Ctrl+T** — show/hide the timeline drawer — *is* rebindable: it is `global.toggleBottom`, category
View. The View-menu entry shows the label but does not register the accelerator, so a rebind takes
effect. See [WORKSPACE.md](WORKSPACE.md#the-full-width-bottom-drawer-workspacecontextbottom).)

<!-- audience:contributor -->

## For developers — how it works

Canonical module: [`src/renderer/shortcuts/`](../src/renderer/shortcuts/).

| File | Role |
|---|---|
| `types.ts` | `ShortcutDef` (id, label, category, scope, `defaultBinding`), `Chord`, `ShortcutScope`. |
| `chord.ts` | `eventToChord` / `matchChord` — canonical chord form. Folds Ctrl/Meta into one `Ctrl` token; carries letter case as an explicit `Shift` (so `l` vs `Shift+L` survive). |
| `registry.ts` | `SHORTCUT_DEFS` — the single source of truth. Both the dispatcher and the editor read it. |
| `keymapStore.ts` | The live `keymap` singleton: `matches(e, id)` (handlers call this), `setBinding/resetBinding/resetAll`, `findConflict`, `hydrate`. Persists overrides-only to `Prefs.shortcuts`. |

UI: [`components/shortcuts/ShortcutsEditor.tsx`](../src/renderer/components/shortcuts/ShortcutsEditor.tsx)
(a HelpBrowser-style overlay), opened via [`services/shortcutsNav.ts`](../src/renderer/services/shortcutsNav.ts)
`openShortcuts()`. It is mounted **once** in `WorkspaceShell`; `keymap.hydrate(prefs.shortcuts)` runs at
boot in `App.tsx`.

**A handler consults the keymap instead of hardcoding keys:**

```ts
// before
if (e.key === ' ') { e.preventDefault(); togglePlay(); }
// after
if (keymap.matches(e, 'timeline.togglePlay')) { e.preventDefault(); togglePlay(); }
```

Handlers migrated: `useTimelineKeys.ts` (`timeline.*`), `App.tsx` globals
(`global.undo/redo/selectAll/perfDock/clearNvwarp`), `ContextRail.tsx`
(`global.nextContext/prevContext`), `StateGraphEditor.tsx` (`stategraph.deleteSelected`),
`ProjectorApp.tsx` warp keys (`projector.*`).

### Gotchas when adding / touching a shortcut

- **Add the action to `registry.ts`** with a stable `id` (the id is the prefs key — never rename it) and
  the correct `scope`. The editor and the dispatcher pick it up from there; nothing else to register.
- **Shift as an orthogonal modifier.** When Shift *modifies* an action rather than being part of its
  binding (timeline delete = ripple/lift; projector nudge = ×10 step), don't use `keymap.matches` — match
  the binding with a leading `Shift+` stripped, then read `e.shiftKey` for the modifier. See the
  `deleteSelected` branch in `useTimelineKeys.ts`.
- **Two menus, kept in sync.** The Help/View/… menu you see is the custom title bar
  [`components/MenuBar.tsx`](../src/renderer/components/MenuBar.tsx); it **mirrors** the native Electron
  menu [`src/main/menu.ts`](../src/main/menu.ts). A menu entry (like *Keyboard Shortcuts…*) must be added
  to **both** — MenuBar is what renders on the frameless window, menu.ts is what macOS + accelerators use.
- **Separate renderer windows hydrate their own keymap.** A projector window (`projector.html`) is its own
  renderer with its own module instances, so it calls `keymap.hydrate(prefs.shortcuts)` on mount — the
  main editor's hydrate does not reach it.
