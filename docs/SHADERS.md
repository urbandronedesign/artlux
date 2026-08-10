# Shaders — GPU generative content on a surface

A **shader** surface draws its picture from a small program that runs on the graphics card, once per
pixel, every frame. Nothing is decoded and nothing is loaded: the picture is *computed*, so it never
loops, never runs out, and costs no disk.

It behaves like any other content. Fixtures sample it, projector outputs show it, opacity and slices
work on it, and it needs no media, no network and no hardware.

> **What you can do today:** choose a built-in shader, edit its code in ArtLux, give it your own
> parameters, drive those from the timeline, OSC or the state machine, and give it trails.
> **Still to come:** sound-reactive inputs, and a library of effects that carries across projects.

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
| **Palette wave** · LED | Bands of one of ArtLux's gradients sweeping along the surface | LED tape — and the worked example of a shader with **knobs** |
| **Comet trails** | A head wandering the surface, leaving a long fading tail | Projection — and the worked example of **feedback** |

The `· LED` mark is the important one. A shader made for a projector usually looks like noise on sixty
LEDs, because a strip samples a single line across the picture: whatever varies top-to-bottom is lost,
and whatever varies left-to-right is all you get. **Strip chase** is built that way on purpose.

## Write your own

Open the **Shader** tab in the dock (Mapping workbench) with a shader surface selected. It shows that
surface's code.

**Press `Ctrl+Enter` to compile.** Nothing compiles while you type — deliberately, because a shader
that is half-written can hang the graphics card, and an editor that built every keystroke would
eventually build one. Only a shader that *builds* is saved to the project.

You write one function:

```glsl
vec4 shaderColor(vec2 uv) {   // uv runs 0..1 across the surface
  return vec4(uv.x, uv.y, 0.5, 1.0);
}
```

Available to it:

<!-- generated:shader-uniforms — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

| Name | Type | What it is |
|---|---|---|
| `iTime` | float | SHOW time in seconds. Scrubs with the timeline; holds when stopped. |
| `iWallTime` | float | free-running clock, ignores the transport. |
| `iResolution` | vec3 | render size in pixels (xy), z = 1. |
| `iAspect` | float | width / height. Use it to keep circles round. |
| `iFrame` | int | frames drawn since the shader loaded. |
| `palette` | vec3 palette(int id, float t) | sample an ArtLux gradient by index. |
| `lastFrame` | sampler2D | this shader last frame. Needs REQUIRES_LAST_FRAME in the header. |

<!-- /generated:shader-uniforms -->

A shader pasted from Shadertoy — one that defines `mainImage(out vec4, in vec2)` — runs as-is. What
does not carry over: multi-pass shaders (Buffer A/B/C/D), `iChannel` textures, and `iMouse`.

## Give it knobs

A number written into the code is a number only you can change, in an editor, with a recompile.
**Declare it instead** and it becomes a control in the inspector — *and* a timeline lane, an OSC
address and a state-machine value, all at once.

Declarations go in a JSON block at the top of the file:

```glsl
/*{
  "TITLE": "Palette wave",
  "INPUTS": [
    { "NAME": "speed", "LABEL": "Speed",   "TYPE": "float",   "MIN": -2, "MAX": 2, "DEFAULT": 0.35 },
    { "NAME": "pal",   "LABEL": "Palette", "TYPE": "palette", "DEFAULT": 1 }
  ]
}*/
vec4 shaderColor(vec2 uv) {
  return vec4(palette(pal, fract(uv.x + iTime * speed)), 1.0);
}
```

Each `NAME` becomes a variable your shader can just use. The built-in **Palette wave** shader is a
worked example — open it and read its header.

| TYPE | Control | Automatable |
|---|---|---|
| `float` | slider + number box | yes |
| `bool` | checkbox | yes |
| `long` | dropdown (give it `LABELS`) | yes |
| `palette` | ArtLux's own gradients, sampled with `palette(id, t)` | yes |
| `color` | colour picker (a `vec4`) | not yet — a lane carries one number |
| `point2D` | two number boxes (a `vec2`) | not yet |

Anything else — `image` above all — is **refused by name** in the inspector rather than ignored, so a
header that will not do what its author expects says so.

**Values live on the surface, not in the code.** The header declares the knob and its default; where
you set it is remembered per surface. Editing and recompiling a shader never resets a show, and two
surfaces can run the same shader at different settings.

**An automation lane wins while it is running, and gives the control back when it stops.** Turning a
lane off snaps the parameter to whatever you set by hand — not to wherever the curve happened to end.

## Trails, decay, and anything that remembers

Add `"REQUIRES_LAST_FRAME": true` to the header and your shader is handed its own previous frame as
`lastFrame`. Read it, fade it, draw on top:

```glsl
vec3 prev = texture(lastFrame, uv).rgb * decay;  // decay 0.96 ≈ a long tail, 0.80 ≈ a short one
return vec4(max(prev, myNewPixels), 1.0);
```

That is the whole mechanism behind trails, motion blur, decay and reaction-diffusion. The built-in
**Comet trails** shader is the worked example.

A shader only ever sees **its own** past, never another surface — which is what keeps it simple and
predictable. Two surfaces running the same shader keep separate histories, so they never bleed into
one another.

One thing to expect: **resizing the surface clears the trail.** The history buffer is re-made at the
new shape, and inventing pixels the shader never drew would be worse than a one-frame reset.

**Reset** puts the built-in shader back, so an experiment is never a one-way door.

### Three things that will not let you break the show

- **A broken edit keeps the last picture.** Compile errors appear in the gutter and below the code,
  and the surface goes on running the last version that built. Only a shader that has *never* built
  shows black.
- **Loops that cannot end are refused** before the graphics card ever sees them — `while (true)` with
  no `break`, `for(;;)`, a `for` that never advances. This catches the accident, not the determined;
  it is not a sandbox.
- **A shader that is too slow disables itself.** If one surface runs over budget for a second solid,
  it keeps its last picture and reports the fault rather than dragging the whole show down. Simplify
  it or lower **Detail**, then compile again to bring it back.

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
