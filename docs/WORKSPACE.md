# Workspace contexts, layout & high-DPI UI scaling

How the editor is organised into **contexts**, how its panel layout persists, and how the UI scales for
4K/high-DPI. This is **workspace ergonomics** — all of it lives in app **Prefs**
(`userData/artlux-prefs.json`), never in the portable `.artlux` project. Scope note: contexts +
persisted sizes + a reusable resizer, **not** a free-form docking engine — see
[Out of scope](#out-of-scope).

## UI scaling (high-DPI / 4K)

The whole editor chrome scales with **one Electron zoom factor on the main window** —
`webContents.setZoomFactor` — rather than a CSS/rem sweep. One call scales chrome, icons, px tokens, and
arbitrary widths uniformly, with zero token refactor. Owner: [`src/main/uiScale.ts`](../src/main/uiScale.ts).

- **Applied to the main window only.** Projector output windows are separate `BrowserWindow`s
  (`projector.html`), so their physical-pixel warp/blend math is never touched. Only ever call
  `setZoomFactor` on `mainWindow.webContents`.
- **Persisted** to `Prefs.uiScale` (clamped `[0.8, 2.0]`). `setZoomFactor` does **not** survive a reload,
  so it's re-applied on every `webContents` `did-finish-load` (see `createWindow` in
  [`src/main/index.ts`](../src/main/index.ts)).
- **First-run default is auto-detected** (`detectDefaultUiScale`) from the primary display via
  `screen.getPrimaryDisplay()` — physical pixels vs. the OS scale factor, *not* `devicePixelRatio` alone
  (a 4K panel at 100% OS scaling has DPR≈1 but tiny chrome). It's only a first-run default; a saved
  `uiScale` always wins and is never recomputed. Untouched installs adapt to whatever display they launch on.
- **Controls:** the Preferences → **Appearance** section (slider 80–200% + "Reset to detected"), and
  the `Ctrl +/− / 0` window commands — both route through `setUiScale`/`resetUiScale`, so they're one
  persisted source of truth (`WINDOW_COMMAND` in [`src/main/ipc.ts`](../src/main/ipc.ts)).
- **IPC:** `setUiScale(scale)` / `detectUiScale()` on `ArtluxApi` (protocol + preload + ipc).
- **GPU output was already high-DPI correct** (`ProjectorGL.setSize(cssW,cssH,dpr)` allocates physical
  pixels; calibration canvases use DPR). The only render fix here was two react-three-fiber previews that
  were pinned `dpr={1}` → `dpr={[1,2]}` (`Simulator3D.tsx`, calibration `ProjectorScene.tsx`).

## Workspace layout state

Layout lives in a module-singleton pub/sub store (the `cueBus`/`helpBus` idiom):
[`src/renderer/services/layoutStore.ts`](../src/renderer/services/layoutStore.ts).

- **`WorkspaceLayout`** — one serializable object: panel **sizes** (`dockHeight`, `helpWidth`,
  `splitRatio`, `bottomHeight`, `leftWidth`, `rightWidth`), **visibility** (`showLeft/Right/Help`,
  `dockOpen`, `splitView`, `timelineMax`), **selections** (`leftTab`, `dockTab`), and `activePreset`.
- **Persistence:** debounced (~300ms) write of the whole object to **one top-level `Prefs.layoutState`**
  key. It's one object on purpose — `setPrefs` is a one-level shallow merge, so a single top-level field
  is safe to patch (same rule as `modalPositions`; see [SDK.md](SDK.md) → `useDraggable`).
- **Read** with `useLayout()` ([`hooks/useLayout.ts`](../src/renderer/hooks/useLayout.ts)), a
  `useSyncExternalStore` wrapper. **Write** with `layoutStore.set(patch)`.
- **App.tsx integration:** the ~11 former layout `useState`s were replaced by destructuring `useLayout()`
  under the old names plus **setter shims** that preserve the `useState` API (a value *or* an updater fn) —
  so the render tree and every call site are unchanged. Hydrate happens in the boot prefs-load effect
  (`layoutStore.hydrate(prefs.layoutState)`); a one-time migration seeds `splitView`/`splitRatio` from the
  old `localStorage` keys (`artlux.splitView` / `artlux.splitRatio`) then clears them.

