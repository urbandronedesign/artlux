import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { setHostLinkRole } from './state/hostLink';
import { liveClient } from './live/client';
import { PanelEditorStore } from './live/panelStore';
import { DETACHABLE_PANELS } from './contexts/detachable';
import { PanelBody } from './components/shell/PanelBody';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FeedbackProvider } from './components/ui/feedback';
import { installGlobalNet } from './services/faultReporter';
import { useEditorPick } from './state/EditorStore';
import { appliesToSelection, panelRegistry } from './host/registries';
import { DockRenderer } from './components/shell/DockRenderer';
import { CollapsibleSection } from './components/CollapsibleSection';
import { DOCK_TREE_VERSION, closePanel, findGroupOf, panelIds, sanitizeDockTree, setActive, type DockTree } from './services/dockTree';
import type { PanelContribution, SelectionSnapshot } from '@artlux/sdk/renderer';
import { ExternalLink } from 'lucide-react';
import { keymap } from './shortcuts/keymapStore';
import { activatePluginUi } from './host/pluginUi';
import { setCameraAccess } from './services/cameraAccess';
import { remoteCameraAccess } from './live/cameraRemote';
import { remotePluginLive } from './live/pluginLiveRemote';
import { remoteUiHost } from './live/uiHostRemote';
import { setDmxFeed } from './services/dmxFeed';
import { remoteDmxFeed } from './live/dmxRemote';
import { setEditorHealth } from './services/editorHealth';
import { remoteEditorHealth } from './live/healthRemote';
import { installSceneRemote } from './live/sceneRemote';
import { installOscRemote } from './live/oscRemote';
import { installTakesRemote } from './live/takesRemote';
import { layoutStore, disableLayoutPersistence, LAYOUT_PREF_KEY } from './services/layoutStore';
import { markPanelWindow } from './services/windowRole';

// A PANEL WINDOW (E5/W5) — `panel.html?panel=<id>`, opened by main/panelWindows.ts. It opens on that one
// panel and is a dock tree of its own (W5b-2): more detachable panels can join it as tabs, stacks or splits.
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
markPanelWindow();
installGlobalNet('panel');
// The editor's saved workbench is the EDITOR's to write (services/layoutStore): this window reads it
// once, so a panel opens with the operator's choices (the media library's view…), and never writes it.
disableLayoutPersistence();
window.artlux?.getPrefs?.().then((p) => layoutStore.hydrate((p as unknown as Record<string, never> | null)?.[LAYOUT_PREF_KEY])).catch(() => {});

const panelId = new URLSearchParams(location.search).get('panel') ?? '';
liveClient.connect(`panel:${panelId}`);
// THIS WINDOW'S REGISTRY holds exactly the panels allowed out, so the dock tree's "+" menu offers those
// and nothing else (W5b-2: a window is a dock tree of its own — tabs, stacks and splits).
for (const p of DETACHABLE_PANELS) panelRegistry.register(p);
// The plugins' UI halves — what the content editor shows for their source types, and the plugins'
// detachable panels (the OSC, Augmenta and Pose monitors, Trigger Zones) — and nothing of their runtimes
// (host/pluginUi.ts). What those panels show of a runtime comes from the editor (`live`), their host
// reads and writes go through this window's replica and the editor (live/uiHostRemote.ts). And the
// camera inspector asks the editor, which runs the capture.
activatePluginUi('panel', remotePluginLive, remoteUiHost);
setCameraAccess(remoteCameraAccess);
// The monitors read the editor's output, render loop and clocks (services/dmxFeed, services/editorHealth).
setDmxFeed(remoteDmxFeed);
setEditorHealth(remoteEditorHealth);
// …and the 3D scene's side panels read the editor's 3D view (its models' named screens, its camera).
installSceneRemote();
// …and the state graph's OSC learn, sender list and "edit this state's timeline" go to the editor.
installOscRemote();
// …and the takes docks drive the editor's recorder (and read their sparklines from it).
installTakesRemote();
// Looked up AFTER the UI halves registered theirs. Only a detachable one: the registry is the whole list.
const panel = ((p) => (p?.detachable ? p : undefined))(panelRegistry.get(panelId));
const titleFor = (ids: string[]) =>
  `${ids.map((id) => panelRegistry.get(id)?.title ?? id).join(' · ') || 'Panel'} — ARTLux`;
