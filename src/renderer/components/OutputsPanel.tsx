import React, { useEffect, useState } from 'react';
import { X, MonitorUp, RefreshCw, Frame, Undo2, Settings2, Spline, Gauge, Radio, Aperture, Cpu, Camera, Loader2 } from 'lucide-react';
import { Surface } from '../types';
import { ProjectorOutput, DisplayInfo, SoftEdge, defaultSoftEdge, WINDOWED_DISPLAY } from '../../../shared/protocol';

interface Props {
  open: boolean;
  onClose: () => void;
  surfaces: Surface[];
  outputs: ProjectorOutput[];
  displays: DisplayInfo[];
  editingOutputId: string | null;
  fpsCap: number;
  onSetEnabled: (surfaceId: string, enabled: boolean) => void;
  onSetDisplay: (surfaceId: string, displayId: number | null) => void;
  onToggleEdit: (surfaceId: string) => void;
  onResetCorners: (surfaceId: string) => void;
  onToggleWarp: (surfaceId: string, on: boolean) => void;
  onSetSoftEdge: (surfaceId: string, patch: Partial<SoftEdge>) => void;
  onSetGamma: (surfaceId: string, gamma: number) => void;
  onSetColorMatch: (surfaceId: string, patch: { colorGain?: [number, number, number]; blackLift?: [number, number, number] }) => void;
  onMeasureGamma: (surfaceId: string) => void;                 // camera-measure projector gamma + colour
  measuringGammaId: string | null;                            // output currently being measured (busy)
  gammaMsg: { id: string; text: string; ok: boolean } | null; // last measurement result / error
  onToggleNdiSend: (surfaceId: string, on: boolean) => void;
  onSetFpsCap: (cap: number) => void;
  onRefreshDisplays: () => void;
  onCalibrate: (surfaceId: string) => void;
  onSetUseCalibration: (surfaceId: string, on: boolean) => void;
  nvAvailable: boolean;                                    // NVAPI scanout warp/blend present (Quadro/RTX-pro)
  onSetHwWarp: (surfaceId: string, on: boolean) => void;   // apply warp+blend at the GPU scanout
}

const cell = 'bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-fg-1 text-[11px] focus:border-accent focus:outline-none disabled:opacity-40';
const numCell = 'w-12 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num text-[10px] focus:border-accent focus:outline-none';
const clamp01h = (v: number) => Math.max(0, Math.min(0.5, v));

