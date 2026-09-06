# Named workspaces — save, switch, share

> **Deliverable:** this document, then the work packages in it.
> **Status:** **BUILT 2026-09-06** — WP-1 → WP-4 and WP-6 shipped; **WP-5 (bind a workspace to a
> project) deliberately not built** — it is optional and nobody has asked for it yet · **Placement:** **Core** (`services/layoutStore.ts`,
> a new `services/workspaceStore.ts`, `components/shell/`, `main/persistence.ts`) · **Risk:** 🟢 low —
> additive, no project-file change, no SDK change · **Breaking changes:** none. `Prefs.layoutState`
> keeps its exact meaning; a machine that never saves a workspace behaves byte-identically to today.
>
> Builds directly on [dockable-workspace.md](dockable-workspace.md). Where the two disagree about the
> dock tree, that document wins.

## 1. What the operator gets

Name the shape of the app and get it back later, on any machine:

- **Save the current arrangement under a name** — "Patch day", "Programming", "Show night", "Laptop".
  It captures *every* workbench's arrangement, not just the one you are looking at: the dock trees, the
  column widths, which panels you closed, the dock tab, the timeline drawer, and which workbench opens
  first.
- **Switch workspaces** from a chip in the title bar, the Context menu, or the command palette. The
  workbench rail keeps doing exactly what it does today — a workspace is the layer *above* it.
- **Export a workspace to a file** (`.artws`) and import it on another machine. One file can carry one
  workspace or the whole set, so a second operator PC is one import away from being set up.
- **Reset a workspace** back to the shipped arrangement without touching the others.
- Everything auto-saves into the workspace you are in. There is no dirty state, no "did I lose it".

**A workspace switch is UI-only and safe on a live rig.** Compositing, GPU sampling and Art-Net live in
`renderer/engine/frameEngine.ts` and depend on no component being mounted — the same fact that made
docking cheap makes this cheap. This is a claim to *verify*, not to assume (§10).

## 2. Naming — "workspace" is already taken, and that is the first hazard

The code and the UI already use *workspace* for what the docs call a **workbench**: `WorkspaceContext`,
`contextRegistry`, the rail's `aria-label="Workspace context"`, the palette's `hint: 'workspace'`. If a
saved arrangement is also called a workspace, every future reader of `layoutStore` has to disambiguate
two things that are one level apart.

**Decision.** The operator-facing word for the *saved snapshot* is **Workspace** — it is what the user
asked for and what Resolve/Notch operators expect. The nine contexts are **workbenches** everywhere the
operator can see, which is already what [docs/WORKSPACE.md](../docs/WORKSPACE.md) calls them. So:

| Layer | Code | UI word |
|---|---|---|
| One workbench (`mapping`, `3d`, …) | `WorkspaceContext`, `contextRegistry` — **unchanged** | "workbench" |
| A named snapshot of all of them | `SavedWorkspace`, `workspaceStore` — **new** | "workspace" |

Two one-line UI renames go with WP-1: the rail's `aria-label` → `"Workbench"`, and the palette's
`hint: 'workspace'` → `'workbench'`. Nothing else in the code changes name.

## 3. The machinery this lands on (all of it already exists)

| Piece | Where | What it gives us |
|---|---|---|
| The live layout | `services/layoutStore.ts` — one `WorkspaceLayout` object, debounce-persisted to `Prefs.layoutState` | The thing being named. Already one serializable blob. |
| Per-workbench ergonomics | `layout.contexts[id]` slices, banked by `setContext` | Travels as-is. |
| Per-workbench arrangement | `layout.dockTrees[id]`, read only through `ensureTree()` | Travels as-is, and `sanitizeDockTree` already refuses anything it does not fully understand. |
| Unknown panel ids | `DockRenderer.GroupBody` **skips an id that does not resolve, without dropping it from the tree** | A workspace authored on Windows-with-NDI opens on a Mac, keeps the placement, and gets it back when the plugin returns. This is the single fact that makes sharing viable. |
| Retired workbench ids | `RETIRED_CONTEXTS` in `layoutStore.hydrate()` | An old workspace naming `timeline`/`tracking` remaps instead of landing on nothing. |
| Shipped-layout revisions | `layoutRev` + `resolveContextLayout()` | An imported slice banked against an older rev is discarded for that workbench — correct, and worth a toast (§6.4). |
| File export/import | `exportRig`/`importRig` in `main/persistence.ts` + `IPC.RIG_EXPORT/IMPORT` | A 20-line template to copy verbatim. |
| Applying a layout at boot | `layoutStore.hydrate()` + `enterActiveContext()` in `App.tsx` | Applying a workspace is the same two steps, minus the boot-only migrations. |

