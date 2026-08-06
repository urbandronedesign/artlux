# Workspace contexts, layout & high-DPI UI scaling

How the editor is organised into **contexts**, how its panel layout persists, and how the UI scales for
4K/high-DPI. This is **workspace ergonomics** — all of it lives in app **Prefs**
(`userData/artlux-prefs.json`), never in the portable `.artlux` project.

> **Read [the dockable workspace](#the-dockable-workspace-the-default-shell) first — it is what
> actually renders.** Since v0.25.0 the workspace is **dockable by default**: a context's flat
> manifest is *compiled* into a per-context split/tab tree the operator can rearrange. The
> hand-built browser/viewport/dock/parameters shell described in the middle of this document is
> still in the tree and still correct, but it is now the **fallback path**, reached only by turning
> *Preferences › Appearance › Dockable workspace* off. Where the two disagree about what an
> operator sees, the dock tree wins.

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

<!-- audience:contributor -->

## Workspace layout state

Layout lives in a module-singleton pub/sub store (the `cueBus`/`helpBus` idiom):
[`src/renderer/services/layoutStore.ts`](../src/renderer/services/layoutStore.ts).

- **`WorkspaceLayout`** — one serializable object: panel **sizes** (`dockHeight`, `helpWidth`,
  `splitRatio`, `bottomHeight`, `leftWidth`, `rightWidth`), **visibility** (`showLeft/Right/Help`,
  `dockOpen`, `splitView`, `bottomOpen`, `timelineMax`), **selections** (`leftTab`, `dockTab`),
  `activePreset`, plus the two docking fields: **`dockTrees`** (one arrangement per context id) and
  **`dockingOff`** (the operator opted out of docking — *absence means on*, see
  [the flip](#two-ways-back-and-why-the-key-is-named-dockingoff)).
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
  (`Dock.tsx`, `invert`, dynamic `max: () => innerHeight-120`), the bottom drawer's top edge, and
  the **two side columns** (below).

### The two side columns

> **Fallback-shell detail.** With docking on — the default — the browser and parameter columns are
> panes of the dock tree and are sized by *its* splitters, which commit **once on release** rather
> than calling `layoutStore.set()` per pointer move. Everything below describes the columns as the
> hand-built shell draws them; the clamp reasoning still applies to both.

The browser column and the parameter column are dragged from their inner edges — a 2px handle
overlapping the viewport, the same idiom as the bottom drawer — and **double-click resets** either to
its default (288 / 320px, the `w-72` / `w-80` they used to be hard-coded to). Both widths ride
`leftWidth` / `rightWidth`, so they are banked **per context** (`CONTEXT_KEYS`) and persisted with
everything else: a wide mixer column in Audio does not force a wide outliner in Mapping.

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
  **manifest of panel ids** and owns no components. Core registers its nine in
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

### The nine contexts

| Cluster | Context | Viewport | What it is for |
|---|---|---|---|
| **Build** | `mapping` | 2D stage | surfaces **and** fixtures — placement, content, patch, DMX; media library + program monitor in the dock |
| | `3d` | `Simulator3D` | venue layout, models, the rig, lighting, tracking overlays; **both take recorders** live in its dock (Lighting Takes / Tracking Takes) and on its action bar |
| **Align** | `project` | outputs table | bind displays, warp, blend, span, gamma; previews in the dock |
| | `calib` | *plugin* — wizard + camera | structured-light / markerless alignment, 3D alongside. **Registered only under the calibration launch profile** — see below |
| **Show** | `scenes` | `CueBankPanel` | capture scenes, fire them from the grid; program preview + both clocks on the left |
| | `machine` | `StateGraphEditor` | the show graph over those scenes |
| | `audio` | *plugin* — the mixer | bed, mix, inserts, spatial |
| | `show` | *plugin* — Show Deck | running it: transport, scene pads, schedule, playlist, metrics |
| **App** | `settings` | `Preferences` | machine-level: output protocol, engine, appearance, watchdog, GPU, plugin sections |

**The timeline is not on this list, deliberately** — it is a *drawer* every one of these except `calib`
and `settings` can pull up (`Ctrl+T`). See [the bottom drawer](#the-full-width-bottom-drawer-workspacecontextbottom).

Seven of these are worth knowing the history of, because the shape was arrived at, not designed up front:

- **`mapping` = the old `map` + `led`.** Surface placement and the DMX patch were separate contexts, but
  you place a surface *in order to* map LEDs onto it, and you check a patch against the surface it
  samples. Both drive the same stage, and `appliesTo` lets the parameter column show surface **and**
  fixture sections at once — so there was nothing left to separate.
- **`machine` was the state-graph modal.** The show graph was a fixed 1000×640 dialog centred over the
  timeline it describes. It is a long-lived authoring surface, so it became a context and got the whole
  window; the timeline's "Edit logic" button and the state lane's edit affordance switch to it.
- **`timeline` was dissolved** (2026-07-26), having itself replaced `media` ("Media & Content" was only a
  media browser beside the stage). It led the Build cluster in the NLE shape: a program monitor on top,
  lanes across the full width underneath. What killed it is that **the timeline is a tool, not a place**
  — you want it while cutting against the 2D stage, while placing a recorded take on a lane with the rig
  in front of you, while authoring a scene's timeline from the cue grid — and reaching it cost you the
  viewport you were working in. That is also why a 12th `light` context looked necessary for the
  light-show workflow: a rail entry was the only way to get the 3D scene and the timeline on screen
  together. (This argument once cited *recording* a lighting take. It no longer does: capture is
  transport-independent, so it left the drawer entirely — see the takes panels below.)

  So the timeline became every context's **bottom drawer**, and this context had nothing left of its own:
  its program monitor is the `core.dock.programPreview` tab (the same full-bleed `ProgramMonitorViewport`
  component — a dock tab is the same shape as a viewport), its media library is the new `core.dock.media`
  tab, and both moved to **Mapping** along with Collect Assets / Collect a Copy. One rail entry and one
  remount-per-visit were lost; nothing else.
- **`tracking` merged into `3d`** (2026-07-26). It had become a near-duplicate: no browser column, one
  parameter section (`core.inspector.scene.tracking`) that `3d` already declared, and a default layout of
  `splitView: true` whose entire purpose was to get the 3D scene on screen beside the stage — because the
  3D scene is where live blobs are drawn. Being *in* the 3D scene is the better version of that. Its
  three plugins contributed only **dock tabs**, and `3d` had no dock at all, so the region was free; they
  now `extend('3d', …)`. `3d` was retitled **Venue & Rig** and is where a light show is prepped: pick
  heads, aim them, record a take against the rig you can see — from the **Lighting Takes** dock beside
  the viewport, not from a drawer.
- **The Takes bin left the timeline** (2026-08-06). Both recorders — lighting and LiDAR — used to live in
  a 40px strip under the timeline toolbar, so capturing a moving head meant pulling up a drawer full of a
  clock you were not using. Both capture INDEPENDENTLY OF THE TRANSPORT, which is the tell: the drawer was
  never the reason they lived there, the commit logic was (`Timeline.tsx` owned the naming, the disk
  write and the doc-key guard, so the button had to be inside it). That moved to
  `services/takeRecorder`, and the controls became **two dock panels** — `core.dock.lightingTakes` (in
  `3d` and `scenes`) and `core.dock.trackingTakes` (in `3d` and `show`) — plus two action-bar buttons
  carrying live REC, a status-bar REC light that stops everything, and **Ctrl+Shift+R** / **Ctrl+Alt+R**,
  which arm from *every* workspace including Calibration and Preferences (which have no drawer at all).
  Two panels and not one because the recorders are different instruments: a lighting take is scoped to
  the SELECTED fixtures and their order is the show, a tracking take has no target at all. Placement did
  not move — you still drag a take onto a lane, and the dock sits directly above the drawer.
- **`settings` was the Preferences modal**, and it is the only context in its own `app` cluster (a rule
  separates it on the rail, last). Preferences started as a 460px dialog over output protocol + engine
  and grew into appearance, unattended watchdog, GPU probing and every plugin's `SettingsSection` — a
  screen you *read and compare*, not one you acknowledge. It is still the single host for plugin
  settings sections; that did not move. `Ctrl+,` and the Context menu both land on it.

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
plugin owns its principal surface.

⚠ **`calib` is not registered at all in a plain editor launch**, and the fallback viewport is the reason
it cannot simply be left on the rail. `plugins/calibration` activates only under the calibration
**launch profile** (`--calibrate`, and implicitly in broadcast/headless — see `src/main/runProfile.ts`),
because a calibrated output renders the venue a second time over the projector's canvas: measured on the
same project, a projector window carries three canvases with the profile and one without. Registering
the context anyway would put a **Calibration** entry on the rail whose workbench falls back to the 2D
stage — an operator clicks it, gets no wizard and no camera, and nothing says why. A rail entry that
cannot do its job is worse than an absent one, so `registerCoreWorkspace()` gates the registration on
the same flag the plugin host uses. `File ▸ Open Calibration Workbench…` saves and relaunches into the
other profile; `verify:invariants` asserts every window main builds carries the profile on its URL,
because an editor whose projector windows disagreed would put the second scene straight back.

### Where did it go? (things that moved)

Almost every workbench moved out of a dialog. If you are looking for something that used to be a menu
item or a floating window:

| Looking for | Now |
|---|---|
| Surfaces / Fixtures outliner, the old left panel | **Mapping** — browser column |
| The properties panel (surface + fixture params) | **Mapping** — parameter column, filtered by what is selected |
| Fixture Editor | **split by what is unique to it** (2026-07-27, `mapping` `layoutRev` 5). `core.dock.fixtureEditor` is **retired**; five of its seven cards were a second rendering of the kind-gated inspector. What survived is two dock tabs — **Library** (`core.dock.fixtureLibrary`: create, templates, groups) and **Wiring & Ledmap** (`core.dock.fixtureWiring`: the physical-index preview + the ledmap, `appliesTo: ['fixture.pixel']`). Everything else is the parameter column |
| Routing | **Mapping** — dock tab |
| The timeline (was its own rail entry) | **the bottom drawer** — `Ctrl+T`, View ▸ Timeline, or click the collapsed strip. Available in every context except Calib and Prefs |
| Recording a **lighting take** (was the Takes bin in the timeline drawer) | **3D** / **Cues** — the `Lighting Takes` dock tab. Also *Record Lighting Take* on the 3D action bar (with a live REC clock), the status-bar REC light, or **`Ctrl+Shift+R`** from anywhere |
| Recording a **tracking take** (was the same bin) | **3D** / **Show** — the `Tracking Takes` dock tab. Also *Record Tracking Take* on the 3D action bar, or **`Ctrl+Alt+R`** from anywhere |
| The take **libraries** (were chips in the bin) | the same two dock tabs — now with rename, duration, the roles a lighting take carries, and a blob-density signature on a tracking take. Still the drag source for a lane |
| Media library, Asset Manager | **Mapping** — dock tab (`Media Library`); also **Audio** — browser column. The Asset Manager was deleted; its per-asset inspector (size, dimensions, path, and the resolved **Usage** list) is the bottom section of the library |
| The program monitor (was the Timeline context's viewport) | **Mapping** / **Proj** / **Show** — the `Program` dock tab, same full-bleed component |
| Outputs… (was a modal) | **Proj** — the viewport; live per-output previews in the dock |
| Calibrate | **Proj** ▸ Calibrate on a row → jumps to **Calib** |
| Scenes & Cues | **Cues** |
| "Edit logic" / the state graph (was a 1000×640 dialog) | **Logic** |
| Audio Bed (was a floating window) | **Audio** — the whole workspace |
| OSC / Pose / Augmenta monitors, Trigger Zones (were **Track**) | **3D** — dock tabs. The `tracking` context merged into `3d` |
| Schedule, project Playlist (were tablet-only) | **Show** — dock tabs |
| 3D scene outliner (was a column inside the 3D view) | **3D** — browser + parameter columns |

Still modal, deliberately, because they are global and momentary rather than workbenches: About, the
update notice, the audio-engine warning, and MediaPipe's floor-calibration wizard. Docs and Help remain
right-hand drawers on every context.

**Getting around:** click the rail, press `Ctrl+1..9` (nine contexts, so every one has a number now),
use the **Context** menu, or press `Ctrl+K` for the command palette — which searches every context *and* every action any context declares, and
switches context for you before running one.

### The full-width bottom drawer (`WorkspaceContext.bottom`)

A context may name **one** panel that gets the workspace's full width, below everything else — the
browser column and the parameter column both stop above it. This is NOT the dock: the dock lives
*inside* the centre column and is flanked by those two.

The timeline is the reason it exists. An editing timeline wants the NLE shape — lanes across the full
width, the picture above them — and lanes squeezed between a browser and an inspector are simply too
narrow to cut in.

**It is a drawer, not a fixed region.** Eight of the nine contexts name `VIEWPORT_TIMELINE` here (all but
`calib`, a full-window wizard, and `settings`). The shell renders it collapsed to a **28px title strip**
and opens it on `WorkspaceLayout.bottomOpen`, which is banked per context — so Mapping remembers that you
were cutting in it while Venue & Rig stays closed. Height is dragged from its top edge, also per context
(`ContextLayout.bottomHeight`, default 340).

Three ways in: click the strip, `Ctrl+T` (`global.toggleBottom`, rebindable), or **View ▸ Timeline** in
either menu. From code, `revealBottom()` in [`contexts/nav.ts`](../src/renderer/contexts/nav.ts) — which
is what the Show Machine's *Timeline* action and a scene card's *Edit Timeline* call. Both used to be
`goToContext('timeline')`, i.e. they took away the graph or the cue grid you were working in.

⚠ A **persistent viewport** named as `bottom` is rendered there and **nowhere else** — the shell filters
it out of the left pane. A React element exists at exactly one position, and mounting `TimelinePanel`
twice would double its keyboard hook and engine subscription, which is the one thing that must never
happen.

That constraint is *why* the drawer only ever changes height rather than being conditionally rendered:
with eight contexts naming the same id, the element keeps the same parent across a context switch and
**never remounts**. When the timeline was a context it physically moved between the left pane's hidden
slot and this region on every entry and exit, throwing away the operator's zoom, scroll and clip
selection each time. Collapsed, the content sits at zero height, still mounted — verified safe because
nothing under `components/timeline/` measures its own size at mount (every `getBoundingClientRect` /
`clientWidth` read is inside a pointer handler or `onZoomFit`).

One thing the operator has to arbitrate: **Mapping defaults to `dockOpen: true`**, so opening the drawer
there on a short window leaves the 2D stage thin. Both regions collapse and both are remembered per
context, which is exactly what banking is for — collapse one once and Mapping keeps it that way.

### `companion` — the other pane, for a 3D context

The shell pins the 3D scene to the **right** pane permanently (one WebGL context, never remounted), and
the left pane shows the active context's own viewport. For a context whose viewport *is* the 3D scene
that leaves nothing for the left pane, so `splitView` used to produce an empty half — a real dead state.
Such a context names a **`companion`** viewport instead: `3d` declares `VIEWPORT_STAGE_2D`, which restores
the stage-beside-3D arrangement the retired `tracking` context provided, now as a toggle rather than a
rail entry. Contexts without a `companion` are unaffected.

### Live previews

Two panels in `contexts/panels/preview.tsx`, both of which only **blit** machinery that already runs
each frame — neither adds a decode or a composite:

- **Program Preview** — the whole timeline composited. It must `retainProgram()` while mounted (the
  engine only builds that canvas while something wants it) and `releaseProgram()` on unmount. Two
  flavours: `ProgramPreviewPanel`, a padded card for the narrow browser/inspector columns, and
  `ProgramMonitorViewport`, the full-bleed monitor — which is the `Program` **dock tab**, and was the
  retired `timeline` context's viewport (a dock tab is the same shape, so nothing was lost). Measured cost of keeping it open: **none** (60 fps with it
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

### The constraint the shell must respect

**Exactly one `TimelinePanel`** — two instances double its keyboard hook and its engine subscription.

> ⚠ **This list used to start with "`Stage` must never unmount", and that rule is gone.** It was true for
> a real reason: the frame loop lived in a `Stage` effect and bailed out if its container or canvas ref
> was empty, so unmounting the component stopped Art-Net mid-show. The loop now lives in
> `engine/frameEngine.ts`, starts itself when its module loads, and reads no DOM at all — the Stage lends
> it a canvas to draw the preview into and nothing more. Deleting the Stage's canvas *and* container out
> of a running app leaves output at 61 Hz, unbothered. Everything below about fixed tree positions is
> therefore now about **preserving viewport state** (zoom, scroll, selection) and about the timeline's
> single-instance rule — not about keeping the show alive. **This is what made free-form docking
> tractable**, and it is why the out-of-scope note below now describes something that shipped: see
> [plans/engine-decoupling.md](../plans/engine-decoupling.md).

`Stage` and `TimelinePanel` are mounted by App as **persistent viewport elements** and passed to
the shell, which places each one at a **fixed position** in its tree and only changes CSS width/visibility.
A React element can exist at one position only, so viewports never "move" between panes — in the
fallback shell `scene3d` is permanently the RIGHT pane, everything else the LEFT pane, and contexts
only change the two widths. Split view, a maximized 3D context and a plain 2D context are the same
tree at different widths.
The 3D canvas takes `paused` (→ r3f `frameloop='never'`) while hidden: it stays mounted, but a hidden
canvas must not keep a render loop running on a zero-width pane.

**Under docking the rule is the same but the mechanism differs**: the tree renders `<ViewportSlot>`
placeholders anywhere, and `PersistentLayer` positions the one real element over whichever slot
wins. Still one element at one tree position; only its coordinates change. That is why a viewport
*appears* to be draggable into any pane without ever being reparented.

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

⚠ `setContext` spreads only the keys a context **declares** over the live layout, so any banked key it
omits silently keeps the *outgoing* context's value. That is how `bottomOpen` first shipped wrong: open
the drawer in Mapping and it appeared pre-opened the first time you entered Venue & Rig — a per-context
setting quietly behaving as a global one. Every context therefore declares all of `showLeft`,
`showRight`, `dockOpen`, `splitView`, `bottomOpen`, and `verify:invariants` checks that it does.

**Migration:** an install with no saved `activeContext` maps its last preset once — `edit→mapping`,
`perform→show`, `calibrate→calib`, anything else (incl. `'custom'`) → the `mapping` default. A saved id
that no longer resolves is remapped by `RETIRED_CONTEXTS` (`map`/`led`/`media`/`timeline`→`mapping`,
`tracking`→`3d`); without that the rail would open with nothing selected. The lookup is **one hop, not
transitive** — which is why dissolving `timeline` also meant repointing `media` at `mapping` rather than
leaving it aimed at an id that no longer exists. Orphaned `contexts[id]` slices are never pruned and are
harmless.

<!-- audience:operator -->

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

## The dockable workspace (the default shell)

**This is what the app renders.** Inside any context the operator can drag a panel by its tab into another group, drop it on an edge to split, reorder, collapse, close, add any registered panel, and reset the workbench to what the context ships. Per context, persisted, surviving a restart. Plan and tracker: [plans/dockable-workspace.md](../plans/dockable-workspace.md).

**It costs the SDK nothing.** The arrangement is a tree *compiled from the flat manifest a context already declares* (`browser[]` / `dock[]` / `inspector[]` / `viewport`), so contexts and plugins keep declaring exactly what they declare today. The **absence** of a saved tree is the migration trigger, and the first build inherits the operator’s banked column widths, dock height and dock tab — an upgrading install sees nothing move.

`WorkspaceShell` picks its renderer from one line:

```ts
const docking = !layout.dockingOff && !DOCKING_FORCED_OFF && PERSISTENT_LAYER_ENABLED;
```

…and then `ensureTree(layout.dockTrees?.[context.id], context, banked)` is **the single door**: it
sanitizes whatever was saved, and compiles the shipped arrangement when there is nothing to sanitize.
No component reads `layout.dockTrees[...]` raw — that is guarded.

### Two ways back, and why the key is named `dockingOff`

Both paths ship for one release, so a regression found in a venue is one toggle away from the shell
that was there before:

| Way back | Where | For |
|---|---|---|
| **Preferences › Appearance › Dockable workspace** | `layout.dockingOff` | the operator, at the machine, mid-show |
| `localStorage['artlux.docking'] = '0'` | read **once at module load** | one machine, without touching a project or a preference |

The flip to on-by-default was a **rename, not a value change**, and the reason is the same failure
mode `layoutRev` exists for. It shipped as `docking?: boolean` defaulting to `false`, so every
install that saved a layout while it was opt-in has `docking: false` sitting in its prefs — flipping
that default would have reached **nobody who had already used the app**. With the key named
`dockingOff`, *absence* means the new default, so the flip lands everywhere and only a deliberate
opt-out persists. If you ever flip a persisted boolean's default, do this instead of changing the
fallback.

Note the toggle is a **preference, not a view option**: the two paths are different renderers, so
switching remounts the panels. Output is unaffected either way — the frame loop has not lived in the
UI since Phase 1, which is the whole reason this feature could be built at all.

### Where the tree is stored, and why not in the context slice

`WorkspaceLayout.dockTrees` is a **map keyed by context id**, at the top level — *not* inside
`ContextLayout`. The plan said slice-only, to avoid mirroring a key to the root; following that
literally would have produced exactly what the rule prevents, because `setContext` does
`state = { ...state, ...incoming }` and therefore spreads **every** slice key onto the top level on
each switch. A map keyed by context id is never spread by `setContext`, never banked by
`CONTEXT_KEYS`, and is still one tree per workbench.

| Piece | Where | What it is |
|---|---|---|
| The model, ops and compiler | `services/dockTree.ts` | Pure logic. Imports **nothing**, which is what lets `npm run test:docktree` check 44 behavioural rules in about a second with no app running. |
| The renderer | `components/shell/DockRenderer.tsx` | Walks the tree. Knows nothing about “browser columns” — only that a `stack` group stacks and a `tabs` group tabs. |
| The drag | `components/shell/DockDrag.tsx` | Pointer events with 5-zone drops. **Never HTML5 DnD** — that channel carries `application/artlux-asset`, and a stray file drop navigates the window. |
| The persistent viewports | `components/shell/PersistentLayer.tsx` | The tree renders empty slots; the real elements are positioned over the winning slot by direct style writes. |

### The model, and the rules its ops enforce

```ts
const DOCK_TREE_VERSION = 1;
type DockSize = { px: number } | { fr: number };
interface DockGroupNode { kind:'group'; id:string; render:'stack'|'tabs'; panelIds:string[];
  activeId?:string; collapsed?:boolean; region?:'browser'|'dock'|'inspector'|'viewport'; }
interface DockSplitNode { kind:'split'; id:string; dir:'row'|'col'; children:DockNode[]; sizes:DockSize[]; }
interface DockTree { v:number; root:DockNode; removed:string[]; meta:{ viewport:string; companion?:string }; }
```

Each rule is earned, and every one of them is a way a naive tree renderer breaks something the shell
already did:

- **`render:'stack'` vs `'tabs'`.** The browser and inspector columns stack `CollapsibleSection`s with
  all of them visible; the dock is tabbed. Without the distinction there is no default-tree parity,
  and the inspector's `appliesTo` co-display — a surface *and* a fixture contributing sections at
  once — breaks.
- **A panel id appears at most once per tree.** Duplicates double window-level keyboard listeners.
- **Unknown panel ids are kept and skipped at render, never dropped.** Disabling a plugin must not
  erase its panel's placement for ever; re-enabling restores it. Same precedent as orphaned context
  slices, which are also never pruned.
- **`removed[]` is honoured on merge**, so a panel the operator closed does not come back next launch.
- **`normalize()` ends every op**: dedupe, drop empty groups, hoist single-child splits, merge
  same-direction splits, repair `sizes`/`activeId`, cap depth ≤ 8 and nodes ≤ 64. That same-direction
  merge is what stops every drag from nesting the tree forever.
- **`sanitizeDockTree` is idempotent**; a version mismatch or garbage returns `null`, which re-derives
  from the manifest rather than rendering something half-trusted.
- **`mergePluginPanels`** inserts panels registered *after* a tree was banked into the group tagged
  with their region — creating that region's group if the context never declared one — and swaps
  `meta.viewport` when a plugin claims a context's viewport via `contextRegistry.extend()`.
- **Reset** goes through `defaultTreeOf`, never a hand-written tree.
- **`mount:'modal'` panels are structurally not dockable.** They render outside `<EditorStore>`, so a
  `useEditor()` inside one would throw the instant it was docked; the Add-Panel menu does not offer
  them.

Because `dockTree.ts` imports nothing — no React, no DOM, no registries, not even the SDK —
`npm run test:docktree` checks 44 behavioural rules in about a second with no Electron and no app.

### Why the viewports are positioned, not moved

A React element exists at exactly one position, and `Simulator3D` (one WebGL context) and `TimelinePanel` (one keyboard hook, one engine subscription) must never be mounted twice nor unmounted. So the tree renders `<ViewportSlot>` placeholders, a registry says which slot currently wins for each id, and `PersistentLayer` draws the one real element over it. Nothing remounts; only coordinates change. `createPortal` was rejected: it physically moves the node on every layout change, which loses a canvas’s contents and can drop a WebGL context outright.

The follow loop **writes styles, never state** — following a rect is per-frame work, and doing it in React would re-render the shell at pointer rate. Measured: it adds **0 ms/s** on top of the splitter’s own cost. It is *armed*, not always-on: it wakes on a structural change, a ResizeObserver hit, a pointer drag or a transition, and stops once the rects settle.

### Three layout traps, each of which shipped once

All three were reported by the operator within minutes of real use, and all three were invisible to automated checks that only ever ran at two window heights. Each is now guarded.

1. **A fixed pane must be able to shrink.** `flex: 0 0 280px` reads like a width; in a short window it means “280 whatever happens”, and the excess paints *outside* the workspace — over the timeline drawer, leaving the lower half of the window black. Panes shrink now, and a px basis is capped at 45% of its split so it cannot starve its neighbour.
2. **`fr` factors must sum to at least 1.** Flexbox distributes only that fraction of the free space and leaves the rest empty — a viewport at `fr: 0.43` beside a fixed dock left a black band across the middle of an ordinary window. `fr` is normalized by its split’s own total.
3. **The panes’ flex is asserted imperatively after every render.** The splitter drags by writing pixels straight onto the elements; React writes a style property only when its own *props* change, and an fr pane computes to the same style before and after a drag — so the drag’s pixels stayed pinned and every pane ended up with grow 0. A `useLayoutEffect` with no dependency array reasserts what the tree says. This cannot be declarative: “the value did not change” is exactly the case that needs repairing.

### What stays out of the tree

The **bottom drawer** (its 28px strip, `Ctrl+T` and never-remounting fixed position are the fix that killed the lost-zoom bug), the context rail, the action bar, the palette, and the help and shortcut editors. **Split view** is still a layout flag rather than a tree node — it is a runtime toggle, so it cannot be compiled into a shipped tree; it becomes redundant once a viewport can simply be dragged into a pane.

<!-- audience:contributor -->

## Regression guards

These rules are load-bearing and invisible: break one and the code still compiles, the app still boots,
nothing throws, and the failure surfaces as *"I can't select my fixtures"* or *"the output stopped"* —
usually on someone's rig, hours later. So they are asserted mechanically.

```bash
npm run verify          # invariant guards + typecheck — the normal loop
npm run verify:invariants   # just the guards (reads source, instant)
```

`scripts/verify-invariants.cjs` — every check carries the bug it came from and prints **why** it matters
when it fires. The shell/engine-related ones are below; the file holds the rest (cold start, transport,
FSM, packaging, a11y floors). Counting them here has gone stale twice, so it no longer says a number —
run `npm run verify:invariants` for the current list.

| Guard | The bug it prevents |
|---|---|
| `InstancedMesh` writes recompute `boundingSphere` | THREE caches it from the first raycast; `instanceMatrix.needsUpdate` does not invalidate it, so the pickable region freezes and later layout changes make objects silently unclickable |
| 3D backdrop objects yield picks to fixtures | screens are nearer the camera than the fixtures on them; an unguarded `stopPropagation()` stole 648 of 649 clicks |
| fixtures have a pickable body | the only target was a 12mm LED sphere |
| fixture/model selection is symmetric | the gizmo is gated on `!selectedModelId`, so a fixture click landed with no visible effect |
| context switches go through `goToContext()` | a direct `setContext` drops `layoutRev`, and a shipped layout never reaches an operator |
| the `scene3d` viewport id is declared once | a drifted copy mounts `Simulator3D` in both panes |
| one `<Simulator3D>` mount site | two WebGL contexts, visible only as halved frame rate |
| `TimelinePanel` mounted once | two timelines double its keyboard hook and its engine subscription. (The `Stage` half of this guard was **removed** once the frame loop left the component — output no longer depends on it being mounted) |
| the frame loop is owned by the engine, not a component or a canvas | put the rAF back in a component, or re-add an `if (!canvas) return` at the top of the loop, and Art-Net silently becomes a property of whether some React element happens to be mounted — which is how "Stage must never unmount" came to shape this entire document |
| the engine owns the GPU mapper and the wire, and the show modes mount no view | the mapper was built by a component effect, sending Art-Net was a `dmxSignal` subscriber in `App`, and headless mounted a hidden 1×1 `Stage`. All three made output a consequence of the UI existing |
| `engine/` never imports React | one hook dragged in there rebuilds the coupling by the back door |
| every referenced context id still exists | removing a context breaks four things and none of them raise: `goToContext` no-ops, `extend()` queues its patch forever (a plugin's dock tabs never appear), a `CONTEXT_MENU_ITEMS` entry does nothing, a stale `RETIRED_CONTEXTS` target leaves the rail unselected |
| every context declares all four visibility flags | an omitted banked key silently keeps the outgoing context's value — `bottomOpen` behaved as a global |
| `EditorData` is memoized | rebuilt per render it re-renders every panel and closes native `<select>` popups |

Two things learned writing them, worth keeping if you add more:

- **Read code, not prose.** This repo comments densely and the comments name the very things being
  asserted. Matching raw text reports mounts that do not exist *and* lets a stale comment satisfy a
  check whose call was deleted. `stripComments()` exists for that.
- **Assert the call, not the identifier.** The first version passed while the guard was deleted, because
  a leftover `import { ledUnderPointer }` still matched. Check for `name(`.

**Verify the guard itself fails.** Break the invariant on purpose, confirm the check fires, then restore.
A guard that cannot fail is worse than none — it reads as coverage.

## Out of scope — and the half of it that expired

**Tear-off OS windows are still out of scope.** A `float` node kind is reserved in the dock model so
adding them later is not a migration, and nothing renders it. If tear-off is ever wanted, the
projector subsystem (`src/main/projector.ts` + the preload MessagePort forwarding) is the proven
recipe: a keyed `BrowserWindow` map + a new `*.html` entry + a typed bridge.

**Free-form docking is no longer out of scope — it is the default shell.** This section used to say
drag-to-rearrange, split trees and tabbed groups had been deliberately not built, for two reasons.
Keeping the record of why that was wrong, because it is the more useful half:

> "A poor fit for the per-frame GPU repaint loop" was really a statement about the *Stage*: the loop
> lived inside it, so the viewport could not be moved, unmounted or duplicated without stopping
> Art-Net, and every layout idea had to be built around that one element. The loop moved to
> `engine/frameEngine.ts` and reads no DOM, so the 2D stage became an ordinary view. What genuinely
> remains single-instance is `Simulator3D` (one WebGL context) and `TimelinePanel` (one keyboard
> hook, one engine subscription) — two elements, not the whole shell. Once that was true the cost
> estimate was measuring a constraint that no longer existed.

The reasoning is worth re-reading before writing off any other feature as "a poor fit for the frame
loop": check whether the frame loop is still where you think it is. Built out as
[the dockable workspace](#the-dockable-workspace-the-default-shell) above, tracked in
[plans/dockable-workspace.md](../plans/dockable-workspace.md).
