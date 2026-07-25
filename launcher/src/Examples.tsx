// The Examples tab: the sets ArtLux ships, copied somewhere you can actually save.
//
// Copy-then-open rather than open-in-place, because the shipped examples live inside the install
// under Program Files, which is owned by Administrators — opening one there and pressing Save fails,
// and "use Save As" is a workaround you have to know in advance.
//
// The whole SET is copied, never one file: audio/ shares a single assets/ folder, so one project
// without it is broken, and with it you have copied the set anyway. You choose which one opens.

import { useCallback, useEffect, useState } from 'react';
import { copyExample, getWorkspace, listExamples, mb, openProject, type ExampleSet, type InstallInfo } from './api';

export function Examples({ install }: { install: InstallInfo | null }) {
  const [sets, setSets] = useState<ExampleSet[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!install) { setSets([]); return; }
    setSets(await listExamples(install.dir));
    setWorkspace(await getWorkspace());
  }, [install]);

  useEffect(() => { load(); }, [load]);

  const use = async (set: ExampleSet, project: string) => {
    if (!install) return;
    setBusy(set.id); setNote(''); setError('');
    try {
      const r = await copyExample(install.dir, set.id, project);
      setNote(r.message);
      const o = await openProject(install.exe, r.project);
      setNote(`${r.message} ${o.message}`);
      if (!o.ok) setError(o.message);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  if (!install) {
    return (
      <section className="card" style={{ padding: 18 }}>
        <div className="label" style={{ marginBottom: 8 }}>Examples</div>
        <div style={{ marginBottom: 4 }}>ArtLux is not installed yet.</div>
        {/* An empty state names the next action rather than only reporting emptiness. */}
        <div className="caption">The example projects ship inside the app — install it from the Install tab and they appear here.</div>
      </section>
    );
  }

  return (
    <>
      <section className="card" style={{ padding: 18 }}>
        <div className="label" style={{ marginBottom: 6 }}>Example projects</div>
        <div className="caption" style={{ marginBottom: 4 }}>
          Each set is copied into your workspace before it opens, so you can save your changes.
        </div>
        <div className="mono dim" style={{ fontSize: 11 }}>{workspace}</div>
      </section>

      {sets.map((s) => (
        <section key={s.id} className="card" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{s.title}</span>
            <span className="caption">{s.projects.length} projects · {mb(s.size)}{s.has_tutorial ? ' · tutorial included' : ''}</span>
          </div>
          {s.blurb && <div className="dim" style={{ fontSize: 12, marginBottom: 12 }}>{s.blurb}</div>}
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

      {note && !error && (
        <section className="card" style={{ padding: 14, borderColor: 'var(--ok)' }}>
          <div style={{ color: 'var(--ok)', fontSize: 12 }}>✓ {note}</div>
        </section>
      )}
      {error && (
        <section className="card" style={{ padding: 14, borderColor: 'var(--danger)' }}>
          <div style={{ color: 'var(--danger)', fontSize: 12 }}>✕ {error}</div>
        </section>
      )}
    </>
  );
}
