import { layoutStore, remapContextId, DEFAULT_LAYOUT, type WorkspaceLayout, type ContextLayout } from './layoutStore';
import { preparePortable, type PortableLayout, type PortableContextLayout, type PreparedLayout } from './workspacePortable';
import { contextRegistry } from '../host/registries';
import { contextLayoutOf } from '../contexts/nav';

export type { PortableLayout, PreparedLayout } from './workspacePortable';

// NAMED WORKSPACES — a saved shell arrangement, switchable, and shareable between machines.
// Plan: plans/named-workspaces.md · operator docs: docs/WORKSPACE.md.
//
// ── The one-paragraph model ──────────────────────────────────────────────────────────────────────
// `Prefs.layoutState` stays exactly what it is: the LIVE layout. A workspace is a NAMED COPY of the
// shareable part of it. So an install that never saves one behaves byte-identically to before, boot
// needs no new step (the live layout is already the active workspace's, kept in step below), and a
// workspaces blob that cannot be read costs the operator the list and nothing else.
//
// ── Two vocabularies, one level apart ────────────────────────────────────────────────────────────
// A `WorkspaceContext` is ONE WORKBENCH (Mapping, 3D, Show…) — the rail switches those. A WORKSPACE
// is a named snapshot of ALL of them at once. The code keeps the older name for the first because it
// is on the SDK's surface; the UI says "workbench" there, and "workspace" only for what this file
// owns. Getting that backwards makes every future reader disambiguate two things a level apart.

// ── Types ────────────────────────────────────────────────────────────────────────────────────────

// workspacePortable.ts describes a layout STRUCTURALLY so it can be tested without the app (see its
// header). These two assertions are the price of that, paid at compile time and nowhere else: a
// portable key that is not a real layout key, or a slice field whose type has drifted, fails HERE —
// the one file where both vocabularies are already in scope. Neither emits anything.
type StrayPortableKey = Exclude<keyof PortableLayout, keyof WorkspaceLayout>;
/** @internal Unreachable: its parameter type is `never` unless a portable key has gone stray. */
export function __assertNoStrayPortableKey(k: StrayPortableKey): never { return k; }
const _sliceIsAContextLayout: ContextLayout = {} as PortableContextLayout;
const _portableIsALayout: Partial<WorkspaceLayout> = {} as PortableLayout;
void _sliceIsAContextLayout; void _portableIsALayout;

export interface SavedWorkspace {
  /** Stable for the life of the workspace. Renaming must not orphan anything that points at it. */
  id: string;
  name: string;
  /**
   * Live edits apply but are never written back, and are discarded on the way out.
   *
   * This is what replaces a dirty flag. The case people actually care about is not "did I save?" —
   * it is "nobody may drag a splitter in my show workspace at 17:55 and have it stick".
   */
  locked?: boolean;
  createdAt: number;
  updatedAt: number;
  /** The window this was authored in. DISPLAYED, never used for arithmetic — see clampToViewport(). */
  authored?: { w: number; h: number };
  layout: PortableLayout;
}

export interface WorkspacesState {
  v: 1;
  /** The workspace whose shape is live. Absent = the operator has never picked one; edits go nowhere
      but `layoutState`, exactly as they did before this file existed. */
  activeId?: string;
  items: SavedWorkspace[];
}

/** The `.artws` file. Always an ARRAY: setting up a second operator PC is the request behind sharing. */
export interface WorkspaceFile {
  app: 'artlux';
  kind: 'workspace';
  v: 1;
  appVersion?: string;
  exportedAt: number;
  workspaces: SavedWorkspace[];
}

export const WORKSPACE_FILE_VERSION = 1;

// ── Store ────────────────────────────────────────────────────────────────────────────────────────

const EMPTY: WorkspacesState = { v: 1, items: [] };

let state: WorkspacesState = EMPTY;
const subs = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let unsubLayout: (() => void) | null = null;

function notify(): void { subs.forEach((f) => f()); }

// Coalesced, like the layout store's own write. These are two SEPARATE `setPrefs` calls on purpose:
// main's setPrefs merges a patch into a cached object and writes atomically, so two writes inside one
// window cannot lose each other, and the alternative — injecting a collector into layoutStore so both
// keys ride one call — would couple the layout store to a feature it has no reason to know about.
function persistSoon(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void window.artlux?.setPrefs?.({ workspaces: state }); }, 400);
}
function persistNow(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  void window.artlux?.setPrefs?.({ workspaces: state });
}

const newId = (): string => `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/** Names are the operator's handle AND a React key in the menus — keep them unique. */
function uniqueName(base: string, exceptId?: string): string {
  const taken = new Set(state.items.filter((w) => w.id !== exceptId).map((w) => w.name));
  const trimmed = base.trim() || 'Workspace';
  if (!taken.has(trimmed)) return trimmed;
  for (let n = 2; n < 999; n++) {
    const candidate = `${trimmed} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

