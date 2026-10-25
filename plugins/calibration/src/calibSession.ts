// The calibration SESSION's state — which output is being calibrated, the flow, 3D pick mode and the
// anchors the 3D view draws. PLAYBACK side on purpose (suite plan Phase 2): the host reads it every
// render (App feeds the embedded 3D its pick props, and asks whether an output is the session's
// target), and reading it must not load the authoring half. Only calibWorkspace (authoring) WRITES it,
// so without a session it simply stays IDLE.

// A tiny pub/sub singleton in the cueBus/helpBus idiom (was App's useStates, Stage 2b). App subscribes to
// feed the embedded 3D its calibPickMode / activePicks / selectedPick.
export interface CalibWorkspaceState {
  /** Surface id being calibrated, or null when no session is open. */
  target: string | null;
  flow: 'board' | 'auto' | 'manual';
  /** The embedded 3D is in pick mode (a click places a correspondence, not a selection). */
  pickMode: boolean;
  /** Markerless anchor world points, mirrored for the 3D markers. */
  picks: [number, number, number][];
  /** Which correspondence is being edited (highlighted in 3D). */
  selectedPick: number | null;
  // Armed one-shot edits on a pose pick (manual/board flow). ARMED, NEVER IMPLIED — same doctrine as
  // the markerless replaceArmed: selection happens as a side effect of ordinary clicks, so selection
  // alone must never make the next click MOVE a point. In state (not module refs) because the wizard
  // renders the armed banner from it.
  /** Next 3D model pick REPLACES this pick's world point instead of creating a pair. */
  editWorld: number | null;
  /** Next crosshair confirm (Enter on the projector) REPLACES this pick's pixel. */
  editPixel: number | null;
  /** Manual flow: re-estimate the lens (focal) from the picks on every solve, so the operator can
   *  calibrate without knowing the throw ratio at all. Off = the entered lens is locked. */
  lensAuto: boolean;
}
export const IDLE: CalibWorkspaceState = { target: null, flow: 'board', pickMode: false, picks: [], selectedPick: null, editWorld: null, editPixel: null, lensAuto: true };
let state: CalibWorkspaceState = IDLE;
const subs = new Set<() => void>();
export function emit(patch: Partial<CalibWorkspaceState>): void {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
}

export function getState(): CalibWorkspaceState { return state; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }