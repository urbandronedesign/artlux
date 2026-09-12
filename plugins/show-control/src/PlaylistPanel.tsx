import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, FolderSearch, Plus, Trash2, Check, Power, Pencil, Play } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import type { Playlist, PlaylistEntry, PlaylistStatus, ProjectInfo, ScanResult } from './types';
import { isSpent, describeRepeat } from './recurrence';
import { ScheduleFields } from './ScheduleFields';
import { useConfirm } from '@/components/ui/feedback'; // never a native dialog — see the invariant
import { getIpc } from './showControlHost';

// The unattended multi-project BROADCAST PLAYLIST, on the desktop.
//
// Time-of-day switching of the whole loaded project, by relaunch-per-project (a clean process each
// switch — the robust option for a venue that runs for weeks). It is MACHINE-global, not project data:
// it lives in a userData sidecar in main, which is why this panel talks over the plugin bridge rather
// than host.show.
//
// Like the schedule, this was previously tablet-only. Arming an unattended venue is exactly the kind
// of thing you want to do — and audit — from the machine that will be running it.
//
// EVERY ENTRY IS EDITABLE. It used to be add-or-delete: a scheduled project's time, days and project
// were fixed at the moment you tapped +, and changing the 18:00 show to 18:30 meant deleting it and
// rebuilding it from a default-time field. The scan is recursive, so a folder of folders of shows —
// how a venue actually files them — is one scan, not one per subfolder.

const rid = () => Math.random().toString(36).slice(2, 10);
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const normPath = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
const samePath = (a?: string | null, b?: string | null) => !!a && !!b && normPath(a) === normPath(b);

// Spent one-offs sink; everything else reads down the clock.
const byWhen = (a: PlaylistEntry, b: PlaylistEntry) =>
  (isSpent(a) ? 1 : 0) - (isSpent(b) ? 1 : 0) || a.time.localeCompare(b.time);

