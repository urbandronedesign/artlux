import * as THREE from 'three';
import { DEPTH_PACK_GLSL, DEPTH_FAR, DEPTH_PACK_COEFFS } from './projectorDepth';
import { nodes } from './renderer3d';
import { blankMap } from './blankMap';

// PROJECTED UV MAPPING — content thrown onto venue geometry from a virtual projector, rather than
// sampled through the mesh's authored UVs.
//
// This is the disguise/VIOSO/Modulo Pi behaviour, and it exists for two reasons an operator actually
// hits: a CAD or scanned GLB often has no TEXCOORD_0 at all (its whole surface then samples one texel
// and reads as a flat colour), and an exported one frequently has a V-flipped or otherwise unusable
// unwrap. Projecting sidesteps both — the mapping comes from a matrix, not from the file.
//
// ONE DEFINITION, BOTH WINDOWS. The editor's Simulator3D and the calibration plugin's ProjectorScene
// interpolate these same chunks, exactly as blendGlsl.ts is shared by the two blend paths. Two copies
// of an empirically-anchored convention drift, and the symptom — one window upside down — is
// unfalsifiable from a screenshot.
//
// It REPLACES an earlier per-vertex bake that wrote a `uv` attribute onto a geometry clone. The bake
// could not handle vertices behind the camera (they got mirror-smeared UVs), needed a private clone
// per model to avoid poisoning the loader's shared geometry, and never re-projected. This does all
// three for free, in the fragment stage.

const DECL_VERT = /* glsl */`
uniform mat4 uProjViewProj;
varying vec4 vProjPos;
varying vec3 vProjWorld;
varying vec3 vProjNrm;
`;

// After <project_vertex>, so `transformed` holds the final object-space position (morphs/skinning
// already applied). `normal` is declared for every non-raw shader by three's default prefix.
const BODY_VERT = /* glsl */`
vec4 artluxWorld = modelMatrix * vec4(transformed, 1.0);
vProjPos = uProjViewProj * artluxWorld;
vProjWorld = artluxWorld.xyz;
// mat3(modelMatrix) rather than a true inverse-transpose: this normal is only ever used for the SIGN
// of a facing test, and a model with per-axis scale can skew it slightly on oblique faces. Carrying a
// per-mesh normal matrix would mean a material per mesh, which is the cost this whole path avoids.
vProjNrm = mat3(modelMatrix) * normal;
`;

const DECL_FRAG = /* glsl */`
uniform vec3 uProjEye;
uniform float uProjSoft;
uniform float uProjCull;
uniform vec2 uMapRepeat;
uniform vec2 uMapOffset;
uniform sampler2D uProjDepth;
uniform float uHasDepth;
uniform float uProjBias;
uniform float uDepthFar;
varying vec4 vProjPos;
varying vec3 vProjWorld;
varying vec3 vProjNrm;
${DEPTH_PACK_GLSL}
`;

