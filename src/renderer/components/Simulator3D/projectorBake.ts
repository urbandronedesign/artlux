import * as THREE from 'three';
import { nodes, isWebGPURenderer } from './renderer3d';
import { useFrame, useThree } from '@react-three/fiber';
import { registeredCasters, type DepthRenderer } from './projectorDepth';

// BAKING A PROJECTOR'S VIEW OF THE VENUE — one GPU pass that answers "which point of the venue does
// each of my pixels land on", at the projector's own resolution.
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
// grid across that invents world points that exist nowhere, smearing content past the object's edge by
// up to a cell. On a flat screen a 64-wide grid is fine; on the objects this app maps, edges are what
// the result is judged on.
//
// ── WHAT LANDS IN THE PIXELS ──────────────────────────────────────────────────────────────────
//
// RGB is the world-space position of the fragment. Alpha is a HIT FLAG: the target clears to
// (0,0,0,0), so alpha 0 means this pixel saw no geometry and its XYZ is meaningless. That is why the
// flag exists rather than testing for a zero vector — the world origin is a legitimate position, and
// on a venue placed around it, "0,0,0" is a point some pixel genuinely lands on.

const BAKE_LAYER = 6;             // 7 is the depth pass; nothing else uses a layer
const PROXY_FLAG = 'artluxBakeProxy';

// ── The material ────────────────────────────────────────────────────────────────────────────────
//
// Dual-path for the same reason projectedMapping and projectorDepth are: the projector windows build
// their own WebGL renderer while the editor viewport may be on WebGPU, and a NodeMaterial cannot
// render on a WebGLRenderer. The choice comes from the RENDERER, never from module state — the bug
// that blacked out a projector output once already (verify:invariants check 100).

function makeShaderMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        // Alpha 1 = "a surface is here". The clear colour supplies 0 everywhere else.
        gl_FragColor = vec4(vWorld, 1.0);
      }
    `,
    side: THREE.DoubleSide,   // a venue GLB with inverted winding must still bake
    toneMapped: false,
  });
}

function makeNodeMaterial(): THREE.Material | null {
  const mods = nodes();
  if (!mods) return null;
  const { MeshBasicNodeMaterial } = mods.webgpu;
  const { positionWorld, vec4, float } = mods.tsl;
  const m = new MeshBasicNodeMaterial();
  m.colorNode = vec4(positionWorld, float(1));
  m.side = THREE.DoubleSide;
  m.toneMapped = false;
  return m as unknown as THREE.Material;
}

let shaderMat: THREE.ShaderMaterial | null = null;
let nodeMat: THREE.Material | null = null;
function bakeMaterial(webgpu: boolean): THREE.Material | null {
  if (webgpu) { if (!nodeMat) nodeMat = makeNodeMaterial(); return nodeMat; }
  if (!shaderMat) shaderMat = makeShaderMaterial();
  return shaderMat;
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
  resolve(m: BakedMap | null): void;
}
let pending: Pending | null = null;

/**
 * Ask the mounted 3D viewport to bake `viewProj` at w×h. Resolves null when nothing can service it —
 * no Canvas mounted, no venue registered — which the caller must treat as "fall back", not as "the
 * projector sees nothing".
 */
export function requestBake(viewProj: number[], w: number, h: number): Promise<BakedMap | null> {
  if (pending) return Promise.resolve(null);   // one at a time; the caller retries or falls back
  return new Promise<BakedMap | null>((resolve) => {
    pending = { viewProj, w, h, resolve };
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
  void bakeWorldMap(gl, scene, req.viewProj, req.w, req.h)
    .then(req.resolve, (e) => { console.warn('[bake] failed', e && (e as Error).stack ? (e as Error).stack : e); req.resolve(null); });
}

export interface BakedMap {
  w: number;
  h: number;
  /** w*h*3 world XYZ, row-major, top-left origin. NaN where the projector sees no geometry. */
  xyz: Float32Array;
  /** How many pixels landed on geometry — the number that says whether the bake is usable. */
  hits: number;
}

/**
 * Render the venue from `viewProj` and read back one world position per pixel.
 *
 * Async because the WebGPU path's readback is: `readRenderTargetPixelsAsync` is the only way to get
 * bytes off a WebGPU target, and pretending otherwise would return a buffer of zeros that looks like
 * a venue nobody hit.
 */
export async function bakeWorldMap(
  gl: DepthRenderer, scene: THREE.Scene, viewProj: number[], w: number, h: number,
): Promise<BakedMap | null> {
  const casters = registeredCasters();
  if (!casters.length) return null;
  const webgpu = isWebGPURenderer(gl);
  const material = bakeMaterial(webgpu);
  if (!material) return null;

  const rt = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    // FLOAT, not bytes. These are metres in world space — a venue tens of metres across, with
    // negative coordinates — and eight bits per channel would quantise it to nothing.
    type: THREE.FloatType,
    depthBuffer: true,          // the depth test IS the occlusion
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;   // positions are data, not colour

  const proxies: THREE.Mesh[] = [];
  const savedTarget = gl.getRenderTarget();
  const savedClear = new THREE.Color();
  gl.getClearColor(savedClear);
  const savedAlpha = gl.getClearAlpha();
  const savedBg = scene.background;

  try {
    for (const c of casters) proxies.push(...attachProxies(c, material));
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
      buf = await webgpuRead.readRenderTargetPixelsAsync(rt, 0, 0, w, h) as Float32Array;
    } else {
      buf = new Float32Array(w * h * 4);
      (gl as unknown as { readRenderTargetPixels: (rt: THREE.WebGLRenderTarget, x: number, y: number, w: number, h: number, out: Float32Array) => void }).readRenderTargetPixels(rt, 0, 0, w, h, buf);
    }
    if (!buf || buf.length < w * h * 4) { console.warn('[bake] short readback', buf?.length, 'expected', w * h * 4); return null; }

    // Flip to a top-left origin and drop the misses. GL reads bottom-up; MPCDI's PFM and every
    // consumer of this map index from the top, and a vertically mirrored calibration is the kind of
    // wrong that looks almost right.
    const xyz = new Float32Array(w * h * 3);
    let hits = 0;
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w;
      for (let x = 0; x < w; x++) {
        const s = (src + x) * 4, d = (y * w + x) * 3;
        if (buf[s + 3] > 0.5) {
          xyz[d] = buf[s]; xyz[d + 1] = buf[s + 1]; xyz[d + 2] = buf[s + 2];
          hits++;
        } else {
          xyz[d] = NaN; xyz[d + 1] = NaN; xyz[d + 2] = NaN;
        }
      }
    }
    return { w, h, xyz, hits };
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
