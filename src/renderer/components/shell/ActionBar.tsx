import React from 'react';
import type { ContextAction, SelectionSnapshot, WorkspaceContext } from '@artlux/sdk/renderer';
import type { WorkspaceLayout } from '../../services/layoutStore';
import { useEditorActions } from '../../state/EditorStore';
import { helpBus } from '../../services/helpBus';

// The active context's FUNCTIONS, as one horizontal bar under the menu bar: context title on the
// left, then the context's actions grouped with a rule between groups.
//
// An action either names a host `menuAction` (reusing the ~30 functions already wired through App's
// dispatchMenu — open, save-as, routing, preferences, collect-assets…) or carries its own `run()`.
// Both go through the stable actions facade, so this bar re-renders only when the context or the
// selection changes, never when the rig state moves underneath it.

interface Props {
  context: WorkspaceContext<WorkspaceLayout>;
  selection: SelectionSnapshot;
}

const ActionButton: React.FC<{ action: ContextAction; selection: SelectionSnapshot }> = ({ action, selection }) => {
  const actions = useEditorActions();
  const enabled = action.enabled ? action.enabled(selection) : true;
  const run = () => {
    if (action.run) action.run();
    else if (action.menuAction) actions.menuAction(action.menuAction);
  };
  return (
    <button
      onClick={run}
      disabled={!enabled}
      title={action.shortcut ? `${action.label} (${action.shortcut})` : action.label}
      onMouseLeave={() => helpBus.set(null)}
      className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-sm text-mini whitespace-nowrap transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        action.danger ? 'text-fg-2 hover:text-danger hover:bg-surface-3' : 'text-fg-2 hover:text-fg-1 hover:bg-surface-3'
      }`}
    >
      {action.icon}
      {action.label}
    </button>
  );
};

export const ActionBar: React.FC<Props> = ({ context, selection }) => {
  const actions = context.actions ?? [];
  // Group in declaration order — a group's position is where its first action appeared, so a plugin
  // appending actions to a context it doesn't own lands its own group at the end rather than
  // interleaving into someone else's.
  const groups: { name: string; items: ContextAction[] }[] = [];
  for (const a of actions) {
    const name = a.group ?? '';
    const g = groups.find((x) => x.name === name);
    if (g) g.items.push(a);
    else groups.push({ name, items: [a] });
  }

  return (
    <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-line-1 bg-surface-2 overflow-x-auto">
      <div className="flex items-center gap-1.5 shrink-0 pr-2 text-fg-1">
        {context.icon}
        <span className="text-xs font-medium whitespace-nowrap">{context.title}</span>
      </div>
      {groups.map((g, i) => (
        <React.Fragment key={g.name || `g${i}`}>
          <div className="h-4 w-px bg-line-2 shrink-0" aria-hidden />
          <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label={g.name || context.title}>
            {g.items.map((a) => <ActionButton key={a.id} action={a} selection={selection} />)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
