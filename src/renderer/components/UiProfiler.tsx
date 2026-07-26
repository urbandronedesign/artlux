import React, { Profiler } from 'react';
import { UI_PROFILING_ENABLED, uiPerfMonitor } from '../services/uiPerfMonitor';

// A named measurement point for React commit cost, reported into services/uiPerfMonitor.
//
// Wrap a region whose re-render cost you want attributed by name; the Performance dock tab lists
// them heaviest-first. React's <Profiler> measures the whole subtree beneath it, so wrapping the
// persistent viewports answers the question the engine-decoupling work actually asks: does an
// unrelated App re-render reconcile Stage / the 3D scene / the timeline, and what does that cost?
//
// THE BRANCH BELOW IS ON A MODULE CONSTANT, AND MUST STAY ONE.
// React identifies a child by its position AND element type. If `UI_PROFILING_ENABLED` could change
// while the app runs, this component would swap between "<Profiler> wrapping children" and "children
// alone" — a different element type at the same position — and React would unmount and rebuild the
// entire subtree. The subtrees here are Stage (which publishes dmx:frame → Art-Net), Simulator3D
// (one WebGL context, GLBs loaded) and TimelinePanel (one keyboard hook, one engine subscription).
// A debug switch must not be able to stop the output mid-show, so there is no switch: set
// `?uiperf=1` or localStorage['artlux.uiPerf']='1' and reload. `verify:invariants` guards this —
// no state, no props, no runtime flip.
//
// Disabled (the default), this is one extra fiber that returns its children untouched: no Profiler,
// no timing, no subscription, nothing per frame.

interface Props {
  /** Stable, human-readable region name — it is what the Performance panel and Prometheus report. */
  id: string;
  children: React.ReactNode;
}

const record = (id: string, _phase: unknown, actualDuration: number): void => {
  uiPerfMonitor.noteCommit(id, actualDuration);
};

export const UiProfiler: React.FC<Props> = ({ id, children }) => {
  if (!UI_PROFILING_ENABLED) return <>{children}</>;
  return <Profiler id={id} onRender={record}>{children}</Profiler>;
};

export default UiProfiler;
