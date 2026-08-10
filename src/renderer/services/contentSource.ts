import { SourceType, type SurfaceContent } from '../types';
import { getInputCanvas, startInput, stopInput } from './dmxInput';
import { SurfaceEffect } from '../gpu/surfaceFx';
import { resolveMediaUrl, mimeForPath } from './mediaCache';
import { contentSourceRegistry, videoCodecRegistry } from '../host/registries';
import * as codecResidency from './codecResidency';

// One registry that turns ANY consumer's content into a drawable, keyed by an arbitrary string
// (surfaces use their id; timeline layers use `layer:<layerId>`). Per-instance producers (video /
// image / effect) live one-per-key; the built-in live receivers are shared and refcounted across all
// consumers, so they run when EITHER a surface or a timeline clip wants them and stop the instant
// none do — DMX-in as ONE singleton, the camera as one capture PER DEVICE (a surface names the video
// input it wants; see the Cameras section). Plugin-contributed live sources (Spout / NDI / TRACKING)
// own the same refcount discipline inside their provider.
//
// surfaceMedia delegates here for surfaces; services/timeline delegates here for content clips.

type Drawable = CanvasImageSource;
type Entry =
  | { type: 'VIDEO'; el: HTMLVideoElement; url: string }
  // An ImageBitmap rather than an <img>: already decoded (no decode-on-first-draw hitch), sized without
  // touching layout, transferable to a worker, and a CanvasImageSource everywhere an <img> was. `bmp`
  // is null until the decode lands. It MUST be closed when the entry is dropped — an ImageBitmap holds
  // GPU-side memory that garbage collection will not hurry to reclaim.
  | { type: 'IMAGE'; bmp: ImageBitmap | null; url: string }
  | { type: 'CODEC'; codecId: string; path: string }; // a plugin VideoCodec (e.g. HAP) decodes this file

const media = new Map<string, Entry>();          // VIDEO / IMAGE / CODEC, keyed by consumer key
const effects = new Map<string, SurfaceEffect>(); // EFFECT, keyed by consumer key

// Shared live receivers, refcounted by consumer key. (Spout + NDI moved to their plugins — same
// refcount pattern, now owned by the content-source providers.) The camera's refcount lives with the
// cameras below, because it is per-DEVICE rather than global.
const dmxConsumers = new Set<string>();

// ⚠ CODEC DECODERS ARE SHARED PER FILE PATH — SO THEY MUST BE REFCOUNTED PER CONSUMER.
//
// A plugin VideoCodec keys its surface decoder by PATH, not by consumer: hap `open$`
// (hapManager) and mp4 `decoders` (mp4Decoder) both return the SAME decoder to every consumer
// asking for the same file. That sharing is the point — it is why N surfaces on one clip cost
// one decode, and why HAP survives many simultaneous sources.
//
// But `closeSurface(path)` tears that shared decoder down unconditionally. Keyed by consumer,
// `dropMedia` used to call it the moment ANY one consumer let go — so with two surfaces on the
// same file, deleting or retyping one KILLED THE OTHER'S DECODER. The survivor then went black
// permanently, because reconcileMedia() early-returns when the url is unchanged and never reopens.
//
// THE COUNT NOW LIVES IN services/codecResidency — one refcount for the whole app, not one per
// module. It used to live here, which was right about consumers and blind to the OTHER holder of the
// same decoders: `timeline.warmMedia` opens path-keyed decoders when it warms a pool, and nothing
// counted or released those. Two independent refcounts over one shared resource is how a warm pool
// came to hold decoders forever. Same behaviour for this module's callers, one owner vocabulary.
const retainCodec = (path: string, key: string, codecId: string): void => codecResidency.retain(path, key, codecId);
const releaseCodec = (codecId: string, path: string, key: string): void => codecResidency.release(path, key, codecId);

let dmxActive = false;
let playing = true;

