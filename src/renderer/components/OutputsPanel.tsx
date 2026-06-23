import React, { useEffect } from 'react';
import { X, MonitorUp, RefreshCw, Frame, Undo2 } from 'lucide-react';
import { Surface } from '../types';
import { ProjectorOutput, DisplayInfo } from '../../../shared/protocol';

interface Props {
  open: boolean;
  onClose: () => void;
  surfaces: Surface[];
  outputs: ProjectorOutput[];
  displays: DisplayInfo[];
  editingOutputId: string | null;
  onSetEnabled: (surfaceId: string, enabled: boolean) => void;
  onSetDisplay: (surfaceId: string, displayId: number | null) => void;
  onToggleEdit: (surfaceId: string) => void;
  onResetCorners: (surfaceId: string) => void;
  onRefreshDisplays: () => void;
}

const cell = 'bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-fg-1 text-[11px] focus:border-accent focus:outline-none disabled:opacity-40';

// Screen / output manager: route each Surface to a physical display as a fullscreen
// projector output (corner-pin warp lives in the projector window). Display picker +
// enable toggle; the App reconciler opens/moves/closes the actual output windows.
export const OutputsPanel: React.FC<Props> = ({
  open, onClose, surfaces, outputs, displays, editingOutputId,
  onSetEnabled, onSetDisplay, onToggleEdit, onResetCorners, onRefreshDisplays,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const outFor = (id: string): ProjectorOutput | undefined => outputs.find((o) => o.surfaceId === id);
  const COLS = 'grid-cols-[1.3fr_60px_1.4fr_56px_124px]';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Outputs"
        className="w-[760px] max-w-[95vw] max-h-[85vh] flex flex-col bg-surface-1 border border-line-2 rounded-[var(--r-lg)] shadow-2xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider flex items-center gap-1.5"><MonitorUp size={14} /> Outputs</span>
          <div className="flex items-center gap-2">
            <button onClick={onRefreshDisplays} title="Re-scan displays" className="flex items-center gap-1 text-[11px] text-fg-2 hover:text-fg-1"><RefreshCw size={13} /> Re-scan</button>
            <button onClick={onClose} aria-label="Close outputs" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          <div className="text-[11px] text-fg-3">
            {displays.length} display{displays.length === 1 ? '' : 's'} detected.
            Enable a surface and pick a display to send it fullscreen to a projector. Click
            <span className="text-fg-2"> Align</span> to drag the four corners onto the real
            projection surface (on the projector: arrows nudge, <b>R</b> reset, <b>Esc</b> done).
          </div>

          <div className="border border-line-1 rounded-[var(--r-md)] divide-y divide-line-1">
            <div className={`grid ${COLS} gap-2 px-2 py-1 text-[9px] uppercase tracking-wider text-fg-3`}>
              <span>Surface</span><span>Output</span><span>Display</span><span>Status</span><span>Align</span>
            </div>
            {surfaces.length === 0 && <div className="px-2 py-2 text-[11px] text-fg-3 italic">No surfaces.</div>}
            {surfaces.map((s) => {
              const o = outFor(s.id);
              const enabled = !!o?.enabled;
              const displayId = o?.displayId ?? null;
              const live = enabled && displayId != null && displays.some((d) => d.id === displayId);
              return (
                <div key={s.id} className={`grid ${COLS} gap-2 px-2 py-1.5 items-center`}>
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
                    {displays.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                  </select>
                  <span className={`text-[10px] truncate ${live ? 'text-ok' : 'text-fg-3'}`}>
                    {live ? 'Live' : enabled ? 'Pick a display' : 'Idle'}
                  </span>
                  <div className="flex items-center gap-1 justify-self-end">
                    <button
                      onClick={() => onToggleEdit(s.id)}
                      disabled={!live}
                      title="Align corners on the projector"
                      className={`flex items-center gap-1 px-1.5 py-1 rounded-[var(--r-sm)] text-[10px] disabled:opacity-30 ${
                        editingOutputId === s.id ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'
                      }`}
                    >
                      <Frame size={12} /> {editingOutputId === s.id ? 'Aligning' : 'Align'}
                    </button>
                    <button
                      onClick={() => onResetCorners(s.id)}
                      disabled={!live}
                      title="Reset corner-pin to fullscreen"
                      className="p-1 rounded-[var(--r-sm)] text-fg-3 hover:text-fg-1 disabled:opacity-30"
                    >
                      <Undo2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
