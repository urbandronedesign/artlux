import { DockTab, type MediaView } from '../types';

// Serializable editor layout — panel sizes, visibility, tab selections, and the active workspace
// preset. Persisted as a SINGLE top-level `Prefs.layoutState` object (Prefs.setPrefs is a one-level
// shallow merge, so a single object is safe to patch). This is workspace ergonomics: it lives in
// prefs (survives restart), never in the portable .artlux project. Backing store is a module-singleton
// pub/sub bus matching the existing cueBus/helpBus idiom; App.tsx reads it via useLayout().

export interface WorkspaceLayout {
  // sizes
  dockHeight: number;    // px, clamped 120..(innerHeight-120)
  helpWidth: number;     // px, clamped 240..560
  splitRatio: number;    // 0.2..0.85 — the 2D stage's fraction of the split host
  bottomHeight: number;  // px — the full-width bottom drawer (WorkspaceContext.bottom), when open
  leftWidth: number;     // px — the browser column (clamped in the shell)
  rightWidth: number;    // px — the parameter column (clamped in the shell)
  // visibility
  showLeft: boolean;
  showRight: boolean;
  showHelp: boolean;
  dockOpen: boolean;
  splitView: boolean;
  // Is the full-width bottom drawer (the timeline, in every context that names it) pulled up? Banked
  // per context, so a workbench remembers whether you were cutting in it — which is the whole reason
  // the timeline stopped being a context of its own.
  bottomOpen: boolean;
  timelineMax: boolean;
  // selections
  leftTab: 'scene' | 'media';
  dockTab: DockTab;
  // Media library tile size (Explorer's large/medium/list). Panel-local, but it is view ergonomics
  // that must survive a restart — the same reason `leftTab` is here rather than in the project. NOT
  // banked per context (CONTEXT_KEYS): the operator picks a density because of their screen and their
  // media, not because of which workbench they walked in from.
  mediaView: MediaView;
  // which preset is active; flips to 'custom' the moment the user hand-tweaks anything
  activePreset: string;
  // ── Workspace contexts ──────────────────────────────────────────────────────────────────
  // The active workbench (a WorkspaceContext id, e.g. 'led'), and each context's REMEMBERED
  // ergonomics. Switching contexts banks the current sizes into the outgoing context's slice and
  // restores the incoming one's, so the operator's dock height in LED survives a trip through Audio.
  activeContext: string;
  contexts: Record<string, ContextLayout>;
  // ── The dockable workspace's per-context arrangement (plans/dockable-workspace.md) ───────────
  //
  // ⚠ A SIBLING OF `contexts`, NOT A FIELD INSIDE IT — and that is a deliberate departure from the
  // plan, which said "slice-only, never mirrored to a top level key".
  //
  // The plan's reasoning was to dodge the CONTEXT_KEYS partial-spread bug class. But reading
  // setContext() shows the slice is the wrong hiding place for exactly that reason: it does
  // `state = { ...state, ...incoming }`, so EVERY key of a context's slice is spread onto the top
  // level anyway. Putting the tree there would mirror it to the root on every context switch — the
  // precise thing the rule exists to prevent, arrived at by following the rule.
  //
  // A map keyed by context id is never spread by setContext, never banked by CONTEXT_KEYS, and still
  // one tree per workbench. Absent id ⇒ no saved tree ⇒ ensureTree() compiles the shipped one, which
  // is the migration trigger and needs no layoutRev bump.
  dockTrees?: Record<string, unknown>;
  /** Master switch for the dockable workspace. Off until WP-5.6. */
  docking?: boolean;
}

