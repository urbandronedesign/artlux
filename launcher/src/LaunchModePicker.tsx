// WHICH ARTLUX A PROJECT OPENS IN — one control, shared by the two tabs that start the app.
//
// The mode belongs to the LAUNCH, not to the project: ArtLux activates the calibration plugin once,
// when a window loads, in the editor and in every projector window it spawns, so switching inside
// the app is a save-and-restart (File ▸ Open Calibration Workbench…). Choosing out here is the one
// way to have a machine come up aligned in a single launch — which is the whole point on a venue PC
// that exists to be aligned.
//
// The state itself lives in App and is persisted in Rust, so Projects and Examples cannot disagree
// about it and a venue tech does not re-pick it every session.

import type { LaunchMode } from './api';

/** The choices, in the order an operator meets them: the ordinary one first. */
const MODES: { id: LaunchMode; label: string; hint: string }[] = [
  { id: 'normal', label: 'Normal', hint: 'The editor as it ships.' },
  { id: 'calibrate', label: 'Calibration', hint: 'Adds the alignment workbench and its Calib rail entry.' },
];

/** What the choice means, spelled out under the control — a segment label is four words at most. */
const EXPLAIN: Record<LaunchMode, string> = {
  normal:
    'Projects open in the ordinary editor. Projector outputs use the cheap warp path.',
  calibrate:
    'Projects open with the alignment workbench: the calibration wizards, the camera, and the live venue render you check a solve against. '
    + 'The same thing File ▸ Open Calibration Workbench… does inside ArtLux — but without the save-and-restart, because the choice is made before the app starts.',
};

export function LaunchModePicker({ mode, onChange, disabled }: {
  mode: LaunchMode;
  onChange: (m: LaunchMode) => void;
  disabled?: boolean;
}) {
  return (
    // role=radiogroup + aria-checked, per the design system's Segmented recipe: the active segment
    // carries a surface AND a border AND a text tier AND a weight, never tint alone (§6).
    <span className="seg" role="radiogroup" aria-label="Which mode ArtLux opens a project in">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          className="seg-item"
          aria-checked={mode === m.id}
          disabled={disabled}
          title={m.hint}
          onClick={() => onChange(m.id)}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}

/** The sentence under the control. Separate so a tab can place it where it has room. */
export function LaunchModeNote({ mode }: { mode: LaunchMode }) {
  return <div className="caption">{EXPLAIN[mode]}</div>;
}

/**
 * The band shown after an open that worked but did NOT get the mode it was asked for.
 *
 * It exists because that outcome is invisible otherwise: the project really is open, ArtLux really
 * is in front of you, and the only symptom is a rail entry that is not there. Colour is never the
 * whole signal — a glyph and words carry it too (§6).
 */
export function ModeNotAppliedBand({ children }: { children: string }) {
  return (
    <section className="panel panel-warn panel-tight">
      <div className="text-mini fw-semi" style={{ color: 'var(--warn)' }}>⚠ Opened, but not in the mode you picked</div>
      <div className="text-mini fg-2">{children}</div>
    </section>
  );
}