## Reusable resizer

[`hooks/useResizable.ts`](../src/renderer/hooks/useResizable.ts) replaces the three copy-pasted drag
handlers. It returns an `onPointerDown` to spread on a handle:

```ts
useResizable({ axis: 'x'|'y', min, max: number|(()=>number), invert?, mode?: 'delta'|'ratio',
               value?, containerRef?, onChange, onCommit? })
```

- `mode:'delta'` (default) adds pointer movement to `value` (px); `invert` grows the panel as the pointer
  moves toward it. `mode:'ratio'` computes a 0–1 fraction from `containerRef`'s box.
- Callers: the split divider (`WorkspaceShell.tsx`, `ratio` + `splitHostRef`), the dock top edge
  (`Dock.tsx`, `invert`, dynamic `max: () => innerHeight-120`), the help left edge (`HelpPanel.tsx`,
  `invert`), the bottom region's top edge, and the **two side columns** (below).

### The two side columns

The browser column and the parameter column are dragged from their inner edges — a 2px handle
overlapping the viewport, the same idiom as the bottom region — and **double-click resets** either to
its default (288 / 320px, the `w-72` / `w-80` they used to be hard-coded to). Both widths ride
`leftWidth` / `rightWidth`, so they are banked **per context** (`CONTEXT_KEYS`) and persisted with
everything else: a wide media browser in Timeline does not force a wide outliner in Mapping.

Two details that are easy to get wrong:

- **The clamp is applied at render, not written back.** `max` is dynamic — `innerWidth − 420 − the
  other column` — because the window is also UI-scaled 80–200%, so a static cap either starves the
  viewport at 100% or wastes half a 4K panel. What it guarantees is ~420px of work area between the
  two columns; they are `shrink-0`, so without it the *viewport* is what collapses. A saved width
  wider than the current window is clamped **for display only** — un-maximizing must not permanently
  shrink a column the operator sized on a big screen. The shell re-renders on `window resize` so the
  clamp actually tracks the window.
- **The collapse transition is dropped during a drag.** `transition-all duration-med` animates the
  show/hide toggle; left on during a resize the column trails the pointer by the whole duration.

## Workspace contexts (replaces the old presets)

A **context** is a whole workbench for one job — Mapping, Projection Outputs, Audio. One is active at
a time and it declares the entire shell around it: which panels fill the browser column, the viewport,
the dock and the parameter column, plus the **functions** on its action bar. The rail down the far left
switches between them.

This replaced the `edit`/`perform`/`calibrate` presets, which only toggled panel *visibility* and could
not change what was *in* the panels. `BUILTIN_PRESETS`/`applyPreset`/`PresetId` are gone; `activePreset`
survives only as a one-time migration input (see below).

- **Contract:** `WorkspaceContext` + `ContextRegistry` in [`@artlux/sdk/renderer`](SDK.md); a context is a
  **manifest of panel ids** and owns no components. Core registers its ten in
  [`src/renderer/contexts/index.tsx`](../src/renderer/contexts/index.tsx) through exactly the same API a
  plugin uses — there is no privileged core path.
- **Shell:** [`components/shell/WorkspaceShell.tsx`](../src/renderer/components/shell/WorkspaceShell.tsx)
  (+ `ContextRail`, `ActionBar`). It resolves panel ids against `panelRegistry` and imports no panel.
- **Soft, never locked.** A context sets the default workbench; opening something off-context is allowed.
- **Extending someone else's context:** `contextRegistry.extend(id, { viewport, browser, dock, inspector, actions })`.
  Lists append; `viewport` **replaces** (a context has one main work area), which is how a plugin claims
  a workbench's principal surface — the audio plugin supplies the mixer for the host-declared `audio`
  context. The host's declared viewport stays as the fallback, so the rail never has a dead entry with
  that plugin disabled. Extends queue if the target hasn't registered yet, so activation order doesn't
  matter.

### The eleven contexts

