import * as THREE from 'three';
import { registeredCasters } from './projectorDepth';

// BAKING A PROJECTOR'S VIEW OF THE VENUE — one GPU pass that answers "which texel of the content
// belongs at each of my pixels", at the projector's own resolution.
//
// This is what a calibration FILE is made of. A solved pose is not portable on its own: replaying it
// means shipping the venue model and re-rendering the scene from the projector's viewpoint at
// showtime, which is exactly the cost the baked-file design exists to remove. Bake it once and the
// player only has to sample a picture through a map.
//
// ── WHY A RENDER PASS AND NOT A RAYCAST ───────────────────────────────────────────────────────
//
// `plugins/calibration/src/mpcdiData.ts` builds the same map by raycasting a grid of projector pixels
// against the venue with `raycastVenueBatch`, which is three's `Raycaster` — brute force, no BVH, so
// it is O(rays × triangles). That is why its grid defaults to 64 wide: 2,176 rays is what it can
// afford. A 1264×681 projector wants 860,784, some 400× more, and the CPU cannot get there.
//
// The GPU has been solving exactly this problem since forever: rendering IS "for each pixel, find the
// nearest surface along its ray". One pass at native raster costs milliseconds, and **occlusion comes
// free from the depth test** rather than needing per-ray nearest-hit bookkeeping.
//
// Why it matters at native resolution rather than a grid: every SILHOUETTE is a depth discontinuity —
// a pixel stops hitting the object and starts hitting the wall behind it — and interpolating a coarse
// grid across that samples content from halfway between two unrelated parts of the picture, smearing
// it past the object's edge by up to a cell. On a flat screen a coarse grid is fine; on the objects
// this app maps, edges are what the result is judged on.
//
// ── WHAT LANDS IN THE PIXELS: THE CONTENT UV, NOT A WORLD POSITION ────────────────────────────
//
// RG is the texture coordinate the venue's own shading would sample at this fragment. Alpha is a HIT
// FLAG: the target clears to (0,0,0,0), so alpha 0 means this pixel saw no geometry.
//
// ⚠ IT USED TO BE WORLD XYZ, AND THAT WAS WRONG FOR REAL PROJECTS. The idea was that a world point is
// the neutral, interoperable thing to store (it is MPCDI's 3D profile) and the UV could be recovered
// at playback by multiplying by the model's `uvProjView`. That recovery only works in PROJECTED uv
// mode. A mesh on AUTHORED UVs — the GLB's own TEXCOORD_0, which is what the owner's venue actually
// uses — has an arbitrary unwrap, and no matrix recovers it from a position. The baked output would
// have rendered black on the very project it was built for.
//
// Baking the UV instead handles both modes with one pass, because the scene's shader already knows
// its final coordinate either way: authored reads the attribute, projected computes it from the
// matrix. It is also smaller, and it needs no matrix at playback at all.
//
// The cost, accepted deliberately: the mapping is FROZEN at bake time. Re-unwrapping the mesh or
// changing the projection means re-baking. A world map would have survived those — for the one uv
// mode where it works. (The rig blend DOES want world positions — bakeWorld, at the end — because it
// asks which point of the venue a pixel lights, not which texel of the content.)
//
// ── WHY IT HAS A RENDERER OF ITS OWN ─────────────────────────────────────────────────────────────
//
// It used to borrow the 3D viewport's: leave a request, let a component inside the Canvas service it
// on its next frame, await WebGPU's compileAsync and readRenderTargetPixelsAsync. That failed two
// ways, both silent:
//   - the viewport stops its frame loop while hidden (Simulator3D `paused`), so a bake asked for from
//     anywhere but the 3D view itself waited for a frame that never came, and timed out;
//   - on the WebGPU renderer the pass STALLED intermittently with nothing logged — compileAsync never
//     settled and, raced past, the readback never resolved. Measured on the rig-blend solve, which
//     sat on "Solving…" for good.
// A short-lived WebGL2 renderer has neither problem: the program compiles inside render(), the
// readback is synchronous and tightly packed (no WebGPU 256-byte row padding to strip — that once
// sheared a 932-wide export), and nothing waits on the viewport. It never touches the live scene
// either: each caster mesh is mirrored as a standalone mesh on its world matrix, sharing geometry.
//
// The context lives for one call and is released with forceContextLoss — Chromium caps live WebGL
// contexts (~16) and evicts the OLDEST past that, which could be one the app is drawing with.
//
// What it still needs is the venue REGISTERED (registeredCasters — the depth pass's set, so a file
// and the live preview agree about what occludes what), which happens once the 3D view has been
// opened in the session.

/** Per-model, because uv mode is a property of the model and a rig can mix them. */
export interface UvSource {
  /** 'projected' throws content from `matrix`; anything else reads the mesh's own TEXCOORD_0. */
  mode: 'authored' | 'projected';
  /** `SceneModel.uvProjView` — world → content clip. Required for 'projected'. */
  matrix?: number[];
}

// ── The materials ───────────────────────────────────────────────────────────────────────────────

