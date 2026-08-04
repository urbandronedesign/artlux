// Which renderer backs the 3D Scene canvas.
//
// The scene used to be three's WebGL renderer in its own context, entirely separate from the WebGPU
// device the pixel mapper owns — so a frame of video bound to a venue mesh is uploaded to the GPU TWICE
// per frame: once into the mapper's atlas, once into a three.js WebGL texture (useSurfaceTexture).
// Sharing one device is what makes that second upload disappear, and it can only happen if the scene is
// on WebGPU too.
//
// This module is deliberately the ONLY place that knows which backend is in play, so the swap stays one
// import deep and reverting is one flag. Sharing the mapper's GPUDevice lives here too — opt-in and
// still unsolved; see the note at the call site.
//
// ── ON BY DEFAULT, AND THE KEY IS NAMED FOR THE OPT-OUT ────────────────────────────────────────────
//
// It shipped opt-in (`artlux.scene3dWebGPU = '1'`) because it had been validated on one machine. Two
// measurements closed that question:
//
//   1. WebGL does not merely run slower here, it SATURATES the GPU process. On this laptop, a scene
//      holding nothing but two venue planes put `CrGpuMain` at **99.8% occupancy, 96.3% of it in
//      `CommandBuffer::Flush`** — the WebGL command-buffer service — for 32 fps. The identical scene on
//      WebGPU runs at 60 with the GPU process near idle. Adding the grid and 24 surfaces did not move
//      it off 60.
//   2. THE OPT-IN COULD NOT REACH A PACKAGED INSTALL. localStorage is per-origin; dev runs on
//      `http://localhost:3000` and the packaged app on `file://…/index.html`. So the flag set while
//      developing was invisible to the artifact anyone actually installs, and every packaged build was
//      quietly taking the 99.8%-saturated path. A default that only a developer can reach is not a
//      default.
//
// So absence now means ON, and the key is named for the polarity it turns OFF — the same trick, for the
// same reason, as `layout.dockingOff` (CLAUDE.md): naming it for the opt-out is what lets the default
// flip reach machines that already have a value stored.
//
//   localStorage['artlux.scene3dWebGL'] = '1'   → force the old WebGL path (then reload)
//
// This is a preference, not a promise: if `navigator.gpu` is missing or the renderer fails to
// initialise, glProp falls back to WebGL by itself and reports why. The worst case is the old behaviour.

import type * as THREE from 'three';
import type { GLProps } from '@react-three/fiber';
import { gpuDevice } from '../../gpu/gpuDevice';

/**
 * Per-machine, and ON unless explicitly turned off. Read once at module load — the renderer is
 * constructed at Canvas mount anyway, and the preload below depends on this being synchronous.
 *
 * The spike's `artlux.scene3dWebGPU='1'` is deliberately NOT read: absence already means on, so a
 * machine that opted in during the spike gets the same answer either way, and a second key that only
 * ever agrees with the default is a thing to keep true for no benefit.
 */
export function wantsWebGPU(): boolean {
  try {
    if (localStorage.getItem('artlux.scene3dWebGL') === '1') return false;
    return true;
  } catch { return true; } // no localStorage (rare) → take the fast path, it self-falls-back
}

// START THE IMPORT NOW, NOT AT MOUNT — this is what keeps the `gl` factory SYNCHRONOUS, and that
// turns out to be load-bearing rather than a nicety. See glProp for the whole story: an async factory
// silently leaves the canvas at its 300x150 default in about half of loads.
//
// Kicked off at module load and never awaited here. The 3D canvas is mounted lazily by the shell, so
// by the time an operator opens that workbench the ~2 MB has long since arrived; if it somehow has
// not, glProp falls back to the async path rather than failing.
const preload: Promise<void> | null = (() => {
  if (typeof window === 'undefined' || !wantsWebGPU()) return null;
  return Promise.all([import('three/webgpu'), import('three/tsl')])
    .then(([webgpu, tsl]) => { nodeModules = { webgpu, tsl }; })
    .catch(() => { /* glProp reports it properly when it tries */ });
})();

// r3f's `gl` prop. Its RUNTIME does `await glConfig(defaultProps)` (fiber's Canvas), but its TYPE still
// declares the factory as returning a Renderer synchronously — so an async factory, which is the only
// way to `await renderer.init()`, does not typecheck against it. The cast is at the one return below,
// with this note, rather than loosening the prop everywhere.
type GlProp = GLProps;

const WEBGL_CONFIG = { powerPreference: 'high-performance' as WebGLPowerPreference, antialias: true };

