// THE MARQUEE — drag a box over keys to select them, across lanes, the After Effects way.
//
// Started from a pointerdown on an EMPTY part of a curve or colour row (CurveEditor, ColorRow). A press
// that does not travel is still a CLICK, and a click keeps what an empty lane click always did — seek
// there — plus the After Effects meaning: drop the selection. The seek therefore happens on RELEASE
// now rather than on press; that is the only way a drag can mean something else.
//
// THE HIT TEST READS THE DOM, on purpose. Keys are drawn by three components whose geometry lives in
// three different coordinate systems (a curve's value axis, a colour row's centre line, a clip's
// trim-relative x). Each key element carries `data-kf="owner|index"` (keySel.keyAttr), so "which keys
// are inside this box" is one query over measured rects, with no surface having to export its maths.
// The box itself is a raw fixed div written by style — a drag must not re-render the timeline.
//
// Shift (or Ctrl) while starting ADDS to the selection instead of replacing it.
import * as keySel from '../../services/keyframeSelection';

const THRESHOLD = 4;   // px of travel before a press becomes a box

export function startMarquee(e: React.PointerEvent, onClick: () => void): void {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const base = additive ? keySel.snapshot() : undefined;
  // Only keys of THIS timeline panel — the scroller the press started in.
  const root = (e.currentTarget as HTMLElement).closest('[data-timeline-root]') ?? document.body;
  let box: HTMLDivElement | null = null;

  const hits = (l: number, t: number, r: number, b: number) => {
    const out: Array<{ owner: string; index: number }> = [];
    root.querySelectorAll<HTMLElement>('[data-kf]').forEach((el) => {
      const k = el.getBoundingClientRect();
      const cx = k.left + k.width / 2, cy = k.top + k.height / 2;
      if (cx < l || cx > r || cy < t || cy > b) return;
      const [owner, idx] = (el.dataset.kf ?? '').split('|');
      const index = Number(idx);
      if (owner && Number.isInteger(index)) out.push({ owner, index });
    });
    return out;
  };

  const move = (ev: PointerEvent) => {
    if (!box) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return;
      box = document.createElement('div');
      box.className = 'fixed z-popover pointer-events-none border border-accent bg-accent/10 rounded-sm';
      document.body.appendChild(box);
    }
    const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY);
    const r = Math.max(x0, ev.clientX), b = Math.max(y0, ev.clientY);
    Object.assign(box.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` });
    keySel.setMany(hits(l, t, r, b), base);
  };
  const done = (commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (box) { box.remove(); return; }
    if (!commit) return;
    if (!additive) keySel.clear();
    onClick();
  };
  const up = () => done(true);
  const cancel = () => done(false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
