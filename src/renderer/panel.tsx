import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { setHostLinkRole } from './state/hostLink';
import { liveClient } from './live/client';
import { PanelEditorStore } from './live/panelStore';
import { DETACHABLE_PANELS } from './contexts/detachable';
import { PanelBody } from './components/shell/PanelBody';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalNet } from './services/faultReporter';
import { useEditorPick } from './state/EditorStore';

// A PANEL IN ITS OWN WINDOW (E5/W5) — `panel.html?panel=<id>`, opened by main/panelWindows.ts.
//
// This window is a CLIENT and produces nothing (plans/native-engine.md §9a): it reads the document from
// its own read-only Show Host replica, the rest of the editor's state and every edit go through the live
// channel to the editor (live/panelStore.tsx). It mounts the SAME panel component the editor docks, from
// the one list of panels allowed out (contexts/detachable.tsx) — and that list, and this file's whole
// import graph, is checked by verify:invariants to contain no transport, engine, decoder or GPU code.
//
// A fault here is audited as an auxiliary window ('panel'): it can never relaunch the show.

// Before the Show Host port can arrive (it is relayed after this module's imports have all run): this
// window's replica is read-only and must never hand the host its empty defaults.
setHostLinkRole('panel');
installGlobalNet('panel');

const panelId = new URLSearchParams(location.search).get('panel') ?? '';
const panel = DETACHABLE_PANELS.find((p) => p.id === panelId);
liveClient.connect(`panel:${panelId}`);
if (panel) document.title = `${panel.title ?? panel.id} — ARTLux`;

const Waiting: React.FC<{ text: string }> = ({ text }) => (
  <div className="h-full flex items-center justify-center text-micro text-fg-3 bg-surface-1">{text}</div>
);

// The panel's own chrome, as the shell draws a section header (WorkspaceShell): icon, title, and the
// panel's header buttons. A window frame already names it, so there is no collapse toggle.
const PanelFrame: React.FC = () => {
  // The selection is what the shell hands every panel; here it comes from the replica like everything else.
  const { selection } = useEditorPick('selection');
  if (!panel) return null;
  const Actions = panel.HeaderActions;
  const contextId = 'window';
  return (
    <div className="h-full flex flex-col bg-surface-1 text-fg-1 font-sans">
      {!panel.bare && (
        <div className="shrink-0 h-7 px-2 flex items-center gap-1.5 border-b border-line-1 text-micro text-fg-2">
          {panel.icon}
          <span className="truncate flex-1">{panel.title ?? panel.id}</span>
          {Actions && <Actions contextId={contextId} selection={selection} />}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        <ErrorBoundary variant="panel" label={panel.title ?? panel.id} faultWindow="panel">
          <PanelBody Component={panel.Component} contextId={contextId} selection={selection} />
        </ErrorBoundary>
      </div>
    </div>
  );
};

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary scope="panel-root" faultWindow="panel" label="Panel window">
      {panel
        ? <PanelEditorStore fallback={<Waiting text="Connecting to the editor…" />}><PanelFrame /></PanelEditorStore>
        : <Waiting text={`"${panelId}" cannot open in its own window.`} />}
    </ErrorBoundary>,
  );
}
