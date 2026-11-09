import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useDraggable, type PanelProps } from '@artlux/sdk/renderer';
import { useConfirm } from '@/components/ui/feedback'; // never a native dialog — see the invariant
import type { MediapipeArea, MediapipeFloor, TrackingZone } from '../../../shared/protocol';
import * as poseEngine from './poseEngine';
import * as poseCamera from './poseCamera';
import * as poseStore from './poseStore';
import { getHost } from './poseHost';
import { QuadPicker, type ZoneOverlay } from './QuadPicker';
import { DEFAULT_QUAD, validateQuad, type Quad } from './poseAreaMath';
import { POSE_SURFACE_KEY, cameraMismatch, points as areaPoints } from './poseArea';

// POSE CALIBRATION — one modal, three tabs over the live camera picture:
//
//   INTERACTION AREA  the quad trigger zones on the 'POSE' surface live in (Scene3D.mediapipeArea). Any
//                     plane: a wall people touch, a screen, a floor, a box of air in front of the lens.
//   FLOOR (3D)        the floor rectangle of known size that places people in the 3D scene
//                     (Scene3D.mediapipeFloor) — what this wizard used to be, on its own.
//   TEST              the area seen flat, with the zones and every body part BlazePose reports, lit as
//                     they would count. Walk the zones here before trusting them with a show.
//
// SAFE BY CONSTRUCTION. Edits are STAGED: nothing reaches the project until Save, and Save is ONE patch.
// A quad the homography cannot trust is refused with the reason (poseAreaMath.validateQuad). Closing with
// unsaved edits, and Clear, both ask first — the old wizard discarded on a stray backdrop click and
// cleared without asking. And the camera is recorded with the calibration, so a swapped webcam is
// flagged instead of silently mapping people to the wrong patch of wall.

type Tab = 'area' | 'floor' | 'test';

const TAB_HINT: Record<Tab, string> = {
  area: 'Where trigger zones live — what makes the camera fire the show. Any plane: wall, screen, floor.',
  floor: 'Only for the 3D preview: places people on a real-size floor. Triggers nothing.',
  test: 'Walk through your zones and watch them light.',
};

// THE TWO CALIBRATIONS, SIDE BY SIDE. They look alike (four corners on the same picture) and do unrelated
// jobs, and the first question every operator asked was "which one makes my zones work?". So both tabs
// show the same two-column answer, the current one ringed. Colour is selection only (design system).
const AreaVsFloor: React.FC<{ active: 'area' | 'floor' }> = ({ active }) => {
  const col = (id: 'area' | 'floor', title: string, lines: React.ReactNode[]) => (
    <div className={`rounded border px-2 py-1.5 ${active === id ? 'border-accent bg-accent/5' : 'border-line-1'}`}>
      <div className={`text-micro font-bold ${active === id ? 'text-fg-1' : 'text-fg-2'}`}>{title}</div>
      <ul className="mt-0.5 space-y-0.5 text-micro text-fg-3 leading-snug">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
    </div>
  );
  return (
    <div className="grid grid-cols-2 gap-2">
      {col('area', 'Interaction area — fires the show', [
        <>Trigger zones live inside it and count hands, feet, head or body.</>,
        <>Any surface the camera sees: a wall, a screen, the floor, a box of air.</>,
        <>No measurements — zones are drawn in proportions.</>,
        <><b>Needed</b> for a camera-driven show.</>,
      ])}
      {col('floor', 'Floor (3D) — the 3D preview only', [
        <>Places each person's feet on a real-size floor in the 3D scene.</>,
        <>A floor rectangle whose width and depth you measure, in metres.</>,
        <>Triggers nothing: zones never use it.</>,
        <><b>Optional.</b> Mark both if you want both; the corners are separate.</>,
      ])}
    </div>
  );
};
const FLOOR_DEFAULT: Quad = [[0.28, 0.70], [0.72, 0.70], [0.9, 0.18], [0.1, 0.18]]; // a perspective trapezoid hint

