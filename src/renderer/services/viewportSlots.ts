// Where each persistent viewport should currently be drawn — the seam that lets a dock tree place
// elements it cannot render. Plan: plans/dockable-workspace.md §4.
//
// THE PROBLEM THIS SOLVES. `Stage`, `Simulator3D` and `TimelinePanel` are created by App and handed to
// the shell as ELEMENTS. A React element exists at exactly one position in the tree, so a generic tree
// walker that might place a panel anywhere cannot render them — and two of the three must never be
// mounted twice (one WebGL context; one keyboard hook + one engine subscription) nor unmounted (r3f's
// raycaster dies if its canvas is ever laid out at 0x0).
//
// So the tree renders empty SLOTS, this registry says which slot currently wins for each id, and
// PersistentLayer positions the one real element over it. The element never moves in the React tree;
// only its coordinates change.
//
// No React, no DOM ownership, no per-frame anything: slots are registered and unregistered on mount and
// on visibility changes, which are structural events and therefore rare. The per-frame work — following
// a rect while a splitter is dragged — belongs to PersistentLayer, and is deliberately not state.

export interface ViewportSlot {
  /** Persistent viewport id, e.g. 'core.viewport.stage2d'. */
  id: string;
  el: HTMLElement;
  /**
   * Ties are broken high-first. This exists for one concrete case: the maximized timeline. Both the
   * drawer's slot and the fullscreen overlay's slot are mounted, and the overlay simply outranks — so
   * the SAME element is retargeted rather than swapped, and its zoom and scroll survive maximizing.
   * Swapping is what loses them today.
   */
  priority: number;
  visible: boolean;
}

type Listener = () => void;

const slots = new Map<string, ViewportSlot[]>();
const listeners = new Set<Listener>();

const notify = (): void => { listeners.forEach((f) => f()); };

/** Subscribe to STRUCTURAL changes (a slot appeared, vanished, or changed visibility). Never per-frame. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function register(slot: ViewportSlot): () => void {
  const list = slots.get(slot.id) ?? [];
  list.push(slot);
  slots.set(slot.id, list);
  notify();
  return () => {
    const cur = slots.get(slot.id);
    if (!cur) return;
    const i = cur.indexOf(slot);
    if (i >= 0) cur.splice(i, 1);
    if (cur.length === 0) slots.delete(slot.id);
    notify();
  };
}

/** Called when a slot is shown or hidden — a context switch, or the drawer opening. */
export function setVisible(slot: ViewportSlot, visible: boolean): void {
  if (slot.visible === visible) return;
  slot.visible = visible;
  notify();
}

/**
 * The slot a given viewport should be drawn over right now, or null if it should not be drawn at all.
 *
 * `null` is a real answer and must stay one: a context that does not show the 3D scene leaves it with no
 * slot, and the layer then parks the element — hidden, still mounted, never at 0x0. "Hidden" and
 * "unmounted" are the same thing to the operator and completely different to r3f.
 */
export function winnerFor(id: string): ViewportSlot | null {
  const list = slots.get(id);
  if (!list || list.length === 0) return null;
  let best: ViewportSlot | null = null;
  for (const s of list) {
    if (!s.visible || !s.el.isConnected) continue;
    if (!best || s.priority > best.priority) best = s;
  }
  return best;
}

/** Every id that currently has at least one registered slot — what the layer iterates. */
export function slotIds(): string[] {
  return [...slots.keys()];
}

/** Test/debug only. */
export function __slots(): Map<string, ViewportSlot[]> { return slots; }
