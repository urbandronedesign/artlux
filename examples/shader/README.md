# Shader examples — GPU generative content

Two projects showing **shader surfaces**: content computed on the graphics card every frame instead of
decoded from a file. Both are **portable and media-free** — no assets, no network, no hardware — and
output is aimed at `127.0.0.1` (loopback), so opening one transmits nothing to real fixtures until you
repoint it.

Reference: [`docs/SHADERS.md`](../../docs/SHADERS.md).

To open: **File ▸ Open…** (`Ctrl+O`) and pick the `.artlux` file. **Save As…** to keep any edits, so
the originals stay pristine.

| Project | What it shows |
|---|---|
| **`01-three-shaders.artlux`** | All three built-in shaders side by side — Plasma, Rings and Strip chase — each with its own 60-LED strip sampling it, on universes 0, 1 and 2. |
| **`02-shader-to-leds.artlux`** | One shader (Strip chase) across a long 120-LED run, drawn at **360p on one surface and 1080p on another**. The two strips look the same. |

## 01 · Three shaders, three strips

Open it and press play. Three surfaces, each running a different shader, each with a strip beneath it.

**What to look for:** the two projection shaders (Plasma, Rings) fill their surface with something
that reads as a picture, while **Strip chase** looks almost trivial on screen — a bright dot with a
tail, and nothing at all varying top to bottom. Now watch the strips. The chase is the one that reads
*perfectly* on LEDs, and the two rich ones are the ones that turn into vague colour wash.

That is the whole lesson of shaders on fixtures: **a strip samples one line across the picture.**
Anything that varies up the surface is thrown away; only variation along it survives. Build for the
output you actually have.

**Then try:** select a surface, and switch its shader in the inspector. Watch its strip change.

## 02 · The same shader at two sizes

Two surfaces, the *same* shader, drawn at 360p on the top one and 1080p on the bottom one, with an
identical 120-LED strip on each.

**What to look for:** the strips match. A strip of 120 LEDs reads 120 colours no matter how big a
picture it was given, so the extra pixels are computed and then discarded — a shader surface feeding
fixtures should stay small. Raise the size for surfaces you actually **project**, where the picture's
detail is what an audience sees.

**Then try:** set the top surface to 1080p as well and watch nothing change on its strip — while the
GPU quietly does about ten times the work for it.

## Stopped shaders are not broken shaders

A shader follows **show time**, so it holds still when the transport is stopped and scrubs when you
scrub. That is what makes it repeatable — the same point in a show draws the same frame on every
machine — and it is also why a shader can look dead the moment you open a project. Press play.
