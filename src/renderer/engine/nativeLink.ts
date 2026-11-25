import type { Fixture, FixtureProfile, Surface, Controller, OutputProtocol, SurfaceContent } from '../types';
import { WINDOWED_DISPLAY, defaultCornerPin, defaultSoftEdge, type ProjectorOutput, type Scene3D } from '../../../shared/protocol';
import { needsBlendPass, hasDistortion, distortionValues, blendValues } from '@artlux/plugin-calibration/playback';
import { hasResidualWarp } from '../projector/warp';
import * as venueLink from './venueLink';
import { badgeBitmap } from '../components/brand/badge';
import { ndiCap } from '../projector/ndiCap';
// The app's own broadcast flag (App.tsx BROADCAST): a broadcast machine sends NDI at up to 1080p.
const BROADCAST = typeof location !== 'undefined' && new URLSearchParams(location.search).get('broadcast') === '1';
import * as surfaceMedia from '../services/surfaceMedia';
import { isLight } from '../services/fixtureKind';
import * as contentSource from '../services/contentSource';
import { timeline } from '../services/timeline';
import * as automationOverlay from '../services/automationOverlay';
import * as lightingPlayback from '../services/lightingPlayback';
import * as colorPlayback from '../services/colorPlayback';
import * as lightingOverlay from '../services/lightingOverlay';
import * as colorOverlay from '../services/colorOverlay';
import * as lightingCue from '../services/lightingCue';

/**
 * E3e — THE LIGHT SHOW AS THE ENGINE EVALUATES IT (engine light.rs): the active timeline's lighting clips with
 * the takes and sequences they name, the named poses, the groups (their fixtures in the group's order), the rig's
 * fixture ids, the colour lanes and the palette — exactly what lightingPlayback and colorPlayback read.
 */
function lightingDoc(): unknown {
  const L = lightingPlayback.nativeState(), C = colorPlayback.nativeState();
  const clips = (L.data?.clips ?? []).filter((c) => c.kind === 'lighting' && c.lighting);
  const takeIds = new Set(clips.map((c) => c.lighting!.takeId).filter(Boolean));
  const seqIds = new Set(clips.map((c) => c.lighting!.sequenceId).filter(Boolean));
  const groupsOf = (gs: { id: string; fixtureIds: string[] }[]) => Object.fromEntries(gs.map((g) => [g.id, g.fixtureIds]));
  return {
    on: L.started && C.started,
    clips: clips.map((c) => ({ id: c.id, start: c.start, duration: c.duration, inPoint: c.inPoint, lighting: c.lighting })),
    takes: (L.data?.lightingTakes ?? []).filter((t) => takeIds.has(t.id)),
    sequences: (L.data?.lightingSequences ?? []).filter((s) => seqIds.has(s.id)),
    poses: L.poses, groups: groupsOf(L.groups), fixtures: L.fixtures.map((f) => f.id),
    colorLanes: C.data?.colorLanes ?? [], colorGroups: groupsOf(C.groups), colorFixtures: C.fixtures.map((f) => f.id), palette: C.palette,
  };
}
function lightingRefs(): unknown[] {
  const L = lightingPlayback.nativeState(), C = colorPlayback.nativeState();
  return [L.data, L.fixtures, L.groups, L.poses, L.started, C.data, C.fixtures, C.groups, C.palette, C.started];
}

// E1f — THE NATIVE ENGINE'S LIVE LINK, renderer half (plans/native-engine.md; main half src/main/engineHost.ts,
// engine half engine/artlux-engine/src/runtime.rs).
//
// "THE HOST EVALUATES, THE ENGINE DRAWS." The frame engine has already turned the show (scenes, the timeline,
// the state machine, automation, fades) into this frame's EFFECTIVE surfaces and fixtures. This module sends
// exactly those to the native engine — never the authored document, which would make the engine re-implement
// all of that and drift from it:
//   - the DOCUMENT, whenever any part of it changes (references, or what a surface's source resolves to —
//     a codec claiming a file, a bake going live), with a new `rev`;
//   - a TICK every frame: the show time (effects), the brightness, for each HAP surface the frame INDEX this
//     app is showing right now — so the engine draws the same frame, not one from a clock of its own — and
//     (E1f-2) each LIGHT fixture's channel values exactly as this frame's precedence stack wrote them. The
//     engine places those bytes; it never evaluates a light (profiles, lighting clips, poses, overrides).
//     Which fixtures ARE lights is services/fixtureKind's call, sent with the document.
// Per surface the SOURCE is decided by surfaceMedia.nativeSource, beside getDrawable, from the same branches.
//
// OFF unless main says the engine is on (`--native-engine`): then nothing here serialises anything. The app's
// own frames keep flowing either way; main decides which sender reaches the wire.

