// A VIDEO'S STILL, AS A PANEL DRAWS IT (E5/W5j) — the camera seam's pattern, for the media library's
// asset chips. Thumbnails are decoded in the editor (services/thumbnailCache, which reaches the boot gate
// and the media pipeline — none of it may run in a panel window).
//
//   EDITOR — live/editorAccess.ts installs the cache itself: what the chips always read.
//   WINDOW — live/takesRemote.ts installs W4's thumbnail service (`liveClient.thumb`): asked once per
//            (path, time), decoded once in the editor, kept here.
// This module imports nothing that runs.

export interface ThumbView {
  /** The still if this window has it (the nearest frame, in the editor). Undefined starts a fetch. */
  getThumb(path: string, time: number): ImageBitmap | undefined;
  /** Fires with a path when a still for it arrives. */
  onThumb(cb: (path: string) => void): () => void;
}
let view: ThumbView = { getThumb: () => undefined, onThumb: () => () => {} };
export function setThumbView(v: ThumbView): void { view = v; }
export function thumbView(): ThumbView { return view; }
