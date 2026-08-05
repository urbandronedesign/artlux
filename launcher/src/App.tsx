// The launcher shell: identity band, rail, content, credits.
//
// Styling is docs/DESIGN-SYSTEM.md throughout, expressed as the classes in styles.css rather than
// as inline style objects — same tokens, same type scale, same panel-header recipe, same
// interaction film. The tokens themselves are GENERATED from src/renderer/styles/tokens.css on
// every build, so the launcher cannot drift into being a different-looking product.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Credits, Wordmark, APP_TAGLINE } from './brand';
import { Projects } from './Projects';
import { Examples } from './Examples';
import { Health } from './Health';
import {
  artluxRunning, cancelDownload, downloadInstaller, getLaunchMode, isNewer, launcherLatest,
  launcherVersion, mb, onProgress, resolveLatest, runInstaller, scanInstalls, setLaunchMode,
  uninstallInstall, updateLauncher,
  type InstallScan, type LaunchMode, type Progress, type ReleaseInfo,
} from './api';
import './styles.css';

type Phase = 'idle' | 'checking' | 'downloading' | 'installing';

const TABS = [
  { id: 'install', label: 'Install' },
  { id: 'projects', label: 'Projects' },
  { id: 'examples', label: 'Examples' },
  { id: 'health', label: 'Health' },
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
  const [removing, setRemoving] = useState(false);
  const [ownVersion, setOwnVersion] = useState('');
  // Which ArtLux a project opens in. HELD HERE, not in either tab: Projects and Examples both start
  // the app, and two copies of this state would let one tab show "Normal" while the other launched
  // into calibration. Persisted in Rust — see LaunchModePicker for why it is remembered at all.
  const [mode, setMode] = useState<LaunchMode>('normal');
  const [selfUpdate, setSelfUpdate] = useState<ReleaseInfo | null>(null);
  const [updatingSelf, setUpdatingSelf] = useState(false);
  const unlisten = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setScan(await scanInstalls());
    setRunning(await artluxRunning());
  }, []);

  // Write-through: the state changes immediately so the control never lags a click, and the config
  // is updated behind it. A failed write is not worth a banner — the worst case is the mode is not
  // remembered next session, and the control still shows the truth about this one.
  const chooseMode = useCallback((m: LaunchMode) => {
    setMode(m);
    setLaunchMode(m).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    getLaunchMode().then(setMode).catch(() => {});
    onProgress(setProgress).then((u) => { unlisten.current = u; });
    (async () => {
      const mine = await launcherVersion();
      setOwnVersion(mine);
      try {
        const l = await launcherLatest();
        // Nothing published yet is the normal state before the first launcher release, and it is
        // not an error to report — the check simply stays silent.
        if (await isNewer(l.version, mine)) setSelfUpdate(l);
      } catch { /* offline, rate-limited, or no launcher release yet */ }
    })();
    return () => { unlisten.current?.(); };
  }, [refresh]);

  const check = async () => {
    setError(''); setOutcome(''); setPhase('checking');
    try { setLatest(await resolveLatest()); }
    catch (e) { setError(String(e)); }
    finally { setPhase('idle'); }
  };

  const removeOld = async (quietUninstall: string) => {
    setRemoving(true); setError(''); setOutcome('');
    try {
      const r = await uninstallInstall(quietUninstall);
      setScan(r.scan);
      if (r.ok) setOutcome(r.message); else setError(r.message);
    } catch (e) { setError(String(e)); }
    finally { setRemoving(false); refresh(); }
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
  // up late: "0.9.0" > "0.25.0" as strings, so it would stop offering updates at 0.10.0.
  const [updatable, setUpdatable] = useState(false);
  useEffect(() => {
    if (!latest || !primary?.version) { setUpdatable(false); return; }
    let live = true;
    isNewer(latest.version, primary.version).then((v) => { if (live) setUpdatable(v); });
    return () => { live = false; };
  }, [latest, primary?.version]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header className="row" style={{ gap: 12, padding: '14px 20px', borderBottom: '1px solid var(--line-2)' }}>
        {/* Never type the app name — the wordmark is drawn from generated outlines (§7). */}
        <span className="fg-1"><Wordmark height={18} /></span>
        <span style={{ width: 1, height: 18, background: 'var(--line-2)' }} />
        <span className="text-mini fg-2">Launcher</span>
        <span className="grow" />
        <span className="caption">{APP_TAGLINE}</span>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav
          aria-label="Sections"
          className="stack-1"
          style={{ width: 156, borderRight: '1px solid var(--line-2)', padding: 10, background: 'var(--surface-0)' }}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              className="rail-item"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <main className="stack-3" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 20 }}>
          {tab === 'projects' && <Projects install={primary} mode={mode} onModeChange={chooseMode} />}
          {tab === 'examples' && <Examples install={primary} mode={mode} onModeChange={chooseMode} />}
          {tab === 'health' && <Health install={primary} />}

          {tab === 'install' && <>
            <section className="panel">
              <div className="panel-title" style={{ marginBottom: 10 }}>On this machine</div>
              {!scan && <div className="text-mini fg-2">Looking…</div>}
              {scan && scan.installs.length === 0 && (
                <>
                  <div className="text-xs" style={{ marginBottom: 2 }}>ArtLux is not installed.</div>
                  {/* An empty state names the next action (§6). */}
                  <div className="caption">Check for the latest version below, then install it.</div>
                </>
              )}
              {scan?.installs.map((i) => (
                <div key={i.dir} className="row" style={{ marginBottom: 4 }}>
                  <span className="text-md fw-semi">{i.version || 'unknown version'}</span>
                  <span className="mono text-mini fg-2 truncate">{i.dir}</span>
                  <span className="caption">{i.per_user ? 'per-user' : 'per-machine'} · found via {i.found_by}</span>
                </div>
              ))}

              {scan?.duplicate && (
                <div className="panel panel-warn panel-tight stack-1" style={{ marginTop: 12, boxShadow: 'none' }}>
                  {/* Status is colour AND a glyph AND words — never colour alone (§6). */}
                  <div className="text-mini fw-semi" style={{ color: 'var(--warn)' }}>⚠ Two installs are present</div>
                  <div className="text-mini fg-2">
                    A per-user install from before 2026-07-22 sits alongside a per-machine one. Windows treats them as
                    different products, so it will never replace one with the other — you get two Start Menu entries and,
                    depending on which you launch, a different version.
                  </div>
                  {/* The only place this can be fixed from: nothing inside ArtLux can see the state,
                      and Windows will not resolve it on its own. */}
                  {scan.installs.filter((i) => i.per_user && i.quiet_uninstall).map((i) => (
                    <button key={i.dir} className="btn" disabled={busy || removing} onClick={() => removeOld(i.quiet_uninstall)} title={i.dir}>
                      {removing ? 'Removing…' : `Remove the per-user install (${i.version || 'unknown version'})`}
                    </button>
                  ))}
                </div>
              )}

              {running && <div className="caption" style={{ marginTop: 8 }}>ArtLux is running right now — close it before installing.</div>}
            </section>

            <section className="panel">
              <div className="panel-title" style={{ marginBottom: 10 }}>Latest release</div>
              {!latest && (
                <button className="btn" onClick={check} disabled={busy}>
                  {phase === 'checking' ? 'Checking…' : 'Check for the latest version'}
                </button>
              )}
              {latest && (
                <>
                  <div className="row" style={{ marginBottom: 4 }}>
                    <span className="text-md fw-semi">{latest.version}</span>
                    <span className="mono text-mini fg-2">{latest.file}</span>
                    <span className="caption">{mb(latest.size)}</span>
                  </div>
                  <div className="caption" style={{ marginBottom: 12 }}>
                    {primary
                      ? updatable
                        ? `Newer than the ${primary.version} you have installed.`
                        : `You already have ${primary.version || 'an install'}. Reinstalling is safe.`
                      : 'Not installed yet.'}
                  </div>
                  <div className="row">
                    <button className="btn btn-primary" onClick={installNow} disabled={busy || running}>
                      {primary ? (updatable ? 'Update' : 'Reinstall') : 'Install ArtLux'}
                    </button>
                    {phase === 'downloading' && <button className="btn" onClick={cancelDownload}>Cancel</button>}
                    <span className="grow" />
                    <span className="caption">Windows will ask for administrator permission.</span>
                  </div>
                </>
              )}
            </section>

            {(phase === 'downloading' || phase === 'installing' || progress) && (
              <section className="panel">
                <div className="panel-title" style={{ marginBottom: 10 }}>{phase === 'installing' ? 'Installing' : 'Downloading'}</div>
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
              <section className="panel panel-ok panel-tight">
                <div className="text-mini fw-semi" style={{ color: 'var(--ok)' }}>✓ {outcome}</div>
              </section>
            )}
            {error && (
              <section className="panel panel-danger panel-tight stack-1">
                <div className="text-mini fw-semi" style={{ color: 'var(--danger)' }}>✕ That did not work</div>
                <div className="text-mini fg-2">{error}</div>
              </section>
            )}
          </>}
        </main>
      </div>

      <footer className="row" style={{ padding: '10px 20px', borderTop: '1px solid var(--line-2)', alignItems: 'flex-end' }}>
        <Credits />
        <span className="grow" />
        {selfUpdate ? (
          // Says what it DOES, and then does it. It used to read "available" and call window.open,
          // which is a no-op inside a WebView — so the click did nothing at all, and even working it
          // would only have opened release notes rather than updating anything.
          <button
            className="btn btn-primary"
            disabled={updatingSelf}
            title={`Download launcher ${selfUpdate.version}, verify it, install it, and restart`}
            onClick={async () => {
              setUpdatingSelf(true); setError('');
              try {
                // Resolves just before the process exits; the window closing IS the success signal.
                await updateLauncher();
              } catch (e) {
                setError(String(e));
                setUpdatingSelf(false);
              }
            }}
          >
            {updatingSelf ? 'Updating — this window will close…' : `Update launcher to ${selfUpdate.version}`}
          </button>
        ) : (
          ownVersion && <span className="caption">Launcher {ownVersion}</span>
        )}
      </footer>
    </div>
  );
}
