import { Fixture, Surface, Controller, ColorOrder, FixtureProfile, type ChannelRole, type OutputProtocol } from '../types';
import { IPixelMapper } from '../services/PixelMapper';
import { GPUMapper } from '../services/GPUMapper';
import { WebGPUMapper } from '../gpu/WebGPUMapper';
import { publishGpuDevice } from '../gpu/gpuDevice';
import { sendArtNetFrame } from '../services/mockSocketService';
import { dmxSignal } from '../services/dmxSignal';
import { livePreview } from '../services/livePreview';
import { isLight } from '../services/fixtureKind';
import * as surfaceMedia from '../services/surfaceMedia';
import * as contentSource from '../services/contentSource';
import * as transitions from '../services/transitions';
import * as automationOverlay from '../services/automationOverlay';
import { resolveDest, destKey, fixtureFootprint } from '../services/addressing';
import * as profilePack from '../services/profilePack';
import * as fixtureSignal from '../services/fixtureSignal';
import * as lightingOverlay from '../services/lightingOverlay';
import * as lightingCue from '../services/lightingCue';
import { perfMonitor } from '../services/perfMonitor';


// THE RENDER/OUTPUT ENGINE — composite, sample, pack, publish.
//
// This is the pipeline that was living inside a React component. Everything it needs was already
// framework-free (services/, gpu/), and the component was reaching all of it through refs mirrored
// out of props — which is to say the input contract below already existed, written as a dozen
// useEffects. This file is that contract, stated once.
//
// WHY IT MOVED. `Stage` owned the requestAnimationFrame loop, so the app's Art-Net output existed
// only for as long as one React element stayed mounted. That is the root of the "Stage must never
// unmount" rule, and therefore of a workspace whose panels cannot be rearranged: a viewport that may
// not move is a viewport the layout has to be built around. Output should not be a property of the
// view tree.
//
// NOT REACT-AWARE, DELIBERATELY. No React import, no hooks, no DOM ownership beyond the optional
// preview canvas handed to it. The same discipline as services/timeline and services/perfMonitor,
// and what lets the loop keep running while the UI does whatever it likes.
//
// IT OWNS ITS OWN LOOP. The singleton starts a requestAnimationFrame at module load — the same idiom
// services/timeline.ts uses — so the pipeline is running before any component mounts and keeps running
// after every one of them has gone. Nothing here reads the DOM to decide whether to run a frame, which
// is the property the whole exercise was for: the Stage is now an ordinary view that may unmount,
// remount, or exist twice, and the output does not care.
//
// WHAT STILL LIVES IN THE VIEW: mapper construction + the backend/error reporting (WP-1.3).
// See plans/engine-decoupling.md.

/**
 * Everything the frame loop reads. One struct, pushed in with setInputs() — the successor to the
 * ref-mirroring effects that used to sit at the top of Stage. Any caller may set any subset; the
 * engine works out for itself what that invalidates.
 */
export interface FrameInputs {
  surfaces: Surface[];
  fixtures: Fixture[];
  controllers: Controller[];
  /**
   * Resolved DMX fixture profiles, by id. A profiled fixture's DMX footprint and its channel bytes
   * both come from here, so the SAME map must reach fixtureFootprint() and the packer or the patch
   * and the wire disagree.
   */
  fixtureProfiles: ReadonlyMap<string, FixtureProfile>;
  gamma: number;
  /** Committed brightness. The per-frame value comes from livePreview so a slider drag is free. */
  brightness: number;
  targetIp: string;
  broadcast: boolean;
  protocol: OutputProtocol;
  engineRunning: boolean;
  videoPlaying: boolean;
  /** Whether packed frames are actually sent to the transport. The operator's output switch. */
  outputEnabled: boolean;
  artNetPort: number;
  /** Engine tick rate (AppSettings.engineFps). Also the DECODE ASK RATE — see the setting for why. */
  engineFps: number;
  /**
   * Whether the 512² composite is actually on screen. Broadcast/headless run with no visible preview,
   * where compositing is dead work on the WebGPU path (fixtures sample per-surface, not the composite).
   */
  showPreview: boolean;
}

/** Things the engine has to tell the document about. Kept to the minimum that genuinely flows back. */
export interface FrameHost {
  /**
   * A surface was auto-fitted to its content's aspect ratio. This is the engine ASKING the document
   * to change — it used to be a setState called from inside the frame loop.
   */
  onSurfacesAutoFitted?: (surfaces: Surface[]) => void;
}

/**
 * Which GPU path came up, and whether it came up at all. The UI reports this honestly rather than
 * degrading in silence: the WebGL fallback does NOT do strict per-surface sampling, so a back-linked
 * fixture can pick up an overlapping front surface, and an operator is entitled to know.
 */
export interface EngineStatus {
  backend: 'webgpu' | 'webgl' | null;
  /** No GPU path at all — nothing will be sampled, and the UI says so in full. */
  failed: boolean;
}

// Hoisted so the composite z-sort doesn't allocate a fresh comparator every frame.
const byZIndex = (a: Surface, b: Surface) => a.zIndex - b.zIndex;

/** One shared empty map, so a rig with no profiled fixtures allocates nothing. */
export const EMPTY_PROFILES: ReadonlyMap<string, FixtureProfile> = new Map();

