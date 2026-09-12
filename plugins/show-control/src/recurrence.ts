// THE ONE SCHEDULING SCHEME, shared by both scheduling layers (the in-project `ScheduleEntry` ticked
// in the renderer and the machine-global `PlaylistEntry` resolved in main). Platform-neutral — no
// node:*, no electron, no react — so both halves import it and neither can drift from the other.
//
// Why this file exists at all: the two layers each carried their own `time + days[]` arithmetic, and
// "days[]" cannot express a one-off ("this Saturday at 20:00"). The playlist resolver additionally
// worked in MINUTE-OF-WEEK, a coordinate in which a calendar date does not exist — so a date could not
// be bolted on, the resolver had to move to absolute time. Everything below is in epoch milliseconds
// for that reason, and every Date is constructed with local-time components (the operator sets a wall
// clock on the show machine; that is the clock the venue runs on).
//
// MIGRATION: none. `repeat` is optional and ABSENT MEANS DERIVED — an entry written before this file
// existed (`days: []` or `days: [1,3]`) resolves byte-identically through `repeatOf()`.

export type RepeatMode =
  | 'daily'   // every day at `time`
  | 'weekly'  // at `time` on each weekday in `days` (empty days behaves as daily — the legacy meaning)
  | 'once';   // at `time` on the single calendar day `date` (YYYY-MM-DD), then never again

// The scheduling half of an entry. Both ScheduleEntry and PlaylistEntry structurally satisfy this.
export interface Recurring {
  time: string;        // "HH:MM", 24h, LOCAL
  days?: number[];     // 0=Sun … 6=Sat (weekly)
  date?: string;       // "YYYY-MM-DD", LOCAL (once)
  repeat?: RepeatMode; // absent = derived from `days` — see repeatOf()
}

