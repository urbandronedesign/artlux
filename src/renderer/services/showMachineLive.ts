// THE RUNNING SHOW MACHINE, AS THE STATE GRAPH READS AND NUDGES IT (E5/W5i) — the camera seam's pattern.
// The graph draws a ring round the CURRENT state and pulses an edge when it FIRES, and lets the operator
// fire a transition (Ctrl+click) or jump to a state (double-click). All four are the transport's
// (services/timeline), which runs in the editor only and is banned from a panel window.
//
// The editor installs the transport itself (live/editorAccess.ts); a panel window installs the live
// channel ('sm.state', 'sm.fired', and the 'sm.trigger' / 'sm.enter' calls — live/oscRemote.ts).
// This module imports nothing that runs.
export interface ShowMachineLive {
  /** The current state id, now and on every change. */
  subscribeState(cb: (id: string | null) => void): () => void;
  /** A transition just fired (for the edge pulse). */
  subscribeFired(cb: (transitionId: string) => void): () => void;
  triggerTransition(id: string): void;
  enterState(id: string): void;
}
let live: ShowMachineLive = { subscribeState: () => () => {}, subscribeFired: () => () => {}, triggerTransition: () => {}, enterState: () => {} };
export function setShowMachineLive(m: ShowMachineLive): void { live = m; }
export function showMachineLive(): ShowMachineLive { return live; }
