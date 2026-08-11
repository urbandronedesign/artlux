# Shader nodes — the complete reference

Every node in the shader **node editor**, what it is for, what it takes, and the GLSL it produces.
For how to *use* the editor — adding nodes, wiring, subpatches, the help patches — see
[SHADERS.md](SHADERS.md). For techniques written as whole shaders, see
[SHADER-COOKBOOK.md](SHADER-COOKBOOK.md).

**The code blocks are not descriptions of what a node does — they are what it emits.** Each one is
produced by calling the node's own generator with its port names standing in for whatever you wire to
it, so a node cannot be documented doing something it does not do. `${...}` never appears: what you see
is the expression that lands in your shader, with your values substituted.

## How to read an entry

- **In / Out tables** are the ports, with the value used when nothing is wired in. An unconnected
  numeric input becomes an editable field on the node itself.
- **Settings** are choices that cannot vary per pixel — an LFO's waveform, a parameter's name. They
  live in the inspector, and choices also appear on the node.
- **helper** names a function from ArtLux's shader library that the node calls; it is emitted once into
  your shader however many nodes ask for it.
- **also found by** lists the other words the node menu will answer to, so `lerp` finds Mix and
  `voronoi` finds Worley.

## Three things that hold across the whole catalogue

**Angles are in turns, never radians.** `Rotate`, `Spin`, `Polar`, `Angle of`, `Sine`, `Cosine` and an
LFO's phase all count 1 as a full cycle. There is no π in a graph, and no unit to convert between.

**Coordinates are 0..1 across the surface**, with y running bottom→top — not pixels, so a patch built
on a laptop preview looks the same on a 12 m wall. `Centre` moves the origin to the middle and corrects
for the surface's shape; nearly every patch that draws something round starts with it.

**Colours are 0..1 per channel**, and a `float` wired into a colour port fans out to all three — which
is why a mask can drive a colour input directly and comes out grey.

<!-- generated:shader-node-reference — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

