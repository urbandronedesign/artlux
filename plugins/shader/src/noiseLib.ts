// The noise library — every generator worth knowing, written from scratch.
//
// SOURCE OF TRUTH for the noise half of docs/SHADER-COOKBOOK.md, on the same terms as cookbook.ts:
// the guide's code is generated from here, and the release harness compiles every one of these on a
// real WebGL2 driver. A noise function that does not build is worse than no noise function, because
// it is copied before it is tested.
//
// WHY FROM SCRATCH RATHER THAN THE CANONICAL IMPLEMENTATIONS. The usual simplex/gradient noise in
// circulation is Ashima Arts' webgl-noise (MIT — permissive, but attribution-bearing) or a Shadertoy
// paste (CC BY-NC-SA by default — share-alike, contagious, and this repo is public). Both would put a
// licence obligation on every project that ships a shader built on them. These are implemented from
// the algorithms instead: same maths, no strings.
//
// They are also written to be READ. A shorter simplex exists; this one keeps its three corners
// visible, because the point of the page is to teach the technique, not to win at golf.

export interface NoiseRecipe {
  id: string;
  name: string;
  /** The one idea, printed as the section subtitle. */
  teach: string;
  /** Prose for the guide. Plain sentences, no markdown. */
  note: string;
  /** Complete and pasteable: the function(s) plus a shaderColor that shows them. */
  source: string;
}

