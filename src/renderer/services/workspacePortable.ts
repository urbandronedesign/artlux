import { sanitizeDockTree, walk, type DockNode } from './dockTree';

// Everything that has to happen between "a workspace off a file or off prefs" and "a layout the shell
// can render". Plan: plans/named-workspaces.md.
//
// ⚠ THIS FILE IMPORTS ONLY dockTree (which itself imports nothing), ON PURPOSE — the same rule, for
// the same reason. No React, no DOM, no registries, and NOT EVEN the layout types: it takes a
// structural view of a layout slice, exactly as dockTree takes one of a WorkspaceContext. The window
// size, "does this workbench exist here" and the retired-id table all arrive as arguments.
//
// That is what lets `npm run test:workspace` compile and run it in a second with no Electron and no
// app — which matters more here than almost anywhere else, because EVERY failure this file exists to
// prevent is SILENT: the app boots, nothing throws, and the operator's shell is simply the wrong
// shape. (A type import would drag in shared/protocol and the SDK, and the test would need the app's
// whole build config to compile one pure function.)
//
// The cost of a structural view is drift, so it is pinned where both types are already in scope:
// workspaceStore.ts asserts at COMPILE TIME that PortableLayout is a subset of WorkspaceLayout and
// that a slice is a ContextLayout. Change a field here and that assertion is what fails.

/** One workbench's remembered ergonomics — the structural view of `layoutStore.ContextLayout`. */
export interface PortableContextLayout {
  dockHeight?: number; splitRatio?: number; bottomHeight?: number;
  leftWidth?: number; rightWidth?: number;
  showLeft?: boolean; showRight?: boolean; dockOpen?: boolean; splitView?: boolean; bottomOpen?: boolean;
  dockPanel?: string; rev?: number;
}

/**
 * The shareable subset of a WorkspaceLayout. EVERY key here is UI SHAPE; nothing here describes a
 * machine — that line is the whole design, and `Prefs` already draws it (see the field comment on
 * `scene3dRenderScale`: "per-MACHINE, because it describes what this GPU can afford"). So `uiScale`,
 * the scene3d group, `calibrationFile`, `mediaView` and `shortcuts` are absent ON PURPOSE, and
 * verify:invariants asserts they stay absent. A shared file that quietly rewrote the recipient's UI
 * scale or their keyboard would be a worse feature than no sharing at all.
 */
export interface PortableLayout {
  contexts: Record<string, PortableContextLayout>;
  activeContext: string;
  showLeft: boolean;
  showRight: boolean;
  dockOpen: boolean;
  splitView: boolean;
  bottomOpen: boolean;
  timelineMax: boolean;
  leftTab: 'scene' | 'media';
  dockingOff?: boolean;
  dockTrees?: Record<string, unknown>;
}

/** Column/row px floors and ceilings, as fractions of the window. */
const MAX_COL_FRAC = 0.4;   // a browser or parameter column may not eat more than 40% of the width
const MAX_ROW_FRAC = 0.6;   // …nor the dock / bottom drawer more than 60% of the height
const MIN_COL = 160;
const MIN_ROW = 120;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/**
 * Bring a workspace authored on another screen into range of THIS one.
 *
 * CLAMP, NEVER RESCALE. A 700px browser column is half of a 1366px laptop, so it has to move; but a
 * proportional rescale silently changes an arrangement the operator authored deliberately, and when it
 * guesses wrong it is indistinguishable from a bug. Clamping only ever moves a size that could not
 * have been rendered anyway. `SavedWorkspace.authored` is kept so the manager can SAY where it came
 * from — that is the honest way to make a moved column legible rather than mysterious.
 *
 * Every `{px}` inside a dock tree needs the same treatment, and there the direction of the parent
 * split decides which axis it is on: a 'row' splits its children left-to-right (px = width), a 'col'
 * top-to-bottom (px = height).
 */