if (panel) document.title = titleFor([panel.id]);

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

// ── WHAT ONE PANEL LOOKS LIKE HERE ───────────────────────────────────────────────────────────────
const KINDS: Record<string, string> = { surface: 'a surface', fixture: 'a fixture', 'fixture.pixel': 'an LED fixture', 'fixture.light': 'a light fixture', model: 'a 3D model' };

/** The body, gated like the shell gates it — but a section that does not apply SAYS what to select. */
const Body: React.FC<{ panel: PanelContribution; selection: SelectionSnapshot }> = ({ panel: p, selection }) => {
  if (!appliesToSelection(p, selection)) {
    return <Waiting text={`Select ${(p.appliesTo ?? []).map((k) => KINDS[k] ?? k).join(' or ')} to see ${p.title ?? 'this'}.`} />;
  }
  return (
    <ErrorBoundary variant="panel" label={p.title ?? p.id} faultWindow="panel">
      {/* Full height for everything but a parameter section, as the editor's tab body gives it: a dock
          panel sized `h-full` (the Trigger Zones map, a monitor) otherwise resolves to 0 here and draws
          nothing — found by test-panel-window step 13, where the zone map's canvas never painted. */}
      <div className={p.mount === 'inspector' ? 'p-3 space-y-3' : 'h-full'}>
        <PanelBody Component={p.Component} contextId="window" selection={selection} />
      </div>
    </ErrorBoundary>
  );
};

/** A tab's body: the panel's own header buttons (Add Fixture, …) and the way back, then the panel. */
const TabBody: React.FC<{ panel: PanelContribution; selection: SelectionSnapshot; onDockBack: (id: string) => void }> = ({ panel: p, selection, onDockBack }) => {
  const Actions = p.HeaderActions;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 h-6 px-2 flex items-center justify-end gap-1.5 border-b border-line-1 text-fg-2">
        {Actions && <Actions contextId="window" selection={selection} />}
        <button className="text-fg-2 hover:text-fg-1" title="Back to the editor" onClick={() => onDockBack(p.id)}>
          <ExternalLink size={12} className="rotate-180" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto"><Body panel={p} selection={selection} /></div>
    </div>
  );
};

/** A stacked panel's section chrome (a saved tree may hold a stack), plus the way back to the editor. */
const Section: React.FC<{ panel: PanelContribution; selection: SelectionSnapshot; onDockBack: (id: string) => void }> = ({ panel: p, selection, onDockBack }) => {
  if (p.bare) return <div className={p.grow ? 'flex-1 min-h-0 overflow-hidden' : 'shrink-0'}><Body panel={p} selection={selection} /></div>;
  const Actions = p.HeaderActions;
  return (
    <CollapsibleSection
      title={p.title ?? p.id}
      icon={p.icon}
      defaultOpen
      grow={p.grow}
      action={(
        <span className="inline-flex items-center gap-1.5">
          {Actions && <Actions contextId="window" selection={selection} />}
          <button className="text-fg-2 hover:text-fg-1" title="Back to the editor"
            onClick={(e) => { e.stopPropagation(); onDockBack(p.id); }}>
            <ExternalLink size={12} className="rotate-180" />
          </button>
        </span>
      )}
      bodyClassName="bg-surface-1"
    >
      <Body panel={p} selection={selection} />
    </CollapsibleSection>
  );
};

// ── THE WINDOW'S OWN WORKBENCH (W5b-2) ───────────────────────────────────────────────────────────
// The SAME DockRenderer the editor's workbench uses, over a tree of this window's own: drag a tab to
// split, right-click for the moves, "+" to add another detachable panel, close a tab. The tree is
// saved per window by main (it comes back with the window); a window left with no panel closes.
const initialTree = (): DockTree => ({
  v: DOCK_TREE_VERSION,
  root: {
    kind: 'group', id: 'w1', panelIds: [panelId], activeId: panelId,
    // TABS, even for a browser or parameter panel: a tabbed group is the one with the "+" (add a panel)
    // and the tab menu (split, move, back to the editor). A stack has neither, so a window opened as a
    // stack could never become more than the one panel. The panel's header buttons ride in TabBody.
    render: 'tabs',
    region: panel?.mount === 'inspector' ? 'inspector' : panel?.mount === 'browser' ? 'browser' : 'dock',
  },
  removed: [],
  meta: { viewport: '' },
});
/** A saved tree, minus any panel this build does not let out (a renamed or retired id). */
function restore(saved: unknown): DockTree | null {
  let t = sanitizeDockTree(saved);
  if (!t) return null;
  for (const id of panelIds(t)) if (!panelRegistry.get(id)?.detachable) t = closePanel(t, id);
  return panelIds(t).length ? t : null;
}