**Nothing in the plugin SDK changes.** A plugin keeps declaring panel ids; a workspace only ever holds ids.

## 4. Data model

### 4.1 What travels, and what does not

The `Prefs` interface already carries a doctrine for this, stated on `scene3dRenderScale`: *per-MACHINE,
because it describes what this GPU can afford*. A workspace is the opposite — it describes **the job**.
The split follows that line and nothing else:

| Travels in a workspace | Why |
|---|---|
| `contexts` (all per-workbench slices) | The arrangement is the point. |
| `dockTrees` (all per-workbench trees) | Ditto. |
| `activeContext` | "Open Show night" should land you in Show. |
| `showLeft` / `showRight` / `dockOpen` / `splitView` / `bottomOpen` / `timelineMax` | The top-level mirror of the active workbench's slice; carried so the first paint after an apply is right. |
| `leftTab`, and `dockPanel` inside each slice | Which browser/dock tab the job wants open. |
| `dockingOff` | A workspace built of dock trees is meaningless under the fallback shell. It carries its own shell mode. |

| Stays per-machine (never in the file) | Why |
|---|---|
| `uiScale` | The screen, not the job. A 4K desk and a 1080p laptop want different numbers for the same workspace. |
| `scene3dRenderScale` / `scene3dMaxFps` / `scene3dLivePreview` / `scene3dGizmoSpace` / `scene3dSnap` | Already documented as per-machine GPU affordances. |
| `mediaView` | Its own comment in `layoutStore` says the operator picks a density because of *their screen and their media*. |
| `calibrationFile` | Describes the room. |
| `shortcuts`, `recentFiles`, `lastProjectPath`, `showSplash`, `appSettings` | Not layout. See §11 for why the keymap is deliberately not bundled. |

### 4.2 Types (new file: `src/renderer/services/workspaceStore.ts`)

```ts
/** The shareable subset of WorkspaceLayout. Every key here is UI SHAPE; nothing here describes a machine. */
export type PortableLayout = Pick<WorkspaceLayout,
  'contexts' | 'activeContext' | 'showLeft' | 'showRight' | 'dockOpen' | 'splitView'
  | 'bottomOpen' | 'timelineMax' | 'leftTab' | 'dockingOff'>
  & { dockTrees?: Record<string, unknown> };

export interface SavedWorkspace {
  id: string;            // stable, generated once — renaming must not orphan a project binding
  name: string;
  locked?: boolean;      // live edits apply but are not written back (see §6.2)
  createdAt: number;
  updatedAt: number;
  /** The window this was authored in, so an apply can clamp px sizes instead of trusting them (§5.3). */
  authored?: { w: number; h: number };
  layout: PortableLayout;
}
```

### 4.3 Persistence — one new top-level `Prefs` key

```ts
/** Named workspaces (saved shell arrangements) + which one is live. Renderer-owned blob, like
 *  layoutState. NOT a replacement for layoutState: that stays the live layout, so an install with no
 *  workspaces is unchanged and a corrupt workspaces blob costs nothing. */
workspaces?: { v: 1; activeId?: string; items: SavedWorkspace[] };
```

`setPrefs` is a one-level shallow merge, so `layoutStore`'s existing debounce can write
`{ layoutState, workspaces }` in **one** call. Keep it to one call — two timers racing on the same
300 ms window is how you get a workspace that remembers the layout from one tick ago.

### 4.4 The file format (`.artws`)

```jsonc
{
  "app": "artlux", "kind": "workspace", "v": 1,
  "appVersion": "0.29.0",          // informational, shown on import
  "dockTreeVersion": 1,            // matched against DOCK_TREE_VERSION — see §5.4
  "exportedAt": 1757000000000,
  "workspaces": [ /* SavedWorkspace[] — always an array, even for one */ ]
}
```

Always an array: exporting the whole set to set up a second operator PC is the request behind "shared
between machines", and a one-element array costs nothing.

## 5. The five portability hazards, and what each one does if unhandled

Each of these is silent — the app boots, nothing throws, and the operator gets a wrong-shaped shell.

