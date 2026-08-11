# Shaders — GPU generative content on a surface

A **shader** surface draws its picture from a small program that runs on the graphics card, once per
pixel, every frame. Nothing is decoded and nothing is loaded: the picture is *computed*, so it never
loops, never runs out, and costs no disk.

It behaves like any other content. Fixtures sample it, projector outputs show it, opacity and slices
work on it, and it needs no media, no network and no hardware.

> **What you can do today:** choose a built-in shader, edit its code in ArtLux, give it your own
> parameters, drive those from the timeline, OSC or the state machine, give it trails, and save it to
> a library that carries across projects, and make it react to sound.

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
| **Spectrum** · LED | Sixteen bars rising with the music, coloured by a palette | LED tape — and the worked example of **sound** |
| **Beat quads** | Four panels, each flashing on its own drum: kick, snare, mid, hats | Projection — and the worked example of **beats** |

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
| `iAudio` | float[16] | the sound, low to high, each 0..1 and already smoothed. |
| `iAudioLevel` | float | the whole spectrum averaged: overall energy, 0..1. |
| `iBeat` | float[4] | kick, snare, mid, high. 1 on the beat, falling back to 0. |
| `iBeatCount` | float[4] | beats counted per channel. Step something on every kick. |

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
| `beatDamp` | a slider in seconds that damps THIS shader's `iBeat` values | yes |
| `color` | colour picker (a `vec4`) | not yet — a lane carries one number |
| `point2D` | two number boxes (a `vec2`) | not yet |

Anything else — `image` above all — is **refused by name** in the inspector rather than ignored, so a
header that will not do what its author expects says so.

**Values live on the surface, not in the code.** The header declares the knob and its default; where
you set it is remembered per surface. Editing and recompiling a shader never resets a show, and two
surfaces can run the same shader at different settings.

**An automation lane wins while it is running, and gives the control back when it stops.** Turning a
lane off snaps the parameter to whatever you set by hand — not to wherever the curve happened to end.

## Build one without writing code — the node editor

**Shader Nodes** (a tab in the dock, next to **Shader**) builds the same shaders by wiring boxes
together. It is not a second kind of content: the graph **generates GLSL**, and everything downstream —
the parameter knobs, the automation lanes, the library, the projector — sees an ordinary shader and
never learns a graph was involved.

The loop is short:

1. **Select a shader surface.** The editor edits whatever is selected; with nothing selected it says so.
2. **Double-click empty canvas to add a node** — or press `Tab`. The menu opens at the cursor showing
   the **eleven categories** and how many nodes are in each; pick one and it lists that category's
   nodes, with `←` (or the breadcrumb) to go back. **Typing searches every category at once**, however
   deep you are, because the node you cannot find is usually filed somewhere you did not expect. `↑`/`↓`
   move, `Enter` opens a category or takes a node. The node lands where you opened the menu, so you
   point at the space you want it in. Double-clicking a *node* does not open the menu; that is a
   different gesture.
3. **Drag from an output dot to an input dot.** Dots are coloured by type — a `vec2` will not drop onto
   a `float` port, and an illegal wire simply refuses to land. Dropping a wire on an input that already
   has one **replaces** it; that gesture means "rewire", not "mistake".
4. **Or drop the wire on empty canvas.** The menu opens listing only the nodes that can receive it —
   *takes vec2* when the wire came out of an output, *makes vec3* when it came out of an input — with
   exact type matches above the ones that would need a conversion. Pick one and it is added **and
   wired** in a single step. **Show all** drops the filter if you want something else after all.
5. **Type into any unconnected number field** to set it. Wire something into that port and the field
   disappears, because the wire now decides the value.
6. **Everything reaches `Output`.** Every graph has exactly one — `color` (a `vec3`) and `alpha`.

**The surface updates as you wire, but only from a graph that builds.** Half of a graph is invalid while
a wire is in mid-air, so a graph that does not generate or does not compile leaves the wall showing the
last good picture and puts the reason in the footer. You cannot break a running show by dragging.

