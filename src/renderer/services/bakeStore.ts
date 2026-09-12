// WHICH SURFACES ARE PLAYING A PRE-RENDERED FILE INSTEAD OF COMPUTING THEMSELVES.
//
// ⚠ READ THIS BEFORE CHANGING WHERE A BAKE LIVES. The obvious design is to swap `Surface.content` to
// the rendered file and remember the original. It cannot work, and it fails silently:
//
//   · a Scene captures `surfaces` — placement AND content (docs/SCENES.md);
//   · unlike fixtures, which get a look/rig allow-list, surfaces are restored WHOLESALE
//     (`setSurfaces(scene.surfaces)` in App, and services/sceneLook says so in as many words);
//   · the state machine recalls a scene on entering EVERY state, including its initial one, on load.
//
// So a swapped surface reverts to the shader within seconds of opening the project, with no dialog and
// no undo record — an FSM recall passes no `origin`, so nothing is even written to history. The bake
// would simply never play, and nothing would say why.
//
// The rule this codebase already has for exactly this is "project-scope data must not ride a look
// snapshot" — it is why `assets`, `groups`, `trackingZones` and `projectorOutputs` are not captured. A
// bake is an asset plus a binding, so it belongs in that category: `ProjectData.bakes`, never in
// `content`. Scenes, cues, the FSM and OSC recalls then cannot fight it, and NO SCENE NEEDS
// RE-CAPTURING after a render.
//
// The fingerprint is what makes one project-scope list behave per-scene: a surface that is a shader in
// scene A and a video in scene B matches in A and does not in B, so the bake applies exactly where it
// describes the content and nowhere else. It is also the staleness test — edit the shader and the
// signature stops matching, so the bake steps aside instead of showing yesterday's picture.

import type { BakeEntry } from '../../../shared/protocol';
import { SourceType, type Surface, type SurfaceContent } from '../types';
import { videoCodecRegistry } from '../host/registries';
import * as codecResidency from './codecResidency';
import * as matteGL from '../gpu/matteGL';

/** Live entries by surface id. Rebuilt whenever the document's `bakes` array changes. */
let bySurface = new Map<string, BakeEntry>();
/** Paths this module has claimed a decoder for, so it can hand them back. */
const claimed = new Set<string>();

const owner = (e: BakeEntry): string => `bake:${e.id}`;

/**
 * A stable description of WHAT WAS RENDERED, cheap enough to compute per frame. The caller passes timeline.activePoolKey() as docKey.
 *
 * Only the fields that change the pictures. Notably NOT `x/y/width/height/rotation/zIndex/opacity`:
 * a bake captures a surface's CONTENT, not its placement, so moving or fading the surface must not
 * invalidate the render — the operator would have no idea why it stopped applying.
 *
 * `docKey` is folded in for timeline-fed content because track ids are minted per scene
 * (`defaultTimeline()` has no layers), so the same `layerId` means different material in different
 * scenes. Without it a bake made in one scene would claim a same-named track in another.
 */
export function signatureOf(content: SurfaceContent, docKey: string): string {
  const c = content as unknown as Record<string, unknown>;
  const parts: unknown[] = [content.type];
  // The fields that decide what a source draws. Listed rather than JSON-stringifying the whole object
  // because that would include per-session junk and make every signature differ on reload.
  for (const k of [
    'url', 'layerId', 'layerIds', 'bgLayerId', 'sliceOf', 'sliceRect',
    'effectId', 'paletteId', 'speed', 'intensity',
    'shaderId', 'shaderSource', 'shaderGraph', 'shaderParams',
    'textBody', 'textFont', 'textFontAsset', 'textSize', 'textTracking', 'textAlign', 'textColor',
  ]) {
    if (c[k] !== undefined) parts.push(k, c[k]);
  }
  const timelineFed = content.type === SourceType.LAYER || content.type === SourceType.PROGRAM;
  if (timelineFed) parts.push('doc', docKey);
  return JSON.stringify(parts);
}

/**
 * Replace the live set. Called by App whenever `ProjectData.bakes` changes (load, render, bypass,
 * delete) — the document stays the source of truth and this is only the frame path's view of it.
 */
