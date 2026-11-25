import React, { useEffect, useRef, useState } from 'react';
import { Cpu, Radar, Check, Radio, Monitor, ShieldAlert, LayoutGrid, Lock, Box, Search } from 'lucide-react';
import { AppSettings } from '../types';
import type { ArtNetDevice, UnattendedPrefs, WatchdogStatus } from '../../../shared/protocol';
import { Field, NumberField, Toggle, Select, Slider, Button, useConfirm } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { settingsSectionRegistry } from '../host/registries';
import { isPanelWindow } from '../services/windowRole';
import { liveClient } from '../live/client';
import { ErrorBoundary } from './ErrorBoundary';
import { layoutStore } from '../services/layoutStore';
import {
  useRenderScale, setRenderScale, RENDER_SCALE_MIN, RENDER_SCALE_MAX,
  useMaxFps, setMaxFps, MAX_FPS_CHOICES,
  useLivePreview, setLivePreview,
} from '../services/scene3dQuality';
import { useLayout } from '../hooks/useLayout';
import { useWorkspaceActions } from '../hooks/useWorkspaceActions';
import { useRovingTabindex } from '../hooks/useRovingTabindex';
import { OscSendersBlock } from './OscSendersBlock';

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

// Label column for this screen's rows. The shared default (`w-16`) is sized for the 260px inspector
// column and truncates "Min relaunch gap (s)" to "Min relau…" — harmless when a tooltip is a hover away
// in a dense inspector, wrong on the screen whose whole job is being read.
const LBL = 'w-36';

// ── TWO COLUMNS: TOPICS ON THE LEFT, ONE TOPIC'S PARAMETERS ON THE RIGHT (owner, 2026-11-23) ───────
// Preferences used to be a MOSAIC of cards packed by CSS multi-column. A wide screen showed everything
// at once, but each card landed somewhere different at every width, and finding "the OSC bind address"
// meant scanning a wall. Now a topic is picked from a fixed list and only its parameters show, which is
// how an operator actually uses this screen: one question at a time.
type GroupId = 'interface' | 'output' | 'media' | 'control' | 'system' | 'plugins';
const GROUPS: { id: GroupId; label: string }[] = [
  { id: 'interface', label: 'Interface' },
  { id: 'output', label: 'Output' },
  { id: 'media', label: 'Media' },
  { id: 'control', label: 'Control & tracking' },
  { id: 'system', label: 'System' },
  { id: 'plugins', label: 'Plugins' },
];
// Where each FIRST-PARTY plugin's section is filed. A plugin not listed here (a new one, or one this
// table has not caught up with) still shows — under "Plugins" — rather than being dropped.
const PLUGIN_GROUP: Record<string, GroupId> = {
  video: 'media', audio: 'media', shader: 'media',
  augmenta: 'control', mediapipe: 'control', 'show-control': 'control',
  recalibration: 'output',
};
interface Topic { id: string; title: string; group: GroupId; icon: React.ReactNode; body: React.ReactNode }

// The topic last looked at, per machine — a convenience, so it lives in localStorage and every access
// is guarded (a private window or a blocked origin simply starts on the first topic).
const TOPIC_KEY = 'artlux.prefs.topic';
const loadTopic = (): string | null => { try { return localStorage.getItem(TOPIC_KEY); } catch { return null; } };
const saveTopic = (id: string): void => { try { localStorage.setItem(TOPIC_KEY, id); } catch { /* ignore */ } };

// Below this width the two columns do not fit (a Preferences panel window can be 280px — the narrow-
// window check holds every detachable panel to it), so the topic list folds into a picker above the
// parameters instead of squeezing both columns into slivers.
const NARROW_PX = 560;
// The marker a search puts on the parameter it found. Written as literals so Tailwind generates them.
const HIT_CLASSES = ['ring-1', 'ring-accent', 'rounded-sm'];

/**
 * Lowercased words of a query. A topic matches when EVERY word appears in its title, its group, or the
 * text of its parameters (labels, notes) — "osc port" finds OSC / Tracking's Listen port. Not a ranker:
 * topics keep their fixed order, the search only hides the ones that cannot be what you mean.
 */
const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);

