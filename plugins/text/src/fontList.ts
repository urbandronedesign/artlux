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
let error: string | null = null;

interface LocalFontData { family: string }
type QueryLocalFonts = () => Promise<LocalFontData[]>;

/** Why the last attempt produced nothing, or null if it worked. Shown in the picker, never swallowed. */
export function lastError(): string | null { return error; }

/**
 * Installed font families, sorted and de-duplicated.
 *
 * ⚠ CALL THIS FROM A USER GESTURE. `queryLocalFonts()` needs the local-fonts permission (granted in
 * main, so no prompt appears) AND transient user activation — asking on mount, with no click behind
 * it, is rejected. That is precisely how this shipped broken: the effect ran at mount, the promise
 * rejected, and the failure was swallowed into an empty list that looked like "this machine has no
 * fonts". The picker now asks when it is opened, which is a gesture by construction.
 *
 * A FAILURE IS NOT CACHED. Caching `[]` on rejection made the first failure permanent — a later call,
 * gesture and all, returned the empty array without ever retrying. Only a successful read is kept.
 */
export async function families(): Promise<string[]> {
  if (cache) return cache;
  if (inFlight) return inFlight;
  const q = (globalThis as unknown as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof q !== 'function') {
    error = 'this build cannot read the machine’s fonts (queryLocalFonts is unavailable)';
    return [];
  }
  inFlight = q()
    .then((fonts) => {
      const set = new Set<string>();
      for (const f of fonts) if (f?.family) set.add(f.family);   // one entry per FACE; we want families
      cache = [...set].sort((a, b) => a.localeCompare(b));
      error = cache.length ? null : 'the machine reported no fonts';
      return cache;
    })
    .catch((e: unknown) => {
      // Left UNCACHED on purpose — see above. The next open tries again.
      error = e instanceof Error ? e.message : String(e);
      return [];
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Drop the cache so the next `families()` asks again — after installing a font without relaunching. */
export function refresh(): void { cache = null; }

/** What we already know, without awaiting — for a first render that must not suspend. */
export function known(): string[] { return cache ?? []; }

/**
 * Can Chromium actually DRAW this family here?
 *
 * NOT `document.fonts.check()`, which is the obvious answer and a useless one: it returns TRUE for any
 * family name at all — measured here, `check('16px "Zzz No Such Family 9137"')` is true — because with
 * no matching @font-face rule it assumes a system font and reports success. A warning built on it can
 * never fire, which is worse than no warning: it looks like a safety net and is not one.
 *
 * Nor is the machine's font LIST the right question either, and that is the first thing this got
 * wrong. The app's own UI face (IBM Plex Sans, bundled through @fontsource) renders perfectly and
 * appears in no such list, because it is not installed on the machine — it is installed in the
 * DOCUMENT. That told operators their default font was missing while it was plainly on screen.
 *
 * So measure instead. Lay the same string out in the requested family backed by a fallback, and in
 * the bare fallback. Identical metrics mean the family never resolved and the fallback is what drew.
 * Two different fallbacks, because a family whose metrics happen to match ONE of them is not rare —
 * it has to match both to be called missing.
 */
let probe: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
const PROBE_TEXT = 'mmmmmmmmmwwwwwwwww@!#iiiiillll';

export function canRender(family: string): boolean {
  const fam = (family || '').trim().replace(/"/g, '');
  if (!fam) return true;
  try {
    if (!probe) {
      probe = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(8, 8).getContext('2d')
        : document.createElement('canvas').getContext('2d');
    }
    const g = probe;
    if (!g) return true;                       // cannot measure ⇒ say nothing (a false alarm is worse)
    for (const fallback of ['monospace', 'serif']) {
      g.font = `72px ${fallback}`;
      const bare = g.measureText(PROBE_TEXT).width;
      g.font = `72px "${fam}", ${fallback}`;
      if (Math.abs(g.measureText(PROBE_TEXT).width - bare) > 0.5) return true;  // it resolved
    }
    return false;                              // fell back to BOTH ⇒ the family is not here
  } catch { return true; }
}
