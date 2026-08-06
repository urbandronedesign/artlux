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
// Both go through the stable actions facade, so the bar re-renders only when the context or the
// selection changes, never when the rig state moves underneath it.
//
// The one exception is an action with a `live` channel (a recorder's REC state): it subscribes, so a
// start or a stop re-renders THAT BUTTON alone. The bar itself still does not move.

interface Props {
  context: WorkspaceContext<WorkspaceLayout>;
  selection: SelectionSnapshot;
}

// The shared shell of a bar button. `live` supplies the run-time overrides; without one, everything
// below is just the declared action.
const ButtonShell: React.FC<{
  action: ContextAction; enabled: boolean; label: string; active?: boolean;
  clockRef?: React.Ref<HTMLSpanElement>;
}> = ({ action, enabled, label, active, clockRef }) => {
  const actions = useEditorActions();
  const run = () => {
    if (action.run) action.run();
    else if (action.menuAction) actions.menuAction(action.menuAction);
  };
  return (
    <button
      onClick={run}
      disabled={!enabled}
      title={action.shortcut ? `${label} (${action.shortcut})` : label}
      onMouseLeave={() => helpBus.set(null)}
      className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-sm text-mini whitespace-nowrap transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        active ? 'text-danger bg-danger/15 ring-1 ring-danger/50'
          : action.danger ? 'text-fg-2 hover:text-danger hover:bg-surface-3' : 'text-fg-2 hover:text-fg-1 hover:bg-surface-3'
      }`}
    >
      {action.icon}
      {label}
      {/* The clock is written straight into this node by an interval — it is never React state. */}
      {clockRef && <span ref={clockRef} className="tabular-nums" aria-hidden />}
    </button>
  );
};

const ActionButton: React.FC<{ action: ContextAction; selection: SelectionSnapshot }> = ({ action, selection }) => (
  <ButtonShell action={action} enabled={action.enabled ? action.enabled(selection) : true} label={action.label} />
);

// An action carrying run-time state (see ContextActionLive). Two channels, deliberately separate:
//
//   · WHAT IT IS — active/label/enabled — through useSyncExternalStore, so a start or a stop re-renders
//     THIS BUTTON and nothing else on the bar. It also means `enabled` is finally re-evaluated while the
//     app runs: `record-take` used to disable itself mid-recording when the operator deselected, because
//     its enabled() asked for a fixture selection and nothing ever re-ran it.
//   · HOW LONG — through a 200 ms interval writing `textContent` on a ref. At 5 Hz through React this
//     would re-render the action bar for the length of the take, for a string of five characters.
//     Same discipline as StatusBar's ShowStateChip.
const LiveActionButton: React.FC<{ action: ContextAction; selection: SelectionSnapshot }> = ({ action, selection }) => {
  const live = action.live!;
  const state = React.useSyncExternalStore(live.subscribe, live.get);
  const clockRef = React.useRef<HTMLSpanElement>(null);

  // Checked ONCE per mount, not per render — a fresh object from get() would loop
  // useSyncExternalStore forever, and a frozen window is a miserable way to discover that.
  React.useEffect(() => {
    if (live.get() !== live.get()) {
      console.error(`[action-bar] live.get() for '${action.id}' returns a new object each call. It must return a cached reference (see ContextActionLive) or this bar re-renders forever.`);
    }
  }, [live, action.id]);

  React.useEffect(() => {
    if (!state.active || !live.text) { if (clockRef.current) clockRef.current.textContent = ''; return; }
    const tick = () => { if (clockRef.current) clockRef.current.textContent = live.text!(); };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [state.active, live]);

  // `live.enabled` wins when present — only it can see run-time state, and it is what lets a recorder
  // say "…but you can always stop what is already running".
  const enabled = state.enabled ?? (action.enabled ? action.enabled(selection) : true);
  return (
    <ButtonShell action={action} enabled={enabled} label={state.label ?? action.label} active={state.active} clockRef={clockRef} />
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
            {/* Branching on `a.live` is stable per action id — an action does not gain or lose its live
                channel at run time — so this never swaps a component type under a mounted hook. */}
            {g.items.map((a) => (a.live
              ? <LiveActionButton key={a.id} action={a} selection={selection} />
              : <ActionButton key={a.id} action={a} selection={selection} />))}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};
