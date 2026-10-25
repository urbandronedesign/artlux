// TEST & SIGN-OFF — ArtLux Calibrator's inspector on the Test & sign-off context (suite plan Phase 3,
// step 5; design S5).
//
// Three jobs, in the order they happen on site:
//   1. a TEST SOURCE on every screen (the Calibrator OPENS on it — services/testSource.ts) the rig lights — the UV checker, Full HD or 4K — with the show's own
//      content kept in the project (calibRig.testBackup) while it plays, so "back to the show" and the
//      hand-off to ArtLux Show can always restore it, even after a save;
//   2. a SIGNED CHECKLIST: who checked the wall, when, against which calibration — stale the moment a
//      projector is recalibrated after it (signOffStale);
//   3. the hand-off: export a calibration file if the show needs one, then open the project in ArtLux Show.

import React, { useState } from 'react';
import { Button, Segmented } from '@/components/ui';
import { useToast } from '@/components/ui/feedback';
import type { CalibSignOff, ProjectorOutput, Scene3D } from '../../../shared/protocol';
import { testTargets, uvCheckerContent } from '@/services/testSource'; // host helpers — the ONE definition, shared with the open
import { getHost, getRig, patchRig, exportRigMpcdi, saveProject } from './calibHost';
import { useOutputs, useScene, useSurfaces, type SurfaceLite } from './useHostData';
import * as rigUi from './rigUi';

const CHECKS = [
  'The coloured corners land on the right corners',
  'Grid lines run straight across every seam',
  'No bright or dark band in the overlaps',
  'Sharp everywhere — focus',
  'Blacks match between projectors',
];

type Source = 'show' | 'fhd' | '4k';

/** A sign-off no longer describes the rig: a projector recalibrated or re-blended after it, or the rig changed. */
export function signOffStale(s: CalibSignOff, outputs: ProjectorOutput[]): boolean {
  const live = outputs.filter((o) => o.enabled && o.calibration?.poseRms != null);
  if (live.length !== s.rig.length) return true;
  return live.some((o) => {
    const r = s.rig.find((x) => x.surfaceId === o.surfaceId);
    return !r || r.calibratedAt !== o.calibration?.calibratedAt || r.blendSolvedAt !== o.blend?.solvedAt;
  });
}

function currentSource(backup: Record<string, unknown> | undefined, surfaces: SurfaceLite[]): Source {
  if (!backup) return 'show';
  const s = surfaces.find((x) => x.id in backup);
  return s?.content.uvChecker?.size === '4k' ? '4k' : 'fhd';
}

