import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Crosshair, Aperture, Loader2 } from 'lucide-react';
import type { MainToProjector } from '../projector/bridge';
import type { ProjectorCalibration, ProjectorOutput } from '../../../shared/protocol';
import * as cam from '../services/calibCapture';
import * as ctl from '../calib/calibController';
import { defaultBoardConfig, type BoardConfig } from '../calib/calibController';

interface Props {
  surfaceId: string;
  surfaceName: string;
  output: ProjectorOutput | undefined;
  sendToProjector: (surfaceId: string, msg: MainToProjector) => void;
  onStoreCalibration: (surfaceId: string, patch: Partial<ProjectorCalibration>) => void;
  onPoseModeChange: (surfaceId: string, on: boolean) => void;
  onClearPoses: (surfaceId: string) => void;
  onClose: () => void;
}

const numCls = 'w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[11px] focus:border-accent focus:outline-none';

// Structured-light projector-intrinsics wizard. Drives the projector through Gray-code patterns while
// a camera watches a checkerboard across poses; calibController accumulates board↔projector
// correspondences and solves intrinsics + distortion. The result is cached on the output's
// calibration (pose is added later in the Pose tab / Phase 3).
export const CalibPanel: React.FC<Props> = ({ surfaceId, surfaceName, output, sendToProjector, onStoreCalibration, onPoseModeChange, onClearPoses, onClose }) => {
  const [tab, setTab] = useState<'intrinsics' | 'pose'>('intrinsics');
  const [devices, setDevices] = useState<cam.CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [camOn, setCamOn] = useState(false);
  const [cfg, setCfg] = useState<BoardConfig>(defaultBoardConfig());
  const [poses, setPoses] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [rms, setRms] = useState<number | null>(output?.calibration?.intrinsicsRms ?? null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const addLog = (s: string) => setLog((l) => [s, ...l].slice(0, 8));

  // Enter pattern mode on the projector; leave + stop the camera on unmount.
  useEffect(() => {
    ctl.begin(surfaceId, (m) => sendToProjector(surfaceId, m));
    enumerate();
    return () => { ctl.end(); cam.stop(); onPoseModeChange(surfaceId, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId]);

  // Switch the projector + scene into the mode for the active tab.
  const switchTab = (t: 'intrinsics' | 'pose') => {
    setTab(t);
    if (t === 'pose') { sendToProjector(surfaceId, { t: 'calib', mode: 'crosshair' }); onPoseModeChange(surfaceId, true); }
    else { sendToProjector(surfaceId, { t: 'calib', mode: 'pattern' }); onPoseModeChange(surfaceId, false); }
  };

  const cal = output?.calibration;
  const hasIntrinsics = cal?.intrinsicsRms != null;
  const poseCount = cal?.posePicks?.length ?? 0;

  const enumerate = async () => {
    try { setDevices(await cam.enumerate()); } catch (e) { addLog(`enumerate failed: ${(e as Error).message}`); }
  };

  const startCam = async () => {
    try {
      setBusy('Starting camera…');
      await cam.start(deviceId || undefined);
      if (videoRef.current) { videoRef.current.srcObject = cam.getStream(); await videoRef.current.play().catch(() => {}); }
      setCamOn(true);
      setDevices(await cam.enumerate()); // labels populate after permission
      const d = cam.dims();
      addLog(`camera ${d.w}×${d.h}`);
    } catch (e) { addLog(`camera failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const capture = async () => {
    setBusy('Capturing pose (projecting Gray-code)…');
    const r = await ctl.capturePose(cfg);
    setBusy(null);
    if ('reason' in r) { addLog(`✗ ${r.reason}`); return; }
    setPoses(r.poses);
    addLog(`pose ${r.poses}: ${r.validCorners}/${r.totalCorners} corners`);
  };

  const solve = async () => {
    setBusy('Solving intrinsics…');
    const r = await ctl.solve();
    setBusy(null);
    if ('error' in r) { addLog(`✗ ${r.error}`); return; }
    setRms(r.rms);
    const raster = ctl.projectorRaster();
    onStoreCalibration(surfaceId, {
      intrinsics: r.k, distortion: r.dist, intrinsicsRms: r.rms, imageSize: [raster.w, raster.h],
    });
    addLog(`✓ intrinsics solved — RMS ${r.rms.toFixed(3)} px`);
  };

  const k = output?.calibration?.intrinsics;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Projector calibration"
        className="w-[680px] max-w-[95vw] max-h-[88vh] flex flex-col bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}>
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><Aperture size={14} /> Calibrate — {surfaceName}</span>
          <button onClick={onClose} aria-label="Close" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
          {(['intrinsics', 'pose'] as const).map((t) => (
            <button key={t} onClick={() => switchTab(t)}
              className={`px-3 py-1 rounded-t text-[11px] border-b-2 ${tab === t ? 'border-accent text-fg-1' : 'border-transparent text-fg-3 hover:text-fg-2'}`}>
              {t === 'intrinsics' ? '1 · Intrinsics' : '2 · Pose'}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 grid grid-cols-[1fr_240px] gap-3">
          {/* Left: controls */}
          <div className="space-y-3 text-[11px]">
            {tab === 'intrinsics' && <>
            <p className="text-fg-3 leading-relaxed">
              <b>Intrinsics (structured light).</b> In a darkened room, point the camera so it sees both a printed
              checkerboard and the projection. Hold the board in ~8–12 varied poses; capture each. Then solve.
            </p>

            {/* Camera */}
            <div className="flex items-center gap-1.5">
              <Camera size={13} className="text-fg-3 shrink-0" />
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                <option value="">Default camera</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
              <button onClick={startCam} className="px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3">{camOn ? 'Restart' : 'Start'}</button>
            </div>

            {/* Board config */}
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1 text-fg-2">Cols<input type="number" min={3} value={cfg.cols} onChange={(e) => setCfg({ ...cfg, cols: Math.max(3, +e.target.value | 0) })} className={numCls} /></label>
              <label className="flex items-center gap-1 text-fg-2">Rows<input type="number" min={3} value={cfg.rows} onChange={(e) => setCfg({ ...cfg, rows: Math.max(3, +e.target.value | 0) })} className={numCls} /></label>
              <label className="flex items-center gap-1 text-fg-2">Square mm<input type="number" min={1} step={0.5} value={+(cfg.squareMeters * 1000).toFixed(1)} onChange={(e) => setCfg({ ...cfg, squareMeters: Math.max(0.001, +e.target.value / 1000) })} className={numCls} /></label>
            </div>
            <p className="text-fg-3 text-[10px] -mt-1.5">Cols/Rows = <i>inner</i> corners (a 10×7-square board = 9×6).</p>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={capture} disabled={!camOn || !!busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 font-medium">
                {busy?.startsWith('Capturing') ? <Loader2 size={13} className="animate-spin" /> : <Crosshair size={13} />} Capture pose
              </button>
              <button onClick={solve} disabled={poses < 3 || !!busy}
                className="px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">
                Solve intrinsics ({poses} pose{poses === 1 ? '' : 's'})
              </button>
            </div>

            {busy && <div className="text-accent flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {busy}</div>}

            {/* Result */}
            <div className="border-t border-line-1 pt-2 space-y-1">
              <div className="text-fg-2">RMS reprojection: <span className="num text-fg-1">{rms != null ? `${rms.toFixed(3)} px` : '—'}</span></div>
              {k && (
                <div className="num text-[10px] text-fg-3">
                  fx {k[0].toFixed(1)} · fy {k[4].toFixed(1)} · cx {k[2].toFixed(1)} · cy {k[5].toFixed(1)}
                </div>
              )}
            </div>

            {/* Log */}
            <div className="border-t border-line-1 pt-2 space-y-0.5 text-[10px] text-fg-3 font-mono">
              {log.map((l, i) => <div key={i} className={l.startsWith('✗') ? 'text-err' : l.startsWith('✓') ? 'text-ok' : ''}>{l}</div>)}
            </div>
            </>}

            {tab === 'pose' && <>
              <p className="text-fg-3 leading-relaxed">
                <b>Pose (venue frame).</b> Intrinsics are fixed; now anchor the projector in the model. On the
                <b> projector</b>, drag/arrow the crosshair onto a known venue feature and press <b>Enter</b>; then
                in the <b>3D Scene</b> window click the matching point on the model. Repeat ≥4 well-spread,
                non-coplanar points — the pose solves automatically and the frustum appears in the scene.
              </p>
              {!hasIntrinsics && <div className="text-err">Solve intrinsics first (tab 1).</div>}
              <div className="border-t border-line-1 pt-2 space-y-1">
                <div className="text-fg-2">Points captured: <span className="num text-fg-1">{poseCount}</span> <span className="text-fg-3">(need ≥4)</span></div>
                <div className="text-fg-2">Pose RMS: <span className="num text-fg-1">{cal?.poseRms != null ? `${cal.poseRms.toFixed(3)} px` : '—'}</span></div>
              </div>
              <button onClick={() => onClearPoses(surfaceId)} disabled={poseCount === 0}
                className="px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">
                Clear points
              </button>
            </>}
          </div>

          {/* Right: camera preview (intrinsics) */}
          <div className="space-y-1.5">
            <div className="aspect-video bg-black rounded border border-line-1 overflow-hidden flex items-center justify-center">
              <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />
            </div>
            <div className="text-[10px] text-fg-3">
              {tab === 'intrinsics'
                ? 'Camera preview. The projector shows calibration patterns full-screen during capture.'
                : 'The projector shows an aim crosshair. Pick matching points in the 3D Scene window.'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
