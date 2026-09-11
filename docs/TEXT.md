# Text on a surface

Type words, and they appear on the wall. A title, a performer's name, a countdown, a credit, a "touch
anywhere to begin" — anything a show needs to *say* rather than show.

Text is a **content source** like video or an effect, so everything that already works for content
works for it: fixtures linked to the surface sample it, projector outputs show it, a 3D venue mesh
wears it, and a timeline clip can carry it.

---

## Put text on a surface

Select a surface, then **Content ▸ Text**. Type into the box — **Enter** starts a new line, and what
you type appears as you type it.

The surface is the canvas. Text is laid out inside the surface's own rectangle and centred there, so
it keeps its proportions when the surface is resized: **Size** is a *share of the surface height*, not
a pixel count. Type that grows past the surface is cropped by it, the same way a video is.

| Control | What it does |
|---|---|
| **Font** | The typeface. See *Choosing a font* below — this is the one that bites when a show travels. |
| **Weight** / **Italic** | 100–900, and the italic cut, if the family has them. |
| **Size** | Share of the surface height. |
| **Line height** | Spacing between lines, as a multiple of the size. |
| **Tracking** | Letter-spacing. Negative tightens. |
| **Align** | Left, centre, right — or **Justify**, which sets the block flush to both edges. |
| **Wrap to the surface** | Break long lines to fit the surface instead of letting them run off it. Off by default; **Justify turns it on**. |
| **Color** / **Stroke** | Fill, and an optional outline that sits behind it. |
| **Detail** | How many pixels the type is drawn at — see *Detail and projectors*. |

Accents, ligatures and non-Latin scripts are handled for you: `Chœur`, `APRÈS` and `光の海` all shape
correctly, because the text is laid out by the same engine that draws the rest of the app.

### Wrapping and justification

By default, lines break **only where you press Enter**. That is what you want for a title: you choose
the breaks, and nothing reflows when the surface is resized.

Turn on **Wrap to the surface** and long lines break to fit instead — which is what you want for a
paragraph. **Justify** sets each line flush to both edges by sharing the slack between the words, and
it switches wrapping on for you, because justifying lines whose length *you* chose would just stretch
them across the surface.

The **last line of every paragraph is left flush**, never stretched. A two-word closing line spread
across a wall is the giveaway of justification done badly, and no typesetter does it.

Two things worth knowing:

- **The measure is the surface.** Justified text runs edge to edge of the surface rectangle, so make
  the surface the shape you want the column to be.
- **A word longer than the measure is not broken.** It takes a line of its own and overhangs, rather
  than being silently chopped — hyphenation needs a dictionary per language.

---

## Choosing a font — the part that travels badly

There are two ways to pick a typeface, and the difference only shows up at the venue.

**Naming a family** — typing a name into **Font** — uses a font installed on *this* machine. The list
that drops down is what this machine has. If the machine that actually runs the show does not have
that font, it silently draws something else, and the wall reads in the wrong face. ArtLux warns you
when the family you have named is not available *here*, but it cannot know what the venue machine has.

**Carrying the file** — **Carry it ▸ Import…** — copies a `.ttf`, `.otf`, `.woff2` or `.ttc` into the
project's `assets/fonts/`. From then on the typeface is part of the project: it travels with the
folder, **Collect Assets** consolidates it, and the Media Library flags it if it ever goes missing.

> **If the show leaves this computer, carry the file.** A named family costs nothing and is the right
> choice while you are designing. Before the show ships, import the font — it is one click and it is
> the difference between the wall reading as designed and the wall reading in Arial.

Use **Unlink** to go back to naming a family.

---

## Moving it

The **Motion** controls move the block as a whole:

| Control | Range |
|---|---|
| **Offset X** / **Offset Y** | Across the surface, as a share of its size |
| **Scale** | 0.05× to 4× |
| **Rotation** | ±180° |

Every one of them is **automatable**: drop a lane on it in the timeline, drive it from OSC, or capture
it into a cue. Fading is the surface's ordinary **Opacity** — nothing special is needed.

Type stays sharp at any scale or angle, because it is re-drawn rather than stretched. The cost is that
*moving* text is redrawn every frame while it moves; text sitting still costs nothing at all.

**The words themselves cannot be keyframed.** A timeline lane carries a number, not a string. To
change the copy during a show, capture the new wording into a **scene** and fire it as a cue — the
change lands instantly when the cue does.

---

## Detail and projectors

**Detail** is a pixel budget for the drawn type, spent in the surface's own proportions. The default
suits LED work, where fixtures sample a small area and anything finer is thrown away.

**Projector outputs ignore it and draw the type at their own full resolution.** Each projector window
re-draws the text itself rather than being sent a picture, which is exactly what keeps glyph edges
crisp on a large output — a letter's edge is where a resolution limit first becomes visible.

---

## Notes

- Text sitting still is **free**: it is drawn once and re-used until something about it changes.
- A text surface never resizes itself to fit the words. The box is your design decision; the type is
  laid out to fit it.
- Timeline clips can carry text too, so a caption can appear for a defined stretch of a show.

**See also:** [Surfaces](SURFACES.md) · [Assets and portable projects](ASSETS.md) ·
[Scenes and cues](SCENES.md)
