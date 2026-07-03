# UI/UX & Design-System Audit

Audit of the renderer UI (`src/renderer` + `plugins/*`) against the "Dark-Mode OLED pro-console"
pattern — the class ArtLux targets, so the *direction* is already right. This documents the findings,
the **design-token conventions** they produced (the reusable part — read this before adding UI), and
what's been fixed vs. what still needs a runtime pass.

Scope at audit time: 60 renderer components, the `components/ui/` primitive kit, `styles/tokens.css`,
`tailwind.config.js`. Method: static analysis (token adherence, arbitrary-value counts, a11y signals)
plus reading representative screens.

## Scorecard

| Dimension | Before | After | Notes |
|---|---|---|---|
| Color system | A | **A** | Was already near-perfect; last 3 leaks now tokenized → **0 arbitrary colors**. |
| Icons | A | A | lucide-react, zero emoji-as-icon. |
| Component kit | A− | A− | `Button`/`IconButton` set the bar (focus ring, disabled, auto-aria). |
| Accessibility | B+ | **A−** | Modals already had `role=dialog`+`aria-modal`+Escape; added keyboard select to list rows. |
| Motion | B | **B+** | Reduced-motion honored; `--dur-*` tokens wired (`duration-med`) and `transitionDuration` scale added. |
| Spacing / radius | B− | **B+** | 4px Tailwind rhythm consistent; radius converged — `rounded-sm/md/lg` now resolve to `--r-*`, one vocabulary. |
| Elevation / z-index | C | **A−** | Introduced named `zIndex` + `shadow-e*` scales; **0 ad-hoc** remain. |
| **Type scale** | **D** | **A** | Named scale + 10px floor; **0 arbitrary `text-[Npx]`** (was 350+). |

## Design-token conventions (READ BEFORE ADDING UI)

The token layer lives in [`src/renderer/styles/tokens.css`](../src/renderer/styles/tokens.css) (CSS vars)
mirrored into [`tailwind.config.js`](../tailwind.config.js) (utility classes). **Never write a raw value
where a token exists.** Verify discipline anytime with the greps in [Guardrails](#guardrails).

### Type scale — 10px is the hard floor
Use the named classes, never `text-[Npx]`:

| Class | Size | Use |
|---|---|---|
| `text-micro` | 10px | dense labels, badges, meta (the floor — nothing smaller) |
| `text-mini` | 11px | secondary controls, list rows |
| `text-xs` | 12px | default body in panels (Tailwind default, unchanged) |
| `text-sm` | 14px | emphasized body (Tailwind default) |
| `text-md` | 13px | menu items |
| `text-lg` / `text-3xl` | — | headings (Tailwind defaults) |

`text-xs`/`sm`/`lg` keep their Tailwind meanings — the scale only **added** `micro`/`mini`/`md`, so no
existing class shifted. Sub-legible `text-[7/8/9px]` were bumped to `text-micro`.

### Color — everything routes through tokens
Surfaces `bg-surface-0..4` (4 = the lighter "stage paper"), text `text-fg-1..3`, lines `border-line-1/2`,
`accent`/`accent-hover`/`accent-press`, semantics `danger`/`ok`/`warn`, selection `sel-surface`/`sel-fixture`,
state-machine `state-init`/`state-active`. **Canvas/WebGL/WGSL draw colors are exempt** — those are data,
not CSS, and correctly use raw hex.

### Elevation — one shadow language
`shadow-e1` (raised control) · `shadow-e2` (popover/dropdown) · `shadow-e3` (modal/overlay). Values in
`--e-1..3`, tuned for the near-black background (Tailwind's default `shadow-*` are calibrated for light
UIs and barely register on `#000`). **Accent/danger glows** (`shadow-[0_0_Npx_rgba(accent)]`) are a
separate semantic — "selected/live", not elevation — and stay inline.

### Stacking — named z-index tiers
Global overlays use named tiers (ascending): `z-stage-guide` (60) < `z-stage-overlay` (100) <
`z-calib-camera` (110) < `z-calib-panel` (120) < `z-menubar` (150) < `z-menu-flyout` (160) <
`z-modal` (200) < `z-toast` (205). Values preserve the pre-existing order (incl. the Stage↔calib
coordination documented in `App.tsx`). **Within-panel** layering keeps Tailwind `z-10..z-50`.

### Radius — one vocabulary
`rounded-sm/md/lg` resolve to `--r-sm` (3px) / `--r-md` (5px) / `--r-lg` (8px) — the old
`rounded-[var(--r-md)]` long form and the plain `rounded-md` class now mean the **same** thing (they
didn't before: Tailwind's `md` was 6px). Bare `rounded` (4px, the workhorse default) and `rounded-full`
are unchanged. Prefer the named classes; `rounded-[Npx]` only for genuine one-offs (e.g. 1px preview cells).

### Motion
`--dur-fast` (120ms) / `--dur-med` (200ms) → utility classes `duration-fast` / `duration-med`;
`--ease-out` is the modal curve. `transition-colors` (150ms default) is fine as-is for hover states.
Keyframes in [`index.css`](../src/renderer/styles/index.css); `prefers-reduced-motion` is globally honored.

### Modals — draggable + position-remembering
Modals are the centered `fixed inset-0 … bg-black/60` backdrop + a `role="dialog"` content div with an
`Escape` handler. To make one **draggable with a remembered position**, wrap the dialog in a positioner
and use the drag hook:
```tsx
const { positionerStyle, handleProps } = useDraggableModal('my-modal-id'); // host: '../hooks/useDraggableModal'
// <div className="fixed inset-0 …" onClick={onClose}>
//   <div style={positionerStyle}>
//     <div role="dialog" onClick={stopProp}>
//       <div {...handleProps} className="… cursor-move select-none">  {/* header = handle */}
```
Host modals persist to app prefs (`Prefs.modalPositions`); **plugin** modals use the SDK's
`useDraggable` directly with their own storage. Full contract: [SDK.md](SDK.md) → "UI helpers".

## What was fixed in this pass

- **Type scale (P1):** codemod across 40 files — `text-[7/8/9/10px]→text-micro`, `11px→text-mini`,
  `12px→text-xs`, `13px→text-md`. Removed ~280 arbitrary values; raised ~45 sub-legible labels to the floor.
- **Color leaks (P3):** `bg-[#404040]`→`bg-surface-4`; `#16e0d8`→`state-init`; `#f5a623`→`state-active`.
  Zero arbitrary color values remain.
- **Elevation (P2):** `shadow-2xl→e3`, `shadow-xl/lg→e2`, `shadow-sm→e1` across ~18 sites.
- **Stacking (P2):** all ad-hoc `z-[NNN]` → named tiers (pure rename, order preserved).
- **Radius convergence (P3):** pointed Tailwind `rounded-sm/md/lg` at the `--r-*` tokens and collapsed
  68 `rounded-[var(--r-*)]` to the short form. The two vocabularies now agree; `0` token-radius long-forms remain.
- **Motion tokens:** added the `transitionDuration` scale; wired the 3 explicit `duration-200` → `duration-med`.
- **Keyboard a11y (P2):** the 4 selectable rows that carry a nested action button
  (`ScenePanel3D` ×2, `CueBankPanel`, `AutoAlignWizard`) got `role="button"` + `tabIndex` +
  Enter/Space handlers — they couldn't become `<button>` (nested-button HTML), so `role` is the correct fix.

Verified: `tsc --noEmit` clean; Tailwind emits every new class; 0 residual arbitrary text/color/z/shadow.

## Needs a runtime pass (`npm run dev`)

1. **Type floor bump** — the ~45 `text-[7/8/9px]→10px` labels are now slightly larger. Eyeball the
   densest users: `ContentEditor`, `FixtureEditor` (the lone 7px), timeline ruler/clip labels — confirm
   nothing wraps or clips.
2. **Shadows** — the elevation tokens are darker/tighter than Tailwind's defaults (intentional, for the
   black bg). Glance at modals, the menu flyout, timeline popovers, calibration wizard rails.
