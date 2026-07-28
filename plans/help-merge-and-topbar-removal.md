# One help surface, one place per function

Two changes that are really the same change: **stop rendering a function twice.**

1. The **TopBar icon group** (Outputs · Routing · DMX Monitor · Preferences · Help) is a second
   entry point for five functions that all already live in the menus, the context rail or the dock
   tab strip. Remove it.
2. **Help is two surfaces** — a right-side drawer (`HelpPanel`, F1) and a centered search modal
   (`HelpBrowser`, Shift+F1) — split across two content stores, with the drawer carrying a button
   whose only job is to open the other one. Merge them into the modal.

Neither change adds a feature. Both delete a duplicate. This is v2 of the plan; v1 was reviewed and
three things were cut or corrected — each is marked ⚑ where it lands, because the *reason* is the
part worth keeping.

---

## Where things stand today

**The icon group** — [TopBar.tsx](src/renderer/components/TopBar.tsx) renders five `IconButton`s,
passed to `MenuBar` through its `actions` slot ([App.tsx:3652](src/renderer/App.tsx#L3652)). Every
one is a second door:

| Icon | What it does | The door that already existed |
|---|---|---|
| `MonitorUp` Outputs | `refreshDisplays(); goToContext('project')` | the identical `case 'outputs'` in dispatchMenu ([App.tsx:2560](src/renderer/App.tsx#L2560)) + Context ▸ Projection Outputs (`Ctrl+3`) + the rail |
| `Network` Routing | `openDockPanel('core.dock.routing')` | File ▸ Routing… + the Routing dock tab in Mapping |
| `Activity` DMX Monitor | toggles `core.dock.monitor` | the DMX Monitor dock tab — **in 4 of 9 contexts, and no menu item** |
| `Settings` Preferences | `goToContext('settings')` | File ▸ Preferences… (`Ctrl+,`) + Context ▸ Preferences (`Ctrl+9`) + the rail |
| `HelpCircle` Help | toggles `showHelp` | Help ▸ Help Panel (`F1`) |

Only the DMX Monitor is a real gap — from Scenes or Audio the icon is genuinely the only way to it.
That gap closes **before** the icon goes (commit 1), not after.

**The two help surfaces:**

| | `HelpPanel` (F1) | `HelpBrowser` (Shift+F1) |
|---|---|---|
| Shape | right drawer, resizable 240–560px, `layout.showHelp` | centered modal, self-owned open state |
| Content | `HELP_TOPICS` — ~8 coarse bilingual guides | `HELP_REGISTRY` — per-function entries, English |
| Live hover | "Context" section, subscribes `helpBus` | — |
| Language | EN/FR `Segmented` → `settings.helpLang` | English only |
| Deep link | — | `helpNav` / `openHelp(id)` — the tooltip "? Learn more" target |
| Cross-link | a "Search all help…" button that opens the other one | — |

The drawer's live-hover "Context" line is itself a *third* copy: `StatusBar`
([StatusBar.tsx:97](src/renderer/components/StatusBar.tsx#L97)) subscribes to the same `helpBus` and
renders the same hint, permanently, without costing 320px of window.

---

## Decisions

1. **The modal wins; the drawer goes.** It is the surface with search, deep-linking and the
   registry behind it.
2. **The live-hover "Context" section does not move into the modal.** A modal sits *over* the UI —
   you cannot hover a control while it is open, so a live hover line in it reads permanently idle.
   `StatusBar` already does that job, always visible, for free.
   ⚑ *v1 compensated with a `helpBus.lastId()` so F1 would open on the last-hovered control. Cut:
   it is a new feature smuggled into a removal task, and "last hover" is stale hover — F1 pressed
   minutes later opens help for a control you brushed past and don't remember, which is more
   surprising than opening at the top. The precise-targeting need is already served by the
   tooltip's "? Learn more" deep link. If operators miss it, it returns as its own small change.*
3. **F1 becomes renderer-owned, exactly like Ctrl+K.**
   ⚑ *v1 kept the native `accelerator: 'F1'` AND widened HelpBrowser's keydown — two owners for
   one key. If Electron consumes the accelerator, the renderer never sees F1 and toggle-to-close is
   dead (the menu path can only open, so a second F1 re-opens instead of closing); if it doesn't,
   one press fires both handlers. The codebase already settled this pattern: CommandPalette owns
   Ctrl+K in its own keydown ([CommandPalette.tsx:59](src/renderer/components/shell/CommandPalette.tsx#L59)),
   there is no native accelerator for it, the MenuBar item is a plain click, and the accel text in
   the custom MenuBar is display-only. F1 copies that.*
4. **No action-string aliases.**
   ⚑ *v1 kept `help-panel`/`help-search` as dispatch aliases "for one release" against a stale
   packaged menu. That menu is rebuilt at every launch from `main/menu.ts` in the same bundle as the
   renderer — the version skew being defended against cannot occur. Dead code, cut.*
5. **Three independently shippable commits**, smallest risk first. This repo commits straight to
   `main`; each commit leaves the app whole.

---

## Commit 1 — `View ▸ DMX Monitor` (closes the only real gap)

Add `DMX Monitor` beside `OSC Monitor` in the View menu, in **both** mirrors —
[MenuBar.tsx](src/renderer/components/MenuBar.tsx#L95) and [main/menu.ts](src/main/menu.ts) (they
are deliberate copies; edit both or the native accelerator path drifts). New `case 'dmx-monitor'`
in `dispatchMenu` runs exactly the body the icon runs today
([App.tsx:3660-3666](src/renderer/App.tsx#L3660-L3666)): toggle off if it is the active dock panel,
else write `dockPanel: MONITOR_PANEL` **into the active context's slice** — never `layout` raw —
the same place the shell's tab strip writes.

No accelerator (OSC Monitor's Ctrl+Shift+M is the exception in that group, not the rule). No
checked-state in the menu item — the custom `Item` type has none and the sibling View toggles
don't show state either.

Shippable alone: it merely adds a third door before commit 3 removes the second.

## Commit 2 — one help modal

### 2a. Fold the topics into the search index

`HELP_TOPICS` ([help/helpContent.ts](src/renderer/help/helpContent.ts)) stay bilingual;
`HELP_REGISTRY` ([help/registry.ts](src/renderer/help/registry.ts)) stays flat English. **Neither
store is rewritten** — adapt at the edge, inside `HelpBrowser`:

```ts
// A topic is a registry entry whose text is language-dependent. `topic.<id>` cannot collide with
// the dotted area ids, so one list serves both tiers.
const topicEntries = (lang: HelpLang): HelpEntry[] =>
  HELP_TOPICS.map((t) => ({ id: `topic.${t.id}`, title: t.title[lang], short: t.body[lang],
                            body: t.body[lang], group: 'Guides', keywords: [t.title.en, t.title.fr] }));
```

Both tiers feed the existing `score()` unchanged. On an **empty query**, list the Guides group
first — opening cold should read as a table of contents, not an alphabetized word heap.

### 2b. Rebuild `HelpBrowser` as the merged modal

Keep the file at [components/help/HelpBrowser.tsx](src/renderer/components/help/HelpBrowser.tsx) —
the "mounted exactly once" invariant ([verify-invariants.cjs:308](scripts/verify-invariants.cjs#L308))
matches on `<HelpBrowser`, and the mount point in `WorkspaceShell` stays put.

- Header gains the EN/FR `Segmented` lifted out of `HelpPanel`, beside the search input.
- Keydown: `e.key === 'F1'` toggles, shift or not — Shift+F1 survives as a silent alias for muscle
  memory at the cost of zero code. Still not suppressed while typing (that is the point of it).
- `helpNav` is unchanged: menu click and tooltip links are open-only, which is correct — you cannot
  click a menu under a focus-trapped overlay, so only the key needs toggle semantics.

**Split the component in two — this is load-bearing.** The merged modal needs `settings.helpLang` +
`updateSettings` from `EditorStore`, and the renderer repaints per frame during playback; a
`useEditor()` in the component that owns the open state re-renders at frame rate to return `null`:

```tsx
export const HelpBrowser = () => {          // open state, keydown, helpNav sub. Reads NO store.
  …
  if (!open) return null;
  return <HelpBrowserBody onClose={close} initialId={selId} />;   // this one calls useEditor()
};
```

Same idea as the existing early `return null`, moved one boundary out so the store subscription
lives on the inside of it.

### 2c. Rewire the entry points

| Where | Now | After |
|---|---|---|
| [main/menu.ts:118](src/main/menu.ts#L118) | `Help Panel`, `accelerator: 'F1'` → `help-panel` | `Help…` → `help`, **no accelerator** (decision 3) |
| [MenuBar.tsx:121-122](src/renderer/components/MenuBar.tsx#L121-L122) | `Help Panel  F1` + `Search Help…  Shift+F1` | one item `Help…  F1` (`accel` is display-only here) |
| [App.tsx:2570-2571](src/renderer/App.tsx#L2570-L2571) | `help-panel` toggles drawer; `help-search` → `openHelp()` | one `case 'help': openHelp(); break;` — old cases deleted, no aliases (decision 4) |

### 2d. Delete `HelpPanel`

Remove [components/HelpPanel.tsx](src/renderer/components/HelpPanel.tsx), its drawer wrapper
([App.tsx:3695-3710](src/renderer/App.tsx#L3695-L3710)), the `setShowHelp`/`setHelpWidth` bindings
([App.tsx:279-280](src/renderer/App.tsx#L279-L280)) and the destructure at
[App.tsx:249](src/renderer/App.tsx#L249), and the `showHelp`/`helpWidth` fields in
[layoutStore.ts](src/renderer/services/layoutStore.ts#L12) (declaration + `DEFAULT_LAYOUT`). They
are not in `CONTEXT_KEYS`, and stale keys in a persisted `layoutState` are inert — the store
spreads over `DEFAULT_LAYOUT` and nothing reads them — so no migration.

The `docsOpen` drawer beside it **stays**: Docs & Tutorials is long-form documentation and example
projects, not a third copy of help.

### 2e. Content that describes the old shape

[help/entries/chrome.ts](src/renderer/help/entries/chrome.ts): **keep every id** (`general.help`
etc. — ids are stable, tooltip deep links resolve by them), rewrite `general.help`'s body to
describe one searchable modal, and retitle the section comment ("TopBar…" → "App chrome"). Update
the rationale comment on the mount-once invariant to say the modal is now the *only* help surface.

## Commit 3 — remove the icon group

1. Delete [TopBar.tsx](src/renderer/components/TopBar.tsx) and its import + usage in `App.tsx`.
   Nothing is lost behaviourally: every body the five icons ran already exists as a dispatch case
   or context entry (see the table up top — including `outputs`, whose `refreshDisplays()` thread
   v1 worried about and which `case 'outputs'` already carries; `OutputsPanel` also refreshes via
   its `onRefreshDisplays` prop).
2. In `MenuBar`, drop the `actions` prop, the `{actions && …}` block **and the separator beside
   it** ([MenuBar.tsx:233-234](src/renderer/components/MenuBar.tsx#L233-L234)) — the separator
   renders unconditionally, so leaving it puts a hairline against the window controls with nothing
   on its left.
3. [scripts/capture-docs.cjs:438](scripts/capture-docs.cjs#L438) clicks `Help (F1)` by title for
   `16-help-panel.png`. Drop the step: the guide's screenshots are knowingly stale and re-capture
   is deferred to one whole-guide pass — this shot joins that pass.
4. Docs sweep: `docs/WORKSPACE.md:177` (TopBar gear), `docs/FEATURES.md:67` (TopBar network icon),
   `docs/SHORTCUTS.md` if it lists Shift+F1, `docs/user-guide/`, `CHANGELOG.md`. Leave
   `docs/PROGRESS.md` and `docs/archive/` — build history, not a description of what ships.

---

## Verifying it

`npm run verify` (invariants + typecheck) after each commit — necessary, nowhere near sufficient:
chrome is exactly the class of change that compiles clean and is wrong on screen. `npm run dev`:

1. **F1** opens the modal; **F1 again closes it** — this is the renderer-ownership fix, and the
   failure mode (native accelerator consuming the key) is silent. Shift+F1 does the same. Esc
   closes from the results list, not just the input.
2. Tooltip **"? Learn more"** still opens the modal focused on its entry
   ([Tooltip.tsx:144](src/renderer/components/ui/Tooltip.tsx#L144)).
3. **EN/FR** flips the Guides' language and survives a restart (`settings.helpLang`).
4. Empty query shows Guides first; searching mixes guides and functions by score.
5. `View ▸ DMX Monitor` from a context **without** the monitor dock tab (Scenes, Audio) — the
   reachability the icon was holding up; toggles off from one that has it.
6. Menu bar right edge: no orphan separator, window controls flush.
7. **Playback runs at rate with the modal closed** — if `useEditor()` leaked into the outer
   component of the 2b split, this is where it shows.
8. Hover a control → the StatusBar hint still updates (nothing in the deletion touches `helpBus`,
   but it is the surviving copy of the drawer's Context section — confirm it).

**No new invariant.** `verify:invariants` encodes bugs that shipped; nothing here is that shape
yet. The existing mount-once check keeps applying.

---

## Non-goals and follow-ups

- **Not** a rewrite of help content — registry, entry files and `HELP_TOPICS` survive as-is.
- **Not** French for the registry entries. The edge-adapter keeps the Guides bilingual; when FR is
  authored for the registry, the right move is to *unify the two stores* on the bilingual shape and
  delete the adapter — noted here so that work starts from one surface, not two.
- **Not** touching Ctrl+K or the Shortcuts editor — separate overlays with separate jobs.
- Deferred, deliberately: F1-opens-on-hovered-control (`helpBus.lastId()`) — see decision 2 for why
  it was cut and what would justify bringing it back.