**5.1 A workbench that does not exist on the target.** `calib` is gated by `CALIBRATION_ENABLED`, and a
plugin can register a workbench. `goToContext()` **no-ops on an unknown id**, and a saved `activeContext`
that resolves to nothing leaves the rail with **nothing selected** — the exact failure `RETIRED_CONTEXTS`
exists for. → `applyWorkspace()` remaps through `RETIRED_CONTEXTS`, then validates against
`contextRegistry.all()`, then falls back to `DEFAULT_LAYOUT.activeContext`. Slices and trees for absent
workbenches are **kept, not pruned** (the plugin may come back — the same rule `DockRenderer` uses for
panels).

**5.2 A panel that does not exist on the target.** Already handled by `GroupBody`'s skip. Nothing to
build — but WP-6 adds an invariant so that skip cannot be "simplified" into a filter that drops the id.

**5.3 A different screen.** `leftWidth` / `rightWidth` / `dockHeight` / `bottomHeight` are absolute px,
and so is every `{ px }` in a dock tree's `sizes`. A 700 px browser column authored on a 4K desk is half
of a 1366 px laptop. → `applyWorkspace()` runs one clamp pass against `window.innerWidth/Height`:
columns ≤ 40 % of width, dock/bottom ≤ 60 % of height, each ≥ its existing floor. **Clamp, do not
rescale** — a proportional rescale silently changes a layout the operator authored deliberately, and is
indistinguishable from a bug when it is wrong. `authored` is stored so the manager can *say* "authored at
3840×2160" rather than to drive arithmetic.

**5.4 A file from a different build.** `sanitizeDockTree` refuses a `v` mismatch and returns `null`, and
`ensureTree` then recompiles the shipped arrangement — correct behaviour, invisible failure. → Import
sanitizes every tree up front, counts the refusals, and **tells the operator**: *"3 workbenches will use
their default arrangement (saved by a newer build)."* A whole-file `v` mismatch refuses the import.

**5.5 A shipped layout revised since.** `resolveContextLayout()` discards a slice whose `rev` differs
from the context's current `layoutRev`. An imported workspace therefore loses *sizes* for a revised
workbench (its dock tree survives — trees are not rev-gated). This is right, and it is why the same toast
covers both cases. **Do not "fix" it by stripping `rev` on import**: that is how a shipped layout change
stops reaching anybody.

## 6. Behaviour decisions

**6.1 Auto-persist, no dirty flag.** Blender's model. Any layout edit while workspace *W* is active is
written into *W*. The `layoutStore` already debounce-persists every change; the workspace write rides the
same timer. Rejected alternative: an explicit Save with a modified dot — it adds a state the operator has
to manage, and its failure mode ("I closed it and lost my arrangement") is worse than its benefit.

⚠ `layoutStore.set()` forces `activePreset = 'custom'` on every patch — the vestige of the retired preset
system. **The workspace id must not be routed through that rule**: resizing a column inside "Programming"
leaves you in Programming. `activeWorkspaceId` lives in the `workspaces` blob, not in `WorkspaceLayout`,
which keeps the two mechanisms from ever touching. (`activePreset` itself stays exactly as it is — it is
read once in `hydrate()` for the pre-context migration and must not be repurposed.)

**6.2 Locked workspaces.** A show workspace should not drift because someone dragged a splitter at
17:55. A locked workspace applies normally and its live edits work — they are simply never written back,
and switching away discards them. One boolean, one `if` in the persist path, and it is the reason a
dirty flag is not needed for the case people actually care about.

**6.3 Reset.** "Reset this workspace" clears its `contexts` and `dockTrees` and re-applies, so every
workbench recompiles from its live manifest — the same door `DockRenderer`'s "Reset this workbench" uses,
one level up. Never hand-build a tree here.

**6.4 Switching.** Bank the live layout into the outgoing workspace (unless locked) → apply the incoming
one → `enterActiveContext(contextLayoutOf(...))`, exactly as boot does. Persistent viewport elements
(`Stage`, `TimelinePanel`, `Simulator3D`) are positioned by `PersistentLayer`, not remounted, so a switch
does not throw away the 2D zoom or kill the 3D context. **The one exception is a workspace that flips
`dockingOff`** — the two shells are different renderers, so panels remount. Acceptable; state it in the
docs and confirm the 3D canvas comes back (it is lazy-*but-sticky* for a reason).

