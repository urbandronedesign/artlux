import React, { useEffect } from 'react';
import { contextRegistry } from '../../host/registries';
import { layoutStore } from '../../services/layoutStore';
import { goToContext } from '../../contexts/nav';
import { useLayout } from '../../hooks/useLayout';
import { helpBus } from '../../services/helpBus';
import { keymap } from '../../shortcuts/keymapStore';

// The workspace-context switcher: a 48px icon rail down the far left, one button per registered
// WorkspaceContext, grouped into the three clusters (Build / Align / Show) with a rule between them.
//
// It reads the registry + the layout store directly and threads no props — the same pattern the
// preset switcher it replaces used inside the StatusBar. Switching goes through layoutStore.setContext
// so the outgoing context's panel sizes are banked and the incoming one's are restored.
//
// Ctrl+1..9 jumps to the Nth context in rail order; Ctrl+Tab / Ctrl+Shift+Tab cycle. Both are ignored
// while typing so a numeric field in a panel keeps its keystrokes (the same guard App uses for
// Ctrl+A). The rail is the only always-visible switcher, so it must never be the thing that eats a
// number the operator is typing into a universe field.

const CLUSTER_LABEL: Record<string, string> = { build: 'Build', align: 'Align', show: 'Show', app: 'App' };


function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export const ContextRail: React.FC = () => {
  const layout = useLayout();
  const contexts = contextRegistry.all();
  const activeId = layout.activeContext;

  useEffect(() => {
    const go = goToContext;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (isTyping()) return;
      const list = contextRegistry.all();
      // Next / previous workspace — bindings resolve through the keymap (defaults Ctrl+Tab / Ctrl+Shift+Tab).
      const prev = keymap.matches(e, 'global.prevContext');
      if (prev || keymap.matches(e, 'global.nextContext')) {
        const i = list.findIndex((c) => c.id === layoutStore.get().activeContext);
        const next = (i + (prev ? -1 : 1) + list.length) % list.length;
        e.preventDefault();
        go(list[next].id);
        return;
      }
      // Ctrl+1..9 direct context jump stays hardcoded — nine numeric variants of one behaviour, not a
      // per-action binding worth exposing in the editor.
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && list[n - 1]) {
        e.preventDefault();
        go(list[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav
      className="w-12 shrink-0 h-full bg-surface-1 border-r border-line-1 flex flex-col items-center py-1.5 gap-0.5 overflow-y-auto"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Workspace context"
    >
      {contexts.map((c, i) => {
        const active = c.id === activeId;
        // A rule between clusters — drawn before the first item of each cluster after the first.
        const newCluster = i > 0 && contexts[i - 1].cluster !== c.cluster;
        return (
          <React.Fragment key={c.id}>
            {newCluster && <div className="w-6 h-px my-1 bg-line-2 shrink-0" aria-hidden />}
            <button
              role="tab"
              aria-selected={active}
              title={`${c.title} — ${CLUSTER_LABEL[c.cluster] ?? c.cluster}${i < 9 ? `  (Ctrl+${i + 1})` : ''}`}
              onClick={() => goToContext(c.id)}
              onMouseEnter={() => c.hint && helpBus.set(c.hint)}
              onMouseLeave={() => c.hint && helpBus.set(null)}
              className={`w-10 shrink-0 flex flex-col items-center gap-0.5 py-1.5 rounded-sm transition-colors ${
                active ? 'bg-accent/15 text-accent' : 'text-fg-3 hover:text-fg-1 hover:bg-surface-3'
              }`}
            >
              {c.icon}
              <span className="text-micro leading-none truncate max-w-full px-0.5">{c.shortTitle ?? c.title}</span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
};
