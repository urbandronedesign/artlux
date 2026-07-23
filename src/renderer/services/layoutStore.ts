import { DockTab } from '../types';

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
  bottomHeight: number;  // px — the full-width bottom region (WorkspaceContext.bottom)
  // visibility
  showLeft: boolean;
  showRight: boolean;
  showHelp: boolean;
  dockOpen: boolean;
  splitView: boolean;
  timelineMax: boolean;
  // selections
  leftTab: 'scene' | 'media';
  dockTab: DockTab;
  // which preset is active; flips to 'custom' the moment the user hand-tweaks anything
  activePreset: string;
  // ── Workspace contexts ──────────────────────────────────────────────────────────────────
  // The active workbench (a WorkspaceContext id, e.g. 'led'), and each context's REMEMBERED
  // ergonomics. Switching contexts banks the current sizes into the outgoing context's slice and
  // restores the incoming one's, so the operator's dock height in LED survives a trip through Audio.
  activeContext: string;
  contexts: Record<string, ContextLayout>;
}

// The subset of the layout a context remembers on its own. Deliberately only the ERGONOMIC keys:
// `activeContext`/`contexts` would be self-referential, and `activePreset` is being retired by the
// context rail. `dockPanel` is the active dock tab as a PANEL ID (the `DockTab` enum is core-only and
// cannot name a plugin's dock panel); it supersedes `dockTab`, which stays until the dock is
// decomposed into panels.
export type ContextLayout = Partial<Pick<WorkspaceLayout,
  'dockHeight' | 'splitRatio' | 'bottomHeight' | 'showLeft' | 'showRight' | 'dockOpen' | 'splitView'>> & {
  dockPanel?: string;
  /** The `WorkspaceContext.layoutRev` this slice was banked against — see resolveContextLayout(). */
  rev?: number;
};

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  dockHeight: 280,
  helpWidth: 320,
  splitRatio: 0.5,
  bottomHeight: 340,
  showLeft: true,
  showRight: true,
  showHelp: false,
  dockOpen: true,
  splitView: false,
  timelineMax: false,
  leftTab: 'scene',
  dockTab: DockTab.FIXTURE_EDITOR,
  activePreset: 'edit',
  activeContext: 'mapping',
  contexts: {},
};

// The ergonomic keys banked per context — one list, used by both directions of a context switch.
const CONTEXT_KEYS = ['dockHeight', 'splitRatio', 'bottomHeight', 'showLeft', 'showRight', 'dockOpen', 'splitView'] as const;

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

// Contexts that no longer exist → what replaced each. `map` + `led` merged into `mapping` (you place
// a surface in order to map LEDs onto it); `media` was dropped and its media browser + asset manager
// became part of `timeline`, which took its place in the rail.
const RETIRED_CONTEXTS: Record<string, string> = { map: 'mapping', led: 'mapping', media: 'timeline' };

// Retired presets → the context that replaced each. 'custom' is absent on purpose: a hand-tweaked
// layout carries no hint about which job it was for, so it falls through to the default context.
const PRESET_TO_CONTEXT: Record<string, string> = { edit: 'mapping', perform: 'show', calibrate: 'calib' };

// BUILTIN_PRESETS / applyPreset / PresetId were REMOVED — workspace contexts replaced them. A preset
// was a named partial layout that toggled panel VISIBILITY only; a WorkspaceContext carries the same
// `layout` partial AND decides which panels the columns contain. Each context's ergonomics now live
// in `contexts[id]` above, applied by setContext(). `activePreset` survives only as the migration
// input read once in hydrate() (PRESET_TO_CONTEXT), so an install upgrading in place lands on the
// context matching the preset it was last using.
