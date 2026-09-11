// WHICH FONTS THIS MACHINE HAS — Chromium's own answer, not ours.
//
// `queryLocalFonts()` (the Local Font Access API) is used rather than enumerating in the main process,
// and the reason is correctness rather than convenience. What actually draws the type is
// `ctx.font = '... "Family"'`, resolved by Chromium's font matcher. A directory or registry scan in
// main returns FILE names, or names read out of the font binary, and neither is guaranteed to be a
// string that matcher will accept — so a picker built on one can offer a family that then silently
// renders as the fallback. This asks the thing that will do the matching.
//
// The permission is granted in main (grantMediaPermissions), so no dialog appears: an unattended venue
// machine must never stop on a prompt nobody is there to answer.
//
// EVERY FAILURE DEGRADES TO "TYPE THE NAME". The API is absent on some builds, can reject, and returns
// nothing useful in a projector window. None of that should cost the operator the control — the field
// stays free text, and the list is only ever an aid, which is also why a project may name a family
// this machine does not have: the show is going somewhere else.

let cache: string[] | null = null;
let inFlight: Promise<string[]> | null = null;

interface LocalFontData { family: string }
type QueryLocalFonts = () => Promise<LocalFontData[]>;

/**
 * Installed font families, sorted, de-duplicated. Empty when the machine will not say — never throws.
 *
 * Cached for the life of the window: enumerating is not free, and a font installed while the app is
 * running is rare enough to be worth a relaunch. `refresh()` exists for when it is not.
 */
export async function families(): Promise<string[]> {
  if (cache) return cache;
  if (inFlight) return inFlight;
  const q = (globalThis as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof q !== 'function') { cache = []; return cache; }
  inFlight = q()
    .then((fonts) => {
      // One entry per FACE comes back (Regular, Bold, Italic…); the picker wants families.
      const set = new Set<string>();
      for (const f of fonts) if (f?.family) set.add(f.family);
      cache = [...set].sort((a, b) => a.localeCompare(b));
      return cache;
    })
    .catch(() => { cache = []; return cache; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Drop the cache so the next `families()` asks again — after installing a font without relaunching. */
export function refresh(): void { cache = null; }

/** What we already know, without awaiting — for a first render that must not suspend. */
export function known(): string[] { return cache ?? []; }
