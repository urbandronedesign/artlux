import type { FixtureProfileSummary } from '../types';

// "Add a fixture by typing its reference" — the matcher behind the library picker.
//
// The reference an operator has in hand is whatever is printed on the case, the invoice or the
// rider: `Martin MAC 250 Krypton`, `MAC250`, `mac 250 krypton`, `Intimidator Spot 375Z IRC`. All of
// those must find the same fixture, so matching is done on a NORMALISED form (lowercased, every
// non-alphanumeric removed) across the model, the manufacturer, the two together, and the profile's
// `aliases` — which the library generator seeds with short names and the names of fixtures that were
// later renamed. Without that normalisation, `MAC250` matches nothing and the library reads as
// though it simply lacked the fixture.

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export interface SearchHit {
  row: FixtureProfileSummary;
  score: number;
}

// Every normalised string a row can be found by. Built once per row and cached on the row's identity
// — the index is loaded once and never mutated, so a WeakMap keyed on it is safe and free.
const haystacks = new WeakMap<FixtureProfileSummary, string[]>();

function keysOf(row: FixtureProfileSummary): string[] {
  const cached = haystacks.get(row);
  if (cached) return cached;
  const set = new Set<string>();
  const add = (s?: string) => { if (s) { const n = norm(s); if (n) set.add(n); } };
  add(row.model);
  add(row.manufacturer);
  add(`${row.manufacturer} ${row.model}`);
  for (const a of row.aliases ?? []) add(a);
  const keys = [...set];
  haystacks.set(row, keys);
  return keys;
}

/**
 * Rank the library against a typed reference.
 *
 * Scoring is deliberately blunt — exact, then prefix, then substring — because the alternative
 * (fuzzy/edit-distance) reorders near-identical model numbers, and `MAC 250` vs `MAC 250 Krypton` vs
 * `MAC 250 Wash` are three different lights whose relative order must be predictable rather than
 * clever. Ties break on manufacturer then model, so the list never reshuffles between keystrokes.
 */
export function search(index: FixtureProfileSummary[], query: string, limit = 50): FixtureProfileSummary[] {
  const q = norm(query);
  if (!q) {
    return index
      .slice()
      .sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.model.localeCompare(b.model))
      .slice(0, limit);
  }

  const hits: SearchHit[] = [];
  for (const row of index) {
    let best = 0;
    for (const key of keysOf(row)) {
      const score = key === q ? 4 : key.startsWith(q) ? 3 : key.includes(q) ? 2 : 0;
      if (score > best) best = score;
    }
    // A multi-word query ('martin mac250') where each word hits somewhere still counts, one tier
    // below a substring match — this is what makes "manufacturer + model" typed in either order work.
    if (!best) {
      const words = query.split(/\s+/).map(norm).filter(Boolean);
      if (words.length > 1 && words.every((w) => keysOf(row).some((k) => k.includes(w)))) best = 1;
    }
    if (best) hits.push({ row, score: best });
  }

  hits.sort((a, b) => b.score - a.score
    || a.row.manufacturer.localeCompare(b.row.manufacturer)
    || a.row.model.localeCompare(b.row.model));
  return hits.slice(0, limit).map((h) => h.row);
}
