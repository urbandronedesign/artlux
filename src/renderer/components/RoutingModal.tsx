import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Lock, Unlock, Hash, AlertTriangle, RefreshCw } from 'lucide-react';
import { Fixture, Surface, Controller, AppSettings, PatchPolicy, FixtureProfile } from '../types';
import { Button } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { fixtureSpans, findCollisions, fixtureFootprint } from '../services/addressing';

interface Props {
  fixtures: Fixture[];
  surfaces: Surface[];
  controllers: Controller[];
  /** Resolved DMX profiles — a profiled fixture's span is its MODE's, not the pixel product. */
  fixtureProfiles?: ReadonlyMap<string, FixtureProfile>;
  settings: AppSettings;
  patchPolicy: PatchPolicy;
  onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
  onAddController: () => void;
  onUpdateController: (id: string, patch: Partial<Controller>) => void;
  onRemoveController: (id: string) => void;
  onAutoPatch: () => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onUpdatePatchPolicy: (p: Partial<PatchPolicy>) => void;
}

// focus-visible: (not focus:) keeps the global accent ring for KEYBOARD focus while suppressing it for
// mouse clicks in the dense grid; the border-accent is the mouse affordance. Dropping the old blanket
// `focus:outline-none` restored a visible keyboard-focus indicator on every patch cell.
const cell = 'w-full bg-surface-0 border border-line-1 rounded-sm px-1 py-0.5 text-fg-1 text-mini focus:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40';