// The subset of the layout a context remembers on its own. Deliberately only the ERGONOMIC keys:
// `activeContext`/`contexts` would be self-referential, and `activePreset` is being retired by the
// context rail. `dockPanel` is the active dock tab as a PANEL ID (the `DockTab` enum is core-only and
// cannot name a plugin's dock panel); it supersedes `dockTab`, which stays until the dock is
// decomposed into panels.
export type ContextLayout = Partial<Pick<WorkspaceLayout,
  'dockHeight' | 'splitRatio' | 'bottomHeight' | 'leftWidth' | 'rightWidth'
  | 'showLeft' | 'showRight' | 'dockOpen' | 'splitView' | 'bottomOpen'>> & {
  dockPanel?: string;
  /** The `WorkspaceContext.layoutRev` this slice was banked against — see resolveContextLayout(). */
  rev?: number;
};

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  dockHeight: 280,
  helpWidth: 320,
  splitRatio: 0.5,
  bottomHeight: 340,
  // The old hard-coded Tailwind widths of the two columns (w-72 / w-80) — so an install that has
  // never dragged them looks exactly as it did before they became resizable.
  leftWidth: 288,
  rightWidth: 320,
  showLeft: true,
  showRight: true,
  showHelp: false,
  dockOpen: true,
  splitView: false,
  // Closed by default everywhere: the drawer is 340px of the window, and a workbench you opened to
  // patch fixtures should not give a third of itself to lanes you did not ask for. The collapsed strip
  // is what keeps it findable.
  bottomOpen: false,
  timelineMax: false,
  leftTab: 'scene',
  dockTab: DockTab.FIXTURE_EDITOR,
  mediaView: 'medium',
  activePreset: 'edit',
  activeContext: 'mapping',
  contexts: {},
  dockTrees: {},
  docking: false,
};

// The ergonomic keys banked per context — one list, used by both directions of a context switch.
const CONTEXT_KEYS = ['dockHeight', 'splitRatio', 'bottomHeight', 'leftWidth', 'rightWidth', 'showLeft', 'showRight', 'dockOpen', 'splitView', 'bottomOpen'] as const;

let state: WorkspaceLayout = DEFAULT_LAYOUT;
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// Coalesce persistence: layout changes fire on every pointer tick during a resize; debounce the
// single-object write so we hit disk at most a few times, not per-frame.
function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void window.artlux?.setPrefs?.({ layoutState: state }); }, 300);
}

export const layoutStore = {
  get(): WorkspaceLayout { return state; },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  // A manual edit is any patch that doesn't set activePreset itself → we're now off any preset.
  // applyPreset() (Phase 3) always includes activePreset, so it's exempt.
  set(patch: Partial<WorkspaceLayout>): void {
    const next: WorkspaceLayout = { ...state, ...patch };
    if (!('activePreset' in patch)) next.activePreset = 'custom';
    state = next;
    subs.forEach((f) => f());
    persistSoon();
  },
  // Switch the active workbench. Banks the current ergonomics into the OUTGOING context's slice,
  // then restores the incoming one's — falling back to `defaults` (the context's own declared layout)
  // the first time a context is entered, or when the declared layout has been revised. Not a "manual
  // edit": this is the context's own doing, so it must not be routed through set()'s
  // activePreset='custom' rule.
  setContext(id: string, defaults?: ContextLayout): void {
    if (id === state.activeContext) return;
    const banked: ContextLayout = { rev: state.contexts[state.activeContext]?.rev };
    for (const k of CONTEXT_KEYS) (banked as Record<string, unknown>)[k] = state[k];
    banked.dockPanel = state.contexts[state.activeContext]?.dockPanel;
    const incoming = resolveContextLayout(state.contexts[id], defaults);
    state = {
      ...state,
      ...incoming,
      activeContext: id,
      contexts: { ...state.contexts, [state.activeContext]: banked, [id]: incoming },
    };
    subs.forEach((f) => f());
    persistSoon();
  },
  // Write one context's arrangement. Deliberately NOT routed through set(): rearranging panels is the
  // operator editing their workbench, not "abandoning a preset", and it must not be able to disturb the
  // ergonomic keys that setContext banks.
  setDockTree(contextId: string, tree: unknown): void {
    state = { ...state, dockTrees: { ...(state.dockTrees ?? {}), [contextId]: tree } };
    subs.forEach((f) => f());
    persistSoon();
  },
  // Boot: merge the saved layout over the defaults (absent keys keep their default). Does NOT persist.
  hydrate(saved?: Partial<WorkspaceLayout>): void {
    state = { ...DEFAULT_LAYOUT, ...(saved ?? {}) };
    // One-time migration off the three workspace presets the context rail replaces. An install that
    // never saved an activeContext lands on the context closest to the preset it was last using.
    if (!saved?.activeContext) {
      state.activeContext = PRESET_TO_CONTEXT[state.activePreset] ?? DEFAULT_LAYOUT.activeContext;
    } else if (RETIRED_CONTEXTS[state.activeContext]) {
      // …and off contexts that have since been merged or removed. A saved id that no longer resolves
      // would leave the rail with nothing selected, so remap it to whatever replaced it.
      state.activeContext = RETIRED_CONTEXTS[state.activeContext];
    }
    subs.forEach((f) => f());
  },
  // Boot, straight after hydrate(): (re)apply the ACTIVE context's ergonomics. hydrate restores the
  // raw top-level fields, and those are whatever the context the operator quit from left behind — so
  // without this you boot into (say) LED wearing Calibration's split. setContext can't do this job:
  // it early-returns when the id is already active, which at boot it always is.
  enterActiveContext(defaults?: ContextLayout): void {
    const id = state.activeContext;
    const l = resolveContextLayout(state.contexts[id], defaults);
    state = { ...state, ...l, contexts: { ...state.contexts, [id]: l } };
    subs.forEach((f) => f());
  },
};

