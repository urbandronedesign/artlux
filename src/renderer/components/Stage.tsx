import React, { useRef, useEffect, useState, useCallback, useSyncExternalStore } from 'react';
import { Fixture, Surface } from '../types';
import { AlertCircle, Magnet, Grid3X3, ZoomIn, Maximize2 } from 'lucide-react';
import { frameEngine } from '../engine/frameEngine';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

// THE 2D STAGE — a view, and nothing else.
//
// The composite / sample / pack / publish pipeline that used to live in this file is now
// engine/frameEngine.ts, which owns its own loop and its own GPU mapper. What is left here is the
// viewport, the overlays you drag, and a canvas the engine paints into.
//
// The prop list is the evidence. Everything the FRAME needed — controllers, profiles, gamma, target
// IP, protocol, brightness — used to arrive through this component and get mirrored into refs, purely
// because the loop happened to live inside it. App feeds the engine directly now, so those props are
// gone and what remains is what a viewport actually needs: what to draw, what is selected, and who to
// tell when the operator moves something.
interface StageProps {
  surfaces: Surface[];
  onUpdateSurfaces: (surfaces: Surface[]) => void;
  onDropAsset?: (surfaceId: string, asset: { id: string; type: string; path: string }) => void;
  selectedSurfaceId: string | null;
  onSelectSurface: (id: string) => void;
  fixtures: Fixture[];
  onUpdateFixtures: (fixtures: Fixture[]) => void;
  selectedFixtureId: string | null;
  selectedFixtureIds?: string[];
  onSelectFixture: (id: string, additive?: boolean) => void;
  onRecordHistory: () => void;
  /** Extra buttons rendered at the end of the stage's top-right toolbar (e.g. the 3D split toggle). */
  extraControls?: React.ReactNode;
}

