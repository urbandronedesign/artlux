import type { DocChunk } from '../../../shared/protocol';

// Search over the shipped documentation — the ONE implementation, shared by the two in-app surfaces
// that ask the same question: the Docs Browser's search field and the F1 Help modal.
//
// ── WHY ONE MODULE AND NOT TWO SEARCHES ───────────────────────────────────────────────────────────────
// The app had two help surfaces and only one of them could search. The F1 modal searched 226 per-function
// entries (a control: "the Blade tool"); the Docs Browser searched nothing at all, so 66 pages of prose
// were reachable only by guessing which chapter they were in. An operator does not know which of those
// two stores holds their answer — they know the word "blade". So one query has to return both, which
// means one scorer: two rankers would put the same query's results in two incomparable orders and the
// merge would be arbitrary.
//
// `score()` is lifted verbatim from HelpBrowser (itself mirrored from CommandPalette) rather than
// replaced with a search library. A dependency (Orama, Pagefind, lunr) buys stemming and BM25 that ~700
// chunks do not need, and would give the doc results a different ranking shape than the registry results
// they are interleaved with — which is the one thing this merge must not do.

/** Subsequence fuzzy match: exact prefix > substring > scattered. -1 = no match; higher is better. */
export function score(needle: string, hay: string): number {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (h.startsWith(n)) return 1000;
  const direct = h.indexOf(n);
  if (direct >= 0) return 500 - direct;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
  }
  return i === n.length ? 100 - Math.min(99, gaps) : -1;
}

export interface DocHit {
  chunk: DocChunk;
  s: number;
  /** ~160 chars of body around the match, for the result row. */
  excerpt: string;
}

// Body text is matched by SUBSTRING, never by the scattered-subsequence path. That is the whole
// difference between a useful body search and a useless one: over a 1200-character paragraph, almost any
// short query matches as a subsequence, so every chunk would "hit" and the ranking would be noise.
// A heading may fuzzy-match, because a heading is short enough for scatter to still mean something.
const BODY_BASE = 240;   // below every heading hit, above a scattered one — body matches are weaker evidence
const PHRASE_BONUS = 40; // the words adjacent, exactly as typed, is better evidence than merely co-present

// ── AND WHY CONTRIBUTOR PROSE IS DEMOTED RATHER THAN HIDDEN ───────────────────────────────────────────
// ~22 reference pages are "architecture and usage" in one file, and before their seams were marked, a
// search for "gray code" answered with *Building the native addon* and *Key files* — true, present, and
// useless to someone standing at a projector. But hiding those slices outright would be wrong: they are
// still correct, and the person configuring a venue PC is sometimes exactly who needs them. So they sink
// below every operator hit instead of disappearing — findable when nothing else matches, never first.
const CONTRIBUTOR_PENALTY = 220;

// ── AND WHY A MULTI-WORD QUERY IS TOKENISED (found by searching the running app) ───────────────────────
// The first build matched the whole query as one literal substring, and **"gray code" returned nothing** —
// because the documentation writes "Gray-code", 15 times, and never once with a space. A reader who types
// what they *say* got silence, while the answer sat in CALIBRATION.md. Punctuation, casing and hyphens are
// exactly what a reader does not remember, so any query of more than one word is matched as a SET of
// tokens that must all be present, with a bonus when they also appear adjacent as typed.
const tokenise = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function excerptAround(text: string, needles: string[]): string {
  const hay = text.toLowerCase();
  let at = -1;
  for (const n of needles) { const i = hay.indexOf(n); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return text.slice(0, 160).trim();
  const from = Math.max(0, at - 60);
  return (from > 0 ? '…' : '') + text.slice(from, from + 160).trim() + (from + 160 < text.length ? '…' : '');
}

export function searchDocs(chunks: DocChunk[], q: string, limit = 40): DocHit[] {
  const query = q.trim();
  if (!query) return [];
  const lower = query.toLowerCase();
  const tokens = tokenise(query);
  if (!tokens.length) return [];
  const multi = tokens.length > 1;

  const hits: DocHit[] = [];
  for (const chunk of chunks) {
    const heading = chunk.heading.toLowerCase();
    const text = chunk.text.toLowerCase();
    let s: number;

    if (multi) {
      // Every token must be present somewhere in this slice — heading or body. Co-presence within one
      // heading-sized chunk is a real signal; across a whole 700-line chapter it would not be, which is
      // the other reason the unit is a heading.
      const both = `${heading} ${text}`;
      if (!tokens.every((t) => both.includes(t))) continue;
      const inHeading = tokens.every((t) => heading.includes(t));
      s = (inHeading ? 600 : BODY_BASE) + (both.includes(lower) ? PHRASE_BONUS : 0);
    } else {
      const headingScore = chunk.heading ? score(query, chunk.heading) : -1;
      const docScore = score(query, chunk.doc) - 120;   // the page title is context, not the answer
      s = Math.max(headingScore, docScore, text.includes(lower) ? BODY_BASE : -1);
      if (s < 0) continue;
    }

    if (chunk.audience === 'contributor') s -= CONTRIBUTOR_PENALTY;
    hits.push({ chunk, s, excerpt: excerptAround(chunk.text, multi ? tokens : [lower]) });
  }
  hits.sort((a, b) => b.s - a.s || a.chunk.doc.localeCompare(b.chunk.doc));
  return hits.slice(0, limit);
}

// ── The index, fetched once per window ────────────────────────────────────────────────────────────────
// One IPC round-trip, cached for the window's life, and the in-flight promise is shared so the Docs
// Browser and the Help modal opening together do not each pull a megabyte. Main caches it too, so a
// second window is nearly free.
let cache: DocChunk[] | null = null;
let inFlight: Promise<DocChunk[]> | null = null;

export function loadDocIndex(): Promise<DocChunk[]> {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = window.artlux.docsSearchIndex()
    .then((chunks) => { cache = chunks ?? []; inFlight = null; return cache; })
    // A failure here must never break the surface that asked: the Help modal still has its 226 registry
    // entries, and the Docs Browser still has its tree. Search degrades to "no doc results", not a crash.
    .catch(() => { inFlight = null; return []; });
  return inFlight;
}