// `url` is a live blob:/http url or an absolute file path (resolved to a blob url via IPC).
function makeVideo(url: string): HTMLVideoElement {
  const v = document.createElement('video');
  // ⚠ crossOrigin is LOAD-BEARING, in both directions. It is what keeps frames UNTAINTED so the 2D
  // composite and the WebGPU LED sampler may read them — drop it and the whole output pipeline throws
  // SecurityError. Under `blob:` it was inert (same origin); under artlux-media:// it makes every load
  // a CORS request, which is why the protocol handler answers with Access-Control-Allow-Origin on
  // every response. Change one without the other and every video in the show goes black.
  v.loop = true; v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
  // Synchronous — a path becomes a streaming url by string construction, so there is no "not loaded
  // yet" window to schedule around any more.
  v.src = resolveMediaUrl(url); v.load();
  if (playing) v.play().catch(() => {});
  return v;
}
/**
 * Start decoding an image into the entry stored at `key`. Returns the entry immediately with `bmp:
 * null`; the bitmap appears when the decode finishes, and getDrawable simply yields nothing until then
 * (the same "not ready yet" state an <img> had before `complete`).
 *
 * Re-checks the map before storing: a surface can be retyped or pointed at another file while this is
 * in flight, and writing a stale bitmap into a live entry would show the previous picture. In that case
 * the bitmap is closed on the spot rather than leaked.
 */
function makeImage(key: string, url: string): Entry {
  const entry: Entry = { type: 'IMAGE', bmp: null, url };
  void (async () => {
    try {
      const src = resolveMediaUrl(url);
      if (!src) return;
      // ONE copy now, streamed: the file used to be read whole over IPC into a Blob and then fetched
      // BACK out of that blob — two full copies of every image in renderer memory before decode.
      const blob = await (await fetch(src)).blob();
      const bmp = await createImageBitmap(blob);
      const cur = media.get(key);
      if (cur === entry) entry.bmp = bmp;
      else bmp.close(); // superseded while decoding
    } catch (e) {
      console.warn('[contentSource] image decode failed', url, (e as Error)?.message);
    }
  })();
  return entry;
}

// ── Cameras ──────────────────────────────────────────────────────────────────────────────────
// ONE CAPTURE PER DEVICE, not one capture full stop. It used to be a single global stream opened
// with a bare `getUserMedia({ video: true })`, i.e. always the OS default video input, with no way
// for a surface to ask for anything else. That is fine on a laptop with one webcam and wrong the
// moment a machine also has a VIRTUAL camera (NDI Webcam Input, OBS, a vendor overlay): Chromium
// hands out the virtual one, it never produces a frame, and the surface sits empty — while the same
// physical camera works in the MediaPipe and calibration pickers, which have always had a device
// dropdown of their own (see plugins/mediapipe/src/poseCamera.ts, which says out loud that it owns
// its own stream so it "can pick a different camera"). Surfaces now pick too.
//
// Keyed by `SurfaceContent.cameraDeviceId ?? ''` — '' means "the default device", preserving the old
// behaviour byte-for-byte for every existing project. Refcounted by consumer key exactly as before,
// so N surfaces + timeline clips on one device still cost ONE capture, and it stops when the last
// one lets go.
// What a consumer asks of a camera. The format is `ideal`, never `exact` — see CameraFormat below.
interface CameraDemand {
  width?: number;
  height?: number;
  fps?: number;
  controls: Record<string, number | string>;
}
interface Cam {
  consumers: Set<string>;
  // The newest frame, when the track is read as VideoFrames rather than played into a <video>.
  // Exactly one is held at a time: a VideoFrame pins a decoder buffer, and leaking them stalls the
  // camera within a second or two, so the previous is closed the moment the next lands.
  frame: VideoFrame | null;
  pump: ReadableStreamDefaultReader<VideoFrame> | null;
  el: HTMLVideoElement | null;
  stream: MediaStream | null;
  // The live video track — the handle for BOTH halves of "expose the camera's parameters": its
  // getCapabilities() is what the inspector renders (so the control list comes from the device, not
  // from a hardcoded guess) and applyConstraints() is how a control lands without a reopen.
  track: MediaStreamTrack | null;
  caps: Record<string, unknown> | null; // capabilities, cached at open (static for a track's life)
  starting: boolean;
  // The merged demand of every consumer, and what the capture was last OPENED / CONSTRAINED with.
  // Kept apart so a reconcile can tell "nothing changed" from "reopen at another resolution" without
  // re-asking the device. `opened` records what was ASKED, not what was negotiated — comparing
  // against the negotiated value would reopen forever on any camera that rounds a request.
  want: CameraDemand;
  opened: string | null;   // formatKey(want) at the last successful open
  applied: string;         // JSON of the controls last pushed through applyConstraints
  // Why there is no picture, in words an operator can act on — surfaced in the content inspector.
  // A camera that fails used to be a console.error and nothing else, which is why "it's not working"
  // was the entire available diagnosis.
  error: string | null;
}
const cams = new Map<string, Cam>();
// What each consumer wants, so a reconcile can start what is newly wanted, stop what no longer is,
// and re-negotiate what merely changed. (Replaces the old `Set` of consumer keys — the device AND
// its format are now part of the demand.)
const cameraConsumers = new Map<string, { deviceId: string } & CameraDemand>();