// Screen / output manager: route each Surface to a physical display as a fullscreen
// projector output (corner-pin warp lives in the projector window). Display picker +
// enable toggle; the App reconciler opens/moves/closes the actual output windows.
export const OutputsPanel: React.FC<Props> = ({
  open, onClose, surfaces, outputs, displays, editingOutputId, fpsCap,
  onSetEnabled, onSetDisplay, onToggleEdit, onResetCorners,
  onToggleWarp, onSetSoftEdge, onSetGamma, onSetColorMatch, onMeasureGamma, measuringGammaId, gammaMsg, onToggleNdiSend, onSetFpsCap, onRefreshDisplays, onCalibrate, onSetUseCalibration,
  nvAvailable, onSetHwWarp,
}) => {
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const outFor = (id: string): ProjectorOutput | undefined => outputs.find((o) => o.surfaceId === id);
  const COLS = 'grid-cols-[1.3fr_56px_1.3fr_48px_144px_28px]';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Outputs"
        className="w-[760px] max-w-[95vw] max-h-[85vh] flex flex-col bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><MonitorUp size={14} /> Outputs</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-fg-2" title="Performance mode: cap projector output frame rate">
              <Gauge size={13} /> FPS cap
              <select
                value={fpsCap}
                onChange={(e) => onSetFpsCap(Number(e.target.value))}
                className="bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-fg-1 text-[11px] focus:border-accent focus:outline-none"
              >
                <option value={0}>Off</option>
                <option value={60}>60</option>
                <option value={30}>30</option>
                <option value={24}>24</option>
              </select>
            </label>
            <button onClick={onRefreshDisplays} title="Re-scan displays" className="flex items-center gap-1 text-[11px] text-fg-2 hover:text-fg-1"><RefreshCw size={13} /> Re-scan</button>
            <button onClick={onClose} aria-label="Close outputs" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          <div className="text-[11px] text-fg-3">
            {displays.length} display{displays.length === 1 ? '' : 's'} detected.
            Enable a surface and pick a display (fullscreen on a projector) — or <span className="text-fg-2">Windowed</span> to
            output to a movable window on this screen (handy for testing on one monitor). Click
            <span className="text-fg-2"> Align</span> to drag the four corners onto the real
            projection surface (on the projector: arrows nudge, <b>R</b> reset, <b>Esc</b> done).
          </div>

          <div className="border border-line-1 rounded-[var(--r-md)] divide-y divide-line-1">
            <div className={`grid ${COLS} gap-2 px-2 py-1 text-[9px] uppercase tracking-wider text-fg-3`}>
              <span>Surface</span><span>Output</span><span>Display</span><span>Status</span><span>Align</span><span></span>
            </div>
            {surfaces.length === 0 && <div className="px-2 py-2 text-[11px] text-fg-3 italic">No surfaces.</div>}
            {surfaces.map((s) => {
              const o = outFor(s.id);
              const enabled = !!o?.enabled;
              const displayId = o?.displayId ?? null;
              const live = enabled && displayId != null && (displayId === WINDOWED_DISPLAY || displays.some((d) => d.id === displayId));
              const soft = o?.softEdge ?? defaultSoftEdge();
              const isOpen = expanded === s.id && live;
              return (
                <React.Fragment key={s.id}>
                <div className={`grid ${COLS} gap-2 px-2 py-1.5 items-center`}>
                  <span className="text-[11px] text-fg-1 truncate" title={s.name}>{s.name}</span>
                  <label className="flex items-center gap-1.5 text-[11px] text-fg-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => onSetEnabled(s.id, e.target.checked)}
                      className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
                    />
                    {enabled ? 'On' : 'Off'}
                  </label>
                  <select
                    className={cell}
                    value={displayId ?? ''}
                    onChange={(e) => onSetDisplay(s.id, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">— pick display —</option>
                    <option value={WINDOWED_DISPLAY}>Windowed (this screen)</option>
                    {displays.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  <span className={`text-[10px] truncate ${live ? 'text-ok' : 'text-fg-3'}`}>
                    {live ? 'Live' : enabled ? 'Pick a display' : 'Idle'}
                  </span>
                  <div className="flex items-center gap-1 justify-self-end">
                    <button
                      onClick={() => onToggleEdit(s.id)}
                      disabled={!live}
                      title="Align corners/mesh on the projector"
                      className={`flex items-center gap-1 px-1.5 py-1 rounded-[var(--r-sm)] text-[10px] disabled:opacity-30 ${
                        editingOutputId === s.id ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'
                      }`}
                    >
                      <Frame size={12} /> {editingOutputId === s.id ? 'Aligning' : 'Align'}
                    </button>
                    <button
                      onClick={() => onResetCorners(s.id)}
                      disabled={!live}
                      title="Reset warp to fullscreen"
                      className="p-1 rounded-[var(--r-sm)] text-fg-3 hover:text-fg-1 disabled:opacity-30"
                    >
                      <Undo2 size={12} />
                    </button>
                    <button
                      onClick={() => onCalibrate(s.id)}
                      disabled={!live}
                      title="Calibrate projector (structured light + pose)"
                      className={`p-1 rounded-[var(--r-sm)] disabled:opacity-30 ${o?.calibration ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}
                    >
                      <Aperture size={12} />
                    </button>
                  </div>
                  <button
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                    disabled={!live}
                    title="Warp / soft-edge / gamma"
                    className={`p-1 rounded-[var(--r-sm)] justify-self-center disabled:opacity-30 ${isOpen ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}
                  >
                    <Settings2 size={13} />
                  </button>
                </div>

                {isOpen && (
                  <div className="px-3 py-2.5 bg-surface-0/40 space-y-2.5 text-[11px]">
                    {/* Bézier warp */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
                        <Spline size={12} className="text-fg-3" />
                        <input type="checkbox" checked={!!o?.warp} onChange={(e) => onToggleWarp(s.id, e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                        Bézier warp
                      </label>
                      {o?.warp && <span className="text-fg-3 italic">Align → drag the 16 control points (corners + curve handles)</span>}
                    </div>

                    {/* Soft edge */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-fg-3 w-[68px]">Soft edge %</span>
                      {(['left', 'right', 'top', 'bottom'] as const).map((side) => (
                        <label key={side} className="flex items-center gap-1 text-fg-2">
                          <span className="uppercase text-[9px] text-fg-3">{side[0]}</span>
                          <input type="number" min={0} max={50} value={Math.round(soft[side] * 100)}
                            onChange={(e) => onSetSoftEdge(s.id, { [side]: clamp01h((+e.target.value) / 100) })} className={numCell} />
                        </label>
                      ))}
                      <label className="flex items-center gap-1 text-fg-2">Blend γ
                        <input type="number" step={0.1} min={0.1} value={+soft.gamma.toFixed(2)}
                          onChange={(e) => onSetSoftEdge(s.id, { gamma: Math.max(0.1, +e.target.value) })} className={numCell} />
                      </label>
                    </div>

                    {/* Output gamma */}
                    <div className="flex items-center gap-2">
                      <span className="text-fg-3 w-[68px]">Output γ</span>
                      <input type="range" min={0.5} max={3} step={0.05} value={o?.gamma ?? 1}
                        onChange={(e) => onSetGamma(s.id, +e.target.value)} className="w-40 accent-accent" />
                      <span className="num text-fg-2 w-8">{(o?.gamma ?? 1).toFixed(2)}</span>
                      <button onClick={() => onSetGamma(s.id, 1)} className="text-fg-3 hover:text-fg-1">reset</button>
                    </div>

                    {/* Camera-measured gamma + colour: projects a level ramp on this output, samples the
                        camera RGB in the lit footprint, fits the response → writes Output γ + Colour gain. */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button onClick={() => onMeasureGamma(s.id)} disabled={measuringGammaId != null}
                        title="Project a ramp and measure this projector's gamma + colour through the camera"
                        className="flex items-center gap-1.5 px-2 py-1 rounded-[var(--r-sm)] bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 disabled:opacity-40">
                        {measuringGammaId === s.id ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />}
                        {measuringGammaId === s.id ? 'Measuring…' : 'Auto-measure (camera)'}
                      </button>
                      {gammaMsg?.id === s.id && (
                        <span className={`text-[10px] num ${gammaMsg.ok ? 'text-ok' : 'text-danger'}`}>{gammaMsg.text}</span>
                      )}
                    </div>

                    {/* Colour + black-level match across projectors (overlap brightness / black floor) */}
                    {(() => {
                      const gain = o?.colorGain ?? [1, 1, 1];
                      const lift = o?.blackLift ?? [0, 0, 0];
                      const setGain = (i: number, v: number) => { const g = [...gain] as [number, number, number]; g[i] = v; onSetColorMatch(s.id, { colorGain: g }); };
                      const setLift = (i: number, v: number) => { const l = [...lift] as [number, number, number]; l[i] = v; onSetColorMatch(s.id, { blackLift: l }); };
                      return (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-fg-3 w-[68px]">Colour gain</span>
                            {[0, 1, 2].map((i) => (
                              <label key={i} className="flex items-center gap-1 text-fg-2">
                                <span className="uppercase text-[9px] text-fg-3">{'RGB'[i]}</span>
                                <input type="number" step={0.01} min={0} max={2} value={+gain[i].toFixed(2)}
                                  onChange={(e) => setGain(i, Math.max(0, +e.target.value))} className={numCell} />
                              </label>
                            ))}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-fg-3 w-[68px]">Black lift</span>
                            {[0, 1, 2].map((i) => (
                              <label key={i} className="flex items-center gap-1 text-fg-2">
                                <span className="uppercase text-[9px] text-fg-3">{'RGB'[i]}</span>
                                <input type="number" step={0.005} min={0} max={0.3} value={+lift[i].toFixed(3)}
                                  onChange={(e) => setLift(i, Math.max(0, +e.target.value))} className={numCell} />
                              </label>
                            ))}
                            <button onClick={() => onSetColorMatch(s.id, { colorGain: [1, 1, 1], blackLift: [0, 0, 0] })} className="text-fg-3 hover:text-fg-1">reset</button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* NDI send */}
                    <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
                      <Radio size={12} className="text-fg-3" />
                      <input type="checkbox" checked={!!o?.ndiSend} onChange={(e) => onToggleNdiSend(s.id, e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                      Send as NDI <span className="text-fg-3 italic">(publishes “ArtLux — {s.name}” ≤720p, ≤1080p in Broadcast)</span>
                    </label>

                    {/* Hardware (NVAPI) scanout warp + blend — Quadro/RTX-pro only, real displays only */}
                    {nvAvailable && o?.displayId != null && o.displayId !== WINDOWED_DISPLAY && (
                      <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
                        <Cpu size={12} className="text-fg-3" />
                        <input type="checkbox" checked={!!o?.hwWarp} onChange={(e) => onSetHwWarp(s.id, e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                        Hardware warp/blend <span className="text-fg-3 italic">(NVAPI scanout · warp + edge blend on the GPU; GLSL renders flat)</span>
                      </label>
                    )}

                    {/* Render from calibrated projector (3D venue scene) */}
                    {o?.calibration?.poseRms != null && (
                      <label className="flex items-center gap-1.5 cursor-pointer text-fg-2">
                        <Aperture size={12} className="text-fg-3" />
                        <input type="checkbox" checked={!!o?.useCalibration} onChange={(e) => onSetUseCalibration(s.id, e.target.checked)} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                        Render from projector <span className="text-fg-3 italic">(3D venue scene via calibration · pose RMS {o.calibration.poseRms.toFixed(2)} px)</span>
                      </label>
                    )}
                  </div>
                )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