// Replaces <map_fragment> wholesale. Guarded by USE_MAP, so with no texture bound the material keeps
// its flat colour exactly as the authored-UV path does.
const BODY_FRAG = /* glsl */`
#ifdef USE_MAP
  float artluxVis = 1.0;
  // BEHIND THE PROJECTOR. A real projector lights nothing behind itself; without this test those
  // fragments divide by a negative w and receive a mirrored, smeared copy of the content — which is
  // precisely the defect the per-vertex bake this replaced was documented as having.
  if (vProjPos.w <= 0.0) artluxVis = 0.0;
  vec3 artluxNdc = vProjPos.xyz / max(vProjPos.w, 1e-6);
  // V IS INVERTED FROM NDC, and the anchor is empirical, not a derivation: the same texture on the
  // same mesh reads upright through authored UVs and upside down through this projection unless the
  // flip is here. Whatever the glTF exporter's V convention was, the one the rest of the app samples
  // with is the one this has to match — a projected frame that disagrees with an authored one is
  // wrong by definition, since the promise of this mode is "it looks like a fullscreen image from
  // that viewpoint". THIS IS THE ONLY PLACE THIS CONVENTION IS WRITTEN DOWN.
  vec2 artluxUv = vec2(artluxNdc.x * 0.5 + 0.5, 0.5 - artluxNdc.y * 0.5);
  // THE FLIP TRAP. three applies a texture's repeat/offset in the VERTEX stage, into vMapUv — so a
  // UV computed HERE bypasses it completely. matchBitmapOrientation compensates for ImageBitmap's
  // ignored flipY by writing exactly those fields, which means skipping this line puts content upside
  // down ON THE REAL PROJECTOR while the geometry stays perfectly aligned and the editor looks right.
  // Read back off the texture rather than re-derived, so bitmapFlip.ts stays the one owner of the rule.
  artluxUv = artluxUv * uMapRepeat + uMapOffset;
  // Footprint falloff as a RAMP, not a discard: two projectors covering the same object cross-fade
  // instead of meeting at a hard cookie edge. smoothstep needs edge0 < edge1, hence the 1.0 - form.
  float artluxE = max(uProjSoft, 1e-4);
  float artluxIx = 1.0 - smoothstep(1.0 - artluxE, 1.0, abs(artluxNdc.x));
  float artluxIy = 1.0 - smoothstep(1.0 - artluxE, 1.0, abs(artluxNdc.y));
  artluxVis *= artluxIx * artluxIy * step(abs(artluxNdc.z), 1.0);
  // Faces turned away from the projector. Still optional and still only exact on closed geometry —
  // but it is no longer the only thing between the content and geometry the projector cannot see.
  // Keep it for a closed convex mesh, where it is exact and costs nothing; the depth test below is
  // what a concave venue actually needs.
  float artluxNdl = dot(normalize(vProjNrm), normalize(uProjEye - vProjWorld));
  artluxVis *= mix(1.0, step(0.0, artluxNdl), uProjCull);
  // OCCLUSION. Everything above only decides whether the fragment is inside the projector's cone;
  // this decides whether the projector can actually SEE it. Without it a nearer surface does not
  // shadow a farther one, so a concave venue sprays content onto walls standing behind the ones in
  // front, and a closed mesh wears the picture on its far side.
  //
  // Compared in METRES along the projector's view axis (projectorDepth.ts has the argument for why
  // not the hardware depth buffer). The bias GROWS ON GRAZING FACES, because there one depth texel
  // spans a long run of surface and no constant offset can cover it: too small and the surface
  // self-shadows in stripes, too large and content creeps past a silhouette onto what is behind it.
  // artluxNdl is the same dot product the back-face test just used, so the grazing term is free.
  if (uHasDepth > 0.5 && artluxVis > 0.0) {
    // NOT artluxUv: that one is V-flipped for the content bitmap and carries the texture's
    // repeat/offset. The depth map is rendered by GL into a render target, so it is plain NDC→UV —
    // reusing artluxUv here would sample the map upside down and shadow the wrong half of the venue.
    vec2 artluxDepthUv = artluxNdc.xy * 0.5 + 0.5;
    float artluxSeen = artluxUnpackDepth(texture2D(uProjDepth, artluxDepthUv)) * uDepthFar;
    float artluxBias = uProjBias * (1.0 + 4.0 * (1.0 - abs(artluxNdl)));
    if (vProjPos.w > artluxSeen + artluxBias) artluxVis = 0.0;
  }
  vec4 sampledDiffuseColor = texture2D(map, artluxUv);
  diffuseColor *= sampledDiffuseColor;
  diffuseColor.rgb *= artluxVis;
#endif
`;

/**
 * What both implementations of the projected material have in common, and all either consumer touches:
 * they assign it to `mesh.material`, write `.map`, and set `.color`. Structural rather than
 * `MeshBasicMaterial`, because the WebGPU twin is a `MeshBasicNodeMaterial` — a sibling of it, not a
 * subclass.
 */
export type ProjectedBasicMaterial = THREE.Material & {
  map: THREE.Texture | null;
  color: THREE.Color;
};

export interface ProjectedMaterial {
  material: ProjectedBasicMaterial;
  /** World view-projection of the projecting camera, plus its position (for the facing test). */
  setProjector(viewProj: THREE.Matrix4, eye: THREE.Vector3): void;
  /** Mirror the texture's repeat/offset into the shader — call after matchBitmapOrientation. */
  syncMapTransform(tex: THREE.Texture | null): void;
  setLook(softNdc: number, cull: boolean): void;
  /**
   * The projector's depth map (projectorDepth.ts) and the self-shadow bias in METRES. Pass null to
   * turn occlusion off — the material then behaves exactly as it did before the depth pass existed.
   */
  setOcclusion(depth: THREE.Texture | null, biasMeters: number): void;
  dispose(): void;
}

