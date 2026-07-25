// The shape of one per-function help entry. Kept in its own module so the per-area entry files under
// help/entries/ can import the type without importing the registry (which imports THEM) — no cycle.

export interface HelpEntry {
  /** Stable dotted id "context.function" — ALSO the deep-link anchor. Never rename in place. */
  id: string;
  /** Label shown in search results and as the reading-pane heading. */
  title: string;
  /** One-line tooltip hint (what today's `title=` / helpProps text says). */
  short: string;
  /** Optional longer explanation shown in the Help Page reading pane. Falls back to `short`. */
  body?: string;
  /** Grouping bucket for the search list ("Timeline", "Outputs", …). */
  group?: string;
  /** Extra search terms / synonyms so a control is found by words not in its title. */
  keywords?: string[];
  /** Optional shortcut hint shown next to the title (e.g. "B"). */
  shortcut?: string;
}
