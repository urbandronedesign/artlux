# The dockable workspace — Phase 5

> **Deliverable:** this document, then the work packages in it. Canonical source for the docking effort;
> every session starts by reading the tracker.
> **Status:** planned 2026-07-27 · **Placement:** **Core** (`renderer/services/dockTree.ts`,
> `components/shell/`, `services/layoutStore.ts`) · **Risk:** 🟡 medium, staged so each WP is revertible ·
> **Breaking changes:** none to the `.artlux` project, none to the plugin SDK. Contexts and plugins keep
> declaring exactly what they declare today.
>
> Seeded by the appendix in [engine-decoupling.md §8](engine-decoupling.md), re-planned against the code
> as it now stands. Where the two disagree, this document wins.

## 0. Why this is much cheaper than it was

The docking design was first written when **output depended on a component staying mounted**. That single
fact forced "one element, one position", which is what made every docking design expensive: panes could
not be rearranged because the heaviest element in the app was pinned to a fixed tree position and the show
depended on it.

**Phase 1 dissolved that.** The frame loop lives in `renderer/engine/frameEngine.ts`, starts itself at
module load, reads no DOM, and reaches main over its own MessagePort — proven by deleting the Stage's
canvas *and container* out of a running app while the native engine held 61 Hz. WP-1.4 then **deleted the
Stage half of the mounted-once guard** deliberately, with docking named as the reason.

So the constraint list is now short, and each entry is a *component* concern rather than a show concern:

| Element | Still single-instance? | Why |
|---|---|---|
| `Stage` (2D) | **No** — free to move | Output no longer depends on it. Keeping it *persistent* is now only about not throwing away the operator's zoom/scroll/selection. |
| `Simulator3D` | **Yes** | One WebGL context. Also: mounting it at 0×0 leaves r3f's raycaster dead (CLAUDE.md), so it must be hidden, never unmounted. |
| `TimelinePanel` | **Yes** | Two instances double its keyboard hook and its engine subscription. |

That is the whole of it. Everything else in the shell is a registry panel that can be mounted, unmounted
and remounted freely — which is what a dock tree needs.

## 1. What the operator gets

Inside any of the nine contexts: drag a panel's tab onto another group to move it, onto an edge to split,
reorder tabs within a group, collapse a group, close a panel, add any registered panel from a menu, drag
splitters, and reset the context to its shipped arrangement. Per-context, persisted, and surviving a
restart — the same way sizes already are.

**Not in this phase:** tear-off OS windows. The `float` node kind is reserved in the model so adding them
later is not a migration, but nothing renders it yet.

## 2. The model

`ContextLayout.dockTree` — **slice-only, never mirrored to a top-level `WorkspaceLayout` key.** That is
not a style preference: `setContext` spreads `CONTEXT_KEYS` between the top level and the slice on every
switch, and a key living in both places is the bug class that produced the `bottomOpen` incident.

```ts
const DOCK_TREE_VERSION = 1;
type DockSize = { px: number } | { fr: number };
interface DockGroupNode { kind:'group'; id:string; render:'stack'|'tabs'; panelIds:string[];
  activeId?:string; collapsed?:boolean; region?:'browser'|'dock'|'inspector'|'viewport'; }
interface DockSplitNode { kind:'split'; id:string; dir:'row'|'col'; children:DockNode[]; sizes:DockSize[]; }
interface DockTree { v:number; root:DockNode; removed:string[]; meta:{ viewport:string; companion?:string }; }
```

Rules the ops enforce, each earned:

- **`render:'stack'` vs `'tabs'`.** The browser and inspector columns stack `CollapsibleSection`s with all
  of them visible; the dock is tabbed. Without the distinction there is no default-tree parity, and the
  inspector's `appliesTo` co-display (a surface *and* a fixture contributing sections at once) breaks.
- **A panel id appears at most once per tree.** Duplicates double window-level keyboard listeners.
- **Unknown panel ids are kept and skipped at render, never dropped.** Disabling a plugin must not erase
  its panel's placement forever. Precedent: orphaned context slices are never pruned.
- **`removed[]` is honoured on merge**, so a panel the operator closed does not come back on next launch.
- **`normalize()` ends every op**: dedupe, drop empty groups, hoist single-child splits, merge same-dir
  splits, repair `sizes`/`activeId`, cap depth ≤ 8 and nodes ≤ 64.
