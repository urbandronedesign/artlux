import React, { useEffect, useState } from 'react';
import { Timer, Camera, Check, AlertTriangle, Loader2, Undo2, Activity } from 'lucide-react';
import type { CalibCameraProfile, AutoRecalConfig, ProjectorOutput } from '../../../shared/protocol';
import { defaultAutoRecalConfig } from '../../../shared/protocol';
import { Button, Toggle, NumberField, Field } from '@/components/ui';
import { useToast } from '@/components/ui/feedback';
import * as autoRecal from './autoRecal';
import * as cam from './calibCapture';
import * as calibNative from './calibNative';
import { getRig, patchRig, getHost, saveProject } from './calibHost';

// Commissioning + status for the unattended recalibration.
//
// The organising idea: EVERY prerequisite is visible and named. A maintenance task that silently
// cannot run is worse than one that fails loudly — for a year nothing happens and nobody knows why —
// so each precondition gets a row saying whether it is met and what to do about it, and autoApply
// sits behind copy that is blunt rather than decorative.

const CORNER_ORDER = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

const Prereq: React.FC<{ ok: boolean; label: string; detail: string }> = ({ ok, label, detail }) => (
  // Status is glyph + colour, never colour alone (DESIGN-SYSTEM §6).
  <div className="flex items-start gap-2 text-mini">
    {ok
      ? <Check size={12} className="text-ok shrink-0 mt-0.5" aria-hidden />
      : <AlertTriangle size={12} className="text-warn shrink-0 mt-0.5" aria-hidden />}
    <span className="sr-only">{ok ? 'ready:' : 'not ready:'}</span>
    <span className="text-fg-1 w-40 shrink-0">{label}</span>
    <span className="text-fg-2">{detail}</span>
  </div>
);

