# Workspace layout & high-DPI UI scaling

How the editor UI scales for 4K/high-DPI and how its panel layout persists. This is **workspace
ergonomics** — all of it lives in app **Prefs** (`userData/artlux-prefs.json`), never in the portable
`.artlux` project. Scope note: this is a *flexible workspace* (persisted sizes + reusable resizer +
presets), not a free-form docking engine — see [Out of scope](#out-of-scope).

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
  `splitRatio`), **visibility** (`showLeft/Right/Help`, `dockOpen`, `splitView`, `timelineMax`),
  **selections** (`leftTab`, `dockTab`), and `activePreset`.
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
- Callers: the split divider (App.tsx, `ratio` + `splitHostRef`), the dock top edge (`Dock.tsx`, `invert`,
  dynamic `max: () => innerHeight-120`), the help left edge (`HelpPanel.tsx`, `invert`).

## Workspace presets

Built-in `edit` / `perform` / `calibrate` presets (`BUILTIN_PRESETS` + `applyPreset` in `layoutStore.ts`).
A preset is a **named partial layout** merged over the current one — sizes/tabs it doesn't mention are
preserved, so the operator keeps their dock height etc. `applyPreset` stamps `activePreset`; any later
manual resize/toggle flips it to `'custom'` (the `set()` guard). The switcher is a segmented control in the
[StatusBar](../src/renderer/components/StatusBar.tsx) that reads the store directly (no props threaded).

## How to…

- **Add a persisted layout field:** add it to `WorkspaceLayout` + `DEFAULT_LAYOUT`, read via `useLayout()`,
  write via `layoutStore.set()`. It rides the existing `Prefs.layoutState` blob — no new Prefs key.
- **Add a preset:** add an entry to `BUILTIN_PRESETS` (a `Partial<WorkspaceLayout>`) and a button to the
  StatusBar `PRESETS` array.
- **Persist any other workspace state** (not project content): add a top-level `Prefs` field in
  `shared/protocol.ts` and read/write via `getPrefs`/`setPrefs` — keep nested state in one object so the
  shallow merge is safe.

## Out of scope

Full free-form docking (drag-to-rearrange, split trees, tabbed groups) and tear-off panel windows were
**deliberately not built** — high cost/maintenance and a poor fit for the per-frame GPU repaint loop +
reparenting the WebGPU/WebGL panels. See [ROADMAP.md](ROADMAP.md). If tear-off is ever wanted, the
projector subsystem (`src/main/projector.ts` + the preload MessagePort forwarding) is the proven recipe:
a keyed `BrowserWindow` map + a new `*.html` entry + a typed bridge.
