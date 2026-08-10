// The Phase 0 built-in shaders.
//
// Three, not one, and chosen to cover the two families a shader has to serve — because a shader that
// reads well at 4K often looks like noise on 60 LEDs, and the only way to find that out is to have one
// of each on screen. `strip` is the LED case (all variation along u, none across v); `rings` and
// `plasma` are the projection case.
//
// Written from scratch. Shadertoy's default licence is CC BY-NC-SA 3.0 — share-alike and contagious —
// and this repo is public, so nothing shipped here may be derived from one.
//
// These are string constants today. In Phase 5 they become the starter LIBRARY: folders on disk with a
// header, values and a thumbnail. Their TEXT should survive that move unchanged, which is the point of
// writing them against the real entry point now rather than something provisional.

export interface Starter {
  id: string;
  name: string;
  family: 'projection' | 'led';
  source: string;
}

export const STARTERS: Starter[] = [
  {
    id: 'plasma',
    name: 'Plasma',
    family: 'projection',
    source: `// Two interfering sine fields, breathing in and out.
vec4 shaderColor(vec2 uv) {
  float breath = 0.5 + 0.5 * sin(iTime * 0.7);

  float f = sin((uv.x + uv.y) * 6.0 + iTime * 0.9)
          + sin((uv.x - uv.y) * 4.2 - iTime * 0.6);

  // A cheap three-phase ramp stands in for a palette until palettes land in Phase 3.
  float t = f * 0.25 + 0.5;
  vec3 col = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));

  return vec4(col * mix(0.35, 1.0, breath), 1.0);
}`,
  },
  {
    id: 'rings',
    name: 'Rings',
    family: 'projection',
    source: `// Concentric rings travelling outward. iAspect is what keeps them ROUND without the
// shader ever learning the pixel size — the whole reason the entry point is normalised.
vec4 shaderColor(vec2 uv) {
  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);
  float rings = sin(length(p) * 40.0 - iTime * 3.0);
  vec3 tint = vec3(0.15, 0.72, 0.78);
  return vec4((0.5 + 0.5 * rings) * tint, 1.0);
}`,
  },
  {
    id: 'strip',
    name: 'Strip chase',
    family: 'led',
    source: `// The LED case: everything varies along u, nothing across v, so a fixture sampling one
// row off this surface sees the whole effect. A comet head with an exponential tail.
vec4 shaderColor(vec2 uv) {
  float head = fract(iTime * 0.25);
  float d = abs(uv.x - head);
  d = min(d, 1.0 - d);               // wrap, so the tail crosses the seam
  float energy = exp(-d * 14.0);
  vec3 col = mix(vec3(0.05, 0.10, 0.35), vec3(1.0, 0.85, 0.45), energy);
  return vec4(col * (0.25 + 0.75 * energy), 1.0);
}`,
  },
];

STARTERS.push({
  id: 'palette-wave',
  name: 'Palette wave',
  family: 'led',
  source: `/*{
  "TITLE": "Palette wave",
  "CATEGORIES": ["led", "ambient"],
  "INPUTS": [
    { "NAME": "speed",  "LABEL": "Speed",     "TYPE": "float",   "MIN": -2.0, "MAX": 2.0, "DEFAULT": 0.35 },
    { "NAME": "bands",  "LABEL": "Bands",     "TYPE": "float",   "MIN": 0.5,  "MAX": 8.0, "DEFAULT": 2.0 },
    { "NAME": "pal",    "LABEL": "Palette",   "TYPE": "palette", "DEFAULT": 1 },
    { "NAME": "sharp",  "LABEL": "Hard edge", "TYPE": "bool",    "DEFAULT": false }
  ]
}*/
// Everything here is a KNOB, not a number — which is what puts each one on a timeline lane, an OSC
// address and the state machine. palette() samples ArtLux's own gradients, the same ones the built-in
// LED effects use, so a palette change is automatable like anything else.
vec4 shaderColor(vec2 uv) {
  float t = uv.x * bands + iTime * speed;
  float f = fract(t);
  if (sharp) f = step(0.5, f);
  return vec4(palette(pal, f), 1.0);
}`,
});

STARTERS.push({
  id: 'trails',
  name: 'Comet trails',
  family: 'projection',
  source: `/*{
  "TITLE": "Comet trails",
  "CATEGORIES": ["ambient"],
  "REQUIRES_LAST_FRAME": true,
  "INPUTS": [
    { "NAME": "decay",  "LABEL": "Trail length", "TYPE": "float", "MIN": 0.80, "MAX": 0.995, "DEFAULT": 0.96 },
    { "NAME": "speed",  "LABEL": "Speed",        "TYPE": "float", "MIN": 0.05, "MAX": 2.0,   "DEFAULT": 0.4 },
    { "NAME": "radius", "LABEL": "Head size",    "TYPE": "float", "MIN": 0.01, "MAX": 0.20,  "DEFAULT": 0.05 }
  ]
}*/
// REQUIRES_LAST_FRAME hands this shader its OWN previous output as \`lastFrame\`. Reading it, fading it
// and drawing on top is the whole trick behind trails, decay and reaction-diffusion — and because a
// shader only ever reads its own past, there is no ordering problem and no cycle to resolve.
vec4 shaderColor(vec2 uv) {
  vec3 prev = texture(lastFrame, uv).rgb * decay;

  vec2 p = (uv - 0.5) * vec2(iAspect, 1.0);
  vec2 head = vec2(cos(iTime * speed) * 0.35, sin(iTime * speed * 1.3) * 0.30);
  float d = length(p - head);

  vec3 dot3 = vec3(0.35, 0.85, 1.0) * smoothstep(radius, 0.0, d);
  return vec4(max(prev, dot3), 1.0);
}`,
});

STARTERS.push({
  id: 'spectrum',
  name: 'Spectrum',
  family: 'led',
  source: `/*{
  "TITLE": "Spectrum",
  "CATEGORIES": ["audio", "led"],
  "INPUTS": [
    { "NAME": "gain", "LABEL": "Gain",    "TYPE": "float",   "MIN": 0.2, "MAX": 4.0, "DEFAULT": 1.0 },
    { "NAME": "pal",  "LABEL": "Palette", "TYPE": "palette", "DEFAULT": 0 }
  ]
}*/
// iAudio holds the sound as 16 bands, low to high, each 0..1 and already enveloped — fast up, slow
// down — so a hit reads as a pulse rather than a flicker. Nothing to declare: it is always there.
vec4 shaderColor(vec2 uv) {
  int band = int(clamp(uv.x, 0.0, 0.999) * 16.0);
  float e = clamp(iAudio[band] * gain, 0.0, 1.0);

  // A bar per band: lit below the level, dark above it.
  float lit = step(1.0 - uv.y, e);
  vec3 col = palette(pal, float(band) / 16.0) * lit;

  // ...and a floor that glows with the overall energy, so a strip sampling one row still moves.
  return vec4(col + palette(pal, uv.x) * iAudioLevel * 0.35, 1.0);
}`,
});

export const DEFAULT_STARTER = 'plasma';

export function starterSource(id: string | undefined): string {
  return (STARTERS.find((s) => s.id === id) ?? STARTERS[0]).source;
}