export interface LinkInputs {
  controllers: Controller[];
  protocol: OutputProtocol;
  targetIp: string;
  broadcast: boolean;
  gamma: number;
  artNetPort: number;
  outputEnabled: boolean;
  fixtureProfiles: ReadonlyMap<string, FixtureProfile>;
}

/**
 * E3f — THE LIGHTS' PROFILES, for the engine's byte solve (lightpack.rs): each light's profile with its channels
 * and the modes its fixtures can resolve to — the ones they name and the first (modeOf's fallback), in the
 * profile's order, so a repeated mode key still resolves to the first of them.
 */
function lightProfiles(fixtures: Fixture[], profiles: ReadonlyMap<string, FixtureProfile>): Record<string, unknown> {
  const named = new Map<string, Set<string>>();
  for (const f of fixtures.filter((x) => isLight(x))) {
    const pid = `${f.profileId}`;   // a light always names one (fixtureKind); an unresolved one finds no profile below
    let s = named.get(pid);
    if (!s) named.set(pid, (s = new Set()));
    if (f.profileMode) s.add(f.profileMode);
  }
  const out: Record<string, unknown> = {};
  for (const [id, keys] of named) {
    const p = profiles.get(id);
    if (p) out[id] = { channels: p.channels, modes: p.modes.filter((m, i) => i === 0 || keys.has(m.key)) };
  }
  return out;
}

let enabled = false;
export const isEnabled = (): boolean => enabled;

/**
 * E3d — THE AUTOMATION LANES THE ENGINE EVALUATES ITSELF: a surface's opacity, and an effect's speed and
 * intensity — the leaves the engine reads straight off the surface (compose.rs, effects.rs). The others stay
 * the app's: text leaves shape a raster the app draws, fixture and global leaves reach the engine already
 * resolved (light bytes, brightness), and geometry is not automatable.
 */
export const engineLane = (path: string): boolean => /^surfaces\.[^.]+\.content\.(opacity|speed|intensity)$/.test(path);
let lanePaths: string[] = [];
let lastLanes = '';

try {
  void window.artlux?.nativeEngineEnabled?.().then((v) => {
    enabled = !!v;
    // A calibration map handed over BEFORE this answer came back would otherwise never reach main.
    if (enabled) for (const { map, key } of baked.values()) window.artlux?.nativeEngineBakedMap?.(key, map.w, map.h, map.uv, map.alpha ?? null);
    refreshDisplays();
  }, () => { /* an older main: off */ });
} catch { /* no bridge (a test page): off */ }

let rev = 0;
let lastRefs: unknown[] = [];
let lastSources = '';

// ── E1f-3: PROJECTOR OUTPUTS ────────────────────────────────────────────────────────────────────────
// App hands these in (they are not frame-engine inputs): the outputs, the projector master brightness
// (committed and live drags) and the cold-start hold. The engine draws an output only when it can draw
// it EXACTLY as ProjectorApp draws it (projector.rs, identical to ProjectorGL — E1e-1; calib3d.rs, identical to
// ProjectorScene), so an output with anything else on it is listed WITH THE REASON and the app keeps every output
// (all or nothing, runtime.rs). A mask, a blend map, a windowed output, an NDI send, an NVIDIA hardware warp and
// the live RENDER-FROM-PROJECTOR (the parts it draws — see calibFor) are the engine's (E6f — see projectorEntry).
// `hwOwned`: the outputs whose geometry + blend the NVIDIA SCANOUT applies (App's hwOwnsGeometry — not re-derived
// here: it needs the NVAPI answer and the displays' `internal`, and two predicates would drift).
let projOutputs: ProjectorOutput[] = [];
let projBrightness = 1;
let projBooting = false;
let projHw = new Set<string>();
let projHwKey = '';
export function setProjectors(outputs: ProjectorOutput[], brightness: number, hwOwned: string[] = []): void {
  projOutputs = outputs; projBrightness = brightness; projHw = new Set(hwOwned); projHwKey = [...projHw].sort().join(',');
  refreshDisplays();
}
// E6f: RENDER-FROM-PROJECTOR. App hands in the scene it sends the projector windows (resolveProjectedScene
// applied), the outputs it tells to draw the venue (its rendersVenue — one predicate), and the output a
// calibration session owns (its wizard drives that window's mode — authoring, the app's). A venue GLB that
// finishes loading changes the document through venueLink.venueGen, which is in its change key.
let venueScene: Scene3D | null = null;
let venueRender = new Set<string>();
let venueCalibrating: string | null = null;
let venueKey = '';
export function setVenue(scene: Scene3D | null, render: string[], calibrating: string | null): void {
  venueScene = scene; venueRender = new Set(render); venueCalibrating = calibrating;
  venueKey = `${[...venueRender].sort().join(',')}|${calibrating ?? ''}`;
}