**6.5 Ship no built-in workspaces.** A built-in would need a hand-built tree per workbench to be worth
anything, and every context `layoutRev` bump would rot it. The shipped arrangement *is* the default, and
"Reset" is the way back to it.

## 7. UI surfaces

Per the standing rule — *when a feature seems to need a new place in the UI, question the shell's shape
instead of adding to it* — **this adds no workbench and no panel.** A workspace is the layer above the
rail, so it appears where the app's global identity already lives:

1. **A chip in the `MenuBar`**, immediately right of the Help menu, `no-drag`, showing the active
   workspace name + chevron. Click → menu: the workspace list (✓ on the active one), then *Save as
   new…* · *Rename…* · *Duplicate* · *Reset* · *Lock* · sep · *Import…* · *Export…* · *Manage…*.
   Absent-by-default: with no saved workspaces it reads "Default" and the menu offers only *Save as
   new…*, so an operator who never uses this never sees a list.
2. **The Context menu** gains a leading `Workspace ▸` submenu with the same items, because the menu bar
   is where a Windows operator looks first and the chip is easy to miss.
3. **Command palette**: one `Workspace: <name>` entry per saved workspace under a `Workspace` group,
   plus *Save as new…* / *Manage…*. Same `Cmd` shape as the existing `ctx:` entries.
4. **`Preferences ▸ Appearance`** gains a *Workspaces* section: the list with rename / duplicate / lock /
   delete / export per row, an import button, and the `authored at W×H` line. This is the full manager;
   `Manage…` in the chip menu navigates here (`goToContext('preferences')`).

No new keyboard shortcut in v1. If one is wanted later it goes through the keymap registry
(`docs/SHORTCUTS.md`), never a hardcoded keydown.

## 8. Work packages

Each is independently revertible and leaves the tree buildable.

**WP-1 — the store (no UI).** `services/workspaceStore.ts`: the types above, a pub/sub singleton in the
`layoutStore`/`cueBus` idiom, `list/get/saveAs/rename/duplicate/remove/setLocked/setActive/reset`,
`captureFromLayout()`, and `applyWorkspace()` (remap → validate → clamp → sanitize trees → `layoutStore`
apply → `enterActiveContext`). Add `Prefs.workspaces` to `shared/protocol.ts`. Hydrate in `App.tsx`
beside `layoutStore.hydrate()` — **after** it, and applying the active workspace replaces
`enterActiveContext`'s job for that boot. Extend `layoutStore`'s persist to write both keys in one
`setPrefs`. Add `layoutStore.applyPortable(p)` (a sibling of `hydrate`, not routed through `set()` — it
must not stamp `activePreset='custom'`). Plus the two one-line renames from §2.
*Verify:* a `tsc`-checked throwaway script over `captureFromLayout` → `applyWorkspace` round-trip and the
clamp pass, per the repo's pattern for pure logic. Not a UI job.

**WP-2 — switch + auto-persist.** Wire the chip in `MenuBar.tsx` and the `Workspace ▸` submenu. Bank on
switch, honour `locked`. This is the first point the feature is usable.

**WP-3 — export / import.** `IPC.WORKSPACE_EXPORT` / `WORKSPACE_IMPORT` + `exportWorkspaces` /
`importWorkspaces` in `main/persistence.ts`, copied from `exportRig`/`importRig` (`.artws`, filter
`ARTLux Workspace`). Preload lines, `ArtluxApi` entries. Import validates the envelope, remaps, sanitizes,
de-duplicates names (`"Show night (2)"`), assigns fresh ids, and reports refusals per §5.4.
**Main is a dumb reader/writer** — every validation rule lives in `workspaceStore`, next to the model it
protects, so the two cannot drift.

**WP-4 — the manager.** The `Preferences ▸ Appearance ▸ Workspaces` section + the palette entries.

**WP-5 — bind a workspace to a project (optional, ship only if wanted).** `Prefs.projectWorkspaces?:
Record<string, string>` — project path → workspace id, **per-machine**. A "Use this workspace with this
project" toggle in the manager; applied when a project loads, skipped under `SHOW_ENGINE`. Per-machine
and by *reference* is what keeps the doctrine intact: layout still never enters the portable `.artlux`.

**WP-6 — guards + docs** (§9, §10).

