import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as poseCamera from './poseCamera';
import * as poseStore from './poseStore';
import { POSE_CONNECTIONS } from './poseRenderer';
import { extractParts, validateQuad, areaToImage, type Quad } from './poseAreaMath';

// QUAD PICKER — four corners marked on the live camera picture. Shared by the interaction-area and
// floor tabs of the calibration wizard. What it fixes over the old floor wizard, one item per way a
// calibration used to go wrong without anybody noticing:
//
//   · TRUE GEOMETRY. The box takes the video's REAL aspect (from the element, not a 300 ms poll that
//     started at 16:9), so a corner is placed on the pixel the operator sees — a 4:3 webcam used to be
//     stretched and every corner was off by the stretch.
//   · THE BODY ON THE PICTURE. BlazePose's skeleton and the parts a zone can count (L/R hand, feet,
//     head, body) are drawn live, so a corner is placed where a HAND actually shows up — the point of
//     the whole exercise — rather than where the operator thinks the wall edge is.
//   · HANDS-FREE CAPTURE. "Walk the corners": stand at each corner, hold a hand still for 2 s, and that
//     corner snaps to it. One person can calibrate a wall from the wall.
//   · PRECISION. Labelled handles, pointer capture, a 4× loupe on the active handle, arrow-key nudge
//     (1 camera pixel; Shift = 0.1), and corners allowed 10% past the frame edge.
//   · SEE THE RESULT. A 4×4 grid through the homography (a bad corner = a visibly bent grid) and the
//     project's zones drawn back onto the picture.
//
// COORDINATES: `quad` is IMAGE space, bottom-left origin, [tl,tr,br,bl] as in the camera picture.
// The DISPLAY may be mirrored (selfie view); handles are LABELLED by display position so the operator
// always drags "TL" to the top-left they see — and the mapping mirrors to match (poseAreaMath).

export interface ZoneOverlay { id: string; name: string; u0: number; v0: number; u1: number; v1: number; hit?: boolean }

interface Props {
  quad: Quad;
  onChange: (q: Quad) => void;
  mirror?: boolean;
  /** Draw the area grid + zones in AREA space (the interaction area). Off for the floor tab. */
  areaOverlay?: boolean;
  zones?: ZoneOverlay[];
}

const LABELS = ['TL', 'TR', 'BR', 'BL'];
const LABELS_MIRRORED = ['TR', 'TL', 'BL', 'BR']; // image tr shows on the left in a mirrored picture
const LIM = 0.1;                    // corners may sit this far outside the frame
const STILL_MS = 2000;              // hold a hand this long to capture a corner (walk mode)
const STILL_EPS = 0.012;            // …within this much movement (image units)
const AWAY = 0.08;                  // the hand must leave the last captured point before the next capture
const clampL = (x: number) => Math.max(-LIM, Math.min(1 + LIM, x));

