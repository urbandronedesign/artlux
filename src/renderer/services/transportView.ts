// THE TRANSPORT, AS THE TIMELINE PANEL READS AND NUDGES IT (E5 — the detached timeline) — the camera seam's
// pattern. The timeline draws the playhead and the bed's clock every frame, seeks, stops, and shows when the
// bound scene is held at its end. All of that is the transport's (services/timeline), which runs in the
// EDITOR only and is banned from a panel window: a window importing it would read its own idle copy — a
// playhead stuck at 0 — or run a second transport. So the timeline asks THIS module:
//
//   EDITOR — live/editorAccess.ts installs the transport itself: exactly what the panel read before.
//   WINDOW — live/transportRemote.ts installs the live channel: the editor's CLOCK ANCHORS (both clocks
//            extrapolated here from the last anchor, so no message per frame — shared/liveProtocol.ts
//            clockAt) and the editor's `transport.*` calls.
//
// The state machine half (current state, fired edges, trigger / enter) is services/showMachineLive.
// This module imports nothing that runs.

export interface TransportView {
  /** The bound document's playhead, seconds, now. */
  getPlayhead(): number;
  /** The show clock (the global bed's time), seconds, now. */
  getShowTime(): number;
  /** Called with the playhead every frame the clock moves (and once on a seek). */
  subscribe(cb: (playhead: number) => void): () => void;
  seek(t: number): void;
  /** The transport's Stop (rewind + pause), decided in the editor. */
  stop(): void;
  /** Is the bound scene parked on its last frame ("hold at end")? */
  isBoundHeld(): boolean;
}

// Until something installs itself this answers "a stopped transport at 0", the truth for a window that has
// neither the transport nor a link to the editor.
let view: TransportView = {
  getPlayhead: () => 0,
  getShowTime: () => 0,
  subscribe: () => () => {},
  seek: () => {},
  stop: () => {},
  isBoundHeld: () => false,
};
export function setTransportView(v: TransportView): void { view = v; }

export const transportView: TransportView = {
  getPlayhead: () => view.getPlayhead(),
  getShowTime: () => view.getShowTime(),
  subscribe: (cb) => view.subscribe(cb),
  seek: (t) => view.seek(t),
  stop: () => view.stop(),
  isBoundHeld: () => view.isBoundHeld(),
};
