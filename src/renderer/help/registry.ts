// The per-function help registry — the fine-grained layer under the HelpPanel's coarse HELP_TOPICS.
//
// Every entry is keyed by a STABLE dotted id ("timeline.blade", "outputs.corner-pin"). That id is the
// one thing three surfaces agree on: the tooltip's "?" link (services/helpBus.ts `help(id)`), the
// searchable Help Page (components/help/HelpBrowser.tsx), and the deep-link target (services/helpNav.ts
// `openHelp(id)`) all resolve the SAME content by it. So a control moving in the tree keeps its help.
//
// Content is English-only for now (authored as plain strings). The bridge in helpBus.ts mirrors `short`
// into the bilingual {en,fr} the StatusBar/HelpPanel expect (fr = en until French content is written),
// so nothing downstream has to change when FR lands — the field is already there in the consumer.
//
// A missing id is a graceful no-op everywhere: `help('not.added.yet')` still renders the control (with
// its native title), the Help Page simply doesn't list it, and `openHelp` opens the browser at the top.
// That is what makes adoption incremental — a call site migrates one prop at a time, entry by entry.
//
// ── WHY THE ENTRIES ARE SPLIT INTO per-area FILES ─────────────────────────────────────────────────
// The content lives in help/entries/<area>.ts, one array per area, aggregated here. Splitting it keeps
// a 300-entry map from being one merge-conflict magnet, lets an area be migrated in isolation, and
// means adding a control is an edit to ONE small file. This module just flattens them into a map and
// enforces that no two areas claim the same id (a duplicate id would silently shadow one of them).

import type { HelpEntry } from './types';
import { timelineHelp } from './entries/timeline';
import { timelineExtraHelp } from './entries/timelineExtra';
import { timelineAudioHelp } from './entries/timelineAudio';
import { outputsHelp } from './entries/outputs';
import { fixturesHelp } from './entries/fixtures';
import { mediaHelp } from './entries/media';
import { contentHelp } from './entries/content';
import { scenesHelp } from './entries/scenes';
import { scene3dHelp } from './entries/scene3d';
import { routingHelp } from './entries/routing';
import { chromeHelp } from './entries/chrome';

export type { HelpEntry } from './types';

const ALL: HelpEntry[] = [
  ...timelineHelp,
  ...timelineExtraHelp,
  ...timelineAudioHelp,
  ...outputsHelp,
  ...fixturesHelp,
  ...mediaHelp,
  ...contentHelp,
  ...scenesHelp,
  ...scene3dHelp,
  ...routingHelp,
  ...chromeHelp,
];

// Build the id → entry map. A duplicate id is a bug (two controls fighting over one help page), so warn
// loudly in dev rather than silently keeping whichever came last.
export const HELP_REGISTRY: Record<string, HelpEntry> = {};
for (const e of ALL) {
  if (HELP_REGISTRY[e.id]) console.warn(`[help] duplicate registry id "${e.id}" — one entry will shadow the other`);
  HELP_REGISTRY[e.id] = e;
}

/** All entries as a flat array — the Help Page's search index. */
export const allHelpEntries = (): HelpEntry[] => Object.values(HELP_REGISTRY);

/** Resolve one entry by id, or undefined if it has not been authored yet. */
export const helpEntry = (id: string): HelpEntry | undefined => HELP_REGISTRY[id];
