// Wrapping an author's fragment shader into a complete GLSL ES 3.00 program.
//
// The author writes ONE function and nothing else:
//
//     vec4 shaderColor(vec2 uv)      // uv is 0..1 across the surface. Never a pixel count.
//
// That signature is the load-bearing decision. A pixel-based entry point (Shadertoy's `fragCoord` /
// `iResolution`) forces the author to care WHICH consumer they are feeding, and ArtLux has two that
// differ by three orders of magnitude: the mapper uploads a surface into an atlas rect sized to that
// surface's LED DENSITY (WebGPUMapper.ts:653), while a projector output wants its native raster. With
// a normalised uv the same file serves a 60-LED strip and a 4K projector and never finds out. MadMapper
// reached the identical signature (`materialColorForPixel`) for the identical reason.
//
// Shadertoy's `mainImage(out vec4, in vec2)` is still accepted — a pasted shader should run — through
// the adapter appended below. It is a compatibility path, not the documented way to write a new one.

import { parseHeader, glslTypeOf } from './header';

/**
 * What the author gets for free, and what the editor's completion list offers.
 *
 * One table, so the uniform block below, the completions and the generated doc block cannot drift
 * apart — a hand-kept uniform list that no longer matches the shader is the exact failure the
 * documentation rule calls out. `scripts/gen-docs-data.cjs` parses this literal.
 */
export const UNIFORMS: { name: string; detail: string }[] = [
  { name: 'iTime', detail: 'float — SHOW time in seconds. Scrubs with the timeline; holds when stopped.' },
  { name: 'iWallTime', detail: 'float — free-running clock, ignores the transport.' },
  { name: 'iResolution', detail: 'vec3 — render size in pixels (xy), z = 1.' },
  { name: 'iAspect', detail: 'float — width / height. Use it to keep circles round.' },
  { name: 'iFrame', detail: 'int — frames drawn since the shader loaded.' },
  // No apostrophes in these strings: gen-docs-data parses this literal with a regex, and an escaped
  // quote ends the capture early — the doc row came out cut off mid-word the first time.
  { name: 'palette', detail: 'vec3 palette(int id, float t) — sample an ArtLux gradient by index.' },
  { name: 'lastFrame', detail: 'sampler2D — this shader last frame. Needs REQUIRES_LAST_FRAME in the header.' },
  { name: 'iAudio', detail: 'float[16] — the sound, low to high, each 0..1 and already smoothed.' },
  { name: 'iAudioLevel', detail: 'float — the whole spectrum averaged: overall energy, 0..1.' },
];

// `palette()` is always available, whether or not the shader declares a `palette` input, so a shader
// can reach ArtLux's gradients with a literal id. An unused sampler costs nothing — the driver
// optimises it out and its uniform location comes back null.
const FRAG_HEAD = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float iWallTime;
uniform float iAspect;
uniform int iFrame;
uniform sampler2D artluxPaletteLut;
uniform int artluxPaletteRows;
uniform float iAudio[16];
uniform float iAudioLevel;
in vec2 vUv;
out vec4 artluxFragColor;

vec3 palette(int id, float t) {
  float y = (float(id) + 0.5) / float(max(artluxPaletteRows, 1));
  return texture(artluxPaletteLut, vec2(fract(t), y)).rgb;
}
`;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Appended AFTER the author's text (so it costs no prefix lines and cannot shift a diagnostic).
// `mainImage` writes through an out-parameter and thinks in pixels, so the bridge hands it
// uv * iResolution.xy and returns what it wrote.
const SHADERTOY_ADAPTER = `
vec4 shaderColor(vec2 uv) {
  vec4 c = vec4(0.0);
  mainImage(c, uv * iResolution.xy);
  return c;
}`;

const MAIN = `
void main() {
  artluxFragColor = shaderColor(vUv);
}`;

/**
 * Wrap the author's text into a complete program.
 *
 * THE PREFIX IS NO LONGER A CONSTANT, and that is the whole reason this returns `prefixLines`. Every
 * declared input adds a `uniform` line, so the offset between a driver diagnostic ("line 47") and the
 * author's own file now depends on their header. A hardcoded number would point every error message at
 * the wrong line the moment somebody adds a parameter — worse than no line number at all, because it
 * looks authoritative. This is the line map the plan predicted, arriving on schedule.
 *
 * Nothing else is injected — deliberately. The obvious next move is to predefine PI/TAU, and it would
 * break a large share of pasted shaders on contact: a `#define PI` collides with the
 * `const float PI = 3.14159;` that half of Shadertoy opens with (the macro expands inside the
 * declaration and the file stops parsing), and a `const float PI` at file scope collides by
 * redefinition. Shared helpers belong behind an `#include` the author opts into, which is Phase 5.
 */
export function buildProgramSource(authorSource: string): { vert: string; frag: string; prefixLines: number } {
  const header = parseHeader(authorSource);
  const decls = header.inputs.map((i) => `uniform ${glslTypeOf(i.type)} ${i.name};`).join('\n');
  // Declared only when asked for. An always-present sampler would cost a texture unit on every shader
  // and, worse, would let one read a history buffer that nothing is maintaining for it.
  const feedback = header.needsLastFrame ? 'uniform sampler2D lastFrame;\n' : '';
  const prefix = `${FRAG_HEAD}${feedback}${decls ? `${decls}\n` : ''}`;

  const usesShadertoy = !/\bshaderColor\s*\(/.test(authorSource) && /\bmainImage\s*\(/.test(authorSource);
  const frag = prefix + authorSource + (usesShadertoy ? SHADERTOY_ADAPTER : '') + MAIN;
  return { vert: VERT, frag, prefixLines: prefix.split('\n').length - 1 };
}
