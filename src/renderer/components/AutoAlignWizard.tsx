import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Check, AlertTriangle, Loader2, Box, MousePointer, ScanLine, Aperture } from 'lucide-react';
import type { MainToProjector } from '../projector/bridge';
import type { ProjectorCalibration, ProjectorOutput, Scene3D } from '../../../shared/protocol';
import * as cam from '../services/calibCapture';
import * as slCapture from '../calib/slCapture';
import { reproject } from '../calib/cvCamera';
import {
  solveCameraPose, solveGeometry, defaultMarkerlessConfig,
  type CamPick, type CameraPose, type MarkerlessResult,
} from '../calib/markerlessController';

interface Props {
  surfaceId: string;
  surfaceName: string;
  output: ProjectorOutput | undefined;
  scene3D: Scene3D;
  live: boolean;
  hasModel: boolean;
  sendToProjector: (surfaceId: string, msg: MainToProjector) => void;
  onStoreCalibration: (surfaceId: string, patch: Partial<ProjectorCalibration>) => void;
  onSetUseCalibration: (surfaceId: string, on: boolean) => void;
  onSetCalibPickMode: (on: boolean) => void;
  onSetSplit: (on: boolean) => void;
  onRegisterMarkerlessPick: (cb: ((world: [number, number, number]) => void) | null) => void;
  onSwitchFlow?: (flow: 'board' | 'auto') => void;
  onClose: () => void;
}

type Step = 'setup' | 'camera' | 'pose' | 'scan' | 'verify';
const STEPS: { id: Step; label: string }[] = [
  { id: 'setup', label: 'Setup' },
  { id: 'camera', label: 'Camera' },
  { id: 'pose', label: 'Anchor' },
  { id: 'scan', label: 'Scan' },
  { id: 'verify', label: 'Verify' },
];

// Nominal camera intrinsics from frame size + an assumed horizontal FOV (square pixels, centred
// principal point). MVP stand-in for board-free self-calibration; "doesn't have to be perfect" (VIOSO).
function nominalK(w: number, h: number, hfovDeg: number): number[] {
  const fx = (w / 2) / Math.tan((hfovDeg * Math.PI / 180) / 2);
  return [fx, 0, w / 2, 0, fx, h / 2, 0, 0, 1];
}

