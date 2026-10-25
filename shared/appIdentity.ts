// WHICH APP THIS BUILD IS — ArtLux Show, ArtLux Calibrator, or the combined app it grew out of.
//
// A BUILD fact, not a launch fact (suite plan §3, plans/artlux-suite-show-calibrator.md): the build sets
// `ARTLUX_APP` and electron.vite.config.ts writes it into every bundle as the literal `__ARTLUX_APP__`,
// so the bundler can DROP what the other app owns — a condition on a literal folds away, and the code
// behind it never ships. Every window of one install agrees by construction; there is no flag to forget.
//
//   suite       today's ArtLux: one app, calibration authoring behind the `--calibrate` launch profile.
//               The default, so `npm run dev` and the existing `npm run package` are unchanged until the
//               two products ship.
//   show        ArtLux Show: builds and runs shows. PLAYS calibrations (live and from a file) but carries
//               none of the authoring — no wizards, no camera, no OpenCV. `--calibrate` means nothing.
//   calibrator  ArtLux Calibrator: aligns the projectors of a venue. Always an authoring launch, and
//               only the workspace that alignment needs.
//
// ⚠ To make the bundler drop code, test `__ARTLUX_APP__` ITSELF at the site (`if (__ARTLUX_APP__ !==
// 'show')`): the define replaces that identifier with a literal in the module being built, so the
// condition folds there. A value imported from here also works for behaviour, but whether the bundler
// can see through the import is its business, not a guarantee.

declare global {
  /** Replaced at build time with 'suite' | 'show' | 'calibrator' (electron.vite.config.ts `define`). */
  const __ARTLUX_APP__: ArtluxApp;
}

export type ArtluxApp = 'suite' | 'show' | 'calibrator';

/** The app this build is. Outside a vite build (a tsx script, a unit check) it is the combined app. */
export const ARTLUX_APP: ArtluxApp = typeof __ARTLUX_APP__ !== 'undefined' ? __ARTLUX_APP__ : 'suite';

/** The name an operator sees: window titles, the menu, dialogs, the machine log. */
export const APP_DISPLAY_NAME: string =
  ARTLUX_APP === 'show' ? 'ArtLux Show' : ARTLUX_APP === 'calibrator' ? 'ArtLux Calibrator' : 'ArtLux';

/** This build can PRODUCE a calibration (wizards, camera, OpenCV, recalibration). Show cannot. */
export const HAS_CALIBRATION_AUTHORING: boolean = ARTLUX_APP !== 'show';