// A context's saved slice wins over its declared layout — that is what preserves the operator's own
// arrangement across switches. The exception is a REVISION: when the context ships a different
// `layoutRev` than the slice was banked against, the declared layout is applied once and re-stamped.
// Without this, every layout we ship is invisible to anyone who has already opened that context.
function resolveContextLayout(saved: ContextLayout | undefined, defaults?: ContextLayout): ContextLayout {
  const rev = defaults?.rev ?? 0;
  if (!saved || (saved.rev ?? 0) !== rev) return { ...(defaults ?? {}), rev };
  return saved;
}

// Contexts that no longer exist → what replaced each. `map` + `led` merged into `mapping` (you place a
// surface in order to map LEDs onto it). `media` was dropped into `timeline`, and `timeline` was itself
// dissolved once the timeline became every context's bottom DRAWER — so `media` had to be repointed at
// `mapping` too: this lookup is a single hop, not transitive, and an ancient `media` install would
// otherwise land on an id that no longer resolves. `tracking` merged into `3d` (the 3D scene is where
// its blobs are drawn, and `3d` had a free dock for its plugins' monitors).
//
// Getting an entry wrong here is silent: the rail simply opens with nothing selected.
const RETIRED_CONTEXTS: Record<string, string> = {
  map: 'mapping', led: 'mapping', media: 'mapping', timeline: 'mapping', tracking: '3d',
};

// Retired presets → the context that replaced each. 'custom' is absent on purpose: a hand-tweaked
// layout carries no hint about which job it was for, so it falls through to the default context.
const PRESET_TO_CONTEXT: Record<string, string> = { edit: 'mapping', perform: 'show', calibrate: 'calib' };

// BUILTIN_PRESETS / applyPreset / PresetId were REMOVED — workspace contexts replaced them. A preset
// was a named partial layout that toggled panel VISIBILITY only; a WorkspaceContext carries the same
// `layout` partial AND decides which panels the columns contain. Each context's ergonomics now live
// in `contexts[id]` above, applied by setContext(). `activePreset` survives only as the migration
// input read once in hydrate() (PRESET_TO_CONTEXT), so an install upgrading in place lands on the
// context matching the preset it was last using.
