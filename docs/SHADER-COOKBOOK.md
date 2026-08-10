# Writing shaders — a cookbook

How to build the things generative content is actually made of: grids, lines, shapes, Voronoi cells,
noise. Every example below is a **complete shader** — select a shader surface, open the **Shader** tab,
paste it in, press `Ctrl+Enter`.

Start with [SHADERS.md](SHADERS.md) if you have not put one on a surface yet. This page assumes you
have, and goes after technique.

Four of these ship in the shader dropdown — **Grid**, **Lines**, **Voronoi** and **Noise warp** — so you
can open one, read it, and change a number to see what it does.

## The one idea

**A shader is not drawing. It is answering a question, once per pixel, in parallel.**

There is no pen, no canvas and no memory of the pixel next door. The graphics card runs your function
millions of times a frame, hands each copy one coordinate, and asks: *what colour is it here?* Every
technique on this page is a way of answering that from the coordinate alone.

Which is why the habit worth building is **thinking in distances**. You do not draw a circle; you ask
"how far am I from the centre?" and light the pixels where the answer is small. That sounds like a
detour and it is the opposite: distances add, subtract, repeat, soften and animate, and shapes drawn
any other way do none of that.

## What you have to work with

The full list is in [SHADERS.md](SHADERS.md#write-your-own); the ones these recipes lean on:

| | |
|---|---|
| `uv` | 0..1 across the surface. `uv.x` left→right, `uv.y` **bottom→top**. |
| `iAspect` | width ÷ height. Multiply centred `x` by it or circles come out as ellipses. |
| `iTime` | show time in seconds — scrubs with the timeline, holds when stopped. |
| `palette(id, t)` | one of ArtLux's own gradients, `t` wrapping 0..1. |
| `iAudio[16]`, `iBeat[4]` | the sound and its four beat channels. |

## The recipes

<!-- generated:shader-cookbook — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

### Coordinates

**uv is 0..1 across the surface; iAspect is what stops shapes stretching.**

Every shader starts here. uv.x runs 0 at the left to 1 at the right, uv.y 0 at the bottom to 1 at the top. Those are FRACTIONS of the surface, not pixels, which is why one shader serves a 60-LED strip and a 4K projector. The moment you want something round, centre the coordinates and multiply x by iAspect: without it a circle on a wide surface is an ellipse, because you asked for equal distance in a space that is not square.

```glsl
vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);   // centred, and square in real units
  float d = length(p);                         // distance from the middle
  return vec4(vec3(1.0 - d), 1.0);
}
```

### Grid

**fract() tiles space; floor() names the tile.**

A grid is two lines of arithmetic. Multiply uv by the number of cells you want, then fract() gives you a fresh 0..1 INSIDE each cell while floor() gives you that cell id. Once you have the id you can make every cell different — this one hashes it into a per-cell brightness and lights cells in a moving wave. That id is the whole trick behind checkerboards, tiled patterns, sprite sheets and anything that should look built rather than smeared.

```glsl
/*{
  "TITLE": "Grid",
  "CATEGORIES": ["pattern"],
  "INPUTS": [
    { "NAME": "cells", "LABEL": "Cells",  "TYPE": "float",   "MIN": 2.0, "MAX": 40.0, "DEFAULT": 10.0 },
    { "NAME": "gap",   "LABEL": "Gap",    "TYPE": "float",   "MIN": 0.0, "MAX": 0.45, "DEFAULT": 0.08 },
    { "NAME": "pal",   "LABEL": "Palette","TYPE": "palette", "DEFAULT": 5 }
  ]
}*/
// A hash: any float in, a repeatable 0..1 out. Not random — the SAME cell always gets the same value,
// which is what makes a pattern hold still instead of boiling.
float hash11(float n) { return fract(sin(n) * 43758.5453123); }

vec4 shaderColor(vec2 uv) {
  vec2 g = uv * cells;
  vec2 cell = floor(g);          // which tile
  vec2 f = fract(g);             // where inside it

  // A square inside each tile, with a gap. smoothstep instead of step so the edge is not a staircase.
  vec2 edge = smoothstep(vec2(gap), vec2(gap + 0.02), f)
            * smoothstep(vec2(gap), vec2(gap + 0.02), 1.0 - f);
  float tile = edge.x * edge.y;

  float id = hash11(cell.x + cell.y * 57.0);
  float wave = 0.5 + 0.5 * sin(iTime * 1.5 - (cell.x + cell.y) * 0.4);

  return vec4(palette(pal, id) * tile * wave, 1.0);
}
```

### Lines

**Draw a line by measuring distance TO it, then thresholding.**

There is no line primitive. You compute how far each pixel is from where the line should be and light the ones that are close. That sounds indirect and it is the most useful habit in shader writing: everything becomes a distance, and distances compose. abs(uv.y - y0) is the distance to a horizontal line; length(p - closestPointOnSegment) is the distance to a segment. Antialias the threshold with fwidth() and the line stays crisp at any size, including a projector.

```glsl
/*{
  "TITLE": "Lines",
  "CATEGORIES": ["pattern", "led"],
  "INPUTS": [
    { "NAME": "count", "LABEL": "Count",     "TYPE": "float",   "MIN": 1.0,   "MAX": 32.0, "DEFAULT": 8.0 },
    { "NAME": "width", "LABEL": "Thickness", "TYPE": "float",   "MIN": 0.002, "MAX": 0.2,  "DEFAULT": 0.02 },
    { "NAME": "speed", "LABEL": "Speed",     "TYPE": "float",   "MIN": -2.0,  "MAX": 2.0,  "DEFAULT": 0.3 },
    { "NAME": "pal",   "LABEL": "Palette",   "TYPE": "palette", "DEFAULT": 2 }
  ]
}*/
// Antialiasing without guesswork: fwidth(x) is how much x changes between neighbouring pixels, so it
// IS one pixel measured in your own units. Feather by that and the edge is one pixel wide at 360p and
// at 4K, with no magic number to retune.
float band(float x, float w) {
  float aa = fwidth(x) * 1.5;
  return smoothstep(w + aa, w - aa, abs(x));
}

vec4 shaderColor(vec2 uv) {
  // Scroll a repeating axis, then measure distance to the nearest line centre.
  float t = uv.x * count + iTime * speed;
  float d = abs(fract(t) - 0.5) / count;   // /count keeps thickness in SURFACE units, not tile units

  float line = band(d, width * 0.5);
  return vec4(palette(pal, fract(floor(t) * 0.17)) * line, 1.0);
}
```

### Shapes (SDF)

**A signed distance field gives you shapes you can combine, outline and soften.**

A signed distance function returns how far a point is from a shape: negative inside, zero on the edge, positive outside. That single number is worth more than a fill test, because arithmetic on it means something. min() of two fields is their union, max() is intersection, max(a, -b) is subtraction, and abs(d) - w turns any shape into an outline of thickness w. Build a vocabulary of three or four and you can draw most things.

```glsl
float sdCircle(vec2 p, float r) { return length(p) - r; }

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);

  float box = sdBox(p, vec2(0.28, 0.18));
  float hole = sdCircle(p, 0.12);
  float d = max(box, -hole);              // box MINUS circle

  float fill = smoothstep(0.005, 0.0, d);        // solid
  float ring = smoothstep(0.006, 0.0, abs(d) - 0.004); // and its outline

  vec3 col = vec3(0.1, 0.5, 0.9) * fill + vec3(1.0) * ring;
  return vec4(col, 1.0);
}
```

### Voronoi

**Scatter one point per cell, then colour by the nearest one.**

Voronoi is the pattern behind cracked earth, cell walls, crystals and a great deal of organic looking motion. The naive version compares every pixel against every point and is far too slow. The standard trick is to work on a grid: put ONE point in each cell at a hashed offset, and then each pixel only has to check the nine cells around it. That is nine distance tests per pixel regardless of how big the pattern is. Animate the offsets and the cells drift like something alive. Returning the distance to the SECOND nearest point instead gives you the walls.

```glsl
/*{
  "TITLE": "Voronoi",
  "CATEGORIES": ["organic"],
  "INPUTS": [
    { "NAME": "cells", "LABEL": "Cells",   "TYPE": "float",   "MIN": 2.0, "MAX": 24.0, "DEFAULT": 7.0 },
    { "NAME": "drift", "LABEL": "Drift",   "TYPE": "float",   "MIN": 0.0, "MAX": 2.0,  "DEFAULT": 0.6 },
    { "NAME": "walls", "LABEL": "Walls",   "TYPE": "bool",    "DEFAULT": false },
    { "NAME": "pal",   "LABEL": "Palette", "TYPE": "palette", "DEFAULT": 1 }
  ]
}*/
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * cells;
  vec2 cell = floor(p);
  vec2 f = p - cell;

  float d1 = 8.0, d2 = 8.0;   // nearest and second nearest
  vec2 nearestId = vec2(0.0);

  // NINE CELLS, never more. The point for a cell lives inside it, so nothing further away can win.
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(cell + g);
      o = 0.5 + 0.5 * sin(iTime * drift + 6.2831853 * o);   // drift, still per-cell repeatable
      float d = length(g + o - f);
      if (d < d1) { d2 = d1; d1 = d; nearestId = cell + g; }
      else if (d < d2) { d2 = d; }
    }
  }

  if (walls) {
    float w = smoothstep(0.0, 0.08, d2 - d1);   // thin where two cells are equally close
    return vec4(palette(pal, 0.7) * (1.0 - w), 1.0);
  }
  float id = fract(hash22(nearestId).x);
  return vec4(palette(pal, id) * (1.0 - d1 * 0.6), 1.0);
}
```

### Noise and warping

**Layered noise makes clouds; feeding noise back into the coordinates makes smoke.**

Value noise is a hash smoothed between grid points. One layer is blobs; adding layers at double frequency and half amplitude (fBm) gives the cloud-like detail everything organic is made of. The step most people miss is DOMAIN WARPING: instead of colouring by noise, use noise to move the coordinates you then sample noise at. Two lines, and a static cloud becomes something that curls and flows. It is the cheapest way to look expensive.

```glsl
/*{
  "TITLE": "Noise warp",
  "CATEGORIES": ["organic", "ambient"],
  "INPUTS": [
    { "NAME": "scale", "LABEL": "Scale",   "TYPE": "float",   "MIN": 0.5, "MAX": 8.0, "DEFAULT": 2.5 },
    { "NAME": "warp",  "LABEL": "Warp",    "TYPE": "float",   "MIN": 0.0, "MAX": 2.0, "DEFAULT": 0.8 },
    { "NAME": "speed", "LABEL": "Speed",   "TYPE": "float",   "MIN": 0.0, "MAX": 1.5, "DEFAULT": 0.15 },
    { "NAME": "pal",   "LABEL": "Palette", "TYPE": "palette", "DEFAULT": 4 }
  ]
}*/
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);                       // smootherstep: no grid creases
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

// Four octaves is plenty for a wall. Each costs a full noise() — this is where the frame goes, so
// raise it only while watching the frame rate.
float fbm(vec2 p) {
  float a = 0.5, v = 0.0;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
  return v;
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * scale;
  float t = iTime * speed;

  // THE WARP: sample noise at coordinates that noise itself has moved.
  vec2 q = vec2(fbm(p + t), fbm(p + vec2(5.2, 1.3) - t));
  float v = fbm(p + warp * q);

  return vec4(palette(pal, v), 1.0);
}
```

### Polar and kaleidoscope

**Change what the coordinates MEAN and the same pattern becomes a different one.**

atan(p.y, p.x) is the angle and length(p) the radius, so switching to polar turns horizontal stripes into rays and vertical ones into rings. Fold the angle with abs(mod(a, s) - s * 0.5) and you have a kaleidoscope with any number of segments. Nothing about the pattern changed — only the space it is drawn in. Reach for this when an effect is right but the shape is wrong.

```glsl
vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);

  float a = atan(p.y, p.x);
  float r = length(p);

  float seg = 6.2831853 / 8.0;            // eight segments
  a = abs(mod(a, seg) - seg * 0.5);       // fold: the mirror that makes it a kaleidoscope

  float rings = 0.5 + 0.5 * sin(r * 30.0 - iTime * 2.0);
  float rays  = 0.5 + 0.5 * sin(a * 12.0);
  return vec4(palette(3, rings * rays), 1.0);
}
```

### Writing for LEDs

**A strip samples ONE line across the picture — put the variation along it.**

This is the difference between a shader that looks good on a wall and one that works on tape. A fixture reads a single row, so anything varying up the surface is thrown away and only variation along it survives. Build the effect as a function of uv.x alone, and treat uv.y as somewhere to put a preview you can see on the stage. The test is simple: if the picture still reads with the height squashed to one pixel, it will read on LEDs.

```glsl
vec4 shaderColor(vec2 uv) {
  // Everything is a function of uv.x — this is the part a fixture will actually see.
  float head = fract(iTime * 0.25);
  float d = abs(uv.x - head);
  d = min(d, 1.0 - d);                        // wrap at the ends
  float energy = exp(-d * 18.0);

  vec3 col = palette(0, 0.15 + energy * 0.7) * energy;

  // uv.y is free: a thin baseline makes the strip readable on the 2D stage without changing what the
  // fixture samples, as long as the fixture's row sits in the lit band.
  col *= smoothstep(0.0, 0.05, uv.y) * smoothstep(1.0, 0.95, uv.y);
  return vec4(col, 1.0);
}
```

<!-- /generated:shader-cookbook -->

## The noise library

Noise is what makes generative content look like a material rather than a diagram. These are the
standard generators, each complete and pasteable, in the order they build on each other: a hash, the
two ways to smooth it, the triangular grid that removes the square bias, the third dimension, then the
layering and folding that turn one field into clouds, fire, mountains, cells and flow.

All written from scratch — see the licence note at the end — so anything you build on them is yours.

<!-- generated:shader-noise — DO NOT EDIT BY HAND. Regenerate with: npm run docs:gen -->

### Hashes

**Every noise starts with a repeatable fake-random number.**

A hash turns a coordinate into a number that LOOKS random but is the same every time you ask — which is the whole point: a pattern built on real randomness would boil, because each frame would draw different values at the same place. All the classic hashes are the same trick, a big irrational multiply and a fract() to throw away the top: cheap, good enough for visuals, and not remotely suitable for anything that matters. Note hash22 returns TWO numbers, which is what you need for a per-cell offset or a gradient direction.

```glsl
float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}

vec4 shaderColor(vec2 uv) {
  // Straight hash per cell: pure static, and the raw material for everything below.
  return vec4(vec3(hash21(floor(uv * 24.0))), 1.0);
}
```

### Value noise (2D)

**Hash the grid corners, then interpolate smoothly between them.**

The simplest real noise. Hash a value at each corner of a grid cell, then blend between them with a curve that flattens at both ends — a straight mix leaves visible creases along the grid lines, because the SLOPE jumps at every corner even though the value does not. The classic fade is the quintic 6t^5 - 15t^4 + 10t^3, whose first and second derivatives are both zero at 0 and 1; the cheaper cubic 3t^2 - 2t^3 is fine for most visuals. Value noise is blobby rather than swirly, which reads as clouds and does not read as terrain.

```glsl
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic fade: no grid creases
  return mix(mix(hash21(i + vec2(0, 0)), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 6.0;
  return vec4(vec3(valueNoise(p + iTime * 0.2)), 1.0);
}
```

### Gradient noise (Perlin)

**Interpolate DIRECTIONS instead of values and the blobs become flow.**

Perlin noise stores a random gradient — a direction — at each grid corner rather than a value, and takes the dot product with the offset to that corner. Because every corner contributes zero AT the corner, the field passes through zero on the lattice and swells between, which gives the characteristic rolling look instead of value noise blobs. It is signed, roughly -0.7..0.7, so remap before using it as a brightness. This is the noise behind most fire, water and terrain.

```glsl
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);   // a DIRECTION, so it must be signed
}

float gradientNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(hash22(i + vec2(0, 0)), f - vec2(0, 0)),
                 dot(hash22(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash22(i + vec2(0, 1)), f - vec2(0, 1)),
                 dot(hash22(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 5.0;
  float n = gradientNoise(p + iTime * 0.25);
  return vec4(vec3(0.5 + 0.5 * n), 1.0);          // signed → remap to 0..1
}
```

### Simplex noise (2D)

**Triangles instead of squares: no grid direction, and three corners instead of four.**

Perlin noise on a square grid has a bias you can see — features line up with the axes. Simplex noise skews space so the cells are triangles, which has no preferred direction and needs only three corners in 2D rather than four. It is the better default for anything organic, and the skew constants are the only fiddly part: F2 maps a square grid to a triangular one, G2 maps back. Each corner contributes a falloff times a gradient dot product, and contributions beyond the radius are simply dropped.

```glsl
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float simplexNoise(vec2 p) {
  const float F2 = 0.3660254;   // (sqrt(3) - 1) / 2   square → triangle
  const float G2 = 0.2113249;   // (3 - sqrt(3)) / 6   triangle → square

  vec2 i = floor(p + (p.x + p.y) * F2);
  vec2 x0 = p - i + (i.x + i.y) * G2;

  // Which of the two triangles in this cell are we in?
  vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 x1 = x0 - i1 + G2;
  vec2 x2 = x0 - 1.0 + 2.0 * G2;

  // Radial falloff per corner, clamped at zero: a corner past the radius contributes nothing.
  vec3 t = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  t = t * t * t * t;

  vec3 n = vec3(dot(hash22(i), x0),
                dot(hash22(i + i1), x1),
                dot(hash22(i + 1.0), x2));

  return 70.0 * dot(t, n);      // 70 brings it to roughly -1..1
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 5.0;
  float n = simplexNoise(p + iTime * 0.2);
  return vec4(vec3(0.5 + 0.5 * n), 1.0);
}
```

### Value noise (3D)

**Use time as a third axis and the pattern evolves instead of sliding.**

Adding time to a 2D coordinate SCROLLS the noise: the same shapes, moving. Feeding time as a third dimension makes the shapes themselves change while staying put, which is what smoke and clouds actually do. It costs eight hashes instead of four. This is almost always the version you want for ambient content, and the one people forget exists.

```glsl
float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

float valueNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
                 mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
                 mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 6.0;
  // Time is the THIRD axis: the field evolves in place rather than sliding past.
  return vec4(vec3(valueNoise3(vec3(p, iTime * 0.4))), 1.0);
}
```

### fBm — layering octaves

**Add the same noise at double frequency and half amplitude, several times.**

One layer of noise is a shape. Fractal Brownian motion adds layers at doubling frequency and halving amplitude, which is what gives natural things detail at every scale — big forms with small forms on them. Two knobs matter: lacunarity, how much finer each layer is (2.0), and gain, how much quieter (0.5). Gain above 0.5 is rougher, below is softer. This is also where a shader gets expensive: octaves multiply the whole cost, so raise the count while watching the frame rate, not afterwards.

```glsl
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;          // a constant bound the compiler can see — see the lint
    sum += amp * valueNoise(p);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 0.0001);     // normalised, so the range does not change with octaves
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 3.0 + iTime * 0.05;
  return vec4(vec3(fbm(p, 5, 2.0, 0.5)), 1.0);
}
```

### Turbulence and ridges

**abs() the octaves for creases; invert them for ridges.**

Two one-line variations on fBm that look nothing like it. Taking abs() of each signed octave folds the field at zero, and a fold is a crease — that is turbulence, the classic fire and marble look. Inverting the fold (1 - abs) puts sharp RIDGES where the creases were, and squaring the result sharpens them further: that is ridged multifractal, the mountain-range noise. Both need SIGNED noise underneath, so they are built on gradient noise rather than value noise.

```glsl
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(hash22(i + vec2(0, 0)), f - vec2(0, 0)),
                 dot(hash22(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash22(i + vec2(0, 1)), f - vec2(0, 1)),
                 dot(hash22(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}

float turbulence(vec2 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) { sum += amp * abs(gnoise(p)); p *= 2.0; amp *= 0.5; }
  return sum;
}

float ridged(vec2 p) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) {
    float n = 1.0 - abs(gnoise(p));
    sum += amp * n * n;               // squared: sharper crests
    p *= 2.0; amp *= 0.5;
  }
  return sum;
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 4.0 + iTime * 0.06;
  float v = uv.x < 0.5 ? turbulence(p) : ridged(p);   // left: turbulence, right: ridges
  return vec4(palette(0, v), 1.0);
}
```

### Worley (cellular) noise

**Distance to the nearest scattered point — F1 for cells, F2 minus F1 for walls.**

Worley noise is Voronoi read as a height field. F1, the distance to the nearest point, gives round cells that look like bubbles or scales; F2 minus F1 lights the boundaries where two points are equally close, which is cracked mud and cell walls. The grid trick is what makes it affordable: one point per cell means only the nine neighbouring cells can hold the nearest one, so cost does not grow with how fine the pattern is. Inverting F1 gives the classic caustic look.

```glsl
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}

// Returns (F1, F2): distance to the nearest and second-nearest feature point.
vec2 worley(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(cell + g);
      o = 0.5 + 0.5 * sin(iTime * 0.6 + 6.2831853 * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 8.0;
  vec2 F = worley(p);
  float cells = 1.0 - F.x;              // bubbles
  float walls = smoothstep(0.0, 0.12, F.y - F.x);
  float v = uv.y < 0.5 ? cells : walls;  // bottom: cells, top: walls
  return vec4(palette(1, v), 1.0);
}
```

### Curl noise (flow)

**Rotate the gradient of a noise field and you get flow that never piles up.**

For anything that should look like it is FLOWING — smoke, ink, hair — you want a velocity field with no sources or sinks, so nothing bunches together or vanishes. Take the gradient of a scalar noise field and rotate it 90 degrees: the result is divergence-free by construction, because the divergence of a rotated gradient is identically zero. The gradient itself comes from two finite differences. Advect coordinates along it and the picture swirls the way real fluid does, at a fraction of the cost of simulating anything.

```glsl
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * valueNoise(p); p *= 2.0; a *= 0.5; }
  return s;
}

// The gradient by finite difference, rotated a quarter turn. eps is a compromise: too small and it is
// numerically noisy, too large and the flow is blurred.
vec2 curl(vec2 p) {
  const float eps = 0.01;
  float dx = fbm(p + vec2(eps, 0.0)) - fbm(p - vec2(eps, 0.0));
  float dy = fbm(p + vec2(0.0, eps)) - fbm(p - vec2(0.0, eps));
  return vec2(dy, -dx) / (2.0 * eps);   // (dy, -dx) IS the rotation
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 3.0;
  vec2 v = curl(p + iTime * 0.08);
  // Advect the sampling point along the flow, then colour by where it landed.
  float n = fbm(p + v * 0.15);
  return vec4(palette(4, n), 1.0);
}
```

### Seamless (tileable) noise

**Hash the cell id modulo N and the pattern repeats exactly.**

Ordinary noise never repeats, which is usually the point — and occasionally the problem. A pattern that has to loop end to end on a strip, or tile across a wall of identical panels, needs the lattice itself to wrap. Wrapping the cell coordinate with mod() before hashing it does exactly that: cell N and cell 0 get the same value, so the field is continuous across the seam. The period must be a whole number of cells, which is the only constraint.

```glsl
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

// The period is in CELLS. mod() before the hash is the whole trick.
float tileableNoise(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, period);
  vec2 b = mod(i + 1.0, period);
  return mix(mix(hash21(vec2(a.x, a.y)), hash21(vec2(b.x, a.y)), f.x),
             mix(hash21(vec2(a.x, b.y)), hash21(vec2(b.x, b.y)), f.x), f.y);
}

vec4 shaderColor(vec2 uv) {
  const float period = 4.0;
  // uv * period means exactly that many cells across the surface, so left and right edges match.
  float n = tileableNoise(uv * period + vec2(iTime * 0.2, 0.0), period);
  return vec4(vec3(n), 1.0);
}
```

<!-- /generated:shader-noise -->

### Choosing one

| Want | Use |
|---|---|
| Static, sparkle, dither | a **hash** on its own |
| Clouds, soft blobs | **value noise** + fBm |
| Flowing organic forms, fire, water | **gradient (Perlin)** or **simplex** + fBm |
| Anything that should not look grid-aligned | **simplex** |
| Evolving in place rather than sliding past | **3D noise**, with time as the third axis |
| Marble, fire creases | **turbulence** |
| Mountains, sharp crests | **ridged** |
| Bubbles, scales, cracked mud, caustics | **Worley** |
| Smoke, ink, hair — motion that never bunches up | **curl noise** |
| A pattern that must loop on a strip or tile a wall | **seamless noise** |

The cheapest way to make any of them look better is the **domain warp** from the recipes above: sample
the noise at coordinates that noise itself has moved.

## Making it fast

A shader runs once per pixel per frame, so cost is **pixels × instructions**, and the first of those
is usually the one to cut.

- **Detail is the biggest lever.** 720p is about 0.9 megapixels; 1080p is 2.1. Going up costs more
  than twice as much for a picture your fixtures throw away. See
  [SHADERS.md](SHADERS.md#detail-and-why-the-small-number-is-usually-right).
- **Loops multiply everything inside them.** The `fbm` above is four `noise()` calls per pixel, and
  each `noise()` is four hashes. Raising it to eight octaves doubles the whole shader. Change the
  count while watching the frame counter, not afterwards.
- **`sin`, `cos`, `exp`, `pow` and division are not free**, but they are also not the problem at these
  scales — a loop count is. Optimise the loop first and the maths never.
- **Branches cost when neighbouring pixels disagree.** `if (uv.x < 0.5)` is cheap because whole regions
  agree; a branch on a hash is not.
- **If it is going to LEDs, it is already cheap** — the picture is sampled down to a few dozen colours,
  so spend the budget on the surfaces you project.

If a shader gets too expensive, ArtLux disables that surface rather than dragging the show down: it
keeps the last picture and reports a fault. Simplify it or lower **Detail**, then recompile.

## Where to learn more

- **[The Book of Shaders](https://thebookofshaders.com/)** — the best introduction there is. Chapters
  on shaping functions, patterns, random, noise and cellular noise map directly onto the recipes above.
- **[Inigo Quilez's articles](https://iquilezles.org/articles/)** — the canonical reference for
  distance functions, smooth minimum, domain warping and Voronoi. Dense, and worth the effort.
- **[Shadertoy](https://www.shadertoy.com/)** — thousands of live examples to read. A single-pass
  shader converts in minutes; see [SHADERS.md](SHADERS.md#write-your-own) for what does and does not
  carry over.
- **[The ISF spec](https://isf.video/)** — where the parameter header comes from. Useful when you want
  to know what a `TYPE` means beyond the subset ArtLux supports.

> **Before you paste someone else's shader into a project you will show or share:** a Shadertoy shader
> with no licence stated carries the site's default, **CC BY-NC-SA 3.0** — attribution and share-alike,
> and share-alike is contagious to anything derived from it. Fine for your own show. Not fine to hand
> on as your own. Everything on this page was written from scratch for exactly that reason.

## See also

- [SHADERS.md](SHADERS.md) — putting a shader on a surface, parameters, sound, trails, the library.
- [EFFECTS.md](EFFECTS.md) — the older built-in effects, no code required.
- [LEDMAP.md](LEDMAP.md) — how a fixture samples the surface underneath it.
