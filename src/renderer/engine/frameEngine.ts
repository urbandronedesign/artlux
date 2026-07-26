import { Fixture, Surface, Controller, ColorOrder, FixtureProfile, type OutputProtocol } from '../types';
import { IPixelMapper } from '../services/PixelMapper';
import { dmxSignal } from '../services/dmxSignal';
import { livePreview } from '../services/livePreview';
import * as surfaceMedia from '../services/surfaceMedia';
import * as contentSource from '../services/contentSource';
import * as transitions from '../services/transitions';
import * as automationOverlay from '../services/automationOverlay';
import { resolveDest, destKey, fixtureFootprint } from '../services/addressing';
import * as profilePack from '../services/profilePack';
import * as fixtureSignal from '../services/fixtureSignal';
import * as lightingOverlay from '../services/lightingOverlay';
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
// WHAT STILL LIVES IN THE VIEW (and moves next):
//   • the rAF loop itself — Stage still drives it and calls tick() (WP-1.2)
//   • `domReady` below, the last DOM gate on output (WP-1.2 deletes it)
//   • mapper construction + the backend/error reporting (WP-1.3)
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

// Hoisted so the composite z-sort doesn't allocate a fresh comparator every frame.
const byZIndex = (a: Surface, b: Surface) => a.zIndex - b.zIndex;

/** One shared empty map, so a rig with no profiled fixtures allocates nothing. */
export const EMPTY_PROFILES: ReadonlyMap<string, FixtureProfile> = new Map();

// Refresh cap for the operator's preview composite, used ONLY when the mapper samples per-surface
// (so the composite feeds the preview and nothing else). 30 Hz reads as smooth for monitoring while
// halving the rescale work on a 60 Hz display. The LED/output path is never throttled by this.
const PREVIEW_MS = 1000 / 30;

