// Lightweight contextual-help bus: components broadcast a hint on hover/focus, the StatusBar and
// the Help panel show the latest one (falling back to idle content). Hints are bilingual: a plain
// { en, fr } object is the seed of "help i18n" without pulling in a framework. Consumers render
// the field for the active help language (AppSettings.helpLang).
export type HelpLang = 'en' | 'fr';
export interface HelpText { en: string; fr: string; }

type Cb = (hint: HelpText | null) => void;

const listeners = new Set<Cb>();
let current: HelpText | null = null;

export const helpBus = {
  set(hint: HelpText | null) {
    current = hint;
    listeners.forEach((l) => l(hint));
  },
  subscribe(cb: Cb): () => void {
    listeners.add(cb);
    cb(current);
    return () => { listeners.delete(cb); };
  },
};

// Spread onto any element to publish a bilingual hint while hovered/focused.
export const helpProps = (hint: HelpText) => ({
  onMouseEnter: () => helpBus.set(hint),
  onMouseLeave: () => helpBus.set(null),
  onFocus: () => helpBus.set(hint),
  onBlur: () => helpBus.set(null),
});

// Spread onto a control to opt it into the rich help system by REGISTRY ID. It does two things:
//   1. re-emits the entry's one-liner to helpBus (so the StatusBar + HelpPanel "Context" line keep
//      working — fr mirrors en until French content is authored), and
//   2. tags the element with `data-help-id`, which the Tooltip / IconButton reads to render the "?"
//      Learn-more link that deep-links into the Help Page.
// A missing id is a graceful no-op (renders the control with just its native title), so a call site
// migrates by swapping one prop: `title="Blade" {...helpProps({…})}` → `{...help('timeline.blade')}`.
// (registry imports nothing from here, so this one-directional import is cycle-free.)
import { helpEntry } from '../help/registry';

export const help = (id: string) => {
  const e = helpEntry(id);
  return {
    ...(e ? helpProps({ en: e.short, fr: e.short }) : {}),
    'data-help-id': id,
  };
};