// Routing spreadsheet: manage controllers + patch every fixture (surface link,
// controller, universe/address, channels) in one grid.
//
// WAS a modal (`RoutingModal`), now a dock panel in the `led` workspace context — patching is done
// beside the fixture list and the DMX monitor, not on top of them. Only the chrome came off; the grid,
// the collision detector and the locked-range policy are unchanged. The name is kept so the file's
// history stays greppable. See docs/WORKSPACE.md.
export const RoutingModal: React.FC<Props> = ({
  fixtures, surfaces, controllers, fixtureProfiles, settings, patchPolicy,
  onUpdateFixture, onAddController, onUpdateController, onRemoveController, onAutoPatch, onUpdateSettings, onUpdatePatchPolicy,
}) => {

  // USB DMX interfaces, for an 'enttec' controller's device picker. Enumerated on mount and on
  // demand — a widget is routinely plugged in AFTER the app is already open, so a one-shot list at
  // startup would leave the picker permanently empty for the most common case.
  const [devices, setDevices] = useState<Array<{ path: string; label: string }>>([]);
  const [scanning, setScanning] = useState(false);
  const rescan = useCallback(async () => {
    setScanning(true);
    try { setDevices((await window.artlux?.listSerialDevices?.()) ?? []); }
    finally { setScanning(false); }
  }, []);
  useEffect(() => { void rescan(); }, [rescan]);

  // Address-overlap detector: flag any two fixtures whose channel ranges intersect on the same
  // resolved destination (protocol|ip|broadcast). MUST sit above the early return (Rules of Hooks).
  const collisions = useMemo(() => {
    const def = { protocol: settings.protocol, ip: settings.artNetIp, broadcast: settings.broadcast };
    const pairs = findCollisions(fixtureSpans(fixtures, controllers, def, fixtureProfiles));
    const nameById = new Map(fixtures.map((f) => [f.id, f.name]));
    const partners = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = partners.get(a);
      if (!set) { set = new Set(); partners.set(a, set); }
      set.add(nameById.get(b) ?? b);
    };
    for (const [a, b] of pairs) { add(a, b); add(b, a); }
    return { count: pairs.length, partners };
  }, [fixtures, controllers, fixtureProfiles, settings]);

  const span = (f: Fixture) => {
    // addressing.ts owns the footprint formula — a profiled fixture's is its mode's, not the pixel
    // product, and this readout must agree with the collision detector shown beside it.
    const ch = fixtureFootprint(f, fixtureProfiles);
    const startAbs = f.universe * 512 + (f.startAddress - 1);
    const endAbs = startAbs + Math.max(0, ch - 1);
    const u0 = Math.floor(startAbs / 512), u1 = Math.floor(endAbs / 512);
    return `${ch}ch · ${u0 === u1 ? `U${u0}` : `U${u0}-${u1}`}`;
  };

  const COLS = 'grid-cols-[1.4fr_1fr_1fr_52px_52px_84px_52px_84px_32px]';

  return (
    <div className="w-full h-full flex flex-col bg-surface-1" aria-label="Routing">
        <div className="h-10 px-3 flex items-center justify-between border-b border-line-1 bg-surface-2 shrink-0 select-none">
          <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">Routing</span>
          <div className="flex items-center gap-2">
            {collisions.count > 0 && (
              <span className="flex items-center gap-1 text-mini font-semibold text-danger" title="Two or more fixtures share DMX channels on the same destination — see the red Span cells below">
                <AlertTriangle size={12} /> {collisions.count} {collisions.count === 1 ? 'conflict' : 'conflicts'}
              </span>
            )}
            <Tooltip id="routing.reserve-locked">
              <label className="flex items-center gap-1 text-mini text-fg-2 cursor-pointer select-none" title="Auto-patch packs auto fixtures AROUND locked ranges instead of through them. Turning this on re-addresses auto fixtures on the next patch — re-upload to hardware after." {...help('routing.reserve-locked')}>
                <input type="checkbox" checked={patchPolicy.reserveLockedRanges} onChange={(e) => onUpdatePatchPolicy({ reserveLockedRanges: e.target.checked })} className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                Reserve locked
              </label>
            </Tooltip>
            <Button variant="primary" size="sm" onClick={onAutoPatch} {...help('routing.auto-patch')}><Hash size={13} /> Auto-patch</Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
          {/* Controllers */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-mini font-semibold text-fg-2 uppercase tracking-wider">Controllers</span>
              <Button variant="tonal" size="sm" onClick={onAddController} {...help('routing.add-controller')}><Plus size={13} /> Controller</Button>
            </div>
            <div className="border border-line-1 rounded-md divide-y divide-line-1">
              <div className="grid grid-cols-[1.2fr_0.8fr_1.2fr_64px_72px_64px_32px] gap-1 px-2 py-1 text-micro uppercase tracking-wider text-fg-3">
                <span>Name</span><span>Protocol</span><span>IP</span><span>Bcast</span><span>Start U</span><span>Prio</span><span></span>
              </div>
              {controllers.length === 0 && <div className="px-2 py-2 text-mini text-fg-3 italic">No controllers — fixtures use the global Preferences target.</div>}
              {controllers.map((c) => (
                <div key={c.id} className="grid grid-cols-[1.2fr_0.8fr_1.2fr_64px_72px_64px_32px] gap-1 px-2 py-1 items-center">
                  <input className={cell} value={c.name} onChange={(e) => onUpdateController(c.id, { name: e.target.value })} />
                  <Tooltip id="routing.controller-protocol">
                    <select className={cell} value={c.protocol} onChange={(e) => onUpdateController(c.id, { protocol: e.target.value as Controller['protocol'] })} {...help('routing.controller-protocol')}>
                      <option value="artnet">Art-Net</option><option value="sacn">sACN</option>
                      <option value="enttec">USB DMX</option>
                    </select>
                  </Tooltip>
                  {c.protocol === 'enttec' ? (
                    // A USB widget has no address — it has a PORT, and the operator must never have
                    // to type "COM3". The list comes from the OS's own USB descriptors, so the row
                    // shows the device's real name.
                    <Tooltip id="routing.controller-device">
                      <div className="flex items-center gap-1 min-w-0" {...help('routing.controller-device')}>
                        <select
                          className={`${cell} min-w-0`}
                          value={c.port ?? ''}
                          onChange={(e) => onUpdateController(c.id, { port: e.target.value || undefined })}
                        >
                          <option value="">— pick a device —</option>
                          {/* A port saved in the project but not currently attached must stay
                              selectable, or opening a show on another machine silently clears it. */}
                          {c.port && !devices.some((d) => d.path === c.port) && (
                            <option value={c.port}>{c.port} (not connected)</option>
                          )}
                          {devices.map((d) => <option key={d.path} value={d.path}>{d.label} — {d.path}</option>)}
                        </select>
                        <button
                          onClick={rescan}
                          title="Rescan for USB DMX interfaces"
                          className="shrink-0 text-fg-3 hover:text-fg-1"
                        >
                          <RefreshCw size={12} className={scanning ? 'animate-spin' : undefined} />
                        </button>
                      </div>
                    </Tooltip>
                  ) : (
                    <Tooltip id="routing.controller-ip">
                      <input className={`${cell} num`} value={c.ip} onChange={(e) => onUpdateController(c.id, { ip: e.target.value })} {...help('routing.controller-ip')} />
                    </Tooltip>
                  )}
                  {c.protocol === 'enttec' ? <span className="justify-self-center text-fg-3 text-micro">—</span> : (
                  <Tooltip id="routing.controller-broadcast">
                    <input type="checkbox" checked={c.broadcast} onChange={(e) => onUpdateController(c.id, { broadcast: e.target.checked })} className="justify-self-center bg-surface-0 border-line-2 rounded text-accent focus:ring-0" {...help('routing.controller-broadcast')} />
                  </Tooltip>)}
                  <Tooltip id="routing.controller-start-universe">
                    <input type="number" className={`${cell} num text-right`} value={c.startUniverse ?? 0} onChange={(e) => onUpdateController(c.id, { startUniverse: Math.max(0, Math.round(+e.target.value)) })} {...help('routing.controller-start-universe')} />
                  </Tooltip>
                  <Tooltip id="routing.controller-priority">
                    <input type="number" className={`${cell} num text-right`} value={c.priority ?? 100} onChange={(e) => onUpdateController(c.id, { priority: Math.max(0, Math.min(200, Math.round(+e.target.value))) })} {...help('routing.controller-priority')} />
                  </Tooltip>
                  <Tooltip id="routing.remove-controller">
                    <button onClick={() => onRemoveController(c.id)} title="Remove controller" className="justify-self-center text-fg-3 hover:text-danger" {...help('routing.remove-controller')}><Trash2 size={12} /></button>
                  </Tooltip>
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
                    <Tooltip id="routing.fixture-surface">
                      <select className={cell} value={f.surfaceId ?? ''} onChange={(e) => onUpdateFixture(f.id, { surfaceId: e.target.value || undefined })} {...help('routing.fixture-surface')}>
                        <option value="">— off —</option>
                        {surfaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </Tooltip>
                    <Tooltip id="routing.fixture-controller">
                      <select className={cell} value={f.controllerId ?? ''} onChange={(e) => onUpdateFixture(f.id, { controllerId: e.target.value || undefined })} {...help('routing.fixture-controller')}>
                        <option value="">Global</option>
                        {controllers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </Tooltip>
                    <Tooltip id="routing.fixture-universe">
                      <input type="number" disabled={!locked} className={`${cell} num text-right`} value={f.universe} onChange={(e) => onUpdateFixture(f.id, { universe: Math.max(0, Math.round(+e.target.value)) })} {...help('routing.fixture-universe')} />
                    </Tooltip>
                    <Tooltip id="routing.fixture-start-address">
                      <input type="number" disabled={!locked} className={`${cell} num text-right`} value={f.startAddress} onChange={(e) => onUpdateFixture(f.id, { startAddress: Math.max(1, Math.min(512, Math.round(+e.target.value))) })} {...help('routing.fixture-start-address')} />
                    </Tooltip>
                    <Tooltip id="routing.fixture-channels">
                      <select className={cell} value={f.channelsPerPixel ?? 4} onChange={(e) => onUpdateFixture(f.id, { channelsPerPixel: (parseInt(e.target.value) as 3 | 4) })} {...help('routing.fixture-channels')}>
                        <option value={3}>RGB (3)</option><option value={4}>RGBW (4)</option>
                      </select>
                    </Tooltip>
                    <Tooltip id="routing.fixture-leds">
                      <input type="number" className={`${cell} num text-right`} value={f.ledCount} onChange={(e) => onUpdateFixture(f.id, { ledCount: Math.max(1, Math.round(+e.target.value)) })} {...help('routing.fixture-leds')} />
                    </Tooltip>
                    <span className={`num text-micro truncate ${clash ? 'text-danger font-semibold' : 'text-fg-3'}`} title={clash ? `Overlaps ${[...clash].join(', ')}` : undefined}>{span(f)}</span>
                    {/* PAST WHAT THE DEVICE CAN SEND. A USB widget drives one universe, so a fixture
                        auto-patched beyond it has nowhere to go — badge it, because the alternative
                        is a fixture that simply never lights and gives no reason why. */}
                    {f.patchOverflow && (
                      <span className="text-warn shrink-0" title="Past this interface's last universe — a USB DMX widget sends only one. Move it to another controller.">
                        <AlertTriangle size={11} />
                      </span>
                    )}
                    <Tooltip id="routing.patch-lock">
                      <button onClick={() => onUpdateFixture(f.id, { patchLocked: !locked })} title={locked ? 'Locked (manual address)' : 'Auto (click to lock)'} className={`justify-self-center ${locked ? 'text-accent' : 'text-fg-3 hover:text-fg-1'}`} {...help('routing.patch-lock')}>
                        {locked ? <Lock size={12} /> : <Unlock size={12} />}
                      </button>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
            <div className="text-micro text-fg-3 mt-1.5">Universe/Start are auto-assigned per controller; lock a row to edit them manually. Default target: {settings.artNetIp} ({settings.protocol}).</div>
          </div>
        </div>
    </div>
  );
};