// ── Capture / apply ──────────────────────────────────────────────────────────────────────────────

/** The live layout, reduced to what travels. */
export function captureLive(): PortableLayout {
  const l = layoutStore.get();
  return {
    contexts: l.contexts,
    activeContext: l.activeContext,
    showLeft: l.showLeft,
    showRight: l.showRight,
    dockOpen: l.dockOpen,
    splitView: l.splitView,
    bottomOpen: l.bottomOpen,
    timelineMax: l.timelineMax,
    leftTab: l.leftTab,
    dockingOff: l.dockingOff,
    dockTrees: l.dockTrees,
  };
}

/**
 * The local binding of the pure preparer: this window's size, this build's workbenches, and the one
 * retired-id table (exported from layoutStore rather than copied — the failure is silent in both
 * places, so there must not be two tables).
 */
export function prepare(p: PortableLayout, view = { w: window.innerWidth, h: window.innerHeight }): PreparedLayout {
  return preparePortable(p, {
    view,
    hasContext: (id) => !!contextRegistry.get(id),
    remap: remapContextId,
    fallbackContext: DEFAULT_LAYOUT.activeContext,
  });
}

/** Put a prepared layout on screen. The second step is exactly what boot does — see enterActiveContext. */
function applyPrepared(layout: PortableLayout): void {
  layoutStore.applyPortable(layout);
  layoutStore.enterActiveContext(contextLayoutOf(layout.activeContext ?? DEFAULT_LAYOUT.activeContext));
}

