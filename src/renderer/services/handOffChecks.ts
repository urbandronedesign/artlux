// BEFORE THE PROJECT LEAVES FOR THE OTHER APP OF THE SUITE — checks that may stop or amend a hand-off.
//
// There are two doors to the hand-off: File ▸ Open in ArtLux Show… (host, App.handleOpenInOtherApp)
// and Test & sign-off ▸ Open in ArtLux Show (calibration plugin, SignoffPanel). A check that lives
// behind one of them is a check the other route skips, so both call `beforeHandOff` and a plugin
// registers what it needs here — today ArtLux Calibrator's "the calibration file the show plays is
// older than the calibration" (plugins/calibration/src/fileFreshness.ts).
//
// A check gets the caller's confirm + toast (they are React hooks, so the caller passes them in) and
// answers whether the hand-off may go on. A check that throws lets it go on: a broken check must not
// strand an operator in the app they are trying to leave.

type ConfirmResult = boolean | 'alt';
export interface HandOffUi {
  confirm: (o: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; altLabel?: string }) => Promise<ConfirmResult>;
  toast: { success: (m: string, d?: string) => void; warn: (m: string, d?: string) => void };
}
export type HandOffCheck = (ui: HandOffUi) => Promise<boolean>;

const checks = new Set<HandOffCheck>();

/** Register a check run before every hand-off. Returns an unregister. */
export function registerBeforeHandOff(check: HandOffCheck): () => void {
  checks.add(check);
  return () => { checks.delete(check); };
}

/** Run every check in turn; false as soon as one says stop. */
export async function beforeHandOff(ui: HandOffUi): Promise<boolean> {
  for (const c of checks) {
    try { if (!(await c(ui))) return false; }
    catch (e) { console.warn('[hand-off] a check failed — handing over anyway', e); }
  }
  return true;
}
