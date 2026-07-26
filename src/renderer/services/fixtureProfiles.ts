import type { FixtureProfile, FixtureProfileSummary } from '../../../shared/protocol';

// Renderer-side resolver for DMX fixture profiles.
//
// A `Fixture` stores only a `profileId`. This is where that id becomes a profile, from three places,
// highest priority first:
//
//   1. THE PROJECT   — profiles embedded in the .artlux (ProjectData.fixtureProfiles). A project is
//                      portable, so it carries the profiles it uses; on a venue PC whose library is
//                      older, or which never had the operator's hand-authored profile, these are the
//                      only copy that exists.
//   2. THE OPERATOR  — userData/fixture-profiles, merged into the library index by main.
//   3. THE BUNDLE    — the generated library shipped with the app.
//
// (2) and (3) both arrive over `fixtureLibrary:get`, already layered by main. This module only has to
// keep (1) on top of that.
//
// WHY A CACHE AT ALL. The library is ~4 MB across one file per manufacturer, so it is fetched lazily
// and per manufacturer: patching a Martin fixture pulls `martin.json` once and every other Martin
// fixture in the rig is then free. Nothing here ever loads the whole library.

let embedded = new Map<string, FixtureProfile>();   // (1) — from the open project
const fetched = new Map<string, FixtureProfile>();  // (2)+(3) — from main, by profile id
const pending = new Map<string, Promise<void>>();   // in-flight manufacturer fetches
const missing = new Set<string>();                  // ids we asked for and main did not have

let resolved: ReadonlyMap<string, FixtureProfile> = new Map();
const subs = new Set<() => void>();

function rebuild(): void {
  const next = new Map(fetched);
  for (const [id, p] of embedded) next.set(id, p);   // the project always wins
  resolved = next;
  subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[fixture-profiles] sub error', e); } });
}

/** Every resolved profile, by id. A stable reference between changes, so it is safe as a dep. */
export function snapshot(): ReadonlyMap<string, FixtureProfile> { return resolved; }

export function get(id: string): FixtureProfile | undefined { return resolved.get(id); }

export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/**
 * Adopt the profiles embedded in a project being opened. Replaces the previous project's set —
 * these are per-document, not accumulated, or a profile from a closed show would keep shadowing the
 * library for the rest of the session.
 */
export function setEmbedded(profiles: FixtureProfile[] | undefined): void {
  embedded = new Map((profiles ?? []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  rebuild();
}

/**
 * Make sure every id is resolved, fetching whatever is missing (one request per manufacturer).
 * Safe to call on every fixture change: ids already resolved or already in flight cost nothing.
 */
export async function ensureLoaded(ids: Iterable<string>): Promise<void> {
  const keys = new Set<string>();
  for (const id of ids) {
    if (!id || resolved.has(id) || missing.has(id)) continue;
    const key = id.split('/')[0];
    if (key) keys.add(key);
  }
  if (!keys.size) return;

  await Promise.all([...keys].map((key) => {
    const inflight = pending.get(key);
    if (inflight) return inflight;
    const job = (async () => {
      try {
        const list = await window.artlux?.fixtureLibraryGet?.(key);
        for (const p of list ?? []) if (p && typeof p.id === 'string') fetched.set(p.id, p);
      } catch (e) {
        // The library is a convenience: a fixture can always be patched by hand, and an unresolved
        // profile is already handled everywhere (footprint 0, packer writes nothing). Never throw
        // into a render or a project load.
        console.error(`[fixture-profiles] failed to load manufacturer "${key}"`, e);
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, job);
    return job;
  }));

  // Remember what genuinely is not there, so a rig with a stale id does not re-request it on every
  // fixture edit for the rest of the session.
  for (const id of ids) if (id && !fetched.has(id) && !embedded.has(id)) missing.add(id);
  rebuild();
}

/**
 * Drop the cached catalogue so the next index() re-reads it. Called after importing a profile —
 * without it a freshly imported fixture would not appear until a restart.
 */
export function invalidateIndex(): void { indexCache = null; }

/** The catalogue, for the picker and the "add by reference" search. Loaded once. */
let indexCache: FixtureProfileSummary[] | null = null;
export async function index(): Promise<FixtureProfileSummary[]> {
  if (indexCache) return indexCache;
  try {
    indexCache = (await window.artlux?.fixtureLibraryIndex?.()) ?? [];
  } catch (e) {
    console.error('[fixture-profiles] failed to load the library index', e);
    indexCache = [];
  }
  return indexCache;
}

/**
 * The profiles a set of fixtures actually uses — what gets written into the project on save.
 * Only the ones in use, so the file stays small.
 */
export function usedBy(fixtures: Array<{ profileId?: string }>): FixtureProfile[] {
  const out = new Map<string, FixtureProfile>();
  for (const f of fixtures) {
    if (!f.profileId) continue;
    const p = resolved.get(f.profileId);
    if (p) out.set(p.id, p);
  }
  return [...out.values()];
}

/**
 * The starting `dmx` values for a profile — every channel at its authored default.
 *
 * A profiled fixture MUST be created with this. `setByPath` deliberately refuses to fabricate a
 * missing nested container (the guard that stopped a cue corrupting `segments`), so a fixture whose
 * `dmx` object does not exist silently ignores every cue, lane and scene aimed at its channels —
 * with no error anywhere. Seeding once at assign time removes the whole failure mode.
 */
export function seedValues(profile: FixtureProfile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of profile.channels) out[c.key] = c.default;
  return out;
}
