import React from 'react';
import { AlertTriangle, RotateCcw, LifeBuoy } from 'lucide-react';
import {
  reportFault, noteBootFailure, hasPainted, reloadWindow, safeBoot, SHOW_ENGINE, type FaultWindow,
} from '../services/faultReporter';

// The renderer's containment layer. React 19 unmounts the WHOLE tree on an uncaught render throw, and
// `Stage` (the per-frame GPU sampler that publishes `dmx:frame`) lives in that tree — so a crash in any
// panel used to take Art-Net down mid-show. The strategy was 100% prevention (defensive coercion) with
// zero containment. This adds the containment.
//
// Two deployment shapes (both in this file):
//   • PANEL boundaries wrap each swappable panel in WorkspaceShell, so a panel throw shows a small
//     recovery card while Stage — a SIBLING persistent viewport, not a child of the failed panel —
//     keeps running and output never stops. This is the one that protects the show.
//   • A top-level boundary (variant="fatal") wraps <App/> as a last resort: a catastrophic App-level
//     throw shows a recovery screen with Reload instead of a blank renderer.
//
// EVERY caught error is also REPORTED to main (services/faultReporter.ts). Containment alone is not
// enough for an unattended install: a nice recovery card in a window that is 1×1 at opacity 0, in a
// venue with nobody in it, is worth exactly nothing. The report is what lets the watchdog see a white
// screen at all — the process stays alive and responsive through one, so nothing else can.
//
// ⚠ A boundary CANNOT catch a throw in its own parent's render. Nothing wrapped inside App protects
// App's own function body (its memos, its normalize calls, the cue flatMap it does inline). Those are
// contained only by the root boundary plus the coercing normalizers in types.ts. The region
// boundaries do NOT make the load path safe.
//
// Resettable: pass `resetKeys` (e.g. the current selection) and the boundary clears itself when they
// change — a panel that threw on one object often renders fine for the next.

interface Props {
  children: React.ReactNode;
  /** Human label for the failed region, shown in the fallback ("Outputs panel stopped"). */
  label?: string;
  /** Full-screen recovery (for the app root) vs. a compact inline card (for a panel). */
  variant?: 'panel' | 'fatal';
  /**
   * Machine identity for the audit log and the watchdog's relaunch policy. Only 'root' and 'stage'
   * relaunch an armed broadcast install; anything else is contained, so it is logged and left alone.
   * Defaults to 'root' for a fatal boundary, `panel:<label>` otherwise.
   */
  scope?: string;
  /** Set at a plugin render site so the audit log names the culprit. */
  pluginId?: string;
  /** Which window this boundary lives in — the main editor unless stated. */
  faultWindow?: FaultWindow;
  /** When any value here changes, a failed boundary resets and retries. */
  resetKeys?: unknown[];
  /** Render nothing at all on failure (inside an R3F canvas, where a DOM fallback is illegal). */
  silent?: boolean;
}