export const QuadPicker: React.FC<Props> = ({ quad, onChange, mirror = false, areaOverlay = false, zones }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const [aspect, setAspect] = useState<number | null>(() => poseCamera.aspect());
  const [videoPx, setVideoPx] = useState<{ w: number; h: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, setPoseTick] = useState(0);
  const [walk, setWalk] = useState<{ corner: number; progress: number } | null>(null);
  const quadRef = useRef(quad); quadRef.current = quad;
  const labels = mirror ? LABELS_MIRRORED : LABELS;

  // image (bottom-left) ⇄ display (top-left, possibly mirrored), both 0..1 of the box
  const toDisp = useCallback((x: number, y: number): [number, number] => [mirror ? 1 - x : x, 1 - y], [mirror]);
  const fromDisp = useCallback((dx: number, dy: number): [number, number] => [clampL(mirror ? 1 - dx : dx), clampL(1 - dy)], [mirror]);

  // ── the live stream (it starts a moment after the engine is acquired, and may restart) ──
  useEffect(() => {
    const attach = () => {
      const v = videoRef.current, stream = poseCamera.getStream();
      if (v && stream && v.srcObject !== stream) { v.srcObject = stream; v.play().catch(() => {}); }
      if (v && !stream && v.srcObject) v.srcObject = null;
    };
    attach();
    const id = window.setInterval(attach, 300);
    return () => window.clearInterval(id);
  }, []);
  const onMeta = () => {
    const v = videoRef.current;
    if (v && v.videoWidth) { setAspect(v.videoWidth / v.videoHeight); setVideoPx({ w: v.videoWidth, h: v.videoHeight }); }
  };

  // ── pose overlay + walk-the-corners capture (fires per inference frame, rAF-coalesced) ──
  const still = useRef<{ x: number; y: number; since: number } | null>(null);
  const lastCaptured = useRef<[number, number] | null>(null);
  const walkRef = useRef(walk); walkRef.current = walk;
  useEffect(() => poseStore.subscribe(() => {
    setPoseTick((t) => (t + 1) % 1e6);
    const w = walkRef.current;
    if (!w) return;
    // The hand to follow: the visible hand nearest the PREVIOUS still point (stickiness), else any.
    const hands: [number, number][] = [];
    for (const d of poseStore.getDetections()) for (const p of extractParts(d.landmarks)) if (p.part === 'handL' || p.part === 'handR') hands.push([p.x, p.y]);
    const now = performance.now();
    if (!hands.length) { still.current = null; setWalk({ ...w, progress: 0 }); return; }
    const ref = still.current;
    const pick = ref ? hands.reduce((a, b) => (Math.hypot(b[0] - ref.x, b[1] - ref.y) < Math.hypot(a[0] - ref.x, a[1] - ref.y) ? b : a)) : hands[0];
    const lc = lastCaptured.current;
    if (lc && Math.hypot(pick[0] - lc[0], pick[1] - lc[1]) < AWAY) { still.current = null; setWalk({ ...w, progress: 0 }); return; }
    if (!ref || Math.hypot(pick[0] - ref.x, pick[1] - ref.y) > STILL_EPS) { still.current = { x: pick[0], y: pick[1], since: now }; setWalk({ ...w, progress: 0 }); return; }
    const progress = Math.min(1, (now - ref.since) / STILL_MS);
    if (progress < 1) { setWalk({ ...w, progress }); return; }
    // CAPTURE.
    const n = quadRef.current.slice() as Quad;
    n[w.corner] = [clampL(ref.x), clampL(ref.y)];
    onChange(n);
    lastCaptured.current = [ref.x, ref.y];
    still.current = null;
    setWalk(w.corner < 3 ? { corner: w.corner + 1, progress: 0 } : null);
  }), [onChange]);

  // ── drag (pointer capture: a fast drag off the handle keeps tracking) ──
  const onHandleDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setActive(i); setDragging(true);
    boxRef.current?.focus();
  };
  const onHandleMove = (i: number) => (e: React.PointerEvent) => {
    if (!dragging || active !== i) return;
    const r = boxRef.current?.getBoundingClientRect(); if (!r) return;
    const n = quad.slice() as Quad;
    n[i] = fromDisp((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    onChange(n);
  };
  const onHandleUp = (e: React.PointerEvent) => { setDragging(false); try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* not captured */ } };

  // ── keyboard: 1-4 select · arrows nudge (1 px; Shift 0.1 px) · S snap to hand · Esc deselect ──
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key >= '1' && e.key <= '4') { setActive(labels.indexOf(LABELS[Number(e.key) - 1])); e.preventDefault(); return; }
    if (active == null) return;
    if (e.key === 'Escape') { setActive(null); e.stopPropagation(); return; }
    if (e.key === 's' || e.key === 'S') { snapToHand(active); e.preventDefault(); return; }
    const px = videoPx ?? { w: 1280, h: 720 };
    const step = e.shiftKey ? 0.1 : 1;
    const dx = step / px.w, dy = step / px.h;
    let [x, y] = quad[active];
    // Arrows move in DISPLAY direction — what the operator sees — whatever the mirror.
    if (e.key === 'ArrowLeft') x += mirror ? dx : -dx;
    else if (e.key === 'ArrowRight') x += mirror ? -dx : dx;
    else if (e.key === 'ArrowUp') y += dy;
    else if (e.key === 'ArrowDown') y -= dy;
    else return;
    e.preventDefault();
    const n = quad.slice() as Quad; n[active] = [clampL(x), clampL(y)]; onChange(n);
  };

  const visibleHands = (): [number, number][] => {
    const out: [number, number][] = [];
    for (const d of poseStore.getDetections()) for (const p of extractParts(d.landmarks)) if (p.part === 'handL' || p.part === 'handR') out.push([p.x, p.y]);
    return out;
  };
  const snapToHand = (i: number) => {
    const hands = visibleHands(); if (!hands.length) return;
    const c = quad[i];
    const best = hands.reduce((a, b) => (Math.hypot(b[0] - c[0], b[1] - c[1]) < Math.hypot(a[0] - c[0], a[1] - c[1]) ? b : a));
    const n = quad.slice() as Quad; n[i] = [clampL(best[0]), clampL(best[1])]; onChange(n);
  };

  // ── loupe: a 4× crop of the camera around the active handle ──
  useEffect(() => {
    if (active == null) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = loupeRef.current, v = videoRef.current;
      if (!c || !v || !v.videoWidth) return;
      const g = c.getContext('2d'); if (!g) return;
      const [x, y] = quadRef.current[active];
      const S = c.width, src = S / 4;
      const sx = x * v.videoWidth - src / 2, sy = (1 - y) * v.videoHeight - src / 2;
      g.save();
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      if (mirror) { g.translate(S, 0); g.scale(-1, 1); }
      g.drawImage(v, sx, sy, src, src, 0, 0, S, S);
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.moveTo(0, S / 2); g.lineTo(S, S / 2); g.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active, mirror]);

  const invalid = validateQuad(quad);
  const disp = quad.map(([x, y]) => toDisp(x, y));
  const poly = disp.map(([x, y]) => `${x * 100},${y * 100}`).join(' ');

  // The area grid + zones, drawn back through the homography (sampled lines, so perspective shows).
  const gridPaths = useMemo(() => {
    if (!areaOverlay || invalid) return [];
    const paths: string[] = [];
    const line = (f: (t: number) => [number, number]) => {
      const pts: string[] = [];
      for (let k = 0; k <= 12; k++) { const [ix, iy] = f(k / 12); const [dx, dy] = toDisp(ix, iy); pts.push(`${dx * 100},${dy * 100}`); }
      return pts.join(' ');
    };
    for (let i = 1; i < 4; i++) {
      paths.push(line((t) => areaToImage(quad, i / 4, t, mirror)));
      paths.push(line((t) => areaToImage(quad, t, i / 4, mirror)));
    }
    return paths;
  }, [areaOverlay, invalid, quad, mirror, toDisp]);
  const zonePolys = useMemo(() => {
    if (!areaOverlay || invalid || !zones) return [];
    return zones.map((z) => {
      const corners: [number, number][] = [[z.u0, z.v1], [z.u1, z.v1], [z.u1, z.v0], [z.u0, z.v0]];
      const pts = corners.map(([u, v]) => { const [ix, iy] = areaToImage(quad, u, v, mirror); const [dx, dy] = toDisp(ix, iy); return [dx * 100, dy * 100] as [number, number]; });
      const cx = pts.reduce((a, p) => a + p[0], 0) / 4, cy = pts.reduce((a, p) => a + p[1], 0) / 4;
      return { ...z, points: pts.map((p) => p.join(',')).join(' '), cx, cy };
    });
  }, [areaOverlay, invalid, zones, quad, mirror, toDisp]);

  const dets = poseStore.getDetections();
  const hasStream = !!poseCamera.getStream();
  // The loupe sits BESIDE the active handle, on the side facing the middle of the picture — never in a
  // fixed corner, where it covered whichever other handle lived there.
  const loupeStyle: React.CSSProperties | undefined = active == null ? undefined : {
    left: `${disp[active][0] * 100}%`, top: `${disp[active][1] * 100}%`,
    transform: `translate(${disp[active][0] > 0.5 ? 'calc(-100% - 22px)' : '22px'}, ${disp[active][1] > 0.5 ? 'calc(-100% - 22px)' : '22px'})`,
  };

  return (
    <div className="space-y-1.5">
      <div ref={boxRef} tabIndex={0} onKeyDown={onKey}
        className="relative w-full rounded overflow-hidden border border-line-1 bg-surface-0 select-none focus:outline-none focus:border-accent"
        style={{ aspectRatio: String(aspect ?? 16 / 9), touchAction: 'none' }}
        onPointerDown={() => setActive(null)}>
        <video ref={videoRef} muted playsInline onLoadedMetadata={onMeta} onResize={onMeta}
          className="absolute inset-0 w-full h-full" style={{ objectFit: 'fill', transform: mirror ? 'scaleX(-1)' : undefined }} />
        {!hasStream && (
          <div className="absolute inset-0 flex items-center justify-center text-micro text-fg-3 text-center px-4">
            Waiting for the camera…
          </div>
        )}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          {/* the people BlazePose sees, and the parts a zone can count */}
          {dets.map((d, di) => d.landmarks && (
            <g key={di}>
              {POSE_CONNECTIONS.map(([a, b], k) => {
                const la = d.landmarks![a], lb = d.landmarks![b];
                if (!la || !lb || la.visibility < 0.5 || lb.visibility < 0.5) return null;
                const [x1, y1] = toDisp(la.x, la.y), [x2, y2] = toDisp(lb.x, lb.y);
                return <line key={k} x1={x1 * 100} y1={y1 * 100} x2={x2 * 100} y2={y2 * 100} stroke="rgba(255,255,255,0.55)" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
              })}
            </g>
          ))}
          {gridPaths.map((p, i) => <polyline key={i} points={p} fill="none" stroke="#27b6c4" strokeOpacity={0.45} strokeWidth={1} vectorEffect="non-scaling-stroke" />)}
          {zonePolys.map((z) => (
            <polygon key={z.id} points={z.points} fill={z.hit ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.08)'} stroke="#fff" strokeOpacity={z.hit ? 1 : 0.6} strokeDasharray={z.hit ? undefined : '3 2'} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <polygon points={poly} fill="rgba(39,182,196,0.10)" stroke={invalid ? '#e5484d' : '#27b6c4'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* zone names + part labels as HTML, so text is never stretched by the SVG's non-uniform scale */}
        {zonePolys.map((z) => (
          <span key={z.id} className="absolute -translate-x-1/2 -translate-y-1/2 text-micro text-white/90 pointer-events-none" style={{ left: `${z.cx}%`, top: `${z.cy}%`, textShadow: '0 0 3px #000' }}>{z.name}</span>
        ))}
        {dets.flatMap((d, di) => extractParts(d.landmarks).filter((p) => p.part !== 'body').map((p) => {
          const [x, y] = toDisp(p.x, p.y);
          const tag = p.part === 'handL' ? 'L' : p.part === 'handR' ? 'R' : p.part === 'head' ? '' : '·';
          return (
            <span key={`${di}${p.part}`} className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none flex items-center justify-center rounded-full bg-black/60 border border-white/80 text-white"
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: p.part.startsWith('hand') ? 16 : 8, height: p.part.startsWith('hand') ? 16 : 8, fontSize: 9, lineHeight: 1 }}>{tag}</span>
          );
        }))}
        {disp.map(([x, y], i) => (
          <div key={i}
            onPointerDown={onHandleDown(i)} onPointerMove={onHandleMove(i)} onPointerUp={onHandleUp}
            className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full border-2 font-bold cursor-grab active:cursor-grabbing shadow no-press ${active === i ? 'bg-accent border-white text-white' : 'bg-surface-1/85 border-accent text-fg-1'} ${walk?.corner === i ? 'ring-2 ring-white' : ''}`}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: 26, height: 26, fontSize: 9 }}
            title={`${labels[i]} — drag, or select and use the arrow keys`}>
            {labels[i]}
          </div>
        ))}
        {active != null && (
          <canvas ref={loupeRef} width={128} height={128} style={loupeStyle}
            className="absolute rounded border-2 border-white shadow-lg pointer-events-none" />
        )}
        {walk && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-black/70 text-white text-micro pointer-events-none">
            Stand at <b>{labels[walk.corner]}</b> and hold a hand still… {Math.round(walk.progress * 100)}%
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => { lastCaptured.current = null; still.current = null; setWalk(walk ? null : { corner: 0, progress: 0 }); }}
          className={`text-micro px-2 py-1 rounded border ${walk ? 'bg-accent/15 border-accent text-accent' : 'border-line-1 text-fg-2'}`}
          title="Stand at each corner in turn (TL, TR, BR, BL) and hold a hand still for 2 seconds — the corner snaps to it">
          {walk ? 'Stop walking' : 'Walk the corners'}
        </button>
        <button disabled={active == null || !visibleHands().length} onClick={() => active != null && snapToHand(active)}
          className="text-micro px-2 py-1 rounded border border-line-1 text-fg-2 disabled:opacity-40"
          title="Move the selected corner to the visible hand nearest it (key S)">
          Snap to hand
        </button>
        <span className="text-micro text-fg-3 ml-auto">Click a corner, then ←↑→↓ to nudge (Shift = fine) · 1–4 select</span>
      </div>
      {invalid && <div className="text-micro text-danger">⚠ {invalid}</div>}
    </div>
  );
};
