import * as THREE from 'three';
import { DEPTH_PACK_GLSL, DEPTH_FAR } from './projectorDepth';

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

export interface ProjectedMaterial {
  material: THREE.MeshBasicMaterial;
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
export function makeProjectedMaterial(): ProjectedMaterial {
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
  const material = new THREE.MeshBasicMaterial({ color: '#161616', toneMapped: false });
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
