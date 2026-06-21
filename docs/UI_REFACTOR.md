# ArtLux UI/UX Refactor — Design System & Architecture

Durable reference for the MadMapper-class UI refactor. Pair with
[ARCHITECTURE_PLAN.md](ARCHITECTURE_PLAN.md) (engine) and [PROGRESS.md](PROGRESS.md) (status).

## Goal
Refactor ArtLux's UI to MadMapper's **logic and visual language** (reference: MadMapper Art-Net
LED-strip workflow) while keeping the existing engine/concepts untouched. UI-only.

## Design tokens (`src/renderer/styles/tokens.css` → mirrored in `tailwind.config.js`)
Dark only. Tailwind class names in parentheses.
- Surfaces: `--bg-stage #000` (`bg-stage`), `--surface-0 #0d0d0d` (`bg-surface-0`),
  `--surface-1 #161616`, `--surface-2 #1e1e1e`, `--surface-3 #2a2a2a`.
- Lines/borders: `--line-1 #2a2a2a` (`border-line-1`), `--line-2 #383838`.
- Text: `--text-1 #e8e8e8` (`text-fg-1`), `--text-2 #9a9a9a` (`text-fg-2`), `--text-3 #6a6a6a`.
- Accent (muted teal): `--accent #27b6c4` (`text-accent`/`bg-accent`, supports `/10` `/15` alpha),
  `--accent-hover`, `--accent-press`, `--accent-dim`.
- Canvas selection: `--sel-surface #27b6c4` (cyan, surfaces), `--sel-fixture #ff3b3b` (red, DMX).
- Semantic: `--danger #e5484d` (`text-danger`), `--ok #3fb950`, `--warn #e3b341`.
- Radii: `--r-sm 3 / --r-md 5 / --r-lg 8` (use `rounded-[var(--r-sm)]` etc.).
- Type: Inter (UI) + mono figures (`.num` / `font-mono`, tabular-nums). Sizes 10/11/12/13.
  Legacy names (`gray-750/850/950`, `accent`) are kept in the Tailwind config so older classes
  keep working during migration.

## Shared primitive kit (`src/renderer/components/ui/`, barrel `ui/index.ts`)
`Button`/`IconButton`, `Section` (collapsible inspector group), `Field` (label+control row),
`NumberField` (spinner), `Slider` (optional `trackGradient` for R/G/B), `Select`, `Toggle`,
`Segmented`, `ListRow` (swatch chip + teal selected). All consume tokens; Lucide icons ~14–16px.
**Convention when restyling a component**: replace inline hex (`bg-[#121212]`, `text-gray-500`)
with token classes (`bg-surface-1`, `text-fg-2`) and swap bespoke rows for kit primitives.

## Information architecture (MadMapper logic) — `App.tsx` AppShell
- **TopBar**: brand · undo/redo · save/load · **ModuleSwitcher** (left); transport (center);
  Monitor toggle + Preferences gear (right).
- **Module model** (`types.ts` `Module`): `MEDIA · MAP · FIXTURES · THREE_D`. The module drives the
  **left panel focus** and the **center** (2D `Stage` for Media/Map/Fixtures — kept mounted so the
  `dmxSignal` stream never stops; lazy `Simulator3D` for `THREE_D`).
- **Left panel** = **Browser** (`ScenePanel`: fixtures tree + groups + scenes, top ~45%) +
  **Inspector** (`InspectorPanel`, below). Right panel removed.
- **Bottom Dock** (`Dock.tsx`, `DockTab`): `MONITOR` (`DMXMonitor`) + `FIXTURE_EDITOR` (placeholder
  until U4). Collapsible; toggled from the TopBar Monitor button.
- **StatusBar** (`StatusBar.tsx`): contextual help line (left) + render FPS / LIVE / native stats
  (right) + left-panel toggle.
- **Preferences** (`Preferences.tsx`): modal with DMX Output (protocol/IP/port/broadcast/enabled)
  + Engine (FPS/keep-alive/gamma). Replaces the old inline Output Config.
- Inspector sections by module: Source = Media only; 3D Layout = 3D only; Mapping/Effect/Output/
  Routing show with a fixture selected. (Per-module section filtering can be deepened in U3.)

## Phase status
- **U1 done** (`4c45809`): Tailwind build + tokens + `ui/` kit; CDN removed; dead files deleted.
- **U2 done** (`22825bb`): AppShell — ModuleSwitcher, consolidated left, Dock, StatusBar,
  Preferences modal; TopBar rebuilt; `Module`/`DockTab` types.
- **U3 (next)**: restyle `InspectorPanel` (its local `PanelSection`/`NumberInput` → kit + tokens;
  gradient R/G/B sliders; tabular values) and `ScenePanel` (browser rows → `ListRow`, swatch chips,
  teal selection); finish any hardcoded hex in panels.
- **U4**: `Stage` toolbar + canvas handle colors (cyan surfaces / red fixtures); `DMXMonitor` dock
  grid restyle (number+value intensity shading); real **Fixture Editor** (pixel type=colorOrder,
  matrix=pixels W×H, serpentine=assignation, channels); `Simulator3D` toolbar.
- **U5**: contextual hover help line, focus-visible rings, motion 150–300ms + reduced-motion,
  empty states, accessibility pass (contrast ≥4.5:1, icon-button aria-labels), packaged smoke test.

## Verification per phase
`npx tsc --noEmit` (clean) → `npm run build` → `env -u ELECTRON_RUN_AS_NODE ELECTRON_ENABLE_LOGGING=1
npm run dev` and check logs for `[output] native Rust engine loaded` + `[Stage] Using WebGPU` and
zero errors. Re-run the LED-strip flow (Media source → Map drag → Fixtures patch → Monitor dock →
output emits). Output/effects pipeline must stay untouched (UI-only).

## Environment gotchas (carry across sessions)
- Sandbox sets `ELECTRON_RUN_AS_NODE=1` → launch dev with `env -u ELECTRON_RUN_AS_NODE`.
- Native engine: `npm run build:native` (needs Rust; `.node` gitignored). Electron postinstall may
  need `node node_modules/electron/install.js`.
- Repo: github.com/urbandronedesign/artlux (`main`). Tag `v*` → CI builds + publishes a Release.
