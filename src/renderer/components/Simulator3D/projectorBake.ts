import * as THREE from 'three';
import { nodes, isWebGPURenderer } from './renderer3d';
import { useFrame, useThree } from '@react-three/fiber';
import { registeredCasters, type DepthRenderer } from './projectorDepth';

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
// mode where it works.

const BAKE_LAYER = 6;             // 7 is the depth pass; nothing else uses a layer
const PROXY_FLAG = 'artluxBakeProxy';

// ── The material ────────────────────────────────────────────────────────────────────────────────
//
// Dual-path for the same reason projectedMapping and projectorDepth are: the projector windows build
// their own WebGL renderer while the editor viewport may be on WebGPU, and a NodeMaterial cannot
// render on a WebGLRenderer. The choice comes from the RENDERER, never from module state — the bug
// that blacked out a projector output once already (verify:invariants check 100).

/** Per-model, because uv mode is a property of the model and a rig can mix them. */
export interface UvSource {
  /** 'projected' throws content from `matrix`; anything else reads the mesh's own TEXCOORD_0. */
  mode: 'authored' | 'projected';
  /** `SceneModel.uvProjView` — world → content clip. Required for 'projected'. */
  matrix?: number[];
}

function makeShaderMaterial(src: UvSource): THREE.ShaderMaterial {
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

function makeNodeMaterial(src: UvSource): THREE.Material | null {
  const mods = nodes();
  if (!mods) return null;
  const { MeshBasicNodeMaterial } = mods.webgpu;
  const { uv, vec4, positionWorld, uniform } = mods.tsl;
  const m = new MeshBasicNodeMaterial();

  // TSL is chained, and its argument types are wide by design; `as never` appears only where the
  // typings cannot express "this node is a vec2/vec4", never to paper over an unknown symbol.
  if (src.mode === 'projected' && src.matrix?.length === 16) {
    const M = uniform(new THREE.Matrix4().fromArray(src.matrix));
    const clip = M.mul(vec4(positionWorld, 1)) as unknown as { xy: { div(w: unknown): { mul(n: number): { add(n: number): unknown } } }; w: unknown };
    const projUv = clip.xy.div(clip.w).mul(0.5).add(0.5);
    m.colorNode = vec4(projUv as never, 0, 1);
  } else {
    m.colorNode = vec4(uv(), 0, 1);   // the mesh's own unwrap — an attribute, not a projection
  }
  m.side = THREE.DoubleSide;
  m.toneMapped = false;
  return m as unknown as THREE.Material;
}

/**
 * A material per UV SOURCE, not one shared by the scene: uv mode is a property of the model, and a
 * rig may mix an authored GLB with a projected plane. Cached by a key so a bake of twenty meshes that
 * share a mode compiles one program, not twenty.
 */
const matCache = new Map<string, THREE.Material | null>();
function bakeMaterial(webgpu: boolean, src: UvSource): THREE.Material | null {
  const key = `${webgpu ? 'gpu' : 'gl'}|${src.mode}|${src.mode === 'projected' ? (src.matrix ?? []).join(',') : ''}`;
  if (matCache.has(key)) return matCache.get(key) ?? null;
  const m = webgpu ? makeNodeMaterial(src) : makeShaderMaterial(src);
  matCache.set(key, m);
  return m;
}

// ── Proxies ─────────────────────────────────────────────────────────────────────────────────────
//
// Same doctrine as the depth pass, and for the same measured reason: swapping an existing mesh's
// material black-screened the WebGPU path, while a proxy that never touches it did not. Parented to
// the caster so the world matrix tracks for free. Skips anything already flagged as a proxy — the
// depth pass's proxies live in the same trees and must not be baked as if they were geometry.

function attachProxies(root: THREE.Object3D, material: THREE.Material): THREE.Mesh[] {
  const made: THREE.Mesh[] = [];
  const add: Array<[THREE.Mesh, THREE.Mesh]> = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    if (mesh.userData[PROXY_FLAG] || mesh.userData['artluxDepthProxy']) return;
    if (!mesh.visible) return;                    // a hidden model is not lit, so it is not baked
    const proxy = new THREE.Mesh(mesh.geometry, material);
    proxy.userData[PROXY_FLAG] = true;
    proxy.layers.set(BAKE_LAYER);
    proxy.raycast = () => { /* never pickable */ };
    proxy.frustumCulled = false;
    add.push([mesh, proxy]);
  });
  for (const [mesh, proxy] of add) { mesh.add(proxy); made.push(proxy); }
  return made;
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