const newCam = (): Cam => ({
  consumers: new Set(), frame: null, pump: null, el: null, stream: null, track: null, caps: null,
  starting: false, want: { controls: {} }, opened: null, applied: '{}', error: null,
});

const formatKey = (d: CameraDemand): string => `${d.width ?? 0}x${d.height ?? 0}@${d.fps ?? 0}`;

/**
 * Read the track as VideoFrames. getUserMedia still has to happen here on the main thread — it needs
 * the window's permission context, which is also why the main process grants 'media' — but a
 * MediaStreamTrackProcessor turns the result into a stream of VideoFrames instead of a <video> element
 * pretending to be a picture. That matters twice over: a VideoFrame is a CanvasImageSource the GPU path
 * takes directly, and the stream is transferable, so the day the engine moves to a worker the camera
 * can follow it without the DOM.
 *
 * Returns false when the API is unavailable, and the caller falls back to the <video> element.
 */
function startCameraProcessor(cam: Cam, track: MediaStreamTrack): boolean {
  const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
  if (!Ctor) return false;
  try {
    const reader = new Ctor({ track }).readable.getReader();
    cam.pump = reader;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cam.pump !== reader) { value?.close(); break; } // superseded by a restart — do not leak
          cam.frame?.close();
          cam.frame = value ?? null;
        }
      } catch { /* the track ended or was cancelled */ }
    })();
    return true;
  } catch (e) {
    console.warn('[contentSource] camera frame reader failed, using a <video>', (e as Error)?.message);
    return false;
  }
}

// Push the requested image controls at the live track. These go in `advanced`, which is best-effort
// by spec: a device that does not support one IGNORES it rather than failing the set, which is what
// makes it safe to send whatever the operator picked without re-checking it against capabilities.
// The whole bag is sent as ONE dict on purpose — `exposureTime` is meaningless unless
// `exposureMode: 'manual'` arrives with it, and split across two calls the device applies the first,
// reverts on the second, and the slider appears not to work.
// Key-ORDER-independent identity for a control bag. The same settings can arrive with their keys in
// different orders (a merge across surfaces vs. a spread during a drag), and a plain JSON compare
// would read that as a change and re-push the whole set at the device on every reconcile.
const controlsKey = (c: Record<string, number | string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a], [b]) => (a < b ? -1 : 1))));

function applyCameraControls(cam: Cam): void {
  const key = controlsKey(cam.want.controls);
  if (!cam.track || cam.applied === key) return;
  cam.applied = key;
  const entries = Object.entries(cam.want.controls);
  if (!entries.length) return; // nothing to assert; a control REMOVED is handled by a reopen
  void cam.track.applyConstraints({ advanced: [Object.fromEntries(entries)] } as MediaTrackConstraints)
    .catch((e) => console.warn('[contentSource] camera controls rejected', (e as Error)?.message));
}

/**
 * Push ONE control at the device immediately, without going through project state — the render-free
 * live channel a drag needs. Committing every pointer move into the document instead would re-render
 * the whole editor at pointer rate (App owns the state, and the tree is only partly memoized), which
 * is the documented way to make a slider feel broken. The inspector calls this on `onInput` and
 * commits the final value on `onChange`; the commit then reconciles to exactly this state and does
 * nothing, because `applied` already records it.
 */
