import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, FolderSearch, Plus, Trash2, Check, Power } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import type { Playlist, PlaylistStatus, ProjectInfo } from './types';
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

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const rid = () => Math.random().toString(36).slice(2, 10);
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export const PlaylistPanel: React.FC<PanelProps> = () => {
  const ipc = getIpc();
  const [pl, setPl] = useState<Playlist>({ enabled: false, entries: [] });
  const [status, setStatus] = useState<PlaylistStatus | null>(null);
  const [scanned, setScanned] = useState<ProjectInfo[]>([]);
  const [folder, setFolder] = useState('');
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

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

  const save = (next: Playlist) => { setPl(next); ipc?.send('showctl:playlist-set', next); void pull(); };

  const scan = async () => {
    if (!folder) return;
    setBusy(true);
    try {
      const list = await ipc?.invoke('showctl:scan', folder) as ProjectInfo[] | undefined;
      setScanned(list ?? []);
      save({ ...pl, folder });
    } finally { setBusy(false); }
  };

  const add = (p: ProjectInfo) => save({
    ...pl,
    entries: [...pl.entries, { id: rid(), enabled: true, projectPath: p.path, name: p.name, time, days: [...days] }],
  });

  const dayLabel = (d: number[]) => d.length === 0 ? 'every day' : d.slice().sort().map((i) => DAYS[i]).join(' ');

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
          <div>next: <span className="text-fg-2">{status.nextPath ? `${baseName(status.nextPath)} at ${status.nextAt}` : '—'}</span></div>
          {!pl.enabled && <div className="text-warn">Switching is off — entries below will not fire.</div>}
        </div>
      )}

      {/* scan a folder for projects */}
      <div className="rounded border border-line-1 bg-surface-2 p-2 space-y-2">
        <div className="flex items-center gap-1.5">
          <input
            value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="folder of .artlux projects"
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 outline-none focus:border-accent"
          />
          <button onClick={scan} disabled={!folder || busy}
            className="inline-flex items-center gap-1 px-2 h-6 rounded border border-line-1 bg-surface-1 hover:bg-surface-3 disabled:opacity-40 text-micro">
            <FolderSearch size={11} /> {busy ? 'Scanning…' : 'Scan'}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
            className="bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 num" />
          {DAYS.map((d, i) => (
            <button key={d} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i])}
              className={`px-1.5 h-5 rounded text-micro border ${days.includes(i) ? 'bg-accent text-black border-transparent' : 'bg-surface-1 text-fg-2 border-line-1 hover:text-fg-1'}`}>{d}</button>
          ))}
          <span className="text-micro text-fg-3">{days.length === 0 ? 'every day' : ''}</span>
        </div>
        {scanned.length > 0 && (
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {scanned.map((p) => (
              <div key={p.path} className="flex items-center gap-2 px-1.5 py-1 rounded bg-surface-1 border border-line-1">
                <span className="flex-1 truncate text-fg-2" title={p.path}>{p.name}</span>
                <span className="text-micro text-fg-3 shrink-0">{p.isFolder ? 'folder' : 'file'}</span>
                <button onClick={() => add(p)} title="Add to the playlist at the time above"
                  className="text-fg-3 hover:text-accent shrink-0"><Plus size={12} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* the playlist */}
      {pl.entries.length === 0
        ? <div className="text-fg-3 italic text-mini px-1">No entries. Scan a folder, pick a time, then add projects.</div>
        : <div className="space-y-1">
            {pl.entries.slice().sort((a, b) => a.time.localeCompare(b.time)).map((e) => (
              <div key={e.id} className="flex items-center gap-2 px-2 py-1.5 rounded border border-line-1 bg-surface-2">
                <button
                  onClick={() => save({ ...pl, entries: pl.entries.map((x) => x.id === e.id ? { ...x, enabled: !x.enabled } : x) })}
                  className={`w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 ${e.enabled ? 'bg-accent border-transparent text-black' : 'border-line-2 text-transparent'}`}>
                  <Check size={10} />
                </button>
                <span className="num text-fg-1 shrink-0">{e.time}</span>
                <span className="flex-1 truncate text-fg-2" title={e.projectPath}>{e.name || baseName(e.projectPath)}</span>
                <span className="text-micro text-fg-3 shrink-0">{dayLabel(e.days)}</span>
                <button onClick={() => save({ ...pl, entries: pl.entries.filter((x) => x.id !== e.id) })}
                  title="Remove" className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>}
    </div>
  );
};
