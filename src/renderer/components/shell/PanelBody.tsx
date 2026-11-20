import React from 'react';
import type { PanelContribution, SelectionSnapshot } from '@artlux/sdk/renderer';

// ─────────────────────────────── THE PANEL MEMO BOUNDARY (W2) ───────────────────────────────
//
// WHY THIS EXISTS. App owns a great deal of state and re-renders often, and the shell (WorkspaceShell /
// DockRenderer) used to render every registry panel's Component inline — so every App render
// re-rendered every visible panel, whatever it read. That is the "central App state re-renders
// everything" cost in the perf notes, and the first thing the multi-window plan has to remove
// (plans/native-engine.md §9a, W2): a panel that will one day live in its own window must already
// re-render only for its own data.
//
// So every place the shell renders a panel's Component goes through this memo. Its props are the
// registry's Component (a stable module-level reference), the context id (a string) and App's
// `editorSelection` (memoized on the selection ids). A panel therefore re-renders when THOSE change,
// or when something it SUBSCRIBES to changes — useEditorPick() fields, a store hook, its own state.
//
// ⚠ THE CONTRACT THIS IMPOSES ON A PANEL: anything it reads during render must be something it
// subscribes to. Reading a service getter in render and relying on the parent to re-render it goes
// stale behind this boundary. (Audited when it landed: the lidar ZonePanel's occupancy icon was the
// one case, and now subscribes to zones.)
type Props = {
  Component: PanelContribution['Component'];
  contextId: string;
  selection: SelectionSnapshot;
};

export const PanelBody = React.memo(function PanelBody({ Component, contextId, selection }: Props) {
  return <Component contextId={contextId} selection={selection} />;
});
