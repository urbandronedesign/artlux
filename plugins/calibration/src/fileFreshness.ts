// THE CALIBRATION FILE MUST NOT FALL BEHIND THE CALIBRATION (ArtLux Calibrator, at the hand-off).
//
// A show with heavy media plays a calibration FILE (Prefs.calibrationFile), not the live calibration —
// measured 2026-10-25: 6K video on two projectors, 3–7 fps live against 60 from the file. The file is a
// snapshot: recalibrate or re-solve the blend and the show keeps playing the OLD aim, silently, until
// somebody remembers to export again. The hand-off to ArtLux Show is the moment that is still cheap to
// catch, so before it the Calibrator compares the file's date with the newest calibration or blend
// solve and offers to replace it in place (same path, so the show picks it up with nothing to reload).
//
// No file set → the show plays live calibration and there is nothing to fall behind: no question.

import type { ProjectorOutput } from '../../../shared/protocol';
import { registerBeforeHandOff, type HandOffUi } from '@/services/handOffChecks'; // host service — both hand-off doors run it
import { getHost, exportRigMpcdi } from './calibHost';

/** The newest calibration or blend solve on any enabled output, ms since epoch (0 = none). */
export function newestCalibrationMs(outputs: ProjectorOutput[]): number {
  let t = 0;
  for (const o of outputs) {
    if (!o.enabled) continue;
    for (const s of [o.calibration?.calibratedAt, o.blend?.solvedAt]) {
      const v = s ? Date.parse(s) : NaN;
      if (v > t) t = v;
    }
  }
  return t;
}

async function check(ui: HandOffUi): Promise<boolean> {
  const file = await window.artlux?.rememberedCalibrationFile?.();
  if (!file) return true;
  const newest = newestCalibrationMs((getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[]);
  if (!newest || (file.mtimeMs != null && file.mtimeMs >= newest)) return true;
  const name = file.path.split(/[\\/]/).pop();
  const answer = await ui.confirm({
    title: 'The calibration file is out of date',
    message: file.mtimeMs == null
      ? `ArtLux Show plays ${name}, which is missing. Export the calibration to it now?`
      : `ArtLux Show plays ${name}, saved ${new Date(file.mtimeMs).toLocaleString()} — before the latest calibration or blend (${new Date(newest).toLocaleString()}). Without a new export the show keeps the old aim.`,
    confirmLabel: 'Export and replace',
    altLabel: 'Hand over without exporting',
    cancelLabel: 'Cancel',
  });
  if (answer === false) return false;
  if (answer === 'alt') return true;
  const msg = await exportRigMpcdi({ replaceRemembered: true });
  if (msg.startsWith('✓')) { ui.toast.success('Calibration file replaced', name); return true; }
  // Do not hand over on a failed export: the operator asked for a fresh file, and the show would
  // start on the stale one with nothing to say so.
  ui.toast.warn('The calibration file was not replaced', msg.replace(/^[✓✗] /, ''));
  return false;
}

export function registerFileFreshnessCheck(): () => void {
  return registerBeforeHandOff(check);
}
