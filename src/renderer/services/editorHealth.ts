// WHAT THE PERFORMANCE AND TIMING PANELS READ, wherever they are drawn (E5/W5) — the camera seam's
// pattern (services/cameraAccess.ts).
//
// Both describe the EDITOR: its render loop (services/perfMonitor), its UI thread (uiPerfMonitor), its
// transport and state machine (services/timeline). In a panel window those modules are idle copies — a
// performance panel reporting a window that renders nothing, or a show clock stuck at 00:00 — and the
// transport is not allowed there at all (verify:invariants bans it from the panel window's graph).
//
//   EDITOR  — live/editorAccess.ts installs the real readers.
//   WINDOW  — live/healthRemote.ts installs the live channel: the 'perf' stream, the clock anchor
//             (extrapolated here, no message per frame) and the 'sm.state' stream.
//
// This module imports nothing that runs, so a panel may import it.
import type { RenderStats } from '../../../shared/protocol';
import type { UiPerfStats } from './uiPerfMonitor'; // the shape only — erased, nothing of it runs here

export interface PerfSample { render: RenderStats; ui: UiPerfStats }

export interface EditorHealth {
  /** About once a second: the editor's render and UI statistics. */
  subscribePerf(cb: (s: PerfSample) => void): () => void;
  /** Hold the clocks while a readout is on screen (a window then asks for anchors). Returns the release. */
  watchClocks(): () => void;
  /** The two clocks NOW, seconds (cheap: called per frame by a readout). Null until known. */
  clocks(): { showTime: number; playhead: number } | null;
  /** Seconds in the current state-machine state NOW (to the second is enough: it is shown as mm:ss). */
  stateElapsedSec(): number;
  /** The current state-machine state id, now and on every change. */
  subscribeState(cb: (id: string | null) => void): () => void;
}

const NONE: EditorHealth = { subscribePerf: () => () => {}, watchClocks: () => () => {}, clocks: () => null, stateElapsedSec: () => 0, subscribeState: () => () => {} };
let health: EditorHealth = NONE;
export function setEditorHealth(h: EditorHealth): void { health = h; }
export function editorHealth(): EditorHealth { return health; }
