import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { X, Check, AlertTriangle, Loader2, ChevronLeft, ChevronRight, Aperture, MonitorUp, Trash2, Wand2, Undo2, Move3d, Crosshair } from 'lucide-react';
import type { MainToProjector } from '@/projector/bridge';
import type { ProjectorCalibration, ProjectorOutput, Scene3D } from '../../../shared/protocol';
import * as calibHost from './calibHost';
import * as calibWorkspace from './calibWorkspace';
import * as ctl from './calibController';
import * as calibNative from './calibNative';
import { manualK, lensFromK, reprojectionErrors, lensConstraint } from './manualLens';
import { cameraCenter, reproject } from './cvCamera';
import type { MeshLook } from './ProjectorScene';

interface Props {
  surfaceId: string;
  surfaceName: string;
  output: ProjectorOutput | undefined;
  scene3D: Scene3D;
  live: boolean;        // projector output is enabled + on a connected display
  hasModel: boolean;    // a visible venue mesh is loaded (the whole metric reference here)
  onSetCalibPickMode: (on: boolean) => void;
  onSwitchFlow?: (flow: 'board' | 'auto' | 'manual') => void;
  onClose: () => void;
}

// The board-free flow: no camera, no checkerboard. The lens (K) is built analytically from the
// projector's spec-sheet optics (throw ratio + lens shift), and the pose comes from the SAME
// crosshair↔model-pick correspondences the board flow uses — the operator aims the projected
// crosshair at a physical feature of the venue, then clicks the matching vertex on
// the 3D model. Sibling of CalibWizard/AutoAlignWizard; the right pane is a projector-raster map of
// the picked points (spread feedback) instead of a camera view.
type Step = 'prereq' | 'lens' | 'pose' | 'verify';
const STEPS: { id: Step; label: string }[] = [
  { id: 'prereq', label: 'Setup' },
  { id: 'lens', label: 'Lens' },
  { id: 'pose', label: 'Points' },
  { id: 'verify', label: 'Verify' },
];

