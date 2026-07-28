// THE one definition of ArtLux's soft-edge blend ramp, as GLSL source shared by every path that
// applies it. There are three of them and they must agree to the pixel:
//
//   1. ProjectorGL's fragment shader — the 2D warp path (every non-calibrated output).
//   2. The calibration plugin's ProjectorScene BlendEffect — the calibrated render-from-projector
//      path, which draws OVER ProjectorGL's canvas and therefore has to redo the blend itself.
//   3. nvwarpApply.buildIntensity — the same math on the CPU, sampled into an NVAPI scanout
//      intensity grid on Quadro/RTX-pro hosts.
//
// (3) is a CPU replica and cannot literally share this text; (1) and (2) both interpolate it, so at
// least the two GPU paths are one implementation. When you change anything here, change buildIntensity
// in the same commit — a divergence shows up as a step at the seam that appears only when hwWarp is
// toggled, which is a genuinely horrible thing to debug on a wall.
//
// Version-agnostic on purpose: only core functions (clamp/pow/max), no sampler, no varying/in, no
// precision qualifier — so the same string compiles inside ESSL 1.00 (ProjectorGL's WebGL1 fallback)
// and the GLSL3 shader that `postprocessing` builds for an Effect.

export const SOFT_EDGE_GLSL = /* glsl */`
// One edge's linear ramp: 1 in the interior, falling to 0 at the border over a feather width w
// (both in normalized content units). w <= 0 means a hard edge — no ramp at all.
float softEdgeFeather(float d, float w) { return w <= 0.0 ? 1.0 : clamp(d / w, 0.0, 1.0); }

// The LINEAR share of the light this projector owns at uv, from the four per-edge feather widths
// s = (left, right, top, bottom). In a two-projector overlap the neighbour owns 1 - share.
float softEdgeShare(vec2 uv, vec4 s) {
  return softEdgeFeather(uv.x, s.x) * softEdgeFeather(1.0 - uv.x, s.y)
       * softEdgeFeather(uv.y, s.z) * softEdgeFeather(1.0 - uv.y, s.w);
}

// ⚠ THE EXPONENT IS 1/g, AND IT USED TO BE g — which made every soft edge a BLACK BAND.
//
// share is a share of LIGHT, but a projector emits signal^g. So the signal we must write is
// share^(1/g): the screen then emits (share^(1/g))^g = share, and share + (1-share) = 1 exactly,
// everywhere in the overlap. With pow(share, g) the middle of a seam emitted 2*0.5^2.2 = 0.07 of
// full light instead of 1.0. See SoftEdge in shared/protocol.ts for the operator-facing note.
float blendSignal(float share, float g) { return pow(max(share, 0.0), 1.0 / max(g, 0.1)); }
`;
