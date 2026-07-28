import React, { useEffect, useState } from 'react';
import { Layers, Loader2, AlertTriangle, ScanEye } from 'lucide-react';
import type { ProjectorOutput } from '../../../shared/protocol';
import { blendController, blendStore, BlendInspector } from '@artlux/plugin-calibration/renderer';
import { Button } from './ui';
import { useToast } from './ui/feedback';

// The rig-level blend control: a project-level fact about the SET of calibrated outputs, so it sits at
// the panel level rather than inside a row. (Deliberately NOT a new workspace context — the rig is a
// property of the outputs already on screen; see docs/WORKSPACE.md.)
//
// Everything reaches the calibration plugin through its barrel — blendStore is a module singleton, and
// a relative import here would hand the host a second, permanently empty copy of it.

interface Props { outputs: ProjectorOutput[] }

export const RigBlendStrip: React.FC<Props> = ({ outputs }) => {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const toast = useToast();

  // The store is a plain singleton, not React state: subscribe so a scan finishing in the wizard
  // updates the count without the operator having to leave the panel and come back.
  useEffect(() => blendStore.subscribe(() => bump((n) => n + 1)), []);

  const rig = outputs.filter(o => o.enabled && o.calibration?.poseRms != null);
  // Only the in-memory half is knowable synchronously; a projector scanned in an earlier session is
  // on disk and gets loaded by the solve. Saying so beats showing a count that reads as "not ready".
  const scanned = rig.filter(o => blendStore.has(o.surfaceId)).length;
  const solved = rig.filter(o => o.blend).length;
  const stale = rig.some(o => blendController.isStale(o, rig));

  const solve = async () => {
    setBusy(true);
    try {
      const r = await blendController.solveRig();
      if (r.ok) { toast.success('Rig blend solved', r.message); setOpen(true); }
      else toast.error('Could not solve the blend', r.message);
    } finally { setBusy(false); }
  };

  if (rig.length < 2) return null; // a blend is meaningless below two calibrated projectors

  return (
    <div className="border border-line-2 rounded-md">
      <div className="px-2 py-1.5 flex items-center gap-3 text-mini">
        <span className="flex items-center gap-1.5 text-fg-1 shrink-0"><Layers size={13} className="text-accent" /> Rig blend</span>

        <span className="text-fg-2 truncate">
          {rig.length} calibrated · {scanned} scanned this session
          {solved > 0 && <> · <span className={stale ? 'text-warn' : 'text-ok'}>{solved} solved{stale ? ' (stale)' : ''}</span></>}
        </span>

        {stale && (
          <span className="flex items-center gap-1 text-warn shrink-0"
            title="A projector was recalibrated, or the rig changed, after this blend was solved. It still renders — a slightly wrong seam beats a hole in the show — but re-solve when you can.">
            <AlertTriangle size={12} /> re-solve
          </span>
        )}

        <div className="flex-1" />

        {solved > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setOpen(o => !o)} aria-expanded={open}
            title="Show each projector's share of the light, and whether the overlap sums to one">
            <ScanEye size={12} /> Inspect
          </Button>
        )}
        <Button size="sm" onClick={solve} disabled={busy}
          title="Compute each projector's share of the light from the scanned 3D maps, so the overlap sums to one">
          {busy ? <><Loader2 size={12} className="animate-spin" /> Solving…</> : 'Solve blend'}
        </Button>
        {solved > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { blendController.clearRig(); toast.success('Rig blend cleared', 'Outputs fall back to the hand-set soft edge.'); }}
            title="Drop the solved blend and fall back to the hand-set soft edge">Clear</Button>
        )}
      </div>

      {open && solved > 0 && (
        <div className="border-t border-line-2">
          <BlendInspector outputs={outputs} />
        </div>
      )}
    </div>
  );
};
