// Was a previous unattended recalibration killed part-way? Asked once at every show boot (see
// plugin.renderer.ts), so it lives apart from autoRecal: a boot that only has to ask one IPC question
// must not load the authoring half to ask it (suite plan Phase 1).

import * as calibNative from './calibNative';

/** On activation: was a previous run killed part-way? Report it once, and do NOT resume. */
export async function reportInterrupted(log: (line: string) => void = (l) => console.warn(`[recal] ${l}`)): Promise<void> {
  const m = await calibNative.calibRecalTakeInterrupted();
  if (!m) return;
  log(`a previous recalibration was interrupted (started ${String(m.startedAt)}) — not resuming; the next scheduled run starts fresh`);
  void calibNative.calibAuditAppend({ ts: new Date().toISOString(), event: 'interrupted', ...m });
}