**The graph is saved on the surface** alongside the generated code, so reopening the project reopens the
graph exactly as you left it. The reverse is not offered: a shader you typed by hand opens the node
editor **empty**, because turning code back into a graph is decompilation, not editing.

**Tidy** arranges the whole graph: every node is placed in a column according to what feeds it, so the
picture reads left to right and ends at `Output`. Nodes you have added but not wired to anything are
parked together past the output, where they read as "not in the graph yet". **Fit** frames everything
without moving a node.

**To remove a wire**, click it — it turns accent-coloured — and press `Delete`. Or grab it near the end
and drop it on empty canvas, which is the same move without the selecting. Dropping that end on another
port rewires it instead.

Delete removes selected nodes and any wires that touched them. Mouse wheel zooms; **dragging on empty
canvas draws a selection box**, and **middle-drag** (or right-drag) pans. Where you put a node is part
of the graph and is saved with it, so a layout you arranged by hand comes back as you left it.

| Key | Does |
|---|---|
| `Tab` | opens the node menu at the pointer |
| `Enter` in the node menu | opens the highlighted category, or adds the highlighted node |
| `←` / `Backspace` in the node menu | back out of a category (`Backspace` only with an empty search) |
| `Escape` in the node menu | closes it |
| `Ctrl+C` / `Ctrl+V` | copy the selected nodes and paste them, wires between them included |
| `Ctrl+D` | duplicate the selection in place |
| drag on empty canvas | select a box of nodes |
| `Space`+drag | pan the canvas — works with any mouse or trackpad |
| middle-drag / right-drag | pan the canvas |
| two-finger scroll (macOS) | pan · `⌘`+scroll zooms. On Windows the wheel zooms. |
| `Ctrl+G` | collapse the selected nodes into one reusable node |
| `Ctrl+Shift+G` | expand a subpatch back onto the canvas |
| `Delete` | remove the selected nodes and wires |
| click a wire | select it (accent-coloured), then `Delete` removes it |
| drag a wire's end onto empty canvas | remove that wire |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo and redo, on ArtLux's ordinary document history |

Pasted nodes are copies, not links, and a pasted **parameter** is given its own name — two knobs called
the same thing would be one uniform declared twice, which compiles to nothing at all. `Output` never
copies: every graph has exactly one. A copied selection can be pasted into a **different** surface's
graph, which is the quickest way to reuse part of something you have already built.

### Make your own node — collapse a selection

**Drag a box** across the canvas to select the nodes you want — a plain left-drag, no modifier — then
press `Ctrl+G` (or **Collapse**). `Shift`+click adds a node to the selection, and the box catches
anything it touches rather than only what it swallows whole. They become **one node** with the inputs and outputs the selection had: a wire that came
into the selection is an input pin, a wire that left is an output pin. **Expand** (`Ctrl+Shift+G`)
puts the contents back.

The new node is a real node type for this project: rename it in the inspector, and add more copies
from the node menu under **Subpatch**. Each copy is independent — its own values, its own knobs.

**The shader does not change when you collapse.** A subpatch is expanded before the code is
generated, so the GLSL is identical to the flat version and the wall does not flicker: collapsing a
patch that works cannot break it. It also costs nothing to render — there is no such thing as a
"subpatch" by the time the graphics card sees it.

**The definition travels with the project**, like your shader code does. A project opened on a venue
machine carries the subpatches it uses, whether or not that machine has ever seen them.

**One thing to know before collapsing a knob.** A parameter's name is also its automation address, and
every copy of a subpatch needs its own — so a parameter that goes inside gets a new address, and any
timeline lane or OSC send aimed at the old one stops matching. ArtLux says which knobs are affected
and asks before doing it.

**Go inside it** by double-clicking it, or with **Inside** in the toolbar. You are then editing the
definition, so **every copy in the project follows** — that is what a subpatch is for. A breadcrumb
above the canvas shows where you are; click **Surface** (or press `Escape`) to come back out.

Inside, the pins appear as small **In ·** and **Out ·** nodes wired to whatever they feed. They are
real nodes: rewire one and the pin moves with it, so changing what a subpatch takes is the same
gesture as any other wiring.

**Save** puts it in this machine's library, and it then appears in the node menu under **Library** in
*any* project. Adding it from there **copies the definition in** — like an effect, and for the same
reason: a project must carry everything it needs, because the venue machine has its own library or
none at all. The cost is the honest one: editing the library copy does not change shows already built
with it.

`Output` cannot go inside a subpatch: it is what the surface draws.

### Learn it by taking a patch apart

**Examples** in the toolbar opens six **help patches**. Each one is an ordinary graph, so it arrives
on the surface fully editable: read the wires, change a number, pull one out and see what breaks.
Opening one replaces what is on the surface, and it asks first if there is anything to lose.

| Patch | What it teaches |
|---|---|
| **1 · Coordinates are colour** | Every shader starts with UV — *where am I on the surface* — and turns that into a colour. |
| **2 · Make it move** | An LFO is the clock of a patch: wire it into any number and that number breathes. |
| **3 · Trails with Last frame** | Feedback. `Last frame` reads what this shader drew a frame ago; dim it, draw on top, and motion leaves a tail. |
| **4 · Follow the music** | `Audio band` gives one number per frequency band. Here it is the height of a bar. |
| **5 · Noise, and how to read it** | Noise is a number per point. Scaling the coordinates sets its size; moving them makes it drift. |
| **6 · Warp space with noise** | Noise fed back into the coordinates of more noise — one wire, and the field starts to flow. |

**Reading the feedback patch** (the one worth studying):

- **`Last frame` samples in 0..1 space, from the raw UV** — not from the centred coordinates the shapes
  use. It is a texture lookup: hand it centred (-0.5..0.5) coordinates and most of the picture is off
  the edge, which reads as "feedback is broken" rather than as a wrong lookup.
- **`Brightness` at 0.94 is the decay,** and it is the whole tail. Take it to 0.99 and the trail runs
  for seconds; take it to 0.8 and there is barely a smear. Anything at or above 1.0 never fades, so the
  picture fills in and whites out — that is worth doing once, to see it.
- **`Mix colours` draws the head over the tail,** with the circle's fill as the blend amount: 0 keeps
  the faded frame, 1 paints the new colour.
- The graph asks for feedback **by using the node** — `REQUIRES_LAST_FRAME` appears in the generated
  header on its own. There is nothing to switch on.

**Reading the noise patches:**

- **Scale is the control that matters first.** Noise fed raw 0..1 coordinates is *one smooth blob* —
  you are looking at a single cell of it. `Scale` at 4 shows the field; at 40 it is static.
- **Noise does not drift by itself.** It is a function of position, so nothing moves until the
  coordinates do: patch 5 slides them with a slow saw LFO. `Value noise 3D` is the other way — wire
  time into its `z` and the field evolves *in place* instead of sliding past.
- **`Remap` before the palette.** fBm rarely uses its whole range, so mapping 0.25..0.75 onto 0..1
  stops the gradient being sampled from a thin slice in the middle.
- **The warp is the whole trick in patch 6:** two noise lookups become an x and a y offset, that offset
  moves the coordinates, and a third noise is read at the moved position. Its **Warp** knob is a
  parameter node, so it is also a timeline lane — turn it to 0 for plain noise, to 1 for soup.
  The second lookup is deliberately offset (`5.2, 1.3`); reading the *same* noise for both x and y
  moves every point along the diagonal, which reads as a slide rather than as flow.

### The inspector

Select a node and the column on the right of the canvas shows what it is: its name, the one-line
explanation from the palette, its settings, and every input port with either the value it is using or
the node driving it. A port fed by a wire shows **← where it comes from** instead of a field, because a
number you can type into that a wire overrules is a control that teaches you not to trust the panel.

Settings that change *what a node is* — an LFO's waveform — also sit on the node itself, so a graph can
be read without opening anything. Names, ranges and defaults live only in the inspector, which is what
keeps a node 148px wide no matter how many settings it gains.

### Renaming a parameter

Select a **Float parameter** or **Palette parameter** node and edit **Name** in the inspector. That name
is what you see everywhere the knob appears: the surface inspector, the timeline's target picker, the
lane header. It commits when you leave the field or press Enter — Escape puts the old one back.