| Cluster | Context | Viewport | What it is for |
|---|---|---|---|
| **Build** | `timeline` | program monitor + timeline as `bottom` | cutting the show; media library on the left |
| | `mapping` | 2D stage | surfaces **and** fixtures — placement, content, patch, DMX |
| | `3d` | `Simulator3D` | venue layout, models, fixture 3D positions, lighting, tracking overlays |
| **Align** | `project` | outputs table | bind displays, warp, blend, span, gamma; previews in the dock |
| | `calib` | *plugin* — wizard + camera | structured-light / markerless alignment, 3D alongside |
| **Show** | `scenes` | `CueBankPanel` | capture scenes, fire them from the grid; program preview + both clocks on the left |
| | `machine` | `StateGraphEditor` | the show graph over those scenes |
| | `audio` | *plugin* — the mixer | bed, mix, inserts, spatial |
| | `tracking` | 2D stage + 3D | LiDAR / MediaPipe / Augmenta; the same Tracking section in the parameter column, monitors in the dock |
| | `show` | *plugin* — Show Deck | running it: transport, scene pads, schedule, playlist, metrics |
| **App** | `settings` | `Preferences` | machine-level: output protocol, engine, appearance, watchdog, GPU, plugin sections |

Five of these are worth knowing the history of, because the shape was arrived at, not designed up front:

- **`mapping` = the old `map` + `led`.** Surface placement and the DMX patch were separate contexts, but
  you place a surface *in order to* map LEDs onto it, and you check a patch against the surface it
  samples. Both drive the same stage, and `appliesTo` lets the parameter column show surface **and**
  fixture sections at once — so there was nothing left to separate.
- **`machine` was the state-graph modal.** The show graph was a fixed 1000×640 dialog centred over the
  timeline it describes. It is a long-lived authoring surface, so it became a context and got the whole
  window; the timeline's "Edit logic" button and the state lane's edit affordance switch to it.
- **`timeline` replaced `media`.** "Media & Content" was only a media browser beside the stage; that
  library is now the timeline's browser column, so you import media where you actually cut it. Timeline
  leads the Build cluster in its place.
- **`settings` was the Preferences modal**, and it is the only context in its own `app` cluster (a rule
  separates it on the rail, last). Preferences started as a 460px dialog over output protocol + engine
  and grew into appearance, unattended watchdog, GPU probing and every plugin's `SettingsSection` — a
  screen you *read and compare*, not one you acknowledge. It is still the single host for plugin
  settings sections; that did not move. `Ctrl+,`, the TopBar gear and the Context menu all land on it.

  Its sections are a **mosaic**, not a column: each `Section` becomes a card and CSS multi-column packs
  them (`columns: 19rem 5`). The count follows the width the shell actually gave the viewport rather
  than a viewport breakpoint — 4 columns at 1392px, 3 at 1000, 2 at 700, 1 at 420 — because the window
  is also UI-scaled 80–200%. The `5` is a cap: unbounded, a 4K panel gets a dozen header-only columns.
  Each card needs `break-inside-avoid` or the column algorithm chops it in half. Eleven sections now
  fit in roughly one screen (33px of scroll) instead of ~1300px of it.
- **`show` absorbed the tablet remote's feature set.** Schedule and Playlist were reachable *only* from
  the served PWA, so an operator at the machine could arm an unattended venue from a phone but not from
  the app in front of them. See [SHOW-CONTROL.md](SHOW-CONTROL.md) → the desktop Show context.

Three contexts have their viewport supplied by a **plugin** (`calib`, `audio`, `show`) via
`extend({ viewport })`. The host declares the context — rail slot, title, hint, default layout — and the
plugin owns its principal surface. With the plugin disabled the host's declared viewport is the
fallback, so the rail never carries a dead entry.

### Where did it go? (things that moved)

Almost every workbench moved out of a dialog. If you are looking for something that used to be a menu
item or a floating window:

| Looking for | Now |
|---|---|
| Surfaces / Fixtures outliner, the old left panel | **Mapping** — browser column |
| The properties panel (surface + fixture params) | **Mapping** — parameter column, filtered by what is selected |
| Fixture Editor, Routing | **Mapping** — dock tabs |
| Media library, Asset Manager | **Timeline** — browser column. The Asset Manager was deleted; its per-asset inspector (size, dimensions, path, and the resolved **Usage** list) is the bottom section of the library |
| Outputs… (was a modal) | **Proj** — the viewport; live per-output previews in the dock |
| Calibrate | **Proj** ▸ Calibrate on a row → jumps to **Calib** |
| Scenes & Cues | **Cues** |
| "Edit logic" / the state graph (was a 1000×640 dialog) | **Logic** |
| Audio Bed (was a floating window) | **Audio** — the whole workspace |
| OSC / Pose / Augmenta monitors | **Track** — dock tabs |
| Schedule, project Playlist (were tablet-only) | **Show** — dock tabs |
| 3D scene outliner (was a column inside the 3D view) | **3D** — browser + parameter columns |

Still modal, deliberately, because they are global and momentary rather than workbenches: About, the
update notice, the audio-engine warning, and MediaPipe's floor-calibration wizard. Docs and Help remain
right-hand drawers on every context.

**Getting around:** click the rail, press `Ctrl+1..9`, use the **Context** menu, or press `Ctrl+K` for
the command palette — which searches every context *and* every action any context declares, and
switches context for you before running one.

### The full-width bottom region (`WorkspaceContext.bottom`)

A context may name **one** panel that gets the workspace's full width, below everything else — the
browser column and the parameter column both stop above it. This is NOT the dock: the dock lives
*inside* the centre column and is flanked by those two.

`timeline` is the reason it exists. An editing timeline wants the NLE shape — program monitor on top,
lanes across the full width underneath — and lanes squeezed between a browser and an inspector are
simply too narrow to cut in. Height is dragged from its top edge and remembered per context
(`ContextLayout.bottomHeight`).

⚠ A **persistent viewport** named as `bottom` is rendered there and **nowhere else** — the shell filters
it out of the left pane. A React element exists at exactly one position, and mounting `TimelinePanel`
twice would double its keyboard hook and engine subscription, which is the one thing that must never
happen. Moving between positions remounts it, exactly as the old dock-tab timeline did on every tab
change.

### Live previews

Two panels in `contexts/panels/preview.tsx`, both of which only **blit** machinery that already runs
each frame — neither adds a decode or a composite:

- **Program Preview** — the whole timeline composited. It must `retainProgram()` while mounted (the
  engine only builds that canvas while something wants it) and `releaseProgram()` on unmount. Two
  flavours: a padded inspector/dock card, and `ProgramMonitorViewport`, the full-bleed monitor the
  `timeline` context puts above its lanes. Measured cost of keeping it open: **none** (60 fps with it
  on vs 61 without) — it only blits a composite the engine already builds.
- **Output Preview** — one live tile per enabled projector output. This is the **multi-screen** view:
  a surface spanned across several projectors becomes one slice surface per output, so the tiles show
  what each machine is putting on its screen, side by side. Warp/soft-edge/gamma are applied in the
  projector window's own GL pass and are deliberately *not* reproduced — the tile answers "is the right
  content on the right screen", and badges carry the rest (display, warp, blend, calib, ndi).

Both draw on their own rAF loop capped at 20 Hz and never touch React state per frame.

### What lives where

Modals are now only for things that are **global and momentary**: About, the update notice, the
audio-engine warning, and the MediaPipe floor-calibration wizard. Everything that is a *workbench*
became a panel on a context:

| Was a modal | Now |
|---|---|
| `OutputsPanel` | the `project` context's **viewport** |
| `RoutingModal` | a `mapping` **dock tab** |
| `Preferences` | the `settings` context's **viewport** |
| `AssetManager` | **deleted** — its selected-asset inspector (size / duration / dimensions / path / missing-on-disk + the resolved **Usage** list) was folded into the Media Library, which already covered import / relink / reveal / remove; consolidate is an action-bar item |
| `ScenePanel3D` (a floating column in the 3D pane) | the `3d` context's **browser + parameter** panels |
| `StateGraphEditor` (a 1000×640 centred dialog) | the `machine` context's **viewport** |
| `OscMonitor` · `PosePanel` · `AugmentaMonitor` | **dock tabs** appended to `tracking` by their plugins |
| `ShowControlPanel` | a **dock tab** appended to `show` by its plugin |
| `AudioBedPanel` (an 880×70vh floating window) | the `audio` context's **viewport**, claimed by its plugin via `extend({ viewport })` |
| `CalibWizard` / `AutoAlignWizard` (App-mounted, camera portaled over the Stage) | the `calib` context's **viewport**, claimed by its plugin — closes ROADMAP Stage 2b |

