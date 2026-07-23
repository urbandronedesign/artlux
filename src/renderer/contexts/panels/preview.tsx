import React, { useEffect, useRef } from 'react';
import { MonitorPlay, MonitorOff } from 'lucide-react';
import { getDrawable } from '../../services/surfaceMedia';
import { timeline as timelineEngine } from '../../services/timeline';
import { useEditor } from '../../state/EditorStore';
import type { Surface } from '../../types';
import { WINDOWED_DISPLAY } from '../../../../shared/protocol';

// Live preview panels — the timeline's program composite, and every projector output at once.
//
// Both pull from machinery that is ALREADY running each frame, so neither adds a decode or a
// composite: the program canvas is built by the timeline engine (refcounted — see retainProgram), and
// a surface's drawable is whatever the compositor last produced for it. A preview only blits.
//
// They render on their OWN rAF loop and never touch React state per frame — the renderer repaints
// during playback and a per-frame setState here would re-render the whole editor (the same rule the
// sliders follow via services/livePreview.ts). Capped well under the frame rate: a monitor is for
// judging content, not for measuring latency, and the outputs grid can hold a dozen canvases.

const PREVIEW_HZ = 20;

// A canvas that blits whatever `getSource()` returns, letterboxed, at PREVIEW_HZ. `getSource` is read
// through a ref so a caller can pass an inline arrow without restarting the loop every render.
const PreviewCanvas: React.FC<{
  getSource: () => CanvasImageSource | null;
  className?: string;
  /** Drawn when the source is null — "nothing on this output right now". */
  placeholder?: React.ReactNode;
}> = ({ getSource, className, placeholder }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const srcRef = useRef(getSource);
  srcRef.current = getSource;
  const emptyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let last = -1e9;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / PREVIEW_HZ) return;
      last = now;
      const cv = canvasRef.current;
      if (!cv) return;
      const src = srcRef.current();
      // Toggle the placeholder imperatively — a React state flip here would re-render per frame.
      if (emptyRef.current) emptyRef.current.style.display = src ? 'none' : '';
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      // Match the backing store to the CSS box once it is laid out (panels resize with the shell).
      const w = cv.clientWidth, h = cv.clientHeight;
      if (w > 0 && h > 0 && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!src) return;
      const sw = (src as HTMLCanvasElement).width || (src as HTMLVideoElement).videoWidth || 0;
      const sh = (src as HTMLCanvasElement).height || (src as HTMLVideoElement).videoHeight || 0;
      if (!sw || !sh) return;
      // Letterbox: never distort what the operator is judging.
      const scale = Math.min(cv.width / sw, cv.height / sh);
      const dw = sw * scale, dh = sh * scale;
      try { ctx.drawImage(src, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh); }
      catch { /* a source mid-teardown (video reload, codec swap) — skip this frame */ }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={`relative bg-black ${className ?? ''}`}>
      <canvas ref={canvasRef} className="w-full h-full block" />
      <div ref={emptyRef} className="absolute inset-0 flex items-center justify-center text-fg-3 text-micro pointer-events-none">
        {placeholder ?? 'No signal'}
      </div>
    </div>
  );
};

// ── Timeline program preview ────────────────────────────────────────────────────────────────
// The whole timeline composited (every contributing layer, z-ordered) — what a PROGRAM surface or a
// 3D screen bound to Program would show. The engine only BUILDS that composite while something wants
// it, so this panel must retain it for as long as it is mounted, and release on unmount or the
// engine keeps compositing for a panel nobody is looking at.
export const ProgramPreviewPanel: React.FC = () => {
  useEffect(() => {
    const key = 'panel:programPreview';
    timelineEngine.retainProgram(key);
    return () => timelineEngine.releaseProgram(key);
  }, []);
  return (
    <div className="p-2">
      <div className="aspect-video w-full border border-line-1 rounded-sm overflow-hidden">
        <PreviewCanvas
          getSource={() => timelineEngine.getProgramDrawable()}
          placeholder="Program — nothing under the playhead"
        />
      </div>
      <div className="text-micro text-fg-3 mt-1.5">
        The whole timeline composited — every contributing layer, z-ordered.
      </div>
    </div>
  );
};

