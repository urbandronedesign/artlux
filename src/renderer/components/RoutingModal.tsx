import React, { useEffect, useMemo } from 'react';
import { X, Plus, Trash2, Lock, Unlock, Hash, AlertTriangle } from 'lucide-react';
import { Fixture, Surface, Controller, AppSettings } from '../types';
import { Button } from './ui';
import { useDraggableModal } from '../hooks/useDraggableModal';
import { fixtureSpans, findCollisions } from '../services/addressing';

interface Props {
  open: boolean;
  onClose: () => void;
  fixtures: Fixture[];
  surfaces: Surface[];
  controllers: Controller[];
  settings: AppSettings;
  onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
  onAddController: () => void;
  onUpdateController: (id: string, patch: Partial<Controller>) => void;
  onRemoveController: (id: string) => void;
  onAutoPatch: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}

const cell = 'w-full bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-fg-1 text-mini focus:border-accent focus:outline-none disabled:opacity-40';

// Routing spreadsheet: manage controllers + patch every fixture (surface link,
// controller, universe/address, channels) in one grid.
export const RoutingModal: React.FC<Props> = ({
  open, onClose, fixtures, surfaces, controllers, settings,
  onUpdateFixture, onAddController, onUpdateController, onRemoveController, onAutoPatch, onUpdateSettings,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const { positionerStyle, handleProps } = useDraggableModal('routing');

  // Address-overlap detector: flag any two fixtures whose channel ranges intersect on the same
  // resolved destination (protocol|ip|broadcast). MUST sit above the early return (Rules of Hooks).
  const collisions = useMemo(() => {
    const def = { protocol: settings.protocol, ip: settings.artNetIp, broadcast: settings.broadcast };
    const pairs = findCollisions(fixtureSpans(fixtures, controllers, def));
    const nameById = new Map(fixtures.map((f) => [f.id, f.name]));
    const partners = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = partners.get(a);
      if (!set) { set = new Set(); partners.set(a, set); }
      set.add(nameById.get(b) ?? b);
    };
    for (const [a, b] of pairs) { add(a, b); add(b, a); }
    return { count: pairs.length, partners };
  }, [fixtures, controllers, settings]);

  if (!open) return null;

  const span = (f: Fixture) => {
    const ch = f.ledCount * (f.channelsPerPixel ?? 4);
    const startAbs = f.universe * 512 + (f.startAddress - 1);
    const endAbs = startAbs + Math.max(0, ch - 1);
    const u0 = Math.floor(startAbs / 512), u1 = Math.floor(endAbs / 512);
    return `${ch}ch · ${u0 === u1 ? `U${u0}` : `U${u0}-${u1}`}`;
  };

  const COLS = 'grid-cols-[1.4fr_1fr_1fr_52px_52px_84px_52px_84px_32px]';

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 animate-overlay-in" onClick={onClose}>
      <div style={positionerStyle}>
      <div
        role="dialog" aria-modal="true" aria-label="Routing"
        className="w-[920px] max-w-[95vw] max-h-[85vh] flex flex-col bg-surface-1 border border-line-2 rounded-lg shadow-e3 animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div {...handleProps} className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0 cursor-move select-none">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Routing</span>
          <div className="flex items-center gap-2">
            {collisions.count > 0 && (
              <span className="flex items-center gap-1 text-mini font-semibold text-danger" title="Two or more fixtures share DMX channels on the same destination — see the red Span cells below">
                <AlertTriangle size={12} /> {collisions.count} {collisions.count === 1 ? 'conflict' : 'conflicts'}
              </span>
            )}
            <label className="flex items-center gap-1 text-mini text-fg-2 cursor-pointer select-none" title="Auto-patch packs auto fixtures AROUND locked ranges instead of through them. Turning this on re-addresses auto fixtures on the next patch — re-upload to hardware after.">
              <input type="checkbox" checked={settings.reserveLockedRanges ?? false} onChange={(e) => onUpdateSettings({ reserveLockedRanges: e.target.checked })} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
              Reserve locked
            </label>
            <Button variant="primary" size="sm" onClick={onAutoPatch}><Hash size={13} /> Auto-patch</Button>
            <button onClick={onClose} aria-label="Close routing" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
          {/* Controllers */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-mini font-semibold text-fg-2 uppercase tracking-wider">Controllers</span>
              <Button variant="tonal" size="sm" onClick={onAddController}><Plus size={13} /> Controller</Button>
            </div>
            <div className="border border-line-1 rounded-md divide-y divide-line-1">
              <div className="grid grid-cols-[1.2fr_0.8fr_1.2fr_64px_72px_64px_32px] gap-1 px-2 py-1 text-micro uppercase tracking-wider text-fg-3">
                <span>Name</span><span>Protocol</span><span>IP</span><span>Bcast</span><span>Start U</span><span>Prio</span><span></span>
              </div>
              {controllers.length === 0 && <div className="px-2 py-2 text-mini text-fg-3 italic">No controllers — fixtures use the global Preferences target.</div>}
              {controllers.map((c) => (
                <div key={c.id} className="grid grid-cols-[1.2fr_0.8fr_1.2fr_64px_72px_64px_32px] gap-1 px-2 py-1 items-center">
                  <input className={cell} value={c.name} onChange={(e) => onUpdateController(c.id, { name: e.target.value })} />
                  <select className={cell} value={c.protocol} onChange={(e) => onUpdateController(c.id, { protocol: e.target.value as Controller['protocol'] })}>
                    <option value="artnet">Art-Net</option><option value="sacn">sACN</option>
                  </select>
                  <input className={`${cell} num`} value={c.ip} onChange={(e) => onUpdateController(c.id, { ip: e.target.value })} />
                  <input type="checkbox" checked={c.broadcast} onChange={(e) => onUpdateController(c.id, { broadcast: e.target.checked })} className="justify-self-center bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                  <input type="number" className={`${cell} num text-right`} value={c.startUniverse ?? 0} onChange={(e) => onUpdateController(c.id, { startUniverse: Math.max(0, Math.round(+e.target.value)) })} />
                  <input type="number" className={`${cell} num text-right`} value={c.priority ?? 100} onChange={(e) => onUpdateController(c.id, { priority: Math.max(0, Math.min(200, Math.round(+e.target.value))) })} />
                  <button onClick={() => onRemoveController(c.id)} title="Remove controller" className="justify-self-center text-fg-3 hover:text-danger"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          </div>

          {/* Fixtures patch grid */}
          <div>
            <span className="text-mini font-semibold text-fg-2 uppercase tracking-wider">Fixtures</span>
            <div className="mt-1.5 border border-line-1 rounded-md divide-y divide-line-1">
              <div className={`grid ${COLS} gap-1 px-2 py-1 text-micro uppercase tracking-wider text-fg-3`}>
                <span>Name</span><span>Surface</span><span>Controller</span><span>Univ</span><span>Start</span><span>Channels</span><span>LEDs</span><span>Span</span><span></span>
              </div>
              {fixtures.length === 0 && <div className="px-2 py-2 text-mini text-fg-3 italic">No fixtures.</div>}
              {fixtures.map((f) => {
                const locked = !!f.patchLocked;
                const clash = collisions.partners.get(f.id);
                return (
                  <div key={f.id} className={`grid ${COLS} gap-1 px-2 py-1 items-center`}>
                    <input className={cell} value={f.name} onChange={(e) => onUpdateFixture(f.id, { name: e.target.value })} />
                    <select className={cell} value={f.surfaceId ?? ''} onChange={(e) => onUpdateFixture(f.id, { surfaceId: e.target.value || undefined })}>
                      <option value="">— off —</option>
                      {surfaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <select className={cell} value={f.controllerId ?? ''} onChange={(e) => onUpdateFixture(f.id, { controllerId: e.target.value || undefined })}>
                      <option value="">Global</option>
                      {controllers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <input type="number" disabled={!locked} className={`${cell} num text-right`} value={f.universe} onChange={(e) => onUpdateFixture(f.id, { universe: Math.max(0, Math.round(+e.target.value)) })} />
                    <input type="number" disabled={!locked} className={`${cell} num text-right`} value={f.startAddress} onChange={(e) => onUpdateFixture(f.id, { startAddress: Math.max(1, Math.min(512, Math.round(+e.target.value))) })} />
                    <select className={cell} value={f.channelsPerPixel ?? 4} onChange={(e) => onUpdateFixture(f.id, { channelsPerPixel: (parseInt(e.target.value) as 3 | 4) })}>
                      <option value={3}>RGB (3)</option><option value={4}>RGBW (4)</option>
                    </select>
                    <input type="number" className={`${cell} num text-right`} value={f.ledCount} onChange={(e) => onUpdateFixture(f.id, { ledCount: Math.max(1, Math.round(+e.target.value)) })} />
                    <span className={`num text-micro truncate ${clash ? 'text-danger font-semibold' : 'text-fg-3'}`} title={clash ? `Overlaps ${[...clash].join(', ')}` : undefined}>{span(f)}</span>
                    <button onClick={() => onUpdateFixture(f.id, { patchLocked: !locked })} title={locked ? 'Locked (manual address)' : 'Auto (click to lock)'} className={`justify-self-center ${locked ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`}>
                      {locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="text-micro text-fg-3 mt-1.5">Universe/Start are auto-assigned per controller; lock a row to edit them manually. Default target: {settings.artNetIp} ({settings.protocol}).</div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
};
