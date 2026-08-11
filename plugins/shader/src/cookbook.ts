// The cookbook shaders — the techniques a generative effect is actually built from.
//
// These are the SOURCE OF TRUTH for docs/SHADER-COOKBOOK.md: the guide's code blocks are generated
// from this file, so a documented example can never be one that does not compile. Every one is
// written from scratch (Shadertoy's default licence is share-alike and this repo is public), uses the
// real entry point, and is short enough to read in one sitting.
//
// Each carries a `teach` line — the one idea it exists to demonstrate — which the guide prints above
// the code. Kept beside the shader rather than in the prose so the two cannot drift.

export interface Recipe {
  id: string;
  name: string;
  /** The single idea. Becomes the guide's section subtitle. */
  teach: string;
  /** Longer prose for the guide. Plain sentences, no markdown. */
  note: string;
  /** True for the ones that also ship in the shader dropdown. */
  starter?: boolean;
  family?: 'projection' | 'led';
  source: string;
}

export const RECIPES: Recipe[] = [
  {
    id: 'cb-coords',
    name: 'Coordinates',
    teach: 'uv is 0..1 across the surface; iAspect is what stops shapes stretching.',
    note:
      'Every shader starts here. uv.x runs 0 at the left to 1 at the right, uv.y 0 at the bottom to 1 at '
      + 'the top. Those are FRACTIONS of the surface, not pixels, which is why one shader serves a 60-LED '
      + 'strip and a 4K projector. The moment you want something round, centre the coordinates and '
      + 'multiply x by iAspect: without it a circle on a wide surface is an ellipse, because you asked '
      + 'for equal distance in a space that is not square.',
    source: `vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);   // centred, and square in real units
  float d = length(p);                         // distance from the middle
  return vec4(vec3(1.0 - d), 1.0);
}`,
  },

  {
    id: 'cb-grid',
    name: 'Grid',
    teach: 'fract() tiles space; floor() names the tile.',
    note:
      'A grid is two lines of arithmetic. Multiply uv by the number of cells you want, then fract() gives '
      + 'you a fresh 0..1 INSIDE each cell while floor() gives you that cell id. Once you have the id you '
      + 'can make every cell different — this one hashes it into a per-cell brightness and lights cells in '
      + 'a moving wave. That id is the whole trick behind checkerboards, tiled patterns, sprite sheets and '
      + 'anything that should look built rather than smeared.',
    starter: true,
    family: 'projection',
    source: `/*{
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
}`,
  },

  {
    id: 'cb-lines',
    name: 'Lines',
    teach: 'Draw a line by measuring distance TO it, then thresholding.',
    note:
      'There is no line primitive. You compute how far each pixel is from where the line should be and '
      + 'light the ones that are close. That sounds indirect and it is the most useful habit in shader '
      + 'writing: everything becomes a distance, and distances compose. abs(uv.y - y0) is the distance to '
      + 'a horizontal line; length(p - closestPointOnSegment) is the distance to a segment. Antialias the '
      + 'threshold with fwidth() and the line stays crisp at any size, including a projector.',
    starter: true,
    family: 'led',
    source: `/*{
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
}`,
  },

  {
    id: 'cb-sdf',
    name: 'Shapes (SDF)',
    teach: 'A signed distance field gives you shapes you can combine, outline and soften.',
    note:
      'A signed distance function returns how far a point is from a shape: negative inside, zero on the '
      + 'edge, positive outside. That single number is worth more than a fill test, because arithmetic on '
      + 'it means something. min() of two fields is their union, max() is intersection, max(a, -b) is '
      + 'subtraction, and abs(d) - w turns any shape into an outline of thickness w. Build a vocabulary '
      + 'of three or four and you can draw most things.',
    source: `float sdCircle(vec2 p, float r) { return length(p) - r; }

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
}`,
  },

  {
    id: 'cb-voronoi',
    name: 'Voronoi',
    teach: 'Scatter one point per cell, then colour by the nearest one.',
    note:
      'Voronoi is the pattern behind cracked earth, cell walls, crystals and a great deal of organic '
      + 'looking motion. The naive version compares every pixel against every point and is far too slow. '
      + 'The standard trick is to work on a grid: put ONE point in each cell at a hashed offset, and then '
      + 'each pixel only has to check the nine cells around it. That is nine distance tests per pixel '
      + 'regardless of how big the pattern is. Animate the offsets and the cells drift like something '
      + 'alive. Returning the distance to the SECOND nearest point instead gives you the walls.',
    starter: true,
    family: 'projection',
    source: `/*{
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
}`,
  },

  {
    id: 'cb-noise',
    name: 'Noise and warping',
    teach: 'Layered noise makes clouds; feeding noise back into the coordinates makes smoke.',
    note:
      'Value noise is a hash smoothed between grid points. One layer is blobs; adding layers at double '
      + 'frequency and half amplitude (fBm) gives the cloud-like detail everything organic is made of. '
      + 'The step most people miss is DOMAIN WARPING: instead of colouring by noise, use noise to move '
      + 'the coordinates you then sample noise at. Two lines, and a static cloud becomes something that '
      + 'curls and flows. It is the cheapest way to look expensive.',
    starter: true,
    family: 'projection',
    source: `/*{
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
}`,
  },

  {
    id: 'cb-polar',
    name: 'Polar and kaleidoscope',
    teach: 'Change what the coordinates MEAN and the same pattern becomes a different one.',
    note:
      'atan(p.y, p.x) is the angle and length(p) the radius, so switching to polar turns horizontal '
      + 'stripes into rays and vertical ones into rings. Fold the angle with abs(mod(a, s) - s * 0.5) '
      + 'and you have a kaleidoscope with any number of segments. Nothing about the pattern changed — '
      + 'only the space it is drawn in. Reach for this when an effect is right but the shape is wrong.',
    source: `vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);

  float a = atan(p.y, p.x);
  float r = length(p);

  float seg = 6.2831853 / 8.0;            // eight segments
  a = abs(mod(a, seg) - seg * 0.5);       // fold: the mirror that makes it a kaleidoscope

  float rings = 0.5 + 0.5 * sin(r * 30.0 - iTime * 2.0);
  float rays  = 0.5 + 0.5 * sin(a * 12.0);
  return vec4(palette(3, rings * rays), 1.0);
}`,
  },

  {
    id: 'cb-strip',
    name: 'Writing for LEDs',
    teach: 'A strip samples ONE line across the picture — put the variation along it.',
    note:
      'This is the difference between a shader that looks good on a wall and one that works on tape. A '
      + 'fixture reads a single row, so anything varying up the surface is thrown away and only variation '
      + 'along it survives. Build the effect as a function of uv.x alone, and treat uv.y as somewhere to '
      + 'put a preview you can see on the stage. The test is simple: if the picture still reads with the '
      + 'height squashed to one pixel, it will read on LEDs.',
    source: `vec4 shaderColor(vec2 uv) {
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
}`,
  },
];

export const STARTER_RECIPES = RECIPES.filter((r) => r.starter);
