# 3. Fixtures

ArtLux has **two kinds of fixture**, and treats them as two devices rather than one type with
optional fields:

- an **LED fixture** — a strip or panel that *samples the content under it* off a surface. How many
  LEDs, how they're wired, how many channels each uses. **This page is about those.**
- a **light fixture** — a moving head, wash or beam, driven by **authored values** from its DMX
  profile rather than by sampling anything. It lives in the **3D** workbench, never on the 2D Stage,
  and never offers pixel controls. See [3D scene](09-3d-scene.md) and
  [LIGHTING-SHOW.md](../LIGHTING-SHOW.md).

You do not pick the kind: giving a fixture a **DMX profile** from the Library makes it a light.

Most of what a fixture *is* lives in the **parameters column** on the right and changes with what is
selected. Two things are not in the column and ship as dock tabs in **Map**:

| Dock tab | Holds |
|---|---|
| **Library** | the shipped DMX profiles, and your own LED templates |
| **Wiring & Ledmap** | the physical-order preview, and the ledmap tools (LED fixtures only) |

> ⚠ The screenshot below — the seven-card **Fixture Editor** dock — is **outdated**. Five of its
> cards were a second rendering of controls the parameters column now owns and explains; *Create*
> moved to the action bar. Re-capture with `node scripts/capture-docs.cjs`.

![The retired Fixture Editor dock](images/04-fixture-editor.png)
*Outdated — the Fixture Editor dock as it was before the split.*

---

## Create a fixture

**Map action bar ▸ Add Fixture** (defaults: 30 LEDs, a Line shape, RGB order, auto‑patched). It
appears on the Stage and auto‑links to the first surface. You can also drop one from a **template**,
or from a **DMX profile** in the **Library** tab — which gives you a light, not a strip.

---

## Geometry (shape)

In the parameters column's **2D / Output** section:

- **Line** — a single run of LEDs (a strip).
- **Matrix** — a 2D panel: set **Cols** and **Rows**, and toggle **Serpentine** if the rows are wired
  in a zig‑zag (row 0 left→right, row 1 right→left…). The **Wiring & Ledmap** dock tab previews the
  physical LED order so you can confirm it matches the panel.

---

## Pixel type

- **Color Order** — the physical channel order of each LED (RGB, GRB, BGR…). WS2812B strips are
  usually **GRB**. *If colors look swapped, this is the setting to change.*
- **Channels** — **RGB (3)** or **RGBW (4)**.
- **White** (RGBW only) — *Subtract min* derives white from the common minimum of R/G/B (brighter,
  keeps hue); *None* leaves white off.
- **Reverse** — flips the whole fixture's pixel order (pixel 0 ↔ last) for backward wiring.

---

## Map it to a surface

With the fixture selected, set the Inspector's **Mapping ▸ Surface** (visible at the top of the
inspector). `— none (off) —` means the fixture samples nothing. The **LED Count**, **Universe** and
**Start Addr** for the fixture are shown here too.

![A line fixture selected — Mapping, Effect, 2D/Output, Routing and 3D Layout cards](images/03-fixture-inspector.png)
*"LED Strip" selected: Mapping (Surface / LED Count / Universe / Start Addr), Effect, 2D/Output, Routing and 3D Layout cards stack down the Inspector.*

---

## Place it on the Stage

Drag to move; drag the corner/edge handles to resize (corner = both axes, side handles = one axis);
drag the top handle to rotate. Hold **Ctrl/Cmd** or **Shift** while clicking to multi‑select; with
snapping on, rotation snaps to 45° steps.

*Light fixtures are not drawn here at all* — click to place them in the **3D** workbench, where they
land at trim height.

---

## Templates (reusable fixture types)

Configure a fixture, select it, and in the **Library** dock tab click **Save selected**. It stores
the *structure only* (LED count, shape, matrix size, serpentine, color order, channels) — not its
position or address. Click a template later to drop a new fixture of that type; delete templates from
the same tab. Templates are a *pixel* idea: a light fixture is reused as a **profile + mode**
instead.

---

## Ledmap (irregular wiring)

A **ledmap** remaps physical pixels onto the fixture's geometry — "the *Nth* pixel in the data stream
lights *which* position?" Most rigs don't need one: **Reverse** handles backward strips and
**Serpentine** handles zig‑zag panels. Reach for a ledmap only for irregular or hand‑wired layouts.

In the **Wiring & Ledmap** dock tab:

- **Load** — import a `.json` map. ArtLux accepts a bare array `[0,1,2,…]` or a WLED‑style
  `{ "map": [...] }`, so you can drop in a WLED `ledmap.json` directly.
- **Export** — save the current map (or an identity template to edit by hand).
- **Clear** — back to natural order.
- **Generate serpentine** (matrix only) — bake the zig‑zag into a ledmap and switch Serpentine off so
  it isn't applied twice.

The map length should equal the LED count; out‑of‑range entries fall back to natural order. Transforms
apply in the order **Reverse → ledmap → Serpentine**. See [LEDMAP.md](../LEDMAP.md).

➡ Next: [Patching & routing](04-patching-and-routing.md)
