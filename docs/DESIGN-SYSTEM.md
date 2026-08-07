# ArtLux Design System

The canonical spec for the ArtLux UI — tokens, typography, spacing, interaction states, the primitive
kit, and the reusable patterns. **Read this before adding or changing UI.** It is the source of truth
every screen is measured against; the audit in [UI-UX-AUDIT.md](UI-UX-AUDIT.md) is the token-adherence
history, and [UI-UX-DEEP-AUDIT](UI-UX-AUDIT.md) findings (C/H/M/L ids) drove the current version.

**The one rule that generates all the others:** never write a raw value where a token exists, and never
hand-roll a control the kit already provides. Both are guarded by `npm run verify:invariants`.

ArtLux is a **dark-only OLED control surface** (MadMapper/Resolume class). It deliberately commits to one
visual world — there is no light theme, and that is a choice, not an omission.

---

## 1. Foundations

### 1.1 Color — everything routes through tokens

Defined in [`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css), mirrored into
[`tailwind.config.js`](../tailwind.config.js) as utility classes. **Canvas/WebGL/WGSL draw colors are
exempt** — those are data, not chrome, and correctly use raw hex.

#### Surfaces (layered dark)
| Token | Hex | Tailwind | Use |
|---|---|---|---|
| `--bg-stage` | `#000000` | `bg-bg-stage` | the void behind the stage (also the splash console's well) |
| `--surface-0` | `#0d0d0d` | `bg-surface-0` | deepest chrome (rails, wells) |
| `--surface-1` | `#161616` | `bg-surface-1` | panels |
| `--surface-2` | `#1e1e1e` | `bg-surface-2` | raised panels, rows |
| `--surface-3` | `#2a2a2a` | `bg-surface-3` | hover step / controls |
| `--surface-4` | `#404040` | `bg-surface-4` | the mappable stage "paper" — deliberately lighter than chrome |

#### Text tiers — **every tier clears WCAG AA (4.5:1) on surfaces 0–3**
| Token | Hex | Tailwind | Contrast on `surface-2` | Use |
|---|---|---|---|---|
| `--text-1` | `#e8e8e8` | `text-fg-1` | **13.7:1** | primary text, headings, values |
| `--text-2` | `#9a9a9a` | `text-fg-2` | **5.96:1** | secondary text, labels, instructions |
| `--text-3` | `#8a8a8a` | `text-fg-3` | **4.86:1** | meta / captions — **the dimmest token; nothing below it** |

> **`bg-bg-stage` only became real in 2026-07.** This table documented the utility from the start, but the
> `bg` key was never in `tailwind.config.js` — Tailwind silently drops an unknown colour, so anything
> written from this row rendered **transparent**. Caught when the splash console's well showed no
> background. The token itself was always fine (`tokens.css`, applied to `<body>` from `index.css`).

> **This failure has a shape, and it is now guarded.** An unknown colour utility compiles to *nothing*:
> no error, no warning, the element simply inherits, and the screen looks almost right. It happened
> three times before anyone noticed a pattern — `bg-bg-stage` (above); **`text-fg-4` at 22 sites** across
> the calibration wizards, for a tier that has never existed (fg-3 is the dimmest **by design**, §1.1);
> and **`text-fg-0`** in `FixtureProfilePicker`, where the *selected* row asked to be brighter than the
> top tier and therefore rendered **dimmer than the unselected rows around it**. All three typechecked,
> linted and shipped. `verify:invariants` now resolves every `text-/bg-/border-…` colour utility against
> `tailwind.config.js` and fails on one that names nothing.

> `--text-3` was `#6a6a6a` (3.10:1) and failed AA at the 10–11px sizes it is used at — 113 sites. It is now
> `#8a8a8a`. **Do not** reintroduce a dimmer text color, and **do not** put `text-fg-3` on text smaller than it
> already carries. Instructional text an operator must read is `text-fg-2` **minimum** — never the dim tier.

#### Lines & dividers
| Token | Hex | Tailwind | Use |
|---|---|---|---|
| `--line-1` | `#2a2a2a` | `border-line-1` | low-emphasis internal splits only (~1.3:1 — barely visible by design) |
| `--line-2` | `#383838` | `border-line-2` | **scannable row separators** (tables, lists) — ~1.9:1 |

> **Divider rule:** any divider that separates rows a user scans (`divide-y` on a table, list-row borders)
> uses `line-2`. Never `line-1`, and **never** alpha-reduce a scannable divider (`border-line-1/60` is ~1.15:1
> and vanishes). `line-1` is only for cosmetic hairlines inside a single group.

#### Accent & semantic
| Token | Hex | Tailwind | Use |
|---|---|---|---|
| `--accent` | `#27b6c4` | `accent` | brand teal — selection, active, primary |
| `--accent-hover` | `#34c8d6` | `accent-hover` | |
| `--accent-press` | `#1f97a3` | `accent-press` | |
| `--accent-dim` | `rgba(39,182,196,.14)` | `accent-dim` | tinted fills |
| `--danger` | `#e5484d` | `danger` | destructive / error (**use this, not `red-400`**) |
| `--ok` | `#3fb950` | `ok` | success / live |
| `--warn` | `#e3b341` | `warn` | warning |
| `--sel-surface` | `#27b6c4` | `sel-surface` | canvas surface selection (cyan) |
| `--sel-fixture` | `#ff3b3b` | `sel-fixture` | canvas fixture selection (red) |
| `--fixture-idle` | `#4a8cff` | `fixture-idle` | idle (unselected) LED fixture on the canvas (blue, hatched via `.fixture-hatch`) |
| `--state-init` | `#16e0d8` | `state-init` | FSM initial node |
| `--state-active` | `#f5a623` | `state-active` | FSM active node ring |

### 1.2 Elevation — one shadow language
`shadow-e1` (raised control) · `shadow-e2` (popover/dropdown) · `shadow-e3` (modal/overlay). Values in
`--e-1..3`, tuned for the near-black ground (Tailwind's default `shadow-*` barely register on `#000`).
**Accent/danger glows** (`shadow-[0_0_Npx_rgba(accent)]`) are a separate semantic — "selected/live", not
elevation — and stay inline.

### 1.3 Radius — one vocabulary
`rounded-sm` → `--r-sm` (3px) · `rounded-md` → `--r-md` (5px) · `rounded-lg` → `--r-lg` (8px). Bare `rounded`
(4px) and `rounded-full` are Tailwind defaults. Prefer the named classes; `rounded-[Npx]` only for genuine
one-offs (1px preview cells).

### 1.4 Stacking — named z-index tiers
Ascending: `z-stage-guide` (60) < `z-stage-overlay` (100) < `z-calib-camera` (110) < `z-calib-panel` (120) <
`z-popover` (130) < `z-menubar` (150) < `z-menu-flyout` (160) < `z-modal` (200) < `z-toast` (205). Global
overlays use these; within-panel layering keeps Tailwind `z-10..z-50`.

> **A popover never trusts its ancestors.** `position:sticky`/`fixed` *with* a z-index creates a stacking
> context, and dense panels are lattices of them — the timeline alone has sticky gutters (`z-20`), a
> sticky ruler (`z-30`) and a `fixed inset-0 z-50` maximise wrapper. A panel written the obvious way
> (`absolute … z-50` beside its anchor) is **sealed** inside one, and its z-index stops meaning anything
> globally. Walked into three times in one day: TrackHeader's opacity/blend panel painted *under the next
> track's header*, and a picker's backdrop lost to the maximise wrapper so the dismissal click fell
> through and scrubbed the timeline. Nothing throws — the panel is in the DOM at correct geometry with
> correct text, so every DOM assertion passes and only the pixels are wrong. **Rule:** any popover with a
> dismiss backdrop portals to `document.body`, sits on the `z-popover` tier, and places itself from a
> *measured* rect (`components/timeline/usePopoverAnchor.ts`). Guarded (§8).

### 1.5 Motion
`--dur-fast` (120ms) → `duration-fast`; `--dur-med` (200ms) → `duration-med`; `--ease-out`
`cubic-bezier(.16,1,.3,1)` is the modal curve. `transition-colors` (150ms) is fine for hover. Keyframes
`animate-overlay-in` / `animate-modal-in` live in `index.css`. **`prefers-reduced-motion` is honored
globally** — don't defeat it.

---

## 2. Typography

**Faces** (self-hosted via `@fontsource`, offline — no CDN):

- **IBM Plex Sans** — the UI. `font-sans` (the `body` default). Latin, weights 400/500/600.
- **IBM Plex Mono** — numeric/DMX/timer/data. `font-mono`. Latin, weights 400/500.

> Historically the config named `Inter` but never bundled it, so Windows rendered Segoe UI. The faces are
> now really shipped. Import lives at the top of [`styles/index.css`](../src/renderer/styles/index.css).

### 2.1 Type scale — 10px is the hard floor
Use the named classes, never `text-[Npx]`.

| Class | Size | Use |
|---|---|---|
| `text-micro` | 10px | dense labels, badges, meta (**the floor — nothing smaller**) |
| `text-mini` | 11px | secondary controls, list rows |
| `text-xs` | 12px | default body in panels |
| `text-md` | 13px | menu items |
| `text-sm` | 14px | emphasized body |
| `text-lg`+ | — | headings |

### 2.2 Weight hierarchy
Reinforce hierarchy with weight, not just color: **headings 600**, **medium/labels 500**, **body 400**.
Don't build hierarchy on color alone — a flat block of one size in three greys does not read as structured.

### 2.3 The panel-header standard
Every dock/panel title uses **one** recipe so an operator gets a consistent "this is a title" signal:

```
text-xs font-semibold uppercase tracking-wider text-fg-1   /* 12–13px */
```

Section labels within a panel: `text-mini uppercase text-fg-2`. Body: `text-mini`/`text-xs`. Captions:
`text-micro text-fg-3`. **Let size carry hierarchy** — a title must not be the same size as its body (the
reference done right is `DMXMonitor`'s `Stat`: a 10px label over a 14px value).

### 2.4 Data is monospace
Anything that lines up or ticks — DMX values, universes, fps, timers, p99, coordinates, file offsets — uses
`font-mono` with `tabular-nums` (the latter is already the `body` default, so columns never jitter).

---

## 3. Spacing & density

4/8px rhythm (Tailwind's default scale). Use a **two-tier** rhythm so groups read as groups: **~4px within
a group** (`gap-1`, `space-y-1`), **~12px between groups** (`gap-3`, `space-y-3`). Let whitespace — not just
the near-invisible hairlines — define sections. A dense panel that stacks five bordered bands with no rest
between them reads as one undifferentiated block.

---

## 4. Interaction states

### 4.1 The hover/press "film" — a floor, not per-button work
One `:where()`-wrapped base-layer rule pair in [`styles/index.css`](../src/renderer/styles/index.css) films
every `<button>` / `[role=button]` / `<summary>` / `.pressable` on `:hover` (5% white inset) and `:active`
(12%). It **composites** over whatever the control already is, so a selected/tinted control keeps its tint
and merely brightens. Do **not** add `hover:bg-*` / `active:*` just to make a control respond — it already
does. `.no-press` opts out (color swatches, thumbnails); `.pressable` opts a non-button in. `:where()` is
load-bearing (keeps components able to override); guarded by `verify:invariants`.

### 4.2 Focus — always visible
A global `:focus-visible { outline: 2px solid var(--accent) }` floor lives in `index.css`. **Never** write
`focus:outline-none` on a real control without drawing a replacement ring — use `focus-visible:` (not
`focus:`) if you must scope it, or add `focus-visible:ring-2`. Kit primitives that opt out draw their own ring.

### 4.3 Disabled — a visible floor
Disabled controls use **opacity 0.4–0.5** (never lower), start from `fg-2` (not the already-dim `fg-3`), and
change the cursor. `disabled:opacity-30` on a glyph already at `fg-3` computes to ~1.4:1 — it reads as empty
space, not "inactive." Every kit primitive exposes a `disabled` prop; use it so "feature off" is consistent.

### 4.4 A rendered control must act
A control that answers its hover/press and then does nothing is read as **the app being broken**, never as
the button being obsolete. When a control cannot act in the current mode it is **absent, or disabled with a
reason** — never rendered wired-to-nothing:
- The StatusBar column toggles render only when handed a handler, and App hands one only on the fallback
  shell (`isDockingOn()`) — under docking the dock chevrons own that job, and the toggles kept flipping,
  persisting and recolouring a flag *nothing read*, for every operator, since docking is the default.
  Guarded (§8).
- A door contributed by a plugin is **gated on the capability actually being present** (the Trigger Zones
  action-bar button asks the panel registry first) — with the plugin disabled the door is absent, not dead.
- A static `enabled()` predicate must not kill the only way to *stop* something mid-operation: the take
  Record button once disabled itself mid-take when the selection emptied, while capture continued. While an
  operation runs, its run-time state (`ContextAction.live`) wins over the static predicate.

---

## 5. Primitive kit

Import from `@/components/ui` (barrel: [`components/ui/index.ts`](../src/renderer/components/ui/index.ts)).
**Prefer these over hand-rolled controls** — the kit carries the a11y contract; hand-rolled `<div onClick>`s
are how the app grew keyboard-unreachable rows and missing labels.

| Primitive | Purpose | a11y contract |
|---|---|---|
| `Button` / `IconButton` | actions | `type="button"`; `IconButton` auto-derives `aria-label` from `title` and `aria-pressed` from `active`; focus ring; disabled prop |
| `Field` | label + control wrapper | associates the visible `<label>` to its control via `useId()` (`htmlFor`/`id`) |
| `NumberField` | numeric input | **finite-guarded** — never commits `NaN`; keeps a local string while editing, commits on blur; arrow-step |
| `Slider` | ranged value | label associated; `aria-valuetext` carries the formatted readout; `disabled` prop; commit-on-release |
| `Select` | single choice | native `<select>`; **the consuming panel must be `React.memo`'d** or a per-frame repaint tears down an open dropdown |
| `Toggle` | boolean | label is part of the hit target (`htmlFor`); native checkbox keeps its focus ring |
| `Segmented` | one-of-N | `role="radiogroup"`/`radio` + `aria-checked`; active segment has a **non-color** cue (inset ring), not tint alone |
| `ListRow` | selectable browser/tree row | `role="button"` + roving `tabIndex` + Enter/Space handler — keyboard-operable everywhere it's used |
| `Section` | collapsible group | header is `type="button"` with `aria-expanded`; hosts an action slot |
| `Tooltip` | hover/focus help | opens on focus; stays open while focus is within anchor-or-panel so the "Learn more" link is Tab-reachable; "Learn more" deep-links into the F1 help modal (§6) |

> **Tooltip clones its child, and under React 19 the child's own ref is read from `props` ONLY.** Merely
> *touching* `element.ref` logs a deprecation error to the console — it did, on every tooltip-wrapped
> child that carried a ref, caught by a smoke test's console-error check. Don't reintroduce the
> `element.ref ?? props.ref` fallback.

### 5.1 Supporting primitives & hooks (feedback + keyboard)
| Name | Purpose |
|---|---|
| `ToastProvider` / `useToast` | app-wide transient feedback with an `aria-live="polite"` region (`assertive` for output-down/watchdog). **The only** sanctioned way to say "Saved" / "Import failed". |
| `ConfirmDialog` / `useConfirm` | themed, focus-trapped confirmation. **Replaces** all native `window.confirm/alert`. Destructive action uses `danger` and is separated from Cancel. |
| `useFocusTrap` | capture `activeElement` on open → trap Tab within the dialog → restore focus on close. Every modal uses it. |
| `useRovingTabindex` | one Tab stop per list; Arrow keys move focus between rows. Use for any list ≥ a handful of rows (avoids both "zero stops" and "hundreds of stops"). |

---

## 6. Patterns

- **Status = color + glyph/text, never color alone.** A green dot needs a label; "calibrated" needs a
  distinct glyph, not just a tint; the active item needs more than a border-color change. (WCAG 1.4.1.)
- **Empty states name the next action.** Not "No surfaces" — "No surfaces yet — Add Surface", wired to the
  actual action. A new operator should never face a dead-end list.
- **Destructive = confirm-or-undo + danger + separation.** Any irreversible action (delete surface/scene/
  controller/output, relink) gets a `ConfirmDialog` (or a real undo) and a `danger`-colored, spatially
  separated trigger. Hover-only delete buttons must also reveal on `group-focus-within` for keyboard users.
- **Forms:** visible associated label (not placeholder-only), inline error below the field, persistent
  helper text for complex inputs, validate on blur (not per keystroke).
- **Live-show safety:** "LIVE" must mean frames are actually flowing, not just that a socket is configured;
  the master output toggle is guarded; the StatusBar carries a warnings channel for degraded-native/errors.
  Recording is chrome-level state: a REC chip in the StatusBar plus a live elapsed clock on the action-bar
  button — written to a DOM ref via `ContextAction.live`, **never through React state**, which would
  re-render the shell once a second for a cosmetic tick.
- **A refusal is a toast, never a `console.warn`.** Mandatory the moment a shortcut can trigger the action
  somewhere no visible button explains the silence — the take recorders shipped every refusal as a warning
  nobody saw, from workbenches with no record button on screen.
- **Shipped is not done until it is findable.** Track reorder had already shipped — documented, working —
  and the owner had never seen it: a 12px glyph at the dim tier carrying only a native `title`, the one
  control in its header not wired into the help system. A control that is a *door* gets a real hit target,
  the brighter text tier, and a `Tooltip` + help entry; a feature gets a **View menu item**; several doors
  are fine when they all land on the same panel (the trigger-zone editor has three). And revealing a panel
  by name must actually surface it — under docking that means writing the dock tree (`ensureTree` +
  `setActive`, re-adding a closed tab), not a flag the docked path never reads.
- **…but chrome never duplicates a door.** The inverse rule: the TopBar icon group (Outputs, Routing, DMX
  Monitor, Preferences, Help) died because every icon was a *second* door to something the menus, the
  context rail, the dock tabs and F1 already opened. Findability comes from help + menus + contextual
  actions, not from accreting global icons.
- **Help has ONE door: F1.** One searchable modal interleaves the per-function control registry, the
  Guides tier, and the usage-doc chapters (723 heading-sized chunks) through **one scorer**
  (`services/docSearch.ts`) — two rankers would order the same merged list two ways, so `verify:docs`
  fails any surface that grows its own. Multi-word queries tokenise ("gray code" must find "Gray-code").
  F1 is renderer-owned like Ctrl+K — a native accelerator would swallow toggle-to-close or double-fire.
- **Progress counts up.** A progress fraction is a **ledger keyed on identity**: `total` only grows,
  `ready` counts what finished — never `total − pending`, because an item finishing and a new one being
  discovered then cancel out and the bar sits still (or runs backwards, or reads n/0). Key on identity,
  not the display label — the same clip re-labelled per phase must not count twice. Pair the fraction
  with a one-word phase ("warming" / "decoding"): a fraction stuck at 12/47 reads as a hang; a phase
  reads as work. Guarded (§8).
- **A canvas is an open workspace, not a fenced square.** The Stage mapping canvas and the state graph
  both pan/zoom unbounded — the unit-square raster and the fixed 2600×1700 scroll-document were fences
  that made real work silently vanish (a surface dragged off the square kept *outputting* but disappeared
  from the preview). Wheel zooms toward the cursor via a **native non-passive listener** — React's root
  `onWheel` is passive, so its `preventDefault` is a console-warning no-op — and every open canvas ships
  a recovery affordance: **Fit / Reset** chrome plus a rebindable `F`, because an operator who loses the
  content off-screen must never be stranded.

---

## 7. Brand marks — one source, never hand-drawn

The app names itself in two shapes, and **both are generated**, never typed out or drawn by hand:

| Mark | What it is | Where it belongs |
|---|---|---|
| **Wordmark** — `ARTLux` | Outlines cut from **IBM Plex Sans 700**, the UI typeface, at a tight ink box. Flat monochrome, `fill="currentColor"`. | Title bar, About dialog, show-control tablet header |
| **Icon mark** — the `A` tile | The *same* `A` glyph, white, centred on a flat black rounded tile. Carries its own colours (a taskbar icon has no CSS to inherit) and is **deliberately not accent teal** — it is the one mark that never sits on ArtLux chrome, so it answers to the OS shell. Flat, not a ramp: at 16px a gradient is three identical greys. | `.ico`/`.png`/favicon, About dialog, tablet home-screen icon |

**Pipeline.** `npm run gen:brand` → [`scripts/gen-wordmark.cjs`](../scripts/gen-wordmark.cjs) reads the
bundled `@fontsource` WOFF and emits `build/wordmark.svg`, `build/icon.svg` and
[`shared/brandMarks.ts`](../shared/brandMarks.ts); [`scripts/gen-icon.cjs`](../scripts/gen-icon.cjs) then
rasterises the tile to `icon.png` / a 7-size `icon.ico` / the renderer favicon. **All outputs are
committed**, so packaging needs no font tooling.

**Rules:**
- Draw a mark ONLY via [`components/brand/AppMark.tsx`](../src/renderer/components/brand/AppMark.tsx)
  (`<AppWordmark>` / `<AppIconMark>`). Guarded — see Governance below.
- Never `<img src="…wordmark.svg">`. An `<img>` is an opaque document, so `currentColor` cannot reach
  it and the wordmark stops being recolourable, which is the whole point of the monochrome treatment.
- Recolour the wordmark with a text colour class at the use site (`text-fg-1`, `text-accent`, …). Do
  not regenerate an asset to change its colour.
- Changing the logo means editing `gen-wordmark.cjs` and re-running `npm run gen:brand` — nothing else.
- **A new icon does not reach an already-installed machine on upgrade.** Windows caches shell icons per
  executable path, so the taskbar/Explorer keep the old mark while the in-app wordmark and About dialog
  update immediately. That asymmetry is the OS, not the build — see
  [INSTALL.md → The app icon lags behind an upgrade](INSTALL.md#the-app-icon-lags-behind-an-upgrade-windows-icon-cache)
  and, before shipping one, [DEVELOPMENT.md → Release process](DEVELOPMENT.md#release-process) for how to
  verify the raster inside the packaged `.exe` (check it at 16px, not just at full size).

**Why it is generated.** The mark used to exist three times over: `build/icon.svg` as a hand-written
teal `A`, plus a `sky-400 → blue-600` CSS tile in the title bar and an accent one in About. They had
already drifted to different colours. Nothing failed — it compiled, booted, threw nothing, and simply
branded the app two ways at once.

---

## 8. Governance

These `check(...)` guards in [`scripts/verify-invariants.cjs`](../scripts/verify-invariants.cjs) keep the
system from regressing (run by `npm run verify`):

- **Colour utilities name real tokens** — every `text-/bg-/border-/ring-…` on an `fg`/`surface`/`line`/
  `accent`/`state`/`sel` scale must resolve in `tailwind.config.js`. An unknown one renders as nothing
  (see §1.1: it has shipped three times).
- **The dim tier stays AA** — `--text-3` / `fg.3` must stay `#8a8a8a`. *(Note: the "may not co-occur with
  `text-micro`" rule below is a written convention, not a machine check — the guard verifies the token
  value, not per-element pairings.)*
- **No native dialogs** — `window.confirm`/`window.alert` are banned in `src/renderer` + `plugins` (route
  through `ConfirmDialog`/`useToast`).
- **A live region exists** — the StatusBar carries at least one `aria-live` region.
- **Focus rings survive** — `focus:outline-none` without a replacement ring is flagged.
- **Rows stay operable** — `ListRow` carries a `role` and an `onKeyDown`.
- **The logo has one source** — `shared/brandMarks.ts` + `components/brand/AppMark.tsx` must exist and be
  wired, MenuBar/About must render the mark, and no other file may hand-draw a lettered gradient tile.
- **The credit + licence line have one source and are shown** — `shared/credits.ts` exists, the splash and
  About both import it and render `AUTHORS_LINE` + `LICENSE_HEADLINE`, and no other file hardcodes an
  author's name. This one is a **licence obligation**, not a style rule: [`LICENSE`](../LICENSE) §3 requires
  a build to show them.
- **Popovers leave the gutter** — a timeline popover with a dismiss backdrop must `createPortal` to the
  body and sit on `z-popover` (§1.4; three panels shipped sealed inside sticky/fixed stacking contexts,
  invisible or scrubbing the timeline on dismiss).
- **A dead toggle is not rendered** — the StatusBar column toggles exist only when handed a handler, and
  App hands one only on the fallback shell (§4.4).
- **The boot fraction cannot go backwards** — the cold-start gate's progress is a grows-only ledger;
  `ready` counts finished items, never `total − pending` (§6).
- **The splash never opens in headless/broadcast** — `splash.open()` has exactly one call site and it is
  gated on `!HEADLESS && !BROADCAST` (see §9).
- Plus the pre-existing floors (interaction film overridable, one type/color/z/shadow vocabulary — see
  [UI-UX-AUDIT.md](UI-UX-AUDIT.md) Guardrails).

---

## 9. The startup splash

Its own `BrowserWindow` (`main/splashWindow.ts` + `renderer/splash.html`), **760×560** at 100% UI scale,
frameless, square-cornered, `surface-0` with a `line-2` hairline border, centred on the primary display's
work area, `alwaysOnTop` only until the editor window paints.

**Why a window and not an overlay:** the editor window is created hidden and revealed on `ready-to-show`
with a 4s backstop, so there are seconds where nothing is on screen. React inside `index.html` cannot cover
a window that isn't visible yet.

**Four bands, top to bottom** — the console is the only one that flexes (`flex-1 min-h-0`; every other band
is `shrink-0`, because in a fixed-height flex column the last child is what gets crushed — that was the
dismiss hint, present in the DOM at zero pixels tall):

| Band | Recipe |
|---|---|
| Identity | `<AppWordmark height={26}>` in `text-fg-1` (**never** the name as text — §7), version `font-mono text-xs text-fg-3` right-aligned on the same baseline, tagline + explainer `text-xs text-fg-2`, `max-w-[62ch]` |
| Console | `bg-bg-stage` well, `border-line-1`, `rounded-md`, `font-mono text-mini`, `role="log"` + `aria-live="polite"` + `aria-busy`; rows are a `grid-cols-[14px_168px_1fr_52px]` (glyph · name `text-fg-1` · detail `text-fg-2` · ms, `tabular-nums`) |
| Phase bar | 2px `surface-3` track, `accent` fill, at 12% / 50% / 100% for the two **real** waves (main process, then renderer) + a summary line |
| Credits | `border-t border-line-1`; `CREDIT_LABEL` as `text-micro uppercase tracking-wider text-fg-2`, names `text-xs font-medium text-fg-1`, licence `text-xs text-fg-2` |

**Rules that are load-bearing, not taste:**
- **Status is glyph + colour, never colour alone** (§6): `✓` `text-ok` · `!` `text-warn` · `·` `text-fg-2` ·
  `✕` `text-danger`. `danger` on near-black is ~4.3:1 — **under AA** for 11px prose — so red is confined to
  the glyph and a short `FAILED` badge while the readable text stays `fg-1`/`fg-2`.
- **Nothing 10–11px is `text-fg-3`** (§8's first guard). The dim tier appears only on the 12px version string.
- **The licence line is not a caption.** It stays 12px on `fg-2`; a legal statement an operator must be able
  to read is never the dim tier at the 10px floor.
- **No spinner.** Plugin activation is synchronous per plugin, so a spinner would imply pending work that
  doesn't exist. A blinking caret (`.animate-caret`) carries the "live" affordance and collapses to a static
  caret under `prefers-reduced-motion`.
- **`off` is not a problem.** The summary counts `degraded + error` as "need attention" and `off` separately
  as "inactive" — `nvwarp` is `off` on every machine without a Quadro/RTX-pro GPU, and a splash that opens on
  "2 need attention" when nothing is wrong teaches operators to ignore the one time it matters.
- **Nothing on it is interpolated to look busy.** Each row appears when that thing's `activate()` actually
  returned, timed with `performance.now()`.
- **Never in `--headless` / `--broadcast`.** Broadcast is the watchdog's relaunch mode: an always-on-top
  window over live fullscreen projector output, mid-show, unattended. Guarded (§8). `Prefs.showSplash`
  turns it off in the editor too (Preferences → Appearance).
- **It contains and reports its own faults, silently.** The splash entry installs the global fault net
  (`installGlobalNet('splash')`) and wraps in a `silent` `ErrorBoundary` — a throw here would otherwise
  leave the splash on screen forever, with "it never opened" as the operator's only symptom. Silent
  because **main owns this window's lifetime**: a failed splash simply shows nothing while main closes it
  on its own schedule, so there is nothing for a recovery card to offer. Its faults report as `aux` — the
  splash can never relaunch a show.
