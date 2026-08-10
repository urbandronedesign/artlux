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

const FRAG_PREFIX = `#version 300 es
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform float iWallTime;
uniform float iAspect;
uniform int iFrame;
in vec2 vUv;
out vec4 artluxFragColor;
`;

/**
 * How many lines the wrapper puts in front of the author's line 1.
 *
 * Derived from the prefix rather than hand-counted, because a hand-counted constant is one edit away
 * from silently pointing every error message at the wrong line — and a confidently wrong line number
 * is worse than none.
 */
export const PREFIX_LINES = FRAG_PREFIX.split('\n').length - 1;

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
 * Nothing else is injected — deliberately.
 *
 * The obvious next move is to predefine PI/TAU and a few helpers, and it would break a large share of
 * pasted shaders on contact: a `#define PI` collides with the `const float PI = 3.14159;` that half of
 * Shadertoy opens with (the macro expands inside the declaration and the file stops parsing), and a
 * `const float PI` at file scope collides with the same line by redefinition. Shared helpers belong
 * behind an explicit `#include` the author opts into, which is Phase 5.
 */
export function buildProgramSource(authorSource: string): { vert: string; frag: string } {
  const usesShadertoy = !/\bshaderColor\s*\(/.test(authorSource) && /\bmainImage\s*\(/.test(authorSource);
  const frag = FRAG_PREFIX + authorSource + (usesShadertoy ? SHADERTOY_ADAPTER : '') + MAIN;
  return { vert: VERT, frag };
}
