import React, { useEffect, useState } from 'react';
import { X, MousePointerClick, Search } from 'lucide-react';
import { helpBus, type HelpText, type HelpLang } from '../services/helpBus';
import { openHelp } from '../services/helpNav';
import { HELP_TOPICS } from '../help/helpContent';
import { Segmented } from './ui';
import { CollapsibleSection } from './CollapsibleSection';
import { useResizable } from '../hooks/useResizable';

// Right-side dockable Help panel (bilingual EN/FR). Two sections:
//   • Context — live help for whatever control is hovered/focused (reuses helpBus, like StatusBar)
//   • Topics  — a browsable accordion of bilingual guides (help/helpContent.ts)
// The EN/FR toggle writes through to AppSettings.helpLang (persisted) via onLang. A left-edge
// handle resizes the column (same pointer-drag idiom as Dock.tsx, horizontal).

interface Props {
  lang: HelpLang;
  onLang: (l: HelpLang) => void;
  onClose: () => void;
  width: number;
  onResize: (w: number) => void;
}

const UI = {
  title: { en: 'Help', fr: 'Aide' },
  context: { en: 'Context', fr: 'Contexte' },
  topics: { en: 'Topics', fr: 'Rubriques' },
  idle: { en: 'Hover a control to see its help here.', fr: 'Survolez un élément pour afficher son aide ici.' },
  searchAll: { en: 'Search all help…', fr: 'Rechercher dans l’aide…' },
};

export const HelpPanel: React.FC<Props> = ({ lang, onLang, onClose, width, onResize }) => {
  const [hint, setHint] = useState<HelpText | null>(null);
  useEffect(() => helpBus.subscribe(setHint), []);

  // Drag the left edge to resize (panel is on the right, so leftward drag widens it).
  const onResizeDown = useResizable({ axis: 'x', invert: true, value: width, min: 240, max: 560, onChange: onResize });

  return (
    <div className="relative h-full flex flex-col bg-surface-1">
      {/* Left-edge resize handle */}
      <div
        onPointerDown={onResizeDown}
        title="Resize"
        className="absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-accent/30 z-10"
      />

      {/* Header: title + EN/FR toggle + close */}
      <div className="h-10 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-line-1 bg-surface-2">
        <span className="text-xs font-semibold text-fg-1 uppercase tracking-wider">{UI.title[lang]}</span>
        <div className="flex items-center gap-2">
          <Segmented<HelpLang>
            options={[{ value: 'en', label: 'EN' }, { value: 'fr', label: 'FR' }]}
            value={lang}
            onChange={onLang}
          />
          <button onClick={onClose} aria-label="Close help" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
        </div>
      </div>

      {/* Context (live hover help) */}
      <div className="shrink-0 px-3 py-2.5 border-b border-line-1">
        <div className="flex items-center gap-1.5 text-micro font-bold uppercase tracking-wider text-fg-3 mb-1.5">
          <MousePointerClick size={11} /> {UI.context[lang]}
        </div>
        <p className={`text-xs leading-relaxed ${hint ? 'text-fg-1' : 'text-fg-3 italic'}`}>
          {hint ? hint[lang] : UI.idle[lang]}
        </p>
        {/* Cross-link to the searchable Help Page: HelpPanel = contextual glance, HelpBrowser = search
            the whole app (Shift+F1). */}
        <button
          onClick={() => openHelp()}
          className="mt-2 w-full flex items-center gap-1.5 px-2 h-7 rounded-sm bg-surface-2 border border-line-1 text-xs text-fg-2 hover:text-fg-1"
        >
          <Search size={12} /> {UI.searchAll[lang]}
        </button>
      </div>

      {/* Topics accordion */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-3 pt-2.5 pb-1 text-micro font-bold uppercase tracking-wider text-fg-3">{UI.topics[lang]}</div>
        {HELP_TOPICS.map((t) => (
          <CollapsibleSection key={t.id} title={t.title[lang]} defaultOpen={false}>
            <p className="px-3 py-2.5 text-xs leading-relaxed text-fg-2">{t.body[lang]}</p>
          </CollapsibleSection>
        ))}
      </div>
    </div>
  );
};