export function previewCameraControl(deviceId: string, name: string, value: number | string): void {
  const cam = cams.get(deviceId);
  if (!cam?.track) return;
  const next = { ...cam.want.controls, [name]: value };
  cam.want = { ...cam.want, controls: next };
  cam.applied = controlsKey(next);
  void cam.track.applyConstraints({ advanced: [next] } as MediaTrackConstraints).catch(() => {});
}

/**
 * Open `deviceId` ('' = the OS default) at the merged demand, relaxing constraints on the way down.
 * The ladder is copied from the pose camera, which needed it for a real reason: a too-high `ideal`
 * can make Chromium negotiate a mode the device then fails to start (NotReadableError), and a bare
 * `{video:true}` on the last rung is also what rescues a project opened on ANOTHER MACHINE —
 * deviceIds are salted per browser profile, so a remembered id resolves to nothing there and `exact`
 * would throw OverconstrainedError. Falling back to the default beats going black; the reason is
 * recorded in `cam.error` so the inspector can say which camera it actually opened.
 *
 * ⚠ THE FORMAT IS ASKED AS `ideal`, DELIBERATELY. A webcam publishes ranges rather than a menu of
 * modes, and `exact` turns "this camera cannot do 4K" into a dead surface instead of the nearest
 * mode it can do. The cost is that the request and the result differ — which is why the inspector
 * reads the negotiated size back off the track and shows it.
 */
async function startCamera(deviceId: string): Promise<void> {
  const cam = cams.get(deviceId);
  if (!cam || cam.starting || cam.el || cam.pump) return;
  cam.starting = true;
  cam.error = null;
  const want = cam.want;
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const fps = want.fps ? { frameRate: { ideal: want.fps } } : {};
  const attempts: Array<MediaTrackConstraints | boolean> = [
    { ...dev, width: { ideal: want.width ?? 1280 }, height: { ideal: want.height ?? 720 }, ...fps },
    { ...dev, width: { ideal: 640 }, height: { ideal: 480 } },
    deviceId ? { deviceId: { exact: deviceId } } : true,
    true, // last resort: the default device, so a stale/foreign id still shows a picture
  ];
  try {
    let stream: MediaStream | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < attempts.length; i++) {
      // Don't spend the final default-device rung on a request that had no device pinned — rungs 1-3
      // already were the default, and retrying it a fourth time only delays the error.
      if (i === attempts.length - 1 && !deviceId) break;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: attempts[i], audio: false }); lastErr = null; if (i === attempts.length - 1) cam.error = 'That camera was not found — showing the default camera instead.'; break; }
      catch (e) {
        lastErr = e;
        const name = (e as DOMException)?.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') break; // a hard block; relaxing won't help
      }
    }
    if (!stream) throw lastErr ?? new Error('no camera');
    // Released while awaiting — the surface was retyped or deleted. Do not leave the light on, and
    // do not leave a consumer-less entry in `cams` claiming the device is open.
    if (cam.consumers.size === 0 || cams.get(deviceId) !== cam) {
      stream.getTracks().forEach((t) => t.stop());
      if (cams.get(deviceId) === cam) cams.delete(deviceId);
      return;
    }
    cam.stream = stream;
    cam.opened = formatKey(want);
    const track = stream.getVideoTracks()[0] ?? null;
    cam.track = track;
    // Capabilities are fixed for a track's life, so read them once. This is the list the inspector
    // renders: brightness/exposure/white-balance/zoom exist only if THIS camera says they do.
    cam.caps = (track?.getCapabilities?.() ?? null) as Record<string, unknown> | null;
    cam.applied = '{}';        // a fresh track is back at the device's own defaults
    applyCameraControls(cam);
    if (track && startCameraProcessor(cam, track)) return;
    // Fallback: play it into a <video> exactly as before.
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    await v.play();
    cam.el = v;
  } catch (e) {
    const err = e as DOMException;
    const name = err?.name ?? 'Error';
    cam.error =
      name === 'NotAllowedError' || name === 'SecurityError' ? 'Camera permission was denied.'
      : name === 'NotReadableError' ? 'The camera is in use by another program.'
      : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'That camera is not connected.'
      : `${name} — ${err?.message ?? String(e)}`;
    console.error(`[contentSource] camera ${deviceId || '(default)'} failed: ${name} — ${err?.message ?? String(e)}`);
  } finally {
    cam.starting = false;
  }
}

