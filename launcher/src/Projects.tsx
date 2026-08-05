// The Projects tab: everything on this machine that ArtLux can open, and one click to open it.
//
// Two sources, deliberately labelled: the disk scan over the library roots, and ArtLux's own recent
// files. Recents are merged in because a project on a USB stick or another drive lives outside every
// root and would otherwise be invisible here while being one click away inside the app.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addLibraryRoot, cancelScan, createProject, getConfig, getEffectiveRoots, onScanProgress,
  openProject, pickFolder, recentProjects, removeLibraryRoot, resetLibraryRoots, scanProjects, when,
  type InstallInfo, type LaunchMode, type ProjectEntry, type ScanProgress, type ScanResult,
} from './api';
import { LaunchModeNote, LaunchModePicker, ModeNotAppliedBand } from './LaunchModePicker';

/**
 * Where a project sits, when its NAME alone is ambiguous.
 *
 * Names repeat legitimately: copy an example set into your workspace and `01-hello-state-machine`
 * exists twice, in two real places. The path column already distinguishes them, but two identical
 * bold names stacked in a list read as a duplicate-entry bug rather than as two files — so the rows
 * carry the smallest trailing slice of their folder that tells them apart, the way an editor
 * disambiguates two open files of the same name. Unique names get nothing, because a qualifier on
 * every row is noise that hides the one place it matters.
 */
