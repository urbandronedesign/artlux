// THE LIVE CHANNEL — what travels between a client window and the ENGINE OWNER (E5/W4).
//
// The Show Host carries the DOCUMENT (classes 1–2 in plans/native-engine.md §9a). This carries the three
// other classes, which must never go through the host because they are either per-frame or pixels:
//
//   3. live streams   — DMX levels, perf numbers, anything a panel watches move. PULL-BASED: the owner
//                       sends a subscription ONE sample, then nothing until the client says `pull`. A
//                       client pulls from its own requestAnimationFrame, so the rate is that window's
//                       display refresh, a hidden window (rAF paused) pulls nothing, and an owner that
//                       produces faster than a client draws never queues a backlog.
//   4. the clock      — NOT streamed. An ANCHOR (position, playing, wall time) is sent when the transport
//                       stops agreeing with the last one: a seek, a pause, a loop wrap, a drift. Between
//                       anchors every window computes the playhead itself from the shared wall clock.
//                       Zero per-frame traffic.
//   5. panel pixels   — thumbnails and audio peaks, produced ONCE by the owner's existing caches and
//                       answered per request. The client never decodes.
//
// Plus the LIVE DRAG: a slider in another window drives services/livePreview in the owner directly,
// exactly as a slider in the editor does, and commits through the host on release like any edit.
//
// The engine owner is the editor renderer until the native engine exists (E1); then it is the engine
// and this file is the contract it has to keep. Main only pairs the two ends (src/main/liveHub.ts) and is
// out of the path afterwards — the projector-bridge pattern.
//
// NO IMPORTS, ON PURPOSE: the editor, panel windows and (later) the engine bridge all read it.

/** A position on both of the timeline's clocks, true at wall time `at`. */
export interface ClockAnchor {
  /** The scene clock (the bound document's playhead), seconds, at `at`. */
  playhead: number;
  /** The show clock (the global bed's time), seconds, at `at`. */
  showTime: number;
  /** The transport's play state, for a play button. NOT what extrapolation uses — see the rates. */
  playing: boolean;
  /**
   * 1 = the scene clock advances one second per wall second from `at`, 0 = it holds. Separate from
   * `playing` because a playing transport can hold: parked on the last frame of a non-looping scene, or
   * in an underrun. And separate per clock because the two hold independently — the scene parks at
   * its end while the show clock (the bed) runs on.
   */
  playheadRate: 0 | 1;
  /** The same for the show clock. */
  showRate: 0 | 1;
  /**
   * Wall time this anchor is true at, in WALL MILLISECONDS (`wallNow()`), not `performance.now()`:
   * each window's `performance.now()` counts from its own navigation start, so two windows' readings
   * of it are not comparable. `timeOrigin + now()` is, to well under a millisecond on one machine.
   */
  at: number;
  /**
   * True while an offline render (a bake) owns the render clock. The show then moves at bake speed,
   * not wall speed, so a client must not extrapolate: it shows the anchored numbers as they are.
   */
  offline: boolean;
  /** Increases with every anchor, so a client can tell a new one from a repeat. */
  rev: number;
}

/** Fixture-channel and brightness drags a client can drive in the owner. */
export type LiveDrag =
  | { target: 'ledBrightness'; value: number; end?: boolean }
  | { target: 'projectorBrightness'; value: number; end?: boolean }
  | { target: 'fixtureChannel'; fixtureId: string; key: string; value: number; end?: boolean };

export type LiveClientMsg =
  | { t: 'hello'; label: string }
  /** Start a stream. The owner answers with one `data` as soon as it has a sample. */
  | { t: 'sub'; id: number; stream: string; params?: unknown }
  | { t: 'unsub'; id: number }
  /** "I have drawn your last sample; send the next one when there is a new one." */
  | { t: 'pull'; id: number }
  /** Ask for clock anchors. Off by default: a window with no time display needs none. */
  | { t: 'clock'; on: boolean }
  | { t: 'thumb'; req: number; path: string; time: number }
  | { t: 'peaks'; req: number; path: string; buckets: number }
  | ({ t: 'drag' } & LiveDrag);

export type LiveOwnerMsg =
  | { t: 'welcome'; clientId: number; streams: string[] }
  | { t: 'data'; id: number; value: unknown; gen: number }
  /** The stream does not exist (or went away): the subscription is over. */
  | { t: 'gone'; id: number }
  | { t: 'clock'; anchor: ClockAnchor }
  /** `bitmap` null = nothing to show for this path (unreadable, or not decodable in time). */
  | { t: 'thumb'; req: number; bitmap: ImageBitmap | null }
  | { t: 'peaks'; req: number; peaks: Float32Array | null; duration: number | null };

/**
 * Wall milliseconds, comparable ACROSS PROCESSES on one machine. Both browser windows and Node have
 * `performance.timeOrigin` (the epoch time their `performance.now()` counts from).
 */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Where the two clocks are at wall time `wall`, from an anchor. Pure: the one extrapolation rule. */
export function clockAt(a: ClockAnchor, wall: number): { playhead: number; showTime: number } {
  if (a.offline) return { playhead: a.playhead, showTime: a.showTime };
  const dt = Math.max(0, wall - a.at) / 1000;
  return { playhead: a.playhead + a.playheadRate * dt, showTime: a.showTime + a.showRate * dt };
}

/**
 * How far the owner's real clock may drift from what clients extrapolate before a new anchor is sent.
 * One millisecond is far under a frame at any refresh rate, and far over float noise; a real event (a
 * seek, a wrap, a pause) moves the clock by much more than this, so it always produces an anchor.
 */
export const CLOCK_TOLERANCE_SEC = 0.001;