export const RecalPanel: React.FC = () => {
  const [, bump] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const toast = useToast();

  const rig = getRig();
  const cfg: AutoRecalConfig = { ...defaultAutoRecalConfig(), ...(rig.autoRecal ?? {}) };
  const scene = (getHost()?.scene3D.get() ?? {}) as { markerMap?: { markers: { worldCorners?: unknown }[] } };
  const outs = ((getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[])
    .filter((o) => o.enabled && o.calibration?.poseRms != null);
  const markers = scene.markerMap?.markers ?? [];
  const cornered = markers.filter((m) => m.worldCorners).length;
  const refs = rig.references ?? [];

  useEffect(() => { void calibNative.calibAuditTail(12).then(setAudit); }, [busy]);
  useEffect(() => getHost()?.scene3D.subscribe(() => bump((n) => n + 1)) ?? (() => {}), []);

  const patchCfg = (p: Partial<AutoRecalConfig>) => { patchRig({ autoRecal: { ...cfg, ...p } }); bump((n) => n + 1); };
  const say = (l: string) => setLog((prev) => [...prev.slice(-40), l]);

  // Save the camera EXACTLY as it is running now — device, mode and every property. An unattended run
  // cannot pick a camera from a dialog, and a measurement taken at a different exposure is not
  // comparable to the reference it will be judged against.
  const saveCameraProfile = async () => {
    setBusy('camera');
    try {
      const live = cam.current();
      if (!live) { toast.error('Start the camera first', 'The profile records the LIVE settings — open the Calibration workbench and start it.'); return; }
      const props: Record<string, number> = {};
      for (const k of ['exposure', 'gain', 'autoexposure', 'auto_wb', 'wb_temperature', 'autofocus', 'focus']) {
        const v = await cam.getProp(k);
        if (typeof v === 'number' && Number.isFinite(v)) props[k] = v;
      }
      const prev = rig.camera;
      const profile: CalibCameraProfile = {
        source: live.source, index: live.index, deviceId: live.deviceId,
        width: live.w, height: live.h, fps: live.fps ?? 30, fourcc: live.fourcc,
        props,
        cameraK: prev?.cameraK ?? [], cameraDist: prev?.cameraDist ?? [0, 0, 0, 0, 0],
        hfovDeg: prev?.hfovDeg,
      };
      patchRig({ camera: profile });
      const saved = await saveProject();
      toast.success('Camera profile saved',
        `${live.source} · ${live.w}×${live.h} · ${Object.keys(props).length} properties${saved ? '' : ' — project not saved (no file yet)'}`);
      bump((n) => n + 1);
    } finally { setBusy(null); }
  };

  const runNow = async (mode: 'check' | 'full') => {
    setBusy(mode);
    setLog([]);
    try {
      const rep = await autoRecal.run({ mode, manual: true, log: say });
      if (rep.aborted) { toast.error('Recalibration did not run', rep.aborted); say(`✗ ${rep.aborted}`); return; }
      const bad = rep.results.filter((r) => r.outcome === 'gross-fault' || r.outcome === 'aborted');
      if (bad.length) toast.error(`${bad.length} output(s) need attention`, bad[0].detail);
      else toast.success(mode === 'check' ? 'Drift check complete' : 'Recalibration complete', `${rep.results.length} output(s)`);
      bump((n) => n + 1);
    } finally { setBusy(null); }
  };

  const canRun = !!rig.camera && rig.camera.cameraK.length === 9 && refs.length > 0 && outs.length > 0;

  return (
    <div className="space-y-3 text-xs">
      <p className="text-fg-2 leading-relaxed">
        Measures whether each projector still lands where its calibration says, on a schedule, and — when
        allowed — re-solves and applies. Schedule it with a <b className="text-fg-1">recalibrate</b> entry in
        Show Control, or run it here.
      </p>

      {/* Every prerequisite, named. A task that silently cannot run is the failure nobody notices. */}
      <div className="space-y-1.5 p-2 rounded-md bg-surface-1 border border-line-1">
        <div className="text-mini uppercase tracking-wider text-fg-2">Prerequisites</div>
        <Prereq ok={!!rig.camera} label="Camera profile"
          detail={rig.camera ? `${rig.camera.source} · ${rig.camera.width}×${rig.camera.height}` : 'start the camera, then Save profile below'} />
        <Prereq ok={(rig.camera?.cameraK.length ?? 0) === 9} label="Camera intrinsics"
          detail={(rig.camera?.cameraK.length ?? 0) === 9
            ? `fx ${rig.camera!.cameraK[0].toFixed(0)} px`
            : 'run one Auto-Align scan — it records the intrinsics it used'} />
        <Prereq ok={cornered >= 2} label="Markers with corners"
          detail={`${cornered} of ${markers.length} registered with 4 corners — a centre-only marker is refused unattended`} />
        <Prereq ok={refs.length > 0 && refs.length >= outs.length} label="Reference observations"
          detail={`${refs.length} of ${outs.length} calibrated outputs — created by an Auto-Align scan`} />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={saveCameraProfile} disabled={!!busy}>
          {busy === 'camera' ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} Save camera profile
        </Button>
        <Button size="sm" onClick={() => runNow('check')} disabled={!!busy || !canRun}
          title={canRun ? 'Measure drift only — never writes' : 'The prerequisites above are not met yet'}>
          {busy === 'check' ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />} Check now
        </Button>
        <Button size="sm" variant="ghost" onClick={() => runNow('full')} disabled={!!busy || !canRun}
          title="Re-solve any projector whose drift exceeds the warn threshold">
          {busy === 'full' ? <Loader2 size={12} className="animate-spin" /> : null} Full run
        </Button>
      </div>

      {/* ── Policy ── */}
      <div className="space-y-2 pt-2 border-t border-line-1">
        <div className="text-mini uppercase tracking-wider text-fg-2">Policy</div>
        <Toggle label="Enabled" checked={cfg.enabled} onChange={(v) => patchCfg({ enabled: v })}
          title="A scheduled recalibrate entry still has to fire it" />
        <Toggle label="Apply automatically" checked={cfg.autoApply} onChange={(v) => patchCfg({ autoApply: v })}
          title="Allow a run to write a new calibration with nobody present" />
        {/* Blunt on purpose. The pipeline has never been validated against a real projector, and a bad
            apply at 4am has no undo in show mode and no crash-recovery file behind it. */}
        <p className={`text-mini leading-snug ${cfg.autoApply ? 'text-warn' : 'text-fg-2'}`}>
          {cfg.autoApply
            ? '⚠ A run may overwrite a working calibration with nobody present. Turn this on only after an attended run has shown the thresholds below match this rig. The previous calibration is kept — Revert below restores it.'
            : 'Off: runs measure, report and log, but never write. Leave it here until commissioning is done.'}
        </p>

        <Field label="Window" labelWidth="w-32">
          <div className="flex items-center gap-1.5">
            <input aria-label="Window start" value={cfg.window?.start ?? ''}
              onChange={(e) => patchCfg({ window: { start: e.target.value, end: cfg.window?.end ?? '05:30' } })}
              className="w-16 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 font-mono text-micro focus-visible:border-accent" />
            <span className="text-fg-2" aria-hidden>→</span>
            <input aria-label="Window end" value={cfg.window?.end ?? ''}
              onChange={(e) => patchCfg({ window: { start: cfg.window?.start ?? '03:30', end: e.target.value } })}
              className="w-16 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 font-mono text-micro focus-visible:border-accent" />
            <span className="text-mini text-fg-2">refused outside this, even if scheduled</span>
          </div>
        </Field>
        <NumberField label="Drift warn (mm)" labelWidth="w-32" value={cfg.driftWarnMm} step={1} min={0} onChange={(v) => patchCfg({ driftWarnMm: v })} />
        <NumberField label="Drift fail (mm)" labelWidth="w-32" value={cfg.driftFailMm} step={1} min={0} onChange={(v) => patchCfg({ driftFailMm: v })} />
        <p className="text-mini text-fg-2 leading-snug">Past <b className="text-fg-1">fail</b> it alerts and refuses to solve — a projector that far out still solves &ldquo;successfully&rdquo;, and the answer is wrong.</p>
        <NumberField label="Max pose jump (m)" labelWidth="w-32" value={cfg.maxPoseJumpM} step={0.01} min={0} onChange={(v) => patchCfg({ maxPoseJumpM: v })} />
        <NumberField label="Max rotation (°)" labelWidth="w-32" value={cfg.maxPoseJumpDeg} step={0.5} min={0} onChange={(v) => patchCfg({ maxPoseJumpDeg: v })} />
        <p className="text-mini text-fg-2 leading-snug">A bolted projector did not move that far. A large jump with a <i>good</i> score means the camera anchor is wrong — that is the case this gate exists for.</p>
        <NumberField label="Improve factor" labelWidth="w-32" value={cfg.improveFactor} step={0.05} min={0.1} max={1} onChange={(v) => patchCfg({ improveFactor: v })} />
      </div>

      {/* ── Per-output status + the way back ── */}
      {outs.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-line-1">
          <div className="text-mini uppercase tracking-wider text-fg-2">Outputs</div>
          {outs.map((o) => {
            const ref = refs.find((r) => r.surfaceId === o.surfaceId);
            return (
              <div key={o.surfaceId} className="flex items-center gap-2 text-mini">
                <span className="text-fg-1 truncate flex-1 font-mono">{o.surfaceId.slice(0, 8)}</span>
                <span className="text-fg-2 font-mono">{ref ? `baseline ${ref.baseline.rmsPx.toFixed(2)} px` : 'no reference'}</span>
                {o.calibrationPrev && (
                  <Button size="sm" variant="ghost"
                    onClick={async () => {
                      const okRevert = await autoRecal.revertCalibration(o.surfaceId);
                      if (okRevert) toast.success('Calibration reverted', 'The previous calibration is live again.');
                      else toast.error('Nothing to revert', 'This output has no previous calibration stored.');
                      bump((n) => n + 1);
                    }}
                    title="Restore the calibration this one replaced">
                    <Undo2 size={11} /> Revert
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {markers.length > 0 && cornered < markers.length && (
        <p className="text-mini text-fg-2 leading-snug">
          {markers.length - cornered} marker(s) are registered by centre only. Re-register them with the{' '}
          <b className="text-fg-1">⌗</b> button in Auto-Align &rarr; Anchor, clicking{' '}
          {CORNER_ORDER.join(', ')} on the model.
        </p>
      )}

      {log.length > 0 && (
        <pre role="log" aria-live="polite"
          className="text-micro text-fg-2 bg-bg-stage border border-line-1 rounded-md p-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
          {log.join('\n')}
        </pre>
      )}

      {audit.length > 0 && (
        <details className="text-mini">
          <summary className="text-fg-2 cursor-pointer">Recent runs ({audit.length})</summary>
          <pre className="text-micro text-fg-2 mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono">
            {audit.map((a) => `${String(a.ts).slice(0, 19)}  ${String(a.event)}  ${String(a.outcome ?? '')} ${String(a.detail ?? '')}`).join('\n')}
          </pre>
        </details>
      )}
    </div>
  );
};
