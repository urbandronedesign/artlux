// THE BAKE PANEL — pick a surface, a range and a size, get a file.
//
// Deliberately plain for this first slice: it is a form and a progress line, not a wizard. The
// interesting behaviour is all refusals, and they are shown as sentences rather than a disabled
// button, because "this surface cannot be baked" is only useful if it says why.

import React, { useCallback, useEffect, useState } from 'react';
import type { Surface } from '@/types';
import { SourceType } from '@/types';
import type { BakeProgress, BakeResult, BakeSuccess } from './types';
import * as runner from './bakeRunner';
import { getBakeHost } from './bakeHost';
import * as bakeStore from '@/services/bakeStore';
import { timeline } from '@/services/timeline';
import type { BakeEntry } from '@/types';

/** The bound document's key — what signatureOf folds in for timeline-fed content. */
const timelinePoolKey = (): string => timeline.activePoolKey();

/**
 * The range the timeline is actually set to render: its IN and OUT points, or the whole document when
 * none are set (timelineStart/timelineEnd already resolve that, including the degenerate out <= in case).
 *
 * Which document depends on the clock, and they are genuinely different questions: a timeline-fed
 * surface is addressed by the BOUND document's playhead, while a generative one rides the SHOW clock,
 * whose bounds are the global document's. Reading the wrong one gives a range that looks plausible and
 * renders the wrong part of the show.
 */
