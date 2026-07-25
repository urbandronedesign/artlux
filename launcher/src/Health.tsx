// The Health tab: ArtLux's own machine check, rendered as something a human can act on.
//
// The script is the app's preflight.ps1 — one source of truth for what a working machine looks like.
// This adds the two things a PowerShell table cannot: which lines are BLOCKING versus expected, and
// a button for the ones that can be repaired.
//
// The failure this exists to prevent is the one docs/INSTALL.md opens with: every native module
// degrades gracefully, so a half-provisioned machine looks identical to a working one until someone
// reaches for NDI or calibration mid-show.

import { useCallback, useEffect, useState } from 'react';
import { healthCached, healthRepair, healthRun, healthState, type InstallInfo, type PreflightItem, type PreflightReport } from './api';
import { SEVERITY_LABEL, STATUS_COLOR, severityOf, triage, type Severity } from './healthTriage';

const ORDER: Severity[] = ['blocking', 'repairable', 'note', 'expected'];
/** The two things -Fix can actually install. Offering Repair for anything else is a no-op button. */
const REPAIRABLE_IDS = ['vcredist', 'ndi.runtime'];

function Row({ item }: { item: PreflightItem }) {
  const t = triage(item.id);
  return (
    <div className="list-row" style={{ alignItems: 'flex-start' }}>
      {/* Status is a WORD as well as a colour — colour alone is not a signal. */}
      <span className="text-mini fw-semi" style={{ color: STATUS_COLOR[item.status] ?? 'var(--text-2)', flex: '0 0 42px' }}>
        {item.status}
      </span>
      <div className="grow">
        <div className="text-xs">{item.name}</div>
        {item.detail && <div className="text-mini fg-2">{item.detail}</div>}
        {/* Curated framing when we have it; otherwise the script's own remedy, verbatim. */}
        {t ? (
          <div className="caption" style={{ marginTop: 2 }}>{t.plain}</div>
        ) : (
          item.remedy && <div className="caption" style={{ marginTop: 2 }}>{item.remedy}</div>
        )}
      </div>
    </div>
  );
}

export function Health({ install }: { install: InstallInfo | null }) {
  const dir = install?.dir ?? '';
  const [state, setState] = useState<{ available: boolean; winget: boolean; script: string } | null>(null);
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [busy, setBusy] = useState<'' | 'checking' | 'repairing'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [showPassed, setShowPassed] = useState(false);

  useEffect(() => {
    healthState(dir).then(setState);
    healthCached().then((r) => { if (r) setReport(r); });
  }, [dir]);

  const check = useCallback(async () => {
    setBusy('checking'); setError(''); setNote('');
    try { setReport(await healthRun(dir)); }
    catch (e) { setError(String(e)); }
    finally { setBusy(''); }
  }, [dir]);

  const repair = async () => {
    setBusy('repairing'); setError(''); setNote('');
    const before = (report?.results ?? []).filter((r) => r.status === 'FAIL').map((r) => r.id);
    try {
      await healthRepair(dir);
      // NEVER claim success from an exit code we did not read: winget was watched by the user, not
      // by us. Re-measure and diff instead.
      const after = await healthRun(dir);
      setReport(after);
      const stillFailing = after.results.filter((r) => r.status === 'FAIL' && before.includes(r.id));
      setNote(
        stillFailing.length === 0
          ? 'Repair finished and those checks now pass.'
          : `Repair did not change: ${stillFailing.map((r) => r.name).join(', ')}. Install those manually.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy('');
    }
  };

  if (state && !state.available) {
    return (
      <section className="panel">
        <div className="panel-title" style={{ marginBottom: 8 }}>Machine check</div>
        <div className="text-mini fg-2">The check script is not available in this build.</div>
      </section>
    );
  }

  const results = report?.results ?? [];
  const failing = results.filter((r) => r.status === 'FAIL');
  const canRepair = !!state?.winget && failing.some((r) => REPAIRABLE_IDS.includes(r.id));
  const notable = results.filter((r) => r.status === 'FAIL' || r.status === 'WARN');
  const quiet = results.filter((r) => r.status === 'PASS' || r.status === 'SKIP');

  const groups = ORDER.map((sev) => ({
    sev,
    items: notable.filter((r) => severityOf(r.id, r.status) === sev),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <section className="panel">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="panel-title">Machine check</span>
          <span className="grow" />
          <button className="btn" onClick={check} disabled={!!busy}>
            {busy === 'checking' ? 'Checking…' : report ? 'Re-check' : 'Check this machine'}
          </button>
          {canRepair && (
            <button className="btn btn-primary" onClick={repair} disabled={!!busy}>
              {busy === 'repairing' ? 'Repairing…' : 'Repair'}
            </button>
          )}
        </div>
        {report ? (
          <div className="caption">
            {report.summary.pass} passed · {report.summary.warn} warnings · {report.summary.fail} failures
            {report.generated_at && ` · ${new Date(report.generated_at).toLocaleString()}`}
            {report.from === 'cache' && ' · from the last saved report, not a fresh run'}
          </div>
        ) : (
          <div className="caption">
            Checks the GPU, the runtimes ArtLux needs, the network profile, firewall rules and the ports it binds.
          </div>
        )}
        {canRepair && (
          <div className="caption" style={{ marginTop: 8 }}>
            Repair opens an elevated window and installs the missing runtimes with winget. You will see its progress.
          </div>
        )}
        {failing.length > 0 && !state?.winget && (
          <div className="caption" style={{ marginTop: 8 }}>
            winget is not available on this machine, so the missing runtimes must be installed by hand.
          </div>
        )}
      </section>

      {groups.map((g) => (
        <section key={g.sev} className={'panel' + (g.sev === 'blocking' ? ' panel-danger' : '')}>
          <div className="section-label" style={{ marginBottom: 6 }}>{SEVERITY_LABEL[g.sev]}</div>
          {g.items.map((it) => <Row key={it.id} item={it} />)}
        </section>
      ))}

      {report && notable.length === 0 && (
        <section className="panel panel-ok panel-tight">
          <div className="text-mini fw-semi" style={{ color: 'var(--ok)' }}>✓ Nothing to fix on this machine.</div>
        </section>
      )}

      {quiet.length > 0 && (
        <section className="panel">
          <button className="btn btn-ghost" style={{ padding: 0 }} aria-expanded={showPassed} onClick={() => setShowPassed((v) => !v)}>
            <span className="section-label">{showPassed ? '▾' : '▸'} {quiet.length} checks passed or not applicable</span>
          </button>
          {showPassed && <div style={{ marginTop: 8 }}>{quiet.map((it) => <Row key={it.id} item={it} />)}</div>}
        </section>
      )}

      {note && <section className="panel panel-tight"><div className="text-mini fg-2">{note}</div></section>}
      {error && (
        <section className="panel panel-danger panel-tight">
          <div className="text-mini fw-semi" style={{ color: 'var(--danger)' }}>✕ {error}</div>
        </section>
      )}
    </>
  );
}