/**
 * Self-shadow bias in metres, when a model does not carry its own. 2 cm holds on venue-scale geometry
 * (the world is metres by convention — see SceneModel.scale) without letting content leak past a
 * silhouette by anything an audience can see.
 */
export const DEFAULT_BIAS_M = 0.02;

// One shared 1×1 "infinitely far" texel, for materials with no depth map bound. White, because that
// is what an empty texel of a real map is — see DEPTH_PACK_GLSL. Lazy + shared: this is a placeholder
// for a disabled feature and must not cost an upload per model.
let farTex: THREE.DataTexture | null = null;
function farDepthTexture(): THREE.DataTexture {
  if (!farTex) {
    farTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    farTex.needsUpdate = true;
  }
  return farTex;
}

// A SECOND material instance rather than a toggled patch on the shared one. Toggling onBeforeCompile
// needs a correct customProgramCacheKey or three silently hands back the previously compiled program;
// two instances make that impossible to get wrong, at the cost of one material per model. And patching
// MeshBasicMaterial rather than writing a ShaderMaterial keeps the sRGB decode, tone-mapping flag, fog
// and clipping chunks identical to the authored-UV path — which is what stops the two looks drifting.
/**
 * @param useNodes  Is THIS window's renderer a node (WebGPU) renderer? Pass
 *                  `isWebGPURenderer(useThree(s => s.gl))` — never infer it from module state.
 *
 * A node material can only render on the node renderer, and the GLSL one only on a WebGLRenderer, so
 * the choice is forced by which renderer the calling Canvas actually built.
 *
 * ⚠ IT MUST COME FROM THE RENDERER, NOT FROM `nodes()`. This used to ask whether the TSL modules were
 * loaded, which was true only inside the WebGPU factory — until they started being preloaded at module
 * load, at which point "modules present" meant nothing more than "the flag is set somewhere in this
 * origin". localStorage is shared across windows, so the CALIBRATION PROJECTOR WINDOW — which builds
 * its own WebGL renderer and never consults that flag — started getting node materials it cannot
 * render. The projector output went black while the editor looked perfect.
 */
export function makeProjectedMaterial(useNodes: boolean): ProjectedMaterial {
  if (useNodes && nodes()) return makeProjectedNodeMaterial();
  return makeProjectedGlslMaterial();
}