// Refresh cap for the operator's per-surface preview canvases. 30 Hz reads as smooth for
// monitoring while halving the raster work on a 60 Hz display. The LED/output path is never
// throttled by this — and neither is the WebGL fallback's composite, which is a sampling source,
// not a preview.
const PREVIEW_MS = 1000 / 30;

// Output channel source-index order per ColorOrder ([R=0,G=1,B=2]).
// A subtractive flag and the primary it takes out. Used by the lighting overlay's role lookup so a
// colour recorded in RGB can drive a CMY head — see the comment at its call site in packAndPublish.
const CMY_FROM_RGB: Partial<Record<ChannelRole, ChannelRole>> = { cyan: 'red', magenta: 'green', yellow: 'blue' };

const COLOR_ORDER: Record<ColorOrder, [number, number, number]> = {
  [ColorOrder.RGB]: [0, 1, 2],
  [ColorOrder.RBG]: [0, 2, 1],
  [ColorOrder.GRB]: [1, 0, 2],
  [ColorOrder.GBR]: [1, 2, 0],
  [ColorOrder.BRG]: [2, 0, 1],
  [ColorOrder.BGR]: [2, 1, 0],
};

const DEFAULT_INPUTS: FrameInputs = {
  surfaces: [], fixtures: [], controllers: [], fixtureProfiles: EMPTY_PROFILES,
  gamma: 1, brightness: 1, targetIp: '', broadcast: false, protocol: 'artnet',
  engineRunning: false, videoPlaying: false, outputEnabled: false, artNetPort: 6454, engineFps: 30,
  showPreview: true,
};

class FrameEngine {
  private inputs: FrameInputs = DEFAULT_INPUTS;
  private host: FrameHost = {};
  private mapper: IPixelMapper | null = null;

  // ── Derived from the inputs, rebuilt only when their source actually changes ──
  private gammaLut = buildGammaLut(1);
  /** Controller lookup, so the per-frame packing loop does an O(1) get() instead of an O(n) find(). */
  private controllerMap = new Map<string, Controller>();
  /** Change detection that used to be three useMemo signature strings + two effects. */
  private fixtureLayoutSig = '';
  private surfaceLayoutSig = '';
  private fixtureParamSig = '';

  // ── Compositing ──
  // The engine composites into its OWN canvas. The inversion is the point of this step: the
  // composite used to be drawn straight into the Stage's visible canvas, and on the WebGL fallback
  // that canvas WAS the sampling source — so LED output was reading pixels out of a DOM node owned
  // by a React component, and unmounting the component left the output with nothing to sample.
  // Since the per-surface preview (below) the composite exists ONLY as the WebGL fallback's
  // sampling source; on WebGPU it is never built. (WP-3.2 makes this an OffscreenCanvas, once the
  // engine is in a worker; a plain detached element is the smaller step and behaves identically to
  // texImage2D.)
  private composite: HTMLCanvasElement | null = null;
  private compositeCtx: CanvasRenderingContext2D | null = null;
  /**
   * Where the operator sees it — when there is an operator. One lent canvas PER SURFACE, painted
   * and positioned by the engine, so a surface placed outside the unit document still shows its
   * content (the old single 512² composite blit silently dropped anything off the square's raster).
   * Optional, and never load-bearing: an empty map costs the operator a picture and the show nothing.
   */
  private surfacePreviews = new Map<string, { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D | null; geomSig: string }>();
  private lastPreviewPaint = -1e9;
  private lastPreviewBrightness = -1;

  // ── Per-frame scratch, reused so the hot loop allocates nothing ──
  private orderedSurfaces: Surface[] = [];
  private universeBuffers: Record<string, number[]> = {};
  /** Per-surface key of the content already aspect-fitted, so we fit once per source. */
  private fittedAspect = new Map<string, string>();

  /** The loop's own handle. Started on construction, stopped by nothing. */
  private raf = 0;
  private status: EngineStatus = { backend: null, failed: false };
  private statusSubs = new Set<() => void>();

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────

