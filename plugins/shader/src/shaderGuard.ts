// The two things that stand between an author's mistake and a dead machine.
//
// A fragment shader is arbitrary GPU code. No other content source can do what a bad one does: an
// unbounded loop is not a slow surface, it is a driver reset that takes the whole machine — every
// window, the show, every projector output. That risk was always in the plan; what made it urgent is
// the audience. Written for one expert this is a text box. Shipped to anyone using ArtLux, someone
// WILL write `while (true)`, and they will do it on the machine running the show.
//
// Neither of these is a sandbox and neither may ever be described as one. They are a lint that catches
// the common accident before it reaches the driver, and a budget that notices when something got past.

// ── 1 · the loop lint ────────────────────────────────────────────────────────────────────────────
// GLSL ES 3.00 permits genuinely unbounded loops, and the compiler will happily accept one. We reject
// the shapes that cannot terminate on their own, by inspection, before the source reaches the driver.
//
// Deliberately CRUDE and deliberately conservative. It reads text, so a determined author defeats it
// in a minute; it exists to stop the accident, not the adversary. It errs toward allowing — a false
// rejection of working code is a bug report and a lost afternoon, while the loops it does catch are
// the ones people actually type by mistake.

const STRIP_STRINGS = /"(?:[^"\\]|\\.)*"/g;

/** Author source with comments and strings removed, so a `// while (true)` note cannot trip the lint. */
function bare(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(STRIP_STRINGS, ' ');
}

export interface LintProblem {
  line: number;   // 1-based, in the AUTHOR's file
  message: string;
}

/**
 * Loops with no compile-time bound. Three shapes:
 *   while (true) / while (1)        — never exits unless the body breaks, and we cannot see that it does
 *   for (;;)                        — same, spelled differently
 *   for (…; …; ) with no increment  — the classic typo: the counter never moves
 *
 * A `break` anywhere inside the function is accepted as evidence of an exit, because proving otherwise
 * needs a parser and the cost of being wrong falls on someone writing correct code.
 */
export function lintLoops(source: string): LintProblem[] {
  const src = bare(source);
  const problems: LintProblem[] = [];
  const lineOf = (idx: number) => src.slice(0, idx).split('\n').length;

  /**
   * Does THIS loop's own body contain an exit?
   *
   * The first version of this asked whether the FILE contained a `break` or a `return` anywhere, and
   * that made the whole lint dead on arrival: every fragment shader ends in `return vec4(...)`, so
   * every loop was excused. It shipped, and a `while (true)` sailed straight past it into the driver —
   * where ANGLE's own compiler happened to reject it ("Infinite loop detected in the shader"). That
   * catch is a gift from one backend, not a guarantee: it is a D3D compiler behaviour, and the shader
   * would have reached the GPU on a driver that does not check.
   *
   * So the question has to be about the loop's OWN body, brace-matched from its header.
   */
  const bodyHasExit = (from: number): boolean => {
    const open = src.indexOf('{', from);
    if (open < 0) {
      // A single-statement body: `while (true) x += 1.0;` — everything up to the semicolon.
      const semi = src.indexOf(';', from);
      const stmt = semi < 0 ? src.slice(from) : src.slice(from, semi + 1);
      return /\b(break|return|discard)\b/.test(stmt);
    }
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return /\b(break|return|discard)\b/.test(src.slice(open, i + 1));
    }
    return true; // unbalanced braces — the compiler will complain properly; don't guess
  };

  const flag = (idx: number, message: string) => {
    if (!bodyHasExit(idx)) problems.push({ line: lineOf(idx), message });
  };

  for (const m of src.matchAll(/\bwhile\s*\(\s*(true|1)\s*\)/g)) {
    flag((m.index ?? 0) + m[0].length, 'while(true) with no break — this can hang the GPU');
  }
  for (const m of src.matchAll(/\bfor\s*\(\s*;\s*;\s*\)/g)) {
    flag((m.index ?? 0) + m[0].length, 'for(;;) with no break — this can hang the GPU');
  }
  // for (init ; cond ; <empty>) — split on the header's own semicolons.
  for (const m of src.matchAll(/\bfor\s*\(([^)]*)\)/g)) {
    const parts = (m[1] ?? '').split(';');
    if (parts.length === 3 && parts[1].trim() !== '' && parts[2].trim() === '') {
      flag((m.index ?? 0) + m[0].length, 'for loop never advances its counter — this can hang the GPU');
    }
  }
  return problems;
}

// ── 2 · the frame budget ─────────────────────────────────────────────────────────────────────────
// What the lint missed still has to be survivable. A shader that takes too long is not stopped
// mid-draw — nothing can do that from here — but it can be stopped from being drawn AGAIN.
//
// The budget is per consumer and generous: at 30 Hz a frame is 33 ms and the whole engine has to fit
// in it, so a single surface eating 16 ms is already pathological. It must be consecutive, because one
// slow frame is a garbage collection, a window resize, or a shader compiling somewhere else — and
// disabling a live surface over a hiccup would be its own outage.

const BUDGET_MS = 16;
const STRIKES = 30; // ~1 second of sustained overrun at 30 Hz

interface Health { strikes: number; disabled: boolean }
const health = new Map<string, Health>();

/** Record a draw. Returns true when this consumer has just been disabled. */
export function noteDraw(key: string, ms: number): boolean {
  let h = health.get(key);
  if (!h) { h = { strikes: 0, disabled: false }; health.set(key, h); }
  if (h.disabled) return false;
  if (ms > BUDGET_MS) {
    h.strikes++;
    if (h.strikes >= STRIKES) { h.disabled = true; return true; }
  } else {
    h.strikes = 0;
  }
  return false;
}

export function isDisabled(key: string): boolean {
  return health.get(key)?.disabled === true;
}

/** Re-arm after an edit — a new compile deserves a fresh chance, or a fixed shader stays dead. */
export function rearm(key: string): void {
  health.delete(key);
}

export const BUDGET = { ms: BUDGET_MS, strikes: STRIKES };
