// THE RIG — ArtLux Calibrator's left column (suite plan Phase 3, step 5; design S1/S4/S5).
//
// One card per projector: its NUMBER (projectors have no colour of their own — the design system keeps
// colour for selection and status, docs/DESIGN-SYSTEM.md §1.1), its name, its display, and its state as
// a glyph AND a word (§6: status is never colour alone). The focused projector is the one thing in the
// accent. Solo / mute are a mixer's two verbs for the real wall (rigUi.ts) — mute blacks one projector,
// solo blacks every other — mirrored on the projectors themselves, never saved.

import React, { useSyncExternalStore } from 'react';
import { Headphones, VolumeX } from 'lucide-react';
import * as rigUi from './rigUi';
import * as session from './calibSession';
import { useOutputs, useSurfaces, outputName, rigState, type RigState } from './useHostData';

const STATE: Record<RigState, { glyph: string; word: string; cls: string }> = {
  calibrated: { glyph: '✓', word: 'calibrated', cls: 'text-ok' },
  calibrating: { glyph: '◐', word: 'calibrating', cls: 'text-accent' },
  none: { glyph: '○', word: 'not calibrated', cls: 'text-fg-2' },
  off: { glyph: '—', word: 'output off', cls: 'text-fg-3' },
};

export const RigList: React.FC = () => {
  const outputs = useOutputs();
  const surfaces = useSurfaces();
  const ui = useSyncExternalStore(rigUi.subscribe, rigUi.getState);
  const target = useSyncExternalStore(session.subscribe, session.getState).target;
  const canMute = rigUi.canMute();

  if (!outputs.length) {
    return (
      <div className="p-3 text-mini text-fg-2 space-y-1">
        <div className="text-fg-1 font-medium">No projectors yet.</div>
        <div>Add an output in Projection Outputs, or open a venue whose Blender file has projector cameras.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-2" role="list" aria-label="Projectors in the rig">
      {outputs.map((o, i) => {
        const st = STATE[rigState(o, target)];
        const focused = ui.focus === o.surfaceId;
        const muted = ui.solo ? ui.solo !== o.surfaceId : ui.muted.includes(o.surfaceId);
        return (
          <div key={o.surfaceId} role="listitem"
            className={`rounded-md border ${focused ? 'border-accent bg-accent-dim' : 'border-transparent'}`}>
            <button type="button" onClick={() => rigUi.setFocus(focused ? null : o.surfaceId)} aria-pressed={focused}
              className="w-full text-left px-2 py-1.5 grid grid-cols-[24px_1fr] gap-x-2 gap-y-0.5 items-center">
              <span className={`row-span-2 w-6 h-6 rounded-sm grid place-items-center font-mono text-mini ${focused ? 'bg-accent text-black' : 'bg-surface-3 text-fg-2'}`}>{i + 1}</span>
              <span className={`text-xs truncate ${focused ? 'font-semibold text-fg-1' : 'font-medium text-fg-1'}`}>{outputName(o, surfaces)}</span>
              <span className="text-mini text-fg-2 truncate">
                <span className={st.cls}>{st.glyph} {st.word}</span>
                {o.calibration?.poseRms != null && <span className="font-mono"> · {o.calibration.poseRms.toFixed(1)} px</span>}
                {muted && <span className="text-fg-3"> · black</span>}
              </span>
            </button>
            {canMute && (
              <div className="flex gap-1 px-2 pb-1.5">
                <button type="button" onClick={() => rigUi.toggleSolo(o.surfaceId)} aria-pressed={ui.solo === o.surfaceId}
                  title="Solo — show only this projector on the wall"
                  className={`h-6 px-2 rounded-sm text-micro inline-flex items-center gap-1 border ${ui.solo === o.surfaceId ? 'border-accent text-fg-1 bg-accent-dim' : 'border-line-2 text-fg-2'}`}>
                  <Headphones size={11} /> Solo
                </button>
                <button type="button" onClick={() => rigUi.toggleMute(o.surfaceId)} aria-pressed={ui.muted.includes(o.surfaceId)}
                  title="Mute — show black from this projector"
                  className={`h-6 px-2 rounded-sm text-micro inline-flex items-center gap-1 border ${ui.muted.includes(o.surfaceId) ? 'border-accent text-fg-1 bg-accent-dim' : 'border-line-2 text-fg-2'}`}>
                  <VolumeX size={11} /> Mute
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