function clampToViewport(p: PortableLayout, w: number, h: number): { layout: PortableLayout; droppedTrees: string[] } {
  const maxCol = Math.max(MIN_COL, Math.floor(w * MAX_COL_FRAC));
  const maxRow = Math.max(MIN_ROW, Math.floor(h * MAX_ROW_FRAC));

  const slice = (s: PortableContextLayout): PortableContextLayout => ({
    ...s,
    ...(typeof s.leftWidth === 'number' ? { leftWidth: clamp(s.leftWidth, MIN_COL, maxCol) } : {}),
    ...(typeof s.rightWidth === 'number' ? { rightWidth: clamp(s.rightWidth, MIN_COL, maxCol) } : {}),
    ...(typeof s.dockHeight === 'number' ? { dockHeight: clamp(s.dockHeight, MIN_ROW, maxRow) } : {}),
    ...(typeof s.bottomHeight === 'number' ? { bottomHeight: clamp(s.bottomHeight, MIN_ROW, maxRow) } : {}),
    ...(typeof s.splitRatio === 'number' ? { splitRatio: clamp(s.splitRatio, 0.2, 0.85) } : {}),
  });

  const contexts: Record<string, PortableContextLayout> = {};
  for (const [id, s] of Object.entries(p.contexts ?? {})) contexts[id] = slice(s);

  const dockTrees: Record<string, unknown> = {};
  const droppedTrees: string[] = [];
  for (const [id, raw] of Object.entries(p.dockTrees ?? {})) {
    const tree = sanitizeDockTree(raw);
    // A tree this build cannot read is DROPPED, not repaired: ensureTree() then recompiles the shipped
    // arrangement for that workbench, which is a better outcome than a mangled one. The caller counts
    // these and TELLS the operator — silence is what would make a shared workspace mystifying.
    if (!tree) { droppedTrees.push(id); continue; }
    walk(tree.root as DockNode, (n) => {
      if (n.kind !== 'split') return;
      const lim = n.dir === 'row' ? maxCol : maxRow;
      const min = n.dir === 'row' ? MIN_COL : MIN_ROW;
      n.sizes = n.sizes.map((s) => ('px' in s ? { px: clamp(s.px, min, lim) } : s));
    });
    dockTrees[id] = tree;
  }
  return { layout: { ...p, contexts, dockTrees }, droppedTrees };
}

export interface PrepareEnv {
  /** The window the layout is about to be rendered in. */
  view: { w: number; h: number };
  /** Does this build have that workbench? (A plugin's context, or `calib` outside its profile.) */
  hasContext: (id: string) => boolean;
  /** The single hop off a workbench id that has been merged away since — layoutStore.remapContextId. */
  remap: (id: string) => string;
  /** Where to land when the saved workbench exists nowhere here. */
  fallbackContext: string;
}

export interface PreparedLayout {
  layout: PortableLayout;
  /** Workbench ids whose saved arrangement could not be read and will use the shipped one. */
  droppedTrees: string[];
  /**
   * True only if the saved active workbench EXISTS NOWHERE here and we fell back to the default.
   *
   * NOT true for a retired id that remapped cleanly (`tracking` → `3d`): that is a rename, the
   * operator lands where they meant to, and telling them "your workbench is not available" would be
   * false. The distinction is the whole value of the flag — it is what a message is written from.
   */
  fellBackContext: boolean;
}

/**
 * Used by BOTH import and apply, so the two can never diverge.
 *
 * The workbench id is the sharpest edge: goToContext() NO-OPS on an id it cannot resolve, so a
 * workspace naming a workbench this machine does not have would leave the rail with nothing selected
 * — the exact failure RETIRED_CONTEXTS exists for, arriving by a new road. Remap first, then verify,
 * then fall back.
 *
 * Slices and trees for absent workbenches are KEPT, not pruned: the plugin may come back, and that is
 * the same rule DockRenderer applies to a panel id it cannot resolve — which is the single fact that
 * makes sharing between differently-equipped machines viable at all.
 */
export function preparePortable(p: PortableLayout, env: PrepareEnv): PreparedLayout {
  const { layout: clamped, droppedTrees } = clampToViewport(p, env.view.w, env.view.h);

  const wanted = env.remap(clamped.activeContext ?? env.fallbackContext);
  const known = env.hasContext(wanted);
  const activeContext = known ? wanted : env.fallbackContext;

  const contexts: Record<string, PortableContextLayout> = {};
  for (const [id, s] of Object.entries(clamped.contexts ?? {})) contexts[env.remap(id)] = s;
  const dockTrees: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(clamped.dockTrees ?? {})) dockTrees[env.remap(id)] = t;

  return {
    layout: { ...clamped, contexts, dockTrees, activeContext },
    droppedTrees,
    fellBackContext: !known,
  };
}
