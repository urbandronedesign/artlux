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
}

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  dockHeight: 280,
  helpWidth: 320,
  splitRatio: 0.5,
  showLeft: true,
  showRight: true,
  showHelp: false,
  dockOpen: true,
  splitView: false,
  timelineMax: false,
  leftTab: 'scene',
  dockTab: DockTab.FIXTURE_EDITOR,
  activePreset: 'edit',
};

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
  // Boot: merge the saved layout over the defaults (absent keys keep their default). Does NOT persist.
  hydrate(saved?: Partial<WorkspaceLayout>): void {
    state = { ...DEFAULT_LAYOUT, ...(saved ?? {}) };
    subs.forEach((f) => f());
  },
};

// ── Workspace presets ─────────────────────────────────────────────────────────────────────────
// A preset is a named partial layout applied over the current one (sizes/tabs the preset doesn't
// mention are preserved, so the operator keeps their dock height etc.). applyPreset stamps
// activePreset so the switcher highlights it; any later manual tweak flips it to 'custom' (see set()).
export const BUILTIN_PRESETS: Record<'edit' | 'perform' | 'calibrate', Partial<WorkspaceLayout>> = {
  edit:      { showLeft: true,  showRight: true,  showHelp: false, dockOpen: true,  splitView: false, timelineMax: false },
  perform:   { showLeft: false, showRight: false, showHelp: false, dockOpen: false, splitView: false, timelineMax: false },
  calibrate: { showLeft: false, showRight: true,  showHelp: false, dockOpen: true,  splitView: true,  splitRatio: 0.5 },
};

export type PresetId = keyof typeof BUILTIN_PRESETS;

export function applyPreset(id: PresetId): void {
  layoutStore.set({ ...BUILTIN_PRESETS[id], activePreset: id });
}