// ── E2: RASTER SOURCES (text first) ─────────────────────────────────────────────────────────────────
// A picture this app draws and the engine shows (plans/native-engine.md §2: "the app rasterises, the engine
// receives an image on change"). Shipped when its BITMAP changes — by identity, not the plugin's generation
// number, which restarts at 1 when a surface is released and drawn again — and BEFORE the document naming the
// source (one IPC channel order: main forwards the raster first). A surface on an enabled projector output
// gets a second raster at that display's CSS size (`<id>@proj`), as the app's projector window draws it.
let displayCss: Record<string, [number, number]> = {};
function refreshDisplays(): void {
  if (!enabled) return;
  void window.artlux?.nativeEngineDisplays?.().then((d) => { displayCss = d ?? {}; }, () => { /* keep the last */ });
}
const rasterSent = new Map<string, ImageBitmap>();
let rasterSeq = 0;
function shipRaster(key: string, r: { bitmap: ImageBitmap; gen: number } | null): void {
  if (!r || rasterSent.get(key) === r.bitmap) return;
  const { width: w, height: h } = r.bitmap;
  if (!w || !h || typeof OffscreenCanvas === 'undefined') return;
  const g = new OffscreenCanvas(w, h).getContext('2d');
  if (!g) return;
  g.drawImage(r.bitmap, 0, 0);
  const px = g.getImageData(0, 0, w, h).data;   // straight alpha, row 0 at the top
  rasterSent.set(key, r.bitmap);
  window.artlux?.nativeEngineRaster?.(key, ++rasterSeq, w, h, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
}
function shipRasters(surfaces: Surface[], sources: Record<string, contentSource.NativeSource>): void {
  for (const s of surfaces) {
    if (sources[s.id]?.kind !== 'raster') { rasterSent.delete(s.id); rasterSent.delete(`${s.id}@proj`); continue; }
    shipRaster(s.id, contentSource.nativeRaster(s.id, s.content));
    let best: [number, number] | null = null;
    for (const o of projOutputs) {
      const c = o.enabled && o.surfaceId === s.id && o.displayId != null ? displayCss[String(o.displayId)] : undefined;
      if (c && (!best || c[0] * c[1] > best[0] * best[1])) best = c;
    }
    if (best) shipRaster(`${s.id}@proj`, contentSource.nativeRaster(s.id, s.content, best[0] * best[1]));
  }
}
export function setProjectorBrightness(brightness: number): void { projBrightness = brightness; }
export function setBooting(booting: boolean): void { projBooting = booting; }

// Item 3: each output's imported CALIBRATION MAP (an .mpcdi region, as the calibration plugin hands it to
// the window — App.sendToProjector records it here). Sent to main ONCE per map (it writes the file the
// engine reads; ~10 MB is not a per-document payload); the document then names it by key.
type BakedMap = { w: number; h: number; uv: Float32Array; alpha?: { w: number; h: number; data: Uint8Array } };
const baked = new Map<string, { map: BakedMap; key: string }>();
let bakedSeq = 0;
export function setProjectorBaked(surfaceId: string, map: BakedMap | null): void {
  if (!map) { baked.delete(surfaceId); bakedSeq++; return; }
  const key = `${surfaceId}-${++bakedSeq}`;
  baked.set(surfaceId, { map, key });
  if (enabled) window.artlux?.nativeEngineBakedMap?.(key, map.w, map.h, map.uv, map.alpha ?? null);
}

/** The output's settings as the app's window gets them (App pushProjectorState): FLAT when the NVIDIA scanout owns it. */
function effectiveOutput(o: ProjectorOutput) {
  return projHw.has(o.surfaceId)
    ? { cornerPin: defaultCornerPin(), warp: null, softEdge: defaultSoftEdge(), gamma: o.gamma, colorGain: [1, 1, 1] as [number, number, number], blackLift: [0, 0, 0] as [number, number, number], blend: null, scanout: true }
    : { cornerPin: o.cornerPin, warp: o.warp ?? null, softEdge: o.softEdge, gamma: o.gamma, colorGain: o.colorGain, blackLift: o.blackLift, blend: o.blend ?? null };
}

/**
 * E6f: a calibrated output in RENDER mode — the venue as the engine draws it (venueLink.calibDoc), or why not.
 * The scene's own reasons are venueLink's; these are the OUTPUT's, each a pass ProjectorScene / ProjectorApp
 * applies that calib3d.rs does not: an NDI send WITHOUT a residual warp (the app's window then returns before its
 * capture and sends nothing). Null: not in render mode.
 *
 * A RESIDUAL WARP is the engine's (E6f step 3): ProjectorApp's path B — the scene's canvas becomes the warp stage's
 * source — decided by ProjectorApp's own test (hasResidualWarp) and handed over as `warped`. Its NDI send is then
 * the app's too (path B captures after warping), and the engine's.
 *
 * The POST PASS is the engine's (E6f step 2): ProjectorScene's EffectComposer — the lens distortion, then the blend
 * (soft edge, colour gain, black lift, the solved rig blend). It runs exactly when ProjectorScene mounts it
 * (hasDistortion || needsBlendPass, ProjectorScene's own tests), with the values its effects are built from
 * (renderLook's distortionValues / blendValues — one definition), and the blend look is the one the window's
 * `config` carries (effectiveOutput: flat under an NVIDIA hardware warp, as App pushes it).
 */
function calibFor(o: ProjectorOutput, sources: Record<string, contentSource.NativeSource>): { doc: unknown } | { why: string } | null {
  if (!venueRender.has(o.surfaceId) || baked.has(o.surfaceId) || !venueScene || !o.calibration) return null;
  const eff = effectiveOutput(o);
  const warped = hasResidualWarp(eff.cornerPin, eff.warp);
  if (o.ndiSend && !warped) return { why: 'calibrated and sent as NDI (the app sends nothing there without a residual warp)' };
  const r = venueLink.calibDoc(o.calibration, venueScene);
  if ('why' in r) return r;
  const look = { softEdge: eff.softEdge, colorGain: eff.colorGain, blackLift: eff.blackLift, blend: eff.blend };
  const distorted = hasDistortion(o.calibration), blended = needsBlendPass(look);
  const bv = blended ? blendValues(look) : null;
  const post = distorted || blended ? {
    dist: distorted ? distortionValues(o.calibration) : null,
    blend: bv ? { ...bv, map: bv.map ? { w: bv.map.w, h: bv.map.h, alpha: Array.from(bv.map.alpha), black: Array.from(bv.map.black) } : null } : null,
  } : null;
  for (const sid of r.surfaces) {
    const x = sources[sid];
    if (!x) return { why: `the venue shows surface ${sid}, which is gone` };
    if (x.kind === 'unsupported') return { why: `the venue shows '${sid}': ${'why' in x ? x.why : 'a source the engine does not draw'}` };
  }
  return { doc: { ...(r.doc as object), post, warped } };
}

function projectorEntry(o: ProjectorOutput, surfaces: Surface[], sources: Record<string, contentSource.NativeSource>) {
  const s = surfaces.find((x) => x.id === o.surfaceId);
  const calib = calibFor(o, sources);
  // In render mode the window shows the VENUE, not its own surface — whose source then does not decide.
  const inRender = !!calib && 'doc' in calib;
  const src = sources[o.surfaceId];
  const why =
    !s ? 'its surface is gone'
    : o.displayId === null ? 'no display chosen'
    // E6f: a WINDOWED output (WINDOWED_DISPLAY) is the engine's too — main gives it the app window's rect, the engine
    // opens an ordinary window there and the app's is hidden while it shows (main/projector.ts, outputs.rs).
    // E6f: a calibration SESSION drives its output's window itself (patterns, crosshair, the verify looks) — authoring.
    : o.surfaceId === venueCalibrating ? 'a calibration session is open on it'
    // A calibration MAP is played (item 3) — it supersedes the venue render inside the window too. Calibration
    // WITHOUT a map, in render mode, is the live RENDER-FROM-PROJECTOR (calibFor below); a calibration NOT in
    // render mode (no pose, opted out, no visible venue) is the plain warp in the app's window too.
    : calib && 'why' in calib ? calib.why
    // E6f: an NVIDIA HARDWARE WARP is the engine's too. NVAPI warps + blends the DISPLAY at scanout — whatever window is
    // on it, the engine's topmost one included — and the app's window then draws the output FLAT (App
    // pushProjectorState: identity corner-pin, no warp, no soft edge, unit gain, no lift; gamma stays), so the
    // engine is handed the same flat output below. `hwWarp` on an output NVAPI does NOT own (a non-pro GPU, the
    // built-in panel, a window) is ignored by the app, which draws the GLSL warp — and so is it here.
    // E6f: NOT refused — a projection MASK (`projMask`) and a BLEND MAP (`blend`). The app's projector window applies
    // neither: the mask is the NVIDIA scanout path's (nvwarpApply), the blend map render-from-projector's
    // (ProjectorScene) — both refused above. Without them the app draws the plain warp, which the engine draws the
    // same (test:native-projectors, with both set). verify:invariants fails this if the app ever applies them.
    // E6f: an NDI SEND is the engine's too — it captures its own window as the app's does and sends under the SAME
    // name (`ndi` below); the app's sender stands down while it does (plugins/ndi). An engine without NDI refuses.
    : inRender ? undefined
    : !src || src.kind === 'unsupported' ? (src && 'why' in src ? src.why : 'a source the engine does not draw')
    : undefined;
  // E6f: a WINDOWED output carries the app's badge (components/brand/badge.ts) — the SAME bitmap the app's window
  // draws, shipped as a raster `badge:<surface>` and composited by the engine where the app draws it.
  const windowed = o.displayId === WINDOWED_DISPLAY;
  if (windowed) {
    const key = `badge:${o.surfaceId}`;
    void badgeBitmap(o.name || s?.name || '', window.devicePixelRatio || 1).then((b) => shipRaster(key, b && { bitmap: b, gen: 0 }));
  }
  return {
    id: o.surfaceId, surfaceId: o.surfaceId, name: o.name ?? s?.name ?? o.surfaceId, displayId: o.displayId,
    ...(windowed ? { badge: `badge:${o.surfaceId}` } : {}),
    // The app's sender name and capture cap (App's NDI reconcile, ProjectorApp captureNdi — ndiFullRes = broadcast).
    ...(o.ndiSend && s ? { ndi: { name: `ArtLux — ${s.name}`, maxW: ndiCap(BROADCAST)[0], maxH: ndiCap(BROADCAST)[1] } } : {}),
    output: (({ blend: _b, ...x }) => x)(effectiveOutput(o)),
    ...(inRender ? { calib: (calib as { doc: unknown }).doc } : {}),
    ...(baked.has(o.surfaceId) ? { baked: { key: baked.get(o.surfaceId)!.key } } : {}),
    ...(why ? { why } : {}),
  };
}

/** One frame. Cheap when nothing changed: a reference compare, one small string, one IPC send. */
export function frame(inputs: LinkInputs, surfaces: Surface[], fixtures: Fixture[], brightness: number, lightBytes: Record<string, number[]> = {}, lanesView: Surface[] | null = null, lightLive: Record<string, Record<string, number>> = {}): void {
  const tick = link(inputs, surfaces, fixtures, brightness, lightBytes, lanesView, lightLive);
  if (tick) window.artlux?.nativeEngineTick?.(tick);
}

/**
 * E6a — THE TICK OF A BAKE FRAME. The same document (sent when it changed, as for a live frame) and the same tick,
 * RETURNED rather than sent: plugins/bake hands it to the engine as a `bakeFrame` request, which is answered once
 * the frame is drawn and encoded (a live tick is coalesced; a bake frame must never be). frameEngine.bakeTick
 * builds the frame's effective surfaces exactly as its own tick does. Null when the engine is off.
 */
export function bakeTick(inputs: LinkInputs, surfaces: Surface[], fixtures: Fixture[], brightness: number, lightBytes: Record<string, number[]> = {}, lanesView: Surface[] | null = null, lightLive: Record<string, Record<string, number>> = {}, at: BakeAt = {}): string | null {
  return link(inputs, surfaces, fixtures, brightness, lightBytes, lanesView, lightLive, at);
}

/** E6a: the bake frame's EXACT time on the clock it steps (`t` the show's, `ph` the playhead's). The timeline's own
 *  reading of a stepped clock is a float sum a hair off it (0.23999… for 0.24), and an effect that steps on a frame
 *  boundary then draws the previous step — measured, one frame in a hundred. The app's render uses the exact time. */
export interface BakeAt { t?: number; ph?: number }

/** E6a: what the engine was last told a surface's content is (`kind`, and `why` when it cannot draw it). */
let lastKinds: Record<string, { kind: string; why?: string }> = {};
export function sourceKind(surfaceId: string): { kind: string; why?: string } | undefined { return lastKinds[surfaceId]; }

function link(inputs: LinkInputs, surfaces: Surface[], fixtures: Fixture[], brightness: number, lightBytes: Record<string, number[]>, lanesView: Surface[] | null, lightLive: Record<string, Record<string, number>>, at: BakeAt = {}): string | null {
  if (!enabled) return null;
  // E3d: `lanesView` — the surfaces WITHOUT the values of the lanes the engine evaluates (frameEngine; null
  // while a scene fade runs over them, or nothing is automated). The document carries the authored values and
  // the lanes; the engine samples them per tick, so a curve no longer re-sends the document every frame.
  if (lanesView) surfaces = lanesView;
  const lanesKey = lanesView ? `on ${timeline.nativeLanes(engineLane).gen}` : 'off';
  const sources: Record<string, contentSource.NativeSource> = {};
  for (const s of surfaces) sources[s.id] = surfaceMedia.nativeSource(s);
  // ⚠ THE APP HAS ONE SPOUT RECEIVER for every Spout surface, and the most recently attached sender wins
  // (plugins/spout spoutContentSource): two surfaces naming DIFFERENT senders both show the same one today.
  // The engine would show each its own — a different picture — so that case stays the app's.
  const spoutSenders = new Set(Object.values(sources).flatMap((x) => (x.kind === 'spout' ? [x.name] : [])));
  if (spoutSenders.size > 1) {
    for (const id in sources) if (sources[id].kind === 'spout') sources[id] = { kind: 'unsupported', why: 'two Spout senders at once (the app shows one of them on every Spout surface)' };
  }
  // The same for NDI: one receiver in the app, the latest source wins on every NDI surface (plugins/ndi).
  const ndiSources = new Set(Object.values(sources).flatMap((x) => (x.kind === 'ndi' ? [x.name] : [])));
  if (ndiSources.size > 1) {
    for (const id in sources) if (sources[id].kind === 'ndi') sources[id] = { kind: 'unsupported', why: 'two NDI sources at once (the app shows one of them on every NDI surface)' };
  }
  // E3a: a composite's tracks become hidden sources `layer:<id>` beside the surfaces (an effect clip carries
  // its content: it is no surface's). Their clip content is kept for the rasters and the per-frame ticks.
  const layerContent = new Map<string, SurfaceContent>();
  for (const s of surfaces) {
    const c = sources[s.id];
    if (c.kind !== 'comp') continue;
    for (const [key, { src, content }] of Object.entries(c.sources)) {
      sources[key] = src.kind === 'effect' ? ({ ...src, content } as contentSource.NativeSource) : src;
      layerContent.set(key, content as SurfaceContent);
    }
    sources[s.id] = { ...c, sources: {} };
  }
  lastKinds = Object.fromEntries(surfaces.map((s) => { const x = sources[s.id] as { kind: string; why?: string }; return [s.id, { kind: x.kind, ...(x.why ? { why: x.why } : {}) }]; }));
  shipRasters(surfaces, sources);   // E2: before the document that names them
  for (const [key, content] of layerContent) if (sources[key]?.kind === 'raster') shipRaster(key, contentSource.nativeRaster(key, content));
  const sourcesKey = JSON.stringify(sources);
  const refs = [surfaces, fixtures, inputs.fixtureProfiles, inputs.controllers, inputs.protocol, inputs.targetIp, inputs.broadcast, inputs.gamma, inputs.artNetPort, inputs.outputEnabled, projOutputs, projHwKey, venueScene, venueKey, venueLink.venueGen(), bakedSeq, ...lightingRefs()];
  if (sourcesKey !== lastSources || lanesKey !== lastLanes || refs.length !== lastRefs.length || refs.some((r, i) => r !== lastRefs[i])) {
    lastRefs = refs; lastSources = sourcesKey; lastLanes = lanesKey; rev++;
    const ln = lanesView ? timeline.nativeLanes(engineLane) : { gen: 0, lanes: [] };
    lanePaths = ln.lanes.map((l) => l.path);
    const doc = {
      rev, fixtures, surfaces, controllers: inputs.controllers,
      defaults: { protocol: inputs.protocol, ip: inputs.targetIp, broadcast: inputs.broadcast },
      gamma: inputs.gamma, port: inputs.artNetPort, outputEnabled: inputs.outputEnabled, sources, lanes: ln, lighting: lightingDoc(),
      lights: fixtures.filter((f) => isLight(f)).map((f) => f.id),
      profiles: lightProfiles(fixtures, inputs.fixtureProfiles),
      // E1f-3: main adds each output's display as PHYSICAL bounds (engineHost.ts) — it owns the screen.
      projectors: projOutputs.filter((o) => o.enabled).map((o) => projectorEntry(o, surfaces, sources)),
    };
    window.artlux?.nativeEngineDoc?.(JSON.stringify(doc), rev);
  }
  const hap: Record<string, number> = {};
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'hap') continue;
    const g = contentSource.getDrawableGeneration(s.id, s.content);
    if (g !== undefined) hap[s.id] = g;
  }
  // Item 2c-4: each MP4 surface's frame ON SCREEN — the VideoFrame.timestamp the app is drawing (the codec's
  // generation: absolute, a looping surface adds the file's duration per loop; the engine folds it back).
  const mp4: Record<string, number> = {};
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'mp4') continue;
    const g = surfaceMedia.nativeGeneration(s);   // E6f: a live bake's frame, when one plays here
    if (g !== undefined) mp4[s.id] = g;
  }
  // Item 2b: each NDI surface's canvas size in the APP — the engine scales its frame to exactly that.
  const ndi: Record<string, [number, number]> = {};
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'ndi') continue;
    const c = surfaceMedia.getDrawable(s) as { width?: number; height?: number } | null;
    if (c && c.width && c.height) ndi[s.id] = [c.width, c.height];
  }
  // Item 2d step 5: each TWIN camera surface's picture fingerprint (two cameras of one model: the engine needs
  // the picture to know which is this one — cam.rs resolve). Sent only while there is one; tiny (144 numbers).
  const camfp: Record<string, number[]> = {};
  for (const s of surfaces) {
    const src = sources[s.id];
    if (src.kind !== 'camera' || !src.twins) continue;
    const fp = contentSource.cameraFingerprintFor(s.content);
    if (fp) camfp[s.id] = fp;
  }
  // E2: each SHADER surface's uniforms this frame (the plugin's nativeTick — the same taps the app's own draw
  // reads), at the show time the app draws it at.
  const shader: Record<string, unknown> = {};
  const showT = at.t ?? timeline.getShowTime();   // E6a: a bake frame's exact show time
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'shader') continue;
    const u = contentSource.nativeTick(s.id, s.content, showT);
    if (u) shader[s.id] = u;
  }
  // E3a: each composite's per-frame values — every track's clip alpha, and its clip-local time (the time a
  // track's shader / effect is drawn at); a track's shader uniforms are its clip's, at that time.
  const comp: Record<string, Record<string, number>> = {};
  const times: Record<string, number> = {};
  for (const s of surfaces) {
    const c = sources[s.id];
    if (c.kind !== 'comp') continue;
    const program = s.content.type === 'PROGRAM';
    const ids = program ? null : surfaceMedia.stackIdsOf(s);
    const a: Record<string, number> = {};
    for (const e of timeline.nativeLayers(program ? null : ids ?? (s.content.layerId ? [s.content.layerId] : []), !program && !ids)) {
      const key = `layer:${e.layerId}`;
      a[key] = e.alpha; times[key] = e.time;
      // E3b: a video track's frame — HAP its index, MP4 its VideoFrame timestamp — as for a surface (hap / mp4).
      if (e.codec && e.codec.gen !== undefined && sources[key]?.kind === 'hap') hap[key] = e.codec.gen;
      if (e.codec && e.codec.gen !== undefined && sources[key]?.kind === 'mp4') mp4[key] = e.codec.gen;
      const content = layerContent.get(key);
      if (content && sources[key]?.kind === 'shader') { const u = contentSource.nativeTick(key, content, e.time); if (u) shader[key] = u; }
    }
    comp[s.id] = a;
  }
  // E2: each TRACKING / AUGMENTA surface's blobs and trail ribbons, as the app drew them this frame.
  const blobs: Record<string, unknown> = {};
  for (const s of surfaces) {
    if (sources[s.id].kind !== 'blobs') continue;
    const u = contentSource.nativeTick(s.id, s.content, showT);
    if (u) blobs[s.id] = u;
  }
  // A light's values as the wire will carry them: the frame codec stores each into a Uint8Array, i.e.
  // JavaScript's ToUint8 (truncate, then modulo 256; NaN → 0). Done HERE so the engine gets bytes.
  const lights: Record<string, number[]> = {};
  for (const id in lightBytes) lights[id] = lightBytes[id].map((v) => { const t = Math.trunc(Number(v)); return Number.isFinite(t) ? ((t % 256) + 256) % 256 : 0; });
  // E3c: `ph` — the PLAYHEAD the tracks above were evaluated at; the engine evaluates their clips from it.
  // E3d: `auto` — the value each engine-evaluated lane holds in the app this frame, for the engine to CHECK.
  const auto: Record<string, number> = {};
  for (const p of lanePaths) { const v = automationOverlay.value(p); if (v !== undefined) auto[p] = v; }
  // E3e: the role values and colours the app's players published this frame, for the engine to CHECK.
  const lroles = lightingOverlay.isActive() ? lightingOverlay.snapshot() : {};
  const lcolors = colorOverlay.isActive() ? colorOverlay.snapshot() : {};
  // E3f: the layers that are EVENTS, not time — the engine cannot evaluate them from the playhead, so the app
  // sends them for the byte solve: the fired pose cue, the faders under a hand, the lane-owned light channels.
  const lcue = lightingCue.isActive() ? lightingCue.snapshot() : {};
  const lown: Record<string, string[]> = {};
  if (automationOverlay.isActive()) for (const id in lightBytes) { const k = automationOverlay.ownedUnder(`fixtures.${id}.dmx.`); if (k.length) lown[id] = k; }
  // E3: `fm` — the renderClock time this frame's playhead and show time were computed for; `tp` — the
  // transport anchor (timeline.ts TransportAnchor) the engine runs its OWN clock from and checks at `fm`. ON
  // EVERY TICK, though it changes only on events: main DROPS a tick the engine is too busy to take (engineHost
  // ticks-dropped), and an anchor carried only by the tick that changed it was lost with it — the engine then ran
  // on the previous one (measured: 0.3 s off for two seconds at a show's start). The engine re-anchors only when
  // the revision changes, so a repeat costs it a comparison. ~300 bytes on a tick that already carries kilobytes.
  const tp = timeline.transportAnchor() ?? undefined;
  return JSON.stringify({ rev, t: at.t ?? timeline.getShowTime(), ph: at.ph ?? timeline.getPlayhead(), fm: timeline.getFrameTimeMs(), tp, auto, lroles, lcolors, lcue, llive: lightLive, lown, brightness, hap, mp4, ndi, camfp, shader, blobs, comp, times, lights, proj: { brightness: projBrightness, booting: projBooting } });
}