// Which scheme an entry is on. The derivation is the whole back-compat story: an old entry has no
// `repeat`, and its `days` already said which of the two old behaviours it wanted.
export function repeatOf(e: Recurring): RepeatMode {
  if (e.repeat === 'daily' || e.repeat === 'weekly' || e.repeat === 'once') return e.repeat;
  return e.days && e.days.length ? 'weekly' : 'daily';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "HH:MM" → minutes since midnight, or null if malformed. A malformed time yields NO occurrences
// anywhere below, which is the safe failure: an unparseable entry never fires rather than firing at
// midnight.
export function parseHM(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// "YYYY-MM-DD" → [y, m0, d] in local terms, or null. Deliberately NOT `new Date(str)`: that parses a
// bare date as UTC midnight, which is the previous local day in every western timezone — a show armed
// for Saturday would have fired on Friday evening.
export function parseYMD(s: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return [y, mo - 1, d];
}

// Local "YYYY-MM-DD" for a Date (the inverse of parseYMD; used to stamp today's date into a new
// one-off and to compare a fire against the calendar).
export function ymd(d: Date): string {
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// Local "HH:MM" for a Date.
export function hm(d: Date): string {
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// Build a local timestamp from calendar components + minutes-past-midnight. Day overflow normalises
// (JS Date semantics), which is what lets the window walk ±N days across month and year boundaries.
function at(y: number, mo: number, d: number, minutes: number): number {
  return new Date(y, mo, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}

// Every fire time of `e` within ±windowDays of `now`, ascending, in epoch ms.
//
// A WINDOW, not an infinite series, because both callers only ever ask two questions — "what was the
// last fire?" and "what is the next?" — and a window keeps a one-off from having to be special-cased
// in the resolver. The default of 8 days preserves the old resolver's behaviour exactly: it looked
// back one full week so that "before the first entry of the week" wrapped to the last entry of the
// previous week.
export function occurrencesNear(e: Recurring, now: Date, windowDays = 8): number[] {
  const minutes = parseHM(e.time);
  if (minutes == null) return [];
  const mode = repeatOf(e);

  if (mode === 'once') {
    const p = parseYMD(e.date || '');
    if (!p) return [];
    const t = at(p[0], p[1], p[2], minutes);
    // A ONE-OFF IS BOUNDED IN THE PAST ONLY, and the asymmetry is deliberate — a symmetric window
    // got both halves wrong at once. Looking forward: it has exactly one occurrence, so there is
    // nothing to bound, and windowing it meant a show booked for next month reported "next: —" on
    // the tablet the moment it was saved (found by scheduling one against the real app). Looking
    // back: it MUST fade, because `due` is "the entry in effect now" and the scheduler relaunches
    // into whatever that is — a one-off that stayed in effect forever would pin the machine to last
    // year's gala. Past the window it simply stops being anyone's answer, and nothing switches.
    if (t > now.getTime()) return [t];
    return now.getTime() - t <= windowDays * 86400000 ? [t] : [];
  }

  // daily / weekly: walk the window day by day in LOCAL calendar terms.
  const days = mode === 'weekly' && e.days && e.days.length ? e.days : null; // null = every day
  const out: number[] = [];
  const y = now.getFullYear(), mo = now.getMonth(), d0 = now.getDate();
  for (let off = -windowDays; off <= windowDays; off++) {
    const t = at(y, mo, d0 + off, minutes);
    if (days && days.indexOf(new Date(t).getDay()) < 0) continue;
    out.push(t);
  }
  return out;
}

// The most recent fire at-or-before `now` (null if the entry has none in the window).
export function lastOccurrence(e: Recurring, now: Date, windowDays = 8): number | null {
  const n = now.getTime();
  let best: number | null = null;
  for (const t of occurrencesNear(e, now, windowDays)) if (t <= n && (best === null || t > best)) best = t;
  return best;
}

// The soonest fire strictly after `now` (null if none in the window — a spent one-off, notably).
export function nextOccurrence(e: Recurring, now: Date, windowDays = 8): number | null {
  const n = now.getTime();
  let best: number | null = null;
  for (const t of occurrencesNear(e, now, windowDays)) if (t > n && (best === null || t < best)) best = t;
  return best;
}

// Does this entry fire in the minute `now` sits in? This is the question the renderer's in-project
// tick asks (it polls every 15 s and de-dupes on the minute), and it must agree with the resolver
// above about what the scheme means — which is exactly why both read `repeatOf`.
export function firesAt(e: Recurring, now: Date): boolean {
  if (e.time !== hm(now)) return false;
  const mode = repeatOf(e);
  if (mode === 'once') return e.date === ymd(now);
  if (mode === 'weekly' && e.days && e.days.length) return e.days.indexOf(now.getDay()) >= 0;
  return true;
}

// "every day" / "Mon Wed Fri" / "once on 2026-09-20" — the scheme in one line, for a list row.
export function describeRepeat(e: Recurring): string {
  const mode = repeatOf(e);
  if (mode === 'once') return e.date ? 'once on ' + e.date : 'once (no date)';
  if (mode === 'weekly' && e.days && e.days.length) {
    return e.days.slice().sort((a, b) => a - b).map((i) => DAY_NAMES[i] || '?').join(' ');
  }
  return 'every day';
}

// "today 18:00" / "tomorrow 09:00" / "Mon 09:00" / "20 Sep 10:00" / "—". A wall-clock time alone is
// ambiguous on a list that mixes schemes ("18:00" — today? Saturday?), and that ambiguity is most of
// what makes an unattended schedule hard to trust.
export function describeWhen(t: number | null, now: Date = new Date()): string {
  if (t == null) return '—';
  const d = new Date(t);
  const at = hm(d);
  const dayDelta = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000,
  );
  if (dayDelta === 0) return 'today ' + at;
  if (dayDelta === 1) return 'tomorrow ' + at;
  if (dayDelta === -1) return 'yesterday ' + at;
  if (dayDelta > 1 && dayDelta < 7) return DAY_NAMES[d.getDay()] + ' ' + at;
  return ymd(d) + ' ' + at;
}

// Is this a one-off whose moment has passed? Such an entry is inert, and saying so on the row is the
// difference between "why is this not firing" and "of course, it already ran".
export function isSpent(e: Recurring, now: Date = new Date()): boolean {
  if (repeatOf(e) !== 'once') return false;
  const p = parseYMD(e.date || '');
  if (!p) return true; // a one-off with no date can never fire
  const minutes = parseHM(e.time);
  if (minutes == null) return true;
  return at(p[0], p[1], p[2], minutes) <= now.getTime();
}
