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
import { appliesToSelection } from './host/registries';
import { keymap } from './shortcuts/keymapStore';

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

const Waiting: React.FC<{ text: string; detail?: string }> = ({ text, detail }) => (
  <div className="h-full flex flex-col items-center justify-center gap-1 px-6 text-center text-micro text-fg-3 bg-surface-1">
    <span>{text}</span>
    {detail && <span className="text-fg-3/80">{detail}</span>}
  </div>
);

// ── KEYS (E5/W5) ─────────────────────────────────────────────────────────────────────────────────
// The editor's keyboard handlers live in the editor, so a window has to forward the ones that mean the
// same thing everywhere: Undo / Redo (renderer-owned on purpose — main/menu.ts passes them through
// without registering them), Save, and the transport's Play / pause. Each becomes the editor's own
// action, so it does exactly what the key does there. Save is here because a panel window has no
// application menu (main/panelWindows.ts removes it), so the editor's Ctrl+S accelerator is not there.
// The operator's rebindings are honoured: the keymap is hydrated from the same prefs the editor reads.
window.artlux?.getPrefs?.().then((p) => keymap.hydrate((p as { shortcuts?: Record<string, string[]> } | null)?.shortcuts)).catch(() => {});
const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type);
  return false;
};
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const run = (name: string, args: unknown[] = []) => {
    e.preventDefault();
    liveClient.action(name, args).catch((err: Error) => console.warn(`[panel] ${name} failed:`, err.message));
  };
  // Save answers while typing too, as the editor's menu accelerator does.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { run('menuAction', ['save']); return; }
  if (typing(e.target)) return;
  if (keymap.matches(e, 'global.undo')) run('menuAction', ['undo']);
  else if (keymap.matches(e, 'global.redo')) run('menuAction', ['redo']);
  else if (keymap.matches(e, 'timeline.togglePlay')) run('togglePlay');
});

// NO SHOW HOST, NO DOCUMENT. A panel window's document IS its Show Host replica; when the host is off
// (ARTLUX_NO_SHOW_HOST=1) or main gave up restarting it, there is nothing to show — so say so, rather
// than "Connecting…" forever. Shown after a grace period; it disappears by itself if the host arrives.
const NO_HOST_AFTER_MS = 8000;
const Connecting: React.FC = () => {
  const [late, setLate] = React.useState(false);
  React.useEffect(() => { const t = setTimeout(() => setLate(true), NO_HOST_AFTER_MS); return () => clearTimeout(t); }, []);
  return late
    ? <Waiting text="This window cannot show the project right now."
        detail="Panel windows read the project from the Show Host, which is not running. Use the panel in the editor; this window comes back to life on its own if the host starts again." />
    : <Waiting text="Connecting to the editor…" />;
};

// The panel's own chrome, as the shell draws a section header (WorkspaceShell): icon, title, and the
// panel's header buttons. A window frame already names it, so there is no collapse toggle.
const PanelFrame: React.FC = () => {
  // The selection is what the shell hands every panel; here it comes from the replica like everything else.
  const { selection } = useEditorPick('selection');
  if (!panel) return null;
  const Actions = panel.HeaderActions;
  const contextId = 'window';
  // A parameter section shows only for its kind of selection, docked or not (the shell's appliesTo
  // filter). In its own window it stays open and says what to select instead of going blank.
  const applies = appliesToSelection(panel, selection);
  const kinds: Record<string, string> = { surface: 'a surface', fixture: 'a fixture', 'fixture.pixel': 'an LED fixture', 'fixture.light': 'a light fixture', model: 'a 3D model' };
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
        {applies ? (
          <ErrorBoundary variant="panel" label={panel.title ?? panel.id} faultWindow="panel">
            <div className={panel.mount === 'inspector' ? 'p-3 space-y-3' : undefined}>
              <PanelBody Component={panel.Component} contextId={contextId} selection={selection} />
            </div>
          </ErrorBoundary>
        ) : (
          <Waiting text={`Select ${(panel.appliesTo ?? []).map((k) => kinds[k] ?? k).join(' or ')} to see ${panel.title ?? 'this'}.`} />
        )}
      </div>
    </div>
  );
};

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary scope="panel-root" faultWindow="panel" label="Panel window">
      {panel
        ? <PanelEditorStore fallback={<Connecting />}><PanelFrame /></PanelEditorStore>
        : <Waiting text={`"${panelId}" cannot open in its own window.`} />}
    </ErrorBoundary>,
  );
}