export function setEntries(entries: readonly BakeEntry[] | undefined): void {
  const next = new Map<string, BakeEntry>();
  for (const e of entries ?? []) if (e && e.surfaceId && e.path) next.set(e.surfaceId, e);
  // Hand back decoders for files that are no longer referenced, or the render's output would stay
  // resident for the life of the app after the operator deleted the bake.
  const wanted = new Set<string>();
  for (const e of next.values()) { wanted.add(e.path); if (e.mattePath) wanted.add(e.mattePath); }
  for (const path of [...claimed]) {
    if (wanted.has(path)) continue;
    const codec = videoCodecRegistry.forPath(path);
    for (const e of bySurface.values()) if (e.path === path || e.mattePath === path) {
      codecResidency.release(path, owner(e));
      matteGL.release(`bake:${e.id}`);
    }
    codec?.releaseLayer(`bake:${path}`);
    claimed.delete(path);
  }
  bySurface = next;
}

export function entryFor(surfaceId: string): BakeEntry | undefined { return bySurface.get(surfaceId); }
export function all(): BakeEntry[] { return [...bySurface.values()]; }

/**
 * Does this surface have a bake that is ENABLED, NOT STALE, and covers `timeSec`?
 *
 * Three separate reasons to decline and they mean different things to an operator, which is why the
 * caller can ask for the reason rather than only for a picture.
 */
export function statusFor(s: Surface, timeSec: number, docKey: string):
  | { state: 'none' }
  | { state: 'bypassed' | 'stale' | 'out-of-range'; entry: BakeEntry }
  | { state: 'live'; entry: BakeEntry } {
  const e = bySurface.get(s.id);
  if (!e) return { state: 'none' };
  if (!e.enabled) return { state: 'bypassed', entry: e };
  if (e.contentSig !== signatureOf(s.content, docKey)) return { state: 'stale', entry: e };
  if (timeSec < e.startSec || timeSec >= e.endSec) return { state: 'out-of-range', entry: e };
  return { state: 'live', entry: e };
}

/**
 * The baked picture for this surface at `timeSec`, or null to fall through to the live content.
 *
 * ⚠ ADDRESSED BY TIME, NOT PLAYED. It goes through the codec's LAYER path — the seekable one — with
 * the bake's own key, so the file is locked to the clock the render was made against. The ordinary
 * SURFACE path would have been simpler and wrong: it runs a free clock of its own, so a render made
 * to sit exactly under a show would drift away from it within a minute, which is the very thing the
 * whole feature exists to avoid.
 *
 * Falls back to null (and therefore to the live content) when no codec claims the file — an operator
 * who has turned GPU MP4 decode off gets their shader back rather than a black surface.
 */
export function drawableFor(s: Surface, timeSec: number, docKey: string): CanvasImageSource | null {
  const st = statusFor(s, timeSec, docKey);
  if (st.state !== 'live') return null;
  const e = st.entry;
  const codec = videoCodecRegistry.forPath(e.path);
  if (!codec) return null;
  if (!claimed.has(e.path)) {
    claimed.add(e.path);
    codecResidency.retain(e.path, owner(e), codec.id);
  }
  const t = timeSec - e.startSec;
  const colour = codec.layerFrame(`bake:${e.path}`, e.path, t);
  if (!e.mattePath) return colour;

  // ── A TRANSPARENT BAKE IS TWO VIDEOS ─────────────────────────────────────────────────────────
  // Both are addressed at the SAME clip time, from their own decoders, and recombined on the GPU.
  // If either is missing this frame, fall through to the live content rather than show the colour
  // video alone: that would be the surface with its transparency silently filled in with black, over
  // whatever is beneath it — which reads as a rendering fault, not as a frame that was not ready.
  const matteCodec = videoCodecRegistry.forPath(e.mattePath);
  if (!matteCodec) return null;
  if (!claimed.has(e.mattePath)) {
    claimed.add(e.mattePath);
    codecResidency.retain(e.mattePath, owner(e), matteCodec.id);
  }
  const matte = matteCodec.layerFrame(`bake:${e.mattePath}`, e.mattePath, t);
  if (!colour || !matte) return null;
  return matteGL.combine(`bake:${e.id}`, colour, matte, e.width, e.height);
}
