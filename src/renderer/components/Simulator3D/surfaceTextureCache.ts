import * as THREE from 'three';
import { getDrawable, getDrawableGeneration, getSurface } from '../../services/surfaceMedia';
import { matchBitmapOrientation } from './bitmapFlip';

// ONE GPU TEXTURE PER SURFACE, NOT PER MESH.
//
// useSurfaceTexture built a private THREE.Texture inside every consumer, so a surface shown on three
// venue meshes was uploaded to the GPU three times per frame, each at the source's full resolution — a
// 1080p clip on three screens is ~18 MB/frame of pure duplication. The frames are identical; only the
// consumers differ. So the texture belongs to the SURFACE and the consumers borrow it.
//
// WHY NOT THE PIXEL MAPPER'S ATLAS, which already holds these frames on the GPU: it only contains
// surfaces that have LED fixtures linked to them (`surfaceOrder` is filtered exactly that way). A venue
// screen carrying video with no LEDs on it — the ordinary projection-mapping case — is not in it. Adding
// those surfaces would grow the atlas and put a per-frame CPU composite of them into the ENGINE's hot
// path, so a viewport nobody may have open would slow the show down. The viewport pays for the viewport.
//
// REFCOUNTED, because a texture outliving its last consumer is a leak and one released early goes black
// on the meshes still showing it. Release is what disposes.

interface Entry {
  tex: THREE.Texture;
  /** Consumers currently holding this key. */
  users: Set<string>;
  /** `getDrawableGeneration` at the last upload — undefined means "the source cannot say". */
  lastGen: number | undefined;
  /** Frame stamp of the last upload, so N consumers cost ONE upload per frame. */
  stamp: number;
  /** The <video> this entry is bound to, if any — a VideoTexture is a different kind of binding. */
  video: HTMLVideoElement | null;
}

const entries = new Map<string, Entry>();

// Advanced once per animation frame by whoever asks first. A shared counter rather than a per-consumer
// flag: the point is that the SECOND consumer in a frame does no work, and it can only know that by
// comparing against something global.
let frameStamp = 0;
let lastRaf = -1;
function stampNow(): number {
  // performance.now() quantised to the frame is enough: two consumers in one frame see the same value,
  // and any real frame boundary changes it. No rAF of our own — this module must not start a loop.
  const t = Math.floor(performance.now());
  if (t !== lastRaf) { lastRaf = t; frameStamp++; }
  return frameStamp;
}

/**
 * Borrow the texture for `surfaceId`. Returns null when the surface has nothing to show. Safe to call
 * every frame from every consumer: the upload happens at most once per surface per frame, and is
 * skipped entirely when the source reports it has no new pixels.
 */
export function acquireSurfaceTexture(surfaceId: string, consumer: string): THREE.Texture | null {
  const s = getSurface(surfaceId);
  const d = s ? getDrawable(s) : null;
  if (!d) { releaseSurfaceTexture(surfaceId, consumer); return null; }

  let e = entries.get(surfaceId);

  if (d instanceof HTMLVideoElement) {
    // A <video> gets a VideoTexture, whose identity must stay pinned to that element.
    if (!e || e.video !== d) {
      e?.tex.dispose();
      const t = new THREE.VideoTexture(d);
      t.colorSpace = THREE.SRGBColorSpace;
      e = { tex: t, users: e?.users ?? new Set(), lastGen: undefined, stamp: -1, video: d };
      entries.set(surfaceId, e);
    }
    e.users.add(consumer);
    // VideoTexture is uploaded by the browser; flagging it once per frame is the whole cost.
    const st = stampNow();
    if (e.stamp !== st) { e.stamp = st; e.tex.needsUpdate = true; }
    return e.tex;
  }

  if (!e || e.video) {
    e?.tex.dispose();
    const t = new THREE.Texture();
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    e = { tex: t, users: e?.users ?? new Set(), lastGen: undefined, stamp: -1, video: null };
    entries.set(surfaceId, e);
  }
  e.users.add(consumer);

  const st = stampNow();
  if (e.stamp === st) return e.tex;   // another consumer already did this frame's work
  e.stamp = st;

  // SKIP REPEATS. A canvas-backed source hands back the same canvas every frame and only repaints when
  // its decoder advances, but `needsUpdate` re-uploads regardless — so a 25 fps clip paid a full
  // upload at display rate. undefined means the source cannot say, so assume it changed.
  const gen = getDrawableGeneration(s!);
  if (gen !== undefined && gen === e.lastGen) return e.tex;
  e.lastGen = gen;

  e.tex.image = d as unknown as HTMLImageElement;
  matchBitmapOrientation(e.tex);   // bitmapFlip.ts stays the one owner of the flip rule
  e.tex.needsUpdate = true;
  return e.tex;
}

/** Give back a borrowed texture. Disposes only when the last consumer lets go. */
export function releaseSurfaceTexture(surfaceId: string, consumer: string): void {
  const e = entries.get(surfaceId);
  if (!e) return;
  e.users.delete(consumer);
  if (e.users.size > 0) return;
  e.tex.dispose();
  entries.delete(surfaceId);
}

/** Live entry count — for tests and the perf panel, so the dedup is observable rather than assumed. */
export function surfaceTextureCount(): number { return entries.size; }