const poseBand = (r: number) => (r < 2 ? 'ok' : r < 5 ? 'warn' : 'danger');
const bandColor = { ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' } as const;
const bandDot = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' } as const;

const numCls = 'w-16 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-mini focus:border-accent focus:outline-none';

// The lens fields a refine overwrites and a revert must restore — kept whole, not per-key.
type LensSnapshot = Pick<ProjectorCalibration, 'intrinsics' | 'distortion' | 'intrinsicsRms' | 'intrinsicsSource'>;

export const ManualWizard: React.FC<Props> = (props) => {
  const { surfaceId, surfaceName, output, scene3D, live, hasModel, onSetCalibPickMode, onSwitchFlow, onClose } = props;
  const sendToProjector = calibHost.sendToProjector;
  const send = (m: MainToProjector) => sendToProjector(surfaceId, m);
  const showWhite = () => send({ t: 'calibPattern', kind: 'white', index: -1 });

  const [step, setStep] = useState<Step>('prereq');
  const [addonOk, setAddonOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [testProj, setTestProj] = useState(false);
  // Verify look. 'edges' by default: crease edges read on the real object where a shaded render (dark
  // materials) and a full wireframe (triangle haze) both fail.
  const [meshLook, setMeshLook] = useState<MeshLook>('edges');
  const [wireOverlay, setWireOverlay] = useState(true); // Points step: project the live edges while picking
  const [selected, setSelected] = useState<number | null>(null);
  const [prevLens, setPrevLens] = useState<LensSnapshot | null>(null); // refine's undo slot
  const addLog = (s: string) => setLog((l) => [s, ...l].slice(0, 6));
  // The armed one-shot edits live in the workspace (pick/onConfirm consume them there); the wizard
  // only renders their banner and the arm/cancel buttons.
  const wsState = useSyncExternalStore(calibWorkspace.subscribe, calibWorkspace.getState);
  const { editWorld, editPixel, lensAuto } = wsState;
  const reaimOrig = useRef<[number, number] | null>(null); // the pixel a live re-aim's Cancel restores

  const cal = output?.calibration;
  const picks = cal?.posePicks ?? [];
  const poseSolved = cal?.poseRms != null;
  // A board-calibrated lens counts too: switching flows must not force re-entering optics that a
  // structured-light solve already measured better than a spec sheet ever will.
  const hasLens = cal?.intrinsicsSource != null || cal?.intrinsicsRms != null;

  // Projector raster, learned from the pattern ack (the projector reports its true device pixels —
  // the same space the crosshair reports in). Seed from a previous calibration so the map has an
  // aspect immediately; the live ack overwrites it.
  const [raster, setRaster] = useState<{ w: number; h: number }>(() =>
    cal?.imageSize && cal.imageSize[0] > 0 ? { w: cal.imageSize[0], h: cal.imageSize[1] } : { w: 0, h: 0 });

  // Lens form state (fractions internally, % in the UI), seeded from what was stored last time.
  const [throwRatio, setThrowRatio] = useState(() => cal?.throwRatio ?? 1.4);
  const [shiftH, setShiftH] = useState(() => cal?.lensShift?.[0] ?? 0);
  const [shiftV, setShiftV] = useState(() => cal?.lensShift?.[1] ?? 0);

  // Mount: enter calibration mode on the projector (ctl.begin owns the pattern-ack plumbing that
  // teaches us the raster), check the addon, register the 3D-marker→list selection tap. Cleanup
  // mirrors CalibWizard's.
  useEffect(() => {
    ctl.begin(surfaceId, (m) => sendToProjector(surfaceId, m));
    calibNative.calibAvailable().then((v) => setAddonOk(!!v)).catch(() => setAddonOk(false));
    calibWorkspace.registerMarkerlessSelect((i) => setSelected(i));
    // The ack can race the projector window's port setup — re-show white until the raster lands.
    let tries = 0;
    const t = window.setInterval(() => {
      const r = ctl.projectorRaster();
      if (r.w > 0) { setRaster(r); window.clearInterval(t); return; }
      if (++tries > 20) { window.clearInterval(t); return; }
      showWhite();
    }, 400);
    return () => {
      window.clearInterval(t);
      ctl.end();
      calibWorkspace.registerMarkerlessSelect(null);
      calibWorkspace.setSelectedPick(null);
      onSetCalibPickMode(false);
      calibWorkspace.poseModeChange(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId]);

  // Mirror the list selection into the workspace so the 3D AnchorMarker highlights with it. Changing
  // (or dropping) the selection always DISARMS — an arm belongs to the pick it was armed for, and
  // carrying it across would move the wrong point (the markerless flow's rule, kept here verbatim).
  useEffect(() => { calibWorkspace.setSelectedPick(selected); calibWorkspace.armEditWorld(null); }, [selected]);

  // The venue scene for the picking wireframe underlay (models change rarely; the solve churns often —
  // so the scene rides its own effect, not the per-solve one below).
  useEffect(() => {
    if (step === 'pose') send({ t: 'scene', scene3D });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, scene3D]);

  // Keep the projector's picking overlay current: the numbered placed pixels + the selected one, AND
  // the live calibration + wireframe flag for the underlay — once a pose solves, the projected
  // wireframe/vertex dots update after every added or edited point, so the operator watches the
  // alignment converge on the real object. Depends on `cal` (not `picks`): a solve-only store keeps
  // the posePicks array identity and would otherwise never push the new pose.
  useEffect(() => {
    if (step !== 'pose') return;
    // `predicted` = where the current solve puts each pick's world point, for the leader lines. Null
    // per pick until a pose exists (nothing to predict from) or when it falls behind the lens.
    const predicted = picks.map((p) => (cal?.poseRms != null
      ? reproject(cal.intrinsics, cal.distortion ?? [0, 0, 0, 0, 0], cal.rotation, cal.translation as [number, number, number], p.world)
      : null));
    send({ t: 'calib', mode: 'crosshair', points: picks.map((p) => p.pixel), predicted, selected, calibration: cal ?? null, meshLook: wireOverlay ? meshLook : 'shaded' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, cal, selected, wireOverlay, meshLook]);

  // Drive projector + scene modes per step (same contract as CalibWizard's step effect).
  useEffect(() => {
    if (step === 'pose') {
      send({ t: 'calib', mode: 'crosshair' });
      onSetCalibPickMode(true); calibWorkspace.poseModeChange(true);
    } else if (step === 'verify') {
      onSetCalibPickMode(false); calibWorkspace.poseModeChange(false);
      if (testProj && cal) { send({ t: 'scene', scene3D }); send({ t: 'calib', mode: 'render', calibration: cal, meshLook }); }
      else send({ t: 'calib', mode: 'idle' });
    } else { // prereq + lens — white field so the operator can see the output is alive + targeted
      send({ t: 'calib', mode: 'pattern' }); showWhite();
      onSetCalibPickMode(false); calibWorkspace.poseModeChange(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, testProj, meshLook]);

  const applyLens = () => {
    const r = raster.w > 0 ? raster : ctl.projectorRaster();
    if (r.w === 0) { addLog('✗ projector raster unknown — is the output window open?'); return; }
    const k = manualK(throwRatio, shiftH, shiftV, r.w, r.h);
    calibHost.storeCalibration(surfaceId, {
      intrinsics: k, distortion: [0, 0, 0, 0, 0], imageSize: [r.w, r.h],
      throwRatio, lensShift: [shiftH, shiftV], intrinsicsSource: 'manual', intrinsicsRms: undefined,
    });
    setPrevLens(null); // the seed changed — a stale refine-undo would restore the wrong optics
    addLog(`✓ lens set — fx ${k[0].toFixed(0)} px @ ${r.w}×${r.h}`);
    // A new K invalidates a pose solved under the old one; re-solve from the picks we already have.
    if (picks.length >= 4) void calibWorkspace.solvePose(surfaceId, picks);
  };

  // Single-view lens refine over the picks (manual K as seed, principal point + aspect held — one
  // view of near-coplanar points cannot constrain them). Kept behind ≥8 points and an explicit
  // keep/revert so a degenerate spread can't silently wreck a working lens.
  const refineLens = async () => {
    if (!cal || picks.length < 8) return;
    const [w, h] = cal.imageSize;
    setBusy('Refining lens from points…');
    const r = await calibNative.calibCalibrateGuided(
      picks.flatMap((p) => p.world), picks.flatMap((p) => p.pixel), [picks.length], w, h,
      cal.intrinsics, true, true);
    setBusy(null);
    if (!r) { addLog('✗ refine failed (addon unavailable)'); return; }
    setPrevLens({ intrinsics: cal.intrinsics, distortion: cal.distortion, intrinsicsRms: cal.intrinsicsRms, intrinsicsSource: cal.intrinsicsSource });
    calibHost.storeCalibration(surfaceId, { intrinsics: r.k, distortion: r.dist, intrinsicsRms: r.rms, intrinsicsSource: 'refined' });
    await calibWorkspace.solvePose(surfaceId, picks);
    const tr = lensFromK(r.k, w, h).throwRatio;
    addLog(`✓ lens refined — RMS ${r.rms.toFixed(2)} px, throw ratio ${tr.toFixed(2)}`);
  };

  const revertLens = async () => {
    if (!prevLens) return;
    calibHost.storeCalibration(surfaceId, { ...prevLens });
    setPrevLens(null);
    addLog('↩ lens reverted to the manual entry');
    if (picks.length >= 4) await calibWorkspace.solvePose(surfaceId, picks);
  };

  const [addingModel, setAddingModel] = useState(false);
  const addVenueModel = async () => {
    setAddingModel(true);
    try {
      const id = await calibHost.addVenueModel();
      addLog(id ? '✓ venue model added' : 'no model chosen');
    } catch (e) {
      addLog(`✗ could not load the model: ${(e as Error).message}`);
    } finally { setAddingModel(false); }
  };

  const errors = poseSolved && cal ? reprojectionErrors(cal, picks) : null;

  // Can these picks see a wrong lens at all? The RMS beside it cannot — see lensConstraint's header
  // for the measured table. Only meaningful once a pose exists, since depth is measured in its frame.
  const lensGauge = poseSolved && cal ? lensConstraint(cal, picks) : null;

  // Where the solve PUT the projector, as a distance the operator can sanity-check against the room.
  // This is the manual flow's lens gauge: PnP absorbs a wrong focal into distance (fx k× too big →
  // projector solved k× too far), so real ÷ shown is exactly the throw-ratio correction factor.
  const solvedDist = poseSolved && cal && picks.length > 0 ? (() => {
    const C = cameraCenter(cal.rotation, cal.translation as [number, number, number]);
    return picks.reduce((a, p) => a + Math.hypot(p.world[0] - C[0], p.world[1] - C[1], p.world[2] - C[2]), 0) / picks.length;
  })() : null;

  const gate: Record<Step, { ok: boolean; why: string }> = {
    prereq: { ok: addonOk === true && live, why: 'Resolve the setup checklist first' },
    lens: { ok: hasLens && hasModel, why: hasLens ? 'Load a venue model for the points step' : 'Apply the lens first' },
    pose: { ok: poseSolved, why: 'Capture ≥4 point pairs until the pose solves' },
    verify: { ok: true, why: '' },
  };
  const idx = STEPS.findIndex(s => s.id === step);
  const canNext = gate[step].ok;
  const next = () => { if (idx < STEPS.length - 1) setStep(STEPS[idx + 1].id); };
  const back = () => { if (idx > 0) setStep(STEPS[idx - 1].id); };
  // Enable render-from-projector and save the document in place — a calibration is venue work an
  // operator must not lose to a crash between now and their next manual save. Best-effort: an
  // unsaved (pathless) project returns false and never raises a dialog.
  const finish = () => {
    calibHost.setUseCalibration(surfaceId, true);
    void calibHost.saveProject();
    onClose();
  };

  const pct = (v: number) => Math.round(v * 100);

  return (
    <div className="w-full h-full flex bg-surface-0 min-h-0">
    <div className="w-[340px] shrink-0 flex flex-col bg-surface-1 border-r border-line-1 min-h-0">
      {/* Header */}
      <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
        <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><Aperture size={14} /> Calibrate — {surfaceName}</span>
        <div className="flex items-center gap-2">
          {onSwitchFlow && (
            <div className="flex items-center rounded border border-line-1 overflow-hidden text-micro">
              <button onClick={() => onSwitchFlow('board')} className="px-1.5 py-0.5 bg-surface-1 text-fg-3 hover:bg-surface-2" title="Switch to board structured-light">Board</button>
              <button onClick={() => onSwitchFlow('auto')} className="px-1.5 py-0.5 bg-surface-1 text-fg-3 hover:bg-surface-2" title="Switch to markerless camera auto-align">Auto-Align</button>
              <span className="px-1.5 py-0.5 bg-accent/20 text-fg-1">Manual</span>
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
            <React.Fragment key={s.id}>
              <button onClick={() => i <= idx && setStep(s.id)} disabled={i > idx}
                className={`flex items-center gap-1 text-micro ${cur ? 'text-accent' : done ? 'text-fg-2' : 'text-fg-3'}`}>
                <span className={`w-4 h-4 rounded-full grid place-items-center text-micro border ${cur ? 'border-accent text-accent' : done ? 'border-ok text-ok' : 'border-line-2'}`}>
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
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-mini">
        {step === 'prereq' && (
          <>
            <p className="text-fg-3 leading-relaxed">Board-free calibration: enter the projector's <b>lens specs</b>, then anchor its position by picking matching points on the <b>real surface</b> (projected crosshair) and the <b>3D model</b>. No camera, no checkerboard.</p>
            <PrereqRow ok={addonOk} label="Calibration engine installed">
              {addonOk === false && <span className="text-fg-3">Run <span className="num">npm run build:calib</span> on an OpenCV host.</span>}
            </PrereqRow>
            <PrereqRow ok={live} label="Projector output live">
              {!live && <span className="text-fg-3">Enable this output on a display in the Outputs panel.</span>}
            </PrereqRow>
            <PrereqRow ok={hasModel} warnOnly label="Venue model loaded (for the points step)">
              {!hasModel && (
                <div className="flex items-center gap-2">
                  <span className="text-fg-2">Needed to place 3D points.</span>
                  <button onClick={addVenueModel} disabled={addingModel}
                    className="px-1.5 py-0.5 rounded border border-accent bg-accent-dim text-fg-1 text-micro disabled:opacity-40">
                    {addingModel ? 'Loading…' : 'Load model…'}
                  </button>
                </div>
              )}
            </PrereqRow>
            <div className="text-fg-3 flex items-center gap-1.5 pt-1"><AlertTriangle size={12} className="text-warn" /> The 3D model must match the real object's true dimensions — it is the only metric reference.</div>
          </>
        )}

        {step === 'lens' && (
          <>
            <p className="text-fg-3 leading-relaxed"><b>Throw ratio</b> = distance ÷ image width. <b>Lens shift</b>: 0% = image centered on the lens axis; +100% vertical = image entirely above it (typical fixed-lens projector). {lensAuto ? <>With auto-solve on, these are only a <b>starting guess</b> — from 6 points the lens solves itself.</> : <>From the projector's spec sheet.</>}</p>
            <label className="flex items-start gap-1.5 cursor-pointer text-fg-2">
              <input type="checkbox" checked={lensAuto} onChange={(e) => calibWorkspace.setLensAuto(e.target.checked)} className="mt-0.5 bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
              <span>Auto-solve lens from the points <span className="text-fg-3">— recommended. Re-estimates the focal on every solve (needs ≥6 points with some depth spread); falls back to the entered lens when the points can't support it. Untick to lock the entered lens.</span></span>
            </label>
            {cal?.intrinsicsRms != null && (cal.intrinsicsSource == null || cal.intrinsicsSource === 'board') && (
              <div className="text-fg-2 flex items-start gap-1.5"><Check size={12} className="text-ok shrink-0 mt-0.5" /> A board-calibrated lens already exists — you can skip this and go straight to Points.</div>
            )}
            <div className="space-y-2 border-t border-line-1 pt-2">
              <label className="flex items-center justify-between gap-2 text-fg-2">Throw ratio
                <input type="number" min={0.2} max={6} step={0.01} value={throwRatio}
                  onChange={(e) => setThrowRatio(Math.max(0.2, +e.target.value || 0.2))} className={numCls} />
              </label>
              <label className="flex items-center justify-between gap-2 text-fg-2">Vertical shift %
                <input type="number" min={-200} max={200} step={1} value={pct(shiftV * 2)}
                  onChange={(e) => setShiftV((+e.target.value || 0) / 200)} className={numCls} />
              </label>
              <label className="flex items-center justify-between gap-2 text-fg-2">Horizontal shift %
                <input type="number" min={-200} max={200} step={1} value={pct(shiftH * 2)}
                  onChange={(e) => setShiftH((+e.target.value || 0) / 200)} className={numCls} />
              </label>
              <div className="text-micro text-fg-3">
                Raster: {raster.w > 0 ? <span className="num text-fg-2">{raster.w}×{raster.h}</span> : <span className="text-warn">waiting for the projector window…</span>}
              </div>
              <button onClick={applyLens} disabled={raster.w === 0}
                className="px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 font-medium">Apply lens</button>
              {cal?.intrinsicsSource === 'manual' && <div className="text-fg-2 flex items-center gap-1"><Check size={11} className="text-ok" /> Manual lens applied.</div>}
              {cal?.intrinsicsSource === 'refined' && <div className="text-fg-2 flex items-center gap-1"><Check size={11} className="text-ok" /> Refined lens in use (from the points step).</div>}
            </div>
            <p className="text-fg-3 text-micro">Not sure? A rough throw ratio is fine to start — from 8 well-spread points you can <b>refine the lens</b> in the next step.</p>
          </>
        )}

        {step === 'pose' && (
          <>
            {poseSolved ? (
              <p className="text-fg-3 leading-relaxed">Now that a pose exists, just <b>click a vertex on the model</b> (3D view, right): the new point lands where the solve <i>predicts</i> that vertex is on the projection — then <b>drag it</b> onto the real feature and watch the fit tighten. Keep spreading points across the raster <b>and across depth</b>.</p>
            ) : (
              <p className="text-fg-3 leading-relaxed">On the <b>projector</b>, put the crosshair on a distinct physical feature (click or arrow keys — a corner, an edge), then click the same point on the model in the <b>3D view (right)</b> — the model click pairs with wherever the crosshair is, no confirmation needed. It snaps to the nearest vertex (hold <b>Alt</b> for free pick). ≥4 points solve the position{lensAuto ? <>; from <b>6</b>, the lens solves itself too</> : null} — spread them across the raster <b>and across depth</b>.</p>
            )}
            {!hasModel && (
              <div className="flex items-center gap-2">
                <span className="text-danger flex items-center gap-1"><AlertTriangle size={12} /> No venue model — the pose has nothing to anchor to.</span>
                <button onClick={addVenueModel} disabled={addingModel}
                  className="px-1.5 py-0.5 rounded border border-accent bg-accent-dim text-fg-1 text-micro disabled:opacity-40">
                  {addingModel ? 'Loading…' : 'Load model…'}
                </button>
              </div>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
              <input type="checkbox" checked={wireOverlay} onChange={(e) => setWireOverlay(e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
              <span>Project the model while picking <span className="text-fg-3">— after the first solve, the mesh edges + vertex dots appear on the object and follow every point you add or fix</span></span>
            </label>
            <div className="border-t border-line-1 pt-2 space-y-1">
              <div className="text-fg-2">Points: <span className="num text-fg-1">{picks.length}</span> <span className="text-fg-3">/ ≥4</span></div>
              <div className="text-fg-2">Pose RMS: {cal?.poseRms != null ? <QualityBadge value={cal.poseRms} band={poseBand(cal.poseRms)} /> : <span className="text-fg-3">—</span>} <span className="text-fg-3">— how well the pose fits, <b>not</b> whether the lens is right</span></div>
              {/* THE MISSING HALF OF THE RMS. A focal error hides inside the distance when every pick
                  sits at one depth, so a flat pick set can read 0.22 px while the projector is solved
                  0.6 m from where it is. Saying only "the lens is unverified" would over-warn a flat
                  screen, where the ambiguity is harmless — so the copy names the case that bites. */}
              {lensGauge && (
                <div className="text-fg-2">
                  Depth spread: <QualityBadge value={Math.round(lensGauge.spread * 100)} band={lensGauge.band} />
                  <span className="text-fg-3"> % · picks {lensGauge.near.toFixed(1)}–{lensGauge.far.toFixed(1)} m out</span>
                  {lensGauge.band !== 'ok' && (
                    <div className="text-fg-3 text-micro leading-snug mt-0.5">
                      These picks are nearly all at one depth, so the RMS above <b>cannot see a wrong throw ratio</b>
                      — a lens 10% off still reads under 2 px. Fine if everything this projector covers lies at that
                      depth (a flat screen or cyclorama). If anything stands off it, pick some points nearer or
                      further and watch the RMS: it will rise if the lens is wrong.
                    </div>
                  )}
                </div>
              )}
              {solvedDist != null && (
                <div className="text-fg-2">Projector solved <span className="num text-fg-1">{solvedDist.toFixed(2)} m</span> <span className="text-fg-3">from the points{lensAuto && cal?.intrinsicsSource === 'refined' ? '' : ' — check this against the room; off by ×N means the throw ratio is off by ×N.'}</span></div>
              )}
              {poseSolved && cal && cal.imageSize[0] > 0 && (
                <div className="text-fg-2">Lens: <span className="text-fg-1">{cal.intrinsicsSource === 'refined' ? 'auto-solved from the points' : cal.intrinsicsSource === 'manual' ? (lensAuto && picks.length >= 6 ? 'entered value (auto-solve pending better spread)' : 'entered value') : 'board'}</span> <span className="num text-fg-3">· throw {lensFromK(cal.intrinsics, cal.imageSize[0], cal.imageSize[1]).throwRatio.toFixed(2)}</span></div>
              )}
            </div>
            {picks.length > 0 && (
              <p className="text-fg-3 text-micro leading-snug">To fix a point, <b>drag it</b>: its marker in the 3D view (snaps to vertices), its dot on the raster map (right), or the numbered point on the projection itself — the solve follows live. A <span className="text-danger">red leader line</span> on the projection points from a pick to where the solve thinks it belongs; its length is that point's error.</p>
            )}
            {picks.length > 0 && (
              <div className="space-y-0.5">
                {picks.map((p, i) => {
                  const err = errors?.[i];
                  const band = err != null && isFinite(err) ? poseBand(err) : null;
                  return (
                    <div key={i}
                      onClick={() => setSelected(selected === i ? null : i)}
                      className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-micro ${selected === i ? 'bg-accent/15 border border-accent/40' : 'bg-surface-0 border border-line-1 hover:bg-surface-2'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${band ? bandDot[band] : 'bg-surface-3'}`} />
                      <span className="num text-fg-2 shrink-0">#{i + 1}</span>
                      <span className="num text-fg-3 flex-1 truncate">{p.pixel[0].toFixed(0)},{p.pixel[1].toFixed(0)} px</span>
                      {err != null && <span className={`num shrink-0 ${band ? bandColor[band] : 'text-fg-3'}`}>{isFinite(err) ? `${err.toFixed(1)} px` : '∞'}</span>}
                      <button onClick={(e) => { e.stopPropagation(); setSelected(null); calibWorkspace.removePick(surfaceId, i); }}
                        aria-label={`Remove point ${i + 1}`} title="Remove this point" className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Editing the selected pair — armed, never implied: selection alone must not make the
                next gesture move a point (see the workspace's armEdit* doctrine). */}
            {selected != null && selected < picks.length && editWorld == null && editPixel == null && (
              <div className="flex items-center gap-1.5 flex-wrap border-t border-line-1 pt-2">
                <span className="text-fg-3 text-micro">Edit #{selected + 1}:</span>
                <button onClick={() => calibWorkspace.armEditWorld(selected)}
                  title="The next click on the 3D model re-places this point's 3D position"
                  className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-micro"><Move3d size={11} /> Move 3D point</button>
                <button onClick={() => { reaimOrig.current = picks[selected].pixel; calibWorkspace.armEditPixel(selected); send({ t: 'calib', mode: 'crosshair', crosshair: picks[selected].pixel }); }}
                  title="The crosshair jumps to this point and the point follows it live — move it into place, then Done"
                  className="flex items-center gap-1 px-2 py-1 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-micro"><Crosshair size={11} /> Re-aim projector pixel</button>
              </div>
            )}
            {editWorld != null && (
              <div className="flex items-start gap-1.5 text-accent text-micro leading-snug border border-accent/40 bg-accent/10 rounded px-2 py-1.5">
                <Move3d size={12} className="shrink-0 mt-0.5" />
                <span className="flex-1">Click the model in the <b>3D view</b> — point <b>#{editWorld + 1}</b>'s 3D point moves there (vertex-snapped; Alt = free).</span>
                <button onClick={() => calibWorkspace.armEditWorld(null)} className="text-fg-2 hover:text-fg-1 shrink-0">Cancel</button>
              </div>
            )}
            {editPixel != null && (
              <div className="flex items-start gap-1.5 text-accent text-micro leading-snug border border-accent/40 bg-accent/10 rounded px-2 py-1.5">
                <Crosshair size={12} className="shrink-0 mt-0.5" />
                <span className="flex-1">Point <b>#{editPixel + 1}</b> follows the crosshair <b>live</b> — move it into place on the projector (the solve tracks it), then Done. Enter on the projector also finishes.</span>
                <button onClick={() => { calibWorkspace.armEditPixel(null); calibWorkspace.endPickDrag(); }}
                  className="text-ok hover:text-fg-1 shrink-0 font-medium">Done</button>
                <button onClick={() => {
                  const i = editPixel, orig = reaimOrig.current;
                  calibWorkspace.armEditPixel(null);
                  calibWorkspace.cancelPickDrag(); // drop the provisional position, keep the stored one
                  if (orig) calibWorkspace.updatePick(surfaceId, i, { pixel: orig });
                }} className="text-fg-2 hover:text-fg-1 shrink-0">Cancel</button>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => { setSelected(null); calibWorkspace.clearPoses(surfaceId); }} disabled={picks.length === 0}
                className="px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">Clear points</button>
              {/* Manual refine only when auto-solve is off — with it on, every solve already does this. */}
              {!lensAuto && (
                <button onClick={() => void refineLens()} disabled={picks.length < 8 || !!busy}
                  title={picks.length < 8 ? 'Needs ≥8 points spread across the raster and depth' : 'Re-estimate the lens (focal) from the picked points'}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40"><Wand2 size={12} /> Refine lens</button>
              )}
              {!lensAuto && prevLens && (
                <button onClick={() => void revertLens()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3"><Undo2 size={12} /> Revert lens</button>
              )}
            </div>
          </>
        )}

        {step === 'verify' && (
          <>
            <p className="text-fg-3 leading-relaxed">Confirm the result. Enable <b>test projection</b> to render the venue from the matched projector and check alignment on the real surface. Misaligned? Go back to Points and fix the worst-error pick first.</p>
            <div className="border-t border-line-1 pt-2 space-y-1">
              <div className="text-fg-2">Lens: <span className="text-fg-1">{cal?.intrinsicsSource === 'refined' ? 'refined from points' : cal?.intrinsicsSource === 'manual' ? 'manual (spec sheet)' : cal?.intrinsicsRms != null ? 'board structured-light' : '—'}</span></div>
              <div className="text-fg-2">Pose RMS: {cal?.poseRms != null ? <QualityBadge value={cal.poseRms} band={poseBand(cal.poseRms)} /> : '—'}</div>
              {solvedDist != null && <div className="text-fg-2">Projector distance: <span className="num text-fg-1">≈ {solvedDist.toFixed(2)} m</span></div>}
              {cal?.intrinsics && cal.imageSize[0] > 0 && (
                <div className="num text-micro text-fg-3">
                  fx {cal.intrinsics[0].toFixed(1)} · cx {cal.intrinsics[2].toFixed(1)} · cy {cal.intrinsics[5].toFixed(1)} · throw {lensFromK(cal.intrinsics, cal.imageSize[0], cal.imageSize[1]).throwRatio.toFixed(2)}
                </div>
              )}
            </div>
            {solvedDist != null && cal?.intrinsicsSource === 'refined' && (
              <p className="text-fg-3 text-micro leading-snug">The lens was auto-solved from your points — the distance above should already match the room. If it's off, add points with more depth spread.</p>
            )}
            {solvedDist != null && cal?.intrinsicsSource !== 'refined' && (
              <p className="text-fg-3 text-micro leading-snug">Measure the real throw distance. If it differs from the solved one, multiply the throw ratio by <span className="num">real ÷ solved</span> in the Lens step, re-apply, and the pose re-solves from your points. (Or place ≥6 points with depth spread and let the lens auto-solve.)</p>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
              <input type="checkbox" checked={testProj} onChange={(e) => setTestProj(e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
              <MonitorUp size={12} className="text-fg-3" /> Test projection (render venue from projector)
            </label>
            {/* Choosing WHAT plays on the mesh is scene work, not calibration work — it lives in the
                3D Scene context (select the model ▸ Content), which is also where the projector's
                own view can be looked through. This step stays about whether the SOLVE is right. */}
            <p className="text-fg-3 text-micro leading-snug border-t border-line-1 pt-2">To put content on the venue mesh, go to <b>3D Scene</b>, select the model and pick a <b>Content</b> source — you can also look through this projector from there.</p>
            <div className={`flex items-center gap-1 text-micro ${testProj ? '' : 'opacity-40'}`}>
              <span className="text-fg-3">Look</span>
              {(['edges', 'wireframe', 'shaded'] as MeshLook[]).map((m) => (
                <button key={m} disabled={!testProj} onClick={() => setMeshLook(m)}
                  title={m === 'edges' ? 'Crease + outline edges only — what you align against the real object'
                    : m === 'wireframe' ? 'Every triangle — only useful on very coarse meshes'
                    : 'The venue materials as the show will render them'}
                  className={`px-1.5 py-0.5 rounded border ${meshLook === m ? 'bg-accent/20 border-accent text-fg-1' : 'bg-surface-1 border-line-1 text-fg-3 hover:bg-surface-2'} disabled:opacity-60`}>
                  {m === 'edges' ? 'Edges' : m === 'wireframe' ? 'Wireframe' : 'Shaded'}
                </button>
              ))}
            </div>
          </>
        )}

        {busy && <div className="text-accent flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {busy}</div>}
        {log.length > 0 && (
          <div className="border-t border-line-1 pt-2 space-y-0.5 text-micro text-fg-3 font-mono">
            {log.map((l, i) => <div key={i} className={l.startsWith('✗') ? 'text-danger' : l.startsWith('✓') ? 'text-ok' : ''}>{l}</div>)}
          </div>
        )}
      </div>

      {/* Footer nav */}
      <div className="h-11 px-3 flex items-center justify-between border-t border-line-1 bg-surface-2 shrink-0">
        <button onClick={back} disabled={idx === 0} className="flex items-center gap-1 px-2 py-1 rounded text-mini text-fg-2 hover:text-fg-1 disabled:opacity-30"><ChevronLeft size={13} /> Back</button>
        {step === 'verify' ? (
          <button onClick={finish} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover font-medium text-mini"><Check size={13} /> Apply &amp; finish</button>
        ) : (
          <button onClick={next} disabled={!canNext} title={!canNext ? gate[step].why : ''}
            className="flex items-center gap-1 px-3 py-1.5 rounded bg-accent text-black hover:bg-accent-hover disabled:opacity-40 font-medium text-mini">Next <ChevronRight size={13} /></button>
        )}
      </div>
    </div>

    {/* Right pane: the projector-raster map — where the picked pixels sit on the raster (spread
        feedback, the manual flow's stand-in for the board wizard's camera coverage grid) + the live
        crosshair. See the `relative` note in CalibWizard: the positioned parent is load-bearing. */}
    <div className="relative flex-1 min-w-0 min-h-0 bg-black">
      <RasterMap raster={raster} picks={picks} errors={errors} selected={selected} onSelect={setSelected} active={step === 'pose'}
        onMovePixel={(i, px) => calibWorkspace.onPointDrag(i, px)} />
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

// A scaled outline of the projector raster with the picked pixels on it. The live crosshair is
// written imperatively in a rAF (position + armed state come from calibWorkspace getters, not React
// state — it moves at pointer rate on the projector and must not re-render the wizard per move).
const RasterMap: React.FC<{
  raster: { w: number; h: number };
  picks: Array<{ world: [number, number, number]; pixel: [number, number] }>;
  errors: number[] | null;
  selected: number | null;
  onSelect: (i: number | null) => void;
  active: boolean; // pose step: crosshair live + status line
  /** Drag a dot → move that pick's projector pixel (streamed; the workspace throttles the solve). */
  onMovePixel?: (i: number, pixel: [number, number]) => void;
}> = ({ raster, picks, errors, selected, onSelect, active, onMovePixel }) => {
  const crossRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragIdx = useRef<number | null>(null);
  // Where the dragged dot IS while the finger is down. The document only learns the new position on
  // release now (calibWorkspace's live drag), so without this the dot would sit at its old place
  // until the drop — the one thing a drag must never do. Local state: it re-renders this map, not
  // the wizard, and never the app.
  const [dragPos, setDragPos] = useState<{ i: number; px: [number, number] } | null>(null);
  const dragToPixel = (e: React.PointerEvent): [number, number] | null => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * raster.w,
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * raster.h,
    ];
  };

  useEffect(() => {
    if (!active || raster.w === 0) return;
    let raf = 0;
    const tick = () => {
      const c = calibWorkspace.getLatestCrosshair();
      if (crossRef.current) {
        if (c) {
          crossRef.current.style.display = 'block';
          crossRef.current.style.left = `${(c[0] / raster.w) * 100}%`;
          crossRef.current.style.top = `${(c[1] / raster.h) * 100}%`;
        } else crossRef.current.style.display = 'none';
      }
      if (statusRef.current) {
        statusRef.current.textContent = c
          ? `Crosshair at ${c[0].toFixed(0)}, ${c[1].toFixed(0)} px — click the matching vertex in the 3D view`
          : 'Click in the projector window to aim the crosshair';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, raster.w, raster.h]);

  if (raster.w === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-fg-3 text-mini">
        waiting for the projector window…
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4">
      <div className="text-micro text-fg-3 uppercase tracking-wider">Projector raster — {raster.w}×{raster.h}</div>
      <div ref={boxRef} className="relative w-full max-w-full border border-line-2 bg-surface-0/40"
        style={{ aspectRatio: `${raster.w} / ${raster.h}`, maxHeight: 'calc(100% - 60px)' }}>
        {picks.map((p, i) => {
          const err = errors?.[i];
          const band = err != null && isFinite(err) ? poseBand(err) : null;
          const px = dragPos?.i === i ? dragPos.px : p.pixel;
          const pos = { left: `${(px[0] / raster.w) * 100}%`, top: `${(px[1] / raster.h) * 100}%` };
          return (
            <React.Fragment key={i}>
              {/* Grab-and-drag moves the pick's pixel directly (pointer capture keeps the moves
                  coming even when the cursor outruns the 12px dot); a plain press just selects. */}
              <button
                onPointerDown={onMovePixel ? ((e) => { e.preventDefault(); (e.target as Element).setPointerCapture(e.pointerId); dragIdx.current = i; onSelect(i); }) : undefined}
                onPointerMove={onMovePixel ? ((e) => { if (dragIdx.current !== i) return; const px = dragToPixel(e); if (px) { setDragPos({ i, px }); onMovePixel(i, px); } }) : undefined}
                onPointerUp={onMovePixel ? ((e) => {
                  if (dragIdx.current !== i) return;
                  dragIdx.current = null;
                  const px = dragToPixel(e);
                  if (px) onMovePixel(i, px);
                  setDragPos(null);
                  calibWorkspace.endPickDrag(); // released → one document write
                }) : undefined}
                onClick={onMovePixel ? undefined : (() => onSelect(selected === i ? null : i))}
                aria-label={`Point ${i + 1}`} title={`#${i + 1}${err != null && isFinite(err) ? ` — ${err.toFixed(1)} px` : ''} — drag to move`}
                className={`absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border no-press ${onMovePixel ? 'cursor-grab' : ''} ${band ? bandDot[band] : 'bg-accent'} ${selected === i ? 'border-fg-1 scale-150' : 'border-black/40'}`}
                style={pos} />
              {/* Same number as the 3D marker, the list row and the projected marker. */}
              <span className={`absolute num text-micro pointer-events-none ${selected === i ? 'text-fg-1' : 'text-fg-2'}`}
                style={{ ...pos, transform: 'translate(7px, -17px)', textShadow: '0 0 3px #000' }}>{i + 1}</span>
            </React.Fragment>
          );
        })}
        {/* Live crosshair (rAF-driven) — white, matching the one on the projection. */}
        <div ref={crossRef} className="absolute w-4 h-4 -ml-2 -mt-2 pointer-events-none" style={{ display: 'none' }}>
          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-fg-1" />
          <div className="absolute top-1/2 left-0 right-0 h-px bg-fg-1" />
        </div>
      </div>
      <div ref={statusRef} className="text-micro text-fg-3 h-4">
        {active ? '' : 'Points appear here as you capture them'}
      </div>
    </div>
  );
};
