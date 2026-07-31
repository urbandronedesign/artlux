import React, { useEffect, useRef, useState } from 'react';
import { X, Camera, Check, AlertTriangle, Loader2, MousePointer, ScanLine, Aperture } from 'lucide-react';
import type { MainToProjector } from '@/projector/bridge'; // host bridge type — transitional seam (props still App-driven)
import type { ProjectorCalibration, ProjectorOutput, Scene3D, CamMask, MarkerMap, FiducialMarker } from '../../../shared/protocol';
import { CameraViewport, type CameraViewportHandle } from './calib/CameraViewport';
import { CameraParamsPanel } from './calib/CameraParamsPanel';
import * as cam from './calibCapture';
import * as calibHost from './calibHost';
import * as calibWorkspace from './calibWorkspace';
import * as slCapture from './slCapture';
import { computeResiduals } from './residuals';
import { regionFromCalibration } from './mpcdiData';
import * as calibNative from './calibNative';
import * as blendController from './blendController';
import * as autoRecal from './autoRecal';
import {
  solveCameraPose, solveGeometry, defaultMarkerlessConfig, camPicksFromAruco,
  type CamPick, type CameraPose, type MarkerlessResult,
} from './markerlessController';

interface Props {
  surfaceId: string;
  surfaceName: string;
  output: ProjectorOutput | undefined;
  scene3D: Scene3D;
  live: boolean;
  hasModel: boolean;
  // Mutations/IO (via ./calibHost) and pick registration (via ./calibWorkspace) go through the plugin,
  // not props. Remaining props are reactive data + the App-owned 3D/camera workspace.
  onSetCalibPickMode: (on: boolean) => void;
  onPicksChange?: (worlds: [number, number, number][]) => void; // report anchor world points → 3D markers
  onSwitchFlow?: (flow: 'board' | 'auto') => void;
  onSelectionChange?: (i: number | null) => void; // report the edited correspondence for 3D highlight
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

// Markerless camera-driven auto-align (Phase 0 geometry): self-contained sibling of CalibWizard.
// No board — the loaded venue model is the metric reference. Setup → Camera → Anchor (camera-image↔
// model picks → camera pose) → Scan (Gray-code → dense decode → raycast venue → resection) → Verify
// (residual heatmap). Produces the same ProjectorCalibration the projector window renders from.
export const AutoAlignWizard: React.FC<Props> = (props) => {
  const { surfaceId, surfaceName, output, scene3D, live, hasModel,
    onSetCalibPickMode, onPicksChange, onSwitchFlow,
    onSelectionChange, onClose } = props;
  // Write path via host-services (see ./calibHost); pick registration via ./calibWorkspace. Same names
  // as the former props → call sites unchanged.
  const sendToProjector = calibHost.sendToProjector;
  const onStoreCalibration = calibHost.storeCalibration;
  const onSetUseCalibration = calibHost.setUseCalibration;
  const onStoreCamMask = (_surfaceId: string, mask: CamMask | null) => calibHost.storeCamMask(mask);
  const onStoreMarkerMap = (map: MarkerMap | null) => calibHost.storeMarkerMap(map);
  const onRegisterMarkerlessPick = calibWorkspace.registerMarkerlessPick;
  const onRegisterMarkerlessSelect = calibWorkspace.registerMarkerlessSelect;

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
  const [camMode, setCamMode] = useState({ w: 1280, h: 720, fps: 60 }); // requested capture mode (resolution/fps)
  const [camSession, setCamSession] = useState(0); // bumped on each (re)start → CameraParamsPanel re-seeds
  const [maskMode, setMaskMode] = useState(false); // drawing camera exclusion polygons
  const [maskDraft, setMaskDraft] = useState<[number, number][]>([]); // current in-progress polygon
  const ARUCO_DICT = 0; // DICT_4X4_50
  const [detIds, setDetIds] = useState<number[]>([]); // last ArUco detection (ids), for registration UI
  const regMarkerRef = useRef<number | null>(null); // id awaiting its 3D model click during registration
  const regCornerModeRef = useRef(false);           // registering four corners rather than one centre
  const regCornersRef = useRef<[number, number, number][]>([]);
  const [regCorners, setRegCorners] = useState(0);  // corners collected so far (UI progress)
  const [picks, setPicks] = useState<CamPick[]>([]);
  const [pose, setPose] = useState<CameraPose | null>(null);
  const [result, setResult] = useState<MarkerlessResult | null>(null);
  const [selfCalOn, setSelfCalOn] = useState(true); // recover camera lens from the scan vs the FOV guess
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const cfg = useRef(defaultMarkerlessConfig());

  const viewportRef = useRef<CameraViewportHandle | null>(null);
  const [pendingCamPx, setPendingCamPx] = useState<[number, number] | null>(null);
  const pendingRef = useRef<[number, number] | null>(null); // mirror for the pick handler closure
  const [selectedPick, setSelectedPick] = useState<number | null>(null); // correspondence being edited
  const selectedPickRef = useRef<number | null>(null); selectedPickRef.current = selectedPick;
  // RE-PLACING A PLACED ANCHOR'S 3D POINT IS ARMED, NEVER IMPLIED. v0.16.0 made a model click mean
  // "move the selected pick's 3D point" whenever a pick was selected and no camera point was pending —
  // but selection is a SIDE EFFECT of three ordinary actions (a press within 12 px of a camera marker,
  // a click on the 3D anchor sphere, a list row), none of which reads as "enter edit mode". The next
  // click on the model then silently MOVED an already-placed anchor to where you clicked instead of
  // creating a point there, announcing it only as one line in a 60-line scrolling log. Same rule the 3D
  // click-to-place mode already states in Simulator3D: an armed mode with no indicator is a trap.
  const [replaceArmed, setReplaceArmed] = useState(false);
  const replaceArmedRef = useRef(false); replaceArmedRef.current = replaceArmed;
  // Mirror of the reactive scene for the pick handler, which is registered per STEP and would otherwise
  // read a scene3D captured when the step changed — registering a second marker against a stale
  // markerMap drops the first one.
  const scene3DRef = useRef(scene3D); scene3DRef.current = scene3D;

  // Feed the placed anchor world points up to App so the 3D scene shows a matching marker per pick.
  useEffect(() => { onPicksChange?.(picks.map((p) => p.world)); }, [picks]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (m: MainToProjector) => sendToProjector(surfaceId, m);
  const addLog = (s: string) => setLog((l) => [...l.slice(-60), s]);
  const cameraK = camDims.w ? nominalK(camDims.w, camDims.h, hfov) : [];

  useEffect(() => { calibNative.calibAvailable().then(setAddonOk).catch(() => setAddonOk(false)); }, []);
  useEffect(() => () => { cam.stop(); slCapture.endScan(); onRegisterMarkerlessPick(null); onSetCalibPickMode(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Report the edited correspondence up so the 3D scene highlights it; register a select handler so a
  // click on a 3D marker selects the same pick (mirror of clicking its camera marker).
  // Selecting a different correspondence (or deselecting) always disarms — an arm belongs to the pick
  // it was armed for, and carrying it across would move the wrong point.
  useEffect(() => { onSelectionChange?.(selectedPick); setReplaceArmed(false); }, [selectedPick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    onRegisterMarkerlessSelect?.(step === 'pose' ? (i: number) => setSelectedPick(i) : null);
    return () => onRegisterMarkerlessSelect?.(null);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Projector + scene mode per step. White field lights the venue for picking; the model-pick split is
  // on during Anchor; idle/render otherwise.
  useEffect(() => {
    if (step === 'pose') {
      send({ t: 'calib', mode: 'pattern' }); send({ t: 'calibPattern', kind: 'white', index: -1 }); onSetCalibPickMode(true);
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
    if (step !== 'pose') { onRegisterMarkerlessPick(null); setReplaceArmed(false); return; }
    onRegisterMarkerlessPick((world) => {
      // Registration: the pending point is a detected marker's centroid → store id↔3D in the marker map.
      if (regMarkerRef.current != null) {
        const id = regMarkerRef.current;
        const prev = scene3DRef.current.markerMap;
        const commit = (m: FiducialMarker) => {
          regMarkerRef.current = null; regCornersRef.current = []; setRegCorners(0);
          pendingRef.current = null; setPendingCamPx(null);
          const markers = [...(prev?.markers ?? []).filter((x) => x.id !== id), m];
          onStoreMarkerMap?.({ dict: prev?.dict ?? ARUCO_DICT, markers });
          return markers.length;
        };
        // CORNER registration: four clicks, in the detector's own order. Worth the extra three
        // clicks, once, at commissioning — four distinct 3D points condition the pose solve, whereas
        // a centre pairs all four image corners with ONE point (four rays through a point, which is
        // rank-deficient). The unattended path REFUSES a pose built that way; see anchorQuality.
        if (regCornerModeRef.current) {
          regCornersRef.current = [...regCornersRef.current, world];
          setRegCorners(regCornersRef.current.length);
          const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
          if (regCornersRef.current.length < 4) {
            addLog(`marker ${id}: ${regCornersRef.current.length}/4 — now click its ${CORNER_NAMES[regCornersRef.current.length]} corner`);
            return;
          }
          const c = regCornersRef.current as [number, number, number][];
          const centre: [number, number, number] = [
            (c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4,
            (c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4,
            (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4,
          ];
          const n = commit({ id, world: centre, worldCorners: [c[0], c[1], c[2], c[3]] });
          addLog(`✓ marker ${id} registered with 4 corners (${n} total) — usable as an unattended reference`);
          return;
        }
        const n = commit({ id, world });
        addLog(`✓ registered marker ${id} centre (${n} total) — one-click re-anchor works; ` +
          `register corners if this venue recalibrates itself unattended`);
        return;
      }
      const camPx = pendingRef.current;
      // Edit: re-place the selected pick's 3D point — ONLY when the operator armed it from the editing
      // banner, and only for one click. Selection alone is not consent: it happens as a side effect of
      // clicking a camera marker, a 3D sphere or a list row, and the silent version of this branch
      // moved an already-placed anchor to wherever the next model click landed. (Pending still wins, so
      // an in-progress new pick always pairs.)
      if (!camPx && selectedPickRef.current != null && replaceArmedRef.current) {
        const i = selectedPickRef.current;
        setReplaceArmed(false);
        setPicks((prev) => {
          if (i >= prev.length) return prev;
          const next = prev.map((p, j) => (j === i ? { ...p, world } : p));
          if (next.length >= 4) void resolvePose(next);
          return next;
        });
        addLog(`✎ point ${i + 1}: 3D point updated`);
        return;
      }
      // No camera point pending → there is nothing to pair with, and (now) nothing armed to move. Say
      // which of the two the operator is missing rather than doing something they did not ask for.
      if (!camPx) {
        addLog(selectedPickRef.current != null
          ? `click a point in the camera image first — or press "move 3D point" to re-place point ${selectedPickRef.current + 1}`
          : 'click a point in the camera image first, then the model');
        return;
      }
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

  // Live RGB preview (browser + native both via cam.grabColor → viewport). The viewport owns the
  // zoom/pan transform + overlays; we just push frames. Paused during the scan so it doesn't compete
  // with the scan's own grabs for the (single) camera.
  useEffect(() => {
    if (!camOn || !!busy || (step !== 'camera' && step !== 'pose')) return;
    let alive = true; let timer = 0;
    const loop = async () => {
      if (!alive) return;
      const c = await cam.grabColor();
      if (alive && c) viewportRef.current?.paint(c);
      if (alive) timer = window.setTimeout(loop, 66);
    };
    timer = window.setTimeout(loop, 0);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [camOn, busy, step]);

  const startCam = async (mode = camMode) => {
    try {
      setBusy('Starting camera…'); setCamErr(null);
      if (camSource === 'native') await cam.start({ source: 'native', index: camIndex, width: mode.w, height: mode.h, fps: mode.fps, fourcc: 'MJPG' });
      else { await cam.start({ source: 'browser', deviceId: deviceId || undefined, width: mode.w, height: mode.h, fps: mode.fps }); setDevices(await cam.enumerate()); }
      setCamOn(true); setCamSession((s) => s + 1);
      const d = cam.dims(); setCamDims(d); addLog(`camera ${d.w}×${d.h}`);
    } catch (e) {
      setCamErr((e as Error)?.message ?? 'camera failed'); setCamOn(false);
    } finally { setBusy(null); }
  };

  // Re-open the camera at a new resolution / fps (from the params panel).
  const reopenCam = (w: number, h: number, fps: number) => { const mode = { w, h, fps }; setCamMode(mode); if (camOn) void startCam(mode); };

  // Place a calibration point: store the camera pixel as pending, then the next 3D model click pairs
  // with it (handled by the registered markerless-pick callback).
  const onPick = (p: [number, number]) => {
    if (step !== 'pose') return;
    // Starting a new correspondence ends any edit: the operator is placing, not fixing.
    setSelectedPick(null);
    pendingRef.current = p; setPendingCamPx(p);
    addLog(`camera point (${p[0].toFixed(0)},${p[1].toFixed(0)}) — now click the matching point on the model`);
  };
  const onMaskPoint = (p: [number, number]) => setMaskDraft((d) => [...d, p]);

  // Edit an already-placed correspondence: move its camera pixel (drag / nudge in the viewport), or
  // select it (then click the model to re-place its 3D point). Re-solve once ≥4 picks remain.
  const movePickCam = (i: number, camPx: [number, number]) => {
    setPicks((prev) => {
      if (i >= prev.length) return prev;
      const next = prev.map((p, j) => (j === i ? { ...p, camPx } : p));
      if (next.length >= 4) void resolvePose(next);
      return next;
    });
  };
  const selectPick = (i: number | null) => setSelectedPick((cur) => (cur === i ? null : i));

  // Double-click closes the in-progress exclusion polygon and commits it to the venue's camera mask.
  const onPreviewDblClick = () => {
    if (!maskMode || maskDraft.length < 3) { setMaskDraft([]); return; }
    const d = cam.dims();
    const prev = scene3D.camMask;
    const next: CamMask = { w: prev?.w || d.w || camDims.w, h: prev?.h || d.h || camDims.h, polys: [...(prev?.polys ?? []), maskDraft] };
    onStoreCamMask?.(surfaceId, next);
    setMaskDraft([]);
    addLog(`✓ mask polygon added (${next.polys.length} total)`);
  };

  const clearMask = () => { setMaskDraft([]); onStoreCamMask?.(surfaceId, null); addLog('camera mask cleared'); };

  const resolvePose = async (ps: CamPick[]) => {
    if (cameraK.length !== 9) { addLog('camera not started'); return; }
    const r = await solveCameraPose(ps, cameraK, cfg.current.cameraDist);
    if ('error' in r) { addLog(`✗ camera pose: ${r.error}`); return; }
    setPose(r); addLog(`✓ camera pose — RMS ${r.rms.toFixed(2)} px (${ps.length} picks)`);
  };

  // Marker centroid (mean of the 4 corners) for the i-th detected marker.
  const markerCentroid = (det: { corners: number[] }, i: number): [number, number] => {
    const b = i * 8; let x = 0, y = 0;
    for (let c = 0; c < 4; c++) { x += det.corners[b + c * 2]; y += det.corners[b + c * 2 + 1]; }
    return [x / 4, y / 4];
  };

  // Grab a frame and detect ArUco fiducials (for both registration and one-click re-anchor).
  const detectMarkers = async () => {
    const g = await cam.grab();
    if (!g) { addLog('no camera frame'); return null; }
    const det = await calibNative.calibDetectAruco(g.data.buffer as ArrayBuffer, g.w, g.h, scene3D.markerMap?.dict ?? ARUCO_DICT);
    if (!det) { addLog('✗ ArUco unavailable (rebuild calib.node with objdetect enabled)'); return null; }
    setDetIds(det.ids);
    addLog(det.ids.length ? `detected markers: ${det.ids.join(', ')}` : 'no markers detected — check lighting / exposure');
    return det;
  };

  // Load the venue mesh from HERE. It is a prerequisite of this wizard, and until now the only way to
  // satisfy it was to leave the calibration context entirely, find the Scene panel, add the model and
  // navigate back — losing the session on the way. Goes through the host service so the placement and
  // naming rules stay in one place (see Scene3DService.addModel).
  const addVenueModel = async () => {
    setBusy('model');
    try {
      const id = await calibHost.addVenueModel();
      addLog(id ? '✓ venue model added — it appears in the 3D scene alongside' : 'no model chosen');
    } catch (e) {
      addLog(`✗ could not load the model: ${(e as Error).message}`);
    } finally { setBusy(null); }
  };

  // Registration: pick a detected marker to pair with the next 3D model click(s).
  const registerMarker = async (id: number, corners = false) => {
    const det = await detectMarkers();
    if (!det) return;
    const i = det.ids.indexOf(id);
    if (i < 0) { addLog(`marker ${id} not currently visible`); return; }
    const c = markerCentroid(det, i);
    regMarkerRef.current = id;
    regCornerModeRef.current = corners;
    regCornersRef.current = []; setRegCorners(0);
    pendingRef.current = c; setPendingCamPx(c);
    addLog(corners
      ? `marker ${id}: click its four corners on the model — top-left first, then clockwise`
      : `marker ${id} selected — click its real-world point on the model`);
  };

  // One-click re-anchor: detect markers, look them up in the map, solve the camera pose — no manual picks.
  const autoAnchor = async () => {
    const map = scene3D.markerMap;
    if (!map?.markers.length) { addLog('no marker map — register markers first'); return; }
    setBusy('Detecting markers…');
    const det = await detectMarkers();
    setBusy(null);
    if (!det) return;
    const ps = camPicksFromAruco(det, map);
    if (ps.length < 4) { addLog(`only ${ps.length} marker-corner picks (need ≥4) — show more registered markers`); return; }
    // The whole list is replaced, so any selection now indexes a DIFFERENT correspondence than the one
    // the operator was looking at. Drop it rather than let it point somewhere it never meant to.
    setSelectedPick(null);
    setPicks(ps);
    await resolvePose(ps);
  };

  const runScan = async () => {
    if (picks.length < 4) { addLog('add ≥4 anchor picks first'); return; }
    setBusy('Scanning venue — hold still…');
    slCapture.beginScan(surfaceId, send);
    const r = await solveGeometry({ ...cfg.current, cameraK, cameraDist: cfg.current.cameraDist, camMask: scene3D.camMask }, picks, selfCalOn);
    slCapture.endScan();
    setBusy(null);
    if ('error' in r) { addLog(`✗ scan: ${r.error}`); return; }
    setResult(r);
    onStoreCalibration(surfaceId, {
      intrinsics: r.calibration.intrinsics, distortion: r.calibration.distortion,
      rotation: r.calibration.rotation, translation: r.calibration.translation,
      imageSize: r.calibration.imageSize, intrinsicsRms: r.calibration.intrinsicsRms, poseRms: r.calibration.poseRms,
    });
    // KEEP THE DENSE MAP. It used to die with this component, which is why the world-space blend could
    // never be solved: computeBlendMaps needs every projector's map at once, and only one is ever in
    // memory at a time. Session store + a sidecar beside the project, so a rig solved next week still
    // has this scan. See blendController.
    void blendController.captureScan(surfaceId, r.calibration.imageSize, r.denseMap);
    // Feed the same scan into the unattended path: the camera intrinsics it just used, and a probe
    // set + baseline for tomorrow's drift check. Without this the recalibration prerequisites can
    // never be satisfied by any amount of calibrating — there is no other producer of either.
    void autoRecal.commissionFromScan(surfaceId, r);
    const lens = r.selfCal?.ok ? `self-cal fx ${r.cameraK[0].toFixed(0)} (${r.selfCal.rms.toFixed(2)}px, ${r.selfCal.inliers} inl)`
      : r.selfCal ? `self-cal rejected → nominal fx ${r.cameraK[0].toFixed(0)}` : `nominal fx ${r.cameraK[0].toFixed(0)}`;
    addLog(`✓ ${r.hits}/${r.decoded} rays · cam ${lens} · proj lens ${(r.calibration.intrinsicsRms ?? 0).toFixed(2)}px · proj pose ${(r.calibration.poseRms ?? 0).toFixed(2)}px`);
    setStep('verify');
  };

  const removePick = (i: number) => {
    setPicks((p) => {
      const next = p.filter((_, j) => j !== i);
      if (next.length >= 4) void resolvePose(next);
      return next;
    });
    setSelectedPick((cur) => (cur == null ? null : cur === i ? null : cur > i ? cur - 1 : cur));
  };
  const finish = () => { onSetUseCalibration(surfaceId, true); onClose(); };

  const exportMpcdi = async () => {
    if (!result) return;
    const region = regionFromCalibration(surfaceId, result.calibration);
    if (!region) { addLog('✗ MPCDI: no venue model loaded'); return; }
    const path = await window.artlux?.exportMpcdi?.([region]);
    addLog(path ? `✓ MPCDI exported → ${path}` : 'MPCDI export cancelled');
  };

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
    // See CalibWizard: rail + camera side by side; the 3D venue scene is the context's right pane.
    <div className="w-full h-full flex bg-surface-0 min-h-0">
    <div className="w-[340px] shrink-0 flex flex-col bg-surface-1 border-r border-line-1 min-h-0">
      <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
        <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><ScanLine size={14} /> Auto-Align — {surfaceName}</span>
        <div className="flex items-center gap-2">
          {onSwitchFlow && (
            <div className="flex items-center rounded border border-line-1 overflow-hidden text-micro">
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
              className={`flex items-center gap-1 text-micro px-1 ${cur ? 'text-fg-1' : done ? 'text-ok' : 'text-fg-3'}`}>
              <span className={`w-4 h-4 rounded-full grid place-items-center border ${cur ? 'border-accent text-accent' : done ? 'border-ok text-ok' : 'border-line-1'}`}>
                {done ? <Check size={10} /> : i + 1}
              </span>{s.label}{i < STEPS.length - 1 && <span className="text-fg-2">›</span>}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-mini">
        {step === 'setup' && (
          <>
            <p className="text-fg-3 leading-relaxed">Markerless camera auto-align onto the <b>loaded 3D model</b> — no checkerboard. You'll click a few matching points to anchor the camera, then scan. Needs a <b>camera</b>, a <b>venue model</b>, a <b>darkened room</b>, and a <b>projector output</b>.</p>
            <Row ok={addonOk === true} label="Calibration engine installed" />
            <Row ok={live} label="Projector output live" />
            <Row ok={hasModel} label="Venue model loaded"
              action={{ label: 'Load model…', busy: busy === 'model', onClick: addVenueModel }} />
            {!hasModel && (
              <p className="text-fg-2 text-micro leading-snug">
                The venue mesh is the metric reference this whole method replaces the checkerboard with —
                a <b className="text-fg-1">.glb</b> of the real surface, at real-world scale.
              </p>
            )}
            <div className="pt-1 text-fg-3">Assumed camera horizontal FOV
              <span className="ml-1 text-fg-1 num">{hfov}°</span>
              <input type="range" min={30} max={110} value={hfov} onChange={(e) => setHfov(parseInt(e.target.value, 10))} className="w-full" />
              <span className="text-fg-2 text-micro">A rough lens guess (board-free); refined later. PS3 Eye ≈ 56–75°.</span>
            </div>
          </>
        )}

        {(step === 'camera' || step === 'pose') && (
          <>
            <div className="text-fg-2 text-micro flex items-center gap-1.5"><MousePointer size={11} /> The live camera is in the large left view — scroll to zoom, drag to pan, click to place points.</div>
            <div className="flex items-center gap-1 text-micro">
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
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
                  <option value="">Default camera</option>
                  {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              )}
              <button onClick={() => startCam()} className="px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3">{camOn ? 'Restart' : 'Start'}</button>
            </div>
            {camErr && <div className="flex items-start gap-1.5 text-danger text-micro leading-snug"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> {camErr}</div>}

            {/* Native source only — see the same note in CalibWizard. */}
            <CameraParamsPanel camOn={camOn} sessionKey={camSession} width={camMode.w} height={camMode.h} fps={camMode.fps}
              onReopen={reopenCam} deviceIndex={camSource === 'native' ? camIndex : undefined} />

            <div className="space-y-1 pt-1 border-t border-line-1">
              <div className="flex items-center gap-1.5 text-micro">
                <button onClick={() => { setMaskMode((m) => !m); setMaskDraft([]); }}
                  className={`px-1.5 py-0.5 rounded border ${maskMode ? 'bg-danger/20 border-danger text-fg-1' : 'bg-surface-1 border-line-1 text-fg-3 hover:bg-surface-2'}`}>
                  {maskMode ? 'Drawing mask…' : 'Camera mask'}
                </button>
                {(scene3D.camMask?.polys.length ?? 0) > 0 && <span className="text-fg-3">{scene3D.camMask!.polys.length} region{scene3D.camMask!.polys.length === 1 ? '' : 's'}</span>}
                {((scene3D.camMask?.polys.length ?? 0) > 0 || maskDraft.length > 0) && <button onClick={clearMask} className="text-danger hover:text-fg-1 ml-auto">clear</button>}
              </div>
              {maskMode && <div className="text-fg-2 text-micro leading-snug">Click to outline a reflective hotspot / obstruction; <b>double-click</b> to close the region. Masked pixels are dropped from the scan.</div>}
            </div>

            {step === 'pose' && (
              <>
                {/* Fiducial markers → one-click recalibration (VIOSO One-Click-Recalibration). */}
                <div className="space-y-1 pt-1 border-t border-line-1">
                  <div className="flex items-center gap-1.5 text-micro">
                    <Aperture size={12} className="text-accent shrink-0" />
                    <span className="text-fg-2 font-medium">Fiducial markers</span>
                    {(scene3D.markerMap?.markers.length ?? 0) > 0 && <span className="text-fg-3">{scene3D.markerMap!.markers.length} registered</span>}
                  </div>
                  {(scene3D.markerMap?.markers.length ?? 0) > 0 && (
                    <button onClick={autoAnchor} disabled={!camOn || !!busy} className="w-full px-2 py-1 rounded bg-accent/20 border border-accent text-fg-1 hover:bg-accent/30 disabled:opacity-40 flex items-center justify-center gap-1.5">
                      <Aperture size={12} /> Auto-anchor (detect markers)
                    </button>
                  )}
                  <div className="flex items-center gap-1.5 text-micro">
                    <button onClick={() => detectMarkers()} disabled={!camOn} className="px-1.5 py-0.5 rounded border bg-surface-1 border-line-1 text-fg-3 hover:bg-surface-2 disabled:opacity-40">Detect markers</button>
                    <span className="text-fg-2">click an id to register its centre · <b>⌗</b> for four corners</span>
                  </div>
                  {detIds.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {detIds.map((id) => {
                        const m = (scene3D.markerMap?.markers ?? []).find((x) => x.id === id);
                        const active = regMarkerRef.current === id;
                        return (
                          <span key={id} className={`flex items-stretch rounded border overflow-hidden text-micro ${active ? 'border-warn' : m ? 'border-ok/60' : 'border-line-1'}`}>
                            <button onClick={() => registerMarker(id, false)}
                              title="Register this marker's CENTRE — enough for one-click re-anchor with an operator present"
                              className={`px-1.5 py-0.5 ${active ? 'bg-warn/20 text-fg-1' : m ? 'bg-ok/15 text-fg-2' : 'bg-surface-1 text-fg-3 hover:bg-surface-2'}`}>
                              {id}{m?.worldCorners ? ' ⌗' : m ? ' ✓' : ''}
                            </button>
                            <button onClick={() => registerMarker(id, true)}
                              title="Register FOUR CORNERS — required for unattended recalibration, which refuses a pose built from centre-only markers"
                              className={`px-1 py-0.5 border-l ${active && regCornerModeRef.current ? 'bg-warn/30 border-warn text-fg-1' : 'bg-surface-1 border-line-1 text-fg-2 hover:bg-surface-2 hover:text-fg-2'}`}>⌗</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {regMarkerRef.current != null && regCornerModeRef.current && (
                    <div className="text-warn text-micro">
                      marker {regMarkerRef.current}: {regCorners}/4 corners — click{' '}
                      {['top-left', 'top-right', 'bottom-right', 'bottom-left'][regCorners] ?? '…'} on the model
                    </div>
                  )}
                  {(scene3D.markerMap?.markers.length ?? 0) > 0 && <button onClick={() => onStoreMarkerMap?.(null)} className="text-micro text-danger hover:text-fg-1">clear marker map</button>}
                </div>

                <div className="text-fg-3 leading-relaxed flex items-start gap-1.5"><MousePointer size={12} className="shrink-0 mt-0.5 text-accent" /> Or pick manually: click a recognizable point in the camera image, then the <b>same</b> point on the 3D model (right). Repeat <b>≥4</b>, well-spread + non-coplanar.</div>
                <div className="flex items-center justify-between">
                  <span className={pose ? 'text-ok' : 'text-fg-3'}>{picks.length} pick{picks.length === 1 ? '' : 's'}{pose ? ` · pose RMS ${pose.rms.toFixed(2)} px` : ''}</span>
                  {pendingCamPx && <span className="text-warn text-micro">camera point set → click model</span>}
                </div>
                {/* Edit a placed correspondence: select it (row / camera marker / 3D sphere), then drag or
                    arrow-nudge its camera marker, and/or click the model to re-place its 3D point. */}
                <div className="space-y-0.5 max-h-28 overflow-auto">
                  {picks.map((p, i) => {
                    const on = selectedPick === i;
                    return (
                      <div key={i} role="button" tabIndex={0} onClick={() => selectPick(i)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPick(i); } }}
                        className={`flex items-center justify-between gap-1 text-micro px-1 py-0.5 rounded cursor-pointer ${on ? 'bg-accent/20 text-fg-1 border border-accent' : 'text-fg-3 hover:bg-surface-2 border border-transparent'}`}>
                        <span className="num">#{i + 1} cam({p.camPx[0].toFixed(0)},{p.camPx[1].toFixed(0)})</span>
                        <button onClick={(e) => { e.stopPropagation(); removePick(i); }} className="text-danger hover:text-fg-1 shrink-0">remove</button>
                      </div>
                    );
                  })}
                </div>
                {selectedPick != null && (
                  <div className={`flex items-center justify-between gap-1.5 text-micro rounded px-1.5 py-1 border ${replaceArmed ? 'text-warn bg-warn/10 border-warn/50' : 'text-accent bg-accent/10 border-accent/40'}`}>
                    <span>{replaceArmed
                      ? `Point ${selectedPick + 1} — click the model to move its 3D point`
                      : `Editing point ${selectedPick + 1} — drag/arrows on camera`}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {/* Explicit, one-shot, and cancellable. A model click moves this point ONLY while
                          this is lit; otherwise the model stays a place-a-new-point surface. */}
                      <button onClick={() => setReplaceArmed((v) => !v)}
                        className={`px-1.5 py-0.5 rounded-sm border ${replaceArmed ? 'border-warn text-fg-1 bg-warn/20' : 'border-line-1 text-fg-2 hover:text-fg-1'}`}>
                        {replaceArmed ? 'cancel' : 'move 3D point'}
                      </button>
                      <button onClick={() => setSelectedPick(null)} className="text-fg-3 hover:text-fg-1">done</button>
                    </span>
                  </div>
                )}
                {picks.length >= 4 && <button onClick={() => resolvePose(picks)} className="text-micro text-accent hover:underline">re-solve pose</button>}
              </>
            )}
          </>
        )}

        {step === 'scan' && (
          <>
            <p className="text-fg-3 leading-relaxed">Project Gray-code onto the venue and decode where each projector pixel lands. <b>Dim the room</b> and keep the camera + projector still. Camera pose is anchored ({picks.length} picks{pose ? `, RMS ${pose.rms.toFixed(2)}px` : ''}).</p>
            <label className="flex items-start gap-1.5 text-fg-3 cursor-pointer">
              <input type="checkbox" checked={selfCalOn} onChange={(e) => setSelfCalOn(e.target.checked)} className="mt-0.5" />
              <span>Self-calibrate camera lens from the scan <span className="text-fg-2">(board-free focal; falls back to the FOV guess if the estimate is unreliable)</span></span>
            </label>
            <button onClick={runScan} disabled={picks.length < 4 || !!busy} className="w-full px-2 py-1.5 rounded bg-accent/20 border border-accent text-fg-1 hover:bg-accent/30 disabled:opacity-40 flex items-center justify-center gap-1.5">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <ScanLine size={13} />} Scan venue
            </button>
            {result && <div className="text-ok text-micro">✓ {result.hits}/{result.decoded} rays hit the venue</div>}
          </>
        )}

        {step === 'verify' && result && (
          <>
            <ResidualHeatmap result={result} />
            <div className="grid grid-cols-2 gap-1 text-micro text-fg-3">
              <span>fx {result.calibration.intrinsics[0].toFixed(0)}</span>
              <span>fy {result.calibration.intrinsics[4].toFixed(0)}</span>
              <span>cx {result.calibration.intrinsics[2].toFixed(0)}</span>
              <span>cy {result.calibration.intrinsics[5].toFixed(0)}</span>
              <span className={(result.calibration.intrinsicsRms ?? 9) < 2 ? 'text-ok' : 'text-warn'}>lens RMS {(result.calibration.intrinsicsRms ?? 0).toFixed(2)}px</span>
              <span className={(result.calibration.poseRms ?? 9) < 3 ? 'text-ok' : 'text-warn'}>pose RMS {(result.calibration.poseRms ?? 0).toFixed(2)}px</span>
            </div>
            <div className="text-fg-2 text-micro">Camera lens: {result.selfCal?.ok ? `self-calibrated (Sampson ${result.selfCal.rms.toFixed(2)}px, ${result.selfCal.inliers} inliers)` : result.selfCal ? 'self-cal rejected → assumed FOV' : 'assumed FOV'}</div>
            <div className="flex items-start gap-1.5 text-warn text-micro leading-snug"><AlertTriangle size={12} className="shrink-0 mt-0.5" /> Low RMS ≠ correct scale — confirm the projection lands right on the real surface before trusting it.</div>
            <div className="flex gap-1.5">
              <button onClick={finish} className="flex-1 px-2 py-1.5 rounded bg-ok/20 border border-ok text-fg-1 hover:bg-ok/30">Apply &amp; finish</button>
              <button onClick={exportMpcdi} title="Export this calibration as an MPCDI file (open interchange)" className="px-2 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-2 hover:bg-surface-3">Export MPCDI</button>
            </div>
          </>
        )}

        {log.length > 0 && (
          <div className="pt-2 border-t border-line-1 space-y-0.5 font-mono text-micro text-fg-3">
            {log.slice(-6).map((l, i) => <div key={i} className={l.startsWith('✗') ? 'text-danger' : l.startsWith('✓') ? 'text-ok' : ''}>{l}</div>)}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="h-11 px-3 flex items-center justify-between border-t border-line-1 bg-surface-2 shrink-0">
        <button onClick={() => idx > 0 && setStep(STEPS[idx - 1].id)} disabled={idx === 0} className="text-mini text-fg-2 hover:text-fg-1 disabled:opacity-30">‹ Back</button>
        {busy && <span className="text-micro text-fg-3 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> {busy}</span>}
        {step === 'verify'
          ? <button onClick={finish} className="text-mini px-2 py-1 rounded bg-ok/20 border border-ok text-fg-1">Finish</button>
          : <button onClick={() => idx < STEPS.length - 1 && canNext && setStep(STEPS[idx + 1].id)} disabled={!canNext} title={canNext ? '' : 'complete this step'} className="text-mini px-2 py-1 rounded bg-accent/20 border border-accent text-fg-1 disabled:opacity-30">Next ›</button>}
      </div>
    </div>
    {/* `relative` is load-bearing — see the same note in CalibWizard: CameraViewport is `absolute
        inset-0`, so a static parent lets it cover the rail beside it. */}
    <div className="relative flex-1 min-w-0 min-h-0 bg-black">
      <CameraViewport
        ref={viewportRef}
        active={camOn}
        pickActive={step === 'pose' && !maskMode}
        maskMode={maskMode}
        picks={picks.map((p) => ({ camPx: p.camPx }))}
        pending={pendingCamPx}
        selectedPick={selectedPick}
        mask={scene3D.camMask}
        maskDraft={maskDraft}
        onPick={onPick}
        onSelectPick={setSelectedPick}
        onMovePick={movePickCam}
        onMaskPoint={onMaskPoint}
        onMaskClose={onPreviewDblClick}
      />
    </div>
    </div>
  );
};

// A prerequisite row. An unmet one may carry its own FIX — a checklist that only reports is a dead
// end, and this one used to send the operator to another workspace to satisfy it (DESIGN-SYSTEM §6:
// an empty state names the next action, wired to the real action).
const Row: React.FC<{ ok: boolean; label: string; action?: { label: string; onClick: () => void; busy?: boolean } }> = ({ ok, label, action }) => (
  <div className="flex items-center gap-1.5">
    {ok ? <Check size={13} className="text-ok" /> : <AlertTriangle size={13} className="text-warn" />}
    <span className={ok ? 'text-fg-1' : 'text-fg-2'}>{label}</span>
    {!ok && action && (
      <button onClick={action.onClick} disabled={action.busy}
        className="ml-auto px-1.5 py-0.5 rounded border border-accent bg-accent-dim text-fg-1 text-micro disabled:opacity-40">
        {action.busy ? <Loader2 size={11} className="animate-spin" /> : action.label}
      </button>
    )}
  </div>
);

// Reproject every dense correspondence with the solved calibration and plot its residual in the
// projector raster — speckle = decode noise (good), spatially-structured = model/scale mismatch.
const ResidualHeatmap: React.FC<{ result: MarkerlessResult }> = ({ result }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // The numbers, not just the picture. An operator reading a speckle pattern is guessing; p95 says
  // how far the worst of it really lands, and it is the same function the unattended recalibration
  // scores a candidate solve with — so what the wizard shows and what the gate decides cannot drift.
  const res = React.useMemo(() => computeResiduals(result.denseMap, result.calibration), [result]);
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
      const err = res.perPoint[i];
      if (!Number.isFinite(err)) continue;
      const t = Math.min(1, err / 4); // 0px green → ≥4px red
      ctx.fillStyle = `rgb(${Math.round(255 * t)},${Math.round(255 * (1 - t))},60)`;
      ctx.fillRect((denseMap.proj[i * 2] / W) * cw, (denseMap.proj[i * 2 + 1] / H) * ch, 2, 2);
    }
  }, [result, res]);
  return (
    <div>
      <div className="text-fg-3 text-micro mb-1 flex items-center gap-1"><Aperture size={11} /> Residual heatmap (projector raster) — green good, red ≥4px</div>
      <canvas ref={ref} className="w-full rounded border border-line-1 bg-black" />
      <div className="text-micro text-fg-3 mt-1 num">
        rms <span className="text-fg-1">{res.stats.rms.toFixed(2)}</span> px ·
        p95 <span className="text-fg-1">{res.stats.p95.toFixed(2)}</span> px ·
        max <span className="text-fg-1">{res.stats.max.toFixed(2)}</span> px ·
        <span className={res.stats.skipped > res.stats.n * 0.05 ? 'text-warn' : ''}> {res.stats.n} pts{res.stats.skipped ? `, ${res.stats.skipped} behind the lens` : ''}</span>
      </div>
    </div>
  );
};