- **`sanitizeDockTree` is idempotent**; a version mismatch or garbage returns `null`, which re-derives.

## 3. The compiler — why no SDK change

`defaultTreeOf(context, banked?)` builds a tree from the **existing flat manifest** a context already
declares (`browser[]` / `dock[]` / `inspector[]` / `viewport` / `companion` / `bottom`). Contexts and
plugins therefore keep declaring what they declare today; `WorkspaceContext` is untouched.

`ensureTree = sanitizeDockTree(saved) ?? defaultTreeOf(context, banked)`. **The absence of a `dockTree`
IS the migration trigger** — no `layoutRev` bump, and the first build inherits the operator's banked
column widths, dock height, dock tab and flags, so an upgrade changes nothing visible.

`mergePluginPanels(tree, context)` inserts panels registered *after* a tree was banked into the group
tagged with their region, honours `removed[]`, and swaps `meta.viewport` when a plugin claims a context's
viewport via `contextRegistry.extend()`.

## 4. Persistent viewports — the one genuinely hard part

The three elements in the table above are created by `App` and passed into the shell. A React element
exists at exactly one position, so they cannot be rendered by a generic tree walker that may place them
anywhere.

**The tree renders `ViewportPlaceholder`s. The real elements live in a `PersistentLayer`**, absolutely
positioned over the winning visible placeholder's measured rect, via direct style writes — a
`ResizeObserver` plus a drag/transition-scoped rAF follow loop. **Never React state per frame**: that is
the discipline the whole engine-decoupling programme just spent itself establishing, and a layer that
setStates on every pointer tick during a splitter drag would reintroduce exactly what WP-0.5 removed.

Rejected: **portal reparenting**. It physically moves DOM nodes per gesture (canvas flicker, WebGL context
loss risk) and would hollow out the single-mount guards that keep the 3D scene and the timeline honest.

`timelineMax` becomes a priority placeholder, so the single `TimelinePanel` element is *retargeted* rather
than swapped — zoom and scroll survive maximizing, which they do not today.

## 5. What stays out of the tree

**The bottom drawer.** Its 28 px strip, `Ctrl+T`, per-context banking and never-remounting fixed position
are load-bearing — that fixed position is precisely the fix that killed the lost-zoom bug when `timeline`
stopped being a context. It keeps its own region below the tree.

**The context rail, action bar, command palette, help and shortcuts editors.** Not panels; not dockable.

## 6. Interaction

- **Pointer-event tab drag, never HTML5 DnD.** That channel already carries `application/artlux-asset` and
  `application/artlux-take`, and Chromium's file-drop-navigates footgun is documented in this repo.
- **5-zone drop targets** per group (centre = add as tab; four edges = split).
- **Splitters via the `useResizable` idiom** — local during drag, commit on release.
- **A tab context menu carrying every drag operation**, so rearranging is keyboard-reachable. Docking that
  is mouse-only would regress the roving-tabindex/WCAG-AA work already done.
- **An Add-Panel menu** over non-modal registry panels. `mount:'modal'` panels render outside
  `<EditorStore>`, so `useEditor()` would throw — they must not be offerable.
- **Reset layout** goes through `defaultTreeOf`, never a hand-written tree.

## 7. Regressions to prove absent (the user asked for this explicitly)

Each is something the current shell does that a naive tree renderer silently breaks:

1. Art-Net continuity while dragging panels — the standing canary (`node scripts/test-engine-output.cjs`).
2. The 3D canvas never remounts and never sits at 0×0 (dead raycaster).
3. Exactly one `TimelinePanel`; its keyboard hook fires once.
4. Inspector `appliesTo` filtering still co-displays sections for a multi-kind selection.
5. Per-panel `ErrorBoundary` still contains a panel throw as a sibling of the viewports.
6. A plugin panel registered late still lands in its region (`mergePluginPanels`).
7. Disabling a plugin does not erase its panel's placement; re-enabling restores it.
8. Banked per-context ergonomics survive; an upgrading install sees no visible change on first launch.
9. `bottomOpen` / `Ctrl+T` / the 28 px strip behave exactly as now.
10. Idle React commit time stays at **0.0 ms/s** — the number WP-0.5 bought.

## 8. Work packages

