import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Camera, Check, AlertTriangle, Loader2, ChevronLeft, ChevronRight, Aperture, MonitorUp, Box, Crosshair } from 'lucide-react';
import type { MainToProjector } from '../projector/bridge';
import type { ProjectorCalibration, ProjectorOutput, Scene3D } from '../../../shared/protocol';
import * as cam from '../services/calibCapture';
import * as ctl from '../calib/calibController';
import { defaultBoardConfig, type BoardConfig } from '../calib/calibController';

interface Props {
  surfaceId: string;
  surfaceName: string;
  output: ProjectorOutput | undefined;
  scene3D: Scene3D;
  live: boolean;        // projector output is enabled + on a connected display
  hasModel: boolean;    // a visible venue mesh is loaded (needed for the pose step)
  sendToProjector: (surfaceId: string, msg: MainToProjector) => void;
  onStoreCalibration: (surfaceId: string, patch: Partial<ProjectorCalibration>) => void;
  onPoseModeChange: (surfaceId: string, on: boolean) => void;
  onClearPoses: (surfaceId: string) => void;
  onSetUseCalibration: (surfaceId: string, on: boolean) => void;
  onSetCalibPickMode: (on: boolean) => void;
  onSetSplit: (on: boolean) => void;
  onClose: () => void;
}

type Step = 'prereq' | 'camera' | 'intrinsics' | 'pose' | 'verify';
const STEPS: { id: Step; label: string }[] = [
  { id: 'prereq', label: 'Setup' },
  { id: 'camera', label: 'Camera' },
  { id: 'intrinsics', label: 'Lens' },
  { id: 'pose', label: 'Pose' },
  { id: 'verify', label: 'Verify' },
];

// RMS quality bands (px) → color + label.
const intrinsicsBand = (r: number) => (r < 1 ? 'ok' : r < 2 ? 'warn' : 'danger');
const poseBand = (r: number) => (r < 2 ? 'ok' : r < 5 ? 'warn' : 'danger');
const bandColor = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' } as const;

const numCls = 'w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[11px] focus:border-accent focus:outline-none';

type Detect = { found: true; corners: number[]; w: number; h: number } | { found: false };

