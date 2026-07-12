// The timeline's current selection — a render-free singleton, modelled on automationOverlay/livePreview.
//
// WHY A SINGLETON AND NOT REACT STATE. Selection is EPHEMERAL: docs/TIMELINE.md is explicit that it must
// never enter the `Timeline` data type (it is not the document, it is the cursor). But the audio MIXER —
// a plugin panel — needs a clip inspector that FOLLOWS it, and a plugin reaches core only through host
// services. Lifting `selected` into App state would re-render the whole App tree on every click of a clip.
// So: an imperative store that Timeline.tsx writes and the mixer subscribes to, with zero React coupling
// in between and zero persistence.
//
// `source` on an audioClip is LOAD-BEARING: the same clip id could exist in either container (the bed, or
// the bound timeline's own audio), and the two commit through DIFFERENT paths at DIFFERENT costs
// (host.audio.setMix vs. onChange(timeline)). An inspector that guessed would write to the wrong document.
export type TimelineSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'audioClip'; id: string; source: 'bed' | 'timeline' }
  | null;

let current: TimelineSelection = null;
const subs = new Set<(s: TimelineSelection) => void>();

const same = (a: TimelineSelection, b: TimelineSelection): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind || a.id !== b.id) return false;
  // Same kind on both sides here, so a 'clip' pair is already equal and an 'audioClip' pair must also
  // agree on its container.
  return a.kind !== 'audioClip' || a.source === (b as { source: string }).source;
};

export function setSelection(s: TimelineSelection): void {
  if (same(current, s)) return;   // idempotent: Timeline re-renders constantly and must not spam the mixer
  current = s;
  subs.forEach(cb => cb(current));
}
export function getSelection(): TimelineSelection { return current; }
export function subscribe(cb: (s: TimelineSelection) => void): () => void {
  subs.add(cb);
  cb(current);                    // fire immediately, so a panel opened mid-show sees the live selection
  return () => { subs.delete(cb); };
}