/**
 * The `gl` prop for the 3D Canvas. WebGL config object unless the machine opted into the WebGPU spike,
 * in which case an async factory — r3f v9 awaits it (`await glConfig(defaultProps)`), which is what
 * makes `await renderer.init()` possible at all.
 *
 * `three/webgpu` is imported DYNAMICALLY so the ~2 MB WebGPU build never enters the bundle graph of a
 * machine that is not using it. It shares `three.core.js` with the plain `three` build, so `Mesh`,
 * `Texture` and friends are the same classes in both — there is no second THREE and no instanceof trap.
 */
export function glProp(onFallback: (reason: string) => void): GlProp {
  if (!wantsWebGPU()) return WEBGL_CONFIG;

  // Sharing the mapper's device needs an await, so it forces the async path. It is a diagnostic mode
  // and known broken (see shareMode below), which is why the DEFAULT path is the synchronous one.
  let shareMode: string | null = null;
  try { shareMode = localStorage.getItem('artlux.scene3dShareDevice'); } catch { /* ignore */ }

  /** Build the renderer once the module namespace is in hand. Shared by both paths. */
  const build = (canvas: HTMLCanvasElement, webgpu: NodeModules['webgpu'], shared: GPUDevice | null) => {
    const { WebGPURenderer } = webgpu;
    const renderer = new WebGPURenderer(
      shared ? { canvas, antialias: true, alpha: true, device: shared } : { canvas, antialias: true, alpha: true },
    );
    // WEBGPU FAILS QUIETLY UNLESS SOMEBODY LISTENS. Validation errors go to the device's
    // `uncapturederror` event and device loss to `device.lost`; neither three nor r3f surfaces either,
    // so a pass that violates the API just stops producing pixels with a clean console. That silence
    // cost most of a day on the projector depth pass — wire it up once, here.
    //
    // `backend.device` only exists after init, so this is deferred rather than read inline.
    const attach = () => {
      const dev = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
      if (!dev) { console.warn('[scene3d] could not reach the GPUDevice — WebGPU errors will stay silent'); return; }
      dev.addEventListener('uncapturederror', (ev) => {
        console.error('[scene3d] WebGPU uncaptured error:', (ev as GPUUncapturedErrorEvent).error?.message ?? ev);
      });
      void dev.lost.then((i) => console.error('[scene3d] WebGPU DEVICE LOST:', i.reason, i.message));
    };
    // SKIP FRAMES UNTIL THE BACKEND IS UP. Returning the renderer synchronously is the whole point
    // (see below), but three does NOT initialise itself on first render — it throws
    // "Renderer: .render() called before the backend is initialized". r3f starts its loop as soon as
    // it has a renderer, so the first frame or two can land first.
    //
    // Dropping those frames is the correct behaviour and costs nothing: r3f calls render again next
    // frame, and init resolves in milliseconds. Everything else r3f does meanwhile (setSize,
    // setPixelRatio) is valid before init — which is exactly why the sync path is safe.
    // The guarded set is three's own, taken from every "called before the backend is initialized"
    // it throws: render, clear, compute, initTexture, initRenderTarget, hasFeature, hasCompatibility.
    // Guarding them by name rather than discovering them one crash at a time.
    let ready = false;
    const GUARDED = ['render', 'clear', 'compute', 'initTexture', 'initRenderTarget'] as const;
    const r = renderer as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of GUARDED) {
      const real = r[name]?.bind(renderer);
      if (!real) continue;
      r[name] = (...a: unknown[]) => (ready ? real(...a) : undefined);
    }
    void renderer.init().then(
      () => { ready = true; attach(); },
      (e) => { console.error('[scene3d] WebGPU init failed:', e); attach(); },
    );
    console.info(shared ? '[scene3d] sharing the mapper GPUDevice' : '[scene3d] three owns its GPUDevice');
    return renderer;
  };

  // ── THE SYNCHRONOUS PATH, AND WHY IT IS THE FIX FOR A REAL BUG ────────────────────────────────
  //
  // r3f applies the canvas size inside its render loop, guarded by `size !== oldSize`. An ASYNC `gl`
  // factory resolves only after the container has already been measured, so that comparison is equal
  // on the first pass, `gl.setSize()` is never called, and the canvas keeps its 300x150 DEFAULT
  // backing store while its CSS box is full size. Measured directly: failing loads reported
  // `300x150@css705x217`, and the WebGPU viewport rendered in roughly half of loads. The same gap is
  // what left three's canvas DEPTH texture at 300x150 and produced ~1700 validation errors a run.
  //
  // Calling `renderer.setSize()` ourselves after init looked like the fix — it removed every
  // validation error, 1700 to 0 — and made rendering strictly WORSE: 0/4 against 2/4. Overriding
  // r3f's bookkeeping from underneath it is not the answer; not taking the async path is.
  //
  // Nothing here actually has to be async: the module import is preloaded at module load, and
  // `renderer.init()` need not be awaited because three initialises itself on the first render.
  if (nodeModules && !shareMode) {
    const mods = nodeModules;
    return (({ canvas }: { canvas: HTMLCanvasElement }) => {
      try {
        if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
        return build(canvas, mods.webgpu, null);
      } catch (e) {
        const reason = String((e as Error)?.message ?? e);
        console.warn('[scene3d] WebGPU renderer unavailable, falling back to WebGL —', reason);
        onFallback(reason);
        return null;
      }
    }) as unknown as GLProps;
  }

  // ── The async fallback: the preload has not landed yet, or a shared device was asked for ───────
  //
  // ⚠ SHARING THE MAPPER'S DEVICE IS OPT-IN AND UNSOLVED. A GPUTexture cannot cross devices, so the
  // mapper's atlas and LED output buffer can never be read by the scene until both sit on one — but
  // handing three the mapper's device renders a black viewport: 0/9 by repeat measurement, canvas
  // present, ~39 fps, ZERO lit pixels, and no WebGPU error of any kind.
  //
  // RULED OUT, each by measurement: compatibility mode / `core-features-and-limits`; the feature set
  // (the mapper now requests the adapter's full list, matching three's own policy); three losing the
  // adapter (it never stores one); adapter request options; contention (an idle mapper is no better);
  // `alphaMode`; the MSAA resolve. Injecting a device is definitely SUPPORTED — a device created
  // fresh moments before the renderer renders correctly (mode '2') — and both adapters on this
  // machine are the same `intel / gen-12lp`, so it is not a two-GPU split.
  //
  // Also proven NOT to be the cause: r3f itself. A standalone repro (.traces/repro, gitignored) of
  // bare r3f + an async WebGPURenderer factory renders 8/8, and 6/6 when mounted hidden-then-revealed.
  //
  // MEASURE REPEATEDLY OR NOT AT ALL. A single run means nothing, and a BLACK canvas still ticks rAF
  // at ~39 fps, so a frame-rate number is meaningless unless that run is known to have drawn.
  //
  // To work on it:  localStorage['artlux.scene3dShareDevice'] = '1'   ('2' = a fresh device, the
  // control that renders).
  const factory = async ({ canvas }: { canvas: HTMLCanvasElement }) => {
    try {
      if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
      if (preload) await preload;
      if (!nodeModules) {
        const [webgpu, tsl] = await Promise.all([import('three/webgpu'), import('three/tsl')]);
        nodeModules = { webgpu, tsl };
      }
      let shared: GPUDevice | null = null;
      if (shareMode === '1') shared = await gpuDevice();
      else if (shareMode === '2') {
        const ad = await navigator.gpu.requestAdapter();
        shared = ad ? await ad.requestDevice({ requiredFeatures: [...ad.features] as GPUFeatureName[] }) : null;
        console.info('[scene3d] DIAG: injecting a freshly created device');
      }
      return build(canvas, nodeModules.webgpu, shared);
    } catch (e) {
      // Returning anything r3f does not recognise as a renderer makes it build its own WebGLRenderer
      // from the default props — so a failed WebGPU init degrades to exactly today's behaviour rather
      // than leaving a dead canvas. Same graceful-degradation contract as the native addons.
      const reason = String((e as Error)?.message ?? e);
      console.warn('[scene3d] WebGPU renderer unavailable, falling back to WebGL —', reason);
      onFallback(reason);
      return null;
    }
  };
  // See the GlProp note: r3f awaits this at runtime, its types say it must not.
  return factory as unknown as GLProps;
}


/** True once a WebGPU renderer is actually live — for the UI to say so honestly. */
export function isWebGPURenderer(gl: unknown): boolean {
  return !!(gl as { isWebGPURenderer?: boolean })?.isWebGPURenderer;
}

// ── Node-material modules ───────────────────────────────────────────────────────────────────────
//
// `three/webgpu` and `three/tsl` are ~2 MB and only mean anything once a WebGPU renderer exists, so
// they are loaded with it (above) rather than imported at the top of every file that builds a node
// material. Those files run inside a frame and cannot await, hence the sync accessor.
//
// The two namespaces are typed as the modules themselves, so every TSL symbol keeps its real type —
// no `any` leaks out of here even though the import is dynamic.
type NodeModules = {
  webgpu: typeof import('three/webgpu');
  tsl: typeof import('three/tsl');
};
let nodeModules: NodeModules | null = null;

/**
 * The TSL/node-material namespaces, or null on the WebGL path. A caller that gets null must keep its
 * GLSL implementation — a `NodeMaterial` cannot render on a plain `WebGLRenderer`, and the projector
 * windows are still WebGL. Both expressions of a shared convention therefore have to exist at once.
 */
export function nodes(): NodeModules | null { return nodeModules; }

export type { THREE };