export const NOISE: NoiseRecipe[] = [
  {
    id: 'nz-hash',
    name: 'Hashes',
    teach: 'Every noise starts with a repeatable fake-random number.',
    note:
      'A hash turns a coordinate into a number that LOOKS random but is the same every time you ask — '
      + 'which is the whole point: a pattern built on real randomness would boil, because each frame '
      + 'would draw different values at the same place. All the classic hashes are the same trick, a big '
      + 'irrational multiply and a fract() to throw away the top: cheap, good enough for visuals, and not '
      + 'remotely suitable for anything that matters. Note hash22 returns TWO numbers, which is what you '
      + 'need for a per-cell offset or a gradient direction.',
    source: `float hash11(float p) {
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
}`,
  },

  {
    id: 'nz-value',
    name: 'Value noise (2D)',
    teach: 'Hash the grid corners, then interpolate smoothly between them.',
    note:
      'The simplest real noise. Hash a value at each corner of a grid cell, then blend between them with '
      + 'a curve that flattens at both ends — a straight mix leaves visible creases along the grid lines, '
      + 'because the SLOPE jumps at every corner even though the value does not. The classic fade is the '
      + 'quintic 6t^5 - 15t^4 + 10t^3, whose first and second derivatives are both zero at 0 and 1; the '
      + 'cheaper cubic 3t^2 - 2t^3 is fine for most visuals. Value noise is blobby rather than swirly, '
      + 'which reads as clouds and does not read as terrain.',
    source: `float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic fade: no grid creases
  return mix(mix(hash21(i + vec2(0, 0)), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

vec4 shaderColor(vec2 uv) {
  vec2 p = uv * vec2(iAspect, 1.0) * 6.0;
  return vec4(vec3(valueNoise(p + iTime * 0.2)), 1.0);
}`,
  },

  {
    id: 'nz-gradient',
    name: 'Gradient noise (Perlin)',
    teach: 'Interpolate DIRECTIONS instead of values and the blobs become flow.',
    note:
      'Perlin noise stores a random gradient — a direction — at each grid corner rather than a value, and '
      + 'takes the dot product with the offset to that corner. Because every corner contributes zero AT '
      + 'the corner, the field passes through zero on the lattice and swells between, which gives the '
      + 'characteristic rolling look instead of value noise blobs. It is signed, roughly -0.7..0.7, so '
      + 'remap before using it as a brightness. This is the noise behind most fire, water and terrain.',
    source: `vec2 hash22(vec2 p) {
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
}`,
  },

  {
    id: 'nz-simplex',
    name: 'Simplex noise (2D)',
    teach: 'Triangles instead of squares: no grid direction, and three corners instead of four.',
    note:
      'Perlin noise on a square grid has a bias you can see — features line up with the axes. Simplex '
      + 'noise skews space so the cells are triangles, which has no preferred direction and needs only '
      + 'three corners in 2D rather than four. It is the better default for anything organic, and the '
      + 'skew constants are the only fiddly part: F2 maps a square grid to a triangular one, G2 maps '
      + 'back. Each corner contributes a falloff times a gradient dot product, and contributions beyond '
      + 'the radius are simply dropped.',
    source: `vec2 hash22(vec2 p) {
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
}`,
  },

  {
    id: 'nz-value3d',
    name: 'Value noise (3D)',
    teach: 'Use time as a third axis and the pattern evolves instead of sliding.',
    note:
      'Adding time to a 2D coordinate SCROLLS the noise: the same shapes, moving. Feeding time as a third '
      + 'dimension makes the shapes themselves change while staying put, which is what smoke and clouds '
      + 'actually do. It costs eight hashes instead of four. This is almost always the version you want '
      + 'for ambient content, and the one people forget exists.',
    source: `float hash31(vec3 p) {
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
}`,
  },

  {
    id: 'nz-fbm',
    name: 'fBm — layering octaves',
    teach: 'Add the same noise at double frequency and half amplitude, several times.',
    note:
      'One layer of noise is a shape. Fractal Brownian motion adds layers at doubling frequency and '
      + 'halving amplitude, which is what gives natural things detail at every scale — big forms with '
      + 'small forms on them. Two knobs matter: lacunarity, how much finer each layer is (2.0), and gain, '
      + 'how much quieter (0.5). Gain above 0.5 is rougher, below is softer. This is also where a shader '
      + 'gets expensive: octaves multiply the whole cost, so raise the count while watching the frame '
      + 'rate, not afterwards.',
    source: `float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

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
}`,
  },

  {
    id: 'nz-turbulence',
    name: 'Turbulence and ridges',
    teach: 'abs() the octaves for creases; invert them for ridges.',
    note:
      'Two one-line variations on fBm that look nothing like it. Taking abs() of each signed octave folds '
      + 'the field at zero, and a fold is a crease — that is turbulence, the classic fire and marble look. '
      + 'Inverting the fold (1 - abs) puts sharp RIDGES where the creases were, and squaring the result '
      + 'sharpens them further: that is ridged multifractal, the mountain-range noise. Both need SIGNED '
      + 'noise underneath, so they are built on gradient noise rather than value noise.',
    source: `vec2 hash22(vec2 p) {
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
}`,
  },

  {
    id: 'nz-worley',
    name: 'Worley (cellular) noise',
    teach: 'Distance to the nearest scattered point — F1 for cells, F2 minus F1 for walls.',
    note:
      'Worley noise is Voronoi read as a height field. F1, the distance to the nearest point, gives round '
      + 'cells that look like bubbles or scales; F2 minus F1 lights the boundaries where two points are '
      + 'equally close, which is cracked mud and cell walls. The grid trick is what makes it affordable: '
      + 'one point per cell means only the nine neighbouring cells can hold the nearest one, so cost does '
      + 'not grow with how fine the pattern is. Inverting F1 gives the classic caustic look.',
    source: `vec2 hash22(vec2 p) {
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
}`,
  },

  {
    id: 'nz-curl',
    name: 'Curl noise (flow)',
    teach: 'Rotate the gradient of a noise field and you get flow that never piles up.',
    note:
      'For anything that should look like it is FLOWING — smoke, ink, hair — you want a velocity field '
      + 'with no sources or sinks, so nothing bunches together or vanishes. Take the gradient of a scalar '
      + 'noise field and rotate it 90 degrees: the result is divergence-free by construction, because the '
      + 'divergence of a rotated gradient is identically zero. The gradient itself comes from two finite '
      + 'differences. Advect coordinates along it and the picture swirls the way real fluid does, at a '
      + 'fraction of the cost of simulating anything.',
    source: `float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

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
}`,
  },

  {
    id: 'nz-tileable',
    name: 'Seamless (tileable) noise',
    teach: 'Hash the cell id modulo N and the pattern repeats exactly.',
    note:
      'Ordinary noise never repeats, which is usually the point — and occasionally the problem. A pattern '
      + 'that has to loop end to end on a strip, or tile across a wall of identical panels, needs the '
      + 'lattice itself to wrap. Wrapping the cell coordinate with mod() before hashing it does exactly '
      + 'that: cell N and cell 0 get the same value, so the field is continuous across the seam. The '
      + 'period must be a whole number of cells, which is the only constraint.',
    source: `float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

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
}`,
  },
];