// Professional guided calibration wizard (replaces the tabbed CalibPanel). A left rail of steps that
// reuses the calibration backend (calibController + calibCapture) and the App calibration handlers; the
// pose step picks directly on the embedded Simulator3D (right split pane).
export const CalibWizard: React.FC<Props> = (props) => {
  const { surfaceId, surfaceName, output, scene3D, live, hasModel,
    sendToProjector, onStoreCalibration, onPoseModeChange, onClearPoses, onSetUseCalibration,
    onSetCalibPickMode, onSetSplit, onClose } = props;

  const [step, setStep] = useState<Step>('prereq');
  const [addonOk, setAddonOk] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<cam.CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [cfg, setCfg] = useState<BoardConfig>(defaultBoardConfig());
  const [poses, setPoses] = useState(0);
  const [coverage, setCoverage] = useState<{ cx: number; cy: number; areaFrac: number }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [detect, setDetect] = useState<Detect>({ found: false });
  const [testProj, setTestProj] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const cal = output?.calibration;
  const hasIntrinsics = cal?.intrinsicsRms != null;
  const poseSolved = cal?.poseRms != null;
  const poseCount = cal?.posePicks?.length ?? 0;
  const addLog = (s: string) => setLog((l) => [s, ...l].slice(0, 6));
  const send = (m: MainToProjector) => sendToProjector(surfaceId, m);
  const showWhite = () => send({ t: 'calibPattern', kind: 'white', index: -1 });

  // Mount: start the SL session, check the addon + cameras, force the split on (3D visible). Cleanup.
  useEffect(() => {
    ctl.begin(surfaceId, (m) => sendToProjector(surfaceId, m));
    onSetSplit(true);
    window.artlux?.calibAvailable?.().then((v) => setAddonOk(!!v)).catch(() => setAddonOk(false));
    cam.enumerate().then(setDevices).catch(() => {});
    return () => { ctl.end(); cam.stop(); onSetCalibPickMode(false); onPoseModeChange(surfaceId, false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId]);

  // Drive projector + scene modes per step.
  useEffect(() => {
    if (step === 'camera' || step === 'intrinsics') {
      send({ t: 'calib', mode: 'pattern' }); showWhite();
      onSetCalibPickMode(false); onPoseModeChange(surfaceId, false);
    } else if (step === 'pose') {
      send({ t: 'calib', mode: 'crosshair' });
      onSetCalibPickMode(true); onPoseModeChange(surfaceId, true); onSetSplit(true);
    } else if (step === 'verify') {
      onSetCalibPickMode(false); onPoseModeChange(surfaceId, false);
      if (testProj && cal) { send({ t: 'scene', scene3D }); send({ t: 'calib', mode: 'render', calibration: cal }); }
      else send({ t: 'calib', mode: 'idle' });
    } else {
      send({ t: 'calib', mode: 'idle' }); onSetCalibPickMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, testProj]);

  // Live board-detect overlay on the camera (camera/intrinsics steps, paused during a capture).
  useEffect(() => {
    if ((step !== 'camera' && step !== 'intrinsics') || !camOn || busy) return;
    let alive = true;
    const tick = async () => {
      const g = cam.grabGray();
      if (g && window.artlux?.calibDetectBoard) {
        const d = await window.artlux.calibDetectBoard(g.data.buffer as ArrayBuffer, g.w, g.h, cfg.cols, cfg.rows);
        if (alive) setDetect(d && d.found ? { found: true, corners: d.corners, w: g.w, h: g.h } : { found: false });
      }
    };
    const id = window.setInterval(tick, 350);
    return () => { alive = false; window.clearInterval(id); };
  }, [step, camOn, busy, cfg.cols, cfg.rows]);

  const startCam = async () => {
    try {
      setBusy('Starting camera…');
      await cam.start(deviceId || undefined);
      if (videoRef.current) { videoRef.current.srcObject = cam.getStream(); await videoRef.current.play().catch(() => {}); }
      setCamOn(true);
      setDevices(await cam.enumerate());
      const d = cam.dims(); addLog(`camera ${d.w}×${d.h}`);
    } catch (e) { addLog(`✗ camera: ${(e as Error).message}`); }
    finally { setBusy(null); }
  };

  const capture = async () => {
    setBusy('Capturing — hold the board still…');
    const r = await ctl.capturePose(cfg);
    setBusy(null);
    showWhite();
    if ('reason' in r) { addLog(`✗ ${r.reason}`); return; }
    setPoses(r.poses);
    setCoverage((c) => [...c, r.bbox]);
    addLog(`pose ${r.poses}: ${r.validCorners}/${r.totalCorners} corners`);
  };

  const solveIntrinsics = async () => {
    setBusy('Solving lens…');
    const r = await ctl.solve();
    setBusy(null);
    if ('error' in r) { addLog(`✗ ${r.error}`); return; }
    const raster = ctl.projectorRaster();
    onStoreCalibration(surfaceId, { intrinsics: r.k, distortion: r.dist, intrinsicsRms: r.rms, imageSize: [raster.w, raster.h] });
    addLog(`✓ lens solved — RMS ${r.rms.toFixed(3)} px`);
  };

  // --- step gating ---
  const cameraPresent = devices.length > 0 || camOn;
  const gate: Record<Step, { ok: boolean; why: string }> = {
    prereq: { ok: addonOk === true && live && cameraPresent, why: 'Resolve the setup checklist first' },
    camera: { ok: camOn, why: 'Start the camera' },
    intrinsics: { ok: hasIntrinsics && hasModel, why: hasIntrinsics ? 'Load a venue model for the pose step' : 'Solve the lens first' },
    pose: { ok: poseSolved, why: 'Capture ≥4 pose points until the pose solves' },
    verify: { ok: true, why: '' },
  };
  const idx = STEPS.findIndex(s => s.id === step);
  const canNext = gate[step].ok;
  const next = () => { if (idx < STEPS.length - 1) setStep(STEPS[idx + 1].id); };
  const back = () => { if (idx > 0) setStep(STEPS[idx - 1].id); };
  const finish = () => { onSetUseCalibration(surfaceId, true); onClose(); };

  return (
    <div className="fixed left-0 top-9 bottom-6 z-[120] w-[340px] flex flex-col bg-surface-1 border-r border-line-2 shadow-2xl animate-overlay-in">
      {/* Header */}
      <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
        <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><Aperture size={14} /> Calibrate — {surfaceName}</span>
        <button onClick={onClose} aria-label="Close" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
      </div>

      {/* Stepper */}
      <div className="flex items-center px-2 py-2 gap-1 shrink-0 border-b border-line-1">
        {STEPS.map((s, i) => {
          const done = i < idx, cur = i === idx;
          return (
            <React.Fragment key={s.id}>
              <button onClick={() => i <= idx && setStep(s.id)} disabled={i > idx}
                className={`flex items-center gap-1 text-[10px] ${cur ? 'text-accent' : done ? 'text-fg-2' : 'text-fg-3'}`}>
                <span className={`w-4 h-4 rounded-full grid place-items-center text-[9px] border ${cur ? 'border-accent text-accent' : done ? 'border-ok text-ok' : 'border-line-2'}`}>
                  {done ? <Check size={10} /> : i + 1}
                </span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-line-1" />}
            </React.Fragment>
          );
        })}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-[11px]">
        {step === 'prereq' && (
          <>
            <p className="text-fg-3 leading-relaxed">This wizard recovers the projector's lens + position so the 3D scene can be projected onto the real surface. You'll need a <b>printed checkerboard</b>, a <b>camera</b>, and a <b>darkened room</b>.</p>
            <PrereqRow ok={addonOk} label="Calibration engine installed">
              {addonOk === false && <span className="text-fg-3">Run <span className="num">npm run build:calib</span> on an OpenCV host.</span>}
            </PrereqRow>
            <PrereqRow ok={live} label="Projector output live">
              {!live && <span className="text-fg-3">Enable this output on a display in the Outputs panel.</span>}
            </PrereqRow>
            <PrereqRow ok={cameraPresent} label="Camera detected">
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                className="mt-1 w-full bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                <option value="">Default camera</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
            </PrereqRow>
            <PrereqRow ok={hasModel} warnOnly label="Venue model loaded (for pose)">
              {!hasModel && <span className="text-fg-3">Add a GLB in the Scene panel; needed for the Pose step.</span>}
            </PrereqRow>
            <div className="text-fg-3 flex items-center gap-1.5 pt-1"><AlertTriangle size={12} className="text-warn" /> Dim the room so the projection dominates.</div>
          </>
        )}

        {(step === 'camera' || step === 'intrinsics') && (
          <>
            <CameraView videoRef={videoRef} detect={detect} />
            <div className="flex items-center gap-1.5">
              <Camera size={13} className="text-fg-3 shrink-0" />
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                <option value="">Default camera</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
              </select>
              <button onClick={startCam} className="px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3">{camOn ? 'Restart' : 'Start'}</button>
            </div>
            <div className={`text-[10px] flex items-center gap-1 ${detect.found ? 'text-ok' : 'text-fg-3'}`}>
              {detect.found ? <><Check size={11} /> checkerboard detected</> : 'point the camera at the board + projection; board not detected yet'}
            </div>

            {step === 'camera' && (
              <>
                <div className="flex items-center gap-3 flex-wrap border-t border-line-1 pt-2">
                  <label className="flex items-center gap-1 text-fg-2">Cols<input type="number" min={3} value={cfg.cols} onChange={(e) => setCfg({ ...cfg, cols: Math.max(3, +e.target.value | 0) })} className={numCls} /></label>
                  <label className="flex items-center gap-1 text-fg-2">Rows<input type="number" min={3} value={cfg.rows} onChange={(e) => setCfg({ ...cfg, rows: Math.max(3, +e.target.value | 0) })} className={numCls} /></label>
                  <label className="flex items-center gap-1 text-fg-2">mm<input type="number" min={1} step={0.5} value={+(cfg.squareMeters * 1000).toFixed(1)} onChange={(e) => setCfg({ ...cfg, squareMeters: Math.max(0.001, +e.target.value / 1000) })} className={numCls} /></label>
                </div>
                <p className="text-fg-3 text-[10px]">Cols/Rows = <i>inner</i> corners (10×7-square board = 9×6). The projector shows white to light the board.</p>
              </>
            )}

            {step === 'intrinsics' && (
              <>
                <div className="border-t border-line-1 pt-2">
                  <div className="text-fg-2 mb-1">Coverage <span className="text-fg-3">— vary position + tilt + distance</span></div>
                  <CoverageGrid coverage={coverage} />
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={capture} disabled={!camOn || !!busy}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 font-medium">
                    {busy?.startsWith('Capturing') ? <Loader2 size={13} className="animate-spin" /> : <Crosshair size={13} />} Capture ({poses})
                  </button>
                  <button onClick={solveIntrinsics} disabled={poses < 3 || !!busy}
                    className="px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">Solve lens</button>
                </div>
                {cal?.intrinsicsRms != null && (
                  <div className="text-fg-2">Lens RMS: <QualityBadge value={cal.intrinsicsRms} band={intrinsicsBand(cal.intrinsicsRms)} /></div>
                )}
              </>
            )}
          </>
        )}

        {step === 'pose' && (
          <>
            <p className="text-fg-3 leading-relaxed">Anchor the projector in the venue. On the <b>projector</b>, drag/arrow the crosshair onto a distinct feature and press <b>Enter</b>; then click the same point on the model in the <b>3D view (right)</b>. Repeat ≥4 well-spread, non-coplanar points.</p>
            {!hasModel && <div className="text-danger flex items-center gap-1"><AlertTriangle size={12} /> No venue model — add a GLB in the Scene panel.</div>}
            <div className="border-t border-line-1 pt-2 space-y-1">
              <div className="text-fg-2">Points: <span className="num text-fg-1">{poseCount}</span> <span className="text-fg-3">/ ≥4</span></div>
              <div className="text-fg-2">Pose RMS: {cal?.poseRms != null ? <QualityBadge value={cal.poseRms} band={poseBand(cal.poseRms)} /> : <span className="text-fg-3">—</span>}</div>
            </div>
            <button onClick={() => onClearPoses(surfaceId)} disabled={poseCount === 0}
              className="px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">Clear points</button>
          </>
        )}

        {step === 'verify' && (
          <>
            <p className="text-fg-3 leading-relaxed">Confirm the result. Enable <b>test projection</b> to render the venue from the matched projector and check alignment on the real surface.</p>
            <div className="border-t border-line-1 pt-2 space-y-1">
              <div className="text-fg-2">Lens RMS: {cal?.intrinsicsRms != null ? <QualityBadge value={cal.intrinsicsRms} band={intrinsicsBand(cal.intrinsicsRms)} /> : '—'}</div>
              <div className="text-fg-2">Pose RMS: {cal?.poseRms != null ? <QualityBadge value={cal.poseRms} band={poseBand(cal.poseRms)} /> : '—'}</div>
              {cal?.intrinsics && <div className="num text-[10px] text-fg-3">fx {cal.intrinsics[0].toFixed(1)} · fy {cal.intrinsics[4].toFixed(1)} · cx {cal.intrinsics[2].toFixed(1)} · cy {cal.intrinsics[5].toFixed(1)}</div>}
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
              <input type="checkbox" checked={testProj} onChange={(e) => setTestProj(e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
              <MonitorUp size={12} className="text-fg-3" /> Test projection (render venue from projector)
            </label>
          </>
        )}

        {busy && <div className="text-accent flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {busy}</div>}
        {log.length > 0 && (
          <div className="border-t border-line-1 pt-2 space-y-0.5 text-[10px] text-fg-3 font-mono">
            {log.map((l, i) => <div key={i} className={l.startsWith('✗') ? 'text-danger' : l.startsWith('✓') ? 'text-ok' : ''}>{l}</div>)}
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="h-11 px-3 flex items-center justify-between border-t border-line-1 bg-surface-2 shrink-0">
        <button onClick={back} disabled={idx === 0} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-fg-2 hover:text-fg-1 disabled:opacity-30"><ChevronLeft size={13} /> Back</button>
        {step === 'verify' ? (
          <button onClick={finish} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover font-medium text-[11px]"><Check size={13} /> Apply &amp; finish</button>
        ) : (
          <button onClick={next} disabled={!canNext} title={!canNext ? gate[step].why : ''}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 font-medium text-[11px]">Next <ChevronRight size={13} /></button>
        )}
      </div>
    </div>
  );
};

// --- subcomponents ---

const PrereqRow: React.FC<{ ok: boolean | null; warnOnly?: boolean; label: string; children?: React.ReactNode }> = ({ ok, warnOnly, label, children }) => (
  <div className="flex items-start gap-2">
    <span className="mt-0.5 shrink-0">
      {ok === null ? <Loader2 size={13} className="animate-spin text-fg-3" />
        : ok ? <Check size={13} className="text-ok" />
        : warnOnly ? <AlertTriangle size={13} className="text-warn" />
        : <X size={13} className="text-danger" />}
    </span>
    <div className="min-w-0 flex-1">
      <div className="text-fg-1">{label}</div>
      {children}
    </div>
  </div>
);

const QualityBadge: React.FC<{ value: number; band: 'ok' | 'warn' | 'danger' }> = ({ value, band }) => (
  <span className={`num font-medium ${bandColor[band]}`}>{value.toFixed(3)} px · {band === 'ok' ? 'good' : band === 'warn' ? 'fair' : 'poor'}</span>
);

// 3×3 frame-region grid (which cells a board centroid has hit) + near/far pips from area fraction.
const CoverageGrid: React.FC<{ coverage: { cx: number; cy: number; areaFrac: number }[] }> = ({ coverage }) => {
  const cells = useMemo(() => {
    const hit = new Array(9).fill(false);
    let near = false, far = false;
    for (const c of coverage) {
      const gx = Math.min(2, Math.max(0, Math.floor(c.cx * 3)));
      const gy = Math.min(2, Math.max(0, Math.floor(c.cy * 3)));
      hit[gy * 3 + gx] = true;
      if (c.areaFrac > 0.18) near = true;
      if (c.areaFrac < 0.08) far = true;
    }
    return { hit, near, far };
  }, [coverage]);
  return (
    <div className="flex items-center gap-2">
      <div className="grid grid-cols-3 gap-0.5 w-16">
        {cells.hit.map((h, i) => <div key={i} className={`aspect-square rounded-[1px] ${h ? 'bg-accent' : 'bg-surface-3'}`} />)}
      </div>
      <div className="text-[10px] space-y-0.5">
        <div className={cells.near ? 'text-ok' : 'text-fg-3'}>{cells.near ? '✓' : '○'} near (large)</div>
        <div className={cells.far ? 'text-ok' : 'text-fg-3'}>{cells.far ? '✓' : '○'} far (small)</div>
      </div>
    </div>
  );
};

// Camera preview with the live board-detect overlay (corners drawn over the video).
const CameraView: React.FC<{ videoRef: React.RefObject<HTMLVideoElement | null>; detect: Detect }> = ({ videoRef, detect }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = canvasRef.current, v = videoRef.current;
    if (!cv || !v) return;
    const w = v.clientWidth, h = v.clientHeight;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (detect.found) {
      const sx = w / detect.w, sy = h / detect.h;
      ctx.fillStyle = '#00ffaa';
      for (let i = 0; i < detect.corners.length; i += 2) {
        ctx.beginPath();
        ctx.arc(detect.corners[i] * sx, detect.corners[i + 1] * sy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [detect, videoRef]);
  return (
    <div className="relative aspect-video bg-black rounded border border-line-1 overflow-hidden">
      <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      {!videoRef.current?.srcObject && <div className="absolute inset-0 grid place-items-center text-fg-3 text-[10px]"><Box size={14} className="mr-1" /> start the camera</div>}
    </div>
  );
};
