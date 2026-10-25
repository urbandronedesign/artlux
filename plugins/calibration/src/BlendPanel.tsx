// BLEND — ArtLux Calibrator's inspector on the Blend context (suite plan Phase 3, step 5; design S4).
//
// The rig blend's controls (solve, clear) and its inspector (every projector's share, whether the
// overlap sums to one) beside the venue — with the rig list's SOLO / MUTE in the left column, which is
// how a seam is actually judged: look at the wall with one projector, then the other, then both.

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/feedback';
import * as blendController from './blendController';
import { isStale, rigOutputs } from './blendStale';
import { BlendInspector } from './BlendInspector';
import { outputName, useOutputs, useSurfaces } from './useHostData';

export const BlendPanel: React.FC = () => {
  const outputs = useOutputs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rig = rigOutputs();
  const solved = rig.filter((o) => o.blend).length;
  const stale = rig.some((o) => isStale(o, rig));
  // Enabled and not calibrated: outside the blend until it is (same rule as RigStatus).
  const surfaces = useSurfaces();
  const todo = outputs.filter((o) => o.enabled && o.calibration?.poseRms == null);

  const solve = async () => {
    setBusy(true);
    try {
      const r = await blendController.solveRig();
      if (r.ok) toast.success('Rig blend solved', r.message);
      else toast.error('Could not solve the blend', r.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      {rig.length < 2 ? (
        <p className="text-mini text-fg-2 m-0">A blend needs at least two calibrated projectors — {rig.length} so far.</p>
      ) : (
        <>
          <div className="text-mini">
            {!solved ? <span className="text-fg-2">○ Not solved yet.</span>
              : stale ? <span className="text-warn">⚠ Stale — a projector changed after the last solve. It still plays; solve again when you can.</span>
              : todo.length ? <span className="text-fg-2">◐ Solved without {todo.map((o) => outputName(o, surfaces)).join(', ')} — calibrate {todo.length === 1 ? 'it' : 'them'}, then solve again.</span>
              : <span className="text-ok">✓ Solved and current.</span>}
          </div>
          <p className="text-mini text-fg-2 m-0">Use Solo and Mute in the rig list to look at each projector's share on the wall.</p>
          {solved > 0 && <div className="border border-line-2 rounded-md"><BlendInspector outputs={outputs} /></div>}
        </>
      )}
      <div className="flex-1" />
      <div className="flex flex-col gap-1.5">
        {solved > 0 && (
          <Button variant="ghost" onClick={() => { blendController.clearRig(); toast.success('Rig blend cleared', 'Outputs fall back to the hand-set soft edge.'); }}>
            Clear blend
          </Button>
        )}
        <Button variant="primary" onClick={solve} disabled={busy || rig.length < 2}>
          {busy ? <><Loader2 size={12} className="animate-spin" /> Solving…</> : solved ? 'Solve again' : 'Solve blend'}
        </Button>
      </div>
    </div>
  );
};
