import React, { useCallback, useEffect, useState } from 'react';
import type { AppInfo, BootReport } from '../../../../shared/protocol';
import {
  APP_TAGLINE, APP_EXPLAINER, AUTHORS_LINE, CREDIT_LABEL, LICENSE_HEADLINE, LICENSE_DEPS,
} from '../../../../shared/credits';
import { AppWordmark } from '../brand/AppMark';
import { BootConsole } from './BootConsole';

// THE STARTUP SPLASH, as the operator sees it. Four bands, top to bottom:
//
//   identity   the generated wordmark + version — the mark, never the name typed out (DESIGN-SYSTEM §7)
//   explainer  what this program is, for the person who inherited the venue PC and doesn't know
//   console    what actually loaded (BootConsole) — the reason this screen is worth its seconds
//   credits    the authors, and the licence restriction
//
// The credits and the licence line are NOT decoration: LICENSE §3 requires a build to show them, and
// they come from shared/credits.ts so this window cannot drift from the About dialog.
//
// Lifecycle is main's, not ours (main/splashWindow.ts): it decides when the editor is really up and the
// report is complete, then asks for the exit fade. This component only renders, and offers a dismiss.

export const SplashScreen: React.FC = () => {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [report, setReport] = useState<BootReport>({ entries: [], mainDone: false, rendererDone: false });
  const [exiting, setExiting] = useState(false);

  const dismiss = useCallback(() => {
    setExiting(true);
    window.artlux?.splashDismiss?.();
  }, []);

  useEffect(() => {
    window.artlux?.getAppInfo?.().then(setInfo).catch(() => { /* version is nice-to-have, not load-bearing */ });
    // Idempotent full snapshots — render whatever arrives, never reassemble a stream.
    const unsub = window.artlux?.onBootReport?.((r) => setReport(r));
    const unsubFade = window.artlux?.onSplashFadeOut?.(() => setExiting(true));
    // Tell main we're listening: the main-process plugins may have finished activating before this
    // bundle even parsed, in which case there is nothing left to push and we'd render an empty console.
    window.artlux?.splashReady?.();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => { unsub?.(); unsubFade?.(); window.removeEventListener('keydown', onKey); };
  }, [dismiss]);

  return (
    // The whole surface dismisses. It is also a real <button> below for keyboard/AT, because a
    // click-anywhere <div> is unreachable without a mouse.
    <div
      role="dialog"
      aria-label="ARTLux startup"
      onClick={dismiss}
      className={`h-screen w-screen flex flex-col p-6 bg-surface-0 border border-line-2 select-none cursor-pointer
        transition-opacity duration-med ${exiting ? 'opacity-0' : 'opacity-100'}`}
    >
      {/* ── Identity ─────────────────────────────────────────────────────────────────────────── */}
      {/* shrink-0 on every band except the console: in a fixed-height flex column the LAST child is
          what gets crushed, and that was the dismiss hint — present in the DOM, zero pixels tall. */}
      <div className="animate-modal-in shrink-0">
        <div className="flex items-end justify-between gap-4">
          {/* The mark IS the title — the app never types its own name (DESIGN-SYSTEM §7). */}
          <AppWordmark height={26} className="text-fg-1" />
          {/* Dim tier is allowed here because this is 12px; it is barred from the 10–11px rows below. */}
          <div className="font-mono text-xs text-fg-3 tabular-nums">v{info?.version ?? '—'}</div>
        </div>
        <div className="mt-2 text-xs text-fg-2">{APP_TAGLINE}</div>
        {/* max-w caps the measure so the eye doesn't have to travel the full 712px back on a 12px line.
            74ch (not 62) sets it in two lines instead of three, which is a whole console row given back. */}
        <p className="mt-1 text-xs text-fg-2 leading-relaxed max-w-[74ch]">{APP_EXPLAINER}</p>
      </div>

      {/* ── What loaded ──────────────────────────────────────────────────────────────────────── */}
      {/* The console is the ONLY band that flexes: it takes whatever the identity and credits leave. */}
      <div className="mt-4 flex-1 min-h-0">
        <BootConsole report={report} />
      </div>

      {/* ── Credits + licence ───────────────────────────────────────────────────────────────── */}
      <div className="shrink-0 mt-3 pt-3 border-t border-line-1 flex items-end justify-between gap-6">
        <div className="min-w-0">
          <div className="text-micro uppercase tracking-wider text-fg-2">{CREDIT_LABEL}</div>
          {/* fg-1 + medium: the names are the point of this band, so they get the primary tier. */}
          <div className="mt-0.5 text-xs font-medium text-fg-1">{AUTHORS_LINE}</div>
        </div>
        {/* A legal statement is not a caption — it stays at 12px on the readable tier, right-aligned
            against the credit so the two read as one line of provenance. */}
        <div className="text-right text-xs text-fg-2 leading-relaxed max-w-[54ch]">
          <div>{LICENSE_HEADLINE}</div>
          <div className="mt-0.5">{LICENSE_DEPS}</div>
        </div>
      </div>

      <div className="shrink-0 mt-2 flex justify-end">
        <button
          type="button"
          onClick={dismiss}
          // Text-only, no chrome: it is an escape hatch, not an action to draw the eye. It still gets
          // the global focus ring and the hover film, so keyboard users can see and use it.
          className="text-xs text-fg-2 rounded-sm px-1"
        >
          Click anywhere or press Esc to continue
        </button>
      </div>
    </div>
  );
};
