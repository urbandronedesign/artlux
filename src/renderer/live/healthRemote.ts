// The Performance and Timing panels' readers in a PANEL WINDOW (E5/W5): the EDITOR's health and clocks,
// over the live channel. The editor's own panels read the services (live/editorAccess.ts).
//
//   perf   — the 'perf' stream (1 Hz in the editor, only while watched): its render loop AND its UI
//            thread. This window's own UI is not what the operator is asking about.
//   clocks — the clock ANCHOR, extrapolated here: no message per frame, a new anchor only when the
//            transport stops agreeing with the last one (a seek, a pause, a wrap).
//   state  — the 'sm.state' stream: sent on a state change and when the displayed second changes.
import { liveClient } from './client';
import type { EditorHealth, PerfSample } from '../services/editorHealth';

let smId: string | null = null;
let smElapsed = 0;
const stateSubs = new Set<(id: string | null) => void>();
let smStop: (() => void) | null = null;
function openSm(): void {
  if (smStop) return;
  smStop = liveClient.subscribe('sm.state', null, (v) => {
    const s = v as { id: string | null; elapsedSec: number };
    const changed = s.id !== smId;
    smId = s.id; smElapsed = s.elapsedSec;
    if (changed) for (const cb of [...stateSubs]) cb(smId);
  });
}

export const remoteEditorHealth: EditorHealth = {
  subscribePerf(cb) {
    return liveClient.subscribe('perf', null, (v) => { const p = v as PerfSample; if (p?.render && p?.ui) cb(p); });
  },
  // Ref-counted in the client: the editor attaches its clock check only while some window holds one.
  watchClocks: () => liveClient.watchClock(),
  clocks() {
    const c = liveClient.now();
    return c ? { showTime: c.showTime, playhead: c.playhead } : null;
  },
  // Between samples the readout holds the last second it was told: at most a quarter-second late, and
  // never ahead of the editor (a held state must not count up in a window while it stands still there).
  stateElapsedSec() { openSm(); return smId == null ? 0 : smElapsed; },
  subscribeState(cb) {
    openSm();
    stateSubs.add(cb);
    cb(smId);
    return () => { stateSubs.delete(cb); if (!stateSubs.size) { smStop?.(); smStop = null; } };
  },
};