function makeProjectedGlslMaterial(): ProjectedMaterial {
  const uniforms = {
    uProjViewProj: { value: new THREE.Matrix4() },
    uProjEye: { value: new THREE.Vector3() },
    uProjSoft: { value: 0 },
    uProjCull: { value: 0 },
    uMapRepeat: { value: new THREE.Vector2(1, 1) },
    uMapOffset: { value: new THREE.Vector2(0, 0) },
    // A 1×1 white stand-in rather than null: a sampler uniform left unbound reads texture unit 0,
    // which is whatever the CONTENT texture happens to be — the map would then "occlude" according
    // to the picture being projected. uHasDepth gates the test, but the binding must still be valid.
    uProjDepth: { value: farDepthTexture() as THREE.Texture },
    uHasDepth: { value: 0 },
    uProjBias: { value: DEFAULT_BIAS_M },
    uDepthFar: { value: DEPTH_FAR },
  };
  // `map` from construction, never null — see blankMap.ts. On the GLSL path it also means USE_MAP is
  // defined before any content arrives, so BODY_FRAG's replacement of <map_fragment> is always live.
  const material = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false, map: blankMap() });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${BODY_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_FRAG}`)
      .replace('#include <map_fragment>', BODY_FRAG);
  };
  // Distinct from an unpatched MeshBasicMaterial in three's program cache.
  material.customProgramCacheKey = () => 'artlux-projected-uv';

  return {
    material,
    setProjector(viewProj, eye) {
      uniforms.uProjViewProj.value.copy(viewProj);
      uniforms.uProjEye.value.copy(eye);
    },
    syncMapTransform(tex) {
      if (tex) {
        uniforms.uMapRepeat.value.set(tex.repeat.x, tex.repeat.y);
        uniforms.uMapOffset.value.set(tex.offset.x, tex.offset.y);
      } else {
        uniforms.uMapRepeat.value.set(1, 1);
        uniforms.uMapOffset.value.set(0, 0);
      }
    },
    setLook(softNdc, cull) {
      uniforms.uProjSoft.value = softNdc;
      uniforms.uProjCull.value = cull ? 1 : 0;
    },
    setOcclusion(depth, biasMeters) {
      uniforms.uProjDepth.value = depth ?? farDepthTexture();
      uniforms.uHasDepth.value = depth ? 1 : 0;
      uniforms.uProjBias.value = biasMeters;
    },
    dispose() { material.dispose(); },
  };
}

/**
 * THE WEBGPU TWIN of makeProjectedGlslMaterial. Same maths, same conventions, expressed as nodes.
 *
 * Read the GLSL above for WHY any of this is the way it is — the V flip, the repeat/offset mirror, the
 * behind-the-projector test, the grazing-angle bias. This function deliberately carries no rationale of
 * its own, so there is one place to change a decision rather than two places to disagree.
 *
 * The one structural difference: GLSL patches `MeshBasicMaterial` through `onBeforeCompile` and
 * replaces `<map_fragment>`, inheriting three's sRGB decode and tone-mapping chunks. Here the whole
 * colour is a `colorNode`; the sRGB decode still happens, because a TSL texture node honours its
 * texture's own `colorSpace`.
 */
function makeProjectedNodeMaterial(): ProjectedMaterial {
  const mods = nodes();
  if (!mods) throw new Error('projectedMapping: node modules unavailable');
  const { MeshBasicNodeMaterial } = mods.webgpu;
  const {
    uniform, texture, vec2, vec3, vec4, float, positionWorld, normalLocal, modelWorldMatrix,
    smoothstep, step, mix, abs, dot, normalize, max,
  } = mods.tsl;

  // Uniform nodes — the node equivalent of the `uniforms` object above; `.value` is written by the
  // same setters, so the two implementations are driven identically.
  const uProjViewProj = uniform(new THREE.Matrix4());
  const uProjEye = uniform(new THREE.Vector3());
  const uProjSoft = uniform(0);
  const uProjCull = uniform(0);
  const uMapRepeat = uniform(new THREE.Vector2(1, 1));
  const uMapOffset = uniform(new THREE.Vector2(0, 0));
  const uHasDepth = uniform(0);
  const uProjBias = uniform(DEFAULT_BIAS_M);
  const uDepthFar = uniform(DEPTH_FAR);
  const uHasMap = uniform(0);

  const world = positionWorld;
  const projPos = uProjViewProj.mul(vec4(world, float(1)));
  const ndc = projPos.xyz.div(max(projPos.w, float(1e-6)));

  // Content UV: V inverted from NDC, then the texture's repeat/offset applied by hand because this UV
  // is computed in the fragment stage and never passes through three's vertex texture matrix.
  const uv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))).mul(uMapRepeat).add(uMapOffset);

  // A texture node whose `.value` is swapped in syncMapTransform — the same call the GLSL path already
  // uses to mirror repeat/offset, which is exactly when the texture identity changes.
  const mapNode = texture(farDepthTexture(), uv);
  const depthNode = texture(farDepthTexture(), vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(0.5).add(0.5)));

  // Inside the cone: soft edge ramp on x and y, hard clip on z, nothing behind the projector.
  const e = max(uProjSoft, float(1e-4));
  const inX = float(1).sub(smoothstep(float(1).sub(e), float(1), abs(ndc.x)));
  const inY = float(1).sub(smoothstep(float(1).sub(e), float(1), abs(ndc.y)));
  const inFront = step(float(1e-6), projPos.w); // w <= 0 is behind → 0
  let vis = inX.mul(inY).mul(step(abs(ndc.z), float(1))).mul(inFront);

  // Facing test — same non-inverse-transpose normal as the GLSL, and for the same reason (sign only).
  const nrm = modelWorldMatrix.mul(vec4(normalLocal, float(0))).xyz;
  const ndl = dot(normalize(nrm), normalize(uProjEye.sub(world)));
  vis = vis.mul(mix(float(1), step(float(0), ndl), uProjCull));

  // Occlusion. Unpack the packed metres, add the grazing-angle-grown bias, hide what the projector
  // cannot see. `step(seen + bias, projPos.w)` is 1 when the fragment is FARTHER than what was seen,
  // i.e. occluded — so it is subtracted from visibility, gated by uHasDepth.
  const seen = artluxUnpackDepthTSL(mods.tsl, depthNode).mul(uDepthFar);
  const bias = uProjBias.mul(float(1).add(float(4).mul(float(1).sub(abs(ndl)))));
  const occluded = step(seen.add(bias), projPos.w).mul(uHasDepth);
  vis = vis.mul(float(1).sub(occluded));

  const mat = new MeshBasicNodeMaterial();
  mat.toneMapped = false;
  mat.color = new THREE.Color('#161616');
  // The node path samples through `mapNode`, not `material.map` — but the OBSERVER reads `material.map`,
  // and that is what decides whether this material's bindings (mapNode's texture included) are refreshed
  // at all. So it is born mapped for exactly the reason in blankMap.ts.
  mat.map = blankMap();
  // mix on a 0/1 uniform rather than a branch: exact at both endpoints and it keeps one compiled
  // shader, matching the GLSL path's `#ifdef USE_MAP` behaviour of falling back to the flat colour.
  mat.colorNode = mix(vec3(mat.color.r, mat.color.g, mat.color.b), mapNode.rgb.mul(vis), uHasMap);

  const material = mat as unknown as ProjectedBasicMaterial;

  return {
    material,
    setProjector(viewProj, eye) {
      uProjViewProj.value.copy(viewProj);
      uProjEye.value.copy(eye);
    },
    syncMapTransform(tex) {
      // ALSO the texture binding, not just its transform. The consumers write `material.map` and then
      // call this; a node material samples through its own node, so this is where the two are joined.
      swapTexture(mat, mapNode, tex ?? farDepthTexture());
      uHasMap.value = tex ? 1 : 0;
      if (tex) {
        uMapRepeat.value.set(tex.repeat.x, tex.repeat.y);
        uMapOffset.value.set(tex.offset.x, tex.offset.y);
      } else {
        uMapRepeat.value.set(1, 1);
        uMapOffset.value.set(0, 0);
      }
    },
    setLook(softNdc, cull) {
      uProjSoft.value = softNdc;
      uProjCull.value = cull ? 1 : 0;
    },
    setOcclusion(depth, biasMeters) {
      swapTexture(mat, depthNode, depth ?? farDepthTexture());
      uHasDepth.value = depth ? 1 : 0;
      uProjBias.value = biasMeters;
    },
    dispose() { mat.dispose(); },
  };
}

type TslNs = NonNullable<ReturnType<typeof nodes>>['tsl'];
/** Whatever TSL itself accepts as a node argument — taken from dot()'s own signature, never `any`. */
type TslNode = Parameters<TslNs['dot']>[0];

/**
 * Point a texture node at a different texture, and make the material notice.
 *
 * Assigning `.value` alone is not enough on the node renderer: the bind group is cached per material
 * and keeps the OLD texture. When the old one has since been disposed — which happens every time the
 * depth pass drops a map, or a clip changes the content texture — the next submit fails with
 * "Destroyed texture used in a submit", followed by a crash inside createBindGroup reading
 * `mipLevelCount` of an undefined GPU texture. Only flag it when the identity actually changed;
 * `needsUpdate` on every frame would rebuild the material at frame rate.
 */
function swapTexture(mat: { needsUpdate: boolean }, node: { value: THREE.Texture }, tex: THREE.Texture): void {
  if (node.value === tex) return;
  node.value = tex;
  mat.needsUpdate = true;
}

/** The reader half of DEPTH_PACK_GLSL, in nodes. Same four coefficients — see DEPTH_PACK_COEFFS. */
function artluxUnpackDepthTSL(tsl: TslNs, packed: TslNode) {
  const { dot, vec4 } = tsl;
  const [a, b, c, d] = DEPTH_PACK_COEFFS;
  return dot(packed, vec4(1 / a, 1 / b, 1 / c, 1 / d));
}

/** Is this model asking for the projected path, and does it have a matrix to use? */
export function usesProjectedUv(m: { uvMode?: string; uvProjView?: number[] }): boolean {
  return m.uvMode === 'projected' && m.uvProjView?.length === 16;
}

/**
 * Should this model's projection be occluded by the rest of the venue?
 *
 * ABSENCE MEANS ON, and the persisted field is named for the OFF polarity on purpose — the same
 * trick as `layout.dockingOff`. Occlusion is what a projector physically does, so it is the correct
 * default; naming the key `uvProjOcclude` would have made every project saved before the depth pass
 * existed opt out of it forever, and the operator would have had to find a checkbox to get the
 * behaviour they already expected.
 */
export function usesProjectedOcclusion(
  m: { uvMode?: string; uvProjView?: number[]; uvProjOccludeOff?: boolean },
): boolean {
  return usesProjectedUv(m) && !m.uvProjOccludeOff;
}
