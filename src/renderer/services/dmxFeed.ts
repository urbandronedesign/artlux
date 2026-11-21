// WHAT THE DMX MONITOR READS, wherever it is drawn (E5/W5) — the camera seam's pattern
// (services/cameraAccess.ts), for the output.
//
// The packed universes and the canonical pixel buffer are the frame engine's, and the frame engine runs
// in the editor only. A panel window importing services/dmxSignal would subscribe to its own idle bus:
// a monitor whose strips stay black while the rig is lit, which is the worst thing a monitor can say.
//
//   EDITOR  — live/editorAccess.ts installs the bus itself: zero copies, exactly what the docked monitor
//             always read (dmxSignal publishes; this hands the same buffers on).
//   WINDOW  — live/dmxRemote.ts installs one shared subscription per kind over the live channel
//             ('dmx.pixels', 'dmx.universes'), however many fixtures the monitor draws.
//
// This module imports nothing that runs, so a panel may import it.

/** One output frame, as the monitor reads it. Valid for the duration of the callback only. */
export interface DmxFrameView {
  /** The canonical RGBW pixel buffer (4 bytes per LED, every fixture in patch order). */
  pixels: Uint8Array;
  /** Universe `u`'s 512 bytes as they left the machine (the first destination that carries it). */
  universe(u: number): ArrayLike<number> | undefined;
}

export interface DmxFeed {
  /**
   * Every output frame. `needs` says what this subscriber reads, so a window is sent only that: a pixel
   * strip reads `pixels`, a light's channel table reads `universes`.
   */
  subscribe(needs: 'pixels' | 'universes', cb: (f: DmxFrameView) => void): () => void;
}

let feed: DmxFeed = { subscribe: () => () => {} };
export function setDmxFeed(f: DmxFeed): void { feed = f; }
export function dmxFeed(): DmxFeed { return feed; }