A menu action still reaches any of them: `dispatchMenu` resolves the action to whichever panel
declares it and either toggles it (modal) or switches to the owning context and selects its tab
(dock). Nothing had to change in the menus when a panel moved.

### Two constraints the shell must respect

1. **`Stage` must never unmount** — it owns the per-frame GPU sampling that publishes `dmx:frame`, so
   unmounting it stops Art-Net mid-show.
2. **Exactly one `TimelinePanel`** — two instances double its keyboard hook and engine subscription.

Both are handled the same way: App mounts these as **persistent viewport elements** and passes them to
the shell, which places each one at a **fixed position** in its tree and only changes CSS width/visibility.
A React element can exist at one position only, so viewports never "move" between panes — `scene3d` is
permanently the RIGHT pane, everything else the LEFT pane, and contexts only change the two widths. Split
view, a maximized 3D context and a plain 2D context are the same tree at different widths.
The 3D canvas takes `paused` (→ r3f `frameloop='never'`) while hidden: it stays mounted, but a hidden
canvas must not keep a render loop running on a zero-width pane.

### Per-context ergonomics

Each context remembers its own sizes in `WorkspaceLayout.contexts[id]` (`ContextLayout`: dock height,
split ratio, panel visibility, and `dockPanel` — the active dock tab as a **panel id**, since the core
`DockTab` enum cannot name a plugin's dock panel). `layoutStore.setContext(id, defaults)` banks the
outgoing context's ergonomics and restores the incoming one's, falling back to the context's declared
`layout` the first time it is entered. At boot, `hydrate()` restores the raw top-level fields — which are
whatever the last context left behind — so App follows it with `layoutStore.enterActiveContext(...)` to
put the active context's own sizes back on (`setContext` can't: it early-returns when the id is already
active, which at boot it always is).

A banked slice always wins over the declared `layout` — otherwise leaving a context would undo the
operator's arrangement. That also means **a layout change we ship would never reach anyone who has
already opened that context**, so `WorkspaceContext.layoutRev` is the escape hatch: the host stamps the
rev into the banked slice and re-applies `layout` exactly once when the two differ
(`resolveContextLayout` in layoutStore.ts). Bump it whenever a context's default layout changes
meaningfully. Core contexts currently ship `layoutRev` 1–3 (bumped as their layouts were revised
during the migration).

**Migration:** an install with no saved `activeContext` maps its last preset once — `edit→mapping`,
`perform→show`, `calibrate→calib`, anything else (incl. `'custom'`) → the `mapping` default. A saved id
that no longer resolves is remapped by `RETIRED_CONTEXTS` (`map`/`led`→`mapping`, `media`→`timeline`);
without that the rail would open with nothing selected.

## How to…

- **Add a persisted layout field:** add it to `WorkspaceLayout` + `DEFAULT_LAYOUT`, read via `useLayout()`,
  write via `layoutStore.set()`. It rides the existing `Prefs.layoutState` blob — no new Prefs key.
- **Switch context from code:** `goToContext(id)` from [`contexts/nav.ts`](../src/renderer/contexts/nav.ts).
  Never call `layoutStore.setContext` directly — the context's `layout` has to travel with its
  `layoutRev` or a shipped layout change silently never reaches an operator who already opened it.
- **Add a context:** `contextRegistry.register({...})` — from `contexts/index.tsx` for core, or from a
  plugin's renderer `activate(ctx)` via `ctx.contexts`. Nothing else to wire; the rail is registry-driven.
- **Add a panel to a context:** `panelRegistry.register({ id, mount, ... })`, then name its id in the
  context's `browser`/`dock`/`inspector` array (or `extend` a context you don't own). `mount` is
  `'modal' | 'browser' | 'inspector' | 'dock' | 'viewport'`; an `'inspector'` panel should declare
  `appliesTo` so the shell shows it only while something of that kind is selected.