**Jump to:** [Input](#input) · [UV](#uv) · [Math](#math) · [LFO](#lfo) · [Pattern](#pattern) · [Noise](#noise) · [Shape](#shape) · [Audio](#audio) · [Parameter](#parameter) · [Colour](#colour) · [Output](#output)

## Input

### UV

0..1 across the surface. x left→right, y bottom→top.

The start of almost every graph. It is 0..1 across the SURFACE, not the screen, so a patch looks the same on a 2 m strip and a 12 m wall — and y runs bottom→top, which is the opposite of most image editors.

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = uv
```

also found by `coordinates`, `position`, `texcoord`

### Time

Show time in seconds — scrubs with the timeline and holds when stopped.

Show time. It scrubs with the timeline and holds when the transport stops, so a scene recalled tomorrow looks exactly as it did tonight. Reach for Wall time only when you want motion that ignores the show.

| In | Type | Default |
|---|---|---|
| `scale` | float — a number | `1` |

| Out | Type |
|---|---|
| `time` | float — a number |

```glsl
time = (iTime * scale)
```

also found by `clock`, `seconds`, `itime`

### Wall time

Free-running clock that ignores the transport.

A clock that never stops, never scrubs and never rewinds. Right for idle and ambient looks; wrong for anything you need to reproduce on a timeline, because two playbacks will not match.

| In | Type | Default |
|---|---|---|
| `scale` | float — a number | `1` |

| Out | Type |
|---|---|
| `time` | float — a number |

```glsl
time = (iWallTime * scale)
```

### Aspect

Surface width ÷ height. Multiply centred x by it to keep circles round.

A surface is a rectangle, but uv is a unit square: a circle drawn in raw uv comes out as an ellipse. Multiplying centred x by this fixes it. Centre already does this, so you rarely need the node itself.

| Out | Type |
|---|---|
| `aspect` | float — a number |

```glsl
aspect = iAspect
```

also found by `ratio`

### Last frame

This shader’s previous output — the only legal feedback. Needs the graph to request it.

The only legal feedback in a shader — a graph that loops back on itself is refused, because that is an infinite loop the GPU cannot see. Sample it with the RAW uv, in 0..1 space: hand it centred (−0.5..0.5) coordinates and most of the picture is off the edge, which reads as "feedback is broken". The graph asks for the previous frame automatically as soon as you use this.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0.5, 0.5` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = texture(lastFrame, uv).rgb
```

asks the shader for `REQUIRES_LAST_FRAME` · also found by `feedback`, `trails`, `buffer`, `previous`

## UV

### Centre

Move the origin to the middle and correct for aspect, so shapes are not stretched.

Moves the origin to the middle and widens x by the aspect, so distances mean the same in both directions. After it, coordinates run roughly −0.5..0.5 and shapes are round. Almost every shape patch starts here.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = ((uv - 0.5) * vec2(iAspect, 1.0))
```

also found by `center`, `origin`, `middle`

### Scale

Zoom the coordinate space. Bigger scale means more of the pattern in the same area.

Multiplying coordinates zooms the PATTERN, and the direction surprises people: a bigger scale means more repeats and a smaller pattern, because each pixel is now reading further out in the field.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `scale` | vec2 — two numbers (x, y) | `1, 1` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = (uv * scale)
```

also found by `zoom`, `size`

### Translate

Slide the coordinates. Wire an LFO in to make the whole pattern drift.

Adding to coordinates moves the sampling point, so the picture appears to move the OTHER way: +0.1 in x slides the pattern left. Wire an LFO in for drift.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `offset` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = (uv + offset)
```

also found by `move`, `offset`, `pan`, `shift`

### Rotate

Turn the coordinate space. Rotate around the centre by centring first.

Turns, not radians: 0.25 is a quarter turn. It rotates about the origin, so centre first unless you want it spinning about the bottom-left corner.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `turns` | float — a number | `0` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = rotate2(uv, turns * 6.2831853)
```

helper: `rotate2` · also found by `turn`, `spin`, `angle`

### Tile

Repeat space. `cell` is which tile you are in, `uv` is where inside it.

Repeats space. `uv` is where you are INSIDE the current tile (0..1 again) and `cell` is which tile that is — feed `cell` into a hash or a noise to make every tile different, which is the whole trick behind grids that do not look stamped.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `cells` | vec2 — two numbers (x, y) | `4, 4` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |
| `cell` | vec2 — two numbers (x, y) |

```glsl
uv = fract(uv * cells)
cell = floor(uv * cells)
```

also found by `repeat`, `grid`, `instance`

### Polar

Radius and angle instead of x and y — stripes become rings and rays.

Rings and rays instead of rows and columns. `angle` is 0..1 turns and wraps at the seam behind the surface, so a pattern that must not show a join has to be periodic in 1 — `fract` and `sin` are, a plain ramp is not.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `radius` | float — a number |
| `angle` | float — a number |

```glsl
radius = length(uv)
angle = (atan(uv.y, uv.x) / 6.2831853 + 0.5)
```

also found by `radial`, `angle`, `rings`

### Kaleidoscope

Fold the angle into N mirrored segments.

Folds the angle into N segments, so whatever you draw is mirrored around the centre. Cheap symmetry, and it makes noise look designed.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `segments` | float — a number | `6` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = rotate2(uv, -(abs(mod(atan(uv.y, uv.x), 6.2831853 / max(segments, 1.0)) - 3.14159265 / max(segments, 1.0))))
```

helper: `rotate2` · also found by `mirror`, `symmetry`

### Pan

Scroll the coordinates over time. Unreal calls this Panner.

Translate with the clock already wired in: the speed is in units per second. The same thing as Time → Translate, in one node, because scrolling is the single most common thing anyone does to coordinates.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `speed` | vec2 — two numbers (x, y) | `0.1, 0` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = (uv + speed * iTime)
```

also found by `panner`, `scroll`, `drift`, `conveyor`

### Spin

Rotate the coordinates over time. Unreal calls this Rotator.

Rotate with the clock already wired in, in turns per second: 0.25 is one revolution every four seconds.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `turnsPerSec` | float — a number | `0.1` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = rotate2(uv, turnsPerSec * iTime * 6.2831853)
```

helper: `rotate2` · also found by `rotator`, `turntable`, `rotate over time`

### Mirror

Fold space about the centre, so one half is the reflection of the other.

Folds space about the origin, so one half is the reflection of the other. Centre first, or it mirrors about the corner and you see three quarters of nothing.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = abs(uv)
```

also found by `fold`, `symmetry`, `flip`, `abs`

### Pixelate

Snap the coordinates to a grid — big soft blocks, and cheaper detail.

Snaps coordinates to a grid, so everything sampled after it comes out in blocks. Also a genuine performance trick: expensive noise read at 32×32 blocks costs the same as at full resolution but has far less to look at.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `cells` | float — a number | `32` |

| Out | Type |
|---|---|
| `uv` | vec2 — two numbers (x, y) |

```glsl
uv = (floor(uv * cells) / max(cells, 1.0))
```

also found by `quantise uv`, `blocks`, `mosaic`, `lowres`

## Math

### Add

a + b

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = (a + b)
```

### Multiply

a × b

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `1` |
| `b` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = (a * b)
```

### Subtract

a − b

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = (a - b)
```

### Divide

a ÷ b, guarded against zero.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = (a / (abs(b) < 1e-6 ? 1e-6 : b))
```

### Mix

Blend a and b by t (0 = a, 1 = b).

Linear interpolation — `lerp` in most other tools. t = 0 gives a, t = 1 gives b, and values outside that range extrapolate rather than clamp, which is occasionally what you want and usually a mistake.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `1` |
| `t` | float — a number | `0.5` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = mix(a, b, t)
```

also found by `lerp`, `interpolate`, `blend`, `crossfade`

### Switch

Choose a or b. Below 0.5 takes a, above takes b — no blending in between.

Chooses instead of blending. Under 0.5 you get a, over it you get b, with nothing in between. It is still a mix underneath: a branch per pixel is the one thing a fragment shader should not do, so `step` turns the number into a hard 0 or 1 and the blend becomes a choice.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `1` |
| `which` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = mix(a, b, step(0.5, which))
```

also found by `select`, `choose`, `if`, `toggle`

### Clamp

Keep a value inside a range.

Keeps a value between two bounds. Saturate is this with 0 and 1 already filled in, which is the case you want most of the time.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `min` | float — a number | `0` |
| `max` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = clamp(x, min, max)
```

also found by `limit`, `saturate`

### Smoothstep

A soft 0→1 ramp between two edges.

A soft edge with an ease at both ends. Use it wherever you would reach for a fade: between edge0 and edge1 it runs 0→1 on an S-curve, and outside them it is flat.

| In | Type | Default |
|---|---|---|
| `edge0` | float — a number | `0` |
| `edge1` | float — a number | `1` |
| `x` | float — a number | `0.5` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = smoothstep(edge0, edge1, x)
```

also found by `ease`, `falloff`, `soft threshold`

### Step

A hard cut: 0 below the edge, 1 above. Antialiased.

A hard edge — but antialiased. It uses the pixel's own rate of change (`fwidth`) to soften the transition by exactly one pixel, so an edge stays crisp without stair-stepping. A raw GLSL `step()` in hand-written code does not do this.

| In | Type | Default |
|---|---|---|
| `edge` | float — a number | `0.5` |
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = aaStep(edge, x)
```

helper: `aaStep` · also found by `threshold`, `cutoff`, `comparison`

### Remap

Move a value from one range to another.

Rescales one range onto another — and it CLAMPS. Values outside the input range are pinned to the output ends rather than extrapolated, which is what makes it safe to put in front of a palette.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `inMin` | float — a number | `0` |
| `inMax` | float — a number | `1` |
| `outMin` | float — a number | `0` |
| `outMax` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = remap(x, inMin, inMax, outMin, outMax)
```

helper: `remap` · also found by `range`, `fit`, `map`, `scale range`

### Fract

The part after the decimal point — a sawtooth.

The part after the decimal point, so 3.7 becomes 0.7. Turns any rising value into a repeating 0..1 ramp: it is how a moving gradient becomes a repeating one.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = fract(x)
```

also found by `repeat`, `wrap`, `modulo`, `mod`

### Abs

Distance from zero. Folds a signed value.

Drops the sign. On centred coordinates it folds space about the origin, which is where mirrored patterns come from.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = abs(x)
```

### Power

x^k — above 1 sharpens, below 1 softens.

Bends a 0..1 ramp without changing its ends. Above 1 pushes values down (a slower start), below 1 lifts them. This is the gamma knob of shader work.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `k` | float — a number | `2` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = pow(max(x, 0.0), k)
```

also found by `pow`, `gamma`, `exponent`

### One minus

Invert a 0..1 value.

Flips a 0..1 value end for end. The fastest way to invert a mask.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = (1.0 - x)
```

also found by `invert`, `negate`, `flip`

### Min

The smaller of two values. On shapes: union.

The smaller of two values. On distance fields it is the UNION of two shapes — whichever surface is nearer wins.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = min(a, b)
```

### Max

The larger of two values. On shapes: intersection.

The larger of two values. On distance fields it is the INTERSECTION: only where both shapes agree.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = max(a, b)
```

### Length

Distance from the origin to a point.

Distance from the ORIGIN to a point — so on centred coordinates it is the distance from the middle, which is where rings, radial fades and round masks all come from.

| In | Type | Default |
|---|---|---|
| `v` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = length(v)
```

also found by `distance`, `magnitude`, `radius`

### Split

Take a vector apart into x and y.

Takes a vec2 apart. `y` on raw uv is height up the surface, which is how a bar or a horizon gets made.

| In | Type | Default |
|---|---|---|
| `v` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `x` | float — a number |
| `y` | float — a number |

```glsl
x = v.x
y = v.y
```

also found by `unpack`, `components`, `xy`

### Combine

Build a vector from two numbers.

Builds a vec2 from two numbers — the other half of Split, and how two separate LFOs become one moving point.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `y` | float — a number | `0` |

| Out | Type |
|---|---|
| `v` | vec2 — two numbers (x, y) |

```glsl
v = vec2(x, y)
```

also found by `make vec2`, `pack`, `join`

### Sine

sin of a value, in TURNS — 1 is a full cycle, so no π anywhere.

In TURNS, not radians: 1 is a full cycle, so there is no π anywhere in a graph. Feed it a rising value for oscillation, or a coordinate for stripes.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = sin(x * 6.2831853)
```

also found by `sin`, `oscillate`, `wave`

### Cosine

cos of a value, in turns. A quarter-turn ahead of Sine.

Sine, a quarter turn ahead. Pair the two to move something in a circle: cos for x, sin for y.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = cos(x * 6.2831853)
```

also found by `cos`

### Angle of

The direction of a vector, 0..1 turns. atan2, without the sign traps.

The direction of a vector as 0..1 turns. This is `atan2` with the quadrant handled and the units already matching the rest of the catalogue.

| In | Type | Default |
|---|---|---|
| `v` | vec2 — two numbers (x, y) | `1, 0` |

| Out | Type |
|---|---|
| `turns` | float — a number |

```glsl
turns = (atan(v.y, v.x) / 6.2831853 + 0.5)
```

also found by `atan2`, `direction`, `arctangent`, `heading`

### Floor

Down to the whole number below. Quantise a value into steps.

Down to the whole number below, which quantises a smooth ramp into steps. Divide afterwards to get those steps back into 0..1.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = floor(x)
```

also found by `quantise`, `quantize`, `posterise`, `round down`, `int`

### Round

To the nearest whole number.

To the nearest whole number, so the step boundary sits halfway rather than at the join.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = floor(x + 0.5)
```

also found by `nearest`

### Modulo

The remainder of x ÷ n. Fract with a divisor of your own.

Fract with a divisor of your choosing. `mod(x, 4)` counts 0,1,2,3,0,1,2,3 — useful for stepping through palettes or cells.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `n` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = mod(x, n)
```

also found by `mod`, `fmod`, `remainder`, `wrap`, `repeat`

### Sign

−1 below zero, 0 at zero, 1 above.

−1 below zero, 0 at zero, 1 above. Useful for turning a signed field into a direction, and for splitting a picture in two at a threshold.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = sign(x)
```

also found by `polarity`, `direction`

### Square root

Also how you soften a falloff without a curve editor.

Also how you soften a falloff without a curve editor: the square root of a 0..1 ramp rises fast and then eases.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = sqrt(max(x, 0.0))
```

also found by `sqrt`, `root`

### Saturate

Clamp to 0..1 — the clamp you reach for nine times out of ten.

Clamps to 0..1, which is the clamp you want nine times out of ten: colours, masks and mix amounts all live in that range, and anything outside it either blows out or wraps.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = clamp(x, 0.0, 1.0)
```

also found by `clamp01`, `limit`, `01`

### Distance

How far apart two points are. Length measures from the origin; this measures between.

Distance BETWEEN two points, where Length measures from the origin. Use it when the centre of the thing you are drawing moves.

| In | Type | Default |
|---|---|---|
| `a` | vec2 — two numbers (x, y) | `0, 0` |
| `b` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = distance(a, b)
```

also found by `dist`, `between`, `separation`

### Dot product

How much one direction points along another. Gradients and lighting-style falloffs.

How much one direction points along another. With normalised inputs it is the cosine of the angle between them: 1 the same way, 0 perpendicular, −1 opposite. Directional fades and lighting-style falloffs are built on it.

| In | Type | Default |
|---|---|---|
| `a` | vec2 — two numbers (x, y) | `1, 0` |
| `b` | vec2 — two numbers (x, y) | `1, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = dot(a, b)
```

also found by `dot`, `projection`

### Normalise

Keep a direction, drop its length.

Keeps a direction and throws away its length. Guarded against the zero vector, which would otherwise produce NaN and paint a black hole in the middle of your surface.

| In | Type | Default |
|---|---|---|
| `v` | vec2 — two numbers (x, y) | `1, 0` |

| Out | Type |
|---|---|
| `out` | vec2 — two numbers (x, y) |

```glsl
out = normalize(v + 1e-6)
```

also found by `normalize`, `unit`, `direction`

### Bias · scale

Add, then multiply. The one-node way to turn −1..1 into 0..1 (bias 1, scale 0.5).

Add, then multiply — the one-node way to move a range. The defaults turn a −1..1 signal (an LFO, a sine) into 0..1, which is what most things downstream expect.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `bias` | float — a number | `1` |
| `scale` | float — a number | `0.5` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = ((x + bias) * scale)
```

also found by `constantbiasscale`, `offset scale`, `range`

### Greater than

1 when a is above b, 0 when it is not. Feed it into Switch to make a decision.

A comparison as a number: 1 when a is above b, 0 when it is not. Feed it into Switch to make a decision, or use it directly as a mask.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0.5` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = step(b, a)
```

also found by `compare`, `if`, `test`, `above`

## LFO

### LFO

A slow oscillator: sine, triangle, saw or square. Rate in cycles per second.

The clock of a patch. `rate` is in cycles per second and `phase` in turns, so two LFOs at the same rate and 0.25 apart are a quarter cycle out — which is how you get circular motion. `out` swings −1..1 and `unipolar` covers the same shape in 0..1: use `out` for movement, `unipolar` for anything that must not go negative, like brightness. The waveform is a setting rather than a port because it cannot vary per pixel, and as a constant the compiler folds the branch away.

| In | Type | Default |
|---|---|---|
| `Hz` | float — a number | `0.5` |
| `turns` | float — a number | `0` |
| `amount` | float — a number | `1` |
| `offset` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |
| `unipolar` | float — a number |

**shape** (setting — `sine`, `triangle`, `saw`, `square`), default `sine`

```glsl
out = (lfo(0, iTime, rate, phase) * amount + offset)
unipolar = ((lfo(0, iTime, rate, phase) * 0.5 + 0.5) * amount + offset)
```

helper: `lfo` · also found by `oscillator`, `sine`, `wave`, `modulation`

### Pulse

A one-shot ramp that falls from 1 after each trigger — an envelope, not a wave.

A repeating envelope rather than a wave: it fires and decays, which is what you want for flashes, strobes and anything that should hit rather than sweep.

| In | Type | Default |
|---|---|---|
| `trigger` | float — a number | `0` |
| `fall` | float — a number | `0.25` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = clamp(trigger * (1.0 - fract(iTime / max(fall, 0.001)) * 0.0), 0.0, 1.0)
```

also found by `trigger`, `envelope`, `blink`

## Pattern

### Grid

Square tiles with a gap. Outputs the tile mask and a per-cell random value.

Lines in both directions with a thickness you control. Feed it tiled coordinates for a denser grid rather than raising the count here, and it stays crisp at any zoom.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `cells` | float — a number | `8` |
| `gap` | float — a number | `0.08` |

| Out | Type |
|---|---|
| `mask` | float — a number |
| `id` | float — a number |

```glsl
mask = (smoothstep(gap, gap + 0.02, fract(uv * cells).x) * smoothstep(gap, gap + 0.02, 1.0 - fract(uv * cells).x) * smoothstep(gap, gap + 0.02, fract(uv * cells).y) * smoothstep(gap, gap + 0.02, 1.0 - fract(uv * cells).y))
id = hash21(floor(uv * cells))
```

helper: `hash21` · also found by `squares`, `checker`

### Lines

Repeating stripes, antialiased to one pixel at any resolution.

Stripes along one axis. Rotate the coordinates before it and the stripes rotate with them — the node itself only ever knows about x.

| In | Type | Default |
|---|---|---|
| `x` | float — a number | `0` |
| `count` | float — a number | `8` |
| `width` | float — a number | `0.15` |

| Out | Type |
|---|---|
| `mask` | float — a number |

```glsl
mask = (1.0 - aaStep(width, abs(fract(x * count) - 0.5)))
```

helper: `aaStep` · also found by `stripes`, `bars`

### Checker

The other classic tiling. 0 or 1 per square.

The alternating square you can never quite remember how to write. Also the quickest way to see what a UV transform is doing to space.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `cells` | float — a number | `8` |

| Out | Type |
|---|---|
| `mask` | float — a number |

```glsl
mask = mod(floor(uv.x * cells) + floor(uv.y * cells), 2.0)
```

## Noise

### Value noise

Soft blobs. The cheapest real noise.

The cheapest noise: random values on a grid, smoothed between them. Blocky at low zoom and perfectly good as a starting field.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = valueNoise(uv)
```

helper: `valueNoise`

### Value noise 3D

Wire time into z and the field evolves in place instead of sliding past.

Value noise with a third coordinate. Wire time into `z` and the field EVOLVES in place instead of sliding past — the difference between smoke and a conveyor belt.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `z` | float — a number | `0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = valueNoise3(vec3(uv, z))
```

helper: `valueNoise3`

### Gradient noise

Perlin. Rolling and organic; signed, so remap before using as brightness.

Perlin noise: smoother and more organic than value noise, and signed, so remap it before using it as brightness or half of your picture is clipped to black.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = gradientNoise(uv)
```

helper: `gradientNoise` · also found by `perlin`

### Simplex noise

Like Perlin without the square-grid bias. The better default.

Like gradient noise but with fewer directional artefacts and a lower cost at higher dimensions. The default choice when a field must not look like it is on a grid.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = simplexNoise(uv)
```

helper: `simplexNoise` · also found by `perlin`, `opensimplex`

### fBm

Layered noise — detail at every scale. Octaves multiply the cost.

Layered noise: each octave is half the size and half the strength of the last, which is what gives clouds and terrain detail at every scale. Octaves multiply the cost — four is plenty, eight is a decision.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `octaves` | int — a whole number | `4` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = fbm(uv, octaves)
```

helper: `fbm` · also found by `fractal`, `octaves`, `clouds`

### Turbulence

fBm folded at zero: creases. Fire and marble.

fBm folded at zero, so the valleys become creases. Fire, smoke and marble all start here.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `octaves` | int — a whole number | `4` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = turbulence(uv, octaves)
```

helper: `turbulence` · also found by `fire`, `marble`

### Ridged

Inverted folds: sharp crests. Mountains.

Turbulence turned inside out: the creases become ridges. Mountains, veins, lightning.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `octaves` | int — a whole number | `4` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = ridged(uv, octaves)
```

helper: `ridged`

### Worley

Cells. F1 is bubbles, F2−F1 is the walls between them.

Cellular noise. `f1` is the distance to the nearest point — bubbles, scales, cracked earth — and `walls` is the gap between the two nearest, which draws the boundaries between cells instead of the cells themselves.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `drift` | float — a number | `0.6` |

| Out | Type |
|---|---|
| `f1` | float — a number |
| `walls` | float — a number |

```glsl
f1 = worley(uv, drift, iTime).x
walls = smoothstep(0.0, 0.12, worley(uv, drift, iTime).y - worley(uv, drift, iTime).x)
```

helper: `worley` · also found by `voronoi`, `cellular`, `cells`

### Curl

A flow field that never bunches up. Wire it into Translate to advect.

A flow field rather than a value: it hands back a direction per point, and the field never converges or diverges. Add it to coordinates to make everything drift as if in water.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |

| Out | Type |
|---|---|
| `flow` | vec2 — two numbers (x, y) |

```glsl
flow = curlNoise(uv)
```

helper: `curl` · also found by `flow`, `vector field`, `fluid`

### Seamless

Noise that repeats exactly — for a strip that loops or panels that tile.

Noise that tiles at 1, so a surface can repeat without a visible join. Costs more than plain noise; only worth it when the seam would show.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `period` | float — a number | `4` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = tileableNoise(uv * period, period)
```

helper: `tileableNoise` · also found by `tileable`, `looping`

## Shape

### Circle

Signed distance to a circle: negative inside, zero on the edge.

A signed distance: negative inside, zero exactly on the edge, positive outside. That number is more useful than a mask — you can grow it, outline it, subtract another shape from it — which is why it is not a fill on its own.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `radius` | float — a number | `0.25` |

| Out | Type |
|---|---|
| `sd` | float — a number |

```glsl
sd = sdCircle(uv, radius)
```

helper: `sdCircle` · also found by `disc`, `sdf`, `dot`

### Box

Signed distance to a rectangle.

The same idea as Circle, squared off. `size` is the half-extent, so 0.25 gives a box half the width of centred space.

| In | Type | Default |
|---|---|---|
| `uv` | vec2 — two numbers (x, y) | `0, 0` |
| `size` | vec2 — two numbers (x, y) | `0.25, 0.15` |

| Out | Type |
|---|---|
| `sd` | float — a number |

```glsl
sd = sdBox(uv, size)
```

helper: `sdBox` · also found by `rect`, `square`, `sdf`

### Fill

Turn a distance into a solid shape, softly.

Turns a signed distance into a mask you can multiply or mix with. `softness` is the width of the fade at the edge — zero is hard, and a little is usually kinder to LEDs than none.

| In | Type | Default |
|---|---|---|
| `sd` | float — a number | `0` |
| `softness` | float — a number | `0.005` |

| Out | Type |
|---|---|
| `mask` | float — a number |

```glsl
mask = smoothstep(softness, -softness, sd)
```

also found by `solid`, `mask`

### Outline

Turn a distance into an outline of a given thickness.

Draws the edge of a shape instead of its inside, at the width you ask for. It is the distance field earning its keep: an outline from a mask would need a second shape.

| In | Type | Default |
|---|---|---|
| `sd` | float — a number | `0` |
| `width` | float — a number | `0.01` |

| Out | Type |
|---|---|
| `mask` | float — a number |

```glsl
mask = smoothstep(width, 0.0, abs(sd))
```

also found by `stroke`, `border`, `ring`

### Cut out

Cut b out of a. (min is union, max is intersection.)

Cuts one shape out of another, on the distance fields rather than on the masks — so the result is still a distance field and can be filled, outlined or cut again. Called Subtract in most tools, and the menu answers to that too.

| In | Type | Default |
|---|---|---|
| `a` | float — a number | `0` |
| `b` | float — a number | `0` |

| Out | Type |
|---|---|
| `sd` | float — a number |

```glsl
sd = max(a, -b)
```

also found by `subtract`, `difference`, `boolean`, `carve`

## Audio

### Audio band

One of 16 frequency bands, low to high, already smoothed.

One number per frequency band, 0 lowest to 15 highest, already smoothed and scaled to 0..1. Bass lives around 0–3 and the air around 12–15.

| In | Type | Default |
|---|---|---|
| `band` | int — a whole number | `1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = iAudio[clamp(band, 0, 15)]
```

also found by `fft`, `spectrum`, `frequency`, `eq`

### Audio level

Overall energy — the whole spectrum averaged.

The whole spectrum averaged: overall energy. Good for a master brightness that breathes with the track without picking out any one instrument.

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = iAudioLevel
```

also found by `volume`, `rms`, `loudness`

### Beat

0 kick · 1 snare · 2 mid · 3 high. 1 on the hit, falling back to 0.

Drum detection on four channels — 0 kick, 1 snare, 2 mid, 3 high. `pulse` snaps to 1 on the hit and falls back down, so multiply it into anything that should flash. `count` goes up by one per beat and never resets: put it through Modulo to step through palettes, positions or cells on the beat.

| In | Type | Default |
|---|---|---|
| `channel` | int — a whole number | `0` |

| Out | Type |
|---|---|
| `pulse` | float — a number |
| `count` | float — a number |

```glsl
pulse = iBeat[clamp(channel, 0, 3)]
count = iBeatCount[clamp(channel, 0, 3)]
```

also found by `kick`, `onset`, `transient`, `bpm`

## Parameter

### Float parameter

A slider in the inspector, and a timeline lane.

A knob. It appears in the surface inspector under the name you give it, and with it come a timeline lane, an OSC address and a state-machine value — the same as declaring an input by hand in code. Renaming it changes the LABEL only; the address underneath stays put so automation you have already recorded keeps working.

| Out | Type |
|---|---|
| `out` | float — a number |

**Name** (setting), default `Value` · What this knob is called in the inspector, the timeline and OSC.

**min** (setting), default `0`

**max** (setting), default `1`

**Default** (setting), default `0.5`

```glsl
out = value
```

declares a parameter in the shader header · also found by `knob`, `slider`, `control`, `automation`

### Palette parameter

A palette picker, and the gradient it selects.

The same as a Float parameter, but the knob is a palette picker: the operator chooses one of ArtLux's gradients and the node hands you the colour at `t`.

| In | Type | Default |
|---|---|---|
| `t` | float — a number | `0` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

**Name** (setting), default `Palette` · What this picker is called in the inspector, the timeline and OSC.

**Default** (setting), default `0` · Which gradient it starts on.

```glsl
color = palette(pal, t)
```

declares a parameter in the shader header · also found by `knob`, `gradient control`

## Colour

### Palette

Sample one of ArtLux’s gradients by index.

Samples one of ArtLux's gradients. `t` runs 0..1 along it, so almost any grey value becomes a colour scheme by feeding it in here — and changing the palette index restyles the whole patch without touching its structure.

| In | Type | Default |
|---|---|---|
| `index` | int — a whole number | `0` |
| `t` | float — a number | `0` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = palette(index, t)
```

also found by `gradient`, `ramp`, `colour ramp`, `color`

### Mix colours

Blend two colours by t.

Blends two colours. Wire a mask into `t` and it becomes "draw b where the mask is", which is how nearly every layered patch is built.

| In | Type | Default |
|---|---|---|
| `a` | vec3 — three numbers — a colour, or a point | `0, 0, 0` |
| `b` | vec3 — three numbers — a colour, or a point | `1, 1, 1` |
| `t` | float — a number | `0.5` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = mix(a, b, t)
```

also found by `lerp`, `blend`, `crossfade`, `color`

### Switch colour

Choose colour a or b. Below 0.5 takes a, above takes b.

Chooses one colour or the other with no blend, for when a half-and-half colour would be meaningless.

| In | Type | Default |
|---|---|---|
| `a` | vec3 — three numbers — a colour, or a point | `0, 0, 0` |
| `b` | vec3 — three numbers — a colour, or a point | `1, 1, 1` |
| `which` | float — a number | `0` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = mix(a, b, step(0.5, which))
```

also found by `select`, `choose`, `color`

### Brightness

Scale a colour.

Scales a colour. Also the decay in a feedback loop: at 0.94 a trail fades over about a second, at 0.99 it runs for several, and at 1.0 or above it never fades and the picture whites out.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `1, 1, 1` |
| `amount` | float — a number | `1` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = (color * amount)
```

also found by `gain`, `dim`, `multiply`, `color`

### Luminance

How bright a colour reads to the eye, as one number.

How bright a colour reads to the eye, as one number — weighted for human vision rather than a flat average, which is why green counts for more than blue.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `1, 1, 1` |

| Out | Type |
|---|---|
| `out` | float — a number |

```glsl
out = dot(color, vec3(0.2126, 0.7152, 0.0722))
```

also found by `desaturate`, `greyscale`, `grayscale`, `mono`, `value`, `color`

### Saturation

Pull a colour towards grey (0) or push it past its own (>1).

Pulls a colour towards grey at 0, leaves it alone at 1, and pushes past its own at more than 1. On LEDs a little extra reads far better than the same picture at higher brightness.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `1, 0.5, 0` |
| `amount` | float — a number | `1` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = mix(vec3(dot(color, vec3(0.2126, 0.7152, 0.0722))), color, amount)
```

also found by `desaturation`, `vibrance`, `color`

### Hue shift

Rotate a colour around the wheel, in turns. The knob a VJ reaches for first.

Rotates a colour around the wheel, in turns. Done as a matrix rather than a trip through HSV: no branch, and no seam on greys, where hue is undefined and any conversion has to invent one.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `1, 0, 0` |
| `turns` | float — a number | `0` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = hueShift(color, turns)
```

helper: `hueShift` · also found by `hue`, `rotate colour`, `rotate color`, `color`

### Contrast

Push values away from mid grey (>1) or towards it (<1).

Pushes values away from mid grey above 1, and towards it below. Applied per channel, so it deepens colour as well as tone.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `0.5, 0.5, 0.5` |
| `amount` | float — a number | `1.4` |

| Out | Type |
|---|---|
| `color` | vec3 — three numbers — a colour, or a point |

```glsl
color = ((color - 0.5) * amount + 0.5)
```

also found by `gamma`, `punch`, `color`

## Output

### Output

What the surface shows. Every graph has exactly one.

What the surface draws. Every graph has exactly one, `color` is RGB in 0..1, and `alpha` is what the surface composites with — lower it and whatever is behind this surface shows through.

| In | Type | Default |
|---|---|---|
| `color` | vec3 — three numbers — a colour, or a point | `0, 0, 0` |
| `alpha` | float — a number | `1` |

| Out | Type |
|---|---|
| `color` | vec4 — four numbers — a colour with alpha |

```glsl
color = vec4(color, alpha)
```

also found by `result`, `final`, `surface`

<!-- /generated:shader-node-reference -->