export const PlaylistPanel: React.FC<PanelProps> = () => {
  const ipc = getIpc();
  const confirmDialog = useConfirm();
  const [pl, setPl] = useState<Playlist>({ enabled: false, entries: [] });
  const [status, setStatus] = useState<PlaylistStatus | null>(null);
  const [scan, setScan] = useState<ScanResult>({ root: '', projects: [], truncated: false });
  const [folder, setFolder] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // The entry being edited (a COPY — editing the live one would make Cancel meaningless).
  const [draft, setDraft] = useState<PlaylistEntry | null>(null);

  const pull = useCallback(async () => {
    const r = await ipc?.invoke('showctl:playlist-get') as { playlist: Playlist; status: PlaylistStatus } | undefined;
    if (!r) return;
    setPl(r.playlist ?? { enabled: false, entries: [] });
    setStatus(r.status ?? null);
    if (r.playlist?.folder) setFolder((f) => f || r.playlist.folder!);
  }, [ipc]);

  // Poll slowly: `nextAt` is wall-clock, so it only changes on the minute or when someone edits it
  // from the tablet. A tighter loop would buy nothing.
  useEffect(() => { void pull(); const t = setInterval(() => void pull(), 15000); return () => clearInterval(t); }, [pull]);

  // SHOW THE PROJECTS WITHOUT BEING ASKED. The panel used to open on an empty box with a path field:
  // the machine already knows which folder the shows live in (it is saved with the playlist), so
  // making the operator press Scan to be told what it already knew is a step that buys nothing. Once
  // per mount, and only when a folder is remembered and nothing has been scanned yet.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !pl.folder || scan.projects.length) return;
    seeded.current = true;
    void scanNow(pl.folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pl.folder]);

  const save = (next: Playlist) => { setPl(next); ipc?.send('showctl:playlist-set', next); void pull(); };

  const scanNow = async (f = folder) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await ipc?.invoke('showctl:scan', f) as ScanResult | undefined;
      setScan(r ?? { root: f, projects: [], truncated: false });
      save({ ...pl, folder: f });
    } finally { setBusy(false); }
  };

  // One flow for add and edit: both open the same draft form.
  const startAdd = (p: ProjectInfo) => setDraft({
    id: rid(), enabled: true, projectPath: p.path, name: p.name, time: '09:00', days: [], repeat: 'daily',
  });
  const commitDraft = () => {
    if (!draft || !draft.projectPath) return;
    const i = pl.entries.findIndex((e) => e.id === draft.id);
    const entries = i < 0 ? [...pl.entries, draft] : pl.entries.map((e) => (e.id === draft.id ? draft : e));
    setDraft(null);
    save({ ...pl, entries });
  };
  const removeEntry = (id: string) => {
    if (draft?.id === id) setDraft(null);
    save({ ...pl, entries: pl.entries.filter((x) => x.id !== id) });
  };

  const shown = scan.projects.filter((p) =>
    !filter || (p.name + ' ' + p.rel).toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
      <div className="flex items-center gap-1.5 text-fg-2">
        <CalendarClock size={13} className="text-accent" />
        <span className="text-mini font-semibold uppercase tracking-wider">Project Playlist</span>
        <span className="text-micro text-fg-3">— unattended, switches the whole project</span>
        <button
          onClick={() => save({ ...pl, enabled: !pl.enabled })}
          title={pl.enabled ? 'Disable unattended switching' : 'Enable unattended switching'}
          className={`ml-auto inline-flex items-center gap-1 px-2 h-6 rounded text-micro border ${pl.enabled ? 'bg-ok/20 text-ok border-ok/40' : 'bg-surface-2 text-fg-3 border-line-1 hover:text-fg-1'}`}
        >
          <Power size={11} /> {pl.enabled ? 'Active' : 'Off'}
        </button>
      </div>

      {status && (
        <div className="rounded border border-line-1 bg-surface-2 px-2 py-1.5 text-micro text-fg-3 space-y-0.5">
          <div>now: <span className="text-fg-2">{status.currentPath ? baseName(status.currentPath) : '—'}</span></div>
          <div>next: <span className="text-fg-2">{status.nextPath ? `${baseName(status.nextPath)} — ${status.nextAt}` : '—'}</span></div>
          {!pl.enabled && <div className="text-warn">Switching is off — entries below will not fire.</div>}
        </div>
      )}

      {/* the playlist — every row opens the same editor the + button does */}
      {pl.entries.length === 0
        ? <div className="text-fg-3 italic text-mini px-1">No entries. Scan a folder below, then add a project.</div>
        : <div className="space-y-1">
            {pl.entries.slice().sort(byWhen).map((e) => (
              <React.Fragment key={e.id}>
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded border border-line-1 bg-surface-2 ${isSpent(e) ? 'opacity-50' : ''}`}>
                  <button
                    onClick={() => save({ ...pl, entries: pl.entries.map((x) => x.id === e.id ? { ...x, enabled: !x.enabled } : x) })}
                    title={e.enabled ? 'Disable' : 'Enable'}
                    className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${e.enabled ? 'bg-accent border-transparent text-black' : 'border-line-2 text-transparent'}`}>
                    <Check size={10} />
                  </button>
                  <span className="num text-fg-1 shrink-0">{e.time}</span>
                  <button onClick={() => setDraft(draft?.id === e.id ? null : { ...e })}
                    className="flex-1 min-w-0 text-left truncate text-fg-2 hover:text-fg-1" title={e.projectPath}>
                    {e.name || baseName(e.projectPath)}
                    {samePath(e.projectPath, status?.currentPath) && <span className="ml-1 text-micro text-ok">NOW</span>}
                    {samePath(e.projectPath, status?.nextPath) && <span className="ml-1 text-micro text-accent">NEXT</span>}
                  </button>
                  <span className="text-micro text-fg-3 shrink-0">{describeRepeat(e)}</span>
                  <button onClick={() => setDraft(draft?.id === e.id ? null : { ...e })} title="Edit"
                    className="text-fg-3 hover:text-accent shrink-0"><Pencil size={11} /></button>
                  <button onClick={() => removeEntry(e.id)} title="Remove"
                    className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
                </div>
                {draft?.id === e.id && (
                  <div className="rounded border border-accent/40 bg-surface-1 p-2 space-y-2">
                    <ScheduleFields draft={draft} onChange={(d) => setDraft(d)} />
                    <div className="flex gap-1.5">
                      <button onClick={() => setDraft(null)}
                        className="px-2 h-6 rounded border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 text-micro">Cancel</button>
                      <button onClick={commitDraft}
                        className="ml-auto px-2 h-6 rounded bg-accent text-black hover:bg-accent-hover text-micro font-medium">Save</button>
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>}

      {/* a brand-new entry edits in the same form, parked at the end of the list */}
      {draft && !pl.entries.some((e) => e.id === draft.id) && (
        <div className="rounded border border-accent/40 bg-surface-1 p-2 space-y-2">
          <div className="text-micro text-fg-3 truncate" title={draft.projectPath}>{baseName(draft.projectPath)}</div>
          <ScheduleFields draft={draft} onChange={(d) => setDraft(d)} />
          <div className="flex gap-1.5">
            <button onClick={() => setDraft(null)}
              className="px-2 h-6 rounded border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 text-micro">Cancel</button>
            <button onClick={commitDraft}
              className="ml-auto px-2 h-6 rounded bg-accent text-black hover:bg-accent-hover text-micro font-medium">Add to playlist</button>
          </div>
        </div>
      )}

      {/* find the projects on this machine — recursively */}
      <div className="rounded border border-line-1 bg-surface-2 p-2 space-y-2">
        <div className="flex items-center gap-1.5">
          <input
            value={folder} onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void scanNow(); }}
            placeholder="folder of projects — subfolders included"
            className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 outline-none focus:border-accent"
          />
          <button onClick={() => void scanNow()} disabled={!folder || busy}
            className="inline-flex items-center gap-1 px-2 h-6 rounded border border-line-1 bg-surface-1 hover:bg-surface-3 disabled:opacity-40 text-micro">
            <FolderSearch size={11} /> {busy ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        {scan.projects.length > 8 && (
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…"
            className="w-full bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 outline-none focus:border-accent" />
        )}
        {scan.projects.length > 0 && (
          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {shown.map((p) => (
              <div key={p.path} className="flex items-center gap-2 px-1.5 py-1 rounded bg-surface-1 border border-line-1">
                <span className="flex-1 truncate text-fg-2" title={p.path}>
                  {p.name}{p.rel && <span className="text-fg-3 text-micro"> · {p.rel}</span>}
                </span>
                <span className="text-micro text-fg-3 shrink-0">{p.isFolder ? 'folder' : 'file'}</span>
                <button onClick={() => startAdd(p)} title="Schedule this project"
                  className="text-fg-3 hover:text-accent shrink-0"><Plus size={12} /></button>
                <button
                  onClick={() => void confirmDialog({
                    title: `Load "${p.name}" now?`,
                    message: 'The app restarts in broadcast mode and the show that is running stops.',
                    confirmLabel: 'Load it',
                    danger: true,
                  }).then((ok) => { if (ok) ipc?.send('showctl:playlist-load', p.path); })}
                  title="Load this project now (restarts in broadcast)"
                  className="text-fg-3 hover:text-warn shrink-0"><Play size={11} /></button>
              </div>
            ))}
            {shown.length === 0 && <div className="text-fg-3 italic text-micro px-1">Nothing matches that filter.</div>}
          </div>
        )}
        {/* A silently-capped scan looks exactly like "that project is not there". */}
        {scan.truncated && (
          <div className="text-micro text-warn">Stopped after {scan.projects.length} projects — point at a narrower folder to see the rest.</div>
        )}
        {scan.root !== '' && scan.projects.length === 0 && !busy && (
          <div className="text-micro text-fg-3">No ArtLux projects under that folder.</div>
        )}
      </div>
    </div>
  );
};