let camera: BakeCamera | null = null;
function getCamera(): BakeCamera {
  if (!camera) { camera = new BakeCamera(); camera.layers.set(BAKE_LAYER); }
  return camera;
}

// ── Getting at a renderer ───────────────────────────────────────────────────────────────────────
//
// The bake needs a live renderer and the scene graph, which only exist INSIDE the Canvas — while the
// thing that wants a bake (the export button, in a wizard) is ordinary React outside it. Same shape
// as the depth pass's request registry: leave a request, let a component inside the Canvas service it
// on its next frame, resolve a promise. One at a time, because a bake is an operator action and two
// concurrent ones would fight over the render target and the clear colour.

interface Pending {
  viewProj: number[]; w: number; h: number;
  /** Per-model uv source — the bake needs it because uv mode is a property of the model. */
  uvFor: (modelId: string) => UvSource;
  resolve(m: BakedMap | null): void;
}
let pending: Pending | null = null;

/**
 * Ask the mounted 3D viewport to bake `viewProj` at w×h. Resolves null when nothing can service it —
 * no Canvas mounted, no venue registered — which the caller must treat as "fall back", not as "the
 * projector sees nothing".
 */
export function requestBake(viewProj: number[], w: number, h: number, uvFor: (modelId: string) => UvSource): Promise<BakedMap | null> {
  if (pending) return Promise.resolve(null);   // one at a time; the caller retries or falls back
  return new Promise<BakedMap | null>((resolve) => {
    pending = { viewProj, w, h, uvFor, resolve };
    // Nothing mounted to service it? Do not hang the export dialog waiting for a frame that will
    // never come. A second is far longer than a frame and far shorter than an operator's patience.
    setTimeout(() => { if (pending?.resolve === resolve) { pending = null; resolve(null); } }, 1000);
  });
}

/** True while a bake is waiting for a frame — lets a caller show "baking…" honestly. */
export function bakePending(): boolean { return pending !== null; }

/**
 * Service a queued bake. Called from inside the Canvas, once per frame, by ProjectorBakePass.
 * Deliberately NOT awaited by the caller: a render loop must not block on a GPU readback.
 */
export function serviceBake(gl: DepthRenderer, scene: THREE.Scene): void {
  const req = pending;
  if (!req) return;
  pending = null;                                  // claim it before awaiting, so one frame = one bake
  void bakeContentUv(gl, scene, req.viewProj, req.w, req.h, req.uvFor)
    .then(req.resolve, (e) => { console.warn('[bake] failed', e && (e as Error).stack ? (e as Error).stack : e); req.resolve(null); });
}

export interface BakedMap {
  w: number;
  h: number;
  /**
   * w*h*3, row-major, top-left origin: (u, v, 0) — the CONTENT texture coordinate this projector
   * pixel should sample. NaN where the projector sees no geometry, or where the fragment fell
   * outside the content footprint. Three components rather than two because a PFM (MPCDI's geometry
   * carrier) is 1- or 3-channel; the third is spare.
   */
  uv: Float32Array;
  /** How many pixels landed on geometry — the number that says whether the bake is usable. */
  hits: number;
}

/**
 * Render the venue from `viewProj` and read back one CONTENT UV per projector pixel.
 *
 * Async because the WebGPU path's readback is: `readRenderTargetPixelsAsync` is the only way to get
 * bytes off a WebGPU target, and pretending otherwise would return a buffer of zeros that looks like
 * a venue nobody hit.
 */
