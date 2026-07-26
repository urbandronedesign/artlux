// The two once-a-second readouts in the status bar, kept OUT of App's state.
//
// `renderFps` and the native pacer's `outputStats` are pure telemetry: one number each, drawn in one
// corner of the chrome, read by nothing else in the app. They used to be `useState` in App — which
// meant the editor re-rendered its entire tree twice a second, forever, including while completely
// idle. App owns every piece of document state, so one of its renders reconciles every panel reading
// useEditor(), all five persistent viewports, Stage, the 3D scene and the timeline. Two counters were
// paying for all of it.
//
// So they live here instead, in the module-singleton pub/sub idiom this codebase already uses for
// cueBus / helpBus / layoutStore, and only the component that draws them subscribes. The status bar
// re-renders at 1 Hz — which is exactly right, because it is the thing displaying a 1 Hz number.
//
// This is the same principle as services/livePreview (a render-free channel for a value that changes
// faster than the tree should be rebuilt), applied at a slower clock: DO NOT route a periodic value
// through App just because App happens to be where the timer lives.

export interface OutputStats {
  pps: number;        // packets/sec, from the native send thread
  fps: number;        // frames/sec including keep-alive
  universes: number;  // universes in the last frame
}

export interface Telemetry {
  /** Renderer frame rate, sampled once a second by App's counting loop. */
  renderFps: number;
  /** The native Art-Net/sACN pacer's own rate, pushed from main ~1 Hz. Null until the first report. */
  outputStats: OutputStats | null;
}

let state: Telemetry = { renderFps: 0, outputStats: null };
const subs = new Set<(t: Telemetry) => void>();

const emit = (): void => { for (const cb of subs) cb(state); };

export const telemetry = {
  get(): Telemetry { return state; },
  subscribe(cb: (t: Telemetry) => void): () => void { subs.add(cb); return () => { subs.delete(cb); } },
  setRenderFps(fps: number): void {
    if (state.renderFps === fps) return; // a steady 60 fps should not wake a single subscriber
    state = { ...state, renderFps: fps };
    emit();
  },
  setOutputStats(s: OutputStats | null): void {
    const p = state.outputStats;
    // Same reason: the pacer reports every second whether or not anything moved.
    if (p === s || (p && s && p.pps === s.pps && p.fps === s.fps && p.universes === s.universes)) return;
    state = { ...state, outputStats: s };
    emit();
  },
};