**Renaming does not move the parameter.** Underneath, the knob keeps the fixed *code name* the inspector
shows below the field (`value_1` and the like), and that is what the generated GLSL, the automation path
and the OSC address use. So a timeline lane recorded before the rename still drives the knob after it —
only the wording changed. It is also why two parameters can never collide by being called the same thing.

### Every node

<!-- generated:shader-nodes — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

**Input**

| Node | What it does | Also found by |
|---|---|---|
| **UV** | 0..1 across the surface. x left→right, y bottom→top. | — |
| **Time** | Show time in seconds — scrubs with the timeline and holds when stopped. | — |
| **Wall time** | Free-running clock that ignores the transport. | — |
| **Aspect** | Surface width ÷ height. Multiply centred x by it to keep circles round. | — |
| **Last frame** | This shader’s previous output — the only legal feedback. Needs the graph to request it. | — |

**UV**

| Node | What it does | Also found by |
|---|---|---|
| **Centre** | Move the origin to the middle and correct for aspect, so shapes are not stretched. | — |
| **Scale** | Zoom the coordinate space. Bigger scale means more of the pattern in the same area. | — |
| **Translate** | Slide the coordinates. Wire an LFO in to make the whole pattern drift. | — |
| **Rotate** | Turn the coordinate space. Rotate around the centre by centring first. | — |
| **Tile** | Repeat space. `cell` is which tile you are in, `uv` is where inside it. | — |
| **Polar** | Radius and angle instead of x and y — stripes become rings and rays. | — |
| **Kaleidoscope** | Fold the angle into N mirrored segments. | — |
| **Pan** | Scroll the coordinates over time. Unreal calls this Panner. | — |
| **Spin** | Rotate the coordinates over time. Unreal calls this Rotator. | — |
| **Mirror** | Fold space about the centre, so one half is the reflection of the other. | — |
| **Pixelate** | Snap the coordinates to a grid — big soft blocks, and cheaper detail. | — |

**Math**

| Node | What it does | Also found by |
|---|---|---|
| **Add** | a + b | — |
| **Multiply** | a × b | — |
| **Subtract** | a − b | — |
| **Divide** | a ÷ b, guarded against zero. | — |
| **Mix** | Blend a and b by t (0 = a, 1 = b). | — |
| **Switch** | Choose a or b. Below 0.5 takes a, above takes b — no blending in between. | — |
| **Clamp** | Keep a value inside a range. | — |
| **Smoothstep** | A soft 0→1 ramp between two edges. | — |
| **Step** | A hard cut: 0 below the edge, 1 above. Antialiased. | — |
| **Remap** | Move a value from one range to another. | — |
| **Fract** | The part after the decimal point — a sawtooth. | — |
| **Abs** | Distance from zero. Folds a signed value. | — |
| **Power** | x^k — above 1 sharpens, below 1 softens. | — |
| **One minus** | Invert a 0..1 value. | — |
| **Min** | The smaller of two values. On shapes: union. | — |
| **Max** | The larger of two values. On shapes: intersection. | — |
| **Length** | Distance from the origin to a point. | — |
| **Split** | Take a vector apart into x and y. | — |
| **Combine** | Build a vector from two numbers. | — |
| **Sine** | sin of a value, in TURNS — 1 is a full cycle, so no π anywhere. | — |
| **Cosine** | cos of a value, in turns. A quarter-turn ahead of Sine. | — |
| **Angle of** | The direction of a vector, 0..1 turns. atan2, without the sign traps. | — |
| **Floor** | Down to the whole number below. Quantise a value into steps. | — |
| **Round** | To the nearest whole number. | — |
| **Modulo** | The remainder of x ÷ n. Fract with a divisor of your own. | — |
| **Sign** | −1 below zero, 0 at zero, 1 above. | — |
| **Square root** | Also how you soften a falloff without a curve editor. | — |
| **Saturate** | Clamp to 0..1 — the clamp you reach for nine times out of ten. | — |
| **Distance** | How far apart two points are. Length measures from the origin; this measures between. | — |
| **Dot product** | How much one direction points along another. Gradients and lighting-style falloffs. | — |
| **Normalise** | Keep a direction, drop its length. | — |
| **Bias · scale** | Add, then multiply. The one-node way to turn −1..1 into 0..1 (bias 1, scale 0.5). | — |
| **Greater than** | 1 when a is above b, 0 when it is not. Feed it into Switch to make a decision. | — |