const TopicLayout: React.FC<{ topics: Topic[]; footer?: React.ReactNode }> = ({ topics, footer }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRefs = useRef(new Map<string, HTMLDivElement>());
  const [width, setWidth] = useState(1000);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>(() => loadTopic() ?? topics[0]?.id ?? '');

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // EVERY topic stays mounted and only the selected one is visible — the same mount set as the old
  // mosaic, so nothing a section holds (a device scan, the watchdog's status, a plugin's own state) is
  // lost by looking at another topic, and the search can read every topic's text.
  const q = words(query);
  const groupLabel = (g: GroupId) => GROUPS.find((x) => x.id === g)?.label ?? '';
  const matches = (t: Topic): boolean => {
    if (!q.length) return true;
    const hay = `${t.title} ${groupLabel(t.group)} ${bodyRefs.current.get(t.id)?.textContent ?? ''}`.toLowerCase();
    return q.every((w) => hay.includes(w));
  };
  const visible = topics.filter(matches);
  // A selection the list no longer shows (a plugin that went away, a search that hides it) falls to the
  // first topic that IS shown, so the right column never describes a topic you cannot see on the left.
  const current = visible.find((t) => t.id === selected) ?? visible[0] ?? null;

  const pick = (id: string) => { setSelected(id); saveTopic(id); };

  // Searching JUMPS TO THE PARAMETER: the first text in the shown topic containing the first word is
  // scrolled into view and ringed for a moment.
  const firstWord = q[0] ?? '';
  const currentId = current?.id ?? '';
  useEffect(() => {
    if (!firstWord || !currentId) return;
    const host = bodyRefs.current.get(currentId);
    if (!host) return;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let hit: HTMLElement | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n.textContent ?? '').toLowerCase().includes(firstWord)) { hit = n.parentElement; break; }
    }
    if (!hit) return;
    const el = hit;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add(...HIT_CLASSES);
    const t = setTimeout(() => el.classList.remove(...HIT_CLASSES), 1200);
    return () => { clearTimeout(t); el.classList.remove(...HIT_CLASSES); };
  }, [firstWord, currentId]);

  const roving = useRovingTabindex<HTMLDivElement>(visible.length);
  const narrow = width < NARROW_PX;

  const search = (
    <div className="relative">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-3 pointer-events-none" aria-hidden />
      <input
        type="search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search settings…" aria-label="Search settings"
        className="w-full bg-surface-0 border border-line-1 rounded-sm pl-7 pr-2 py-1 text-mini text-fg-1 focus:border-accent focus:outline-none"
      />
    </div>
  );

  const list = (
    <div ref={roving.containerRef} onKeyDown={roving.onKeyDown} className="space-y-3">
      {GROUPS.map((g) => {
        const rows = visible.filter((t) => t.group === g.id);
        if (!rows.length) return null;
        return (
          <div key={g.id}>
            <div className="px-2 pb-1 text-micro font-semibold uppercase tracking-wider text-fg-3">{g.label}</div>
            {rows.map((t) => {
              const sel = t.id === current?.id;
              return (
                <div
                  key={t.id}
                  role="button"
                  aria-pressed={sel}
                  aria-current={sel ? 'page' : undefined}
                  {...roving.getItemProps(visible.indexOf(t))}
                  onClick={() => pick(t.id)}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(t.id); } }}
                  className={`pressable relative flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-sm cursor-pointer text-xs transition-colors ${
                    sel ? 'bg-accent/10 text-fg-1 font-semibold' : 'text-fg-2 hover:bg-surface-2'}`}
                >
                  {/* The selection's SHAPE cue (a bar), not just its tint — DESIGN-SYSTEM §6. */}
                  {sel && <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 rounded-full bg-accent" />}
                  <span className={sel ? 'text-accent' : 'text-fg-3'}>{t.icon}</span>
                  <span className="flex-1 truncate">{t.title}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {!visible.length && <div className="px-2 text-mini text-fg-2 italic">No setting matches “{query}”.</div>}
    </div>
  );

  const bodies = (
    <>
      {topics.map((t) => (
        <div key={t.id} hidden={t.id !== current?.id}
             ref={(el) => { if (el) bodyRefs.current.set(t.id, el); else bodyRefs.current.delete(t.id); }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg-1 mb-2">
            <span className="text-fg-3">{t.icon}</span>{t.title}
          </h2>
          <div className="rounded-md border border-line-1 bg-surface-1 p-3 space-y-3">{t.body}</div>
        </div>
      ))}
    </>
  );

  return (
    <div ref={rootRef} className="w-full h-full bg-surface-0 flex min-h-0" aria-label="Preferences">
      {narrow ? (
        <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
          {search}
          <Select value={current?.id ?? ''} onChange={(e) => pick(e.target.value)} aria-label="Preferences topic">
            {GROUPS.map((g) => {
              const rows = visible.filter((t) => t.group === g.id);
              return rows.length ? (
                <optgroup key={g.id} label={g.label}>
                  {rows.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                </optgroup>
              ) : null;
            })}
          </Select>
          {bodies}
          {footer}
        </div>
      ) : (
        <>
          <nav className="w-[220px] shrink-0 border-r border-line-1 overflow-y-auto p-2 space-y-3" aria-label="Preferences topics">
            {search}
            {list}
            {footer}
          </nav>
          {/* Capped width: a row's label and its control stay within one glance on a 4K panel. */}
          <div className="flex-1 min-w-0 overflow-y-auto p-4">
            <div className="max-w-[720px]">{bodies}</div>
          </div>
        </>
      )}
    </div>
  );
};

/**
 * The named-workspace manager (plans/named-workspaces.md). The chip in the title bar is the switcher;
 * this is where a workspace is renamed, locked, reset, deleted, and — the reason the feature exists —
 * carried to another machine.
 *
 * The `authored at` line is deliberate: a workspace built on a 4K desk has its columns CLAMPED, not
 * rescaled, when it opens on a laptop (see clampToViewport), and the only thing that makes that
 * legible rather than mysterious is saying where it came from.
 */
/**
 * A setting of THE EDITOR'S OWN WINDOW, drawn in a panel window (E5/W5k). Shown — so the operator finds
 * it where they look — but disabled, saying where it is changed: a panel window cannot change the
 * editor's workbench, named workspaces or 3D view, and a control that looked like it did would be worse
 * than none. In the editor this is a plain wrapper.
 */
const EditorOnly: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (!isPanelWindow()) return <>{children}</>;
  return (
    <div data-editor-only className="space-y-1">
      <div className="opacity-45 pointer-events-none select-none" aria-disabled>{children}</div>
      <div className="text-micro text-fg-3 italic">This changes the editor window — set it in the editor's Preferences.</div>
    </div>
  );
};

/**
 * In a panel window: the editor's Preferences sections this window does not have. A plugin whose section
 * is still registered by its RUNTIME (Calibration's Recalibration, part of the authoring code) has it in
 * the editor only; saying so beats a Preferences that silently lacks it.
 */
const ElsewhereSections: React.FC = () => {
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    if (!isPanelWindow()) return;
    return liveClient.subscribe('prefs.sections', null, (v) => {
      const here = new Set(settingsSectionRegistry.all().map((s) => s.id));
      setMissing(((v as { id: string; title: string }[]) ?? []).filter((s) => !here.has(s.id)).map((s) => s.title));
    });
  }, []);
  if (!missing.length) return null;
  return (
    <div data-prefs-elsewhere className="text-micro text-fg-3 italic px-1 py-2">
      Also in the editor's Preferences: {missing.join(', ')}.
    </div>
  );
};

const WorkspacesSection: React.FC = () => {
  const ws = useWorkspaceActions();
  return (
    <div className="space-y-2">
      <p className="text-mini text-fg-3">
        A workspace saves the arrangement of every workbench — panels, columns, tabs, and which one opens
        first. UI scale, 3D quality and the calibration file stay with this machine and never travel.
      </p>
      {ws.list.length > 0 ? (
        <div className="border border-line-1 rounded-sm divide-y divide-line-1">
          {ws.list.map((w) => {
            const isActive = w.id === ws.active?.id;
            return (
              <div key={w.id} className={`px-2 py-1.5 ${isActive ? 'bg-accent/10' : ''}`}>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => ws.switchTo(w.id)} title={isActive ? 'This is the live workspace' : 'Switch to this workspace'}
                          className="flex-1 min-w-0 text-left text-xs text-fg-1 truncate flex items-center gap-1.5">
                    <Check size={12} className={isActive ? 'text-accent shrink-0' : 'opacity-0 shrink-0'} aria-hidden />
                    <span className="truncate">{w.name}</span>
                    {w.locked && <Lock size={10} className="text-fg-3 shrink-0" aria-label="Locked" />}
                  </button>
                  <Button variant="tonal" size="sm" onClick={() => { void ws.rename(w.id); }}>Rename</Button>
                  <Button variant="tonal" size="sm" onClick={() => ws.duplicate(w.id)}>Duplicate</Button>
                  <Button variant="tonal" size="sm" onClick={() => ws.toggleLock(w.id)}
                          title={w.locked ? 'Save changes into it again' : 'Stop saving changes into it — the arrangement is frozen'}>
                    {w.locked ? 'Unlock' : 'Lock'}
                  </Button>
                  <Button variant="tonal" size="sm" onClick={() => { void ws.exportAll([w.id]); }}>Export</Button>
                  <Button variant="tonal" size="sm" onClick={() => { void ws.reset(w.id); }}
                          title="Every workbench in it goes back to its shipped arrangement">Reset</Button>
                  <Button variant="tonal" size="sm" onClick={() => { void ws.remove(w.id); }}>Delete</Button>
                </div>
                {w.authored && (
                  <div className="text-micro text-fg-3 pl-[18px]">
                    authored at {w.authored.w}×{w.authored.h} · updated {new Date(w.updatedAt).toLocaleDateString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-mini text-fg-3">No saved workspaces. The layout is still remembered per machine.</p>
      )}
      <div className="flex items-center gap-1.5">
        <Button variant="tonal" size="sm" onClick={() => { void ws.saveAs(); }}>Save current layout…</Button>
        <Button variant="tonal" size="sm" onClick={() => { void ws.importFile(); }}>Import…</Button>
        <Button variant="tonal" size="sm" disabled={!ws.list.length} onClick={() => { void ws.exportAll(); }}>Export all…</Button>
      </div>
    </div>
  );
};

const WATCHDOG_UI_DEFAULTS: UnattendedPrefs = {
  enabled: false, crashRecovery: true, outputDownSec: 15, renderStallSec: 10,
  minRelaunchGapSec: 30, maxRelaunchesPerHour: 6, always: false,
};

// Unattended self-healing config. Lives on Prefs.unattended (not AppSettings), so this section reads
// and writes it directly through getPrefs/setPrefs and shows live status from the main-side watchdog.
// Changes take effect on the next launch/relaunch (the watchdog arms + attaches its detectors at
// process start), so we make that explicit in the UI.
const WatchdogSection: React.FC = () => {
  const [cfg, setCfg] = useState<UnattendedPrefs>(WATCHDOG_UI_DEFAULTS);
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const refreshStatus = () => { window.artlux?.getWatchdogStatus?.().then(setStatus).catch(() => {}); };
  useEffect(() => {
    window.artlux?.getPrefs?.().then((p) => {
      if (p?.unattended) setCfg({ ...WATCHDOG_UI_DEFAULTS, ...p.unattended });
    }).catch(() => {});
    refreshStatus();
  }, []);

  // Persist a patch to Prefs.unattended. Applies on the next launch/relaunch.
  const update = (patch: Partial<UnattendedPrefs>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    window.artlux?.setPrefs?.({ unattended: next });
  };

  const runTask = async (fn?: () => Promise<{ ok: boolean; message: string }>) => {
    if (!fn) return;
    setBusy(true); setMsg('');
    try { const r = await fn(); setMsg(r?.message ?? ''); }
    catch (e) { setMsg(String((e as Error)?.message ?? e)); }
    finally { setBusy(false); setTimeout(refreshStatus, 1500); }
  };

  return (
    <>
      <Toggle label="Self-heal (watchdog)" checked={cfg.enabled} onChange={(v) => update({ enabled: v })}
              title="Auto-relaunch the show if the renderer/GPU crashes, the window hangs, the render loop freezes, or Art-Net output dies. Armed in broadcast mode." />
      <Toggle label="Crash + hang recovery" checked={cfg.crashRecovery} onChange={(v) => update({ crashRecovery: v })}
              title="Tier-1: relaunch on render-process-gone / GPU crash / unresponsive window / frozen render loop" />
      <Toggle label="Arm outside broadcast" checked={!!cfg.always} onChange={(v) => update({ always: v })}
              title="By default the watchdog only arms in --broadcast (so it never surprises you in the editor). Enable to arm everywhere." />
      <NumberField label="Output-down (s)" labelWidth={LBL} value={cfg.outputDownSec} step={1} min={2} max={600}
                   onChange={(v) => update({ outputDownSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Render-stall (s)" labelWidth={LBL} value={cfg.renderStallSec} step={1} min={2} max={600}
                   onChange={(v) => update({ renderStallSec: Math.max(2, Math.round(v)) })} />
      <NumberField label="Min relaunch gap (s)" labelWidth={LBL} value={cfg.minRelaunchGapSec} step={1} min={0} max={600}
                   onChange={(v) => update({ minRelaunchGapSec: Math.max(0, Math.round(v)) })} />
      <NumberField label="Max relaunches / hour" labelWidth={LBL} value={cfg.maxRelaunchesPerHour} step={1} min={1} max={60}
                   onChange={(v) => update({ maxRelaunchesPerHour: Math.max(1, Math.round(v)) })} />

      {/* Live status from the main-side watchdog */}
      <div className="flex flex-wrap gap-1.5 pt-1 text-micro">
        <span className={`px-1.5 py-0.5 rounded-sm border num ${status?.enabled ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-3'}`}>
          {status?.enabled ? 'armed' : 'idle'}
        </span>
        {status?.tripped && <span className="px-1.5 py-0.5 rounded-sm border num bg-danger/15 border-danger text-danger">breaker tripped</span>}
        <span className="px-1.5 py-0.5 rounded-sm border num bg-surface-2 border-line-1 text-fg-3">{status?.relaunchesLastHour ?? 0} relaunch/h</span>
        <span className="px-1.5 py-0.5 rounded-sm border num bg-surface-2 border-line-1 text-fg-3">task {status?.taskInstalled ? 'installed' : 'off'}</span>
      </div>

      {/* Tier-2 OS supervisor (Windows Scheduled Task) — needs elevation */}
      <div className="flex gap-1.5 pt-1">
        <Button variant="tonal" size="sm" disabled={busy} className="flex-1"
                onClick={() => runTask(window.artlux?.installWatchdogTask)}>Install OS task</Button>
        <Button variant="tonal" size="sm" disabled={busy} className="flex-1"
                onClick={() => runTask(window.artlux?.uninstallWatchdogTask)}>Remove OS task</Button>
      </div>
      {msg && <div className="text-micro text-fg-3 italic px-0.5">{msg}</div>}
      <div className="text-micro text-fg-3 px-0.5">Applies on next launch/relaunch. The OS task relaunches the app after a full crash or reboot (Windows only).</div>

      {/* Recent self-heal events (tail of the persistent log; survives relaunches) */}
      {status && status.recent.length > 0 && (
        <div className="border border-line-1 rounded-sm divide-y divide-line-1 max-h-32 overflow-auto mt-1">
          {status.recent.slice(0, 12).map((e, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2 py-1 text-micro">
              <span className="min-w-0">
                <span className="block text-fg-1 truncate">{e.trigger} · <span className="text-fg-3">{e.action}</span></span>
                <span className="block num text-micro text-fg-3 truncate">{e.detail}</span>
              </span>
              <span className="num text-micro text-fg-3 shrink-0">{new Date(e.ts).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

// GPU rendering diagnostics. WebGPU (compute) is primary; the WebGL fallback does NOT do strict
// per-surface sampling. This section reports which backend is live (recorded to localStorage by Stage),
// probes WebGPU on demand, and lets a tester force the WebGL fallback on this machine to compare — a
// per-machine localStorage flag (`artlux.forceWebGL`), deliberately not a project/prefs field.
// Which Blender imports and updates native .blend venue files (main/blendImport.ts). Empty = auto-detect
// (ARTLUX_BLENDER, then the newest version in the standard install location). Shown with what it
// resolves to RIGHT NOW, so "Blender was not found" is answerable here rather than in a log.
const BlenderSection: React.FC = () => {
  const [path, setPath] = useState('');
  const [resolved, setResolved] = useState<string | null | undefined>(undefined);
  const refresh = () => { void window.artlux?.findBlender?.().then((p) => setResolved(p ?? null)); };
  useEffect(() => {
    void window.artlux?.getPrefs?.().then((p) => setPath((p as { blenderPath?: string } | undefined)?.blenderPath ?? ''));
    refresh();
  }, []);
  const commit = (v: string) => {
    const next = v.trim();
    void window.artlux?.setPrefs?.({ blenderPath: next || undefined }).then(refresh);
  };
  return (
    <>
      <p className="text-mini text-fg-3 leading-relaxed">Native <b>.blend</b> venue files are imported by the Blender installed on this machine, and updated when you save them. A machine that only plays the show does not need it.</p>
      <Field label="Blender path">
        <input
          type="text" value={path} placeholder="auto-detect"
          onChange={(e) => setPath(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
          className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-fg-1 text-mini focus:border-accent focus:outline-none"
          {...help('general.blender-path')}
        />
      </Field>
      <div className="text-mini">
        {resolved === undefined ? <span className="text-fg-3">Looking for Blender…</span>
          : resolved ? <span className="text-fg-2 flex items-center gap-1"><Check size={11} className="text-ok shrink-0" /><span className="truncate" title={resolved}>{resolved}</span></span>
          : <span className="text-warn">Blender not found — .blend files cannot be imported or updated here.</span>}
      </div>
    </>
  );
};

// E6e — THE NATIVE OUTPUT ENGINE SWITCH (main/engineHost.ts decide()). On by default on Windows; this is the
// per-machine way OFF that needs no command line (a venue tech's way back to the app's own output). Read at
// LAUNCH only — never mid-show — so the row says what runs now and what the next start will do. Not offered off
// Windows: there the engine is off unless a developer starts it with --native-engine (E6g).
// E6i step 3: NO SWITCH ANY MORE (it was E6e's `Prefs.nativeEngineOff`). On Windows the native engine IS the output;
// the app draws only as an emergency (the engine missing, refused or given up — the machine log says which). What is
// left here is the line that says what runs. `--no-native-engine` remains, for a test or a tech.
const NativeEngineSwitch: React.FC = () => {
  const windows = /Windows/i.test(navigator.userAgent);
  const [running, setRunning] = useState<boolean | null>(null);
  useEffect(() => {
    void window.artlux?.nativeEngineEnabled?.().then((v) => setRunning(!!v)).catch(() => setRunning(false));
  }, []);
  if (!windows || running === null) return null;
  return (
    <span className="text-mini text-fg-3">
      {running
        ? 'Native output engine: on. It draws every output; if it cannot run, ArtLux draws the output itself and the log says why.'
        : 'Native output engine: off for this run (started with --no-native-engine).'}
    </span>
  );
};

const GpuSection: React.FC = () => {
  const [forced, setForced] = useState(false);
  const [active, setActive] = useState('');
  const [probe, setProbe] = useState('');
  const [probing, setProbing] = useState(false);
  const [scene3dGpu, setScene3dGpu] = useState(false);
  const renderScale = useRenderScale();
  const maxFps = useMaxFps();
  const livePreview = useLivePreview();

  useEffect(() => {
    try { setForced(localStorage.getItem('artlux.forceWebGL') === '1'); } catch { /* ignore */ }
    try { setActive(localStorage.getItem('artlux.activeBackend') || ''); } catch { /* ignore */ }
    // Absence means ON — the key is named for the opt-out. See renderer3d.ts for why.
    try { setScene3dGpu(localStorage.getItem('artlux.scene3dWebGL') !== '1'); } catch { /* ignore */ }
  }, []);

  const toggleForce = (v: boolean) => {
    setForced(v);
    try { if (v) localStorage.setItem('artlux.forceWebGL', '1'); else localStorage.removeItem('artlux.forceWebGL'); } catch { /* ignore */ }
  };

  // Same door and the same storage as the flag itself (renderer3d.ts reads it SYNCHRONOUSLY at module
  // load, before prefs IPC could have answered, which is why this one knob is localStorage and not a
  // Prefs field like its two neighbours). Reload to apply: the renderer is constructed once, at mount.
  //
  // The stored key is the OPT-OUT (`scene3dWebGL`), so absence = WebGPU. Ticking the box therefore
  // REMOVES a key rather than writing one. Note this is per-origin, so a value set in a dev run does
  // not carry to a packaged install — which is exactly why the default had to flip rather than stay
  // an opt-in nobody outside a dev build could reach.
  const toggleScene3dGpu = (v: boolean) => {
    setScene3dGpu(v);
    try { if (v) localStorage.removeItem('artlux.scene3dWebGL'); else localStorage.setItem('artlux.scene3dWebGL', '1'); } catch { /* ignore */ }
  };

  const testWebGPU = async () => {
    setProbing(true); setProbe('');
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
      if (!gpu) { setProbe('navigator.gpu unavailable — this machine can only run the WebGL fallback.'); return; }
      const adapter = await gpu.requestAdapter() as { info?: { vendor?: string; architecture?: string; description?: string } } | null;
      if (!adapter) { setProbe('requestAdapter() returned null — no usable WebGPU adapter (fallback path).'); return; }
      const info = adapter.info;
      const name = info ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ').trim() : '';
      setProbe(`WebGPU OK${name ? ' — ' + name : ' — adapter available'}.`);
    } catch (e) {
      setProbe('WebGPU probe threw: ' + String((e as Error)?.message ?? e));
    } finally { setProbing(false); }
  };

  return (
    <>
      <div className="flex items-center justify-between text-mini">
        <span className="text-fg-3">Active backend</span>
        <span className={`px-1.5 py-0.5 rounded-sm border num ${active === 'webgpu' ? 'bg-accent/15 border-accent text-accent' : active === 'webgl' ? 'bg-warn/15 border-warn text-warn' : 'bg-surface-2 border-line-1 text-fg-3'}`}>
          {active === 'webgpu' ? 'WebGPU (compute)' : active === 'webgl' ? 'WebGL (fallback)' : 'unknown'}
        </span>
      </div>
      <Button variant="tonal" size="sm" className="w-full" disabled={probing} onClick={testWebGPU}>
        {probing ? 'Testing…' : 'Test WebGPU support'}
      </Button>
      {probe && <div className="text-micro text-fg-3 px-0.5 break-words">{probe}</div>}
      <Toggle label="Force WebGL fallback" checked={forced} onChange={toggleForce}
              title="Force the WebGL fallback to test reduced-mode rendering on a machine that has WebGPU. Per-machine only (localStorage) — never travels with the project. Reload to apply." />
      <div className="text-micro text-fg-3 px-0.5">Force-WebGL applies on the next reload (Ctrl+R). The Stage shows a banner while the fallback is active.</div>
      {/* The 3D view's quality is held in the EDITOR's memory (services/scene3dQuality, applied live). */}
      <EditorOnly>
      <Slider label="3D render scale" value={renderScale} min={RENDER_SCALE_MIN} max={RENDER_SCALE_MAX} step={0.05}
              format={(v) => `${v.toFixed(2)}×`} onChange={setRenderScale} />
      <div className="text-micro text-fg-3 px-0.5">
        Resolution the 3D Scene renders at, applied live. Cost scales with the SQUARE — 0.5× is a quarter
        of the pixels. Lower it first when the 3D view is slow. Per-machine, so it never travels with a project.
      </div>
      <Field label="3D frame rate" labelWidth={LBL}>
        <Select value={String(maxFps)} onChange={(e) => setMaxFps(Number(e.target.value))}>
          {MAX_FPS_CHOICES.map((f) => (
            <option key={f} value={f}>{f === 0 ? 'Display rate (uncapped)' : `${f} fps`}</option>
          ))}
        </Select>
      </Field>
      <div className="text-micro text-fg-3 px-0.5">
        Ceiling on how often the 3D Scene redraws, applied live. It does <strong>not</strong> touch the
        show: mapping, LED sampling and Art-Net keep running at the engine FPS, so capping the preview
        gives the output GPU time back rather than costing it any. Reach for this when the 3D view is
        slow and the render scale did not help — that means whole frames are expensive, not pixels.
      </div>
      <Toggle label="Live gizmo preview" checked={livePreview} onChange={setLivePreview}
              title="Fixtures follow the 3D transform gizmo while you drag it, instead of jumping to the new pose when you release. Per-machine; the project is still written once, on release." />
      <div className="text-micro text-fg-3 px-0.5">
        <strong>On by default.</strong> Turn it off on a weak machine or a very large rig: previewing
        recomputes the dragged fixtures' LED positions every frame. A big selection already drops to
        moving the fixture <em>bodies</em> only, and the show file is written once on release either way.
      </div>
      </EditorOnly>
      <Toggle label="3D Scene on WebGPU" checked={scene3dGpu} onChange={toggleScene3dGpu}
              title="Render the 3D Scene viewport with WebGPU instead of WebGL. ON by default — turning it off is a diagnostic. Per-machine (localStorage), reload to apply, and it falls back to WebGL by itself if WebGPU is unavailable." />
      <div className="text-micro text-fg-3 px-0.5">
        <strong>On by default</strong>; applies on the next reload (Ctrl+R). Turn it off only to compare —
        on the WebGL path a scene holding just two venue screens measured here at <strong>32 fps with the
        GPU process 99.8% saturated</strong>, against 60 fps on WebGPU. If this machine has no usable
        WebGPU adapter the viewport falls back on its own, so the worst case is the old behaviour.
      </div>
    </>
  );
};

// Preferences — the `settings` context's viewport (it was a draggable modal until it grew past
// output+engine into appearance, watchdog, GPU and every plugin's own SettingsSection).
export const Preferences: React.FC<Props> = ({ settings, onChange }) => {
  const layout = useLayout();
  const confirm = useConfirm();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [devices, setDevices] = useState<ArtNetDevice[]>([]);
  const [localAddrs, setLocalAddrs] = useState<string[]>([]);
  const [uiScaleValue, setUiScaleValue] = useState(1); // main-window zoom factor; applied in main
  const [showSplash, setShowSplash] = useState(true);  // Prefs.showSplash; absent = on (main's default)

  useEffect(() => {
    window.artlux?.listLocalAddrs?.().then((a) => setLocalAddrs(a ?? [])).catch(() => setLocalAddrs([]));
    // Show the scale in effect: the saved value, else the auto-detected default for this display.
    (async () => {
      const p = await window.artlux?.getPrefs?.();
      const s = typeof p?.uiScale === 'number' ? p.uiScale : await window.artlux?.detectUiScale?.();
      if (typeof s === 'number') setUiScaleValue(s);
      setShowSplash(p?.showSplash !== false); // main reads it the same way — only an explicit false is off
    })();
  }, []);

  // Apply immediately (main persists + zooms) and reflect in the slider readout.
  const applyScale = (v: number) => { setUiScaleValue(v); window.artlux?.setUiScale?.(v); };

  const scan = async () => {
    setScanning(true);
    try {
      setDevices((await window.artlux?.discoverDevices?.()) ?? []);
    } finally {
      setScanning(false);
      setScanned(true);
    }
  };


  // ── THE TOPICS ─────────────────────────────────────────────────────────────────────────────────
  // One entry per Preferences topic: the left column lists them (grouped), the right column shows the
  // selected one's parameters. Core topics are written out here; every plugin's SettingsSection joins
  // them through the registry, filed under the group its id maps to (PLUGIN_GROUP), else "Plugins".
  // The TITLES are load-bearing: the guide sends operators to "Preferences ▸ OSC / Tracking" and
  // verify:docs checks that string still exists — rename a topic and update the guide with it.
  const topics: Topic[] = [
    { id: 'appearance', title: 'Appearance', group: 'interface', icon: <Monitor size={14} />, body: (
        <>
          <Slider label="UI scale" value={uiScaleValue} min={0.8} max={2} step={0.05}
                  format={(v) => `${Math.round(v * 100)}%`} onChange={applyScale} />
          <div className="flex items-center justify-between">
            <span className="text-mini text-fg-3">Scales the whole editor. Also Ctrl +/− / 0.</span>
            <Button variant="tonal" size="sm" onClick={async () => {
              const d = await window.artlux?.detectUiScale?.();
              if (typeof d === 'number') applyScale(d);
            }}>Reset to detected</Button>
          </div>
          {/* Editor-only by construction: broadcast/headless never open the splash whatever this says
              (main/splashWindow.ts), so an unattended venue PC is unaffected either way. */}
          <Toggle label="Startup splash" checked={showSplash} onChange={(v) => {
            setShowSplash(v);
            window.artlux?.setPrefs?.({ showSplash: v });
          }} title="Show the credits + plugin/native load report at launch" />
          {/* The way back to the fixed shell, without editing prefs by hand. Deliberately a PREFERENCE
              rather than a view option: the two paths are different renderers, so switching remounts the
              panels. Output is unaffected either way — the frame loop has not lived in the UI since
              Phase 1, which is the whole reason this feature could be built at all. */}
          <EditorOnly>
            <Toggle label="Dockable workspace" checked={!layout.dockingOff}
              onChange={(v) => layoutStore.set({ dockingOff: !v })}
              title="Drag panels into tabs and splits, per workbench. Off restores the fixed browser / viewport / dock / parameters layout." />
          </EditorOnly>
        </>
    ) },
    { id: 'workspaces', title: 'Workspaces', group: 'interface', icon: <LayoutGrid size={14} />, body: (
          <EditorOnly><WorkspacesSection /></EditorOnly>
    ) },
    { id: 'dmx', title: 'DMX Output', group: 'output', icon: <Cpu size={14} />, body: (
        <>
          <Field label="Protocol" labelWidth={LBL}>
            <Select value={settings.protocol} onChange={(e) => onChange({ protocol: e.target.value as AppSettings['protocol'] })}>
              <option value="artnet">Art-Net</option>
              <option value="sacn">sACN (E1.31)</option>
            </Select>
          </Field>
          {/* Guarded: turning this off stops ALL Art-Net/sACN output — a live stage goes dark. Confirm
              before killing it; turning it back on is unguarded. */}
          <Toggle label="Output enabled" checked={settings.outputEnabled} onChange={async (v) => {
            if (!v && !(await confirm({
              title: 'Disable all DMX output?',
              message: 'This stops every Art-Net / sACN frame — any live fixtures and projectors driven by DMX go dark.',
              confirmLabel: 'Disable output', danger: true,
            }))) return;
            onChange({ outputEnabled: v });
          }} />
          <Field label="Target IP" labelWidth={LBL}>
            <Tooltip id="general.dmx-target-ip">
              <input
                type="text"
                value={settings.artNetIp}
                onChange={(e) => onChange({ artNetIp: e.target.value })}
                title="The default address DMX frames are sent to (unicast, or broadcast/multicast per the toggle)."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.dmx-target-ip')}
              />
            </Tooltip>
          </Field>
          <NumberField label="Port" labelWidth={LBL} value={settings.artNetPort} step={1} onChange={(v) => onChange({ artNetPort: v })} />
          <Toggle label="Broadcast / multicast" checked={settings.broadcast} onChange={(v) => onChange({ broadcast: v })} />

          {/* Art-Net device discovery (ArtPoll) */}
          <div className="space-y-1.5 pt-1">
            <Button variant="tonal" size="sm" onClick={scan} disabled={scanning} className="w-full">
              <Radar size={13} className={scanning ? 'animate-spin' : ''} /> {scanning ? 'Scanning…' : 'Discover devices'}
            </Button>
            {devices.length > 0 && (
              <div className="border border-line-1 rounded-sm divide-y divide-line-1 max-h-32 overflow-auto">
                {devices.map((d) => {
                  const active = settings.artNetIp === d.ip;
                  return (
                    <button
                      key={d.ip}
                      onClick={() => onChange({ artNetIp: d.ip })}
                      title={d.longName || d.shortName}
                      className={`w-full flex items-center justify-between gap-2 px-2 py-1 text-left transition-colors hover:bg-surface-3 ${active ? 'bg-accent/10' : ''}`}
                    >
                      <span className="min-w-0">
                        <span className="block text-mini text-fg-1 truncate">{d.shortName || d.longName || 'Art-Net node'}</span>
                        <span className="block num text-micro text-fg-3">{d.ip}{d.mac ? ` · ${d.mac}` : ''}</span>
                      </span>
                      {active && <Check size={12} className="text-accent shrink-0" />}
                    </button>
                  );
                })}
              </div>
            )}
            {scanned && !scanning && devices.length === 0 && (
              <div className="text-micro text-fg-3 italic px-0.5">No Art-Net nodes replied.</div>
            )}
          </div>
        </>
    ) },
    { id: 'engine', title: 'Engine', group: 'output', icon: <Cpu size={14} />, body: (
        <>
          <NumberField label="FPS" labelWidth={LBL} value={settings.fps} step={1} min={1} max={1000} onChange={(v) => onChange({ fps: Math.max(1, Math.min(1000, Math.round(v))) })} />
          <Toggle label="Keep-alive" checked={settings.keepAlive} onChange={(v) => onChange({ keepAlive: v })} title="Re-send last frame at FPS so receivers never starve" />
          <Toggle label="Synchronous output (ArtSync)" checked={settings.artNetSync} onChange={(v) => onChange({ artNetSync: v })} title="Send ArtSync (0x5200) after each frame so nodes latch + output simultaneously (tear-free multi-universe)" />
          <Slider label="Gamma" value={settings.gamma} min={1} max={3} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => onChange({ gamma: v })} />
          {/* Cold start: how long to wait for the opening content to decode before the show machine is
              armed anyway. The gate ALWAYS fails open — this is the venue's patience for a slow disk or
              a missing asset, not a choice about whether to wait forever. See services/bootGate.ts. */}
          <NumberField label="Preload wait (s)" labelWidth={LBL} value={settings.bootPreloadSec ?? 15} step={1} min={1} max={120}
            onChange={(v) => onChange({ bootPreloadSec: Math.max(1, Math.min(120, Math.round(v))) })} />
          {/* Engine rate — how often a new frame is composited, sampled and published, and therefore
              how often each layer's codec is asked for a frame. Higher is not always smoother: asking
              faster than the decoder can serve returns the nearest frame instead of the exact one, and
              a burst of those is the stutter. Not the Art-Net wire rate (that is FPS above, paced with
              keep-alive). Lower this if the preview stutters on heavy video; raise it on a fast rig. */}
          <NumberField label="Engine rate (fps)" labelWidth={LBL} value={settings.engineFps ?? 30} step={1} min={1} max={120}
            onChange={(v) => onChange({ engineFps: Math.max(1, Math.min(120, Math.round(v))) })} />
          <NativeEngineSwitch />
        </>
    ) },
    { id: 'gpu', title: 'GPU rendering', group: 'output', icon: <Cpu size={14} />, body: <GpuSection /> },
    { id: 'blender', title: 'Blender', group: 'media', icon: <Box size={14} />, body: <BlenderSection /> },
    { id: 'osc', title: 'OSC / Tracking', group: 'control', icon: <Radio size={14} />, body: (
        <>
          <Toggle label="OSC receive" checked={settings.oscEnabled} onChange={(v) => onChange({ oscEnabled: v })} title="Bind a UDP listener for external control + LiDAR blob tracking" />
          <NumberField label="Listen port" labelWidth={LBL} value={settings.oscListenPort} step={1} min={1} max={65535} onChange={(v) => onChange({ oscListenPort: Math.max(1, Math.min(65535, Math.round(v))) })} />
          <Field label="Bind address" labelWidth={LBL}>
            <Tooltip id="general.osc-bind-address">
              <input
                type="text"
                value={settings.oscListenAddress}
                placeholder="All interfaces"
                onChange={(e) => onChange({ oscListenAddress: e.target.value.trim() })}
                title="Bind the OSC receiver to one local network card (this machine's IP, e.g. its 192.168.61.x address). Leave blank to listen on all interfaces."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.osc-bind-address')}
              />
            </Tooltip>
          </Field>
          {/* Quick-pick the local NIC to bind (this machine's addresses). */}
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onChange({ oscListenAddress: '' })}
              className={`px-1.5 py-0.5 rounded-sm border num text-micro transition-colors ${settings.oscListenAddress === '' ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
            >All</button>
            {localAddrs.map((ip) => (
              <button
                key={ip}
                onClick={() => onChange({ oscListenAddress: ip })}
                className={`px-1.5 py-0.5 rounded-sm border num text-micro transition-colors ${settings.oscListenAddress === ip ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:text-fg-1'}`}
              >{ip}</button>
            ))}
          </div>
          <Field label="Control prefix" labelWidth={LBL}>
            <Tooltip id="general.osc-control-prefix">
              <input
                type="text"
                value={settings.oscControlPrefix}
                onChange={(e) => onChange({ oscControlPrefix: e.target.value })}
                title="Namespace for external control (e.g. /artlux/transport/play). LiDAR blob addresses (/SOL, /MUR, /SOL_MUR) are handled separately."
                className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
                {...help('general.osc-control-prefix')}
              />
            </Tooltip>
          </Field>
          <OscSendersBlock settings={settings} onChange={onChange} />
        </>
    ) },
    { id: 'watchdog', title: 'Unattended / Watchdog', group: 'system', icon: <ShieldAlert size={14} />, body: <WatchdogSection /> },
    // Plugin-contributed sections (e.g. the mp4 plugin's "Video"). Each owns its fields; the host passes
    // the shared settings + onChange. Contained in its OWN ErrorBoundary, so a throwing plugin panel
    // leaves the rest of Preferences usable — including Unattended / Watchdog, which is where an operator
    // goes when things are already going wrong.
    ...settingsSectionRegistry.all().map((sec): Topic => ({
      id: sec.id, title: sec.title, group: PLUGIN_GROUP[sec.id] ?? 'plugins', icon: sec.icon ?? <Cpu size={14} />,
      body: (
        <ErrorBoundary variant="panel" scope={`plugin:${sec.id}`} pluginId={sec.id} label={sec.title}>
          <sec.Component settings={settings} onChange={onChange} />
        </ErrorBoundary>
      ),
    })),
  ];

  // No title bar: the ActionBar above already carries the context icon + "Preferences".
  return <TopicLayout topics={topics} footer={<ElsewhereSections />} />;
};