// `keepEntry` is the re-open case (a new resolution, or a control put back to auto): tear the capture
// down but leave the record, because startCamera reads its merged demand and its consumer set.
function stopCamera(deviceId: string, keepEntry = false): void {
  const cam = cams.get(deviceId);
  if (!cam) return;
  const reader = cam.pump;
  cam.pump = null;                 // makes the pump loop drop its next frame rather than store it
  void reader?.cancel().catch(() => {});
  cam.frame?.close();
  cam.frame = null;
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.el?.pause();
  cam.el = null;
  cam.track = null; cam.caps = null;
  cam.opened = null; cam.applied = '{}'; // a stopped device holds none of what we asked of it
  // Keep the entry only while something is still starting on it; otherwise the map is the truth about
  // what is open, and reconcileCamera reads it as such.
  if (!keepEntry && !cam.starting) cams.delete(deviceId);
}

// The video inputs this machine can offer, for the content inspector's picker. Labels are only
// populated once camera permission has been granted (the main process grants it, but Chromium still
// withholds labels until a capture has succeeded at least once), hence the numbered fallback.
export interface CameraDevice { deviceId: string; label: string }
export async function listCameras(): Promise<CameraDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

// What this device is doing right now, for the inspector: 'off' when nothing wants it. Lets the UI
// say "in use by another program" instead of showing an empty rectangle and no explanation, and —
// the other half of exposing a camera's parameters — hands over the device's OWN capability list so
// the inspector renders the controls this camera actually has, plus the settings it negotiated.
//
// `settings` is read LIVE rather than cached: it is the only honest answer to "what resolution am I
// actually getting", which routinely differs from what was asked (the format is requested as
// `ideal`, so a camera that cannot do 1080p60 quietly gives 1080p30 and nothing else would say so).
export interface CameraInfo {
  state: 'off' | 'starting' | 'live' | 'error';
  error: string | null;
  capabilities: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
}
export function getCameraInfo(deviceId: string): CameraInfo {
  const cam = cams.get(deviceId);
  if (!cam) return { state: 'off', error: null, capabilities: null, settings: null };
  const capabilities = cam.caps;
  const settings = (cam.track?.getSettings?.() ?? null) as Record<string, unknown> | null;
  if (cam.frame || cam.el) return { state: 'live', error: cam.error, capabilities, settings }; // `error` may hold the "fell back to the default" note
  if (cam.starting) return { state: 'starting', error: null, capabilities, settings };
  return { state: cam.error ? 'error' : 'starting', error: cam.error, capabilities, settings };
}

function dropMedia(key: string): void {
  const e = media.get(key);
  if (!e) return;
  if (e.type === 'VIDEO') e.el.pause();
  if (e.type === 'IMAGE') e.bmp?.close(); // GPU-side memory; GC will not hurry to reclaim it
  if (e.type === 'CODEC') releaseCodec(e.codecId, e.path, key); // shared per path — close only on the last user
  media.delete(key);
}

// Bring this key's per-instance <video>/<img> in line with its content (no-op for live/effect types).
function reconcileMedia(key: string, content: SurfaceContent): void {
  if (content.type === SourceType.VIDEO && content.url) {
    const e = media.get(key);
    const curUrl = e ? (e.type === 'CODEC' ? e.path : e.type === 'VIDEO' ? e.url : null) : null;
    if (curUrl === content.url) return;
    if (e?.type === 'VIDEO') e.el.pause();
    if (e?.type === 'CODEC') releaseCodec(e.codecId, e.path, key); // retyped away — drop this key's claim
    const url = content.url;
    const codec = videoCodecRegistry.forPath(url); // a plugin decoder claims this file (e.g. HAP .mov)
    if (codec) {
      // Optimistically use the codec; its probe downgrades to a normal <video> if it isn't (e.g. an
      // H.264 .mov that isn't HAP).
      media.set(key, { type: 'CODEC', codecId: codec.id, path: url });
      retainCodec(url, key, codec.id);
      void codec.openSurface(url).then((ok) => {
        if (ok) return;
        const cur = media.get(key);
        if (cur && cur.type === 'CODEC' && cur.path === url) {
          releaseCodec(codec.id, url, key); // not decodable by this codec → hand the file to a <video>
          media.set(key, { type: 'VIDEO', el: makeVideo(url), url });
        }
      });
    } else {
      media.set(key, { type: 'VIDEO', el: makeVideo(url), url });
    }
  } else if (content.type === SourceType.IMAGE && content.url) {
    const e = media.get(key);
    if (!e || e.type !== 'IMAGE' || e.url !== content.url) {
      if (e?.type === 'IMAGE') e.bmp?.close(); // replacing one image with another: close the old bitmap
      // makeImage's decode is async, so it always resolves after this synchronous set() — by which
      // point its "am I still the entry at this key" check has something real to compare against.
      media.set(key, makeImage(key, content.url));
    }
  } else {
    dropMedia(key); // not a media-instance type for this key anymore
  }
}