**LFO**

| Node | What it does | Also found by |
|---|---|---|
| **LFO** | A slow oscillator: sine, triangle, saw or square. Rate in cycles per second. | — |
| **Pulse** | A one-shot ramp that falls from 1 after each trigger — an envelope, not a wave. | — |

**Pattern**

| Node | What it does | Also found by |
|---|---|---|
| **Grid** | Square tiles with a gap. Outputs the tile mask and a per-cell random value. | — |
| **Lines** | Repeating stripes, antialiased to one pixel at any resolution. | — |
| **Checker** | The other classic tiling. 0 or 1 per square. | — |

**Noise**

| Node | What it does | Also found by |
|---|---|---|
| **Value noise** | Soft blobs. The cheapest real noise. | — |
| **Value noise 3D** | Wire time into z and the field evolves in place instead of sliding past. | — |
| **Gradient noise** | Perlin. Rolling and organic; signed, so remap before using as brightness. | — |
| **Simplex noise** | Like Perlin without the square-grid bias. The better default. | — |
| **fBm** | Layered noise — detail at every scale. Octaves multiply the cost. | — |
| **Turbulence** | fBm folded at zero: creases. Fire and marble. | — |
| **Ridged** | Inverted folds: sharp crests. Mountains. | — |
| **Worley** | Cells. F1 is bubbles, F2−F1 is the walls between them. | — |
| **Curl** | A flow field that never bunches up. Wire it into Translate to advect. | — |
| **Seamless** | Noise that repeats exactly — for a strip that loops or panels that tile. | — |

**Shape**

| Node | What it does | Also found by |
|---|---|---|
| **Circle** | Signed distance to a circle: negative inside, zero on the edge. | — |
| **Box** | Signed distance to a rectangle. | — |
| **Fill** | Turn a distance into a solid shape, softly. | — |
| **Outline** | Turn a distance into an outline of a given thickness. | — |
| **Cut out** | Cut b out of a. (min is union, max is intersection.) | `subtract`, `difference`, `boolean`, `carve` |

**Audio**

| Node | What it does | Also found by |
|---|---|---|
| **Audio band** | One of 16 frequency bands, low to high, already smoothed. | — |
| **Audio level** | Overall energy — the whole spectrum averaged. | — |
| **Beat** | 0 kick · 1 snare · 2 mid · 3 high. 1 on the hit, falling back to 0. | — |

**Parameter**

| Node | What it does | Also found by |
|---|---|---|
| **Float parameter** | A slider in the inspector, and a timeline lane. | — |
| **Palette parameter** | A palette picker, and the gradient it selects. | — |

**Colour**

| Node | What it does | Also found by |
|---|---|---|
| **Palette** | Sample one of ArtLux’s gradients by index. | — |
| **Mix colours** | Blend two colours by t. | — |
| **Switch colour** | Choose colour a or b. Below 0.5 takes a, above takes b. | — |
| **Brightness** | Scale a colour. | — |
| **Luminance** | How bright a colour reads to the eye, as one number. | — |
| **Saturation** | Pull a colour towards grey (0) or push it past its own (>1). | — |
| **Hue shift** | Rotate a colour around the wheel, in turns. The knob a VJ reaches for first. | — |
| **Contrast** | Push values away from mid grey (>1) or towards it (<1). | — |

**Output**

| Node | What it does | Also found by |
|---|---|---|
| **Output** | What the surface shows. Every graph has exactly one. | — |

<!-- /generated:shader-nodes -->

**[SHADER-NODES.md](SHADER-NODES.md) is the full reference**: every node with its ports, its
defaults, what it is for, and the GLSL it actually emits.