function timelineRange(timelineFed: boolean): { start: number; end: number } {
  return timelineFed
    ? { start: timeline.getStart(), end: timeline.getEnd() }
    : { start: timeline.getGlobalStart(), end: timeline.getGlobalEnd() };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

const NUM = 'w-full rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1';
const LBL = 'mb-0.5 block text-micro text-fg-2';

/** Remaining time, in the coarsest unit that is still honest — nobody waits on "217s". */
function eta(framesLeft: number, rate: number): string {
  const secs = Math.max(0, Math.round(framesLeft / rate));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Why this surface cannot be rendered, in one sentence, or null when it can. */
function whyNot(s: Surface | undefined): string | null {
  if (!s) return 'Select a surface.';
  const t = s.content.type;
  if (t === SourceType.SLICE) return 'This is a slice. Bake the surface it crops instead, so the split stays adjustable.';
  if (t === SourceType.CAMERA || t === SourceType.DMX_IN) return 'This is a live source — stepping the clock does not move it.';
  if (t === SourceType.NONE) return 'This surface has no content.';
  return null;
}

export const BakePanel: React.FC = () => {
  const host = getBakeHost();

  // SUBSCRIBE, don't snapshot. The first cut read host.surfaces.list() inside a useMemo keyed on the
  // host — which never changes — so the panel captured whatever existed at mount. On a project that
  // had not finished opening that is an EMPTY list, and an empty list means no surface is selected,
  // which means the button is disabled forever with "Select a surface." showing. The service has a
  // subscribe() for exactly this; not using it was the bug.
  const [surfaces, setSurfaces] = useState<Surface[]>(() => (host?.surfaces.list() as Surface[] | undefined) ?? []);
  const [sceneName, setSceneName] = useState<string | null>(null);

  useEffect(() => {
    if (!host) return;
    const readSurfaces = () => setSurfaces((host.surfaces.list() as Surface[] | undefined) ?? []);
    const readScene = () => {
      const id = host.show.getStatus().activeSceneId;
      const scenes = host.show.getScenes() as Array<{ id: string; name?: string }>;
      setSceneName(id ? (scenes.find((sc) => sc.id === id)?.name ?? id) : null);
    };
    readSurfaces();
    readScene();
    const offSurfaces = host.surfaces.subscribe(readSurfaces);
    const offShow = host.show.subscribe(readScene);
    return () => { offSurfaces(); offShow(); };
  }, [host]);

  const [surfaceId, setSurfaceId] = useState<string>('');
  // Re-read on every document change, so a finished render and a bypass toggle both show immediately.
  const [bakeRev, setBakeRev] = useState(0);
  useEffect(() => {
    if (!host) return;
    return host.bakes.subscribe(() => setBakeRev((n) => n + 1));
  }, [host]);

  // Keep the selection pointing at something that exists: surfaces arrive after mount on a cold open,
  // and one can be deleted while this panel is showing.
  useEffect(() => {
    if (surfaces.length === 0) { if (surfaceId) setSurfaceId(''); return; }
    if (surfaces.some((sf) => sf.id === surfaceId)) return;
    // Prefer a surface that can ACTUALLY be baked. Landing on the first one in the rig means a project
    // whose first surface happens to be a timeline track opens this panel already refusing, which
    // reads as the feature being broken rather than as that one surface being ineligible.
    const first = surfaces.find((sf) => whyNot(sf) === null) ?? surfaces[0];
    setSurfaceId(first.id);
  }, [surfaces, surfaceId]);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(10);
  const [fps, setFps] = useState(30);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1080);
  const [mbps, setMbps] = useState(20);
  const [clock, setClock] = useState<'show' | 'playhead'>('show');
  const [withAudio, setWithAudio] = useState(true);
  const [intoProject, setIntoProject] = useState(true);
  // Follow the timeline's in/out until the operator types a range of their own. A panel that kept
  // re-imposing the timeline would fight anyone entering a number; one that never followed it would
  // make setting in/out — the thing you do to choose what to render — have no effect here.
  const [followInOut, setFollowInOut] = useState(true);
  // Same idea for the rate and size: follow the material until told otherwise.
  const [followRate, setFollowRate] = useState(true);
  const [progress, setProgress] = useState<BakeProgress | null>(null);
  const [result, setResult] = useState<BakeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const surface = surfaces.find((s) => s.id === surfaceId);
  const blocked = whyNot(surface);
  const timelineFed = surface?.content.type === SourceType.LAYER || surface?.content.type === SourceType.PROGRAM;
  // bakeRev is read so this recomputes when the document's bakes change; the value itself is unused.
  void bakeRev;
  const existing = surface ? (host?.bakes.forSurface(surface.id) as BakeEntry | undefined) : undefined;
  // Stale is not an error — it is the fingerprint doing its job. Say so rather than silently ignoring.
  const stale = !!(existing && surface
    && existing.contentSig !== bakeStore.signatureOf(surface.content, timelinePoolKey()));
  const frames = Math.max(0, Math.round((endSec - startSec) * fps));
  // Narrowed with a statement rather than inline in the JSX: easier to read, and the discriminant is
  // a string because this tsconfig has no strictNullChecks and boolean literals do not narrow without
  // it (see types.ts).
  let done: BakeSuccess | null = null;
  let refused: string | null = null;
  if (result) {
    if (result.kind === 'ok') done = result;
    else refused = result.reason;
  }

  // Re-read whenever the answer could have changed: a different surface can change WHICH clock the
  // range is measured on, and a scene recall swaps the bound document outright.
  useEffect(() => {
    if (!followInOut) return;
    const fed = surface?.content.type === SourceType.LAYER || surface?.content.type === SourceType.PROGRAM;
    const r = timelineRange(fed);
    setStartSec(round2(r.start));
    setEndSec(round2(r.end));
  }, [followInOut, surfaceId, sceneName, surface]);

  // What is actually IN the range, natively — the only honest basis for a rate and a size. Re-surveyed
  // as the range moves, and polled briefly because a codec cannot answer until it has opened the file.
  const [survey, setSurvey] = useState<runner.SourceSurvey | null>(null);
  useEffect(() => {
    if (!surface) { setSurvey(null); return; }
    let alive = true;
    const read = () => { if (alive) setSurvey(runner.surveySources(surface, startSec, endSec)); };
    read();
    const t = window.setInterval(read, 1000);
    const stop = window.setTimeout(() => window.clearInterval(t), 6000);
    return () => { alive = false; window.clearInterval(t); window.clearTimeout(stop); };
  }, [surface, startSec, endSec]);

  // Follow the material until the operator types a rate of their own.
  useEffect(() => {
    if (!followRate || !survey) return;
    setFps(Math.max(1, Math.round(survey.suggestedFps)));
    if (survey.size) { setWidth(survey.size.width); setHeight(survey.size.height); }
  }, [followRate, survey]);

  const useInOut = useCallback(() => {
    const fed = surface?.content.type === SourceType.LAYER || surface?.content.type === SourceType.PROGRAM;
    const r = timelineRange(fed);
    setStartSec(round2(r.start));
    setEndSec(round2(r.end));
    setFollowInOut(true);
  }, [surface]);

  const start = useCallback(async () => {
    setBusy(true); setResult(null); setProgress(null);
    try {
      const r = await runner.run(
        { surfaceId, startSec, endSec, fps, width, height, clock, bitrate: Math.round(mbps * 1e6), audio: withAudio, intoProject },
        surfaces,
        setProgress,
      );
      setResult(r);
    } finally {
      setBusy(false); setProgress(null);
    }
  }, [surfaceId, startSec, endSec, fps, width, height, clock, mbps, withAudio, intoProject, surfaces]);

  // h-full + overflow-y-auto is the dock convention (ShowControlDeck, PlaylistPanel, ZonePanel).
  // Without it a tall panel in a short dock strip simply CLIPS: the surface picker and the scene banner
  // sat above the visible area with no way to reach them, so the only thing an operator could see was a
  // refusal about a surface they could not change.
  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2 text-micro text-fg-1">
      <div className="rounded border border-line-1 bg-surface-0 p-1.5 text-fg-2">
        {sceneName
          ? <>Baking the scene that is live now: <span className="text-fg-1">{sceneName}</span>.</>
          : <>No scene is active — baking the global document.</>}
        {' '}Recall a different scene to bake that one; a render always reads the live look.
      </div>

      <div>
        <label className={LBL}>Surface</label>
        <select className={NUM} value={surfaceId} onChange={(e) => setSurfaceId(e.target.value)} disabled={busy}>
          {surfaces.length === 0 && <option value="">No surfaces</option>}
          {surfaces.map((s) => (
            <option key={s.id} value={s.id}>
              {whyNot(s) ? '— ' : ''}{s.name || s.id} · {String(s.content.type)}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div><label className={LBL}>Start (s)</label>
          <input type="number" step="0.1" className={NUM} value={startSec} disabled={busy}
            onChange={(e) => { setStartSec(Number(e.target.value)); setFollowInOut(false); }} /></div>
        <div><label className={LBL}>End (s)</label>
          <input type="number" step="0.1" className={NUM} value={endSec} disabled={busy}
            onChange={(e) => { setEndSec(Number(e.target.value)); setFollowInOut(false); }} /></div>
        <div><label className={LBL}>Frame rate</label>
          <input type="number" className={NUM} value={fps} disabled={busy}
            onChange={(e) => { setFps(Number(e.target.value)); setFollowRate(false); }} /></div>
        <div><label className={LBL}>Bitrate (Mb/s)</label>
          <input type="number" className={NUM} value={mbps} disabled={busy}
            onChange={(e) => setMbps(Number(e.target.value))} /></div>
        <div><label className={LBL}>Width</label>
          <input type="number" className={NUM} value={width} disabled={busy}
            onChange={(e) => { setWidth(Number(e.target.value)); setFollowRate(false); }} /></div>
        <div><label className={LBL}>Height</label>
          <input type="number" className={NUM} value={height} disabled={busy}
            onChange={(e) => { setHeight(Number(e.target.value)); setFollowRate(false); }} /></div>
      </div>

      {survey && (survey.files.length > 0 ? (
        <div className="rounded border border-line-1 bg-surface-0 p-1.5 text-fg-2">
          <div>
            {survey.files.length} source{survey.files.length === 1 ? '' : 's'} in range ·{' '}
            {survey.rates.map((r) => `${r}fps`).join(', ')}
            {survey.size && ` · up to ${survey.size.width}x${survey.size.height}`}
          </div>
          {survey.incompatible ? (
            <div className="text-fg-1">
              These rates are not multiples of one another, so no single output rate is lossless — one
              of them will judder whichever you pick.
            </div>
          ) : survey.rates.length > 1 ? (
            <div>
              Rendering at {Math.max(...survey.rates)}fps keeps all of them; a lower rate would discard
              frames the faster source has.
            </div>
          ) : (
            <div>Matching it exactly — nothing gained by rendering faster, nothing lost by not.</div>
          )}
        </div>
      ) : (
        <div className="text-fg-3">
          No video in range — this content is generative, so it has no native rate and any rate renders
          it truthfully. Defaulting to the document&apos;s {Math.round(timeline.getFps())}fps.
        </div>
      ))}

      {(width % 2 !== 0 || height % 2 !== 0) && (
        <div className="text-fg-2">
          H.264 needs even dimensions — this will render at {width - (width % 2)}×{height - (height % 2)}.
        </div>
      )}

      <div>
        <label className={LBL}>Clock</label>
        {timelineFed ? (
          <div className="rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-fg-2">
            Playhead — a timeline-fed surface is addressed by its document, not the show clock.
          </div>
        ) : (
          <select className={NUM} value={clock} disabled={busy}
            onChange={(e) => setClock(e.target.value as 'show' | 'playhead')}>
            <option value="show">Show clock (generative content)</option>
            <option value="playhead">Playhead (timeline-bound content)</option>
          </select>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-fg-2">
          {followInOut ? 'Range follows in/out' : 'Range set by hand'}
          {' · '}
          {followRate ? 'rate follows the material' : 'rate set by hand'}
        </span>
        <button type="button" disabled={busy}
          className="rounded border border-line-1 px-1.5 py-0.5 text-micro text-fg-2 disabled:opacity-40"
          onClick={() => { useInOut(); setFollowRate(true); }}>Match timeline</button>
      </div>

      <label className="flex cursor-pointer items-center gap-1.5 text-fg-1">
        <input type="checkbox" checked={intoProject} disabled={busy}
          onChange={(e) => setIntoProject(e.target.checked)}
          className="cursor-pointer rounded border-line-2 bg-surface-0 text-accent" />
        Keep with the project (assets/video)
      </label>
      {intoProject && (
        <div className="text-fg-3">
          Written straight into the project folder, so it travels with the show and Collect Assets finds
          it. Uncheck to choose a location — that opens a dialog, and the window is modal until you answer.
        </div>
      )}

      <label className="flex cursor-pointer items-center gap-1.5 text-fg-1">
        <input type="checkbox" checked={withAudio} disabled={busy}
          onChange={(e) => setWithAudio(e.target.checked)}
          className="cursor-pointer rounded border-line-2 bg-surface-0 text-accent" />
        Render the show&apos;s sound into the file
      </label>
      {withAudio && (
        <div className="text-fg-3">
          The audio device is released while rendering, so nothing sounds until it finishes. Stereo
          only &mdash; AAC in MP4 cannot carry more.
        </div>
      )}

      {blocked && <div className="rounded border border-line-1 bg-surface-0 p-1.5 text-fg-2">{blocked}</div>}

      <button
        type="button"
        className="rounded border border-line-1 bg-surface-1 px-2 py-1 text-micro text-fg-1 disabled:opacity-40"
        disabled={busy || !!blocked || frames <= 0}
        onClick={() => { void start(); }}
      >
        {busy ? 'Baking…' : `Bake ${frames} frames`}
      </button>

      {busy && (
        <button type="button" className="rounded border border-line-1 px-2 py-1 text-micro text-fg-2"
          onClick={() => runner.cancel()}>Cancel</button>
      )}

      {progress && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.frames}
          aria-valuenow={progress.frame}
          aria-label="Bake progress"
          className="flex flex-col gap-1"
        >
          {/* A real bar, not a counter. A render is the one operation in this app that can legitimately
              run for minutes, and "129 / 3000" does not answer the only question anyone has in front of
              it, which is whether to wait. The width is a direct style write rather than a class, since
              it changes on a fifth of the frames. */}
          <div className="h-1.5 w-full overflow-hidden rounded bg-surface-0 border border-line-1">
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${Math.round((progress.frame / Math.max(1, progress.frames)) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-fg-2">
            <span>
              {Math.round((progress.frame / Math.max(1, progress.frames)) * 100)}% · {progress.frame}/{progress.frames} frames
            </span>
            <span>
              {progress.rate.toFixed(1)} fps
              {/* Only once there is a rate worth extrapolating from: an estimate computed off the first
                  two frames is wrong by an order of magnitude and is read as a promise. */}
              {progress.rate > 0 && progress.frame > 10 && ` · ${eta(progress.frames - progress.frame, progress.rate)} left`}
            </span>
          </div>
        </div>
      )}

      {existing && (
        <div className="rounded border border-line-1 bg-surface-0 p-1.5">
          <div className="text-fg-1">
            {existing.enabled ? 'Playing a pre-rendered file' : 'Pre-rendered file available (bypassed)'}
          </div>
          <div className="text-fg-3">
            {existing.width}×{existing.height} · {existing.fps} fps ·{' '}
            {existing.startSec.toFixed(1)}–{existing.endSec.toFixed(1)}s on the {existing.clock} clock
          </div>
          {stale && (
            <div className="text-fg-2">
              The surface&apos;s content has changed since this was rendered, so it is being ignored. Re-render to use it.
            </div>
          )}
          <div className="mt-1 flex gap-1">
            <button type="button" className="rounded border border-line-1 px-2 py-1 text-micro text-fg-1"
              onClick={() => host?.bakes.setEnabled(existing.id, !existing.enabled)}>
              {existing.enabled ? 'Use live' : 'Use the file'}
            </button>
            <button type="button" className="rounded border border-line-1 px-2 py-1 text-micro text-fg-2"
              onClick={() => host?.bakes.remove(existing.id)}>
              Forget
            </button>
          </div>
        </div>
      )}

      {done && (
        <div className="rounded border border-line-1 p-1.5 text-fg-1">
          Wrote {done.frames} frames to {done.path} in {(done.elapsedMs / 1000).toFixed(1)}s
          {done.audioNote && <div className="text-fg-2">Sound: {done.audioNote}</div>}
        </div>
      )}
      {refused && (
        <div className="rounded border border-line-2 p-1.5 text-fg-2">Did not bake: {refused}</div>
      )}

      <div className="text-fg-3">
        Video only in this build — no sound, and the surface is not switched over to the file.
      </div>
    </div>
  );
};
