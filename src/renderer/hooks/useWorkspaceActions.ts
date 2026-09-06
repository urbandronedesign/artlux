import React from 'react';
import { nextNumberedName } from '@artlux/sdk/renderer';
import { workspaceStore, type SavedWorkspace, type WorkspacesState } from '../services/workspaceStore';
import { useToast, useConfirm, usePrompt } from '../components/ui';

// The named-workspace verbs, with their feedback attached — ONE implementation for the three places
// that offer them (the title-bar chip, the command palette, Preferences ▸ Appearance). Plan:
// plans/named-workspaces.md.
//
// It exists because the interesting half of each verb is what it TELLS the operator, and that half is
// exactly what three copies would get inconsistently right. Switching a workspace that came off
// another machine can silently do two things — fall back to a different workbench, or drop a dock
// arrangement this build cannot read — and both of those are worth a sentence, once.

export interface WorkspaceActions {
  state: WorkspacesState;
  list: SavedWorkspace[];
  active?: SavedWorkspace;
  switchTo: (id: string) => void;
  saveAs: () => Promise<void>;
  rename: (id: string) => Promise<void>;
  duplicate: (id: string) => void;
  toggleLock: (id: string) => void;
  reset: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportAll: (ids?: string[]) => Promise<void>;
  importFile: () => Promise<void>;
}

export function useWorkspaceActions(): WorkspaceActions {
  const toast = useToast();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const state = React.useSyncExternalStore(workspaceStore.subscribe, workspaceStore.get);

  return React.useMemo<WorkspaceActions>(() => {
    const active = state.items.find((w) => w.id === state.activeId);

    /** What this machine could not honour. Silence here is what makes a shared workspace mystifying. */
    const reportApply = (name: string, dropped: number, fellBack: boolean): void => {
      const notes: string[] = [];
      if (dropped) notes.push(`${dropped} workbench${dropped > 1 ? 'es' : ''} will use the shipped arrangement (saved by a different build)`);
      if (fellBack) notes.push('the workbench it opens on is not available here, so it opened on the default one');
      if (notes.length) toast.info(`Workspace “${name}”`, notes.join('. ') + '.');
    };

    return {
      state,
      list: state.items,
      active,

      switchTo: (id) => {
        const w = state.items.find((x) => x.id === id);
        const prepared = workspaceStore.switchTo(id);
        if (w && prepared) reportApply(w.name, prepared.droppedTrees.length, prepared.fellBackContext);
      },

      saveAs: async () => {
        const name = await prompt({
          title: 'Save workspace',
          message: 'Saves the arrangement of EVERY workbench — panels, columns, tabs and which one opens first.',
          // Not `items.length + 1`: delete “Workspace 1” out of two and the count proposes
          // “Workspace 2”, which is already on screen. One door for numbered defaults, app-wide.
          initial: nextNumberedName('Workspace', state.items),
          placeholder: 'Patch day, Programming, Show night…',
          confirmLabel: 'Save',
        });
        if (!name) return;
        const w = workspaceStore.saveAs(name);
        toast.success(`Workspace “${w.name}” saved`, 'Changes you make now are kept in it automatically.');
      },

      rename: async (id) => {
        const w = state.items.find((x) => x.id === id);
        if (!w) return;
        const name = await prompt({ title: 'Rename workspace', initial: w.name, confirmLabel: 'Rename' });
        if (!name) return;
        workspaceStore.rename(id, name);
      },

      duplicate: (id) => {
        const copy = workspaceStore.duplicate(id);
        if (copy) toast.success(`“${copy.name}” created`);
      },

      toggleLock: (id) => {
        const w = state.items.find((x) => x.id === id);
        if (!w) return;
        workspaceStore.setLocked(id, !w.locked);
        toast.info(w.locked ? `“${w.name}” unlocked` : `“${w.name}” locked`,
          w.locked ? 'Changes are saved into it again.' : 'You can still move panels — they just will not be saved into it.');
      },

      reset: async (id) => {
        const w = state.items.find((x) => x.id === id);
        if (!w) return;
        if (!(await confirm({
          title: `Reset “${w.name}”?`,
          message: 'Every workbench in it goes back to its shipped arrangement. The workspace keeps its name.',
          confirmLabel: 'Reset', danger: true,
        }))) return;
        workspaceStore.reset(id);
      },

      remove: async (id) => {
        const w = state.items.find((x) => x.id === id);
        if (!w) return;
        if (!(await confirm({
          title: `Delete “${w.name}”?`,
          message: 'The arrangement on screen stays as it is — only the saved workspace goes.',
          confirmLabel: 'Delete', danger: true,
        }))) return;
        workspaceStore.remove(id);
      },

      exportAll: async (ids) => {
        const info = await window.artlux?.getAppInfo?.();
        const file = workspaceStore.buildFile(ids, info?.version);
        if (!file.workspaces.length) { toast.warn('Nothing to export', 'Save a workspace first.'); return; }
        const path = await window.artlux?.exportWorkspaces?.(file);
        if (path) toast.success(`${file.workspaces.length} workspace${file.workspaces.length > 1 ? 's' : ''} exported`, path);
      },

      importFile: async () => {
        const raw = await window.artlux?.importWorkspaces?.();
        if (raw == null) return; // cancelled
        const res = workspaceStore.importFile(raw);
        if (res.error) { toast.error('Could not import that file', res.error); return; }
        const names = res.added.map((w) => w.name).join(', ');
        toast.success(`Imported ${res.added.length} workspace${res.added.length > 1 ? 's' : ''}`,
          res.droppedTrees
            ? `${names}. ${res.droppedTrees} workbench arrangement${res.droppedTrees > 1 ? 's' : ''} could not be read and will use the shipped one.`
            : names);
      },
    };
  }, [state, toast, confirm, prompt]);
}
