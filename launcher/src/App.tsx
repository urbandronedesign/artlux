// Stage 1: the Install tab. Detect what is here, resolve what is published, download it verified,
// run it, and say plainly what happened.
//
// The tabs for Projects / Examples / Health are declared but disabled — they are stages 2–4. They
// are shown rather than hidden so the shape of the product is legible from the first build, and each
// says why it is not available yet instead of being a dead control.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Credits, Wordmark, APP_TAGLINE } from './brand';
import { Projects } from './Projects';
import {
  artluxRunning, cancelDownload, downloadInstaller, isNewer, mb, onProgress,
  resolveLatest, runInstaller, scanInstalls,
  type InstallScan, type Progress, type ReleaseInfo,
} from './api';
import './styles.css';

type Phase = 'idle' | 'checking' | 'downloading' | 'installing';

const TABS = [
  { id: 'install', label: 'Install', ready: true },
  { id: 'projects', label: 'Projects', ready: true },
  { id: 'examples', label: 'Examples', ready: false, why: 'The example gallery lands after Projects.' },
  { id: 'health', label: 'Health', ready: false, why: 'The machine check (preflight) lands last.' },
] as const;

export default function App() {
  const [tab, setTab] = useState<string>('install');
  const [scan, setScan] = useState<InstallScan | null>(null);
  const [latest, setLatest] = useState<ReleaseInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const [running, setRunning] = useState(false);
  const unlisten = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setScan(await scanInstalls());
    setRunning(await artluxRunning());
  }, []);

  useEffect(() => {
    refresh();
    onProgress(setProgress).then((u) => { unlisten.current = u; });
    return () => { unlisten.current?.(); };
  }, [refresh]);

  const check = async () => {
    setError(''); setOutcome(''); setPhase('checking');
    try {
      setLatest(await resolveLatest());
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase('idle');
    }
  };

  const installNow = async () => {
    if (!latest) return;
    setError(''); setOutcome(''); setProgress(null); setPhase('downloading');
    try {
      const path = await downloadInstaller(latest);
      setPhase('installing');
      const res = await runInstaller(path);
      setOutcome(res.message);
      setScan(res.scan);
      if (!res.ok) setError(res.message);
    } catch (e) {
      // "cancelled" is a user action, not a failure to report as one.
      const msg = String(e);
      if (!msg.includes('cancelled')) setError(msg);
    } finally {
      setPhase('idle');
      refresh();
    }
  };

  const primary = scan?.installs.find((i) => !i.per_user) ?? scan?.installs[0] ?? null;
  const busy = phase !== 'idle';

  // "Is the published version newer?" is answered by Rust's semver, never here. A second comparison
  // in TypeScript is a second source of truth, and the naive one is wrong in a way that only shows
  // up late: "0.9.0" > "0.25.0" as strings, so the launcher would stop offering updates at 0.10.0.
  const [updatable, setUpdatable] = useState(false);
  useEffect(() => {
    if (!latest || !primary?.version) { setUpdatable(false); return; }
    let live = true;
    isNewer(latest.version, primary.version).then((v) => { if (live) setUpdatable(v); });
    return () => { live = false; };
  }, [latest, primary?.version]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Identity band */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 24px', borderBottom: '1px solid var(--line-2)' }}>
        <div style={{ color: 'var(--fg-1)' }}><Wordmark height={20} /></div>
        <div style={{ width: 1, height: 22, background: 'var(--line-2)' }} />
        <div className="dim" style={{ fontSize: 12 }}>Launcher</div>
        <div style={{ flex: 1 }} />
        <div className="caption">{APP_TAGLINE}</div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Rail */}
        <nav style={{ width: 168, borderRight: '1px solid var(--line-2)', padding: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              disabled={!t.ready}
              title={t.ready ? undefined : t.why}
              className="btn-ghost"
              style={{
                border: 0, textAlign: 'left', padding: '7px 10px', borderRadius: 'var(--radius-md)',
                background: tab === t.id ? 'var(--surface-2)' : 'transparent',
                color: tab === t.id ? 'var(--fg-1)' : 'var(--fg-2)',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {tab === 'projects' && <Projects install={primary} />}
          {tab === 'install' && <>
          <section className="card" style={{ padding: 18 }}>
            <div className="label" style={{ marginBottom: 10 }}>On this machine</div>
            {!scan && <div className="dim">Looking…</div>}
            {scan && scan.installs.length === 0 && (
              <div>
                <div style={{ marginBottom: 4 }}>ArtLux is not installed.</div>
                <div className="caption">Check for the latest version below, then install it.</div>
              </div>
            )}
            {scan?.installs.map((i) => (
              <div key={i.dir} style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>{i.version || 'unknown version'}</span>
                <span className="mono dim" style={{ fontSize: 11 }}>{i.dir}</span>
                <span className="caption">
                  {i.per_user ? 'per-user' : 'per-machine'} · found via {i.found_by}
                </span>
              </div>
            ))}
            {scan?.duplicate && (
              <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--warn)', borderRadius: 'var(--radius-md)' }}>
                <div style={{ color: 'var(--warn)', fontWeight: 600, marginBottom: 4 }}>⚠ Two installs are present</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  A per-user install from before 2026-07-22 sits alongside a per-machine one. Windows treats them as
                  different products, so it will never replace one with the other — you get two Start Menu entries and,
                  depending on which you launch, a different version. Remove the per-user one.
                </div>
              </div>
            )}
            {running && (
              <div className="caption" style={{ marginTop: 8 }}>ArtLux is running right now — close it before installing.</div>
            )}
          </section>

          <section className="card" style={{ padding: 18 }}>
            <div className="label" style={{ marginBottom: 10 }}>Latest release</div>
            {!latest && (
              <button className="btn" onClick={check} disabled={busy}>
                {phase === 'checking' ? 'Checking…' : 'Check for the latest version'}
              </button>
            )}
            {latest && (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{latest.version}</span>
                  <span className="mono dim" style={{ fontSize: 11 }}>{latest.file}</span>
                  <span className="caption">{mb(latest.size)}</span>
                </div>
                <div className="caption" style={{ marginBottom: 12 }}>
                  {primary
                    ? updatable
                      ? `Newer than the ${primary.version} you have installed.`
                      : `You already have ${primary.version || 'an install'}. Reinstalling is safe.`
                    : 'Not installed yet.'}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-primary" onClick={installNow} disabled={busy || running}>
                    {primary ? (updatable ? 'Update' : 'Reinstall') : 'Install ArtLux'}
                  </button>
                  {phase === 'downloading' && (
                    <button className="btn" onClick={cancelDownload}>Cancel</button>
                  )}
                  <div style={{ flex: 1 }} />
                  <span className="caption">Windows will ask for administrator permission.</span>
                </div>
              </>
            )}
          </section>

          {(phase === 'downloading' || phase === 'installing' || progress) && (
            <section className="card" style={{ padding: 18 }}>
              <div className="label" style={{ marginBottom: 10 }}>
                {phase === 'installing' ? 'Installing' : 'Downloading'}
              </div>
              <div className="bar" style={{ marginBottom: 8 }}>
                <i style={{ width: progress && progress.total ? `${Math.min(100, (progress.received / progress.total) * 100)}%` : '0%' }} />
              </div>
              <div className="caption">
                {phase === 'installing'
                  ? 'Running the installer. It also installs the NDI and Visual C++ runtimes and adds the firewall rules.'
                  : progress
                    ? `${mb(progress.received)} of ${mb(progress.total)} — verified against the checksum GitHub published before anything is run.`
                    : 'Starting…'}
              </div>
            </section>
          )}

          {outcome && !error && (
            <section className="card" style={{ padding: 18, borderColor: 'var(--ok)' }}>
              <div style={{ color: 'var(--ok)', fontWeight: 600 }}>✓ {outcome}</div>
            </section>
          )}
          {error && (
            <section className="card" style={{ padding: 18, borderColor: 'var(--danger)' }}>
              <div style={{ color: 'var(--danger)', fontWeight: 600, marginBottom: 4 }}>✕ That did not work</div>
              <div className="dim" style={{ fontSize: 12 }}>{error}</div>
            </section>
          )}
          </>}
        </main>
      </div>

      <footer style={{ padding: '12px 24px', borderTop: '1px solid var(--line-2)' }}>
        <Credits />
      </footer>
    </div>
  );
}