function reconcileCamera(): void {
  // Demand, grouped by device — the set of consumer keys per device is what makes "the last surface
  // let go" a computable event rather than a global count.
  //
  // ONE CAPTURE SERVES EVERY CONSUMER OF A DEVICE, so their demands MERGE rather than compete:
  //   · size and rate take the largest anyone asked for — a bigger capture serves a smaller consumer
  //     exactly as well (sampling is by UV, not by pixel count), while the reverse would starve it;
  //   · image controls are last-writer-wins in SURFACE-ID ORDER, because a camera physically has one
  //     exposure. The alternative — a second capture of the same device — is refused outright by
  //     most drivers, so there is no arrangement in which two surfaces get two exposures.
  // Sorted iteration is what makes that deterministic: an unordered merge would resolve differently
  // between reconciles and the camera would reopen in a loop.
  const want = new Map<string, { keys: Set<string>; demand: CameraDemand }>();
  for (const key of [...cameraConsumers.keys()].sort()) {
    const req = cameraConsumers.get(key)!;
    let e = want.get(req.deviceId);
    if (!e) want.set(req.deviceId, (e = { keys: new Set(), demand: { controls: {} } }));
    e.keys.add(key);
    const d = e.demand;
    if (req.width) d.width = Math.max(d.width ?? 0, req.width);
    if (req.height) d.height = Math.max(d.height ?? 0, req.height);
    if (req.fps) d.fps = Math.max(d.fps ?? 0, req.fps);
    Object.assign(d.controls, req.controls);
  }
  for (const id of [...cams.keys()]) if (!want.has(id)) stopCamera(id);
  for (const [id, e] of want) {
    let cam = cams.get(id);
    if (!cam) cams.set(id, (cam = newCam()));
    cam.consumers = e.keys;
    cam.want = e.demand;
    // `pump` counts as "running" alongside `el`: on the VideoFrame path there is no element, and
    // asking whether the camera is up by looking only for one would re-enter startCamera on every
    // reconcile. A device that has already FAILED is not retried here either — a dead camera would
    // otherwise re-ask on every surface edit; `retryCamera` is the deliberate way back.
    const running = !!(cam.el || cam.pump);
    if (cam.starting) continue;
    if (!running) { if (!cam.error) void startCamera(id); continue; }
    // A format change needs a new track. So does a control REMOVED: applyConstraints can set a
    // value but has no way to say "forget it and go back to auto", so the only honest reset is to
    // re-open the device. Compare against what was APPLIED, not against the last demand — that is
    // the record of what the device is actually holding.
    const applied = JSON.parse(cam.applied || '{}') as Record<string, unknown>;
    const dropped = Object.keys(applied).some((k) => !(k in e.demand.controls));
    if (cam.opened !== formatKey(e.demand) || dropped) { stopCamera(id, true); void startCamera(id); continue; }
    applyCameraControls(cam);
  }
}