3. **`StateGraphEditor` modal at `z-[60]`** (left as-is): it's a full-screen modal sitting *below*
   `z-menubar` (150) and other modals (200). Decide if that's intended (keep menu reachable) or a latent
   bug → bump to `z-modal`. Not touched because it changes stacking and needs eyes.
4. **Row keyboard nav** — the 4 rows are now tabbable; in very long lists a roving-tabindex `listbox`
   would be a better pattern than one tab-stop per row. Fine for now.
5. **Radius 1px shifts** — the convergence moved existing `rounded-sm` (2→3px) and `rounded-md` (6→5px);
   ~10 elements total (e.g. `TrackHeader`, `ListRow`, `Timeline`, `Simulator3D`). Cosmetic; glance to confirm.

## Backlog (not yet done)

- **Row `listbox` semantics:** the 4 selectable rows use `role="button"`; long lists would read better as a
  roving-tabindex `role="listbox"`/`option`. Low priority for a mouse-first console.
- **`StatusBar`/`Dock` micro-audit:** not deep-read in this pass; spot-check against the token conventions.

## Guardrails

Run these to keep the tree clean (all should return `0`):

```bash
# arbitrary font sizes
grep -rIoE "text-\[[0-9]+px\]" src/renderer plugins --include=*.tsx | wc -l
# arbitrary colors (canvas draw colors live in .ts/ctx, not className, so won't match)
grep -rIoE "(bg|text|border|ring|from|to|via)-\[#[0-9a-fA-F]" src/renderer plugins --include=*.tsx | wc -l
# ad-hoc z-index and shadows
grep -rIoE "z-\[[0-9]{2,}\]" src/renderer plugins --include=*.tsx | grep -v StateGraphEditor | wc -l
grep -rIoE "shadow-(sm|md|lg|xl|2xl)\b" src/renderer plugins --include=*.tsx | wc -l
```
