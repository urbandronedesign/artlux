// The Examples tab: the sets ArtLux ships, copied somewhere you can actually save.
//
// Copy-then-open rather than open-in-place, because the shipped examples live inside the install
// under Program Files, which is owned by Administrators — opening one there and pressing Save fails,
// and "use Save As" is a workaround you have to know in advance.
//
// The whole SET is copied, never one file: audio/ shares a single assets/ folder, so one project
// without it is broken, and with it you have copied the set anyway. You choose which one opens.

import { useCallback, useEffect, useState } from 'react';
import { copyExample, getWorkspace, listExamples, mb, openProject, pickFolder, setWorkspace, type ExampleSet, type InstallInfo, type LaunchMode } from './api';
import { LaunchModeNote, LaunchModePicker, ModeNotAppliedBand } from './LaunchModePicker';

export function Examples({ install, mode, onModeChange }: {
  install: InstallInfo | null;
  mode: LaunchMode;
  onModeChange: (m: LaunchMode) => void;
}) {
  const [sets, setSets] = useState<ExampleSet[]>([]);
  const [workspace, setWorkspace2] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [modeMiss, setModeMiss] = useState('');

  const load = useCallback(async () => {
    if (!install) { setSets([]); return; }
    setSets(await listExamples(install.dir));
    setWorkspace2(await getWorkspace());
  }, [install]);

  useEffect(() => { load(); }, [load]);

  const changeWorkspace = async () => {
    const p = await pickFolder('Choose where copied example projects should go');
    if (!p) return;
    setWorkspace2(await setWorkspace(p));
  };

  const use = async (set: ExampleSet, project: string) => {
    if (!install) return;
    setBusy(set.id); setNote(''); setError(''); setModeMiss('');
    try {
      const r = await copyExample(install.dir, set.id, project);
      setNote(r.message);
      const o = await openProject(install.exe, r.project, mode, install.version);
      // The copy always happened and is worth saying — so unlike Projects, the note stays and only
      // the OPEN half moves into the band. Same rule underneath: each fact is stated once.
      const missed = o.ok && !o.mode_applied && mode !== 'normal';
      setNote(missed ? r.message : `${r.message} ${o.message}`);
      setModeMiss(missed ? o.message : '');
      if (!o.ok) setError(o.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  if (!install) {
    return (
      <section className="panel">
        <div className="panel-title" style={{ marginBottom: 8 }}>Examples</div>
        <div className="text-xs" style={{ marginBottom: 2 }}>ArtLux is not installed yet.</div>
        {/* An empty state names the next action rather than only reporting emptiness. */}
        <div className="caption">The example projects ship inside the app — install it from the Install tab and they appear here.</div>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title" style={{ marginBottom: 6 }}>Example projects</div>
        <div className="caption" style={{ marginBottom: 8 }}>
          Each set is copied into your workspace before it opens, so you can save your changes.
        </div>
        <div className="row">
          <span className="mono text-mini fg-2 grow truncate">{workspace}</span>
          <button className="btn" onClick={changeWorkspace} disabled={!!busy}>Change…</button>
        </div>
      </section>

      {/* The same control as the Projects tab, over the same state — not a second setting. An
          example opened here starts ArtLux exactly as a project row does, so hiding the choice on
          one of the two tabs would just mean opening an example in whatever was picked elsewhere. */}
      <section className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="panel-title">Open projects in</span>
          <span className="grow" />
          <LaunchModePicker mode={mode} onChange={onModeChange} disabled={!!busy} />
        </div>
        <LaunchModeNote mode={mode} />
      </section>

      {sets.map((s) => (
        <section key={s.id} className="panel">
          <div className="row" style={{ alignItems: 'baseline', marginBottom: 4 }}>
            {/* Size carries hierarchy: a set title is a step above its own body. */}
            <span className="text-sm fw-semi">{s.title}</span>
            <span className="caption">{s.projects.length} projects · {mb(s.size)}{s.has_tutorial ? ' · tutorial included' : ''}</span>
          </div>
          {s.blurb && <div className="text-mini fg-2" style={{ marginBottom: 12 }}>{s.blurb}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {s.projects.map((p, i) => (
              <button
                key={p}
                className="btn"
                disabled={!!busy}
                onClick={() => use(s, p)}
                title={`Copy the ${s.id} set into your workspace and open ${s.project_names[i]}`}
              >
                {busy === s.id ? 'Copying…' : s.project_names[i]}
              </button>
            ))}
          </div>
        </section>
      ))}

      {modeMiss && <ModeNotAppliedBand>{modeMiss}</ModeNotAppliedBand>}
      {note && !error && (
        <section className="panel panel-ok panel-tight">
          <div className="text-mini fw-semi" style={{ color: 'var(--ok)' }}>✓ {note}</div>
        </section>
      )}
      {error && (
        <section className="panel panel-danger panel-tight">
          <div className="text-mini fw-semi" style={{ color: 'var(--danger)' }}>✕ {error}</div>
        </section>
      )}
    </>
  );
}
