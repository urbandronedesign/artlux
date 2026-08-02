// Streamed surface pictures available to this projector window, as a render-free channel.
//
// A mesh bound to a SURFACE (SceneModel.surfaceId) is textured from the frames this window is being
// sent. Two kinds arrive, and they differ in who owns the bitmap:
//
//   • THIS window's own surface (`frame`) — ProjectorApp has already taken it for the base canvas and
//     closes the previous one when the next lands. We hold a NON-OWNING reference: never close it.
//   • Any OTHER surface (`surfaceFrame`) — transferred to this channel and nothing else, so the
//     channel OWNS it and must close the one it replaces or every frame leaks an ImageBitmap.
//
// Two disciplines in one module is exactly the shape that leaks, so ownership is carried per entry
// rather than inferred. Same contract the timeline mirror's setLayerBitmap already runs under.
//
// A channel rather than React state or props, for the reason stated all over this codebase: frames
// arrive at ~30 fps, and pushing them through setState would re-render the whole projector tree
// thirty times a second to deliver a value only a useFrame needs. Consumers poll `gen`.

export interface SurfaceFrame {
  surfaceId: string;
  bitmap: ImageBitmap | null; // null = the source has nothing to show (clip ended / live source dropped)
  gen: number;                // ticks per delivery; identity alone can repeat
  owned: boolean;             // true → this channel closes it (see the header)
}

const frames = new Map<string, SurfaceFrame>();
let gen = 0;

/** CalibProjector calls this from the bridge message handler — no React involved. */
export function setSurfaceFrame(surfaceId: string, bitmap: ImageBitmap | null, owned = false): void {
  const prev = frames.get(surfaceId);
  // Only ever close what we were given ownership of, and never the bitmap we are being handed again.
  if (prev?.owned && prev.bitmap && prev.bitmap !== bitmap) prev.bitmap.close();
  frames.set(surfaceId, { surfaceId, bitmap, gen: ++gen, owned });
}

export function getSurfaceFrame(surfaceId: string | undefined | null): SurfaceFrame | null {
  return surfaceId ? frames.get(surfaceId) ?? null : null;
}

// Leaving render mode: main stops streaming the referenced surfaces, so the bitmaps we OWN would sit
// here holding GPU memory until the window closed — one per surface the venue geometry referenced.
// The window's own-surface entry is deliberately left alone: ProjectorApp owns that bitmap and goes
// on replacing it for the base canvas, so dropping it here would be closing someone else's frame.
export function clearOwnedSurfaceFrames(): void {
  for (const [id, f] of frames) {
    if (!f.owned) continue;
    f.bitmap?.close();
    frames.delete(id);
  }
}

/** Leaving render mode / window teardown. Omit the id to drop everything. */
export function clearSurfaceFrame(surfaceId?: string): void {
  if (surfaceId === undefined) {
    for (const f of frames.values()) if (f.owned) f.bitmap?.close();
    frames.clear();
    return;
  }
  const f = frames.get(surfaceId);
  if (f?.owned) f.bitmap?.close();
  frames.delete(surfaceId);
}