const Workbench: React.FC = () => {
  // The selection is what the shell hands every panel; here it comes from the replica like everything else.
  const { selection } = useEditorPick('selection');
  const [tree, setTree] = React.useState<DockTree | null>(null);
  const treeRef = React.useRef<DockTree | null>(null);
  treeRef.current = tree;

  const commit = React.useCallback((next: DockTree) => {
    const ids = panelIds(next);
    // ⚠ A WINDOW'S LAST PANEL. A dock tree is never empty — closePanel on the last panel keeps the old
    // root and only records the panel as closed (services/dockTree finish()) — so "nothing left" shows
    // up as every remaining panel being one that was just closed. That is how a window's last tab goes:
    // its close button, Back to the editor, or dragged into another window. Without this, all three
    // left the window open on a panel the operator had just sent away (found by test-panel-window
    // step 20, E5/W5l — the earlier steps only ever removed a tab from a window that had two).
    const closedYetShown = ids.filter((id) => next.removed.includes(id));
    if (!ids.length || closedYetShown.length === ids.length) { window.close(); return; }
    setTree(next);
    document.title = titleFor(ids);
    window.artlux?.panelWindowTree?.(next);
  }, []);

  React.useEffect(() => {
    let alive = true;
    const start = (saved: unknown) => { if (alive) commit(restore(saved) ?? initialTree()); };
    if (window.artlux?.panelWindowState) window.artlux.panelWindowState().then((st) => start(st?.tree)).catch(() => start(null));
    else start(null);
    return () => { alive = false; };
  }, [commit]);

  // Asked for again from the editor while already here: bring its tab to the front.
  React.useEffect(() => window.artlux?.onPanelWindowReveal?.((id) => {
    const t = treeRef.current;
    const g = t && findGroupOf(t, id);
    if (t && g) commit(setActive(t, g.id, id));
  }), [commit]);

  // "Back to the editor": the editor puts it in its workbench (services/dockBack), this window lets go.
  const dockBack = React.useCallback((id: string) => {
    liveClient.action('dockPanel', [id]).catch((e: Error) => console.warn('[panel] dock back failed:', e.message));
    const t = treeRef.current;
    if (t) commit(closePanel(t, id));
  }, [commit]);

  if (!tree) return null;
  return (
    <div className="h-full flex flex-col bg-surface-1 text-fg-1 font-sans">
      <DockRenderer tree={tree} ctx={{
        contextId: 'window',
        selection,
        persistentIds: [],
        renderPanel: (p) => <Section panel={p} selection={selection} onDockBack={dockBack} />,
        renderTabBody: (p) => <TabBody panel={p} selection={selection} onDockBack={dockBack} />,
        onTree: commit,
        manifest: { id: 'window', viewport: '', dock: panelIds(tree) },
        defaults: {},
        keepInapplicable: true,
        onDockBack: dockBack,
      }} />
    </div>
  );
};

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <ErrorBoundary scope="panel-root" faultWindow="panel" label="Panel window">
      {/* The editor's toasts and in-app confirm/prompt dialogs, in THIS window: a panel that asks "replace
          this shader?" asks where the operator is looking. Without it, useConfirm() throws and the
          whole window falls to its error boundary (found by test-panel-window step 12, Shader). */}
      <FeedbackProvider>
        {panel
          ? <PanelEditorStore fallback={<Connecting />}><Workbench /></PanelEditorStore>
          : <Waiting text={`"${panelId}" cannot open in its own window.`} />}
      </FeedbackProvider>
    </ErrorBoundary>,
  );
}