This is the whole list, and the node menu searches it — by name, by category, by description **and by
the other names for the same thing**. Type `lerp` and you get **Mix**; `voronoi` gets **Worley**,
`perlin` gets **Gradient noise**, `feedback` gets **Last frame**, `fft` gets **Audio band**. The row
shows which word matched, so a hit that looks surprising explains itself. You never have to remember
which group a node is in, or which name ArtLux happens to use for it.

**Parameter** nodes are the bridge to everything else in ArtLux: one becomes a knob in the inspector
with the name you give it, and therefore a timeline lane, an OSC address and a state-machine target —
exactly as if you had declared it in a header by hand. A parameter that drives nothing declares
nothing; wire it into the graph and the knob appears.

### Saving a graph, and leaving one behind

**Save current** stores a graph effect with its graph inside. Apply it to another surface and the node
editor opens the graph, not just the code — the same effect, editable the same way. An effect saved
from the code editor has no graph, and applying it to a surface that had one **clears** it, because a
graph left behind describes a shader that is no longer there.

**Convert to code** is the one-way door. It hands the generated GLSL to the **Shader** tab and discards
the graph, after asking — there is no way back, because reading code into a graph is decompilation.
Two other actions do the same thing from the other side, and for the same reason: compiling by hand in
the code editor, and choosing a different built-in from the **Shader** dropdown. Two authors cannot own
one shader — leave the graph in place and the next node you touch regenerates over everything you typed.

## Your effect library

An effect written for one show is a building block in the next. The **Effects** panel in the browser
column is where they live.

- **Save current** stores the selected surface’s shader — its code, its parameter values, and a
  thumbnail — under the surface’s name.
- **Click a card** to apply that effect to whichever surface is selected.
- **Folder** opens the library on disk. Each effect is one folder holding `shader.frag`,
  `values.json` and `thumbnail.png`, so sharing one with somebody is copying a folder.

The library lives with your ArtLux install, not inside any project — that is what lets it follow you
from show to show.

### Applying copies, it does not link

When you apply an effect its **code is copied into the surface**. Two things follow, and both are
deliberate:

- **A project carries its own shaders.** Open it on a venue machine with an empty library and it
  still renders exactly what you built. There is no missing-file state to discover on the night.
- **Editing a library effect does not change shows that already used it.** A show that worked last
  night works tonight. To update an older project, apply the effect again there.

## Make it react to sound

Every shader can read what is playing. Nothing to declare and nothing to switch on:

```glsl
vec4 shaderColor(vec2 uv) {
  float bass = iAudio[1];        // 16 bands, low to high, each 0..1
  float energy = iAudioLevel;    // the whole spectrum averaged
  return vec4(vec3(bass), 1.0);
}
```

The bands are the **mixed output** — everything ArtLux is playing, after the master effects and the
master fader, which is what the room hears. Band 0 is the low end, band 15 the top.

They are already **smoothed**: each band rises almost instantly and falls over about a quarter of a
second. That is what makes a visual pulse with a hit rather than flicker on it, and it means you can
use the value directly instead of building your own follower.

The built-in **Spectrum** shader is the worked example.

### What the numbers mean

- **0 is silence and 1 is full scale**, on a 60 dB scale — so a quiet passage sits low rather than
  filling the screen with noise, and a loud one reaches the top instead of clipping at half.
- **The bands are spaced by ear**, not evenly: each is about a third wider than the one below it, so
  the low end gets as much of the picture as the top does.
- **The lowest four bands move together.** Resolving 40 Hz from 58 Hz needs a longer listen than a
  visual can afford to lag by, so the bottom of the range reports bass energy rather than four
  independent notes. Above roughly 200 Hz every band is its own.

**No sound, no motion.** If the machine has no audio device, or nothing is playing, every band reads
0 and an audio-reactive shader is simply dark. That is the shader working, not failing.
### Beats, not just level

Four channels watch for **hits** rather than loudness:

| | Channel | Listens to | Usually |
|---|---|---|---|
| `iBeat[0]` | kick | 40–180 Hz | the kick drum, bass notes |
| `iBeat[1]` | snare | 180–550 Hz | snare, toms, low vocals |
| `iBeat[2]` | mid | 550 Hz–3.5 kHz | guitars, keys, vocal presence |
| `iBeat[3]` | high | 3.5–16 kHz | hats, cymbals |

