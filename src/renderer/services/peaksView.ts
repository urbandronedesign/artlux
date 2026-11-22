// AN AUDIO FILE'S WAVEFORM AND LENGTH, AS THE TIMELINE DRAWS THEM (E5 — the detached timeline) — the camera
// seam's pattern. Peaks come from DECODING the file (components/timeline/audioPeaks.ts), which a panel window
// must not do: it would decode every bed file a second time beside the editor's copy.
//
//   EDITOR — live/editorAccess.ts installs audioPeaks itself: exactly what the timeline read before.
//   WINDOW — live/transportRemote.ts installs W4's peaks service (`liveClient.peaks`): decoded once in the
//            editor, the buckets asked for crossed once and kept here.
// This module imports nothing that runs.

export interface PeaksView {
  /** Fires when any file's peaks (or its failure) arrive. */
  subscribe(cb: () => void): () => void;
  /** Start decoding `path` if nothing has yet (a no-op once it is decoded or decoding). */
  ensure(path: string): void;
  /** `buckets` peak values for the whole file, or null until they exist. */
  peaksFor(path: string, buckets: number): Float32Array | null;
  /** The decoded file's length in seconds, or null until known. */
  sourceDuration(path: string): number | null;
  /** The file's length without decoding it all (an import's first estimate). */
  probeDuration(path: string): Promise<number | null>;
}

let view: PeaksView = {
  subscribe: () => () => {},
  ensure: () => {},
  peaksFor: () => null,
  sourceDuration: () => null,
  probeDuration: async () => null,
};
export function setPeaksView(v: PeaksView): void { view = v; }

export const peaksView: PeaksView = {
  subscribe: (cb) => view.subscribe(cb),
  ensure: (p) => view.ensure(p),
  peaksFor: (p, b) => view.peaksFor(p, b),
  sourceDuration: (p) => view.sourceDuration(p),
  probeDuration: (p) => view.probeDuration(p),
};