// Re-open a device that failed (the operator plugged it back in, or quit the program holding it).
export function retryCamera(deviceId: string): void {
  const cam = cams.get(deviceId);
  if (!cam || cam.starting) return;
  cam.error = null;
  if (cam.consumers.size > 0) void startCamera(deviceId);
}
// Loopback DMX-in universes: the legacy 0-7 range (casual/external senders) PLUS every universe a
// patched fixture touches (so a back rig on sACN universe 8+ is mirrored). Derived from fixtures by
// Stage; strictly additive to the old fixed [0..7] set → non-regressing. This only widens sACN's joined
// multicast groups (Art-Net binds one UDP port and was never per-universe-limited).
const DEFAULT_DMX_UNIVERSES = [0, 1, 2, 3, 4, 5, 6, 7];
let dmxUniverses: number[] = DEFAULT_DMX_UNIVERSES;
export function setDmxInputUniverses(universes: number[]): void {
  const next = Array.from(new Set([...DEFAULT_DMX_UNIVERSES, ...universes])).sort((a, b) => a - b);
  if (next.length === dmxUniverses.length && next.every((u, i) => u === dmxUniverses[i])) return;
  dmxUniverses = next;
  if (dmxActive) window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: dmxUniverses }); // re-join live
}

function reconcileDmx(): void {
  const want = dmxConsumers.size > 0;
  if (want === dmxActive) return;
  dmxActive = want;
  if (want) { window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: dmxUniverses }); startInput(); }
  else { window.artlux?.configureInput?.({ enabled: false, protocol: 'both', universes: [] }); stopInput(); }
}

// Declare that `key` wants `content` live this frame. Idempotent — safe to call every sync; the
// receiver reconcilers only start/stop on an actual change.
export function acquire(key: string, content: SurfaceContent): void {
  reconcileMedia(key, content);
  if (content.type === 'EFFECT') { if (!effects.has(key)) effects.set(key, new SurfaceEffect()); }
  else effects.delete(key);

  // The device AND its format travel with the demand: re-pointing a surface at another camera, or at
  // another resolution, is just a different value here, and reconcileCamera works out whether that
  // means opening a device, dropping one, re-opening at a new format, or pushing a control live.
  if (content.type === SourceType.CAMERA) {
    cameraConsumers.set(key, {
      deviceId: content.cameraDeviceId ?? '',
      width: content.cameraWidth, height: content.cameraHeight, fps: content.cameraFps,
      controls: content.cameraControls ?? {},
    });
  } else cameraConsumers.delete(key);
  if (content.type === SourceType.DMX_IN) dmxConsumers.add(key); else dmxConsumers.delete(key);

  // Plugin-contributed content sources (e.g. Spout, NDI, TRACKING): hand the key to the matching
  // provider, drop it from the rest (mirrors the per-type add/delete discipline above).
  for (const p of contentSourceRegistry.all()) {
    if (content.type === p.type) p.acquire?.(key, content); else p.release?.(key);
  }

  reconcileCamera(); reconcileDmx();
}

// Drop everything `key` was holding (instance element + receiver refcounts + tracking canvas).
export function release(key: string): void {
  dropMedia(key);
  effects.delete(key);
  cameraConsumers.delete(key); dmxConsumers.delete(key);

  for (const p of contentSourceRegistry.all()) p.release?.(key);
  reconcileCamera(); reconcileDmx();
}

// Global transport toggle — applies to <video> elements + the camera (live receivers ignore it).
export function setPlaying(p: boolean): void {
  playing = p;
  for (const e of media.values()) if (e.type === 'VIDEO') { if (p) e.el.play().catch(() => {}); else e.el.pause(); }
  for (const cam of cams.values()) if (cam.el) { if (p) cam.el.play().catch(() => {}); else cam.el.pause(); }
  for (const c of videoCodecRegistry.all()) c.setPlaying(p);
}