export async function bakeContentUv(
  gl: DepthRenderer, scene: THREE.Scene, viewProj: number[], w: number, h: number,
  uvFor: (modelId: string) => UvSource,
): Promise<BakedMap | null> {
  const casters = registeredCasters();
  if (!casters.length) return null;
  const webgpu = isWebGPURenderer(gl);

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
  const rt = new THREE.WebGLRenderTarget(rw, rh, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    // FLOAT, not bytes. A uv quantised to 8 bits is 256 addressable texels across a 1920-wide
    // source — every seam in the venue would land on a visibly wrong column.
    type: THREE.FloatType,
    depthBuffer: true,          // the depth test IS the occlusion
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;   // coordinates are data, not colour

  const proxies: THREE.Mesh[] = [];
  const savedTarget = gl.getRenderTarget();
  const savedClear = new THREE.Color();
  gl.getClearColor(savedClear);
  const savedAlpha = gl.getClearAlpha();
  const savedBg = scene.background;

  try {
    // ONE MATERIAL PER MODEL, because uv mode is per model: an authored GLB and a projected plane in
    // the same rig bake differently, and a shared material would silently give one of them the
    // other's coordinates.
    for (const c of casters) {
      const material = bakeMaterial(webgpu, uvFor(c.id));
      if (!material) continue;
      proxies.push(...attachProxies(c.object, material));
    }
    if (!proxies.length) return null;

    const cam = getCamera();
    cam.projectionMatrix.fromArray(viewProj);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    // Alpha 0 everywhere the venue is not — the hit flag. A background would be drawn over it.
    scene.background = null;
    gl.setRenderTarget(rt);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, true, false);

    // WEBGPU COMPILES PIPELINES ASYNCHRONOUSLY, so a brand-new material's first render can return
    // before the work is queued — the same failure that blacked the depth pass until it warmed up.
    // Here the pass is one-shot, so waiting is both possible and correct.
    const compiler = gl as unknown as { compileAsync?: (s: THREE.Scene, c: THREE.Camera) => Promise<unknown> };
    if (webgpu && compiler.compileAsync) await compiler.compileAsync(scene, cam);

    gl.render(scene, cam);

    // ⚠ THE TWO READBACKS HAVE DIFFERENT SIGNATURES, AND GETTING IT WRONG FAILS DEEP INSIDE THREE.
    //
    //   WebGL   readRenderTargetPixels     (rt, x, y, w, h, BUFFER)   → fills the buffer you pass
    //   WebGPU  readRenderTargetPixelsAsync(rt, x, y, w, h, texIndex) → RETURNS a new typed array
    //
    // Passing a Float32Array where WebGPU wants a texture index put it through `backend.get(texture)`
    // with the array as the key, and it surfaced as `TypeError: Invalid value used as weak map key`
    // from WebGPUTextureUtils.copyTextureToBuffer — a message that names nothing in this file. Read
    // the signature, do not pattern-match the WebGL one.
    let buf: Float32Array;
    const webgpuRead = gl as unknown as { readRenderTargetPixelsAsync?: (rt: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number) => Promise<ArrayBufferView> };
    if (webgpuRead.readRenderTargetPixelsAsync) {
      buf = await webgpuRead.readRenderTargetPixelsAsync(rt, 0, 0, rw, rh) as Float32Array;
    } else {
      buf = new Float32Array(rw * rh * 4);
      (gl as unknown as { readRenderTargetPixels: (rt: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number, out: Float32Array) => void }).readRenderTargetPixels(rt, 0, 0, rw, rh, buf);
    }
    if (!buf || buf.length < rw * rh * 4) { console.warn('[bake] short readback', buf?.length, 'expected', rw * rh * 4); return null; }

    // Flip to a top-left origin and drop the misses. GL reads bottom-up; MPCDI's PFM and every
    // consumer of this map index from the top, and a vertically mirrored calibration is the kind of
    // wrong that looks almost right.
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
          // GL reads bottom-up; MPCDI's PFM and every consumer of this map index from the top, and a
          // vertically mirrored calibration is the kind of wrong that looks almost right.
          const ry = rh - 1 - (y * SS + sy);
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
  } finally {
    for (const p of proxies) p.removeFromParent();
    gl.setRenderTarget(savedTarget);
    gl.setClearColor(savedClear, savedAlpha);
    scene.background = savedBg;
    rt.dispose();
    // WEBGPU: re-assert the canvas size after a render-target detour, or the canvas pass comes back
    // with a stale depth attachment and the whole viewport goes black with a clean console. Measured;
    // see the same line in projectorDepth's endPass.
    if (webgpu) { const s = gl.getSize(new THREE.Vector2()); gl.setSize(s.x, s.y, false); }
  }
}

/**
 * Mount ONE inside any Canvas that holds the venue, beside <ProjectorDepthPass />. Without it the
 * request registry fills up and every bake times out into the raycast fallback — silently, at a
 * fortieth of the resolution, which is exactly the failure this module exists to remove.
 */
export function ProjectorBakePass(): null {
  const gl = useThree((s) => s.gl) as unknown as DepthRenderer;
  const scene = useThree((s) => s.scene);
  // Priority -1, like the depth pass: a negative priority leaves r3f's automatic render intact and
  // merely guarantees this runs before it, so a bake never lands mid-frame.
  useFrame(() => { serviceBake(gl, scene); }, -1);
  return null;
}