- **Make a menu action reach a panel:** give the panel a `menuAction`. `dispatchMenu` resolves the action
  to whichever panel declares it and does the right thing per mount — toggle (modal), open the dock tab,
  or switch to the context whose viewport it is. Nothing to add per panel.
- **Expose a new function on a context:** add a `ContextAction`. It appears on the action bar **and** in
  the `Ctrl+K` palette automatically — the context declaration is the command index, so nothing is
  registered twice.
- **Let a plugin own a workbench's main surface:** register a `mount:'viewport'` panel and
  `ctx.contexts.extend('<id>', { viewport: '<panel id>' })`. Keep the host's declared viewport as a
  sane fallback so the rail entry still works with the plugin disabled (`calib`, `audio`, `show` all do
  this).
- **Panels read state, not props:** `useEditor()` / `useEditorActions()` from
  [`state/EditorStore.tsx`](../src/renderer/state/EditorStore.tsx). App remains the sole owner of state
  and of every mutation — the store only distributes it. Action identities are permanent (a facade
  forwards to App's latest handler at call time), so a panel that only dispatches never re-renders.
- **Persist any other workspace state** (not project content): add a top-level `Prefs` field in
  `shared/protocol.ts` and read/write via `getPrefs`/`setPrefs` — keep nested state in one object so the
  shallow merge is safe.

## Regression guards

These rules are load-bearing and invisible: break one and the code still compiles, the app still boots,
nothing throws, and the failure surfaces as *"I can't select my fixtures"* or *"the output stopped"* —
usually on someone's rig, hours later. So they are asserted mechanically.

```bash
npm run verify          # invariant guards + typecheck — the normal loop
npm run verify:invariants   # just the guards (reads source, instant)
```

`scripts/verify-invariants.cjs` — nine checks, each carrying the bug it came from and printing **why**
it matters when it fires:

| Guard | The bug it prevents |
|---|---|
| `InstancedMesh` writes recompute `boundingSphere` | THREE caches it from the first raycast; `instanceMatrix.needsUpdate` does not invalidate it, so the pickable region freezes and later layout changes make objects silently unclickable |
| 3D backdrop objects yield picks to fixtures | screens are nearer the camera than the fixtures on them; an unguarded `stopPropagation()` stole 648 of 649 clicks |
| fixtures have a pickable body | the only target was a 12mm LED sphere |
| fixture/model selection is symmetric | the gizmo is gated on `!selectedModelId`, so a fixture click landed with no visible effect |
| context switches go through `goToContext()` | a direct `setContext` drops `layoutRev`, and a shipped layout never reaches an operator |
| the `scene3d` viewport id is declared once | a drifted copy mounts `Simulator3D` in both panes |
| one `<Simulator3D>` mount site | two WebGL contexts, visible only as halved frame rate |
| `Stage` / `TimelinePanel` mounted once | `Stage` publishes `dmx:frame`; two timelines double its keyboard hook and engine subscription |
| `EditorData` is memoized | rebuilt per render it re-renders every panel and closes native `<select>` popups |

Two things learned writing them, worth keeping if you add more:

- **Read code, not prose.** This repo comments densely and the comments name the very things being
  asserted. Matching raw text reports mounts that do not exist *and* lets a stale comment satisfy a
  check whose call was deleted. `stripComments()` exists for that.
- **Assert the call, not the identifier.** The first version passed while the guard was deleted, because
  a leftover `import { ledUnderPointer }` still matched. Check for `name(`.

**Verify the guard itself fails.** Break the invariant on purpose, confirm the check fires, then restore.
A guard that cannot fail is worse than none — it reads as coverage.

## Out of scope

Full free-form docking (drag-to-rearrange, split trees, tabbed groups) and tear-off panel windows were
**deliberately not built** — high cost/maintenance and a poor fit for the per-frame GPU repaint loop +
reparenting the WebGPU/WebGL panels. See [ROADMAP.md](ROADMAP.md). If tear-off is ever wanted, the
projector subsystem (`src/main/projector.ts` + the preload MessagePort forwarding) is the proven recipe:
a keyed `BrowserWindow` map + a new `*.html` entry + a typed bridge.