// Paint a grayscale frame into a canvas at its native resolution (CSS object-contain scales it).
function paintGray(cv: HTMLCanvasElement | null, g: { w: number; h: number; data: Uint8Array }): void {
  if (!cv) return;
  if (cv.width !== g.w || cv.height !== g.h) { cv.width = g.w; cv.height = g.h; }
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(g.w, g.h);
  const d = img.data;
  for (let i = 0, px = g.w * g.h; i < px; i++) { const v = g.data[i]; d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
}

// Map a click on the preview canvas (CSS object-contain) → camera pixel coords, or null if outside.
function clickToCamPx(cv: HTMLCanvasElement, e: React.MouseEvent): [number, number] | null {
  const fw = cv.width, fh = cv.height;
  if (!fw || !fh) return null;
  const r = cv.getBoundingClientRect();
  const scale = Math.min(r.width / fw, r.height / fh);
  const offX = (r.width - fw * scale) / 2, offY = (r.height - fh * scale) / 2;
  const u = (e.clientX - r.left - offX) / scale, v = (e.clientY - r.top - offY) / scale;
  if (u < 0 || v < 0 || u > fw || v > fh) return null;
  return [u, v];
}

// Markerless camera-driven auto-align (Phase 0 geometry): self-contained sibling of CalibWizard.
// No board — the loaded venue model is the metric reference. Setup → Camera → Anchor (camera-image↔
// model picks → camera pose) → Scan (Gray-code → dense decode → raycast venue → resection) → Verify
// (residual heatmap). Produces the same ProjectorCalibration the projector window renders from.
export const AutoAlignWizard: React.FC<Props> = (props) => {
  const { surfaceId, surfaceName, output, scene3D, live, hasModel,
    sendToProjector, onStoreCalibration, onSetUseCalibration,
    onSetCalibPickMode, onSetSplit, onRegisterMarkerlessPick, onSwitchFlow, onClose } = props;

  const [step, setStep] = useState<Step>('setup');
  const [addonOk, setAddonOk] = useState<boolean | null>(null);
  const [camSource, setCamSource] = useState<cam.CaptureSource>('browser');
  const [camIndex, setCamIndex] = useState(0);
  const [devices, setDevices] = useState<cam.CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [camOn, setCamOn] = useState(false);
  const [camErr, setCamErr] = useState<string | null>(null);
  const [camDims, setCamDims] = useState({ w: 0, h: 0 });
  const [hfov, setHfov] = useState(60);
  const [picks, setPicks] = useState<CamPick[]>([]);
  const [pose, setPose] = useState<CameraPose | null>(null);
  const [result, setResult] = useState<MarkerlessResult | null>(null);
  const [selfCalOn, setSelfCalOn] = useState(true); // recover camera lens from the scan vs the FOV guess
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const cfg = useRef(defaultMarkerlessConfig());

  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const [pendingCamPx, setPendingCamPx] = useState<[number, number] | null>(null);
  const pendingRef = useRef<[number, number] | null>(null); // mirror for the pick handler closure

  const send = (m: MainToProjector) => sendToProjector(surfaceId, m);
  const addLog = (s: string) => setLog((l) => [...l.slice(-60), s]);
  const cameraK = camDims.w ? nominalK(camDims.w, camDims.h, hfov) : [];

  useEffect(() => { window.artlux?.calibAvailable?.().then(setAddonOk).catch(() => setAddonOk(false)); }, []);
  useEffect(() => () => { cam.stop(); slCapture.endScan(); onRegisterMarkerlessPick(null); onSetCalibPickMode(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Projector + scene mode per step. White field lights the venue for picking; the model-pick split is
  // on during Anchor; idle/render otherwise.
  useEffect(() => {
    if (step === 'pose') {
      send({ t: 'calib', mode: 'pattern' }); send({ t: 'calibPattern', kind: 'white', index: -1 });
      onSetSplit(true); onSetCalibPickMode(true);
    } else if (step === 'camera' || step === 'setup') {
      send({ t: 'calib', mode: 'pattern' }); send({ t: 'calibPattern', kind: 'white', index: -1 });
      onSetCalibPickMode(false);
    } else if (step === 'verify' && result) {
      send({ t: 'scene', scene3D }); send({ t: 'calib', mode: 'render', calibration: result.calibration });
      onSetCalibPickMode(false);
    } else {
      onSetCalibPickMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, result]);

  // Register the model-pick handler during Anchor: pair the next model world point with the pending
  // camera-image pixel → a camera↔model correspondence.
  useEffect(() => {
    if (step !== 'pose') { onRegisterMarkerlessPick(null); return; }
    onRegisterMarkerlessPick((world) => {
      const camPx = pendingRef.current;
      if (!camPx) { addLog('click a point in the camera image first, then the model'); return; }
      pendingRef.current = null; setPendingCamPx(null);
      setPicks((prev) => {
        const nextPicks = [...prev, { camPx, world }];
        if (nextPicks.length >= 4) void resolvePose(nextPicks);
        return nextPicks;
      });
    });
    return () => onRegisterMarkerlessPick(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Live grayscale preview (browser + native both via cam.grab → canvas). Paused during the scan so it
  // doesn't compete with the scan's own grabs for the (single) camera.
  useEffect(() => {
    if (!camOn || !!busy || (step !== 'camera' && step !== 'pose')) return;
    let alive = true; let timer = 0;
    const loop = async () => {
      if (!alive) return;
      const g = await cam.grab();
      if (alive && g) paintGray(baseRef.current, g);
      if (alive) timer = window.setTimeout(loop, 66);
    };
    timer = window.setTimeout(loop, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [camOn, busy, step]);

  const startCam = async () => {
    try {
      setBusy('Starting camera…'); setCamErr(null);
      if (camSource === 'native') await cam.start({ source: 'native', index: camIndex, width: 1280, height: 720, fps: 60, fourcc: 'MJPG' });
      else { await cam.start({ source: 'browser', deviceId: deviceId || undefined }); setDevices(await cam.enumerate()); }
      setCamOn(true);
      const d = cam.dims(); setCamDims(d); addLog(`camera ${d.w}×${d.h}`);
    } catch (e) {
      setCamErr((e as Error)?.message ?? 'camera failed'); setCamOn(false);
    } finally { setBusy(null); }
  };

  const onPreviewClick = (e: React.MouseEvent) => {
    if (step !== 'pose' || !baseRef.current) return;
    const p = clickToCamPx(baseRef.current, e);
    if (!p) return;
    pendingRef.current = p; setPendingCamPx(p);
    addLog(`camera point (${p[0].toFixed(0)},${p[1].toFixed(0)}) — now click the matching point on the model`);
  };

  const resolvePose = async (ps: CamPick[]) => {
    if (cameraK.length !== 9) { addLog('camera not started'); return; }
    const r = await solveCameraPose(ps, cameraK, cfg.current.cameraDist);
    if ('error' in r) { addLog(`✗ camera pose: ${r.error}`); return; }
    setPose(r); addLog(`✓ camera pose — RMS ${r.rms.toFixed(2)} px (${ps.length} picks)`);
  };

  const runScan = async () => {
    if (picks.length < 4) { addLog('add ≥4 anchor picks first'); return; }
    setBusy('Scanning venue — hold still…');
    slCapture.beginScan(surfaceId, send);
    const r = await solveGeometry({ ...cfg.current, cameraK, cameraDist: cfg.current.cameraDist }, picks, selfCalOn);
    slCapture.endScan();
    setBusy(null);
    if ('error' in r) { addLog(`✗ scan: ${r.error}`); return; }
    setResult(r);
    onStoreCalibration(surfaceId, {
      intrinsics: r.calibration.intrinsics, distortion: r.calibration.distortion,
      rotation: r.calibration.rotation, translation: r.calibration.translation,
      imageSize: r.calibration.imageSize, intrinsicsRms: r.calibration.intrinsicsRms, poseRms: r.calibration.poseRms,
    });
    const lens = r.selfCal?.ok ? `self-cal fx ${r.cameraK[0].toFixed(0)} (${r.selfCal.rms.toFixed(2)}px, ${r.selfCal.inliers} inl)`
      : r.selfCal ? `self-cal rejected → nominal fx ${r.cameraK[0].toFixed(0)}` : `nominal fx ${r.cameraK[0].toFixed(0)}`;
    addLog(`✓ ${r.hits}/${r.decoded} rays · cam ${lens} · proj lens ${(r.calibration.intrinsicsRms ?? 0).toFixed(2)}px · proj pose ${(r.calibration.poseRms ?? 0).toFixed(2)}px`);
    setStep('verify');
  };

  const removePick = (i: number) => setPicks((p) => p.filter((_, j) => j !== i));
  const finish = () => { onSetUseCalibration(surfaceId, true); onClose(); };

  // Step gating.
  const gate: Record<Step, boolean> = {
    setup: addonOk === true && live && hasModel,
    camera: camOn,
    pose: !!pose,
    scan: !!result,
    verify: true,
  };
  const idx = STEPS.findIndex((s) => s.id === step);
  const canNext = gate[step];

  return (
    <div className="fixed left-0 top-9 bottom-6 z-[120] w-[340px] flex flex-col bg-surface-1 border-r border-line-2 shadow-2xl animate-overlay-in">
      <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
        <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><ScanLine size={14} /> Auto-Align — {surfaceName}</span>
        <div className="flex items-center gap-2">
          {onSwitchFlow && (
            <div className="flex items-center rounded border border-line-1 overflow-hidden text-[10px]">
              <button onClick={() => onSwitchFlow('board')} className="px-1.5 py-0.5 bg-surface-1 text-fg-3 hover:bg-surface-2" title="Switch to board structured-light">Board</button>
              <span className="px-1.5 py-0.5 bg-accent/20 text-fg-1">Auto-Align</span>
            </div>
          )}
          <button onClick={onClose} aria-label="Close" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>
      </div>

      {/* Stepper */}
      <div className="flex items-center px-2 py-2 gap-1 shrink-0 border-b border-line-1">
        {STEPS.map((s, i) => {
          const done = i < idx, cur = i === idx;
          return (
            <button key={s.id} onClick={() => i <= idx && setStep(s.id)}
              className={`flex items-center gap-1 text-[10px] px-1 ${cur ? 'text-fg-1' : done ? 'text-ok' : 'text-fg-3'}`}>
              <span className={`w-4 h-4 rounded-full grid place-items-center border ${cur ? 'border-accent text-accent' : done ? 'border-ok text-ok' : 'border-line-1'}`}>
                {done ? <Check size={10} /> : i + 1}
              </span>{s.label}{i < STEPS.length - 1 && <span className="text-fg-4">›</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-[11px]">
        {step === 'setup' && (
          <>
            <p className="text-fg-3 leading-relaxed">Markerless camera auto-align onto the <b>loaded 3D model</b> — no checkerboard. You'll click a few matching points to anchor the camera, then scan. Needs a <b>camera</b>, a <b>venue model</b>, a <b>darkened room</b>, and a <b>projector output</b>.</p>
            <Row ok={addonOk === true} label="Calibration engine installed" />
            <Row ok={live} label="Projector output live" />
            <Row ok={hasModel} label="Venue model loaded" />
            <div className="pt-1 text-fg-3">Assumed camera horizontal FOV
              <span className="ml-1 text-fg-1 num">{hfov}°</span>
              <input type="range" min={30} max={110} value={hfov} onChange={(e) => setHfov(parseInt(e.target.value, 10))} className="w-full" />
              <span className="text-fg-4 text-[10px]">A rough lens guess (board-free); refined later. PS3 Eye ≈ 56–75°.</span>
            </div>
          </>
        )}

        {(step === 'camera' || step === 'pose') && (
          <>
            <div className="relative aspect-video bg-black rounded border border-line-1 overflow-hidden">
              <canvas ref={baseRef} onClick={onPreviewClick} className={`w-full h-full object-contain ${step === 'pose' ? 'cursor-crosshair' : ''}`} />
              {!camOn && <div className="absolute inset-0 grid place-items-center text-fg-3 text-[10px]"><Box size={14} className="mr-1" /> start the camera</div>}
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              <span className="text-fg-3">Capture via</span>
              {(['browser', 'native'] as cam.CaptureSource[]).map((s) => (
                <button key={s} onClick={() => { if (camOn) cam.stop(); setCamOn(false); setCamSource(s); }}
                  className={`px-1.5 py-0.5 rounded border ${camSource === s ? 'bg-accent/20 border-accent text-fg-1' : 'bg-surface-1 border-line-1 text-fg-3 hover:bg-surface-2'}`}>
                  {s === 'browser' ? 'Browser' : 'OpenCV (DShow)'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Camera size={13} className="text-fg-3 shrink-0" />
              {camSource === 'native' ? (
                <input type="number" min={0} max={9} value={camIndex} onChange={(e) => setCamIndex(Math.max(0, Math.min(9, parseInt(e.target.value || '0', 10))))}
                  className="w-14 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num focus:border-accent focus:outline-none" />
              ) : (
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                  <option value="">Default camera</option>
                  {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              )}
              <button onClick={startCam} className="px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3">{camOn ? 'Restart' : 'Start'}</button>
            </div>
            {camErr && <div className="flex items-start gap-1.5 text-danger text-[10px] leading-snug"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {camErr}</div>}

            {step === 'pose' && (
              <>
                <div className="text-fg-3 leading-relaxed flex items-start gap-1.5"><MousePointer size={12} className="shrink-0 mt-0.5 text-accent" /> Click a recognizable point in the camera image, then the <b>same</b> point on the 3D model (right). Repeat <b>≥4</b>, well-spread + non-coplanar.</div>
                <div className="flex items-center justify-between">
                  <span className={pose ? 'text-ok' : 'text-fg-3'}>{picks.length} pick{picks.length === 1 ? '' : 's'}{pose ? ` · pose RMS ${pose.rms.toFixed(2)} px` : ''}</span>
                  {pendingCamPx && <span className="text-warn text-[10px]">camera point set → click model</span>}
                </div>
                <div className="space-y-0.5 max-h-24 overflow-auto">
                  {picks.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-[10px] text-fg-3">
                      <span>#{i + 1} cam({p.camPx[0].toFixed(0)},{p.camPx[1].toFixed(0)})</span>
                      <button onClick={() => removePick(i)} className="text-danger hover:text-fg-1">remove</button>
                    </div>
                  ))}
                </div>
                {picks.length >= 4 && <button onClick={() => resolvePose(picks)} className="text-[10px] text-accent hover:underline">re-solve pose</button>}
              </>
            )}
          </>
        )}

        {step === 'scan' && (
          <>
            <p className="text-fg-3 leading-relaxed">Project Gray-code onto the venue and decode where each projector pixel lands. <b>Dim the room</b> and keep the camera + projector still. Camera pose is anchored ({picks.length} picks{pose ? `, RMS ${pose.rms.toFixed(2)}px` : ''}).</p>
            <label className="flex items-start gap-1.5 text-fg-3 cursor-pointer">
              <input type="checkbox" checked={selfCalOn} onChange={(e) => setSelfCalOn(e.target.checked)} className="mt-0.5" />
              <span>Self-calibrate camera lens from the scan <span className="text-fg-4">(board-free focal; falls back to the FOV guess if the estimate is unreliable)</span></span>
            </label>
            <button onClick={runScan} disabled={picks.length < 4 || !!busy} className="w-full px-2 py-1.5 rounded bg-accent/20 border border-accent text-fg-1 hover:bg-accent/30 disabled:opacity-40 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <ScanLine size={13} />} Scan venue
            </button>
            {result && <div className="text-ok text-[10px]">✓ {result.hits}/{result.decoded} rays hit the venue</div>}
          </>
        )}

        {step === 'verify' && result && (
          <>
            <ResidualHeatmap result={result} />
            <div className="grid grid-cols-2 gap-1 text-[10px] text-fg-3">
              <span>fx {result.calibration.intrinsics[0].toFixed(0)}</span>
              <span>fy {result.calibration.intrinsics[4].toFixed(0)}</span>
              <span>cx {result.calibration.intrinsics[2].toFixed(0)}</span>
              <span>cy {result.calibration.intrinsics[5].toFixed(0)}</span>
              <span className={(result.calibration.intrinsicsRms ?? 9) < 2 ? 'text-ok' : 'text-warn'}>lens RMS {(result.calibration.intrinsicsRms ?? 0).toFixed(2)}px</span>
              <span className={(result.calibration.poseRms ?? 9) < 3 ? 'text-ok' : 'text-warn'}>pose RMS {(result.calibration.poseRms ?? 0).toFixed(2)}px</span>
            </div>
            <div className="text-fg-4 text-[10px]">Camera lens: {result.selfCal?.ok ? `self-calibrated (Sampson ${result.selfCal.rms.toFixed(2)}px, ${result.selfCal.inliers} inliers)` : result.selfCal ? 'self-cal rejected → assumed FOV' : 'assumed FOV'}</div>
            <div className="flex items-start gap-1.5 text-warn text-[10px] leading-snug"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> Low RMS ≠ correct scale — confirm the projection lands right on the real surface before trusting it.</div>
            <button onClick={finish} className="w-full px-2 py-1.5 rounded bg-ok/20 border border-ok text-fg-1 hover:bg-ok/30">Apply &amp; finish</button>
          </>
        )}

        {log.length > 0 && (
          <div className="pt-2 border-t border-line-1 space-y-0.5 font-mono text-[10px] text-fg-3">
            {log.slice(-6).map((l, i) => <div key={i} className={l.startsWith('✗') ? 'text-danger' : l.startsWith('✓') ? 'text-ok' : ''}>{l}</div>)}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="h-11 px-3 flex items-center justify-between border-t border-line-1 bg-surface-2 shrink-0">
        <button onClick={() => idx > 0 && setStep(STEPS[idx - 1].id)} disabled={idx === 0} className="text-[11px] text-fg-2 hover:text-fg-1 disabled:opacity-30">‹ Back</button>
        {busy && <span className="text-[10px] text-fg-3 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> {busy}</span>}
        {step === 'verify'
          ? <button onClick={finish} className="text-[11px] px-2 py-1 rounded bg-ok/20 border border-ok text-fg-1">Finish</button>
          : <button onClick={() => idx < STEPS.length - 1 && canNext && setStep(STEPS[idx + 1].id)} disabled={!canNext} title={canNext ? '' : 'complete this step'} className="text-[11px] px-2 py-1 rounded bg-accent/20 border border-accent text-fg-1 disabled:opacity-30">Next ›</button>}
      </div>
    </div>
  );
};

const Row: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <div className="flex items-center gap-1.5">
    {ok ? <Check size={13} className="text-ok" /> : <AlertTriangle size={13} className="text-warn" />}
    <span className={ok ? 'text-fg-1' : 'text-fg-2'}>{label}</span>
  </div>
);

// Reproject every dense correspondence with the solved calibration and plot its residual in the
// projector raster — speckle = decode noise (good), spatially-structured = model/scale mismatch.
const ResidualHeatmap: React.FC<{ result: MarkerlessResult }> = ({ result }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const { calibration: c, denseMap } = result;
    const [W, H] = c.imageSize;
    const cw = 300, ch = Math.max(60, Math.round((cw * H) / Math.max(1, W)));
    cv.width = cw; cv.height = ch;
    ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, cw, ch);
    const n = denseMap.proj.length / 2;
    for (let i = 0; i < n; i++) {
      const X: [number, number, number] = [denseMap.world[i * 3], denseMap.world[i * 3 + 1], denseMap.world[i * 3 + 2]];
      const rp = reproject(c.intrinsics, c.distortion, c.rotation, c.translation as [number, number, number], X);
      if (!rp) continue;
      const du = rp[0] - denseMap.proj[i * 2], dv = rp[1] - denseMap.proj[i * 2 + 1];
      const err = Math.hypot(du, dv);
      const t = Math.min(1, err / 4); // 0px green → ≥4px red
      ctx.fillStyle = `rgb(${Math.round(255 * t)},${Math.round(255 * (1 - t))},60)`;
      ctx.fillRect((denseMap.proj[i * 2] / W) * cw, (denseMap.proj[i * 2 + 1] / H) * ch, 2, 2);
    }
  }, [result]);
  return (
    <div>
      <div className="text-fg-3 text-[10px] mb-1 flex items-center gap-1"><Aperture size={11} /> Residual heatmap (projector raster) — green good, red ≥4px</div>
      <canvas ref={ref} className="w-full rounded border border-line-1 bg-black" />
    </div>
  );
};