function qualifiers(list: ProjectEntry[]): Map<string, string> {
  const groups = new Map<string, ProjectEntry[]>();
  for (const p of list) {
    const k = p.name.toLowerCase();
    const g = groups.get(k);
    if (g) g.push(p); else groups.set(k, [p]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // The CONTAINER, not the item: a folder project is named after its own folder, so what
    // distinguishes two of them is where those folders live.
    const segments = group.map((p) => {
      const container = (p.root ?? p.path).replace(/[\\/][^\\/]*$/, '');
      return container.split(/[\\/]/).filter(Boolean).reverse();
    });
    for (let depth = 1; depth <= 5; depth++) {
      const labels = segments.map((seg) => seg.slice(0, depth).reverse().join('\\'));
      const distinct = new Set(labels.map((l) => l.toLowerCase())).size === labels.length;
      if (distinct || depth === 5) {
        group.forEach((p, i) => out.set(p.path, labels[i]));
        break;
      }
    }
  }
  return out;
}

/** Why the walk stopped early, in words the operator can act on. */
const STOPPED: Record<string, string> = {
  cap: 'Stopped at the 4000-project limit — there may be more. Narrow your library folders.',
  budget: 'Stopped after 20 seconds — there may be more. Narrow your library folders, or scan a specific one.',
  cancelled: 'Cancelled — this list is incomplete.',
};

export function Projects({ install, mode, onModeChange }: {
  install: InstallInfo | null;
  mode: LaunchMode;
  onModeChange: (m: LaunchMode) => void;
}) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [recents, setRecents] = useState<ProjectEntry[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState('');
  // `edited` distinguishes "the user curated this list" from "these are the OS defaults" — the same
  // distinction the config's Option<Vec<_>> carries, so Reset is only offered when it would do
  // something.
  const [edited, setEdited] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // "The project opened, but not in the mode you picked" — kept apart from `note` because it is a
  // different kind of thing and must not be one more grey sentence in the same box.
  const [modeMiss, setModeMiss] = useState('');
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

  const addRoot = async () => {
    const p = await pickFolder('Choose a folder to search for ArtLux projects');
    if (!p) return;
    setRoots(await addLibraryRoot(p)); setEdited(true); rescan();
  };
  const dropRoot = async (path: string) => {
    setRoots(await removeLibraryRoot(path)); setEdited(true); rescan();
  };
  const resetRoots = async () => {
    setRoots(await resetLibraryRoots()); setEdited(false); rescan();
  };

  useEffect(() => {
    getConfig().then((c) => setEdited(!!c.library_roots));
    getEffectiveRoots().then(setRoots);
    onScanProgress(setProgress).then((u) => { unlisten.current = u; });
    rescan();
    return () => { unlisten.current?.(); };
  }, [rescan]);

  // The launcher picks WHERE; ArtLux writes WHAT. Nothing here knows the shape of a project file.
  //
  // A new project always opens in the ordinary editor, whatever the launch mode says — it has no
  // surfaces, no outputs and no venue model, so the alignment workbench would have nothing to align.
  // That rule is enforced in Rust (runner::new_project), not by remembering to pass a flag here.
  const create = async () => {
    if (!install) { setNote('ArtLux is not installed yet - install it from the Install tab first.'); return; }
    if (!newName.trim() || creating) return;
    setCreating(true); setNote(''); setModeMiss('');
    try {
      const r = await createProject(install.exe, newName.trim());
      setNote(r.message + ' ArtLux is opening it.');
      setNewName('');
      // The folder exists now but its project file does not until ArtLux saves, so a rescan has to
      // wait for that; the operator can Rescan when they are back.
    } catch (e) {
      setNote(String(e));
    } finally {
      setCreating(false);
    }
  };

  const open = async (p: ProjectEntry) => {
    if (!install) { setNote('ArtLux is not installed yet — install it from the Install tab first.'); return; }
    // install.version, not a guess: the Rust refuses calibration on an ArtLux older than 0.25.1,
    // which would otherwise drop the flag in silence and open the ordinary editor.
    const r = await openProject(install.exe, p.path, mode, install.version);
    // ONE place says it: the band carries the message when the mode was missed, the note carries it
    // otherwise. Both at once reads as two separate things having happened.
    //
    // Raised only for a mode the operator went and chose. A retarget into a running ArtLux never
    // applies a mode — `mode_applied` says so truthfully for Normal too — but banner-ing the
    // ordinary "it switched to this project" is how a warning becomes something people learn to
    // scroll past. The note still says the running copy kept its own mode.
    const missed = r.ok && !r.mode_applied && mode !== 'normal';
    setModeMiss(missed ? r.message : '');
    setNote(missed ? '' : r.message);
  };

  // Recents the scan already found are not shown twice. Compared case-insensitively because Windows
  // paths differ only in case all the time (c:\ vs C:\ from a command line).
  const found = new Set((result?.entries ?? []).map((e) => e.path.toLowerCase()));
  const extraRecents = recents.filter((r) => !found.has(r.path.toLowerCase()));
  const all = [...extraRecents, ...(result?.entries ?? [])];
  const q = filter.trim().toLowerCase();
  const shown = q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) : all;
  // Computed over what is SHOWN: filtering to one of two same-named projects makes the qualifier
  // unnecessary, and keeping it would explain a collision no longer on screen.
  const qual = qualifiers(shown);

  return (
    <>
      <section className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="panel-title">Where it looks</span>
          <span className="grow" />
          <button className="btn" onClick={addRoot} disabled={busy}>Add a folder…</button>
          {/* Only offered once the list has been curated: resetting an untouched list does nothing,
              and a button that does nothing is worse than no button. */}
          {edited && <button className="btn" onClick={resetRoots} disabled={busy}>Reset</button>}
        </div>
        {roots.map((r) => (
          <div key={r} className="list-row">
            <span className="mono text-mini fg-2 grow truncate">{r}</span>
            <button className="btn btn-ghost btn-sm fg-2" onClick={() => dropRoot(r)} disabled={busy}>Remove</button>
          </div>
        ))}
        {roots.length === 0 && (
          // An empty list is a real, chosen state — not "not configured yet" — so it says what it
          // means and names the way back (§6).
          <div className="text-mini fg-2">No folders are being searched. Add one, or Reset to go back to Desktop, Documents and Videos.</div>
        )}
        <div className="caption" style={{ marginTop: 8 }}>
          Searched 6 levels deep. System folders, node_modules and build output are skipped.
        </div>
      </section>

      {/* ITS OWN PANEL, above the list. It changes what every row in that list does, so it cannot be
          one more control in the filter row — and putting it above means it is read before a project
          is clicked rather than discovered after the wrong thing opened. */}
      <section className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="panel-title">Open projects in</span>
          <span className="grow" />
          <LaunchModePicker mode={mode} onChange={onModeChange} />
        </div>
        <LaunchModeNote mode={mode} />
      </section>

      <section className="panel">
        <div className="row" style={{ marginBottom: 10 }}>
          <span className="panel-title">Your projects</span>
          <span className="grow" />
          <input
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            placeholder="New project name..."
            aria-label="Name for a new project"
            style={{ width: 170 }}
          />
          <button className="btn btn-primary" onClick={create} disabled={creating || !newName.trim()}>
            {creating ? 'Creating...' : 'Create'}
          </button>
          <span style={{ width: 1, height: 18, background: 'var(--line-2)' }} />
          <input
            className="input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            aria-label="Filter projects"
            style={{ width: 180 }}
          />
          <button className="btn" onClick={rescan} disabled={busy}>{busy ? 'Scanning…' : 'Rescan'}</button>
          {busy && <button className="btn" onClick={cancelScan}>Cancel</button>}
        </div>

        {busy && progress && (
          <div className="caption" style={{ marginBottom: 8 }}>
            {progress.found} found · {progress.scanned} folders searched
            <span className="mono" style={{ marginLeft: 8 }}>{progress.current}</span>
          </div>
        )}

        {/* A truncated list must SAY it is truncated. Silently showing 4000 of 9000 reads as
            "that is everything", which is the one thing it is not. */}
        {result?.stopped && (
          <div className="panel panel-warn panel-tight text-mini" style={{ marginBottom: 10, boxShadow: 'none', color: 'var(--warn)' }}>
            ⚠ {STOPPED[result.stopped] ?? result.stopped}
          </div>
        )}

        {!busy && shown.length === 0 && (
          <>
            <div className="text-xs" style={{ marginBottom: 2 }}>{q ? 'Nothing matches that.' : 'No ArtLux projects found yet.'}</div>
            {!q && <div className="caption">Searched {roots.length} folder(s). Add the folder your shows live in, or open one from the Examples tab.</div>}
          </>
        )}

        {shown.map((p) => (
          <div
            key={p.path}
            className="list-row pressable"
            role="button"
            tabIndex={0}
            onClick={() => open(p)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p); } }}
          >
            {/* ONE fixed-width cell holding the name and its qualifier, both nowrap. A qualifier
                added beside a free-growing name wrapped the cell and every column after it went
                ragged — the rows stopped being scannable, which is the only thing a list is for. */}
            <span style={{ flex: '0 0 330px', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
              <span className="text-xs fw-semi" style={{ whiteSpace: 'nowrap' }}>{p.name}</span>
              {qual.has(p.path) && (
                <span className="text-micro fg-2 truncate" title={p.root ?? p.path}>{qual.get(p.path)}</span>
              )}
            </span>
            {/* Kind is a WORD, not a colour or an icon alone (§6). */}
            <span className="caption" style={{ flex: '0 0 46px' }}>{p.kind}</span>
            <span className="caption mono" style={{ flex: '0 0 44px' }}>{p.version ? `v${p.version}` : ''}</span>
            <span className="caption" style={{ flex: '0 0 92px' }}>{when(p.mtime_ms)}</span>
            {p.source === 'recent' && <span className="caption">recent</span>}
            <span className="mono text-micro fg-2 grow truncate path-tail">{p.root ?? p.path}</span>
          </div>
        ))}
      </section>

      {modeMiss && <ModeNotAppliedBand>{modeMiss}</ModeNotAppliedBand>}
      {note && (
        <section className="panel panel-tight">
          <div className="text-mini fg-2">{note}</div>
        </section>
      )}
    </>
  );
}