function uvMaterial(src: UvSource): THREE.ShaderMaterial {
  const projected = src.mode === 'projected' && src.matrix?.length === 16;
  return new THREE.ShaderMaterial({
    uniforms: { uProjViewProj: { value: new THREE.Matrix4().fromArray(src.matrix ?? new Array(16).fill(0)) } },
    vertexShader: /* glsl */`
      uniform mat4 uProjViewProj;
      varying vec2 vBakeUv;
      varying float vBakeOk;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        ${projected ? `
        vec4 clip = uProjViewProj * w;
        // Behind the content projector, or outside its frustum, is UNLIT — the projected footprint
        // has an edge, and clamping would paint the venue with a stretched border texel.
        vBakeOk = clip.w > 0.0 ? 1.0 : 0.0;
        vBakeUv = clip.w > 0.0 ? (clip.xy / clip.w * 0.5 + 0.5) : vec2(0.0);
        ` : `
        vBakeUv = uv;      // the mesh's own unwrap — an attribute, not something a matrix can produce
        vBakeOk = 1.0;
        `}
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vBakeUv;
      varying float vBakeOk;
      void main() {
        // A fragment outside the content footprint is a MISS, exactly like empty space: alpha 0. The
        // alternative — storing a clamped uv — would light the venue with a smeared border pixel.
        if (vBakeOk < 0.5 || vBakeUv.x < 0.0 || vBakeUv.x > 1.0 || vBakeUv.y < 0.0 || vBakeUv.y > 1.0) {
          gl_FragColor = vec4(0.0);
          return;
        }
        gl_FragColor = vec4(vBakeUv, 0.0, 1.0);
      }
    `,
    side: THREE.DoubleSide,   // a venue GLB with inverted winding must still bake
    toneMapped: false,
  });
}

function worldMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec3 vBakeWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vBakeWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vBakeWorld;
      void main() { gl_FragColor = vec4(vBakeWorld, 1.0); }
    `,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

// ── The camera ──────────────────────────────────────────────────────────────────────────────────
//
// `updateProjectionMatrix` is deliberately a no-op: the matrix is the projector's OWN, built from the
// solved OpenCV intrinsics, and three calls that method from inside `render()`. A PerspectiveCamera
// would helpfully overwrite it with one derived from fov/aspect and quietly bake the wrong lens — the
// same trap projectorDepth documents, and it fails silently because the result still looks plausible.
class BakeCamera extends THREE.Camera {
  // Not `override`: THREE.Camera does not declare this, but three CALLS it during render() when it
  // exists on the object — which is exactly why the empty body has to be here.
  updateProjectionMatrix(): void { /* the projection is supplied, not derived */ }
}

// ── The pass both bakes share ───────────────────────────────────────────────────────────────────

/**
 * Render the registered venue from `viewProj` into an rw×rh FLOAT target, each model with the
 * material `materialFor` gives it, and read it back in GL's bottom-up order (rw*rh*4). Null when
 * there is nothing to render or no float render targets.
 */
function offscreenPass(
  viewProj: number[], rw: number, rh: number,
  materialFor: (modelId: string) => THREE.Material,
): Float32Array | null {
  const casters = registeredCasters();
  if (!casters.length) return null;
  const materials: THREE.Material[] = [];
  const rt = new THREE.WebGLRenderTarget(rw, rh, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    // FLOAT, not bytes. A uv quantised to 8 bits is 256 addressable texels across a 1920-wide
    // source — every seam in the venue would land on a visibly wrong column. And a world point is in
    // metres.
    type: THREE.FloatType,
    depthBuffer: true,          // the depth test IS the occlusion
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;   // coordinates are data, not colour
  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: false, alpha: true });
    if (!renderer.extensions.has('EXT_color_buffer_float')) return null;
    const scene = new THREE.Scene();
    for (const c of casters) {
      // ONE MATERIAL PER MODEL, because uv mode is per model: an authored GLB and a projected plane
      // in the same rig bake differently, and a shared material would silently give one of them the
      // other's coordinates.
      const material = materialFor(c.id);
      materials.push(material);
      c.object.updateWorldMatrix(true, true);
      c.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!(mesh as { isMesh?: boolean }).isMesh) return;
        // The depth pass's proxies live in the same trees and must not be baked as if geometry.
        if (mesh.userData['artluxDepthProxy']) return;
        if (!mesh.visible) return;                    // a hidden model is not lit, so it is not baked
        const m = new THREE.Mesh(mesh.geometry, material);
        m.matrixAutoUpdate = false;
        m.matrix.copy(mesh.matrixWorld);
        m.frustumCulled = false;
        scene.add(m);
      });
    }
    if (!scene.children.length) return null;
    const cam = new BakeCamera();
    cam.projectionMatrix.fromArray(viewProj);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);              // alpha 0 = the hit flag says "no geometry"
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    const buf = new Float32Array(rw * rh * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, rw, rh, buf);
    return buf;
  } finally {
    for (const m of materials) m.dispose();
    rt.dispose();
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); }
  }
}

// ── The calibration-file bake: content uv ───────────────────────────────────────────────────────

export interface BakedMap {
  w: number;
  h: number;
  /**
   * w*h*3, row-major, BOTTOM row first (GL raster order — see the resolve loop): (u, v, coverage) —
   * the CONTENT texture coordinate this
   * projector pixel should sample. NaN where the projector sees no geometry, or where the fragment
   * fell outside the content footprint. Three components rather than two because a PFM (MPCDI's
   * geometry carrier) is 1- or 3-channel.
   */
  uv: Float32Array;
  /** How many pixels landed on geometry — the number that says whether the bake is usable. */
  hits: number;
}

/**
 * Render the venue from `viewProj` and read back one CONTENT UV per projector pixel. Null when
 * nothing can be baked (no venue registered, no float targets) — the caller must treat that as
 * "skip, and say why", never as "the projector sees nothing".
 */
export function bakeContentUv(
  viewProj: number[], w: number, h: number, uvFor: (modelId: string) => UvSource,
): BakedMap | null {
  // ── SUPERSAMPLE, SO THE SILHOUETTE CARRIES COVERAGE ─────────────────────────────────────────
  // Rendered at SS× and resolved below to a coverage fraction per output texel. Without it the hit
  // flag is binary and the projector has no way to antialias its own outline: a downstream blur can
  // soften the step but cannot know where inside the pixel the edge actually fell — and a distance
  // field derived from a same-resolution binary mask gives back exactly the binary answer.
  //
  // 2 rather than 4: quarter-pixel coverage steps are past what a projector resolves on a wall, and
  // this is 4x the render and 4x the readback (~11M float4 at native raster) already.
  const SS = 2;
  const rw = w * SS, rh = h * SS;
  const buf = offscreenPass(viewProj, rw, rh, (id) => uvMaterial(uvFor(id)));
  if (!buf) return null;

  // RESOLVE SS x SS -> one texel: (mean uv of the subsamples that hit, coverage fraction).
  //
  // The uv is averaged over HITS ONLY. Including a miss would drag the coordinate toward whatever
  // the cleared buffer holds, which is not a point on the venue at all — the same reason the map is
  // sampled NEAREST downstream. A partially covered texel therefore carries a real coordinate from
  // the covered part of itself, which is exactly what a fringe pixel needs in order to be dimmed
  // rather than invented.
  //
  // Coverage rides in the third channel — declared spare by this format and ignored by any reader
  // that does not know about it, so a file with it stays readable by one that does not.
  const out = new Float32Array(w * h * 3);
  let hits = 0;
  const inv = 1 / (SS * SS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let su = 0, sv = 0, n = 0;
      for (let sy = 0; sy < SS; sy++) {
        // NO ROW FLIP: the map is kept in GL raster order, bottom row first — what ProjectorGL samples
        // it with (texture2D(uMap, vRaster), GL origin) and what every calibration file exported so
        // far holds. WebGL reads back bottom-up, so the order is already right. The WebGPU version of
        // this pass flipped rows here, and only got the same order because WebGPU reads top-down —
        // a WebGL bake flipped the same way played upside down (measured, the test-card rig).
        const ry = y * SS + sy;
        for (let sx = 0; sx < SS; sx++) {
          const s = (ry * rw + (x * SS + sx)) * 4;
          if (buf[s + 3] > 0.5) { su += buf[s]; sv += buf[s + 1]; n++; }
        }
      }
      const d = (y * w + x) * 3;
      if (n) {
        out[d] = su / n; out[d + 1] = sv / n; out[d + 2] = n * inv;   // coverage 0<c<=1
        hits++;
      } else {
        out[d] = NaN; out[d + 1] = NaN; out[d + 2] = NaN;
      }
    }
  }
  return { w, h, uv: out, hits };
}

// ── The rig-blend bake: world position ──────────────────────────────────────────────────────────
//
// Replaces a CPU raycast (three's Raycaster, no BVH) that held the blend to a fixed 160-wide grid.
// One sample per pixel, no supersample: the blend weighs a point, it does not antialias an outline,
// and a position averaged across a silhouette would be a point floating in mid-air between the
// object and the wall behind it.

export interface WorldMap {
  w: number;
  h: number;
  /** w*h*3, row-major, top-left origin: the world XYZ this pixel's ray first hits. NaN = a miss. */
  world: Float32Array;
  hits: number;
}

export function bakeWorld(viewProj: number[], w: number, h: number): WorldMap | null {
  const buf = offscreenPass(viewProj, w, h, () => worldMaterial());
  if (!buf) return null;
  const world = new Float32Array(w * h * 3);
  let hits = 0;
  for (let y = 0; y < h; y++) {
    const ry = h - 1 - y;                              // GL reads bottom-up → top-left origin
    for (let x = 0; x < w; x++) {
      const s = (ry * w + x) * 4, d = (y * w + x) * 3;
      if (buf[s + 3] > 0.5) { world[d] = buf[s]; world[d + 1] = buf[s + 1]; world[d + 2] = buf[s + 2]; hits++; }
      else { world[d] = NaN; world[d + 1] = NaN; world[d + 2] = NaN; }
    }
  }
  return { w, h, world, hits };
}