const StageView: React.FC<StageProps> = ({
  surfaces,
  onUpdateSurfaces,
  onDropAsset,
  selectedSurfaceId,
  onSelectSurface,
  fixtures,
  onUpdateFixtures,
  selectedFixtureId,
  selectedFixtureIds = [],
  onSelectFixture,
  onRecordHistory,
  extraControls,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fixtureRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Which GPU path came up — reported BY the engine, which now owns the mapper. The Stage's job here
  // is only to say so out loud: the WebGL fallback does not do strict per-surface sampling, so a
  // back-linked fixture can pick up an overlapping front surface, and an operator is entitled to know
  // rather than have the app degrade in silence.
  const engineStatus = useSyncExternalStore(frameEngine.subscribeStatus, frameEngine.getStatus);
  const webglError = engineStatus.failed;
  const reducedMode = engineStatus.backend === 'webgl';
  const [reducedDismissed, setReducedDismissed] = useState(false);

  const [viewState, setViewState] = useState({ x: 0, y: 0, scale: 0.8 });
  const viewStateRef = useRef(viewState);
  useEffect(() => { viewStateRef.current = viewState; }, [viewState]);

  // The stage is the composition canvas; surfaces are placed within it. Square (1:1)
  // so the 512² backing buffer maps 1:1 to the displayed canvas — a normalized UV
  // texture square. Surfaces/LEDs use normalized 0–1 coords, so sampling is unaffected.
  const contentAspect = 1;

  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [gridDivisions, setGridDivisions] = useState(8);
  // Refs so the (mouse-move) drag handlers read live snap/grid settings without re-binding.
  const snapRef = useRef(snapEnabled);
  const gridRef = useRef({ show: showGrid, divisions: gridDivisions });
  useEffect(() => { snapRef.current = snapEnabled; }, [snapEnabled]);
  useEffect(() => { gridRef.current = { show: showGrid, divisions: gridDivisions }; }, [showGrid, gridDivisions]);
  const [activeSnapLines, setActiveSnapLines] = useState<{ x: number[], y: number[] }>({ x: [], y: [] });

  // ── Local-during-drag, commit-on-release ──────────────────────────────────────────────────────
  // A geometry drag used to push the whole fixtures/surfaces array up to App on EVERY pointermove.
  // App owns all state, so that re-rendered the entire editor at pointer rate: every panel reading
  // useEditor(), all five persistent viewports, and — because Simulator3D's LED layout signature
  // includes x/y/w/h/rotation — a full rebuild of the 3D InstancedMesh geometry (computeLedPositions
  // over EVERY fixture, plus a fresh Float32Array) for each mouse move. On a large rig that is the
  // most expensive thing the editor does, sixty times a second, to draw a rectangle moving.
  //
  // So the gesture is now local: the draft array below drives this component's own render while the
  // drag is live, and App is told once, on release. This is the same rule the timeline already
  // follows for clip drags (Timeline.tsx "Invariant 7"), and the same shape as livePreview's
  // render-free brightness channel.
  //
  // What must NOT wait for the release is the ENGINE: each move pushes the new geometry straight into
  // frameEngine, which composites and samples it on the very next frame and works out for itself that
  // the GPU LED buffers need rebuilding. So Art-Net follows the drag live while React does not move.
  // What does now wait for the release is the 3D scene, which follows committed state — a deliberate
  // trade: it is exactly the geometry rebuild described above.
  const [fixtureDraft, setFixtureDraft] = useState<Fixture[] | null>(null);
  const [surfaceDraft, setSurfaceDraft] = useState<Surface[] | null>(null);

  const dragState = useRef({
      isDragging: false,
      mode: null as 'move' | 'pan' | 'rotate' | 'resize-x' | 'resize-y' | 'resize-xy' | null,
      targetId: null as string | null,
      startX: 0,
      startY: 0,
      initialFixture: null as null | { x: number, y: number, w: number, h: number, r: number },
      initialView: { x: 0, y: 0 },
      hasMoved: false
  });

  // Lend the engine somewhere to show its composite. That is the entire relationship this component
  // now has with the frame loop: the engine runs on its own rAF, started when its module loaded, and
  // handing back null on unmount costs the operator a picture and costs the show nothing.
  //
  // This is what the whole extraction was for. Stage may unmount, remount, or be hidden by a context
  // switch, and Art-Net does not notice — so the workspace is free to move it around.
  useEffect(() => {
    frameEngine.setPreviewCanvas(canvasRef.current);
    return () => frameEngine.setPreviewCanvas(null);
  }, []);

  // --- Surface drag (self-contained; cyan rectangles) ---
  // `moved` is a per-gesture history latch: a surface drag streams to state at pointer rate via the
  // render-free onUpdateSurfaces, so — exactly like the fixture drag above — we record ONCE, on the
  // first real move, not per frame and not on a click that never drags. See plans/timeline-undo.md §5.1.
  const surfaceDrag = useRef<{ mode: 'move' | 'resize' | 'rotate' | null; id: string | null; sx: number; sy: number; init: { x: number; y: number; w: number; h: number; r: number } | null; moved: boolean }>({ mode: null, id: null, sx: 0, sy: 0, init: null, moved: false });

  const onSurfaceMove = useCallback((e: MouseEvent) => {
    const st = surfaceDrag.current;
    if (!st.mode || !st.id || !st.init || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = (e.clientX - st.sx) / rect.width;
    const dy = (e.clientY - st.sy) / rect.height;
    const cur = frameEngine.getSurfaces();
    const idx = cur.findIndex(s => s.id === st.id);
    if (idx === -1) return;
    // First real move of this gesture → one undo entry for the whole drag.
    if (!st.moved) { st.moved = true; onRecordHistory(); }
    const init = st.init;
    const next = { ...cur[idx] };
    // Snap a normalized coord to the nearest grid line when snapping + grid are both on.
    const g = gridRef.current;
    const snapG = (v: number) => (snapRef.current && g.show ? Math.round(v * g.divisions) / g.divisions : v);
    if (st.mode === 'move') { next.x = snapG(init.x + dx); next.y = snapG(init.y + dy); }
    else if (st.mode === 'resize') {
      // Uniform scale from the corner — preserve the surface's (content) aspect ratio.
      const w = Math.max(0.01, snapG(init.w + dx));
      next.width = w;
      next.height = Math.max(0.01, w * (init.h / init.w));
    }
    else if (st.mode === 'rotate') {
      const cx = rect.left + (init.x + init.w / 2) * rect.width;
      const cy = rect.top + (init.y + init.h / 2) * rect.height;
      next.rotation = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI + 90;
    }
    const arr = [...cur]; arr[idx] = next;
    // Same rule as the fixture drag above: local while the gesture runs, committed on release. The
    // engine gets it immediately, so output follows the drag; App does not, so nothing re-renders.
    frameEngine.setInputs({ surfaces: arr });
    setSurfaceDraft(arr);
  }, [onRecordHistory]);

  const onSurfaceUp = useCallback(() => {
    const moved = surfaceDrag.current.moved;
    surfaceDrag.current = { mode: null, id: null, sx: 0, sy: 0, init: null, moved: false };
    setSurfaceDraft(null);
    if (moved) onUpdateSurfaces(frameEngine.getSurfaces());
    window.removeEventListener('mousemove', onSurfaceMove);
    window.removeEventListener('mouseup', onSurfaceUp);
  }, [onSurfaceMove, onUpdateSurfaces]);

  const startSurfaceDrag = (e: React.MouseEvent, mode: 'move' | 'resize' | 'rotate', id: string) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectSurface(id);
    const s = frameEngine.getSurfaces().find(x => x.id === id);
    if (!s) return;
    surfaceDrag.current = { mode, id, sx: e.clientX, sy: e.clientY, init: { x: s.x, y: s.y, w: s.width, h: s.height, r: s.rotation }, moved: false };
    window.addEventListener('mousemove', onSurfaceMove);
    window.addEventListener('mouseup', onSurfaceUp);
  };

  const handleWindowMouseMove = useCallback((e: MouseEvent) => {
    const state = dragState.current;
    if (!state.isDragging) return;

    if (state.mode === 'pan') {
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        setViewState({
            ...viewStateRef.current,
            x: state.initialView.x + dx,
            y: state.initialView.y + dy
        });
        return;
    }

    if (!containerRef.current || !state.targetId || !state.initialFixture) return;
    
    if (!state.hasMoved) {
        state.hasMoved = true;
        onRecordHistory(); 
    }

    const fixtures = frameEngine.getFixtures();
    const fixtureIndex = fixtures.findIndex(f => f.id === state.targetId);
    if (fixtureIndex === -1) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const init = state.initialFixture;
    
    const deltaX = (e.clientX - state.startX) / containerRect.width;
    const deltaY = (e.clientY - state.startY) / containerRect.height;
    
    const target = { ...fixtures[fixtureIndex] };

    const currentSnapsX: number[] = [];
    const currentSnapsY: number[] = [];
    const SNAP_THRES = 0.02; 
    
    const applySnap = (val: number, guides: number[]) => {
        let bestVal = val;
        let bestDist = SNAP_THRES;
        let snapped = null;
        for (const g of guides) {
            const dist = Math.abs(val - g);
            if (dist < bestDist) {
                bestDist = dist;
                bestVal = g;
                snapped = g;
            }
        }
        return { val: bestVal, snapped };
    };

    const guidesX = [0, 0.5, 1];
    const guidesY = [0, 0.5, 1];
    if (snapEnabled) {
        fixtures.forEach(f => {
            if (f.id === state.targetId) return;
            guidesX.push(f.x, f.x + f.width, f.x + f.width/2);
            guidesY.push(f.y, f.y + f.height, f.y + f.height/2);
        });
        // Grid lines as additional snap targets.
        const g = gridRef.current;
        if (g.show) {
            for (let k = 0; k <= g.divisions; k++) { guidesX.push(k / g.divisions); guidesY.push(k / g.divisions); }
        }
    }

    if (state.mode === 'move') {
        let newX = init.x + deltaX;
        let newY = init.y + deltaY;

        if (snapEnabled) {
             const sLeft = applySnap(newX, guidesX);
             const sRight = applySnap(newX + init.w, guidesX);
             const sCenter = applySnap(newX + init.w/2, guidesX);

             let diff = SNAP_THRES;
             if (sLeft.snapped !== null) { newX = sLeft.val; currentSnapsX.push(sLeft.snapped); diff = 0; } 
             else if (sRight.snapped !== null) { 
                 newX = sRight.val - init.w; currentSnapsX.push(sRight.snapped); 
             }
             else if (sCenter.snapped !== null) { newX = sCenter.val - init.w/2; currentSnapsX.push(sCenter.snapped); }

             const sTop = applySnap(newY, guidesY);
             const sBottom = applySnap(newY + init.h, guidesY);
             const sMid = applySnap(newY + init.h/2, guidesY);

             if (sTop.snapped !== null) { newY = sTop.val; currentSnapsY.push(sTop.snapped); }
             else if (sBottom.snapped !== null) { newY = sBottom.val - init.h; currentSnapsY.push(sBottom.snapped); }
             else if (sMid.snapped !== null) { newY = sMid.val - init.h/2; currentSnapsY.push(sMid.snapped); }
        }

        target.x = newX;
        target.y = newY;
    }
    else if (state.mode === 'rotate') {
        const cx = containerRect.left + (init.x + init.w/2) * containerRect.width;
        const cy = containerRect.top + (init.y + init.h/2) * containerRect.height;
        const angleRad = Math.atan2(e.clientY - cy, e.clientX - cx);
        let angleDeg = angleRad * (180 / Math.PI) + 90;
        
        if (snapEnabled) {
            const rotSnaps = [0, 45, 90, 135, 180, 225, 270, 315];
            let bestRot = angleDeg;
            let minDiff = 5;
            const normRot = (angleDeg + 360) % 360;
            for(const r of rotSnaps) {
                if(Math.abs(normRot - r) < minDiff) {
                    minDiff = Math.abs(normRot - r);
                    bestRot = r;
                }
            }
            angleDeg = bestRot;
        }
        target.rotation = angleDeg;
    }
    else if (state.mode && state.mode.startsWith('resize')) {
        const angleRad = (init.r * Math.PI) / 180;
        const cos = Math.cos(-angleRad);
        const sin = Math.sin(-angleRad);
        
        const localDx = deltaX * cos - deltaY * sin;
        const localDy = deltaX * sin + deltaY * cos;
        
        let newW = init.w;
        let newH = init.h;
        
        if (state.mode === 'resize-x' || state.mode === 'resize-xy') {
            newW = Math.max(0.01, init.w + localDx);
        }
        if (state.mode === 'resize-y' || state.mode === 'resize-xy') {
            newH = Math.max(0.01, init.h + localDy);
        }

        if (snapEnabled && Math.abs(init.r % 90) < 1) {
            if (state.mode.includes('x') || state.mode.includes('xy')) {
                 const sRight = applySnap(target.x + newW, guidesX);
                 if (sRight.snapped !== null) { newW = sRight.val - target.x; currentSnapsX.push(sRight.snapped); }
            }
            
            if (state.mode.includes('y') || state.mode.includes('xy')) {
                const sBottom = applySnap(target.y + newH, guidesY);
                if (sBottom.snapped !== null) { newH = sBottom.val - target.y; currentSnapsY.push(sBottom.snapped); }
            }
        }

        let anchorU = 0, anchorV = 0;
        if (state.mode === 'resize-x') { anchorU = 0; anchorV = 0.5; } 
        else if (state.mode === 'resize-y') { anchorU = 0.5; anchorV = 0; } 
        else { anchorU = 0; anchorV = 0; } 

        const getAnchorWorld = (fx: number, fy: number, fw: number, fh: number, fr: number) => {
             const cx = fx + fw/2;
             const cy = fy + fh/2;
             const rad = fr * (Math.PI / 180);
             const c = Math.cos(rad);
             const s = Math.sin(rad);
             const ox = (anchorU - 0.5) * fw;
             const oy = (anchorV - 0.5) * fh;
             const rx = ox * c - oy * s;
             const ry = ox * s + oy * c;
             return { x: cx + rx, y: cy + ry };
        };

        const oldAnchor = getAnchorWorld(init.x, init.y, init.w, init.h, init.r);
        const newAnchorUncorrected = getAnchorWorld(init.x, init.y, newW, newH, init.r);
        
        target.width = newW;
        target.height = newH;
        target.x = init.x + (oldAnchor.x - newAnchorUncorrected.x);
        target.y = init.y + (oldAnchor.y - newAnchorUncorrected.y);
    }

    const el = fixtureRefs.current.get(state.targetId);
    if (el) {
        el.style.left = `${target.x * 100}%`;
        el.style.top = `${target.y * 100}%`;
        el.style.width = `${target.width * 100}%`;
        el.style.height = `${target.height * 100}%`;
        el.style.transform = `rotate(${target.rotation}deg)`;
    }

    setActiveSnapLines({ x: currentSnapsX, y: currentSnapsY });
    const nextFixtures = [...fixtures];
    nextFixtures[fixtureIndex] = target;
    // The engine gets the geometry immediately — it composites and samples it on the next frame and
    // works out for itself that the GPU LED buffers need rebuilding, so output follows the drag.
    // React does not: the draft is local, and App hears about it once, on mouse-up.
    frameEngine.setInputs({ fixtures: nextFixtures });
    setFixtureDraft(nextFixtures);

  }, [snapEnabled, onRecordHistory]);

  const handleWindowMouseUp = useCallback(() => {
    // Commit the gesture exactly once, and only if it actually moved: a plain click selects, and
    // must not push an identical array into App (that would re-render the editor for nothing).
    const moved = dragState.current.hasMoved && dragState.current.mode !== 'pan';
    dragState.current.isDragging = false;
    dragState.current.mode = null;
    dragState.current.targetId = null;
    dragState.current.hasMoved = false;
    setActiveSnapLines({ x: [], y: [] });
    // Clearing the draft and committing in the same handler puts both in one React batch, so the
    // draft is never dropped a render before the committed props arrive (which would flash the
    // fixture back to where the drag started).
    setFixtureDraft(null);
    if (moved) onUpdateFixtures(frameEngine.getFixtures());
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', handleWindowMouseUp);
  }, [handleWindowMouseMove, onUpdateFixtures]);

  const startDrag = (e: React.MouseEvent, mode: 'move' | 'pan' | 'rotate' | 'resize-x' | 'resize-y' | 'resize-xy', fixtureId?: string) => {
      e.stopPropagation();
      e.preventDefault();
      dragState.current.isDragging = true;
      dragState.current.mode = mode;
      dragState.current.startX = e.clientX;
      dragState.current.startY = e.clientY;
      dragState.current.initialView = { ...viewStateRef.current };
      dragState.current.hasMoved = false; 

      if (fixtureId) {
          onSelectFixture(fixtureId, e.ctrlKey || e.metaKey || e.shiftKey);
          dragState.current.targetId = fixtureId;
          const f = frameEngine.getFixtures().find(fx => fx.id === fixtureId);
          if (f) {
              dragState.current.initialFixture = { 
                  x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation || 0 
              };
          }
      }
      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!viewportRef.current) return;

    const rect = viewportRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const sensitivity = 0.001;
    const delta = -e.deltaY * sensitivity;

    setViewState(prev => {
        const oldScale = prev.scale;
        let newScale = oldScale + delta;
        newScale = Math.min(Math.max(newScale, 0.1), 5);

        if (newScale === oldScale) return prev;

        const ratio = newScale / oldScale;
        
        const newX = mouseX - (mouseX - prev.x) * ratio;
        const newY = mouseY - (mouseY - prev.y) * ratio;

        return {
            x: newX,
            y: newY,
            scale: newScale
        };
    });
  };

  const resetView = () => {
      setViewState({ x: 0, y: 0, scale: 0.8 });
  };

  // Frame the surfaces you actually built, instead of always showing the whole square. The canvas is
  // a fixed UV square by design (see contentAspect above) — a wide rig therefore occupies a thin band
  // of it, and that is a VIEW problem, not a document one. Fitting the view solves it without
  // touching the normalized coordinate space (and so without touching rotation, which is computed in
  // normalized units but applied as a screen-space CSS transform — the two only agree at aspect 1).
  //
  // Coordinates, all reusing what the render tree already sets up:
  //   · the pannable layer is translate(view.x, view.y) scale(view.scale) with origin 0,0
  //   · the stage box is centred in it (left/top 50%, margin -stageW/2, -stageH/2)
  //   ⇒ a normalized point (nx,ny) sits at layer coords (Vw/2 - stageW/2 + nx*stageW, …y…)
  const fitView = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const { width: Vw, height: Vh } = vp.getBoundingClientRect();
      if (Vw <= 0 || Vh <= 0) return;

      // Normalized bounds of the content to frame. ROTATION-AWARE: a rotated surface's corners stick
      // out past its rect, and framing the un-rotated rect would clip them. The canvas is square, so
      // a normalized rotation IS the visual rotation and no aspect correction is needed here.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of surfaces) {
          const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
          const r = ((s.rotation || 0) * Math.PI) / 180;
          const cos = Math.cos(r), sin = Math.sin(r);
          for (const [ox, oy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
              const px = ox * s.width, py = oy * s.height;
              const x = cx + px * cos - py * sin;
              const y = cy + px * sin + py * cos;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
      }
      // Nothing placed yet (or degenerate): frame the whole document — still a useful "fit".
      if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

      const PAD = 24; // screen px of breathing room on every side
      const boxW = (maxX - minX) * stageW, boxH = (maxY - minY) * stageH;
      // Same [0.1, 5] bounds handleWheel clamps to, so fit can't land somewhere the wheel can't reach.
      const scale = Math.min(Math.max(Math.min((Vw - 2 * PAD) / boxW, (Vh - 2 * PAD) / boxH), 0.1), 5);
      const layerCx = Vw / 2 - stageW / 2 + ((minX + maxX) / 2) * stageW;
      const layerCy = Vh / 2 - stageH / 2 + ((minY + maxY) / 2) * stageH;
      setViewState({ x: Vw / 2 - scale * layerCx, y: Vh / 2 - scale * layerCy, scale });
  };

  const getResizeCursor = (rotation: number, offset: number) => {
    const a = (rotation + offset) % 180; 
    const angle = a < 0 ? a + 180 : a;
    if (angle < 22.5 || angle >= 157.5) return 'ns-resize'; 
    if (angle >= 22.5 && angle < 67.5) return 'nesw-resize'; 
    if (angle >= 67.5 && angle < 112.5) return 'ew-resize'; 
    if (angle >= 112.5 && angle < 157.5) return 'nwse-resize'; 
    return 'move';
  };

  // Stage container size from the content aspect (base 512 on the longer axis).
  const stageW = contentAspect >= 1 ? 512 : 512 * contentAspect;
  const stageH = contentAspect >= 1 ? 512 / contentAspect : 512;

  // The overlays draw from the live draft while a drag is in flight, and from committed props the
  // rest of the time. Without this the rectangles would render from props that deliberately stop
  // updating mid-gesture, and the object being dragged would sit still under the cursor.
  const renderFixturesList = fixtureDraft ?? fixtures;
  const renderSurfacesList = surfaceDraft ?? surfaces;

  return (
    <div className="flex flex-col w-full h-full bg-surface-0 select-none">
      {/* Docked viewport header — tools live in reserved chrome, not floating over the canvas
          (Houdini-style). The canvas below renders edge-to-edge with nothing painted on top. */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-surface-1 border-b border-line-1">
        {/* Fit is the primary action — it's what you want after placing surfaces. Plain reset stays
            reachable (alt-click, and its own button) so the default framing is never lost. */}
        <Tooltip id="content.stage-fit">
          <button
            onClick={(e) => (e.altKey ? resetView() : fitView())}
            className="p-1.5 rounded-sm border bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 transition-colors"
            title="Fit view to surfaces (Alt-click: reset view)"
            aria-label="Fit view to surfaces"
            {...help('content.stage-fit')}
          >
            <Maximize2 size={14} />
          </button>
        </Tooltip>
        <Tooltip id="content.stage-reset">
          <button
            onClick={resetView}
            className="p-1.5 rounded-sm border bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 transition-colors"
            title="Reset View"
            aria-label="Reset view"
            {...help('content.stage-reset')}
          >
            <ZoomIn size={14} />
          </button>
        </Tooltip>
        <div className="w-px h-5 bg-line-2 mx-1"></div>
        <Tooltip id="content.stage-grid">
          <button
            onClick={() => setShowGrid(!showGrid)}
            className={`p-1.5 rounded-sm border transition-colors ${showGrid ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
            title="Toggle Grid"
            aria-label="Toggle grid"
            aria-pressed={showGrid}
            {...help('content.stage-grid')}
          >
            <Grid3X3 size={14} />
          </button>
        </Tooltip>
        {showGrid && (
          <Tooltip id="content.stage-grid-divisions">
            <input
              type="number"
              min={1}
              max={64}
              value={gridDivisions}
              onChange={(e) => setGridDivisions(Math.max(1, Math.min(64, Math.round(parseFloat(e.target.value) || 1))))}
              title="Grid divisions"
              aria-label="Grid divisions"
              className="w-11 px-1.5 py-1 text-center num text-mini rounded-sm border border-line-1 bg-surface-2 text-fg-1 focus:border-accent focus:outline-none"
              {...help('content.stage-grid-divisions')}
            />
          </Tooltip>
        )}
        <Tooltip id="content.stage-snap">
          <button
            onClick={() => setSnapEnabled(!snapEnabled)}
            className={`p-1.5 rounded-sm border transition-colors ${snapEnabled ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
            title="Toggle Snapping"
            aria-label="Toggle snapping"
            aria-pressed={snapEnabled}
            {...help('content.stage-snap')}
          >
            <Magnet size={14} />
          </button>
        </Tooltip>
        {extraControls && <div className="ml-auto flex items-center gap-1">{extraControls}</div>}
      </div>
      {/* Pannable/zoomable canvas region. viewportRef tracks THIS element (not the header+canvas
          combined) so zoom-to-cursor / pan bounding-rect math stays correct. */}
      <div
        ref={viewportRef}
        className="flex-1 relative overflow-hidden cursor-default"
        onWheel={handleWheel}
        onDragOver={(e) => { if (onDropAsset && e.dataTransfer.types.includes('application/artlux-asset')) e.preventDefault(); }}
        onDrop={(e) => {
          if (!onDropAsset) return;
          const raw = e.dataTransfer.getData('application/artlux-asset');
          if (!raw || !containerRef.current) return;
          e.preventDefault();
          let asset: { id: string; type: string; path: string };
          try { asset = JSON.parse(raw); } catch { return; }
          if (asset.type !== 'video' && asset.type !== 'image') return; // only video/image fill a surface
          const r = containerRef.current.getBoundingClientRect();
          const nx = (e.clientX - r.left) / r.width, ny = (e.clientY - r.top) / r.height;
          // Topmost surface (highest zIndex; later in array wins ties) whose rect contains the drop.
          let hit: Surface | null = null;
          for (const s of surfaces) {
            if (nx >= s.x && nx <= s.x + s.width && ny >= s.y && ny <= s.y + s.height) {
              if (!hit || (s.zIndex ?? 0) >= (hit.zIndex ?? 0)) hit = s;
            }
          }
          if (hit) { onSelectSurface(hit.id); onDropAsset(hit.id, asset); }
        }}
        onMouseDown={(e) => {
           if (e.button === 1 || (e.button === 0 && e.shiftKey === false)) {
               startDrag(e, 'pan');
           } else {
               onSelectFixture('');
           }
        }}
      >
      <div
        style={{
            transform: `translate(${viewState.x}px, ${viewState.y}px) scale(${viewState.scale})`,
            transformOrigin: '0 0',
            width: '100%',
            height: '100%',
        }}
      >
          <div
            ref={containerRef}
            className="absolute shadow-e3 bg-surface-4 border border-line-1"
            style={{
                width: `${stageW}px`,
                height: `${stageH}px`,
                left: '50%',
                top: '50%',
                marginLeft: `${-stageW / 2}px`,
                marginTop: `${-stageH / 2}px`,
            }}
          >
            {/* Layout grid — divides the square into `gridDivisions` cells for placement. */}
            {showGrid && (
                <div
                    className="absolute inset-0 pointer-events-none z-[1]"
                    style={{
                        backgroundImage: 'linear-gradient(rgba(255,255,255,0.16) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.16) 1px, transparent 1px)',
                        backgroundSize: `${100 / gridDivisions}% ${100 / gridDivisions}%`,
                    }}
                />
            )}
            {activeSnapLines.x.map((x, i) => (
                <div key={`sx-${i}`} className="absolute top-0 bottom-0 w-px bg-sel-surface z-stage-guide shadow-[0_0_4px_rgba(39,182,196,0.8)]" style={{ left: `${x * 100}%` }}></div>
            ))}
            {activeSnapLines.y.map((y, i) => (
                <div key={`sy-${i}`} className="absolute left-0 right-0 h-px bg-sel-surface z-stage-guide shadow-[0_0_4px_rgba(39,182,196,0.8)]" style={{ top: `${y * 100}%` }}></div>
            ))}

            {webglError && (
            <div className="absolute inset-0 z-stage-overlay bg-black/90 flex flex-col items-center justify-center text-danger font-mono text-xs text-center p-4">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>WebGL Initialization Failed</p>
                <p className="opacity-50 mt-1">Check browser hardware acceleration settings</p>
            </div>
            )}

            {/* Non-blocking honesty banner: distinct from the full-screen webglError overlay above. Shows
                when the WebGPU compute path is unavailable and the WebGL fallback (approximate per-surface
                sampling) is running. Dismissable; re-shows on the next fallback (remount). */}
            {reducedMode && !reducedDismissed && (
            <div className="absolute top-0 left-0 right-0 z-stage-overlay flex items-center gap-2 px-3 py-1.5 text-mini font-medium pointer-events-none" style={{ background: '#e3b341', color: '#151515' }}>
                <AlertCircle size={13} className="shrink-0" />
                <span className="flex-1">Reduced rendering mode — GPU compute (WebGPU) unavailable. Per-surface sampling is approximate; fixtures may sample overlapping surfaces.</span>
                <button onClick={() => setReducedDismissed(true)} className="shrink-0 hover:opacity-70 pointer-events-auto" aria-label="Dismiss reduced-mode notice" title="Dismiss">✕</button>
            </div>
            )}

            <canvas
                ref={canvasRef}
                width={512} height={512}
                className="absolute top-0 left-0 w-full h-full object-fill pointer-events-none"
                style={{ filter: 'brightness(var(--preview-brightness, 1))' }}
            />

            {/* Surfaces (cyan) — behind fixtures. Container ignores pointer events so empty
                areas fall through to the viewport; each surface re-enables them. */}
            <div className="absolute top-0 left-0 w-full h-full z-[5] pointer-events-none">
            {renderSurfacesList.map((s) => {
                const sel = s.id === selectedSurfaceId;
                return (
                    <div
                        key={s.id}
                        onMouseDown={(e) => startSurfaceDrag(e, 'move', s.id)}
                        className={`absolute cursor-move pointer-events-auto ${sel ? 'z-[8]' : ''}`}
                        style={{
                            left: `${s.x * 100}%`, top: `${s.y * 100}%`,
                            width: `${s.width * 100}%`, height: `${s.height * 100}%`,
                            transform: `rotate(${s.rotation}deg)`, transformOrigin: 'center center',
                        }}
                    >
                        <div className={`w-full h-full border ${sel ? 'border-sel-surface shadow-[0_0_10px_rgba(39,182,196,0.25)]' : 'border-dashed border-sel-surface/40'}`}></div>
                        <div
                            className="absolute -top-5 left-0 text-micro font-mono text-sel-surface bg-black/70 px-1 whitespace-nowrap pointer-events-none"
                            style={{ transform: `rotate(${-s.rotation}deg)` }}
                        >{s.name}</div>
                        {sel && (
                            <>
                                <div
                                    className="absolute -top-6 left-1/2 -translate-x-1/2 w-px h-6 bg-sel-surface origin-bottom cursor-alias flex flex-col items-center justify-start pointer-events-auto"
                                    onMouseDown={(e) => startSurfaceDrag(e, 'rotate', s.id)}
                                >
                                    <div className="w-2.5 h-2.5 bg-black border border-sel-surface rounded-full -mt-1 hover:bg-sel-surface transition-colors"></div>
                                </div>
                                <div
                                    className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-black border border-sel-surface hover:bg-sel-surface transition-colors cursor-nwse-resize pointer-events-auto"
                                    onMouseDown={(e) => startSurfaceDrag(e, 'resize', s.id)}
                                ></div>
                            </>
                        )}
                    </div>
                );
            })}
            </div>

            <div className="absolute top-0 left-0 w-full h-full z-10 overflow-hidden pointer-events-none">
            {renderFixturesList.map((fixture) => {
                const isPrimary = selectedFixtureId === fixture.id;
                const isSel = isPrimary || selectedFixtureIds.includes(fixture.id);
                return (
                <div
                key={fixture.id}
                ref={(el) => {
                    if (el) fixtureRefs.current.set(fixture.id, el);
                    else fixtureRefs.current.delete(fixture.id);
                }}
                onMouseDown={(e) => startDrag(e, 'move', fixture.id)}
                className={`absolute group cursor-move flex items-center justify-center pointer-events-auto ${
                    isPrimary ? 'z-50' : isSel ? 'z-30' : 'z-20 hover:opacity-80 transition-opacity'
                }`}
                style={{
                    left: `${fixture.x * 100}%`,
                    top: `${fixture.y * 100}%`,
                    width: `${fixture.width * 100}%`,
                    height: `${fixture.height * 100}%`,
                    transform: `rotate(${fixture.rotation || 0}deg)`,
                    transformOrigin: 'center center'
                }}
                >
                    <div className={`w-full h-full border ${isSel ? 'border-sel-fixture shadow-[0_0_10px_rgba(255,59,59,0.35)]' : 'border-white/25'}`}></div>

                    {isSel && (
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-sel-fixture/60"></div>
                    )}

                    {isPrimary && (
                        <>
                            <div
                                className="absolute -top-6 left-1/2 -translate-x-1/2 w-px h-6 bg-sel-fixture origin-bottom cursor-alias flex flex-col items-center justify-start z-50 pointer-events-auto"
                                onMouseDown={(e) => startDrag(e, 'rotate', fixture.id)}
                            >
                                <div className="w-2.5 h-2.5 bg-black border border-sel-fixture rounded-full -mt-1 hover:bg-sel-fixture transition-colors"></div>
                            </div>

                            <div
                                className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-black border border-sel-fixture hover:bg-sel-fixture transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 135) }}
                                onMouseDown={(e) => startDrag(e, 'resize-xy', fixture.id)}
                            ></div>

                            <div
                                className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-1.5 h-4 bg-black border border-sel-fixture hover:bg-sel-fixture transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 90) }}
                                onMouseDown={(e) => startDrag(e, 'resize-x', fixture.id)}
                            ></div>

                            <div
                                className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-1.5 bg-black border border-sel-fixture hover:bg-sel-fixture transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 180) }}
                                onMouseDown={(e) => startDrag(e, 'resize-y', fixture.id)}
                            ></div>

                            <div
                                className="absolute -top-6 left-0 text-micro font-mono text-sel-fixture bg-black/80 px-1 border border-sel-fixture/25 whitespace-nowrap z-50 pointer-events-none"
                                style={{ transform: `rotate(-${fixture.rotation || 0}deg)` }}
                            >
                                {fixture.name} <span className="text-fg-3">|</span> U:{fixture.universe}.{fixture.startAddress}
                            </div>
                        </>
                    )}
                </div>
                );
            })}
            </div>
        </div>
      </div>
        
      </div>
    </div>
  );
};

// MEMOIZED, and that is only meaningful because App hands it stable props.
//
// This is the heaviest always-mounted element in the app, and it used to reconcile on every App
// render — including ones that had nothing to do with it, like switching workspace context. A
// shallow compare cannot bail out while the parent builds fresh callbacks and inline JSX per render,
// so App wraps the handlers with useStableHandlers and memoizes extraControls. Remove either and
// this memo silently becomes a wasted comparison rather than a saving.
export const Stage = React.memo(StageView);