export const SignoffPanel: React.FC = () => {
  const outputs = useOutputs();
  const surfaces = useSurfaces();
  const scene = useScene();
  const toast = useToast();
  const host = getHost();
  const backup = scene.calibRig?.testBackup;
  const source = currentSource(backup, surfaces);
  const signOff = scene.calibRig?.signOff;
  const seat = scene.calibRig?.audienceSeat;
  const [by, setBy] = useState(signOff?.by ?? '');
  const [checks, setChecks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const setSource = (next: Source) => {
    const set = host?.surfaces.setContent;
    if (!set) { toast.error('Cannot change content', 'This build offers no way to set a surface\'s content.'); return; }
    const targets = testTargets(scene, outputs);
    if (next === 'show') {
      // Back to the show: every surface we replaced gets its own content back, then the backup goes.
      for (const [id, content] of Object.entries(backup ?? {})) set(id, content);
      patchRig({ testBackup: undefined });
      return;
    }
    if (!targets.length) { toast.warn('Nothing to test', 'No surface reaches a projector yet — bind a screen or switch an output on.'); return; }
    // Keep the SHOW content once — switching Full HD ↔ 4K must not back up the test card itself.
    const keep = backup ?? Object.fromEntries(targets.map((id) => [id, surfaces.find((s) => s.id === id)?.content]).filter(([, c]) => c));
    patchRig({ testBackup: keep });
    for (const id of Object.keys(keep)) {
      set(id, uvCheckerContent(next));
    }
  };

  const sign = async () => {
    const live = outputs.filter((o) => o.enabled && o.calibration?.poseRms != null);
    patchRig({
      signOff: {
        by: by.trim(), at: new Date().toISOString(), checks,
        rig: live.map((o) => ({ surfaceId: o.surfaceId, calibratedAt: o.calibration?.calibratedAt, blendSolvedAt: o.blend?.solvedAt })),
      },
    });
    const ok = await saveProject();
    toast[ok ? 'success' : 'warn'](ok ? 'Signed off and saved' : 'Signed off — save the project to keep it', `${by.trim()}, ${new Date().toLocaleString()}`);
    setChecks([]);
  };

  const exportFile = async () => {
    setBusy(true);
    try { const msg = await exportRigMpcdi(); (msg.startsWith('✓') ? toast.success : toast.warn)('Calibration file', msg.replace(/^[✓✗] /, '')); }
    finally { setBusy(false); }
  };

  const handOff = async () => {
    // The show takes the wall back: its content, no solo/mute, saved — then ArtLux Show opens it.
    if (getRig().testBackup) setSource('show');
    rigUi.clearSoloMute();
    await new Promise((r) => setTimeout(r, 150)); // let the restore land in the document (React state + its refs) before saving
    const ok = await saveProject();
    const path = host?.project.path();
    if (!ok || !path) { toast.warn('Save first', 'Save the project to a file, then open it in ArtLux Show.'); return; }
    window.artlux?.openInOtherApp?.(path);
  };

  const stale = signOff ? signOffStale(signOff, outputs) : false;
  const allChecked = CHECKS.every((c) => checks.includes(c));

  return (
    <div className="p-3 flex flex-col gap-3 text-xs">
      <div className="text-mini uppercase tracking-wider text-fg-2">Test source</div>
      <Segmented<Source> value={source} onChange={setSource}
        options={[{ value: 'show', label: 'Show content' }, { value: 'fhd', label: 'UV · Full HD' }, { value: '4k', label: 'UV · 4K' }]} />
      <p className="text-mini text-fg-2 m-0">
        {source === 'show' ? 'The screens play the show. Pick the UV checker to judge the calibration on the wall.'
          : 'Every screen the rig lights plays the UV checker. The show content is kept and comes back with “Show content”.'}
      </p>

      <div className="h-px bg-line-1" />

      {/* THE AUDIENCE SEAT (decision 15): judge the wall from where people will stand, not from wherever
          the orbit camera happened to be. Saved in the project (calibRig.audienceSeat). */}
      <div className="text-mini uppercase tracking-wider text-fg-2">Audience seat</div>
      <div className="flex gap-1.5">
        <Button variant="tonal" size="sm" className="flex-1" disabled={!host?.scene3D.captureView}
          onClick={() => {
            const v = host?.scene3D.captureView?.();
            if (!v) { toast.warn('No 3D view', 'Open the venue in 3D, frame the wall from the audience, then save.'); return; }
            patchRig({ audienceSeat: v });
            toast.success('Audience seat saved', 'Go to the seat brings the 3D view back here.');
          }}>Save this view</Button>
        <Button variant="tonal" size="sm" className="flex-1" disabled={!seat}
          title={seat ? 'Look at the venue from the saved seat' : 'Save a seat first'}
          onClick={() => {
            if (!seat) return;
            // A seat is an EDITOR-camera viewpoint: leave any through-projector view first.
            if ((scene as { viewFrom?: string }).viewFrom) host?.scene3D.patch({ viewFrom: undefined } as Partial<Scene3D>);
            setTimeout(() => host?.scene3D.applyView?.(seat), 50);
          }}>Go to the seat</Button>
      </div>

      <div className="h-px bg-line-1" />

      <div className="text-mini uppercase tracking-wider text-fg-2">Sign-off</div>
      {signOff && (
        <div className={`text-mini ${stale ? 'text-warn' : 'text-ok'}`}>
          {stale ? '⚠ ' : '✓ '}Signed by {signOff.by}, {new Date(signOff.at).toLocaleString()}{stale ? ' — the rig changed since' : ''}
        </div>
      )}
      <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
        <legend className="sr-only">Checks on the wall</legend>
        {CHECKS.map((c) => (
          <label key={c} className="flex items-start gap-2 text-mini text-fg-1 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={checks.includes(c)}
              onChange={(e) => setChecks((xs) => (e.target.checked ? [...xs, c] : xs.filter((x) => x !== c)))} />
            {c}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-mini text-fg-2">
        Signed by
        <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Your name"
          className="bg-surface-0 border border-line-2 rounded-sm px-2 py-1 text-xs text-fg-1 focus:border-accent" />
      </label>
      <Button variant="tonal" onClick={() => void sign()} disabled={!allChecked || !by.trim()}>
        {allChecked && by.trim() ? 'Sign off' : 'Tick every check and add your name to sign'}
      </Button>

      <div className="flex-1" />

      <div className="flex flex-col gap-1.5">
        <Button variant="ghost" onClick={() => void exportFile()} disabled={busy}>Export calibration file…</Button>
        <Button variant="primary" onClick={() => void handOff()}>Open in ArtLux Show</Button>
      </div>
    </div>
  );
};
