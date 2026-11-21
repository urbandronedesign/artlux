// THE TAKE RECORDER, AS THE TAKES DOCKS READ AND DRIVE IT (E5/W5j) — the camera seam's pattern.
//
// Recording is the editor's: the lighting recorder samples the rig's resolved state every frame, the
// tracking recorder taps the LiDAR feed, and both write into the editor's document (services/takeRecorder).
// A panel window must neither record (a second recorder of an idle copy) nor show its own idle state (a
// Record button that never turns red while the editor is recording). So the docks go through this:
//
//   EDITOR  — live/editorAccess.ts installs the recorder, the tracking store and the orphan-takes scan.
//   WINDOW  — live/takesRemote.ts installs the live channel: the 'takes.state' stream (recording flags,
//             elapsed, live blob count, orphan files — sent on a change, and once a second while
//             recording) and a 'takes.*' call per command.
//
// This module imports nothing that runs.

export type TakeKind = 'lighting' | 'tracking';
export interface RecState { lighting: boolean; tracking: boolean }

export interface TakesAccess {
  subscribe(cb: () => void): () => void;
  /** Stable between changes (useSyncExternalStore). */
  getRec(): RecState;
  /** Seconds recorded so far, NOW (a readout polls it). */
  elapsed(kind: TakeKind): number;
  /** Live blobs the tracker reports right now (the tracking dock's "live: N blobs"). */
  liveBlobs(): number;
  /** Take files in the project folder that the library does not list (stable between changes). */
  orphans(): string[];
  toggle(kind: TakeKind): void;
  cancel(kind: TakeKind): void;
  addLane(kind: TakeKind): void;
  rename(kind: TakeKind, id: string, name: string): void;
  remove(kind: TakeKind, id: string): void;
}

const IDLE: RecState = { lighting: false, tracking: false };
const NONE: string[] = [];
let access: TakesAccess = {
  subscribe: () => () => {}, getRec: () => IDLE, elapsed: () => 0, liveBlobs: () => 0, orphans: () => NONE,
  toggle: () => {}, cancel: () => {}, addLane: () => {}, rename: () => {}, remove: () => {},
};
export function setTakesAccess(a: TakesAccess): void { access = a; }
export function takesAccess(): TakesAccess { return access; }
