// The canonical GLSL helper functions — ONE copy, three consumers.
//
// The node catalogue emits these when a graph uses a node that needs one; noiseLib.ts composes its
// documented examples out of them; and the release harness compiles everything that comes out of both.
// Before this file the same hash lived in four places, which is exactly the drift the documentation
// rule is about: the day someone improves `hash21` for the noise page, the node that quietly kept the
// old one starts producing a different picture from the docs that describe it.
//
// Each entry is a COMPLETE function (or small group), comments included, because the comments are half
// the teaching value on the cookbook page and there is no second copy to put them in.

export const LIB: Record<string, string> = {
  // ── Hashes ──────────────────────────────────────────────────────────────────────────────────────
  hash11: `float hash11(float p) {
  return fract(sin(p * 127.1) * 43758.5453123);
}`,

  hash21: `float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}`,

  hash22: `vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453123);
}`,

  hash33: `vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}`,

  hash31: `float hash31(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}`,

  // A SIGNED hash: gradient noise interpolates directions, so its corner values must point somewhere.
  hash22s: `vec2 hash22s(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}`,

  // ── Noise ───────────────────────────────────────────────────────────────────────────────────────
  valueNoise: `float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);   // quintic fade: no grid creases
  return mix(mix(hash21(i + vec2(0, 0)), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}`,

  valueNoise3: `float valueNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
                 mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
                 mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`,

  gradientNoise: `float gradientNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(dot(hash22s(i + vec2(0, 0)), f - vec2(0, 0)),
                 dot(hash22s(i + vec2(1, 0)), f - vec2(1, 0)), u.x),
             mix(dot(hash22s(i + vec2(0, 1)), f - vec2(0, 1)),
                 dot(hash22s(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y);
}`,

  simplexNoise: `float simplexNoise(vec2 p) {
  const float F2 = 0.3660254;   // (sqrt(3) - 1) / 2   square grid to triangular
  const float G2 = 0.2113249;   // (3 - sqrt(3)) / 6   and back

  vec2 i = floor(p + (p.x + p.y) * F2);
  vec2 x0 = p - i + (i.x + i.y) * G2;

  vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);   // which half of the cell
  vec2 x1 = x0 - i1 + G2;
  vec2 x2 = x0 - 1.0 + 2.0 * G2;

  vec3 t = max(0.5 - vec3(dot(x0, x0), dot(x1, x1), dot(x2, x2)), 0.0);
  t = t * t * t * t;

  vec3 n = vec3(dot(hash22s(i), x0), dot(hash22s(i + i1), x1), dot(hash22s(i + 1.0), x2));
  return 70.0 * dot(t, n);
}`,

  fbm: `float fbm(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;      // a bound the compiler can see — see the loop lint
    sum += amp * valueNoise(p);
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 0.0001);
}`,

  turbulence: `float turbulence(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * abs(gradientNoise(p));   // the FOLD at zero is the crease
    p *= 2.0;
    amp *= 0.5;
  }
  return sum;
}`,

  ridged: `float ridged(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gradientNoise(p));
    sum += amp * n * n;                   // squared: sharper crests
    p *= 2.0;
    amp *= 0.5;
  }
  return sum;
}`,

  // Returns (F1, F2): distance to the nearest and second-nearest feature point.
  worley: `vec2 worley(vec2 p, float drift, float t) {
  vec2 cell = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(cell + g);
      o = 0.5 + 0.5 * sin(t * drift + 6.2831853 * o);
      float d = length(g + o - f);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2);
}`,

  curl: `vec2 curlNoise(vec2 p) {
  const float eps = 0.01;
  float dx = fbm(p + vec2(eps, 0.0), 4) - fbm(p - vec2(eps, 0.0), 4);
  float dy = fbm(p + vec2(0.0, eps), 4) - fbm(p - vec2(0.0, eps), 4);
  return vec2(dy, -dx) / (2.0 * eps);   // the rotated gradient: divergence-free by construction
}`,

  tileableNoise: `float tileableNoise(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec2 a = mod(i, period), b = mod(i + 1.0, period);   // wrap the LATTICE, not the value
  return mix(mix(hash21(vec2(a.x, a.y)), hash21(vec2(b.x, a.y)), f.x),
             mix(hash21(vec2(a.x, b.y)), hash21(vec2(b.x, b.y)), f.x), f.y);
}`,

  // ── Shapes ──────────────────────────────────────────────────────────────────────────────────────
  sdCircle: `float sdCircle(vec2 p, float r) { return length(p) - r; }`,

  sdBox: `float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}`,

  // ── Utilities ───────────────────────────────────────────────────────────────────────────────────
  // Pixel-width antialiasing. fwidth(x) is how much x changes between neighbouring pixels, so it IS
  // one pixel in your own units — feather by it and an edge is one pixel wide at any resolution.
  aaStep: `float aaStep(float edge, float x) {
  float w = fwidth(x) * 0.75;
  return smoothstep(edge - w, edge + w, x);
}`,

  rotate2: `vec2 rotate2(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}`,

  remap: `float remap(float x, float a, float b, float c, float d) {
  return c + (d - c) * clamp((x - a) / max(b - a, 1e-6), 0.0, 1.0);
}`,

  // THE LFO. One function, four shapes, chosen by an int so a graph node can switch without recompiling
  // a different function in. Phase is in TURNS (0..1) rather than radians: an operator setting a
  // quarter-cycle offset should type 0.25, not 1.5707963.
  lfo: `float lfo(int shape, float t, float rate, float phase) {
  float x = fract(t * rate + phase);
  if (shape == 1) return abs(2.0 * x - 1.0) * 2.0 - 1.0;        // triangle
  if (shape == 2) return 2.0 * x - 1.0;                          // saw
  if (shape == 3) return x < 0.5 ? -1.0 : 1.0;                   // square
  return sin(x * 6.2831853);                                     // sine
}`,
};

/**
 * Resolve a set of helper names into GLSL, once each and in dependency order.
 *
 * Order matters — GLSL has no forward declarations, so `valueNoise` must appear after `hash21`. The
 * table below is the dependency graph; keeping it explicit beats parsing the sources for calls, which
 * would guess wrong the first time a helper mentioned another one in a comment.
 */
const DEPS: Record<string, string[]> = {
  valueNoise: ['hash21'],
  valueNoise3: ['hash31'],
  gradientNoise: ['hash22s'],
  simplexNoise: ['hash22s'],
  fbm: ['hash21', 'valueNoise'],
  turbulence: ['hash22s', 'gradientNoise'],
  ridged: ['hash22s', 'gradientNoise'],
  worley: ['hash22'],
  curl: ['hash21', 'valueNoise', 'fbm'],
  tileableNoise: ['hash21'],
};

export function resolveHelpers(names: Iterable<string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of DEPS[n] ?? []) visit(d);
    const body = LIB[n];
    if (!body) throw new Error(`glslLib: no helper named "${n}"`);
    out.push(body);
  };
  for (const n of names) visit(n);
  return out.join('\n\n');
}
