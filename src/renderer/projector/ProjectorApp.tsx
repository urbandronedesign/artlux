import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Surface, SourceType } from '../types';
import { defaultCornerPin, defaultSoftEdge, type CornerPin, type BezierWarp, type SoftEdge } from '../../../shared/protocol';
import { syncSurfaces, getDrawable, resolveSource } from '../services/surfaceMedia';
import { timeline as engine } from '../services/timeline';
import { ProjectorGL } from './ProjectorGL';
import { squareToQuad, applyH } from './homography';
import { makeBezierWarp, tessellateBezier, evalBezier, hasResidualWarp, BEZIER_CORNERS } from './warp';
import type { MainToProjector, ProjectorToMain, ProjectorRender } from './bridge';
import { activateRendererPlugins } from '../host/plugins';
import { keymap } from '../shortcuts/keymapStore';
import { eventToChord } from '../shortcuts/chord';
import { projectorChannelRegistry, projectorPanelRegistry } from '../host/registries';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { reportFault } from '../services/faultReporter';
import type { ProjectorPanelContext } from '@artlux/sdk/renderer';

// IMAGE (one cheap decode) + EFFECT (procedural) render locally. Everything HW-decoded —
// camera/Spout/DMX-in/NDI AND file video / timeline layers — is decoded once in the main
// window and streamed here as ImageBitmaps, so the same media isn't decoded per window.
// Content-type-string membership sets (SurfaceContent.type is an open string space; SourceType values
// are strings, so a Set<string> both constructs from the enum and accepts any plugin type id at .has()).
const SELF_RENDER = new Set<string>([SourceType.IMAGE, 'EFFECT', SourceType.TRACKING]);
const STREAMED = new Set<string>([SourceType.CAMERA, SourceType.SPOUT, SourceType.DMX_IN, SourceType.NDI, SourceType.VIDEO, SourceType.LAYER, SourceType.PROGRAM]);
// Silence on the port for this long means the main window is no longer producing — see the liveness
// check in the render loop for why a frozen picture is worse than a black one. Generous next to the
// ~30 Hz frame rate and the transport/config traffic that punctuates an idle output, because a false
// positive blacks out a live show: this must only fire when the producer is genuinely gone.
const PRODUCER_TIMEOUT_MS = 5000;
// A SLICE shows another surface's picture, so it is classified by that surface's type, not its own —
// a slice of an EFFECT still renders here at display rate, a slice of a VIDEO is still streamed
// (already cropped to this output's region, so it is SMALLER than an unsliced push, not larger).
// These types own no media of their own, so registering them in a projector window costs nothing —
// which is what lets a slice resolve its source here without ever decoding it twice.
const OWNS_NO_MEDIA = (s: Surface): boolean =>
  s.content.type === SourceType.SLICE || s.content.type === SourceType.LAYER
  || s.content.type === SourceType.PROGRAM || s.content.type === SourceType.NONE;
const CORNER_KEYS: (keyof CornerPin)[] = ['tl', 'tr', 'br', 'bl'];
const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'];
const AA_SAMPLES = 4;
const RENDER_TESS = 24; // patch → render mesh subdivisions per axis
// Identity feather, hoisted so the calibrated-warp path does not allocate one per frame per window.
const NO_FEATHER = defaultSoftEdge();
const NDI_MAX_W = 1280, NDI_MAX_H = 720; // cap NDI capture for light readback + IPC
const NDI_BCAST_W = 1920, NDI_BCAST_H = 1080; // broadcast mode: send NDI at up to 1080p

