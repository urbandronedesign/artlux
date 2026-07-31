// The projector window's own streamed surface picture, as a render-free channel.
//
// A mesh bound to a SURFACE (SceneModel.surfaceId) is textured with the frames this window is
// already being sent — the frame pump ships the output's surface every ~33 ms and ProjectorApp draws
// it on the base canvas, so the mesh costs nothing beyond one more texture upload.
//
// A channel rather than React state or props, for the reason stated all over this codebase: frames
// arrive at ~30 fps, and pushing them through setState would re-render the whole projector tree
// thirty times a second to deliver a value only a useFrame needs. ProjectorModel polls `gen`.
//
// OWNERSHIP: the bitmap belongs to ProjectorApp, which closes the previous one when the next frame
// lands. We only hold a reference to the CURRENT frame and never close it — the same contract the
// timeline mirror's setLayerBitmap path already runs under.

export interface SurfaceFrame {
  surfaceId: string;
  bitmap: ImageBitmap | null; // null = the source has nothing to show (clip ended / live source dropped)
  gen: number;                // ticks per delivery; identity alone can repeat
}

let frame: SurfaceFrame | null = null;
let gen = 0;

/** CalibProjector calls this from the bridge message handler — no React involved. */
export function setSurfaceFrame(surfaceId: string, bitmap: ImageBitmap | null): void {
  frame = { surfaceId, bitmap, gen: ++gen };
}
export function getSurfaceFrame(): SurfaceFrame | null { return frame; }
/** Window teardown / leaving render mode: forget the reference (never close — not ours). */
export function clearSurfaceFrame(): void { frame = null; }