interface State { error: Error | null; bootFailures: number }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, bootFailures: 0 };

  static getDerivedStateFromError(error: Error): State { return { error, bootFailures: 0 }; }

  private scope(): string {
    return this.props.scope ?? (this.props.variant === 'fatal' ? 'root' : `panel:${this.props.label ?? 'unknown'}`);
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the log loud — this is a real bug to fix, not a handled condition.
    console.error(`[error-boundary${this.props.label ? ' · ' + this.props.label : ''}]`, error, info.componentStack);
    // …and tell main, which is the only process that can do anything about it in an unattended venue.
    reportFault({
      window: this.props.faultWindow ?? 'main',
      scope: this.scope(),
      pluginId: this.props.pluginId,
      message: error?.message || String(error),
      stack: `${error?.stack ?? ''}\n--- component stack ---${info.componentStack ?? ''}`,
    });
    // A root throw BEFORE the first frame is a boot failure: reloading re-runs the same load path and
    // throws again. Count it, so the ladder can escalate to Safe Mode instead of storming.
    // Main window only: the projector and docs windows never heartbeat, so every fault in one would
    // otherwise look like a failed boot and offer Safe Mode, which means nothing there.
    if (this.props.variant === 'fatal' && (this.props.faultWindow ?? 'main') === 'main' && !hasPainted()) {
      this.setState({ bootFailures: noteBootFailure() });
    }
  }

  componentDidUpdate(prev: Props) {
    if (!this.state.error) return;
    const a = prev.resetKeys ?? [], b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) this.reset();
  }

  reset = () => this.setState({ error: null, bootFailures: 0 });

  render() {
    const { error, bootFailures } = this.state;
    if (!error) return this.props.children;
    const label = this.props.label ?? 'This view';

    // No operator is in the room and the window is 1×1 at opacity 0 — a recovery card here would be
    // decoration. The report is already out; main owns the recovery (a full leak-safe relaunch, then
    // the circuit breaker). Render NOTHING, and in particular nothing that keeps a rAF alive: a
    // fallback that kept pushing the heartbeat would suppress render-stall and re-blind the watchdog.
    if (SHOW_ENGINE || this.props.silent) return null;

    if (this.props.variant === 'fatal') {
      // The recovery ladder. Rung 2 (reload) is right when the app ran and then broke. It is WRONG
      // for a load-path throw, where it re-runs the same poison — so a second failed boot escalates
      // to rung 3, Safe Mode, which is the only rung that terminates.
      const escalate = bootFailures >= 2;
      return (
        <div className="fixed inset-0 z-toast flex items-center justify-center bg-black p-8">
          <div className="max-w-lg w-full bg-surface-1 border border-line-2 rounded-lg shadow-e3 p-6">
            <div className="flex items-center gap-2 text-danger mb-3">
              <AlertTriangle size={18} aria-hidden />
              <h1 className="text-sm font-semibold uppercase tracking-wider">ARTLux hit an unexpected error</h1>
            </div>
            <p className="text-fg-2 text-xs mb-4">
              {escalate
                ? 'This project has failed to open twice. Start in Safe Mode to get the app back — it opens empty and leaves your project file on disk exactly as it is.'
                : 'The interface stopped rendering. Your project on disk is untouched. Reload to recover; if it keeps happening, the message below helps track it down.'}
            </p>
            <pre className="text-fg-3 text-micro font-mono bg-surface-0 border border-line-1 rounded-sm p-2 overflow-auto max-h-40 mb-4 whitespace-pre-wrap">
              {error.message || String(error)}
            </pre>
            <div className="flex items-center gap-2">
              {!escalate && (
                <button
                  type="button"
                  onClick={reloadWindow}
                  className="flex items-center gap-2 bg-accent text-black font-medium rounded-md px-3 py-1.5 text-xs"
                >
                  <RotateCcw size={14} aria-hidden /> Reload ARTLux
                </button>
              )}
              <button
                type="button"
                onClick={safeBoot}
                className={escalate
                  ? 'flex items-center gap-2 bg-accent text-black font-medium rounded-md px-3 py-1.5 text-xs'
                  : 'flex items-center gap-2 text-fg-2 border border-line-2 rounded-md px-3 py-1.5 text-xs'}
              >
                <LifeBuoy size={14} aria-hidden /> Start in Safe Mode
              </button>
            </div>
          </div>
        </div>
      );
    }

    // Compact panel fallback — contains the blast radius, keeps Stage alive.
    return (
      <div role="alert" className="m-2 p-3 bg-surface-1 border border-danger/40 rounded-md">
        <div className="flex items-center gap-2 text-danger text-mini font-medium mb-1">
          <AlertTriangle size={13} aria-hidden /> {label} stopped
        </div>
        <p className="text-fg-3 text-micro mb-2">Output is unaffected. Reload just this panel to retry.</p>
        <button
          type="button"
          onClick={this.reset}
          className="flex items-center gap-1.5 text-fg-2 text-micro border border-line-2 rounded-sm px-2 py-1"
        >
          <RotateCcw size={11} aria-hidden /> Reload panel
        </button>
      </div>
    );
  }
}
