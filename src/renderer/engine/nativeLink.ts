import type { Fixture, Surface, Controller, OutputProtocol, SurfaceContent } from '../types';
import { WINDOWED_DISPLAY, type ProjectorOutput } from '../../../shared/protocol';
import * as surfaceMedia from '../services/surfaceMedia';
import { isLight } from '../services/fixtureKind';
import * as contentSource from '../services/contentSource';
import { timeline } from '../services/timeline';

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
}

let enabled = false;
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
// it EXACTLY as ProjectorApp's plain warp path does (projector.rs, identical to ProjectorGL — E1e-1), so an
// output with anything else on it — calibration (render-from-projector or a baked map), a mask, NVIDIA
// hardware warp, an NDI send, a blend map, a windowed display — is listed WITH THE REASON and the app keeps
// every output (all or nothing, runtime.rs).
let projOutputs: ProjectorOutput[] = [];
let projBrightness = 1;
let projBooting = false;
export function setProjectors(outputs: ProjectorOutput[], brightness: number): void { projOutputs = outputs; projBrightness = brightness; refreshDisplays(); }

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

function projectorEntry(o: ProjectorOutput, surfaces: Surface[], sources: Record<string, contentSource.NativeSource>) {
  const s = surfaces.find((x) => x.id === o.surfaceId);
  const src = sources[o.surfaceId];
  const why =
    !s ? 'its surface is gone'
    : o.displayId === null || o.displayId === WINDOWED_DISPLAY ? 'a windowed output'
    // A calibration MAP is played (item 3) — it supersedes the venue render inside the window too. Calibration
    // WITHOUT a map is the live render-from-projector, which stays the app's.
    : !baked.has(o.surfaceId) && (o.calibration || o.useCalibration) ? 'calibrated (render-from-projector)'
    : o.hwWarp ? 'NVIDIA hardware warp'
    : o.projMask?.polys?.length ? 'a projection mask'
    : o.ndiSend ? 'an NDI send'
    : o.blend ? 'a blend map'
    : !src || src.kind === 'unsupported' ? (src && 'why' in src ? src.why : 'a source the engine does not draw')
    : undefined;
  return {
    id: o.surfaceId, surfaceId: o.surfaceId, name: o.name ?? s?.name ?? o.surfaceId, displayId: o.displayId,
    output: { cornerPin: o.cornerPin, warp: o.warp ?? null, softEdge: o.softEdge, gamma: o.gamma, colorGain: o.colorGain, blackLift: o.blackLift },
    ...(baked.has(o.surfaceId) ? { baked: { key: baked.get(o.surfaceId)!.key } } : {}),
    ...(why ? { why } : {}),
  };
}

/** One frame. Cheap when nothing changed: a reference compare, one small string, one IPC send. */
export function frame(inputs: LinkInputs, surfaces: Surface[], fixtures: Fixture[], brightness: number, lightBytes: Record<string, number[]> = {}): void {
  if (!enabled) return;
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
  shipRasters(surfaces, sources);   // E2: before the document that names them
  for (const [key, content] of layerContent) if (sources[key]?.kind === 'raster') shipRaster(key, contentSource.nativeRaster(key, content));
  const sourcesKey = JSON.stringify(sources);
  const refs = [surfaces, fixtures, inputs.controllers, inputs.protocol, inputs.targetIp, inputs.broadcast, inputs.gamma, inputs.artNetPort, inputs.outputEnabled, projOutputs, bakedSeq];
  if (sourcesKey !== lastSources || refs.length !== lastRefs.length || refs.some((r, i) => r !== lastRefs[i])) {
    lastRefs = refs; lastSources = sourcesKey; rev++;
    const doc = {
      rev, fixtures, surfaces, controllers: inputs.controllers,
      defaults: { protocol: inputs.protocol, ip: inputs.targetIp, broadcast: inputs.broadcast },
      gamma: inputs.gamma, port: inputs.artNetPort, outputEnabled: inputs.outputEnabled, sources,
      lights: fixtures.filter((f) => isLight(f)).map((f) => f.id),
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
    const g = contentSource.getDrawableGeneration(s.id, s.content);
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
  const showT = timeline.getShowTime();
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
  window.artlux?.nativeEngineTick?.(JSON.stringify({ rev, t: timeline.getShowTime(), brightness, hap, mp4, ndi, camfp, shader, blobs, comp, times, lights, proj: { brightness: projBrightness, booting: projBooting } }));
}
