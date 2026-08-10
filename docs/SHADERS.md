# Shaders — GPU generative content on a surface

A **shader** surface draws its picture from a small program that runs on the graphics card, once per
pixel, every frame. Nothing is decoded and nothing is loaded: the picture is *computed*, so it never
loops, never runs out, and costs no disk.

It behaves like any other content. Fixtures sample it, projector outputs show it, opacity and slices
work on it, and it needs no media, no network and no hardware.

> **What you can do today:** choose one of the built-in shaders and its render size. **Writing your
> own** — an editor inside ArtLux, your parameters on the timeline, and a library of effects you build
> up across shows — is being built next. The examples below run right now.

## Put one on a surface

1. Select the surface.
2. In the content picker, choose **Shader**.
3. Pick a shader from the list, and a **Detail** level.

That is the whole setup. The picture starts immediately.

## The built-in shaders

| Shader | What it looks like | Best for |
|---|---|---|
| **Plasma** | Two interfering sine fields, breathing slowly in and out | Projection — a big, calm, always-moving wash |
| **Rings** | Concentric rings travelling outward from the centre | Projection — circular architecture, discs, columns |
| **Strip chase** · LED | A bright comet running left to right with a fading tail, wrapping at the ends | LED tape — everything varies *along* the strip |

The `· LED` mark is the important one. A shader made for a projector usually looks like noise on sixty
LEDs, because a strip samples a single line across the picture: whatever varies top-to-bottom is lost,
and whatever varies left-to-right is all you get. **Strip chase** is built that way on purpose.

## The picture takes the surface's shape

A shader has no natural size or shape of its own — it fills whatever it is given. So it is drawn at
**your surface's proportions**: a tall surface gets a tall picture, a wide one gets a wide picture, and
circles stay circles in both. Nothing is stretched, and there are no bars.

What changes with the surface's shape is *how much you see*: **Rings** on a tall surface shows the
middle band of its rings, the same way a tall crop of any picture would. Resize the surface and the
picture re-draws to fit.

## Detail, and why the small number is usually right

**Detail** is how many pixels the shader draws before anything samples it — `720p` means "about as
many pixels as 1280 × 720", spent in whatever shape your surface actually has. The default is 720p.

For **fixtures**, more is not better and generally does nothing: a strip of 60 LEDs reads 60 colours,
so a 1080p picture is reduced to 60 samples either way. Example `02-shader-to-leds` puts the same
shader at 360p and at 1080p next to each other with identical strips on both — the strips match.

For a **projector**, size is the picture's actual detail, so raise it when the output looks soft.

Bigger costs GPU time, and a shader is drawn every frame: on a modest laptop GPU a shader costs
roughly a tenth of a millisecond at 720p and about ten times that at 1080p. Ten shader surfaces at
720p is still a small fraction of a frame; ten at 1080p is not. Start at 720p and raise the ones that
are actually projected.

## The clock: a shader follows the show, not the wall

A shader's motion is driven by **show time**. That means it does what the rest of the show does:

- **Scrub the timeline** and the shader scrubs with it.
- **Stop the transport** and the shader **holds still**.
- Two machines at the same point in the show draw the *same frame* — a shader is repeatable, which is
  what makes it safe to build a cue around.

So a shader that appears frozen is almost always a stopped transport, not a broken shader. Press play.

## Try it

Two ready-made projects in [`examples/shader/`](../examples/shader/README.md) — no media, no hardware,
output aimed at loopback:

- **`01-three-shaders`** — all three shaders side by side, each with its own LED strip.
- **`02-shader-to-leds`** — one shader across a long strip, and the render-size comparison above.

## If a shader surface is black

- **The transport is stopped.** See the clock section above — press play.
- **The shader has an error**, or this machine could not start its graphics context. The message is in
  the surface's Shader section, under the size picker. A machine with no WebGL2 support disables
  shader content entirely and says so on the startup report.
- **Opacity is at zero**, or something is drawn over it — the ordinary surface checks.

## See also

- [EFFECTS.md](EFFECTS.md) — the older built-in effects (Solid, Rainbow, Palette Flow, Wave, Fire),
  which still work and are set up the same way.
- [SURFACES.md](SURFACES.md) — surfaces, content and slicing.
- [OUTPUTS.md](OUTPUTS.md) — getting the result to fixtures.