  /**
   * The loop starts with the object, and there is deliberately no stop(): running the output is not
   * something the UI gets to decide. Every previous way of stopping it — unmounting a component,
   * losing a canvas, an ErrorBoundary catching a render throw — was a bug that took the show with it.
   * `engineRunning` in the inputs gates OUTPUT; the loop itself simply runs.
   */
  constructor() {
    if (typeof requestAnimationFrame === 'undefined') return; // no rAF (a test harness) — stay idle
    void this.initMapper();
    // ── THE TICK RATE IS ALSO THE DECODE ASK RATE ───────────────────────────────────────────────
    // Every tick asks each layer's codec for the exact frame at the playhead. Asking faster than the
    // decoder can serve does not produce more pictures — it produces MISSES: the ring hands back the
    // nearest frame it has, and a burst of those is what an operator reports as the picture stopping
    // and starting.
    //
    // Measured on a 1080p60 HAP show looping every 14 s. Uncapped (rAF, ~60 Hz of asks): 19% of exact
    // frames missed, clustered ~78 into the half second after each loop wrap. At 25 Hz on the same
    // content: 0.27%, worst half-second 9, and every scene cut clean. The projector window — which
    // decodes only the one surface it draws — missed 0.007% throughout, which is what pointed here.
    //
    // NOT the Art-Net wire rate. The native pacer sends at AppSettings.fps (44 by default) with
    // keep-alive, so a slower engine repeats the last frame on the wire rather than starving a node;
    // what changes is how often NEW pixel data is produced. Rate comes from AppSettings.engineFps.
    let lastTick = -1e9;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const cap = this.inputs.engineFps;
      if (cap > 0 && now - lastTick < 1000 / cap - 0.5) return;
      lastTick = now;
      this.tick();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * Bring up a GPU path: WebGPU compute first, the WebGL sampler as a fallback, and an honest failure
   * if neither works. This used to be an effect inside the Stage, which meant the app's ability to
   * sample pixels was created and destroyed by a component's lifecycle.
   */
  private async initMapper(): Promise<void> {
    let m: IPixelMapper | null = null;
    try {
      m = await WebGPUMapper.create();
      if (m) { console.log('[engine] using the WebGPU compute mapper'); this.setStatus({ backend: 'webgpu', failed: false }); }
    } catch {
      m = null;
    }
    // Publish the device — or the absence of one — before anything else. The 3D scene blocks on this
    // to decide whether it can share (see gpu/gpuDevice); a fallback that never published would leave
    // it waiting forever instead of building its own renderer.
    publishGpuDevice(m instanceof WebGPUMapper ? m.getDevice() : null);
    if (!m) {
      try {
        m = new GPUMapper(512, 512);
        console.log('[engine] using the WebGL mapper (fallback)');
        this.setStatus({ backend: 'webgl', failed: false });
      } catch (e) {
        console.error('[engine] no GPU mapper could be initialized:', e);
        this.setStatus({ backend: null, failed: true });
        return;
      }
    }
    this.setMapper(m);
  }

  // ── Status ────────────────────────────────────────────────────────────────────────────────────

  getStatus = (): EngineStatus => this.status;
  subscribeStatus = (cb: () => void): (() => void) => { this.statusSubs.add(cb); return () => { this.statusSubs.delete(cb); }; };

  private setStatus(next: EngineStatus): void {
    if (next.backend === this.status.backend && next.failed === this.status.failed) return;
    this.status = next;
    // Recorded per machine so Settings ▸ GPU rendering can report which path is live.
    if (next.backend) { try { localStorage.setItem('artlux.activeBackend', next.backend); } catch { /* ignore */ } }
    for (const cb of this.statusSubs) cb();
  }

  // ── Inputs ────────────────────────────────────────────────────────────────────────────────────

  setHost(host: FrameHost): void { this.host = host; }

  setMapper(m: IPixelMapper | null): void {
    this.mapper = m;
    if (!m) return;
    // Apply everything the engine already knows — the mapper is built asynchronously and typically
    // arrives after the first inputs have landed.
    m.updateMapping(this.inputs.fixtures, this.inputs.surfaces);
    m.updateParams?.(this.inputs.fixtures);
    m.setBrightness(this.inputs.brightness);
  }

  /**
   * Lend the engine one surface's preview canvas. Passing null (the element unmounted, the surface
   * was deleted, an HMR swap) costs the operator that surface's picture and costs the show nothing.
   * A new element for a known id resets the cached ctx and geometry signature — same "re-fetch if
   * the element was replaced" idiom the old single-canvas blit used, so a remount can't go stale.
   */
  setSurfacePreviewCanvas(id: string, el: HTMLCanvasElement | null): void {
    if (!el) { this.surfacePreviews.delete(id); return; }
    const cur = this.surfacePreviews.get(id);
    if (cur?.canvas === el) return;
    this.surfacePreviews.set(id, { canvas: el, ctx: null, geomSig: '' });
  }

  /**
   * Push any subset of the inputs. The engine diffs and does the invalidation itself, so callers do
   * not have to know that (say) moving a fixture requires a GPU remap while changing its intensity
   * does not. Cheap to call with everything on every render — that is the intended usage.
   */
  setInputs(patch: Partial<FrameInputs>): void {
    const prev = this.inputs;
    const next = { ...prev, ...patch };
    this.inputs = next;

    // Loopback DMX-in listens on the universes our patched fixtures touch, so a back rig on sACN
    // universe 8+ is mirrored. The span comes from addressing.ts's fixtureFootprint (the one owner of
    // that formula, so a profiled fixture's mode footprint is honoured here too).
    if (next.fixtures !== prev.fixtures || next.fixtureProfiles !== prev.fixtureProfiles) {
      const touched = new Set<number>();
      for (const f of next.fixtures) {
        const startAbs = f.universe * 512 + (f.startAddress - 1);
        const endAbs = startAbs + Math.max(0, fixtureFootprint(f, next.fixtureProfiles) - 1);
        for (let u = Math.floor(startAbs / 512); u <= Math.floor(endAbs / 512); u++) touched.add(u);
      }
      contentSource.setDmxInputUniverses([...touched]);
    }

    // The media service owns element lifecycle for whatever the surfaces reference.
    if (next.surfaces !== prev.surfaces || next.videoPlaying !== prev.videoPlaying) {
      surfaceMedia.syncSurfaces(next.surfaces, next.videoPlaying);
    }

    if (next.controllers !== prev.controllers) {
      this.controllerMap = new Map(next.controllers.map(c => [c.id, c]));
    }

    if (next.gamma !== prev.gamma) this.gammaLut = buildGammaLut(next.gamma);

    // Mirror committed brightness into the imperative live channel, so scene recall / project load
    // stay in sync. Live drags write to livePreview directly and never come through here.
    if (next.brightness !== prev.brightness) livePreview.setBrightness(next.brightness);

    // Geometry vs params: a move rebuilds the per-LED GPU buffers, an intensity change only re-uploads
    // parameters. This is the change detection that used to be two JSON.stringify useMemos + effects.
    if (next.fixtures !== prev.fixtures || next.surfaces !== prev.surfaces) {
      const fSig = fixtureLayoutSignature(next.fixtures);
      const sSig = surfaceLayoutSignature(next.surfaces);
      if (fSig !== this.fixtureLayoutSig || sSig !== this.surfaceLayoutSig) {
        this.fixtureLayoutSig = fSig;
        this.surfaceLayoutSig = sSig;
        this.mapper?.updateMapping(next.fixtures, next.surfaces);
      }
    }
    if (next.fixtures !== prev.fixtures) {
      const pSig = fixtureParamSignature(next.fixtures);
      if (pSig !== this.fixtureParamSig) {
        this.fixtureParamSig = pSig;
        this.mapper?.updateParams?.(next.fixtures);
      }
    }
  }

  /** The live arrays. The view reads these while a drag is in flight. */
  getSurfaces(): Surface[] { return this.inputs.surfaces; }
  getFixtures(): Fixture[] { return this.inputs.fixtures; }

  // ── The frame ─────────────────────────────────────────────────────────────────────────────────

  /**
   * One frame: composite → sample → pack → publish. Driven by the engine's own rAF.
   *
   * NOTE WHAT IS NOT HERE. There is no check that a container exists, and none that a canvas exists.
   * Those two lines used to sit at the top of this loop, and between them they meant that Art-Net
   * stopped the moment a React component went away — even on the WebGPU path, where the sampling
   * never touched the visible canvas at all. The only gate left is "is there a mapper", which is
   * about the GPU, not the DOM.
   */
  tick(): void {
    // Record the inter-frame interval (unconditional; two performance.now() reads). endFrame() below
    // closes the work measurement once this frame's compute/pack/publish is done.
    perfMonitor.beginFrame();
    if (!this.mapper) return;
    const mapper = this.mapper;
    const { engineRunning, showPreview } = this.inputs;

    // Fit each surface's rect to its content's aspect ratio once the media is loaded (once per
    // source). Keeps width + top-left, derives height (the canvas is square, so a normalized w/h
    // ratio equals the displayed pixel ratio). User scale stays uniform.
    {
      let fitUpdate: Surface[] | null = null;
      for (const s of this.inputs.surfaces) {
        const aspect = surfaceMedia.getContentAspect(s);
        if (!aspect) continue;
        // The aspect is PART OF THE KEY, not just the url. A LAYER surface's identity string never
        // changes (it's the layer id — the clips under it come and go), so a url-only key would fit
        // once on the first clip and never again. Keying on the measured aspect re-fits exactly when
        // the shape of the content actually changes, and still leaves a manual resize alone while
        // the content is unchanged — which is the behaviour the one-shot fit was written for.
        const key = `${s.content.type}:${s.content.url ?? s.content.layerId ?? s.content.spoutName ?? ''}:${aspect.toFixed(3)}`;
        if (this.fittedAspect.get(s.id) === key) continue;
        this.fittedAspect.set(s.id, key);
        if (Math.abs(s.width / s.height - aspect) > 0.01) {
          if (!fitUpdate) fitUpdate = [...this.inputs.surfaces];
          const i = fitUpdate.findIndex(x => x.id === s.id);
          fitUpdate[i] = { ...s, height: Math.max(0.01, s.width / aspect) };
        }
      }
      if (fitUpdate) {
        this.inputs = { ...this.inputs, surfaces: fitUpdate };
        this.host.onSurfacesAutoFitted?.(fitUpdate);
      }
    }

    // Render-free overrides, laid over the committed state each frame so they animate at display rate
    // without a React re-render (idle ⇒ pass-through). ORDER MATTERS:
    //   ① automation — a keyframe lane owns its path outright, so it is the BASE.
    //   ② the scene/cue fade — it runs ON TOP, and for an automated path it re-reads its destination
    //      from ① (transitions.toDynamic), so a recall glides onto the curve instead of snapping to a
    //      stale value. Get this order backwards and every automated param jumps the instant a scene
    //      is recalled. See the precedence note in transitions.ts.
    let effSurfaces = this.inputs.surfaces;
    let effFixtures = this.inputs.fixtures;
    let effBrightness = livePreview.brightness;
    // Read the dirty flags BEFORE the isActive() check, not inside it: releasing the last lane empties
    // the overlay, so isActive() is already false on the frame the authored value must be re-uploaded.
    // Guarding the read on it would leave the GPU holding the last automated value for good.
    let geomDirty = automationOverlay.geometryAnimating();
    const paramsDirty = automationOverlay.paramsAnimating();
    automationOverlay.consumeDirty();
    if (automationOverlay.isActive()) {
      const v = automationOverlay.apply({ surfaces: effSurfaces, fixtures: effFixtures, globalBrightness: effBrightness });
      effSurfaces = v.surfaces; effFixtures = v.fixtures; effBrightness = v.globalBrightness;
    }
    const fade = transitions.sample(performance.now());
    if (fade) {
      const v = fade.apply({ surfaces: effSurfaces, fixtures: effFixtures, globalBrightness: effBrightness });
      effSurfaces = v.surfaces; effFixtures = v.fixtures; effBrightness = v.globalBrightness;
      if (fade.geometryAnimating) geomDirty = true;
    }
    // Geometry moves change the LED↔surface UV mapping → rebuild the GPU LED buffers this frame.
    if (geomDirty) mapper.updateMapping?.(effFixtures, effSurfaces);
    // Non-geometry fixture params (intensity/speed) otherwise reach the GPU only through the input
    // diff above — which a render-free override never touches. Without this, an automated intensity
    // would animate everywhere EXCEPT the LEDs.
    else if (paramsDirty) mapper.updateParams?.(effFixtures);

    // Composite every surface's content into the 512² canvas (z-order) — WEBGL FALLBACK ONLY.
    // There the composite IS the sampling source, so it is not optional and must never be
    // throttled — throttling it would throttle the actual LED output. On the WebGPU path nothing
    // reads it (renderSurfaces uploads each surface's own drawable; rawBytes comes from the compute
    // readback; the operator's preview is the per-surface canvases below), so it is never built.
    const perSurface = !!(mapper.perSurface && mapper.renderSurfaces);
    if (!perSurface) {
      const ctx = this.compositeContext();
      if (ctx) {
        const cw = ctx.canvas.width;
        const ch = ctx.canvas.height;
        ctx.imageSmoothingEnabled = true;
        ctx.clearRect(0, 0, cw, ch);
        // Sort into a reused scratch array (no per-frame spread allocation).
        const ordered = this.orderedSurfaces;
        ordered.length = 0;
        for (let i = 0; i < effSurfaces.length; i++) ordered.push(effSurfaces[i]);
        ordered.sort(byZIndex);
        for (const s of ordered) {
          const d = surfaceMedia.getDrawable(s);
          if (!d) continue;
          ctx.globalAlpha = s.content.opacity ?? 1; // per-surface opacity (z-order alpha blend)
          const x = s.x * cw, y = s.y * ch, w = s.width * cw, h = s.height * ch;
          if (s.rotation) {
            ctx.save();
            ctx.translate(x + w / 2, y + h / 2);
            ctx.rotate((s.rotation * Math.PI) / 180);
            ctx.drawImage(d, -w / 2, -h / 2, w, h);
            ctx.restore();
          } else {
            ctx.drawImage(d, x, y, w, h);
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Paint the operator's per-surface previews (30 Hz; cosmetic; failure here cannot affect
    // output). Painted from effSurfaces — the render-free overrides (automation lanes, scene
    // fades) move geometry and opacity without touching React, and the preview must follow them
    // exactly as the old composite did. The gate lives INLINE, never at the top of tick(): a
    // view condition that could return out of the frame loop is the bug class the engine
    // extraction exists to prevent (guarded by verify:invariants).
    if (showPreview && this.surfacePreviews.size > 0) {
      const nowMs = performance.now();
      if (nowMs - this.lastPreviewPaint >= PREVIEW_MS) {
        this.lastPreviewPaint = nowMs;
        this.paintSurfacePreviews(effSurfaces);
      }
    }

    if (engineRunning) {
      // Pull brightness from the live channel each frame so slider drags affect output immediately
      // without committing React state (which would re-render the whole app).
      mapper.setBrightness(effBrightness);
      // The preview canvases dim through a CSS var that livePreview owns — and a render-free override
      // never goes through livePreview. Without this the LEDs would dim while the preview stayed
      // bright, so the preview would lie about what is actually leaving the machine. Purely a preview
      // concern, so it is skipped when there is no preview (broadcast, headless, view unmounted).
      if (this.surfacePreviews.size > 0 && effBrightness !== this.lastPreviewBrightness) {
        this.lastPreviewBrightness = effBrightness;
        document.documentElement.style.setProperty('--preview-brightness', String(effBrightness));
      }
      // WebGPU samples each fixture strictly from its linked surface; the WebGL fallback samples the
      // engine's own composite — which is why that composite is no longer the visible canvas.
      if (mapper.perSurface && mapper.renderSurfaces) {
        mapper.renderSurfaces((id) => {
          const s = effSurfaces.find((x) => x.id === id);
          return s ? surfaceMedia.getDrawable(s) : null;
        }, (id) => effSurfaces.find((x) => x.id === id)?.content.opacity ?? 1);
      } else if (this.composite) {
        mapper.updateSource(this.composite);
      }
      // Offer the GPU's own measurement of the sampling pass. Cheap and unconditional: the mapper
      // returns its last value (or null), and perfMonitor de-duplicates, so this costs one call per
      // frame and records only when a new measurement has actually landed. Without it the CPU work
      // time below is the only number we have, and a busy CPU and a busy GPU look identical.
      perfMonitor.noteGpuUs(mapper.gpuSample ? mapper.gpuSample() : null);

      const rawBytes = mapper.read();

      if (rawBytes) {
        this.packAndPublish(rawBytes, effFixtures);
      }
    }

    perfMonitor.endFrame();
  }

  /**
   * The engine's own 512² composite target, created on first use. 512 because the backing buffer maps
   * 1:1 to a normalized UV square — surfaces and LEDs are in 0–1 coords, so sampling is unaffected by
   * whatever size the operator's viewport happens to be.
   */
  private compositeContext(): CanvasRenderingContext2D | null {
    if (!this.compositeCtx) {
      if (typeof document === 'undefined') return null;
      this.composite = document.createElement('canvas');
      this.composite.width = 512;
      this.composite.height = 512;
      this.compositeCtx = this.composite.getContext('2d');
    }
    return this.compositeCtx;
  }

  /**
   * Paint (and position) every lent surface-preview canvas. Cosmetic; failure here cannot affect
   * output. Iterates effSurfaces — an entry whose surface is gone is simply never painted, and the
   * ref callback deletes it when React drops the element.
   *
   * The engine writes the element's position STYLES as well as its pixels. That is deliberate, and
   * it is the same doctrine as the `--preview-brightness` documentElement write above and
   * PersistentLayer's direct style writes: automation lanes and scene fades move surface geometry
   * render-free (effSurfaces), so a React-positioned element would sit still while its content
   * plays a move the LEDs are already following. Signature-cached, so a static layout writes no
   * styles at all.
   */
  private paintSurfacePreviews(effSurfaces: Surface[]): void {
    for (const s of effSurfaces) {
      const entry = this.surfacePreviews.get(s.id);
      if (!entry) continue;
      // Position/rotation/stacking, only when the geometry actually changed.
      const sig = `${s.x},${s.y},${s.width},${s.height},${s.rotation},${s.zIndex}`;
      if (entry.geomSig !== sig) {
        entry.geomSig = sig;
        const st = entry.canvas.style;
        st.left = `${s.x * 100}%`;
        st.top = `${s.y * 100}%`;
        st.width = `${s.width * 100}%`;
        st.height = `${s.height * 100}%`;
        st.transform = s.rotation ? `rotate(${s.rotation}deg)` : '';
        st.zIndex = String(s.zIndex);
      }
      // Backing store at document scale (512 = the old composite's raster, so resolution parity),
      // capped so an operator who scales a surface to 20× the document can't allocate unbounded
      // memory. A resize clears the canvas, which the repaint below covers.
      const bw = Math.min(2048, Math.max(1, Math.round(s.width * 512)));
      const bh = Math.min(2048, Math.max(1, Math.round(s.height * 512)));
      if (entry.canvas.width !== bw) entry.canvas.width = bw;
      if (entry.canvas.height !== bh) entry.canvas.height = bh;
      if (entry.ctx?.canvas !== entry.canvas) entry.ctx = entry.canvas.getContext('2d');
      const ctx = entry.ctx;
      if (!ctx) continue;
      ctx.clearRect(0, 0, bw, bh);
      const d = surfaceMedia.getDrawable(s);
      if (!d) continue; // no content → transparent, same as the composite skipped it
      // Opacity is baked into the pixels (not CSS opacity) so stacked sibling canvases reproduce
      // the composite's z-ordered source-over blend — and so an automated opacity stays live.
      ctx.globalAlpha = s.content.opacity ?? 1;
      ctx.drawImage(d, 0, 0, bw, bh);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Universe packing + publish. Split out of tick() only for readability — it is the same straight
   * line of work, and it allocates nothing per frame beyond the destination bookkeeping.
   */
  private packAndPublish(rawBytes: Uint8Array, currentFixtures: Fixture[]): void {
    let offset = 0;
    const pool = this.universeBuffers;

    // Zero all pooled arrays (prevents ghosting when config changes).
    for (const k in pool) pool[k].fill(0);

    const defaultIp = this.inputs.targetIp;
    const defaultBroadcast = this.inputs.broadcast;
    const defaultProtocol = this.inputs.protocol;

    // Resolved role values for every profiled fixture this frame (pan/tilt in degrees, colour,
    // intensity) — published after the loop for the 3D scene and the beams.
    const fixtureStates = new Map<string, fixtureSignal.FixtureState>();

    // THE PRECEDENCE STACK, ENFORCED IN ONE PLACE:
    //   profile default < authored dmx < LIGHTING CLIP < POSE CUE < automation lane < live override
    //
    // Automation has already been folded into `currentFixtures` by the caller (automationOverlay lays
    // it over the StateView), so a lane's value is sitting in `f.dmx` by now. Asking the overlay
    // whether it OWNS the path is therefore the whole rule: if a lane owns it, the authored value
    // already IS the lane's and neither the cue nor the clip must speak; if not, a FIRED POSE CUE
    // wins over a clip that happens to be running, and the clip wins over what the operator parked
    // there by hand.
    //
    // The cue sits BELOW the lane, not at the top, on purpose — see services/lightingCue. Putting it
    // above would break "a lane always wins", and the top layer is livePreview: a fader drag right
    // now, which a cue fired by the scheduler at 3 a.m. is not.
    lightingCue.tick(performance.now());
    const cueLive = lightingCue.isActive();
    const roleOverride: profilePack.RoleOverride | undefined = (lightingOverlay.isActive() || cueLive)
      ? (fixtureId, channel) => {
          if (automationOverlay.owns(`fixtures.${fixtureId}.dmx.${channel.key}`)) return undefined;
          const cued = cueLive ? lightingCue.get(fixtureId, channel.role) : undefined;
          const direct = cued ?? lightingOverlay.get(fixtureId, channel.role);
          if (direct !== undefined) return direct;
          // COLOUR CROSSES THE MIXING MODEL. A take and a pose key store colour as red/green/blue
          // (fixtureSignal.ROLES_CAPTURED has no cyan/magenta/yellow, because the resolved signal is
          // an RGB reading whatever the head does internally). A discharge head has no channel with
          // role `red`, so without this every recorded colour move landed on a CMY rig as silence —
          // the clip looked right, the heads never changed. Cyan takes out red, and so on: the same
          // dichroic assignment fixtureSignal reads them back with, so the round trip closes.
          const complement = CMY_FROM_RGB[channel.role];
          if (!complement) return undefined;
          const rgb = (cueLive ? lightingCue.get(fixtureId, complement) : undefined)
            ?? lightingOverlay.get(fixtureId, complement);
          return rgb === undefined ? undefined : 1 - rgb;
        }
      : undefined;

    // THE LIVE LAYER — a fader under a hand right now, above everything else including a running
    // clip. Skipped entirely (no closure, no lookup) whenever nothing is being dragged, which is
    // every frame of a show. See services/livePreview for why this exists at all.
    const liveOverride: profilePack.ChannelOverride | undefined = livePreview.liveChannels > 0
      ? (fx, channel) => livePreview.readFixtureChannel(fx.id, channel.key, fx.dmx?.[channel.key])
      : undefined;

    // Per-destination universe maps, keyed by `${protocol}|${ip}|${broadcast}`.
    const destinations: Record<string, {
      ip: string; protocol: OutputProtocol; broadcast: boolean; sparse: boolean;
      priority?: number; universes: Record<number, number[]>;
    }> = {};

    for (let fIdx = 0; fIdx < currentFixtures.length; fIdx++) {
      const f = currentFixtures[fIdx];

      // Destination resolves from the per-fixture output override → controller → global settings.
      // Shared with the Routing collision detector via resolveDest/destKey so the UI's overlap check
      // and this real output never drift.
      const ctrl = f.controllerId ? this.controllerMap.get(f.controllerId) : undefined;
      const wire = resolveDest(f, ctrl, { protocol: defaultProtocol, ip: defaultIp, broadcast: defaultBroadcast });
      const proto = wire.protocol;
      // For a USB widget the COM path IS the address — it travels in the same `ip` slot the network
      // protocols use, so the frame codec and the Rust engine needed no new field.
      const ip = wire.protocol === 'enttec' ? (wire.port ?? '') : wire.ip;
      const bcast = wire.broadcast;
      const priority = f.output?.priority ?? ctrl?.priority;
      const sparse = f.output?.sparse ?? false;
      const dk = destKey(wire);
      let dest = destinations[dk];
      if (!dest) {
        dest = { ip, protocol: proto, broadcast: bcast, sparse: false, priority, universes: {} };
        destinations[dk] = dest;
      }
      dest.sparse = dest.sparse || sparse;

      // Fetch (or lazily create) a pooled 512-array for a universe in this dest.
      const getArr = (u: number): number[] => {
        const pk = `${dk}#${u}`;
        let arr = pool[pk];
        if (!arr) { arr = new Array(512).fill(0); pool[pk] = arr; }
        if (!dest!.universes[u]) dest!.universes[u] = arr;
        return arr;
      };

      let currentUniverse = f.universe;
      let currentChannel = f.startAddress - 1; // 0-based

      const order = COLOR_ORDER[f.colorOrder ?? ColorOrder.RGB];
      const o0 = order[0], o1 = order[1], o2 = order[2];
      const cpp = f.channelsPerPixel ?? 4;
      const lut = this.gammaLut;

      // Fetch the destination universe array lazily and re-fetch only when a write spills past
      // channel 512. The lazy fetch preserves the original registration semantics exactly: a universe
      // appears in `dest.universes` only if a channel is actually written into it (no trailing/empty
      // universe when a fixture ends on a 512 boundary, none for a 0-LED fixture).
      let arr: number[] | null = null;
      const writeCh = (val: number) => {
        if (currentChannel >= 512) { currentUniverse++; currentChannel = 0; arr = null; }
        if (!arr) arr = getArr(currentUniverse);
        arr[currentChannel] = val;
        currentChannel++;
      };

      // ── PROFILED FIXTURE (a moving head / wash / beam) ────────────────────────────
      // Its channels are named parameters at fixed offsets in the mode, not colour components, so it
      // packs from its authored values rather than from sampled pixels — and NOT through the gamma
      // LUT, which would move the head to the wrong angle. See services/profilePack.ts.
      //
      // It still consumes ONE pixel of the canonical buffer (ledCount is pinned to 1 for a profiled
      // fixture), so `offset` stays in step with the monitor and the 3D scene, both of which index
      // that buffer by cumulative ledCount.
      if (isLight(f)) {
        const profile = this.inputs.fixtureProfiles.get(f.profileId!);
        const mode = profile ? profilePack.modeOf(profile, f.profileMode) : undefined;
        // An UNRESOLVED profile writes nothing at all. That matches fixtureFootprint() returning 0 for
        // the same case, so the patch and the wire still agree — a fixture we cannot describe occupies
        // no channels and disturbs no neighbour.
        if (profile && mode) {
          profilePack.packProfiled(f, profile, mode, writeCh, roleOverride, liveOverride);
          // Publish what this fixture is DOING, in roles and degrees, for the 3D scene and the beams.
          // Resolved here rather than in the scene so there is exactly one interpretation of
          // "intensity"/"pan" in the app — see fixtureSignal.
          //
          // ⚠ THE LIVE LAYER MUST REACH HERE TOO, not just the wire. This is the signal the take
          // recorder samples, so a drag that moved the rig but not this map would still record a
          // step; and it is what the 3D scene draws, so the head would not follow your hand.
          fixtureStates.set(f.id, fixtureSignal.resolveFixture(f, profile, roleOverride, liveOverride));
        }
        offset += f.ledCount;
        continue;
      }

      for (let i = 0; i < f.ledCount; i++) {
        const idx = offset * 4;
        if (idx + 3 >= rawBytes.length) break;

        // rawBytes is linear RGBW; remap RGB to the fixture's color order + gamma-correct.
        const r = rawBytes[idx], g = rawBytes[idx + 1], b = rawBytes[idx + 2];
        writeCh(lut[o0 === 0 ? r : o0 === 1 ? g : b]);
        writeCh(lut[o1 === 0 ? r : o1 === 1 ? g : b]);
        writeCh(lut[o2 === 0 ? r : o2 === 1 ? g : b]);
        if (cpp === 4) writeCh(lut[rawBytes[idx + 3]]);

        offset++;
      }
    }

    // Broadcast canonical pixels (monitor/3D) + routing destinations (output).
    dmxSignal.publish(rawBytes, destinations);
    // …and put them on the wire. This was a dmxSignal SUBSCRIBER living in App — which made sending
    // Art-Net something a React component opted into, and re-subscribed on every settings change. It
    // is not a side effect of the document; it is the last step of the frame. sendArtNetFrame gates on
    // its own ~44 Hz throttle before building any target list, so a throttled-away frame costs nothing.
    if (this.inputs.outputEnabled) sendArtNetFrame(destinations, this.inputs.artNetPort);
    // …and the profiled fixtures' resolved roles. Always published, even when empty, so a consumer
    // sees a fixture DISAPPEAR (profile cleared, fixture deleted) rather than holding its last pose
    // forever.
    fixtureSignal.publish(fixtureStates);
  }
}

/** Output gamma LUT (applied during universe packing). Identity when gamma = 1. */
function buildGammaLut(gamma: number): Uint8Array {
  const lut = new Uint8Array(256);
  const g = gamma && gamma > 0 ? gamma : 1;
  for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, g) * 255);
  return lut;
}

/** Anything that changes a per-LED surface-local UV or the GPU buffer layout. */
function fixtureLayoutSignature(fixtures: Fixture[]): string {
  return JSON.stringify(fixtures.map(f => ({
    id: f.id, x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation, c: f.ledCount,
    rev: f.reverse, sh: f.shape, mw: f.matrixWidth, mh: f.matrixHeight, sp: f.serpentine,
    lm: f.ledMap ? f.ledMap.length : 0, surf: f.surfaceId ?? '',
    seg: f.segments ? f.segments.map(s => `${s.start}-${s.stop}`).join(',') : '',
  })));
}

/** Surface geometry/linkage affects per-LED surface-local UVs and pass order. */
function surfaceLayoutSignature(surfaces: Surface[]): string {
  return JSON.stringify(surfaces.map(s => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: s.height, r: s.rotation, z: s.zIndex })));
}

/** Cheap per-fixture effect/palette params (sliders/dropdowns) — no reallocation on the GPU. */
function fixtureParamSignature(fixtures: Fixture[]): string {
  return JSON.stringify(fixtures.map(f => ({
    s: f.source, e: f.effectId, p: f.paletteId, sp: f.speed, it: f.intensity, rw: f.rgbwMode,
    // s.off drives the segment's GPU mode (-2 off / -1 media) — must be in the param signature so
    // toggling Off re-uploads segParams via the cheap updateParams path (no full remap).
    segp: f.segments ? f.segments.map(s => `${s.off ? 1 : 0},${s.source},${s.effectId},${s.paletteId},${s.speed},${s.intensity}`).join('|') : '',
  })));
}

// Constructing the singleton starts the loop, the way services/timeline.ts does. Importing this
// module IS starting the engine — there is no "a component mounted, therefore output exists" step any
// more, which was the whole problem. The loop idles cheaply until a mapper and `engineRunning` arrive.
export const frameEngine = new FrameEngine();