// Output channel source-index order per ColorOrder ([R=0,G=1,B=2]).
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
  engineRunning: false, videoPlaying: false, showPreview: true,
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

  // ── The preview canvas. The engine draws into it; it does not own or create it. ──
  private previewCanvas: HTMLCanvasElement | null = null;
  private canvasCtx: CanvasRenderingContext2D | null = null;
  private lastPreviewComposite = -1e9;
  private lastPreviewBrightness = -1;

  // ── Per-frame scratch, reused so the hot loop allocates nothing ──
  private orderedSurfaces: Surface[] = [];
  private universeBuffers: Record<string, number[]> = {};
  /** Per-surface key of the content already aspect-fitted, so we fit once per source. */
  private fittedAspect = new Map<string, string>();

  /**
   * TEMPORARY, and the whole point of the next step. Output currently still requires the view to be
   * mounted, because this is the gate `if (!containerRef.current)` used to be. WP-1.2 deletes it:
   * nothing in the pipeline below reads the DOM, so nothing about it should depend on the DOM.
   */
  private domReady = false;

  // ── Inputs ────────────────────────────────────────────────────────────────────────────────────

  setHost(host: FrameHost): void { this.host = host; }
  setDomReady(ready: boolean): void { this.domReady = ready; }

  setMapper(m: IPixelMapper | null): void {
    this.mapper = m;
    if (!m) return;
    // Apply everything the engine already knows — the mapper is built asynchronously and typically
    // arrives after the first inputs have landed.
    m.updateMapping(this.inputs.fixtures, this.inputs.surfaces);
    m.updateParams?.(this.inputs.fixtures);
    m.setBrightness(this.inputs.brightness);
  }

  setPreviewCanvas(el: HTMLCanvasElement | null): void {
    this.previewCanvas = el;
    this.canvasCtx = null;
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

  /** One frame: composite → sample → pack → publish. Currently called by Stage's rAF (WP-1.2). */
  tick(): void {
    // Record the inter-frame interval (unconditional; two performance.now() reads). endFrame() below
    // closes the work measurement once this frame's compute/pack/publish is done.
    perfMonitor.beginFrame();
    if (!this.domReady || !this.mapper) return;
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

    // Composite every surface's content into the 512² canvas (z-order). Fixtures sample this
    // composite on the WebGL path; on the WebGPU path it is PREVIEW ONLY.
    //
    // Skip it entirely when the preview is hidden (broadcast/headless) AND the mapper samples
    // per-surface — there the composite feeds nothing (renderSurfaces uploads each surface's own
    // drawable; rawBytes comes from the compute readback).
    const perSurface = !!(mapper.perSurface && mapper.renderSurfaces);
    let needComposite = showPreview || !perSurface;
    // ⚠ Only throttle in the per-surface case. On the WebGL fallback this canvas IS the sampling
    // source (updateSource below reads it), so throttling it would throttle the actual LED output.
    if (needComposite && perSurface) {
      const nowMs = performance.now();
      if (nowMs - this.lastPreviewComposite < PREVIEW_MS) needComposite = false;
      else this.lastPreviewComposite = nowMs;
    }
    const canvas = this.previewCanvas;
    if (canvas && needComposite) {
      // Cache the 2D context across frames. Re-fetch if the canvas element itself was ever replaced,
      // so the cache can't go stale.
      if (this.canvasCtx?.canvas !== canvas) this.canvasCtx = canvas.getContext('2d');
      const ctx = this.canvasCtx;
      if (ctx) {
        const cw = canvas.width;
        const ch = canvas.height;
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

    if (canvas && engineRunning) {
      // Pull brightness from the live channel each frame so slider drags affect output immediately
      // without committing React state (which would re-render the whole app).
      mapper.setBrightness(effBrightness);
      // The preview canvas dims through a CSS var that livePreview owns — and a render-free override
      // never goes through livePreview. Without this the LEDs would dim while the preview stayed
      // bright, so the preview would lie about what is actually leaving the machine.
      if (effBrightness !== this.lastPreviewBrightness) {
        this.lastPreviewBrightness = effBrightness;
        document.documentElement.style.setProperty('--preview-brightness', String(effBrightness));
      }
      // WebGPU samples each fixture strictly from its linked surface; the WebGL fallback samples the
      // composite preview canvas.
      if (mapper.perSurface && mapper.renderSurfaces) {
        mapper.renderSurfaces((id) => {
          const s = effSurfaces.find((x) => x.id === id);
          return s ? surfaceMedia.getDrawable(s) : null;
        }, (id) => effSurfaces.find((x) => x.id === id)?.content.opacity ?? 1);
      } else {
        mapper.updateSource(canvas);
      }
      const rawBytes = mapper.read();

      if (rawBytes) {
        this.packAndPublish(rawBytes, effFixtures);
      }
    }

    perfMonitor.endFrame();
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
    //   profile default < authored dmx < LIGHTING CLIP < automation lane < live override
    //
    // Automation has already been folded into `currentFixtures` by the caller (automationOverlay lays
    // it over the StateView), so a lane's value is sitting in `f.dmx` by now. Asking the overlay
    // whether it OWNS the path is therefore the whole rule: if a lane owns it, the authored value
    // already IS the lane's and the clip must not speak; if not, the clip's role value wins over what
    // the operator parked there by hand.
    const roleOverride: profilePack.RoleOverride | undefined = lightingOverlay.isActive()
      ? (fixtureId, channel) => {
          if (automationOverlay.owns(`fixtures.${fixtureId}.dmx.${channel.key}`)) return undefined;
          return lightingOverlay.get(fixtureId, channel.role);
        }
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
      if (f.profileId) {
        const profile = this.inputs.fixtureProfiles.get(f.profileId);
        const mode = profile ? profilePack.modeOf(profile, f.profileMode) : undefined;
        // An UNRESOLVED profile writes nothing at all. That matches fixtureFootprint() returning 0 for
        // the same case, so the patch and the wire still agree — a fixture we cannot describe occupies
        // no channels and disturbs no neighbour.
        if (profile && mode) {
          profilePack.packProfiled(f, profile, mode, writeCh, roleOverride);
          // Publish what this fixture is DOING, in roles and degrees, for the 3D scene and the beams.
          // Resolved here rather than in the scene so there is exactly one interpretation of
          // "intensity"/"pan" in the app — see fixtureSignal.
          fixtureStates.set(f.id, fixtureSignal.resolveFixture(f, profile, roleOverride));
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

export const frameEngine = new FrameEngine();