// One fullscreen projector output for a Surface. Renders content through a corner-pin or a
// bicubic Bézier warp (tessellated to a mesh) with soft-edge + gamma, MSAA-resolved. Edit
// mode overlays draggable handles (4 corners, or the 16 Bézier control points) + a curved
// calibration grid.
export const ProjectorApp: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<ProjectorGL | null>(null);
  // A baked calibration map, held until the draw loop can upload it (see the 'bakedMap' handler).
  // `tried` separates "not uploaded yet" from "cannot be uploaded here", which are opposite answers to
  // the question applyCalibMode asks — the first must not yet supersede the venue render, the second
  // must never do so.
  const bakedRef = useRef<{ w: number; h: number; uv: Float32Array; uploaded: boolean; tried: boolean } | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const surfaceRef = useRef<Surface | null>(null);
  // Content type this window actually renders: the surface's own, or — when it is a SLICE — the type
  // of the surface it crops. Drives the self-render / streamed decision in the frame loop.
  const effTypeRef = useRef<string>(SourceType.NONE);
  // The surfaces this window's surface depends on (a slice's source). Kept so the sync set can be
  // DERIVED on every re-sync rather than replayed from a snapshot: a transport tick arrives ~30×/s
  // and re-syncs, and handing it a stale (or, after a hot reload, empty) snapshot would wipe the
  // surface lookup a slice resolves through — the window then goes black and never recovers,
  // because no new config is coming.
  const sourcesRef = useRef<Surface[]>([]);
  const frameRef = useRef<ImageBitmap | null>(null);
  // Ticks once per streamed frame received from main. Handed to ProjectorGL.draw so an unchanged
  // generation skips the texture upload — frames arrive at ~30 fps but we draw at display rate.
  const frameGenRef = useRef(0);
  // Producer liveness. `lastMsgRef` is stamped by EVERY inbound port message (the one choke point);
  // `producerLostRef` edge-triggers the blackout + its single report, so the rAF neither re-reports
  // at 60 Hz nor re-renders React on every frame of an outage. Seeded now, which gives the handshake
  // one full timeout's grace before this window can declare a producer it has never heard from dead.
  const lastMsgRef = useRef(performance.now());
  const producerLostRef = useRef(false);
  // Memoized Bézier render mesh: tessellateBezier is a pure function of (warp, RENDER_TESS) and the
  // warp only changes when a config arrives or a handle is dragged, but this ran EVERY frame in
  // EVERY output window. Keyed on the warp object identity (warpRef is reassigned, never mutated).
  const meshRef = useRef<{ src: BezierWarp | null; mesh: ReturnType<typeof tessellateBezier> | null }>({ src: null, mesh: null });
  const playingRef = useRef(true);

  const pinRef = useRef<CornerPin>(defaultCornerPin());
  const warpRef = useRef<BezierWarp | null>(null);
  const softRef = useRef<SoftEdge>(defaultSoftEdge());
  const gammaRef = useRef(1);
  const brightnessRef = useRef(1);
  const colorGainRef = useRef<[number, number, number]>([1, 1, 1]);
  const blackLiftRef = useRef<[number, number, number]>([0, 0, 0]);
  const fpsCapRef = useRef(0);
  const ndiSendRef = useRef(false);
  const ndiFullResRef = useRef(false);
  const lastNdiRef = useRef(0);
  const draggingRef = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  // A full-window projector panel (calibration's render-from-projector) can offer ITS canvas as this
  // window's picture — see the panel context's setRenderSource and the calib branch of the frame loop.
  // `consumingPanelRef` tracks whether we are currently warping it, so the visibility write below
  // happens on the transition rather than once per frame.
  const panelSourceRef = useRef<HTMLCanvasElement | null>(null);
  const consumingPanelRef = useRef(false);

  // Calibration's projector-window rendering (structured-light pattern / pose crosshair / render-from-
  // projector) is a plugin projector-panel contribution now — see the panel-context + mount below.

  const [pin, setPinState] = useState<CornerPin>(defaultCornerPin());
  const [warp, setWarpState] = useState<BezierWarp | null>(null);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(0);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState('');
  // The main window's cold-start hold, mirrored here (see bridge.ts 'boot'). The REF is what the frame
  // loop reads — it must not wait for a React commit to stop drawing — and the state drives the sign.
  const bootingRef = useRef(false);
  const [boot, setBoot] = useState<{ booting: boolean; ready: number; total: number }>({ booting: false, ready: 0, total: 0 });

  // Re-register this window's surfaces with surfaceMedia. Media is only ACQUIRED for content this
  // window renders itself; a slice and its source own no media, so they are always safe to register
  // (that registration is what lets getDrawable resolve the crop here). Derived, never snapshotted.
  const resync = (playing: boolean) => {
    const s = surfaceRef.current;
    if (!s) return;
    const all = [s, ...sourcesRef.current];
    const self = SELF_RENDER.has(effTypeRef.current);
    syncSurfaces(self ? all : all.filter(OWNS_NO_MEDIA), playing);
  };

  const setPin = (n: CornerPin) => { pinRef.current = n; setPinState(n); };
  const setWarp = (n: BezierWarp | null) => { warpRef.current = n; setWarpState(n); };
  const send = (m: ProjectorToMain) => portRef.current?.postMessage(m);
  // Projector-panel plugins (e.g. calibration's pattern/crosshair/render overlay) subscribe to the
  // main→projector message stream and send acks back through this stable context.
  const panelMsgSubs = useRef(new Set<(m: unknown) => void>());
  // State, not a ref: a panel has to RE-RENDER to change its own loop. It moves on project load, not
  // per frame, so rebuilding the context that rarely costs nothing — the message subscriptions it
  // carries live in a ref and survive the new identity.
  const [panelFpsCap, setPanelFpsCap] = useState(0);
  const panelCtx = useMemo<ProjectorPanelContext>(() => ({
    fpsCap: panelFpsCap,
    onMessage: (cb) => { panelMsgSubs.current.add(cb); return () => { panelMsgSubs.current.delete(cb); }; },
    send: (m) => portRef.current?.postMessage(m as ProjectorToMain),
    setRenderSource: (c) => {
      const prev = panelSourceRef.current;
      if (prev === c) return;
      // Hand the outgoing canvas its visibility back. Without this, a panel that unmounts while we
      // were warping it leaves an invisible element behind, and its NEXT mount reuses the node —
      // the projector then shows black with nothing in the logs to say why.
      if (prev) prev.style.visibility = '';
      panelSourceRef.current = c;
      consumingPanelRef.current = false; // re-decided on the next frame against the new canvas
    },
  }), [panelFpsCap]);
  const commit = () => { if (warpRef.current) send({ t: 'warp', warp: warpRef.current }); else send({ t: 'cornerPin', cornerPin: pinRef.current }); };
  const commitDebounced = () => {
    if (commitTimer.current) window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(commit, 250);
  };

  const applyRender = (r: ProjectorRender) => {
    if (!draggingRef.current) {
      setPin(r.cornerPin ?? defaultCornerPin());
      setWarp(r.warp ?? null);
    }
    softRef.current = r.softEdge ?? defaultSoftEdge();
    gammaRef.current = r.gamma ?? 1;
    brightnessRef.current = r.brightness ?? 1;
    colorGainRef.current = r.colorGain ?? [1, 1, 1];
    blackLiftRef.current = r.blackLift ?? [0, 0, 0];
    fpsCapRef.current = r.fpsCap ?? 0;
    // A panel that draws the whole picture runs its own loop, so it cannot be throttled from here —
    // it has to be told. Without this, "performance mode" capped the warp/blend stage and left the
    // calibrated 3D scene above it running at display rate, which is the expensive half.
    setPanelFpsCap(r.fpsCap ?? 0);
    // Hand the render config to any projector channel that applies to this surface (e.g. LiDAR reads
    // trackingSmoothing/PredictMs). The host no longer knows which fields are plugin-specific.
    const cs = surfaceRef.current;
    if (cs) for (const ch of projectorChannelRegistry.all()) if (ch.appliesTo?.(cs)) ch.onConfig?.(cs, r);
    ndiSendRef.current = !!r.ndiSend;
    ndiFullResRef.current = !!r.ndiFullRes;
  };

  // External mirror, but decode HAP layers locally: this window is visible/full-speed, so it
  // plays HAP smoothly even when the hidden broadcast main window throttles its frame pump.
  useEffect(() => { engine.setExternal(true); engine.setHapLocal(true); }, []);

  // This is a SEPARATE renderer window (projector.html) with its own module instances, so it must adopt
  // the user's shortcut overrides itself — the main editor's keymap.hydrate() doesn't reach here. Absent
  // overrides fall through to the registry defaults, so warp keys work before prefs even resolve.
  useEffect(() => { window.artlux?.getPrefs?.().then((p) => keymap.hydrate(p?.shortcuts)).catch(() => {}); }, []);

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Activate first-party plugins in this projector window so projector-channel `apply()` (e.g. the
  // LiDAR tracking snapshot → its store) runs here before any pluginData messages arrive.
  useEffect(() => { activateRendererPlugins('projector'); }, []);

  // The mirror's local decode set has two independent contributors: the surface config (this
  // window's own layer / tracking background) and — while render-from-projector is on — the layers
  // bound to the 3D scene's venue meshes, so a locally-decodable codec clip on a mesh runs at
  // display rate instead of the ~30 fps streamed fallback. Merged here because whichever message
  // arrives last must not clobber the other's contribution.
  const configLocalRef = useRef<string[]>([]);
  const sceneLayersRef = useRef<string[]>([]);
  const calibRenderRef = useRef(false);
  // The calib mode as REQUESTED by main, before the baked-map override in applyCalibMode(). Kept
  // because the override can flip long after the mode arrived — a venue file is imported while an
  // output is already rendering — and the panels then have to be told the effective mode again.
  const lastCalibRef = useRef<Extract<MainToProjector, { t: 'calib' }> | null>(null);
  const applyLocalLayers = () => {
    engine.setLocalLayers([...new Set([...configLocalRef.current, ...(calibRenderRef.current ? sceneLayersRef.current : [])])]);
  };

  // ── A BAKED MAP SUPERSEDES RENDER-FROM-PROJECTOR ────────────────────────────────────────────────
  //
  // Both describe the same thing — where this projector's content lands on the venue — and a baked map
  // is that answer already computed: the unwrap, the occlusion and the footprint edge are in its
  // pixels. Running both would be a second, redundant scene render whose output is thrown away.
  //
  // It has to be decided HERE, in the window, and it has to reach the PANELS, because render mode is
  // two cooperating pieces: this window's frame loop skips its own draw (see the calibRenderRef branch
  // below), and the calibration panel mounts an opaque full-window 3D scene ON TOP. Suppressing only
  // the first leaves the map drawing underneath a scene that covers it — which is exactly the bug this
  // fixes, and why the map appeared to work: both paths draw the same silhouette, so the wrong one
  // looked right.
  //
  // Main is NOT the place for this decision. It drives render mode from `useCalibration + poseRms`
  // (App's pushProjectorState), and whether a baked map exists is the calibration PLUGIN's state —
  // core asking a plugin what to render would put the plugin boundary the wrong way round. The window
  // already receives both facts, so it is the one place that needs no new channel.
  //
  // Only 'render' is superseded. 'pattern' and 'crosshair' are authoring modes — an operator running a
  // wizard is re-solving, and must see the projector itself, not a map. ⚠ The corollary: a wizard's
  // Verify step on an output that already HAS an imported map shows the map, not the live solve.
  // Withdraw the import before re-calibrating that output.
  const applyCalibMode = (): void => {
    const req = lastCalibRef.current;
    if (!req) return;
    const eff = req.mode === 'render' && bakedRef.current?.uploaded ? { ...req, mode: 'idle' as const } : req;
    calibRenderRef.current = eff.mode === 'render';
    applyLocalLayers();
    panelMsgSubs.current.forEach((cb) => cb(eff));
  };

  // --- MessagePort handshake ---
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.kind !== 'artlux:projector-port' || !e.ports[0]) return;
      const port = e.ports[0];
      portRef.current = port;
      port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as MainToProjector;
        // The single choke point for everything the main window says to this output — so it is also
        // the only honest liveness signal we have about the producer. See PRODUCER_TIMEOUT_MS.
        lastMsgRef.current = performance.now();
        if (m.t === 'config') {
          surfaceRef.current = m.surface;
          playingRef.current = m.playing;
          setName(m.surface.name);
          setConnected(true);
          applyRender(m.render);
          // A slice borrows its source's picture, so it is classified by the SOURCE's type — that is
          // what decides whether this window renders locally or waits for pushed frames.
          sourcesRef.current = m.sources ?? [];
          const eff = resolveSource(m.surface, [m.surface, ...sourcesRef.current]) ?? m.surface;
          effTypeRef.current = eff.content.type;
          resync(m.playing);
          // DECODE ONLY WHAT THIS WINDOW DRAWS. A projector renders exactly one surface, but the
          // engine's mirror loop walked every layer in the document — so each output ran its own
          // decode ring over the whole show, and a window showing an IMAGE still decoded the
          // timeline's HAP video. At most two layers matter here: the one this surface (or the
          // surface a SLICE crops) is bound to, and a TRACKING surface's background layer — that one
          // stays in the set deliberately, because this window decodes it at display rate whereas the
          // streamed `layerFrame` fallback arrives at ~30 fps.
          const local: string[] = [];
          if (eff.content.type === SourceType.LAYER && eff.content.layerId) local.push(eff.content.layerId);
          if (eff.content.type === SourceType.TRACKING && eff.content.bgLayerId) local.push(eff.content.bgLayerId);
          configLocalRef.current = local;
          applyLocalLayers();
          if (!STREAMED.has(eff.content.type)) { frameRef.current?.close(); frameRef.current = null; }
        } else if (m.t === 'frame') {
          frameRef.current?.close();
          frameRef.current = m.bitmap;
          frameGenRef.current++;
        } else if (m.t === 'frameIdle') {
          // The source has nothing to show — drop the held frame so we render black instead of
          // freezing on the last one. Bump the generation so the next real frame always uploads.
          frameRef.current?.close();
          frameRef.current = null;
          frameGenRef.current++;
        } else if (m.t === 'layerFrame') {
          engine.setLayerBitmap(m.layerId, m.bitmap); // TRACKING background / render-mode mesh layer
        } else if (m.t === 'layerFrameIdle') {
          engine.clearLayerBitmap(m.layerId); // main stopped sending — don't hold the last frame
        } else if (m.t === 'scene') {
          // Venue-mesh layer bindings, for the render-mode local decode set (the panel plugins get
          // the same message via the fan-out below — this is the window's own bookkeeping).
          sceneLayersRef.current = (m.scene3D.models ?? [])
            // Planes included: a screen bound to a locally-decodable codec clip (HAP/MP4) should
            // decode in this window at display rate like any mesh, not ride the ~30 fps stream.
            .filter((x) => x.visible && x.layerId)
            .map((x) => x.layerId!);
          applyLocalLayers();
        } else if (m.t === 'bakedMap') {
          // Held as DATA, not uploaded here: this handler can run before the canvas has a GL context
          // (the port is bridged on did-finish-load, the renderer builds the context in an effect),
          // and a map dropped on the floor would leave the output on the mesh warp with nothing
          // saying why. The draw loop uploads it on the next frame it can.
          bakedRef.current = m.map ? { ...m.map, uploaded: false, tried: false } : null;
          if (!m.map) glRef.current?.clearBakedMap();
          // Arriving or being withdrawn CHANGES THE MODE — see applyCalibMode.
          applyCalibMode();
        } else if (m.t === 'calib') {
          lastCalibRef.current = m;
          applyCalibMode();
          // applyCalibMode fans the EFFECTIVE message to the panels itself, so this must not also
          // fall through to the raw fan-out at the bottom — a panel that saw both would mount the
          // venue scene from the raw 'render' and never hear that it lost.
          return;
        } else if (m.t === 'timeline') {
          engine.setData(m.timeline);
        } else if (m.t === 'transport') {
          playingRef.current = m.playing;
          engine.setPlaying(m.playing); engine.seek(m.playhead);
          // A mirror is TOLD the show clock, never derives it — an effect SURFACE is drawn against it.
          engine.setExternalShowTime(m.showTime);
          resync(m.playing);
        } else if (m.t === 'boot') {
          bootingRef.current = m.booting;
          setBoot({ booting: m.booting, ready: m.ready, total: m.total });
        } else if (m.t === 'brightness') {
          brightnessRef.current = m.value;
        } else if (m.t === 'pluginData') {
          projectorChannelRegistry.get(m.channel)?.apply?.(m.payload); // e.g. LiDAR tracking snapshot → its store
        } else if (m.t === 'edit') {
          setEditing(m.on);
          if (m.on) window.focus();
        }
        // Fan out to projector-panel plugins (calibration's calib / calibPattern / scene overlay).
        panelMsgSubs.current.forEach((cb) => cb(m));
      };
      port.start();
      (port.postMessage as (m: ProjectorToMain) => void)({ t: 'ready' });
      lastMsgRef.current = performance.now(); // the producer is alive as of the handshake
    };
    window.addEventListener('message', onMsg);
    window.postMessage('artlux:projector-ready', '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // --- render loop (refs only; fps-capped for performance mode) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: ProjectorGL;
    try { gl = new ProjectorGL(canvas); } catch (err) { console.error(err); return; }
    glRef.current = gl;
    // Publish this output as NDI (~30 fps, capped resolution) when enabled. Extracted from the tail of
    // the loop because the calibrated-warp branch returns early and must still send — a calibrated
    // output's NDI feed was black for exactly that reason.
    const captureNdi = (now: number) => {
      if (!ndiSendRef.current || now - lastNdiRef.current < 33) return;
      lastNdiRef.current = now;
      const id = surfaceRef.current?.id;
      if (!id) return;
      const mw = ndiFullResRef.current ? NDI_BCAST_W : NDI_MAX_W;
      const mh = ndiFullResRef.current ? NDI_BCAST_H : NDI_MAX_H;
      const shot = gl.captureRGBA(mw, mh);
      if (shot) window.artlux?.pluginSend?.('ndi:send-frame', id, shot.width, shot.height, shot.data.buffer as ArrayBuffer);
    };
    let raf = 0; let lastDraw = -1e9;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const cap = fpsCapRef.current;
      if (cap > 0 && now - lastDraw < 1000 / cap - 0.5) return;
      lastDraw = now;
      gl.setSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
      const s = surfaceRef.current;
      const warp = warpRef.current;
      if (meshRef.current.src !== warp) meshRef.current = { src: warp, mesh: warp ? tessellateBezier(warp, RENDER_TESS) : null };
      const mesh = meshRef.current.mesh;
      const opts = { cornerPin: pinRef.current, warp: mesh, softEdge: softRef.current, gamma: gammaRef.current, brightness: brightnessRef.current, colorGain: colorGainRef.current, blackLift: blackLiftRef.current, aa: AA_SAMPLES };
      // ── THE COLD-START HOLD ─────────────────────────────────────────────────────────────────────
      // The main window is still decoding a freshly-opened project, so THIS OUTPUT SHOWS NOTHING —
      // black under the "PRELOADING SHOW" sign below. Half a look is worse than none: the warm pool has
      // parked layer 1 on its first frame while layers 2-4 are still empty, and a venue reading that as
      // "the show is broken" is exactly the call an operator should not have to make. Held at the DRAW,
      // not at the source, so everything else (transport, config, warp geometry, calibration overlays)
      // keeps flowing and the moment the gate arms the real picture is already there.
      //
      // ⚠ The sign is DOM, so an NDI send of this output carries the BLACK, not the words. That is the
      // right way round — an NDI consumer is another machine's input, not a person to be told things.
      if (bootingRef.current) { gl.draw(null, opts); return; }
      // ── UPLOAD THE BAKED MAP, ONCE, BEFORE THE BRANCH IT DECIDES ────────────────────────────────
      // Done here rather than in the message handler because the GL context only exists inside this
      // loop's closure, and a map can arrive before the canvas has one. Done BEFORE the
      // render-from-projector branch below because whether the map is USABLE is what releases that
      // branch — deciding on the map's presence instead would suppress the venue render on a machine
      // that then cannot draw the map, leaving a flat warp and no calibration at all.
      //
      // One attempt, not per frame: both failure modes are permanent (see ProjectorGL.canDrawBaked)
      // and the upload repacks ~10 MB into RGBA32F, which is not something to retry at 60 Hz.
      {
        const b = bakedRef.current;
        if (b && !b.tried) {
          b.tried = true;
          b.uploaded = gl.setBakedMap(b.w, b.h, b.uv) && gl.canDrawBaked();
          // Say which path is live, once. Two paths that draw the SAME silhouette is what made the
          // shadowed map look like it worked, and an operator at a venue has even less to go on than
          // a screenshot — so the window states it rather than leaving it to be inferred.
          if (b.uploaded) console.log(`[projector] baked calibration map ACTIVE — ${b.w}×${b.h}, render-from-projector superseded`);
          else console.warn('[projector] baked map unusable in this context — keeping the mesh path');
          applyCalibMode(); // usability is only knowable now, and it may release the venue render
        }
      }
      // ── NOTHING UNDER AN OPAQUE OVERLAY — UNLESS THERE IS A RESIDUAL WARP ───────────────────────
      // Render-from-projector mounts the calibrated 3D scene as an OPAQUE full-window layer above
      // this canvas, so every pixel drawn here is thrown away — while still costing a full-resolution
      // upload of the streamed frame plus the warp/blend pass, per frame, on the machine that can
      // least afford it. Skipped rather than paused: the loop keeps running, so the moment the mode
      // ends (or the overlay fails and unmounts) the very next frame paints normally.
      //
      // EXCEPT: neither manual nor auto calibration lands perfect in a real venue, so an operator has
      // to be able to nudge the result to finalise the mapping — and the warp stage lives HERE, not in
      // the panel. When a residual warp exists, the panel's canvas stops being an overlay and becomes
      // this stage's SOURCE, so the ordinary corner-pin / Bézier handles (and gamma, brightness, colour
      // gain) apply to the calibrated render exactly as they do to a flat output. One warp
      // representation, one handle editor, both paths.
      //
      // The identity case keeps the original early-return: no upload, no pass, nothing read — so an
      // output nobody has nudged is pixel-identical and cost-identical to before this existed. That is
      // the whole safety property; see hasResidualWarp for why it is not just `warp == null`.
      if (calibRenderRef.current) {
        const src = panelSourceRef.current;
        const consume = !!src && hasResidualWarp(pinRef.current, warpRef.current);
        if (consume !== consumingPanelRef.current) {
          consumingPanelRef.current = consume;
          // Transition only, and `visibility` rather than `display`: a display:none canvas has no
          // layout box, so its drawing buffer collapses and we would sample a blank texture the frame
          // after we started warping. Hidden keeps it laid out and still rendering — it is the source
          // now, not the picture.
          if (src) src.style.visibility = consume ? 'hidden' : '';
        }
        if (!consume || !src) return;
        // ⚠ GEOMETRY ONLY — every photometric stage stays identity here, and NOT passing `opts`
        // wholesale is the point.
        //
        // The panel's composer has ALREADY applied the soft edge, the solved rig blend, the colour
        // gain and the black lift to these pixels (see ProjectorScene's BlendEffect / BlendLook).
        // Re-applying them here would square the blend alpha — a dark band at every projector overlap
        // that reads exactly like a mis-set blend gamma, which is the hardest thing to diagnose on a
        // wall at 2am. This is the same double-apply hazard `hwOwnsGeometry` guards on the NVAPI side.
        //
        // Gamma and brightness are identity for a different reason: they do not apply on this path
        // TODAY (the whole stage was skipped), so honouring them only for warped outputs would make
        // the master brightness work on some calibrated projectors and not others. Whether they
        // should apply to a calibrated render at all is a separate question from bending it.
        //
        // aa:1 — the panel's canvas is already antialiased (its 3D geometry edges are the ones that
        // matter); this stage's MSAA would only smooth the warp mesh's outer boundary, which the soft
        // edge and blend already feather. At 1080p that is 2.1 M samples instead of 8.3 M per frame.
        //
        // No `srcGen`: a live canvas mutates in place, so it must re-upload every frame — the same
        // rule as a locally-decoded drawable below.
        gl.draw(src, { cornerPin: pinRef.current, warp: mesh, softEdge: NO_FEATHER, aa: 1 });
        // An NDI send of a calibrated output used to be BLACK, because the capture below sat after the
        // early return. Warping restores it.
        captureNdi(now);
        return;
      }
      // ── PRODUCER LIVENESS — do not let a dead show LOOK healthy ─────────────────────────────────
      // This window has its own root and its own rAF, so it survives the main window's tree dying. It
      // used to survive it by lying: `frameRef` holds the last ImageBitmap and is only replaced by a
      // newer one, so a STREAMED surface froze on its final frame indefinitely, while a SELF_RENDER
      // surface (IMAGE/EFFECT/TRACKING) went right on animating off this window's own clock and
      // looked completely fine. The room saw a plausible picture with no show behind it — and on the
      // wire the native pacer's keep-alive held the rig at its last look, so that lied too.
      //
      // Nothing punctuates the port at a guaranteed rate except frames (~30 Hz) and transport/config
      // messages, so silence past PRODUCER_TIMEOUT_MS means the producer is gone. Drop the held frame
      // (black, not frozen) and re-show the existing "Waiting for the main window…" caption. A black
      // projector with a legible caption is the truth. Reported once per outage, as an 'aux' fault:
      // audited, never a relaunch — the main window's own detectors own that decision, and two
      // windows racing to relaunch the show is a bug.
      if (now - lastMsgRef.current > PRODUCER_TIMEOUT_MS) {
        if (!producerLostRef.current) {
          producerLostRef.current = true;
          setConnected(false);
          if (frameRef.current) { frameRef.current.close(); frameRef.current = null; frameGenRef.current++; }
          reportFault({ window: 'projector', scope: 'producer-lost',
            message: `no message from the main window for ${Math.round((now - lastMsgRef.current) / 1000)}s (output "${surfaceRef.current?.name ?? '?'}")` });
        }
        gl.draw(null, opts);
        return;
      }
      if (producerLostRef.current) { producerLostRef.current = false; setConnected(true); }
      // A projector channel may GPU-render this surface's content itself (e.g. LiDAR tracking): the
      // plugin composites a source texture, we warp it — no CPU canvas, no host knowledge of content.
      const rch = s ? projectorChannelRegistry.all().find((c) => c.renderSource && c.appliesTo?.(s)) : undefined;
      const srcSize = rch && s ? rch.projectorSourceSize?.(s) : null;
      if (rch && s && srcSize) {
        gl.drawComposited(srcSize.w, srcSize.h,
          (rgl) => rch.renderSource!(rgl, s, { timeMs: now, getLayerDrawable: (id) => engine.getLayerDrawable(id) }),
          opts);
      } else {
        // For HAP LAYER content getDrawable returns this window's locally-decoded canvas; for
        // other streamed sources it's null, so we fall back to the frame pushed from main.
        let src: CanvasImageSource | ImageBitmap | null = null;
        let srcGen: number | undefined;
        if (s) {
          // Classified by the EFFECTIVE type (a slice's source), but drawn from the surface itself —
          // getDrawable resolves the crop, so a slice hands back only its own region.
          if (SELF_RENDER.has(effTypeRef.current)) src = getDrawable(s);
          else if (STREAMED.has(effTypeRef.current)) {
            src = getDrawable(s);
            // Only the pushed ImageBitmap carries a generation. A locally-decoded drawable is a
            // live canvas that mutates in place, so it must be re-uploaded unconditionally.
            if (!src) { src = frameRef.current; srcGen = frameGenRef.current; }
          }
        }
        // ── THE BAKED PATH, PREFERRED WHEN A CALIBRATION FILE IS LOADED ────────────────────────
        // A baked map already encodes everything the mesh warp plus a render-from-projector scene
        // would have computed: the unwrap, the occlusion, the footprint edge. So it REPLACES the warp
        // rather than composing with it — running both would bend an already-bent picture.
        //
        // Uploaded here rather than in the message handler because the GL context only exists inside
        // this loop's closure, and the map can arrive before the canvas has one.
        // Uploaded above, before the render-from-projector branch — see the note there for why the
        // order matters. Still falls through to the mesh path if drawBaked declines, so a machine that
        // cannot take this path keeps exactly the output it had before.
        if (!(bakedRef.current?.uploaded && gl.drawBaked(src as TexImageSource | null, opts, srcGen))) {
          gl.draw(src as TexImageSource | null, opts, srcGen);
        }
      }
      captureNdi(now);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); gl.dispose(); glRef.current = null; frameRef.current?.close(); frameRef.current = null; };
  }, []);

  // Editable handles: the 16 Bézier control points, or the 4 corner-pin points.
  const handlePoints: [number, number][] = warp ? warp.points : [pin.tl, pin.tr, pin.br, pin.bl];
  const setHandle = (i: number, p: [number, number]) => {
    if (warpRef.current) {
      const pts = warpRef.current.points.slice(); pts[i] = p;
      setWarp({ points: pts });
    } else {
      setPin({ ...pinRef.current, [CORNER_KEYS[i]]: p });
    }
  };

  // --- dragging ---
  useEffect(() => {
    if (!editing) return;
    const norm = (e: PointerEvent): [number, number] => [
      Math.min(1, Math.max(0, e.clientX / window.innerWidth)),
      Math.min(1, Math.max(0, e.clientY / window.innerHeight)),
    ];
    const onMove = (e: PointerEvent) => { if (draggingRef.current != null) setHandle(draggingRef.current, norm(e)); };
    const onUp = () => { if (draggingRef.current != null) { draggingRef.current = null; commit(); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, warp]);

  // --- keyboard: nudge / reset / dismiss ---
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc-to-dismiss stays hardcoded (universal cancel). Reset + the four nudges resolve through the
      // keymap (defaults R / arrows) — see shortcuts/registry.ts `projector.*`.
      if (e.key === 'Escape') { setEditing(false); send({ t: 'editOff' }); return; }
      if (keymap.matches(e, 'projector.warpReset')) {
        if (warpRef.current) setWarp(makeBezierWarp(pinRef.current));
        else setPin(defaultCornerPin());
        commit(); return;
      }
      // Shift is an ORTHOGONAL modifier here (×10 step, read below), not part of the binding — so match
      // each direction against its binding with any leading Shift stripped (mirrors the timeline delete).
      const bare = eventToChord(e).replace(/^Shift\+/, '');
      const hit = (id: string) => keymap.resolve(id).includes(bare);
      const dxy: [number, number] | undefined =
        hit('projector.warpNudgeLeft')  ? [-1, 0] :
        hit('projector.warpNudgeRight') ? [1, 0]  :
        hit('projector.warpNudgeUp')    ? [0, -1] :
        hit('projector.warpNudgeDown')  ? [0, 1]  : undefined;
      if (!dxy) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const pts = warpRef.current ? warpRef.current.points : [pinRef.current.tl, pinRef.current.tr, pinRef.current.br, pinRef.current.bl];
      const idx = Math.min(selected, pts.length - 1);
      const [cx, cy] = pts[idx];
      setHandle(idx, [
        Math.min(1, Math.max(0, cx + (dxy[0] * step) / window.innerWidth)),
        Math.min(1, Math.max(0, cy + (dxy[1] * step) / window.innerHeight)),
      ]);
      commitDebounced();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, selected, warp]);

  // Calibration overlay: curved iso-lines for the Bézier patch, or the homography grid.
  const px = (p: [number, number]) => `${(p[0] * size.w).toFixed(1)},${(p[1] * size.h).toFixed(1)}`;
  const curveLines = (): string[] => {
    const lines: string[] = [];
    if (warp) {
      const LINES = 4, STEPS = 24;
      for (let a = 0; a <= LINES; a++) {
        const v = a / LINES, u = a / LINES;
        lines.push(Array.from({ length: STEPS + 1 }, (_, k) => px(evalBezier(warp, k / STEPS, v))).join(' '));
        lines.push(Array.from({ length: STEPS + 1 }, (_, k) => px(evalBezier(warp, u, k / STEPS))).join(' '));
      }
    } else {
      const m = squareToQuad(pin), N = 4;
      const seg = (uF: number | null, vF: number | null) => Array.from({ length: N + 1 }, (_, i) => { const t = i / N; return px(applyH(m, uF ?? t, vF ?? t)); }).join(' ');
      for (let i = 0; i <= N; i++) { lines.push(seg(i / N, null)); lines.push(seg(null, i / N)); }
    }
    return lines;
  };
  // Faint Bézier control net (rows + columns of the 4×4 net).
  const netLines = (): string[] => {
    if (!warp) return [];
    const out: string[] = [];
    for (let j = 0; j < 4; j++) out.push([0, 1, 2, 3].map(i => px(warp.points[j * 4 + i])).join(' '));
    for (let i = 0; i < 4; i++) out.push([0, 1, 2, 3].map(j => px(warp.points[j * 4 + i])).join(' '));
    return out;
  };

  const sel = Math.min(selected, handlePoints.length - 1);
  const cornerOf = (i: number) => warp ? BEZIER_CORNERS.indexOf(i) : i; // -1 if interior/edge control point

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#000', overflow: 'hidden', cursor: editing ? 'default' : 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />

      {/* Projector-panel plugins: full-window overlays on top of the base canvas (e.g. calibration's
          structured-light pattern / pose crosshair / render-from-projector). They own their own modes
          via the message stream — inert until their plugin gets a relevant message. */}
      {/* Contained, and `silent`: THE CANVAS ABOVE MUST SURVIVE. A throw in one of these unmounted
          ProjectorApp and took the <canvas> out of the DOM with it — the only path this app had to a
          genuinely black projector, from a plugin overlay that is inert most of the time. */}
      {projectorPanelRegistry.all().map((p) => (
        <ErrorBoundary key={p.id} scope={`plugin:${p.id}`} pluginId={p.id} faultWindow="projector" silent>
          <p.Component ctx={panelCtx} size={size} />
        </ErrorBoundary>
      ))}

      {!connected && <div style={overlayCenter}>Waiting for the main window… {name}</div>}

      {/* PRELOADING SHOW — the cold-start hold, said on the output itself. Read from the floor of a
          venue, not from the operator's screen: big, dim (this is a projector pointed at a wall, and a
          white flash between shows is worse than the wait), and it names the output so a wall of six
          projectors tells you WHICH one you are looking at. It disappears by itself. */}
      {boot.booting && (
        <div style={overlayCenter}>
          <div style={{ textAlign: 'center', color: '#8a8f98' }}>
            <div style={{ font: '600 clamp(18px, 3.2vw, 54px) system-ui', letterSpacing: '0.14em' }}>PRELOADING SHOW</div>
            <div style={{ marginTop: '1.2em', font: '400 clamp(11px, 1.1vw, 18px) system-ui', color: '#5a5f68' }}>
              {name}{boot.total > 0 ? ` · ${boot.ready}/${boot.total}` : ''}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <>
          <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            {netLines().map((pts, i) => (
              <polyline key={`n${i}`} points={pts} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={1} strokeDasharray="4 4" />
            ))}
            {curveLines().map((pts, i) => (
              <polyline key={`c${i}`} points={pts} fill="none" stroke="rgba(0,255,170,0.55)" strokeWidth={1} />
            ))}
          </svg>
          {handlePoints.map(([nx, ny], i) => {
            const active = sel === i;
            const ci = cornerOf(i);
            const r = ci >= 0 ? 14 : 8;
            return (
              <div
                key={i}
                onPointerDown={(e) => { e.preventDefault(); setSelected(i); draggingRef.current = i; }}
                style={{
                  position: 'absolute', left: nx * size.w - r, top: ny * size.h - r, width: r * 2, height: r * 2,
                  borderRadius: '50%', border: `2px solid ${active ? '#00ffaa' : ci >= 0 ? '#ffffff' : 'rgba(255,255,255,0.7)'}`,
                  background: active ? 'rgba(0,255,170,0.25)' : 'rgba(255,255,255,0.12)',
                  cursor: 'grab', touchAction: 'none', boxSizing: 'border-box',
                }}
              >
                {ci >= 0 && (
                  <span style={{ position: 'absolute', left: r * 2 + 2, top: 2, font: '11px system-ui', color: active ? '#00ffaa' : '#fff', textShadow: '0 1px 2px #000', whiteSpace: 'nowrap' }}>
                    {CORNER_LABELS[ci]}
                  </span>
                )}
              </div>
            );
          })}
          <div style={hintBox}>
            {warp ? 'Drag Bézier points (corners + curve handles)' : 'Drag corners'} · arrows nudge (Shift ×10) · <b>R</b> reset · <b>Esc</b> done
          </div>
        </>
      )}
    </div>
  );
};

const overlayCenter: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: '#666', font: '12px system-ui', pointerEvents: 'none',
};
const hintBox: React.CSSProperties = {
  position: 'absolute', left: '50%', bottom: 24, transform: 'translateX(-50%)',
  padding: '6px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.7)', color: '#ddd',
  font: '12px system-ui', whiteSpace: 'nowrap', pointerEvents: 'none',
};
