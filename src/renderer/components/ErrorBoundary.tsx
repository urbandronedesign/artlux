import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

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
// Resettable: pass `resetKeys` (e.g. the current selection) and the boundary clears itself when they
// change — a panel that threw on one object often renders fine for the next.

interface Props {
  children: React.ReactNode;
  /** Human label for the failed region, shown in the fallback ("Outputs panel stopped"). */
  label?: string;
  /** Full-screen recovery (for the app root) vs. a compact inline card (for a panel). */
  variant?: 'panel' | 'fatal';
  /** When any value here changes, a failed boundary resets and retries. */
  resetKeys?: unknown[];
}

interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Keep the log loud — this is a real bug to fix, not a handled condition.
    console.error(`[error-boundary${this.props.label ? ' · ' + this.props.label : ''}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (!this.state.error) return;
    const a = prev.resetKeys ?? [], b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) this.reset();
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const label = this.props.label ?? 'This view';

    if (this.props.variant === 'fatal') {
      return (
        <div className="fixed inset-0 z-toast flex items-center justify-center bg-black p-8">
          <div className="max-w-lg w-full bg-surface-1 border border-line-2 rounded-lg shadow-e3 p-6">
            <div className="flex items-center gap-2 text-danger mb-3">
              <AlertTriangle size={18} aria-hidden />
              <h1 className="text-sm font-semibold uppercase tracking-wider">ArtLux hit an unexpected error</h1>
            </div>
            <p className="text-fg-2 text-xs mb-4">
              The interface stopped rendering. Your project on disk is untouched. Reload to recover; if it
              keeps happening, the message below helps track it down.
            </p>
            <pre className="text-fg-3 text-micro font-mono bg-surface-0 border border-line-1 rounded-sm p-2 overflow-auto max-h-40 mb-4 whitespace-pre-wrap">
              {error.message || String(error)}
            </pre>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex items-center gap-2 bg-accent text-black font-medium rounded-md px-3 py-1.5 text-xs"
            >
              <RotateCcw size={14} aria-hidden /> Reload ArtLux
            </button>
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