// ── The banking rule ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the live layout back into the active workspace. Called on a debounce while the operator works
 * (Blender's model: there is no Save, and therefore no way to lose an arrangement by forgetting one)
 * and synchronously before anything that is about to replace the live layout.
 */
function bankNow(): void {
  const w = state.items.find((x) => x.id === state.activeId);
  if (!w || w.locked) return;
  const layout = captureLive();
  state = {
    ...state,
    items: state.items.map((x) => (x.id === w.id ? { ...x, layout, updatedAt: Date.now() } : x)),
  };
}

export const workspaceStore = {
  get(): WorkspacesState { return state; },
  list(): SavedWorkspace[] { return state.items; },
  active(): SavedWorkspace | undefined { return state.items.find((w) => w.id === state.activeId); },
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },

  /**
   * Boot. Adopts the saved list and starts the auto-persist subscription — and does NOT apply the
   * active workspace's layout, because it does not need to: `layoutState` already holds it (they are
   * kept in step by banking), App has just hydrated it, and re-applying here would fight the Safe-Mode
   * rule that boots DEFAULTS rather than whatever the operator left open.
   */
  hydrate(saved?: unknown): void {
    const s = saved as Partial<WorkspacesState> | undefined;
    const items = Array.isArray(s?.items) ? (s!.items as SavedWorkspace[]).filter(isWorkspace) : [];
    const activeId = items.some((w) => w.id === s?.activeId) ? s!.activeId : undefined;
    state = { v: 1, activeId, items };
    unsubLayout?.();
    // Any layout edit while a workspace is live belongs to that workspace. The debounce is the layout
    // store's own idiom: this fires on every pointer tick of a splitter drag.
    unsubLayout = layoutStore.subscribe(() => {
      if (!state.activeId) return;
      const w = state.items.find((x) => x.id === state.activeId);
      if (!w || w.locked) return;
      bankNow();
      notify();
      persistSoon();
    });
    notify();
  },

  /** Capture the live shell under a new name and make it the active workspace. */
  saveAs(name: string): SavedWorkspace {
    const now = Date.now();
    const w: SavedWorkspace = {
      id: newId(),
      name: uniqueName(name),
      createdAt: now,
      updatedAt: now,
      authored: { w: window.innerWidth, h: window.innerHeight },
      layout: captureLive(),
    };
    state = { ...state, activeId: w.id, items: [...state.items, w] };
    notify();
    persistNow();
    return w;
  },

  rename(id: string, name: string): void {
    state = { ...state, items: state.items.map((w) => (w.id === id ? { ...w, name: uniqueName(name, id), updatedAt: Date.now() } : w)) };
    notify();
    persistNow();
  },

  duplicate(id: string): SavedWorkspace | undefined {
    const src = state.items.find((w) => w.id === id);
    if (!src) return undefined;
    const now = Date.now();
    const copy: SavedWorkspace = { ...src, id: newId(), name: uniqueName(`${src.name} copy`), locked: false, createdAt: now, updatedAt: now };
    state = { ...state, items: [...state.items, copy] };
    notify();
    persistNow();
    return copy;
  },

  /** Removing the ACTIVE workspace leaves the shell exactly as it is — only the name goes away. */
  remove(id: string): void {
    state = {
      ...state,
      activeId: state.activeId === id ? undefined : state.activeId,
      items: state.items.filter((w) => w.id !== id),
    };
    notify();
    persistNow();
  },

  setLocked(id: string, locked: boolean): void {
    // Locking BANKS first: the shape on screen is the one the operator means to freeze, and a pending
    // debounce would otherwise be dropped by the very act of locking.
    if (state.activeId === id && locked) bankNow();
    state = { ...state, items: state.items.map((w) => (w.id === id ? { ...w, locked, updatedAt: Date.now() } : w)) };
    notify();
    persistNow();
  },

  /**
   * Switch. Bank the outgoing one, then apply the incoming one.
   *
   * The order matters: `activeId` moves BEFORE the layout does, so the subscription above cannot
   * write the incoming layout into the outgoing workspace on the way past.
   */
  switchTo(id: string): PreparedLayout | undefined {
    const target = state.items.find((w) => w.id === id);
    if (!target) return undefined;
    bankNow();
    state = { ...state, activeId: id };
    const prepared = prepare(target.layout);
    applyPrepared(prepared.layout);
    notify();
    persistNow();
    return prepared;
  },

  /**
   * Back to the shipped arrangement: drop the workspace's own slices and trees so every workbench
   * recompiles from its LIVE manifest. Never hand-build a tree here — that is what makes the way back
   * pick up a panel a plugin has contributed since.
   */
  reset(id: string): void {
    const w = state.items.find((x) => x.id === id);
    if (!w) return;
    const layout: PortableLayout = { ...w.layout, contexts: {}, dockTrees: {} };
    state = { ...state, items: state.items.map((x) => (x.id === id ? { ...x, layout, updatedAt: Date.now() } : x)) };
    if (state.activeId === id) applyPrepared(prepare(layout).layout);
    notify();
    persistNow();
  },

  // ── Sharing ────────────────────────────────────────────────────────────────────────────────────

  /** Build the `.artws` payload for some (default: all) workspaces. */
  buildFile(ids?: string[], appVersion?: string): WorkspaceFile {
    const chosen = ids?.length ? state.items.filter((w) => ids.includes(w.id)) : state.items;
    return {
      app: 'artlux',
      kind: 'workspace',
      v: WORKSPACE_FILE_VERSION,
      appVersion,
      exportedAt: Date.now(),
      workspaces: chosen,
    };
  },

  /**
   * Adopt workspaces off a `.artws` file. Fresh ids (so importing twice cannot collide with what is
   * already here), unique names, and every layout run through prepare() so the report can say what
   * this machine could not honour.
   */
  importFile(raw: unknown): { added: SavedWorkspace[]; droppedTrees: number; error?: string } {
    const f = raw as Partial<WorkspaceFile> | null;
    if (!f || typeof f !== 'object') return { added: [], droppedTrees: 0, error: 'That file is not readable.' };
    if (f.kind !== 'workspace' || f.app !== 'artlux') return { added: [], droppedTrees: 0, error: 'That is not an ARTLux workspace file.' };
    // A FUTURE format must not be half-read by an older build that happens to recognise some keys —
    // the same refusal sanitizeDockTree makes, and for the same reason.
    if (f.v !== WORKSPACE_FILE_VERSION) {
      return { added: [], droppedTrees: 0, error: `That file was written by a different version of ARTLux (format ${String(f.v)}).` };
    }
    const list = Array.isArray(f.workspaces) ? f.workspaces.filter(isWorkspace) : [];
    if (!list.length) return { added: [], droppedTrees: 0, error: 'That file holds no workspaces.' };

    const added: SavedWorkspace[] = [];
    let droppedTrees = 0;
    for (const w of list) {
      const prepared = prepare(w.layout);
      droppedTrees += prepared.droppedTrees.length;
      added.push({
        ...w,
        id: newId(),
        name: uniqueName(w.name),
        layout: prepared.layout,
        updatedAt: Date.now(),
      });
      // uniqueName reads `state`, so each import has to land before the next name is chosen.
      state = { ...state, items: [...state.items, added[added.length - 1]] };
    }
    notify();
    persistNow();
    return { added, droppedTrees };
  },
};

// CDP harness hook, the same idiom as `window.__artluxOpenTrace` / `__artluxProjPump` /
// `__artluxLayerGaps`. Named workspaces are only really testable against a LIVE shell — banking,
// switching and the file round-trip all read the layout store — and the alternative is a script that
// hunts for menu items by their text, which is how a fuzzy selector once opened "Delete scene Scene 1?"
// on a real project. Driving the store directly is both safer and what actually needs proving.
(window as unknown as Record<string, unknown>).__artluxWorkspaces = { store: workspaceStore, layout: layoutStore };

/** Structural check — enough to keep a corrupt or hand-edited blob from reaching the shell. */
function isWorkspace(w: unknown): w is SavedWorkspace {
  if (!w || typeof w !== 'object') return false;
  const o = w as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string'
    && !!o.layout && typeof o.layout === 'object';
}