// The same composite as a full-bleed VIEWPORT — the program monitor sitting above an editing
// timeline. Fills its pane rather than sitting in a padded card, and letterboxes inside it.
export const ProgramMonitorViewport: React.FC = () => {
  useEffect(() => {
    const key = 'viewport:programMonitor';
    timelineEngine.retainProgram(key);
    return () => timelineEngine.releaseProgram(key);
  }, []);
  return (
    <div className="w-full h-full flex flex-col bg-surface-0">
      <div className="h-7 shrink-0 flex items-center gap-1.5 px-2 border-b border-line-1 bg-surface-1 text-fg-2">
        <MonitorPlay size={12} className="text-accent" />
        <span className="text-micro font-bold uppercase tracking-wider">Program</span>
        <span className="text-micro text-fg-3">— the whole timeline composited</span>
      </div>
      <PreviewCanvas
        className="flex-1 min-h-0"
        getSource={() => timelineEngine.getProgramDrawable()}
        placeholder="Nothing under the playhead"
      />
    </div>
  );
};

// ── All projector outputs ───────────────────────────────────────────────────────────────────
// One live tile per projector output. This is the multi-screen view: with a surface spanned across
// several projectors each slice is an ordinary surface with its own output, so the tiles show exactly
// what each machine is putting on its screen — side by side, in one place.
//
// The tile draws the output's SOURCE surface. Warp / soft-edge / gamma are applied in the projector
// window's own GL pass, so they are deliberately NOT reproduced here: this answers "is the right
// content on the right screen", which is the question a multi-projector rig actually fails at. The
// badges carry the rest (display binding, warp/blend/calibration state).
export const OutputsPreviewPanel: React.FC = () => {
  const { surfaces, projectorOutputs, displays } = useEditor();
  const outputs = projectorOutputs.filter((o) => o.enabled);

  if (outputs.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-fg-3 text-mini p-4 text-center">
        <MonitorOff size={20} />
        <div>No outputs enabled.</div>
        <div className="text-micro">Bind a surface to a display in the Projection Outputs context.</div>
      </div>
    );
  }

  const surfaceOf = (id: string): Surface | undefined => surfaces.find((s) => s.id === id);
  const displayName = (id: number | null | undefined): string => {
    if (id == null) return 'unbound';
    // WINDOWED_DISPLAY is a sentinel, not a display id — never render it as "Display -1".
    if (id === WINDOWED_DISPLAY) return 'windowed';
    const d = displays.find((x) => x.id === id);
    return d ? (d.label || `Display ${id}`) : `Display ${id} (missing)`;
  };

  return (
    <div className="p-2 grid gap-2 overflow-y-auto h-full" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {outputs.map((o) => {
        const s = surfaceOf(o.surfaceId);
        const warped = !!o.warp || !!o.hwWarp;
        const blended = !!o.softEdge && (o.softEdge.left > 0 || o.softEdge.right > 0 || o.softEdge.top > 0 || o.softEdge.bottom > 0);
        return (
          <div key={o.surfaceId} className="border border-line-1 rounded-sm overflow-hidden bg-surface-2">
            <div className="aspect-video w-full">
              <PreviewCanvas
                getSource={() => (s ? getDrawable(s) : null)}
                placeholder={s ? 'No content' : 'Surface missing'}
              />
            </div>
            <div className="px-1.5 py-1 border-t border-line-1">
              <div className="flex items-center gap-1 min-w-0">
                <MonitorPlay size={11} className="text-accent shrink-0" />
                <span className="text-mini text-fg-1 truncate">{s?.name ?? o.surfaceId}</span>
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                <span className="text-micro text-fg-3 truncate">{displayName(o.displayId)}</span>
                {warped && <span className="text-micro text-fg-2 px-1 rounded-sm bg-surface-3" title={o.hwWarp ? 'Hardware (NVAPI) scanout warp' : 'GLSL warp'}>warp</span>}
                {blended && <span className="text-micro text-fg-2 px-1 rounded-sm bg-surface-3" title="Soft-edge blending is active on this output">blend</span>}
                {o.useCalibration && <span className="text-micro text-accent px-1 rounded-sm bg-accent/15" title="Rendering the 3D venue from the calibrated projector pose">calib</span>}
                {o.ndiSend && <span className="text-micro text-fg-2 px-1 rounded-sm bg-surface-3" title="Also published as an NDI source">ndi</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