| WP | Scope | Status | Commit | Notes |
|---|---|---|---|---|
| 5.1 | `services/dockTree.ts` — types, `sanitizeDockTree`, `normalize`, the pure ops, `defaultTreeOf`, `mergePluginPanels`, `ensureTree`. **No UI.** | ☑ done | `cb09097` | Import-free as planned, and the test was **promoted from throwaway to durable**: `npm run test:docktree` runs **44 behavioural assertions in about a second** with no Electron and no app — cheap enough that there was no reason to throw it away. It caught one real disagreement, and **the model was right, not my assumption**: dropping a panel below the dock does *not* deepen the tree, because `normalize` inlines a same-direction split — which is exactly the rule that stops every drag from nesting forever. Guard `the dock tree imports nothing, and no saved tree is trusted without sanitizing` (3 break tests: a React import, removing `ensureTree`, and a component reading `layout.contexts[x].dockTree` raw). 55 checks. |
| 5.2 | `PersistentLayer` + `ViewportSlot` + `services/viewportSlots.ts`, behind a flag (`localStorage['artlux.persistentLayer']`, read once at module load), current shell still driving | ☑ done | `db0956c` | **Verified live:** all five viewports draw exactly over their slots or are correctly parked; the 3D scene follows into its own context **at a real size** (never 0×0, which kills r3f's raycaster); everything stays aligned through a **120-move splitter drag**; output holds 61 Hz / 4 universes throughout; no renderer errors. **The cost measurement is worth more than the claim.** The drag showed **195 ms/s** of React commit time — damning until the same drag is measured with the layer **OFF: 200 ms/s**. The layer adds *nothing*. ⚠ **That ~190 ms/s is the EXISTING column splitter**, which calls `layoutStore.set()` on every pointer move and re-renders the shell at pointer rate. Pre-existing, not introduced here, not fixed here — **but WP-5.4 adds more splitters and must not copy it**: the plan already says local-during-drag/commit-on-release, and the current column splitter does not do that. Guard `the persistent viewports are positioned, never reparented, and never followed through React state` (3 break tests; **the transform check needed tightening** — its first version passed a build with the positioning line deleted, because the *parked* branch also writes a transform). 56 checks. |
| 5.3 | Render the tree in `WorkspaceShell` behind `layout.docking` (+ the `artlux.docking` dev switch), defaulting **off**; both paths ship until 5.6 | ☑ done | `27ee1c6` | **Parity verified across all nine contexts** — same panels reachable, same viewports on screen, no renderer errors, output 61 Hz. **Two deviations, both because the code disagreed with the plan.** (1) The tree is a `dockTrees` map keyed by context id, **not** inside the context slice: the plan wanted slice-only to avoid mirroring to the top level, but `setContext` does `state = {...state, ...incoming}`, so every slice key **is** spread to the root on each switch — following the rule literally would have produced the exact thing the rule prevents. (2) **Split view stays a layout flag**, not a tree node: it is a runtime toggle (Calibration declares it on so the camera and the 3D scene sit side by side), so it cannot be compiled into a shipped tree. It goes away for free once a viewport can simply be dragged into a pane. **The parity check paid for itself twice:** it caught the 3D scene vanishing in Calibration (I had gated the pairing on the main pane being a persistent viewport — there the *plugin* claims the viewport, so it is a registry panel), and then, by comparing **rects rather than looking at the screen**, a worse one: a pane wrapper was not a flex container, so a nested split had no flex parent and collapsed to content height — **stage 776×0 in Mapping, scene 0×808 in Calibration**, invisible while the DOM insisted it was there. A visual check would have called that a glitch. Splitters here commit **once on release**, writing flex-basis directly during the drag — deliberately not the existing columns' per-move `layoutStore.set()`. |
| 5.4 | Interaction: tab drag + 5-zone drops, splitters, collapse, close, context menu, Add-Panel, Reset. | ☐ | | Accept: the regression list in §7, each exercised. |
| 5.5 | Guards + docs (`WORKSPACE.md`, `CLAUDE.md`, `SDK.md` note that the manifest is unchanged). | ☐ | | Accept: every guard broken on purpose once. |
| 5.6 | Flip the default on; keep the flag one release. | ☐ | | Accept: user sign-off after a real session. |

**Order is strict.** 5.1 is pure logic and lands first because everything else depends on its shape.