function useScene3D<T>(): T | undefined {
  const host = getHost();
  return useSyncExternalStore(
    (cb) => host?.scene3D.subscribe(cb) ?? (() => {}),
    () => host?.scene3D.get() as T | undefined,
  );
}
const usePoseTick = () => useSyncExternalStore(poseStore.subscribe, poseStore.lastUpdatedAt);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fmt = (n: number) => String(Math.round(n * 100) / 100);

// The area's real proportions as the picture suggests them — a starting value the operator corrects.
function pictureAspect(q: Quad, px: { w: number; h: number } | null): number {
  const W = px?.w ?? 16, H = px?.h ?? 9;
  const d = (a: [number, number], b: [number, number]) => Math.hypot((a[0] - b[0]) * W, (a[1] - b[1]) * H);
  const w = (d(q[0], q[1]) + d(q[3], q[2])) / 2, h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  return h > 1e-6 ? Math.max(0.1, Math.min(10, w / h)) : 1;
}

export const PoseCalibration: React.FC<PanelProps> = ({ onClose }) => {
  const { positionerStyle, handleProps } = useDraggable();
  const confirm = useConfirm();
  const asking = useRef(false); // a confirm is open — Escape belongs to it, not to this wizard
  const ask = async (opts: Parameters<typeof confirm>[0]) => {
    asking.current = true;
    try { return !!(await confirm(opts)); } finally { asking.current = false; }
  };
  // TAKE FOCUS ON OPEN. The menu item that opened this keeps focus otherwise, and the menu swallows
  // Escape (stopPropagation) — so Esc did nothing and the arrow keys never reached the corner picker.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.focus(); }, []);
  const host = getHost();
  const scene = useScene3D<{ mediapipeArea?: MediapipeArea; mediapipeFloor?: MediapipeFloor; trackingZones?: TrackingZone[] }>();
  const savedArea = scene?.mediapipeArea;
  const savedFloor = scene?.mediapipeFloor;
  usePoseTick();

  const [tab, setTab] = useState<Tab>(savedArea || !savedFloor ? 'area' : 'floor');
  // STAGED copies. Seeded once from what is saved; Revert re-seeds.
  const [areaQuad, setAreaQuad] = useState<Quad>(() => savedArea?.imageQuad ?? DEFAULT_QUAD);
  const [mirror, setMirror] = useState<boolean>(() => !!savedArea?.mirror);
  const [aspectText, setAspectText] = useState<string>(() => (savedArea ? fmt(savedArea.aspect) : ''));
  const [floorQuad, setFloorQuad] = useState<Quad>(() => savedFloor?.imageQuad ?? FLOOR_DEFAULT);
  const [widthText, setWidthText] = useState(() => String(savedFloor?.width ?? 4));
  const [depthText, setDepthText] = useState(() => String(savedFloor?.depth ?? 3));

  // Run the camera + inference while the wizard is open (even with no pose surface on screen).
  useEffect(() => { poseEngine.acquire('pose-calibrate'); return () => poseEngine.release('pose-calibrate'); }, []);
  const [status, setStatus] = useState(() => poseEngine.status());
  useEffect(() => { const id = window.setInterval(() => setStatus(poseEngine.status()), 400); return () => window.clearInterval(id); }, []);
  const cam = poseCamera.info();

  // ── area ──
  const autoAspect = pictureAspect(areaQuad, cam);
  const aspectNum = aspectText.trim() === '' ? autoAspect : parseFloat(aspectText);
  const aspectErr = !(Number.isFinite(aspectNum) && aspectNum >= 0.1 && aspectNum <= 10) ? 'Use a width ÷ height between 0.1 and 10.' : null;
  const areaInvalid = validateQuad(areaQuad);
  const stagedArea: MediapipeArea = {
    imageQuad: areaQuad, aspect: aspectErr ? 1 : aspectNum, mirror: mirror || undefined,
    camera: cam ?? savedArea?.camera,
  };
  const areaDirty = !savedArea
    ? !same(areaQuad, DEFAULT_QUAD) || mirror || aspectText !== ''
    : !same(areaQuad, savedArea.imageQuad) || mirror !== !!savedArea.mirror || Math.abs(stagedArea.aspect - savedArea.aspect) > 1e-6;

  // ── floor ──
  const width = parseFloat(widthText), depth = parseFloat(depthText);
  const widthErr = !(Number.isFinite(width) && width > 0 && width <= 200) ? 'Width must be a positive number of metres.' : null;
  const depthErr = !(Number.isFinite(depth) && depth > 0 && depth <= 200) ? 'Depth must be a positive number of metres.' : null;
  const floorInvalid = validateQuad(floorQuad);
  const floorDirty = !savedFloor
    ? !same(floorQuad, FLOOR_DEFAULT) || widthText !== '4' || depthText !== '3'
    : !same(floorQuad, savedFloor.imageQuad) || width !== savedFloor.width || depth !== savedFloor.depth;

  const dirty = areaDirty || floorDirty;

  // ── zones on the area (drawn on the picture and in Test, lit when a qualifying part is inside) ──
  const pts = areaPoints();
  const zones: ZoneOverlay[] = useMemo(() => (scene?.trackingZones ?? []).filter((z) => z.surface === POSE_SURFACE_KEY).map((z) => {
    const u0 = Math.min(z.u0, z.u1), u1 = Math.max(z.u0, z.u1), v0 = Math.min(z.v0, z.v1), v1 = Math.max(z.v0, z.v1);
    const want = z.parts?.length ? z.parts : null;
    const hit = pts.some((p) => (!want || (p.part && want.includes(p.part))) && p.u >= u0 && p.u <= u1 && p.v >= v0 && p.v <= v1);
    return { id: z.id, name: z.name, u0, v0, u1, v1, hit };
  }), [scene?.trackingZones, pts]);

  // ── actions ──
  const saveArea = () => { if (areaInvalid || aspectErr) return; host?.scene3D.patch({ mediapipeArea: stagedArea } as never); };
  const saveFloor = () => {
    if (floorInvalid || widthErr || depthErr) return;
    host?.scene3D.patch({ mediapipeFloor: { imageQuad: floorQuad, width, depth } } as never);
  };
  const revert = () => {
    if (tab === 'floor') { setFloorQuad(savedFloor?.imageQuad ?? FLOOR_DEFAULT); setWidthText(String(savedFloor?.width ?? 4)); setDepthText(String(savedFloor?.depth ?? 3)); }
    else { setAreaQuad(savedArea?.imageQuad ?? DEFAULT_QUAD); setMirror(!!savedArea?.mirror); setAspectText(savedArea ? fmt(savedArea.aspect) : ''); }
  };
  const reset = () => { if (tab === 'floor') setFloorQuad(FLOOR_DEFAULT); else setAreaQuad(DEFAULT_QUAD); };
  const clear = async () => {
    const what = tab === 'floor' ? 'floor calibration' : 'interaction area';
    const consequence = tab === 'floor' ? 'People will no longer be placed in the 3D scene.' : 'Trigger zones on the camera area will stop seeing anyone until it is marked again.';
    if (!(await ask({ title: `Clear the saved ${what}?`, message: consequence, confirmLabel: 'Clear', danger: true }))) return;
    if (tab === 'floor') { host?.scene3D.patch({ mediapipeFloor: undefined } as never); setFloorQuad(FLOOR_DEFAULT); }
    else { host?.scene3D.patch({ mediapipeArea: undefined } as never); setAreaQuad(DEFAULT_QUAD); setMirror(false); setAspectText(''); }
  };
  const close = async () => {
    if (asking.current) return;
    if (dirty && !(await ask({ title: 'Close without saving?', message: 'Your unsaved corner changes will be lost.', confirmLabel: 'Discard changes', danger: true }))) return;
    onClose?.();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !asking.current) { e.preventDefault(); void close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const mismatch = cameraMismatch();
  // People from the STORE (what zones see — also counts a simulated source), fps from the engine.
  const seen = poseStore.getDetections().length;
  const engineState = status.disabled ? 'Camera unavailable' : status.running ? `${status.fps} fps · ${seen} ${seen === 1 ? 'person' : 'people'}` : 'Starting camera…';

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40" onClick={() => void close()}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-label="Pose Calibration" style={positionerStyle} onClick={(e) => e.stopPropagation()}
        className="outline-none w-[720px] max-w-[96vw] max-h-[94vh] flex flex-col rounded-lg border border-line-1 bg-surface-1 shadow-2xl overflow-hidden">
        <div {...handleProps} className="flex items-center justify-between px-3 py-2 border-b border-line-1 bg-surface-2 cursor-move select-none">
          <span className="text-mini font-bold text-fg-1">Pose Calibration</span>
          <span className={`text-micro ml-3 mr-auto ${status.disabled ? 'text-danger' : 'text-fg-3'}`}>{engineState}</span>
          <button onClick={() => void close()} className="text-fg-3 hover:text-fg-1 text-mini">✕</button>
        </div>

        <div className="flex gap-1 px-3 pt-2 border-b border-line-1">
          {([['area', 'Interaction area', areaDirty], ['floor', 'Floor (3D)', floorDirty], ['test', 'Test', false]] as const).map(([id, label, d]) => (
            <button key={id} onClick={() => setTab(id)} title={TAB_HINT[id]}
              className={`text-mini px-3 py-1.5 rounded-t border-b-2 -mb-px ${tab === id ? 'border-accent text-fg-1' : 'border-transparent text-fg-3 hover:text-fg-1'}`}>
              {label}{d ? ' •' : ''}
            </button>
          ))}
        </div>

        <div className="p-3 space-y-2.5 overflow-y-auto">
          {status.disabled && (
            <div className="flex items-center gap-2 text-micro text-danger border border-danger/40 bg-danger/10 rounded px-2 py-1.5">
              <span className="flex-1 break-words">The camera or the pose model could not start{status.error ? `: ${status.error}` : '.'} Check the camera is plugged in and not used by another app.</span>
              <button onClick={() => poseEngine.retry()} className="px-2 py-1 rounded border border-danger/60 text-fg-1 shrink-0">Retry camera</button>
            </div>
          )}
          {mismatch && tab !== 'floor' && <div className="text-micro text-warn border border-warn/40 bg-warn/10 rounded px-2 py-1.5">⚠ {mismatch}</div>}

          {tab !== 'test' && <AreaVsFloor active={tab} />}

          {tab === 'area' && (
            <>
              <p className="text-micro text-fg-3 leading-snug">
                Mark the part of the picture people interact with — a wall they touch, a screen, the floor, or
                a box of air in front of the camera. Drag the four corners onto it, or press <b>Walk the corners</b>{' '}
                and hold a hand still at each corner in turn. Trigger zones on <b>Camera area</b> are drawn inside it.
              </p>
              <QuadPicker quad={areaQuad} onChange={setAreaQuad} mirror={mirror} areaOverlay zones={zones} />
              <div className="flex flex-wrap items-start gap-4">
                <label className="flex items-center gap-2 text-xs text-fg-2" title="Show the picture as a mirror, the way people facing the camera see themselves. Left and right hands are still the person's own.">
                  <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Mirror (selfie view)
                </label>
                <label className="flex items-center gap-2 text-xs text-fg-2" title="The area's real width ÷ height, so zones are drawn with true proportions. Blank = estimated from the picture.">
                  Shape W÷H
                  <input value={aspectText} placeholder={fmt(autoAspect)} onChange={(e) => setAspectText(e.target.value)}
                    className={`num w-16 bg-surface-0 border rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none ${aspectErr ? 'border-danger' : 'border-line-1'}`} />
                </label>
                {aspectErr && <span className="text-micro text-danger">{aspectErr}</span>}
              </div>
            </>
          )}

          {tab === 'floor' && (
            <>
              <p className="text-micro text-fg-3 leading-snug">
                For the 3D preview only. Drag the corners onto a floor rectangle whose real size you know, then
                enter its width and depth. The top edge is the far side of the floor.
              </p>
              <QuadPicker quad={floorQuad} onChange={setFloorQuad} />
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-fg-2">Width (m)
                  <input value={widthText} onChange={(e) => setWidthText(e.target.value)}
                    className={`num w-20 bg-surface-0 border rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none ${widthErr ? 'border-danger' : 'border-line-1'}`} />
                </label>
                <label className="flex items-center gap-2 text-xs text-fg-2">Depth (m)
                  <input value={depthText} onChange={(e) => setDepthText(e.target.value)}
                    className={`num w-20 bg-surface-0 border rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none ${depthErr ? 'border-danger' : 'border-line-1'}`} />
                </label>
              </div>
              {(widthErr || depthErr) && <div className="text-micro text-danger">{widthErr ?? depthErr}</div>}
            </>
          )}

          {tab === 'test' && (
            <TestView area={savedArea} zones={zones} pts={pts} unsaved={areaDirty} />
          )}
        </div>

        {tab !== 'test' && (
          <div className="flex items-center gap-2 px-3 py-2 border-t border-line-1">
            <button onClick={() => void clear()} disabled={tab === 'floor' ? !savedFloor : !savedArea}
              className="text-mini px-3 py-1.5 rounded border border-line-1 text-fg-2 disabled:opacity-40">Clear…</button>
            <button onClick={reset} className="text-mini px-3 py-1.5 rounded border border-line-1 text-fg-2" title="Put the corners back to the starting rectangle">Reset corners</button>
            <button onClick={revert} disabled={tab === 'floor' ? !floorDirty : !areaDirty}
              className="text-mini px-3 py-1.5 rounded border border-line-1 text-fg-2 disabled:opacity-40" title="Back to the last saved calibration">Revert</button>
            <span className="flex-1" />
            {tab === 'area' ? (
              <button onClick={saveArea} disabled={!!areaInvalid || !!aspectErr || (!areaDirty && !!savedArea)}
                className="text-mini px-3 py-1.5 rounded bg-accent text-white disabled:opacity-40">Save area</button>
            ) : (
              <button onClick={saveFloor} disabled={!!floorInvalid || !!widthErr || !!depthErr || (!floorDirty && !!savedFloor)}
                className="text-mini px-3 py-1.5 rounded bg-accent text-white disabled:opacity-40">Save floor</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// THE AREA SEEN FLAT — what the zone engine sees. Zones light when a part they count is inside; every
// part is drawn and labelled (L/R hand, feet, head, body), one shape per person.
const PART_TAG: Record<string, string> = { handL: 'L', handR: 'R', footL: 'l', footR: 'r', head: 'H', body: 'B' };
const TestView: React.FC<{ area?: MediapipeArea; zones: ZoneOverlay[]; pts: { u: number; v: number; person: string; part?: string }[]; unsaved: boolean }> = ({ area, zones, pts, unsaved }) => {
  if (!area) return <div className="text-micro text-fg-3 italic py-6 text-center">Save an interaction area first — the test shows the SAVED area, exactly as the zones see it.</div>;
  return (
    <div className="space-y-1.5">
      {unsaved && <div className="text-micro text-warn">The area has unsaved changes — this shows the saved one.</div>}
      <div className="relative w-full mx-auto rounded border border-line-1 bg-surface-0 overflow-hidden" style={{ aspectRatio: String(area.aspect), maxHeight: '52vh' }}>
        {zones.map((z) => (
          <div key={z.id} className={`absolute border ${z.hit ? 'border-accent bg-accent/25' : 'border-line-2 border-dashed bg-surface-2/40'}`}
            style={{ left: `${z.u0 * 100}%`, width: `${(z.u1 - z.u0) * 100}%`, top: `${(1 - z.v1) * 100}%`, height: `${(z.v1 - z.v0) * 100}%` }}>
            <span className={`absolute top-0.5 left-1 text-micro ${z.hit ? 'text-fg-1 font-bold' : 'text-fg-3'}`}>{z.name}</span>
          </div>
        ))}
        {pts.map((p, i) => (
          <span key={i} className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full bg-fg-1 text-surface-0 font-bold pointer-events-none"
            style={{ left: `${p.u * 100}%`, top: `${(1 - p.v) * 100}%`, width: 14, height: 14, fontSize: 8 }}
            title={`person ${Number(p.person) + 1} · ${p.part}`}>
            {PART_TAG[p.part ?? ''] ?? '•'}
          </span>
        ))}
        {zones.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-micro text-fg-3 italic">No trigger zones on the camera area yet — draw them in Trigger Zones.</div>}
      </div>
      <div className="text-micro text-fg-3">L / R = left / right hand · l / r = feet · H = head · B = body. A zone lights when a part it counts is inside (its dwell is not applied here).</div>
    </div>
  );
};
