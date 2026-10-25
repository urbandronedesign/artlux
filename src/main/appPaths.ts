// ONE PROFILE FOR THE WHOLE SUITE — imported second in main/index.ts, straight after ./threadpool and
// before ANY module that reads app.getPath('userData') at import time (logger, persistence, watchdog…).
//
// Electron derives userData from the product name, so ArtLux Calibrator would get its own
// `%APPDATA%\ArtLux Calibrator` — a second set of prefs, recents and remembered calibration file on a
// machine that has ONE rig. Those are facts about the machine, not about an app (suite plan Phase 3), so
// the Calibrator uses the folder every ArtLux install already has. ArtLux Show's product name is still
// `ArtLux`, so it lands there by default and needs nothing.
//
// What this ALSO buys, deliberately: Electron's requestSingleInstanceLock is keyed on the userData
// directory, so sharing it makes the lock cover both apps — ArtLux Show and ArtLux Calibrator can never
// run at once, the second one's argv reaching the first as a `second-instance` (see index.ts). Two apps
// driving the same displays and universes is the failure that lock exists to prevent.
//
// A `--user-data-dir=` on the command line wins (Chromium applies it before this runs, and a test bench
// or a second instance beside the operator's depends on it). What differs per app is only the layout
// (Prefs.layoutStateCalibrator) and the logs folder (logger.ts), so a machine log names its app.

import { app } from 'electron';
import { join } from 'node:path';
import { ARTLUX_APP } from '../../shared/appIdentity';

if (ARTLUX_APP === 'calibrator' && !process.argv.some((a) => a.startsWith('--user-data-dir='))) {
  app.setPath('userData', join(app.getPath('appData'), 'ArtLux'));
}