Files touched, whole feature: `shared/protocol.ts`, `src/preload/index.ts`, `src/main/persistence.ts`,
`src/main/ipc.ts`, `src/renderer/services/workspaceStore.ts` (new), `services/layoutStore.ts`,
`components/MenuBar.tsx`, `components/Preferences.tsx`, `components/shell/CommandPalette.tsx`,
`components/shell/ContextRail.tsx` (label only), `App.tsx` (hydrate), `scripts/verify-invariants.cjs`,
`docs/WORKSPACE.md`, `docs/user-guide/01-interface-tour.md`.

## 9. Invariants to add (`scripts/verify-invariants.cjs`)

Each encodes a failure above that compiles, boots, throws nothing, and is wrong.

1. **`applyWorkspace` is the single door onto a saved workspace** — nothing outside `workspaceStore.ts`
   may read `prefs.workspaces` or spread a `SavedWorkspace.layout` into the layout store. (Mirrors the
   existing `ensureTree` guard.)
2. **An applied `activeContext` is validated against the registry** — `workspaceStore.ts` must reference
   both `RETIRED_CONTEXTS` (via the store) and `contextRegistry`, or an imported id lands on a rail with
   nothing selected.
3. **A workspace apply does not go through `layoutStore.set()`** — that would stamp
   `activePreset='custom'` and, more importantly, re-enter the manual-edit path while applying.
4. **`DockRenderer` keeps skipping unresolved panel ids rather than filtering them out of the tree** —
   the guarantee the whole sharing story rests on.
5. **The per-machine keys never appear in `PortableLayout`** — a literal check that `uiScale`,
   `scene3d*`, `calibrationFile`, `mediaView` and `shortcuts` are absent from the type's `Pick<>` and
   from the export builder.

## 10. Verification — what was actually run

Two entry points, both kept (the repo already keeps `test-docktree.ts` and a family of CDP harnesses):

**`npm run test:workspace`** — 23 assertions over the pure module, compiled and run in about a second
with no Electron and no app. A 4K-authored workspace clamped onto 1366×768 (columns to 40 %, the dock
to 60 %, `fr` sizes untouched, the tree's px clamped on the *same axis as its split*); idempotence; a
`v: 2` tree refused **and counted**; `tracking` remapped to `3d`; an absent workbench falling back
instead of selecting nothing, with its slice kept; and the per-machine keys absent.

> It **found a defect on its first run**: `remappedContext` was true for a *clean* retired-id remap,
> so switching a workspace saved as `tracking` would have told the operator their workbench was
> unavailable when it had simply been renamed. It is now `fellBackContext`, true only when the
> workbench exists nowhere. That is the argument for the module being pure.

**`npm run test:workspace:live`** — 28 assertions against the running app over CDP (drives the store,
never a text-matched menu item). The chip is in the title bar and reads *Default*; save; an edit banks
into the workspace you are in; a second workspace holds its own shape; switching back restores the
first; a **locked** workspace is not written to while the live layout still moves; the file round trip
(fresh ids, de-duplicated names, nothing refused on the same build); a rig file / a `v: 99` file /
junk / an empty file all refused; eight switches never leaving the rail with nothing selected; and
what reached prefs carries no per-machine key. It removes every workspace it creates.

**The show, measured rather than assumed.** Section 9 samples the engine's own metrics endpoint while
switches run: **output held 54–60 fps through 32 switches in 2.6 s**, against a 52–58 idle band — no
dip. The long-frame counter rose at the same rate it rises at idle, so nothing there is attributable
to switching. This is the claim §1 makes, and it is the one that had to be a measurement.

**Two guards caught two more defects before the app was ever launched**, which is the mechanism the
repo is built on: a numbered default name from `items.length + 1` (delete one of two and the count
proposes a name already on screen — `nextNumberedName` is the one door), and a `focus:outline-none` in
the new prompt input that would have removed the keyboard-focus ring for every consumer of the kit.

**Three defects in the tests themselves**, all found by running them rather than reading them, and all
worth knowing because each would have made the suite lie:

1. **The live suite deleted every workspace at the end**, not just its own — it would have wiped the
   operator's real ones. It now snapshots the list on the way in and restores exactly that.
2. **The output check compared two floors within 1 fps.** `artlux_output_fps` is a 1 Hz gauge on a box
   also running vite; it wobbles a few fps at rest, so the check failed on noise alone once. It now
   asserts what an operator would actually notice — never zero, never below 45 — and prints both bands
   so a real regression shows up in the numbers instead of hiding behind a pass.
3. **A long dev session poisoned a run.** After many HMR reloads the cleanup "succeeded" and prefs still
   ended with eight workspaces: a stale module instance was holding its own copy of the store *and* a
   live layout subscription, and wrote it back last. On a fresh boot the same suite passes repeatedly
   and disk ends empty. **This is the known dev-only duplicate-singleton hazard, not a product bug** —
   but it is worth remembering that a workspace result from a hot-reloaded session cannot be trusted.

**Still not verified, and only a second machine can do it:** the actual cross-machine import — export
here, import on a build without NDI/Spout/calibration, and confirm the arrangement holds and the panels
return when the plugins do. The panel-skipping behaviour it rests on is asserted by an invariant, and
the tree/clamp/remap half is covered above, but the end-to-end trip is untested.

## 11. Non-goals (v1), each with its reason

- **The keymap does not travel.** It has its own store, its own editor and its own prefs key, and a
  rebinding is a personal habit rather than a task. Bundling it into a workspace would mean a shared
  file silently rewriting someone's keyboard. If it is wanted later it is a *second, opt-in payload* in
  the same file, never implicit.
- **Per-workbench named workspaces** (a "Mapping: wide" vs "Mapping: narrow"). One level of naming is
  what the request asks for, and two would make "which one am I in" a question with two answers.
- **Sync over the network / a cloud store.** A file is the shareable unit; the venue PCs already move
  projects by file. (`plans/multi-machine-sync.md` is the place for the other conversation.)
- **Workspaces inside the `.artlux` project.** Layout is workspace ergonomics; the project stays
  portable and machine-agnostic. WP-5's per-machine *reference* is the sanctioned way to tie the two.
- **Built-in workspaces.** §6.5.

## 12. Documentation (the gate — this is a net-new feature)

Written in the **same commits**, per the rule in CLAUDE.md:

- **[docs/WORKSPACE.md](../docs/WORKSPACE.md)** (`hybrid`) — a *Workspaces* section on the operator side
  of an `<!-- audience:operator -->` toggle: what a workspace holds, what stays on the machine, saving,
  switching, locking, resetting, and the `.artws` round-trip. The model/portability half of this plan
  goes on the contributor side.
- **[docs/user-guide/01-interface-tour.md](../docs/user-guide/01-interface-tour.md)** — the operator
  walkthrough, describing **verbs and destinations** (title-bar chip → *Save as new…*), never panel
  coordinates. No new screenshot: the cap is a ceiling and a menu is describable in prose.
- No `docs/manifest.json` change (no new page), and no `generated:` block — nothing here is derived
  from source. `npm run verify:docs` must pass.

## 13. Decisions taken during the build

**The chip lives in the title bar** (owner, 2026-09-06) — right of the menus, before the draggable
spacer, sharing the `MenuBar`'s existing `open` state so an outside click or Escape closes it by the
effect that is already there. The rail footer and the StatusBar were the alternatives.

Four deviations from the plan above, each with its reason:

1. **The pure half is its own module** — `services/workspacePortable.ts`, not a function inside
   `workspaceStore.ts`. It imports only `dockTree` (itself import-free) and types, so the clamp, the
   tree refusal and the workbench remap are verifiable by a throwaway `tsx` script instead of by
   clicking panels. That test **found a real defect** on its first run (below), which is the argument.
2. **Two `setPrefs` calls, not one.** §4.3 wanted the workspaces blob to ride the layout store's
   existing write. It does not: main's `setPrefs` merges a patch into a cached object and writes
   atomically, so two writes inside one window cannot lose each other — and injecting a collector into
   `layoutStore` would couple it to a feature it has no reason to know about.
3. **`usePrompt()` was added to the feedback substrate** (`components/ui/feedback.tsx`). Naming a
   workspace needs a text question, and the module exists precisely so no feature reaches for a native
   `window.prompt`. It is the third channel beside `useToast`/`useConfirm`, and rename reuses it.
4. **`remappedContext` became `fellBackContext`.** The pure test showed the flag was true for a
   *clean* retired-id remap (`tracking` → `3d`), so a correct rename would have told the operator
   "your workbench is not available here". It is now true only when the workbench exists nowhere.

Two guards caught two more defects before the app was ever launched: a numbered default name built from
`items.length + 1` (the repo has one door for those, `nextNumberedName`), and a `focus:outline-none` in
the new prompt input that would have removed the keyboard-focus ring for every consumer of the kit.
