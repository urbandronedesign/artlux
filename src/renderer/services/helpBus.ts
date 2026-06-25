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