Each one goes to **1 the instant it fires** and falls back to 0 over about a quarter second, so you
can use it directly as a flash:

```glsl
vec3 col = base + vec3(1.0) * iBeat[0];   // white flash on every kick
```

And `iBeatCount[4]` counts them, which is how you change something **once per hit** instead of once
per frame:

```glsl
vec3 col = palette(pal, fract(iBeatCount[0] * 0.137));   // a new colour on every kick
```

The built-in **Beat quads** shader is the worked example — one panel per channel.

**A beat is not "loud", it is louder than the last second was.** Each channel compares its energy
against its own running average, and how far above it has to be adapts to how busy the music already
is. So a steady tone never fires however loud it is, a held chord fires once at the front rather than
continuously, and the same shader works on a sparse dub track and a wall of guitars without retuning.

What it will not do: keep time. There is no tempo, no bar and no downbeat here — a channel reports
that something hit, not where you are in the music.
### Damping — the one setting that decides whether it feels right

Sound-reactive values are judged by how long they take to **let go**. Too short and a kick is a
strobe; too long and the room never goes dark between hits. The right number depends on the music and
on the size of what you are lighting — a wall wants a slower fall than a strip.

So it is a knob, in **Preferences → Shaders**:

- **Beat fall** — how long a beat flash takes to fade. Default 0.25 s.
- **Spectrum fall** — how long the sixteen bands take to come back down. Default 0.25 s.

Both take effect immediately, so set them with the music playing. They apply to every shader on the
machine, and they are machine settings rather than project ones — the same show in a bigger room
deserves a different fall — so they do not travel with the project.

Neither affects how a beat is *detected*, only how long its pulse lives afterwards.
#### Damping one shader rather than the machine

Declare a `beatDamp` input and that shader gets its own beat fall, with a slider in the inspector
next to its other parameters:

```glsl
/*{ "INPUTS": [
  { "NAME": "damp", "LABEL": "Beat damping", "TYPE": "beatDamp", "MIN": 0.05, "MAX": 2.0, "DEFAULT": 0.25 }
] }*/
```

Nothing else changes — `iBeat[c]` is read exactly as before, it simply decays at the rate that
slider says. Two surfaces can react to the same kick at very different speeds, and because it is an
ordinary parameter it travels with the project and can ride a timeline lane.

A shader that declares none uses **Preferences → Shaders ▸ Beat fall**, the machine default. The
built-in **Beat quads** declares one, so it is the quickest place to feel the difference.
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

For a **projector output**, Detail does not apply at all: the output draws the shader again at its
own display's full resolution. A 4K projector gets a 4K picture whatever this control says, and there
is nothing to raise. The shader is not copied from the editor to the projector — the *code* is, and
each screen draws it at the size it needs.

So Detail is only about the picture the editor and your fixtures see. Bigger costs GPU time, and a
shader is drawn every frame: on a modest laptop GPU a shader costs roughly a tenth of a millisecond
at 720p and about ten times that at 1080p. Ten shader surfaces at 720p is still a small fraction of a
frame; ten at 1080p is not. There is rarely a reason to leave 720p.

**How high the list goes depends on the graphics card.** A machine with a discrete GPU — which is what
a machine driving projectors has — is offered **1440p and 2160p** as well; one running on integrated
graphics stops at 1080p and says so under the control, naming the card it found. That is not a
judgement about speed, which the frame budget already handles: a 4K shader buffer **killed the graphics
process outright** on an integrated Intel part during development, twice, taking every shader on the
wall with it. A card that cannot be identified is treated as the cautious case.

**A project keeps the Detail it was saved with.** Open one authored at 2160p on a laptop and the
control still shows 2160p rather than quietly reinterpreting your work — it renders at what it says on
the machine that can.

## In a show launch

Started with `--broadcast`, ArtLux runs your shaders and shows them on the outputs, with **no editor
and no library** — there is no operator at that machine and nothing should be compiling while a show
is on. Everything you built is already in the project.

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
