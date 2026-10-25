// RIG STATUS — ArtLux Calibrator's inspector on the Rig context (suite plan Phase 3, step 5; design S1).
//
// With nothing being calibrated, the inspector is the rig's TO-DO LIST: who is done, whether the blend is
// current, whether the rig is signed off — and ONE primary action, the next thing to do (design: "one
// primary action at its foot"). Starting a projector opens the calibration session and the workbench.

import React, { useSyncExternalStore } from 'react';
import { Button } from '@/components/ui';
import { getHost } from './calibHost';
import * as rigUi from './rigUi';
import * as session from './calibSession';
import * as calibWorkspace from './calibWorkspace';
import { isStale, rigOutputs } from './blendStale';
import { useOutputs, useSurfaces, useScene, outputName, rigState } from './useHostData';
import { signOffStale } from './SignoffPanel';
import { MachineCheck } from './MachineCheck';

export const RigStatus: React.FC = () => {
  const outputs = useOutputs();
  const surfaces = useSurfaces();
  const scene = useScene();
  const ui = useSyncExternalStore(rigUi.subscribe, rigUi.getState);
  const target = useSyncExternalStore(session.subscribe, session.getState).target;

  const enabled = outputs.filter((o) => o.enabled);
  const todo = enabled.filter((o) => o.calibration?.poseRms == null);
  const rig = rigOutputs();
  const solved = rig.filter((o) => o.blend).length;
  const stale = rig.some((o) => isStale(o, rig));
  const signOff = scene.calibRig?.signOff;
  const signStale = signOff ? signOffStale(signOff, outputs) : false;

  // The next thing to do: the focused projector if it needs it, else the first one that does.
  const next = (ui.focus && todo.find((o) => o.surfaceId === ui.focus)) || todo[0];
  const start = (id: string) => {
    rigUi.setFocus(id);
    calibWorkspace.begin(id);
    getHost()?.ui?.goToContext('calib');
  };
  const go = (ctx: string) => getHost()?.ui?.goToContext(ctx);

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">

      <div className="border border-line-2 rounded-md overflow-hidden">
        <div className="grid grid-cols-[20px_1fr_auto_56px] gap-2 px-2 py-1 bg-surface-2 text-micro uppercase tracking-wider text-fg-2">
          <span>#</span><span>Projector</span><span>State</span><span className="text-right">Fit</span>
        </div>
        {outputs.map((o, i) => {
          const st = rigState(o, target);
          return (
            <div key={o.surfaceId} className="grid grid-cols-[20px_1fr_auto_56px] gap-2 px-2 py-1 border-t border-line-2 text-mini items-center">
              <span className="font-mono text-fg-2">{i + 1}</span>
              <span className="truncate text-fg-1">{outputName(o, surfaces)}</span>
              <span className={st === 'calibrated' ? 'text-ok' : st === 'calibrating' ? 'text-accent' : 'text-fg-2'}>
                {st === 'calibrated' ? '✓ done' : st === 'calibrating' ? '◐ in progress' : st === 'off' ? '— off' : '○ to do'}
              </span>
              <span className="font-mono text-right text-fg-2">{o.calibration?.poseRms != null ? `${o.calibration.poseRms.toFixed(1)} px` : '—'}</span>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1 text-mini">
        <div className="flex justify-between gap-2">
          <span className="text-fg-2">Blend</span>
          {rig.length < 2 ? <span className="text-fg-2">needs two calibrated projectors</span>
            : !solved ? <span className="text-fg-2">○ not solved</span>
            : stale ? <span className="text-warn">⚠ stale — solve again</span>
            : <span className="text-ok">✓ solved</span>}
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-fg-2">Sign-off</span>
          {!signOff ? <span className="text-fg-2">○ not signed</span>
            : signStale ? <span className="text-warn">⚠ rig changed since {signOff.by} signed</span>
            : <span className="text-ok">✓ {signOff.by}, {new Date(signOff.at).toLocaleDateString()}</span>}
        </div>
      </div>

      <div className="h-px bg-line-1" />
      <MachineCheck />

      <div className="flex-1" />

      <div className="flex flex-col gap-1.5">
        {next ? (
          <Button variant="primary" onClick={() => start(next.surfaceId)} disabled={!!target}>
            {target ? 'A calibration is open' : `Calibrate ${outputName(next, surfaces)}`}
          </Button>
        ) : rig.length >= 2 && (!solved || stale) ? (
          <Button variant="primary" onClick={() => go('blend')}>Solve the blend</Button>
        ) : (
          <Button variant="primary" onClick={() => go('signoff')}>Test & sign off</Button>
        )}
        {ui.focus && !todo.some((o) => o.surfaceId === ui.focus) && !target && (
          <Button variant="tonal" onClick={() => start(ui.focus!)}>
            Recalibrate {outputName(outputs.find((o) => o.surfaceId === ui.focus) ?? outputs[0], surfaces)}
          </Button>
        )}
        {!enabled.length && <span className="text-mini text-fg-2 text-center">Switch an output on in Projection Outputs first.</span>}
      </div>
    </div>
  );
};