// Drawable for `key`'s content this frame, or null if not ready. `timeSec` drives generative EFFECT
// content. LAYER is handled by the caller.
//
// ⚠ `timeSec` IS A TRANSPORT TIME. IT USED TO BE WALL TIME FOR SURFACES, AND THIS COMMENT SAID SO.
//
// It read: *"clip-local for timeline clips, wall-clock for surfaces"* — and the wall-clock half was the
// bug, not the contract. A surface's effect was handed `performance.now()/1000`, so it NEVER READ THE
// TRANSPORT: pausing the show did not freeze the picture, a seek did not move it, and each window ran its
// own epoch, so the operator's preview and the audience's projector sat at different phases *permanently*.
// Fixed 2026-07-14 (`surfaceMedia.ts`): a surface's effect now rides the **SHOW clock** — pause freezes it,
// a seek scrubs it, Stop resets it, and a scene recall does NOT restart it (an ambient background belongs
// to the show, exactly like the audio bed).
//
// ⚠⚠ AND THIS IS A PLUGIN-FACING CONTRACT, WHICH IS WHY IT MATTERS MORE THAN AN INTERNAL COMMENT.
// `getDrawable` is the `ContentSourceProvider` API (see the registry below): the meaning of the `timeSec`
// a third-party provider receives changed from wall time to show time. Any provider that assumed a
// monotonic, never-pausing clock — and the old comment told them to — is now wrong in a way nothing will
// warn them about. Callers:
//   · timeline clips  → clip-local time (unchanged)
//   · surfaces        → the SHOW clock (`timeline.getShowTime()`), NOT wall time
// It is currently documented nowhere else; docs/SDK.md and docs/PLUGINS.md describe getDrawable without
// naming a clock at all. They should.
export function getDrawable(key: string, content: SurfaceContent, timeSec: number): Drawable | null {
  switch (content.type) {
    case SourceType.VIDEO: {
      const e = media.get(key);
      if (!e) return null;
      if (e.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.surfaceFrame(e.path) ?? null;
      return e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el : null;
    }
    case SourceType.IMAGE: {
      const e = media.get(key);
      return e && e.type === 'IMAGE' ? e.bmp : null; // null until the decode lands
    }
    case SourceType.CAMERA: {
      // The VideoFrame path when it is running, otherwise the <video> fallback.
      const cam = cams.get(content.cameraDeviceId ?? '');
      if (!cam) return null;
      return cam.frame ?? (cam.el && cam.el.readyState >= 2 ? cam.el : null);
    }
    case SourceType.DMX_IN:
      return getInputCanvas();
    case 'EFFECT': {
      let e = effects.get(key);
      if (!e) { e = new SurfaceEffect(); effects.set(key, e); }
      return e.render(content, timeSec);
    }
    default: {
      const p = contentSourceRegistry.get(content.type); // plugin-contributed type, else NONE / LAYER
      return p ? p.getDrawable(key, content, timeSec) : null;
    }
  }
}

// A value that changes only when `key`'s drawable holds NEW pixels, or undefined when that can't be
// known (live receivers, effects, plugin sources) — undefined means "assume it changed". Lets a
// consumer that pays per frame skip repeats; see VideoCodecContribution.surfaceGeneration.
export function getDrawableGeneration(key: string, content: SurfaceContent): number | undefined {
  if (content.type !== SourceType.VIDEO) return undefined;
  const e = media.get(key);
  if (!e) return undefined;
  if (e.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.surfaceGeneration?.(e.path);
  // A <video> element advances continuously; currentTime is its natural frame identity. Paused or
  // stalled playback repeats the same value, which is exactly what we want to detect.
  return e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el.currentTime : undefined;
}

// Natural aspect ratio (w/h) of `key`'s content once loaded, or null if unknown / not applicable.
export function getAspect(key: string, content: SurfaceContent): number | null {
  switch (content.type) {
    case SourceType.IMAGE: {
      const e = media.get(key);
      return e && e.type === 'IMAGE' && e.bmp && e.bmp.height > 0 ? e.bmp.width / e.bmp.height : null;
    }
    case SourceType.VIDEO: {
      const e = media.get(key);
      if (e?.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.aspect(e.path) ?? null;
      return e && e.type === 'VIDEO' && e.el.videoWidth > 0 ? e.el.videoWidth / e.el.videoHeight : null;
    }
    case SourceType.CAMERA: {
      const cam = cams.get(content.cameraDeviceId ?? '');
      if (!cam) return null;
      if (cam.frame && cam.frame.displayHeight > 0) return cam.frame.displayWidth / cam.frame.displayHeight;
      return cam.el && cam.el.videoWidth > 0 ? cam.el.videoWidth / cam.el.videoHeight : null;
    }
    default: {
      const p = contentSourceRegistry.get(content.type);
      return p?.getAspect ? p.getAspect(key, content) : null;
    }
  }
}
