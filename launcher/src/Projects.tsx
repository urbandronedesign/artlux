// The Projects tab: everything on this machine that ArtLux can open, and one click to open it.
//
// Two sources, deliberately labelled: the disk scan over the library roots, and ArtLux's own recent
// files. Recents are merged in because a project on a USB stick or another drive lives outside every
// root and would otherwise be invisible here while being one click away inside the app.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelScan, getEffectiveRoots, onScanProgress, openProject, recentProjects, scanProjects, when,
  type InstallInfo, type ProjectEntry, type ScanProgress, type ScanResult,
} from './api';

/** Why the walk stopped early, in words the operator can act on. */
const STOPPED: Record<string, string> = {
  cap: 'Stopped at the 4000-project limit — there may be more. Narrow your library folders.',
  budget: 'Stopped after 20 seconds — there may be more. Narrow your library folders, or scan a specific one.',
  cancelled: 'Cancelled — this list is incomplete.',
};

export function Projects({ install }: { install: InstallInfo | null }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [recents, setRecents] = useState<ProjectEntry[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  const unlisten = useRef<(() => void) | null>(null);

  const rescan = useCallback(async () => {
    setBusy(true); setNote(''); setProgress(null);
    try {
      setRecents(await recentProjects());
      setResult(await scanProjects());
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false); setProgress(null);
    }
  }, []);

  useEffect(() => {
    getEffectiveRoots().then(setRoots);
    onScanProgress(setProgress).then((u) => { unlisten.current = u; });
    rescan();
    return () => { unlisten.current?.(); };
  }, [rescan]);

  const open = async (p: ProjectEntry) => {
    if (!install) { setNote('ArtLux is not installed yet — install it from the Install tab first.'); return; }
    const r = await openProject(install.exe, p.path);
    setNote(r.message);
  };

  // Recents that the scan already found are not shown twice. Compared case-insensitively because
  // Windows paths differ only in case all the time (c:\ vs C:\ from a command line).
  const found = new Set((result?.entries ?? []).map((e) => e.path.toLowerCase()));
  const extraRecents = recents.filter((r) => !found.has(r.path.toLowerCase()));
  const all = [...extraRecents, ...(result?.entries ?? [])];
  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : all;

  return (
    <>
      <section className="card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div className="label">Your projects</div>
          <div style={{ flex: 1 }} />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter projects"
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--line-2)', color: 'var(--fg-1)',
              borderRadius: 'var(--radius-md)', padding: '5px 9px', font: 'inherit', fontSize: 12, width: 190,
            }}
          />
          <button className="btn" onClick={rescan} disabled={busy}>{busy ? 'Scanning…' : 'Rescan'}</button>
          {busy && <button className="btn" onClick={cancelScan}>Cancel</button>}
        </div>

        {busy && progress && (
          <div className="caption" style={{ marginBottom: 10 }}>
            {progress.found} found · {progress.scanned} folders searched
            <span className="mono" style={{ marginLeft: 8 }}>{progress.current}</span>
          </div>
        )}

        {/* A truncated list must SAY it is truncated. Silently showing 4000 of 9000 reads as
            "that is everything", which is the one thing it is not. */}
        {result?.stopped && (
          <div style={{ marginBottom: 10, padding: 10, border: '1px solid var(--warn)', borderRadius: 'var(--radius-md)', color: 'var(--warn)', fontSize: 12 }}>
            {STOPPED[result.stopped] ?? result.stopped}
          </div>
        )}

        {!busy && shown.length === 0 && (
          <div>
            <div style={{ marginBottom: 4 }}>{q ? 'Nothing matches that.' : 'No ArtLux projects found yet.'}</div>
            {/* An empty state names the next action rather than just reporting emptiness. */}
            {!q && <div className="caption">Searched {roots.length} folder(s). Add the folder your shows live in, or open one from the Examples tab.</div>}
          </div>
        )}

        {shown.map((p) => (
          <div
            key={p.path}
            role="button"
            tabIndex={0}
            onClick={() => open(p)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); } }}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 10px',
              borderBottom: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)', cursor: 'default',
            }}
          >
            <span style={{ fontWeight: 600, minWidth: 190 }}>{p.name}</span>
            {/* Colour is never the only signal — the kind is spelled out. */}
            <span className="caption" style={{ minWidth: 52 }}>{p.kind === 'folder' ? 'folder' : 'file'}</span>
            <span className="caption" style={{ minWidth: 66 }}>{p.version ? `v${p.version}` : ''}</span>
            <span className="caption" style={{ minWidth: 96 }}>{when(p.mtime_ms)}</span>
            {p.source === 'recent' && <span className="caption">recent</span>}
            <span className="mono dim" style={{ fontSize: 11, marginLeft: 'auto', direction: 'rtl', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 420 }}>
              {p.root ?? p.path}
            </span>
          </div>
        ))}
      </section>

      <section className="card" style={{ padding: 18 }}>
        <div className="label" style={{ marginBottom: 8 }}>Where it looked</div>
        {roots.map((r) => <div key={r} className="mono dim" style={{ fontSize: 11 }}>{r}</div>)}
        <div className="caption" style={{ marginTop: 8 }}>
          Folders are searched 6 levels deep. System folders, node_modules and build output are skipped.
        </div>
      </section>

      {note && (
        <section className="card" style={{ padding: 14 }}>
          <div style={{ fontSize: 12 }}>{note}</div>
        </section>
      )}
    </>
  );
}
