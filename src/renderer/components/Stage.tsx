import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Fixture, Surface, Controller, ColorOrder } from '../types';
import { AlertCircle, Magnet, Grid3X3, ZoomIn } from 'lucide-react';
import { GPUMapper } from '../services/GPUMapper';
import { WebGPUMapper } from '../gpu/WebGPUMapper';
import { IPixelMapper } from '../services/PixelMapper';
import { dmxSignal } from '../services/dmxSignal';
import { livePreview } from '../services/livePreview';
import * as surfaceMedia from '../services/surfaceMedia';
import * as transitions from '../services/transitions';

interface StageProps {
  surfaces: Surface[];
  onUpdateSurfaces: (surfaces: Surface[]) => void;
  onDropAsset?: (surfaceId: string, asset: { id: string; type: string; path: string }) => void;
  selectedSurfaceId: string | null;
  onSelectSurface: (id: string) => void;
  controllers: Controller[];
  fixtures: Fixture[];
  onUpdateFixtures: (fixtures: Fixture[]) => void;
  selectedFixtureId: string | null;
  selectedFixtureIds?: string[];
  onSelectFixture: (id: string, additive?: boolean) => void;
  isEngineRunning: boolean;
  isVideoPlaying: boolean;
  globalBrightness: number;
  gamma: number;
  targetIp: string;
  broadcast: boolean;
  protocol: 'artnet' | 'sacn';
  onRecordHistory: () => void;
  /** Extra buttons rendered at the end of the stage's top-right toolbar (e.g. the 3D split toggle). */
  extraControls?: React.ReactNode;
}

// Output channel source-index order per ColorOrder ([R=0,G=1,B=2]).
const COLOR_ORDER: Record<ColorOrder, [number, number, number]> = {
  [ColorOrder.RGB]: [0, 1, 2],
  [ColorOrder.RBG]: [0, 2, 1],
  [ColorOrder.GRB]: [1, 0, 2],
  [ColorOrder.GBR]: [1, 2, 0],
  [ColorOrder.BRG]: [2, 0, 1],
  [ColorOrder.BGR]: [2, 1, 0],
};

export const Stage: React.FC<StageProps> = ({
  surfaces,
  onUpdateSurfaces,
  onDropAsset,
  selectedSurfaceId,
  onSelectSurface,
  controllers,
  fixtures,
  onUpdateFixtures,
  selectedFixtureId,
  selectedFixtureIds = [],
  onSelectFixture,
  isEngineRunning,
  isVideoPlaying,
  globalBrightness,
  gamma,
  targetIp,
  broadcast,
  protocol,
  onRecordHistory,
  extraControls,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);

  const fixtureRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fixturesRef = useRef(fixtures);
  useEffect(() => { fixturesRef.current = fixtures; }, [fixtures]);

  // Surfaces composited each frame; the media service owns element lifecycle.
  const surfacesRef = useRef(surfaces);
  useEffect(() => { surfacesRef.current = surfaces; }, [surfaces]);
  // Per-surface key of the content we've already aspect-fitted, so we fit once per source.
  const fittedAspect = useRef<Map<string, string>>(new Map());
  useEffect(() => { surfaceMedia.syncSurfaces(surfaces, isVideoPlaying); }, [surfaces, isVideoPlaying]);

  const controllersRef = useRef(controllers);
  useEffect(() => { controllersRef.current = controllers; }, [controllers]);

  const mapper = useRef<IPixelMapper | null>(null);
  const [webglError, setWebglError] = useState(false);
  const brightnessRef = useRef(globalBrightness);
  useEffect(() => { brightnessRef.current = globalBrightness; }, [globalBrightness]);

  // Output gamma LUT (applied during universe packing). Identity when gamma=1.
  const gammaLut = useMemo(() => {
    const lut = new Uint8Array(256);
    const g = gamma && gamma > 0 ? gamma : 1;
    for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.pow(i / 255, g) * 255);
    return lut;
  }, [gamma]);
  const gammaLutRef = useRef(gammaLut);
  useEffect(() => { gammaLutRef.current = gammaLut; }, [gammaLut]);

  const targetIpRef = useRef(targetIp);
  useEffect(() => { targetIpRef.current = targetIp; }, [targetIp]);
  const broadcastRef = useRef(broadcast);
  useEffect(() => { broadcastRef.current = broadcast; }, [broadcast]);
  const protocolRef = useRef(protocol);
  useEffect(() => { protocolRef.current = protocol; }, [protocol]);
  
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

  // Pool of 512-channel arrays keyed by `${destKey}#${universe}` (reused across frames).
  const universeBuffers = useRef<Record<string, number[]>>({});

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
        let m: IPixelMapper | null = null;
        try {
            m = await WebGPUMapper.create();
            if (m) console.log('[Stage] Using WebGPU compute mapper');
        } catch (e) {
            m = null;
        }
        if (!m) {
            try {
                m = new GPUMapper(512, 512);
                console.log('[Stage] Using WebGL mapper (fallback)');
            } catch (e) {
                console.error('Failed to initialize GPU Mapper:', e);
                setWebglError(true);
                return;
            }
        }
        if (cancelled) { m.dispose(); return; }
        mapper.current = m;
        // Apply current state captured after the async init.
        m.updateMapping(fixturesRef.current, surfacesRef.current);
        m.updateParams?.(fixturesRef.current);
        m.setBrightness(brightnessRef.current);
    })();
    return () => {
        cancelled = true;
        if (mapper.current) {
            mapper.current.dispose();
            mapper.current = null;
        }
    };
  }, []);

  const fixtureLayoutSignature = useMemo(() => {
     return JSON.stringify(fixtures.map(f => ({
         id: f.id, x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation, c: f.ledCount,
         rev: f.reverse, sh: f.shape, mw: f.matrixWidth, mh: f.matrixHeight, sp: f.serpentine,
         lm: f.ledMap ? f.ledMap.length : 0, surf: f.surfaceId ?? '',
         seg: f.segments ? f.segments.map(s => `${s.start}-${s.stop}`).join(',') : ''
     })));
  }, [fixtures]);

  // Surface geometry/linkage affects per-LED surface-local UVs and pass order.
  const surfaceLayoutSignature = useMemo(() => {
     return JSON.stringify(surfaces.map(s => ({ id: s.id, x: s.x, y: s.y, w: s.width, h: s.height, r: s.rotation, z: s.zIndex })));
  }, [surfaces]);

  useEffect(() => {
    if (mapper.current) {
        mapper.current.updateMapping(fixturesRef.current, surfacesRef.current);
    }
  }, [fixtureLayoutSignature, surfaceLayoutSignature]);

  // Cheap per-fixture effect/palette param updates (sliders/dropdowns) — no realloc.
  const fixtureParamSignature = useMemo(() => {
     return JSON.stringify(fixtures.map(f => ({
         s: f.source, e: f.effectId, p: f.paletteId, sp: f.speed, it: f.intensity, rw: f.rgbwMode,
         segp: f.segments ? f.segments.map(s => `${s.source},${s.effectId},${s.paletteId},${s.speed},${s.intensity}`).join('|') : ''
     })));
  }, [fixtures]);

  useEffect(() => {
    mapper.current?.updateParams?.(fixtures);
  }, [fixtureParamSignature]);

  // Mirror committed brightness into the imperative live channel (CSS var + mapper feed),
  // so scene recall / project load stay in sync. Live drags write here directly.
  useEffect(() => { livePreview.setBrightness(globalBrightness); }, [globalBrightness]);

  const tick = useCallback(() => {
    if (!containerRef.current || !mapper.current) {
      requestRef.current = requestAnimationFrame(tick);
      return;
    }

    // Fit each surface's rect to its content's aspect ratio once the media is loaded
    // (once per source). Keeps width + top-left, derives height (canvas is square, so a
    // normalized w/h ratio equals the displayed pixel ratio). User scale stays uniform.
    {
      let fitUpdate: Surface[] | null = null;
      for (const s of surfacesRef.current) {
        const aspect = surfaceMedia.getContentAspect(s);
        if (!aspect) continue;
        const key = `${s.content.type}:${s.content.url ?? s.content.spoutName ?? ''}`;
        if (fittedAspect.current.get(s.id) === key) continue;
        fittedAspect.current.set(s.id, key);
        if (Math.abs(s.width / s.height - aspect) > 0.01) {
          if (!fitUpdate) fitUpdate = [...surfacesRef.current];
          const i = fitUpdate.findIndex(x => x.id === s.id);
          fitUpdate[i] = { ...s, height: Math.max(0.01, s.width / aspect) };
        }
      }
      if (fitUpdate) { surfacesRef.current = fitUpdate; onUpdateSurfaces(fitUpdate); }
    }

    // Render-free fade overrides: an active scene/cue transition lays interpolated values over the
    // committed state each frame so the fade animates without a React re-render (idle ⇒ pass-through).
    const fade = transitions.sample(performance.now());
    let effSurfaces = surfacesRef.current;
    let effFixtures = fixturesRef.current;
    let effBrightness = livePreview.brightness;
    if (fade) {
        const v = fade.apply({ surfaces: effSurfaces, fixtures: effFixtures, globalBrightness: effBrightness });
        effSurfaces = v.surfaces; effFixtures = v.fixtures; effBrightness = v.globalBrightness;
        // Geometry fades change LED↔surface UV mapping → rebuild the GPU LED buffers this frame.
        if (fade.geometryAnimating) mapper.current.updateMapping?.(effFixtures, effSurfaces);
    }

    // Composite every surface's content into the 512² canvas (z-order). Fixtures
    // sample this composite (S1); strict per-surface sampling arrives in S3.
    if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            const cw = canvasRef.current.width;
            const ch = canvasRef.current.height;
            ctx.imageSmoothingEnabled = true;
            ctx.clearRect(0, 0, cw, ch);
            const ordered = [...effSurfaces].sort((a, b) => a.zIndex - b.zIndex);
            for (const s of ordered) {
                const d = surfaceMedia.getDrawable(s);
                if (!d) continue;
                ctx.globalAlpha = s.content.opacity ?? 1; // per-surface opacity (z-order alpha blend)
                const x = s.x * cw, y = s.y * ch, w = s.width * cw, h = s.height * ch;
                if (s.rotation) {
                    ctx.save();
                    ctx.translate(x + w / 2, y + h / 2);
                    ctx.rotate((s.rotation * Math.PI) / 180);
                    ctx.drawImage(d, -w / 2, -h / 2, w, h);
                    ctx.restore();
                } else {
                    ctx.drawImage(d, x, y, w, h);
                }
            }
            ctx.globalAlpha = 1;
        }
    }

    if (canvasRef.current && isEngineRunning && mapper.current) {
        // Pull brightness from the live channel each frame so slider drags affect output
        // immediately without committing React state (which would re-render the whole app).
        mapper.current.setBrightness(effBrightness);
        // WebGPU samples each fixture strictly from its linked surface; the WebGL
        // fallback samples the composite preview canvas.
        if (mapper.current.perSurface && mapper.current.renderSurfaces) {
            mapper.current.renderSurfaces((id) => {
                const s = effSurfaces.find((x) => x.id === id);
                return s ? surfaceMedia.getDrawable(s) : null;
            }, (id) => effSurfaces.find((x) => x.id === id)?.content.opacity ?? 1);
        } else {
            mapper.current.updateSource(canvasRef.current);
        }
        const rawBytes = mapper.current.read();

        if (rawBytes) {
            let offset = 0;
            const pool = universeBuffers.current;

            // Zero all pooled arrays (prevents ghosting when config changes).
            for (const k in pool) pool[k].fill(0);

            const defaultIp = targetIpRef.current;
            const defaultBroadcast = broadcastRef.current;
            const defaultProtocol = protocolRef.current;
            const currentFixtures = effFixtures;

            // Per-destination universe maps, keyed by `${protocol}|${ip}|${broadcast}`.
            const destinations: Record<string, {
                ip: string; protocol: 'artnet' | 'sacn'; broadcast: boolean; sparse: boolean;
                priority?: number; universes: Record<number, number[]>;
            }> = {};

            for (let fIdx = 0; fIdx < currentFixtures.length; fIdx++) {
                const f = currentFixtures[fIdx];

                // Destination resolves from the fixture's controller (S5), then any
                // per-fixture output override, then the global settings (back-compat).
                const ctrl = controllersRef.current.find(c => c.id === f.controllerId);
                const proto = f.output?.protocol || ctrl?.protocol || defaultProtocol;
                const ip = f.output?.ip || ctrl?.ip || defaultIp;
                const bcast = f.output?.broadcast ?? ctrl?.broadcast ?? defaultBroadcast;
                const priority = f.output?.priority ?? ctrl?.priority;
                const sparse = f.output?.sparse ?? false;
                const destKey = `${proto}|${ip}|${bcast ? 1 : 0}`;
                let dest = destinations[destKey];
                if (!dest) {
                    dest = { ip, protocol: proto, broadcast: bcast, sparse: false, priority, universes: {} };
                    destinations[destKey] = dest;
                }
                dest.sparse = dest.sparse || sparse;

                // Fetch (or lazily create) a pooled 512-array for a universe in this dest.
                const getArr = (u: number): number[] => {
                    const pk = `${destKey}#${u}`;
                    let arr = pool[pk];
                    if (!arr) { arr = new Array(512).fill(0); pool[pk] = arr; }
                    if (!dest!.universes[u]) dest!.universes[u] = arr;
                    return arr;
                };

                let currentUniverse = f.universe;
                let currentChannel = f.startAddress - 1; // 0-based

                const order = COLOR_ORDER[f.colorOrder ?? ColorOrder.RGB];
                const cpp = f.channelsPerPixel ?? 4;
                const lut = gammaLutRef.current;

                for (let i = 0; i < f.ledCount; i++) {
                    const idx = offset * 4;
                    if (idx + 3 >= rawBytes.length) break;

                    const rgb = [rawBytes[idx], rawBytes[idx + 1], rawBytes[idx + 2]];
                    const channels = [
                        lut[rgb[order[0]]],
                        lut[rgb[order[1]]],
                        lut[rgb[order[2]]],
                    ];
                    if (cpp === 4) channels.push(lut[rawBytes[idx + 3]]);

                    for (const val of channels) {
                        const arr = getArr(currentUniverse);
                        arr[currentChannel] = val;
                        currentChannel++;
                        if (currentChannel >= 512) { currentUniverse++; currentChannel = 0; }
                    }

                    offset++;
                }
            }

            // Broadcast canonical pixels (monitor/3D) + routing destinations (output).
            dmxSignal.publish(rawBytes, destinations);
        }
    }
    
    requestRef.current = requestAnimationFrame(tick);
  }, [isEngineRunning]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(tick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [tick]);

  // --- Surface drag (self-contained; cyan rectangles) ---
  const surfaceDrag = useRef<{ mode: 'move' | 'resize' | 'rotate' | null; id: string | null; sx: number; sy: number; init: { x: number; y: number; w: number; h: number; r: number } | null }>({ mode: null, id: null, sx: 0, sy: 0, init: null });

  const onSurfaceMove = useCallback((e: MouseEvent) => {
    const st = surfaceDrag.current;
    if (!st.mode || !st.id || !st.init || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = (e.clientX - st.sx) / rect.width;
    const dy = (e.clientY - st.sy) / rect.height;
    const cur = surfacesRef.current;
    const idx = cur.findIndex(s => s.id === st.id);
    if (idx === -1) return;
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
    const arr = [...cur]; arr[idx] = next; surfacesRef.current = arr; onUpdateSurfaces(arr);
  }, [onUpdateSurfaces]);

  const onSurfaceUp = useCallback(() => {
    surfaceDrag.current = { mode: null, id: null, sx: 0, sy: 0, init: null };
    window.removeEventListener('mousemove', onSurfaceMove);
    window.removeEventListener('mouseup', onSurfaceUp);
  }, [onSurfaceMove]);

  const startSurfaceDrag = (e: React.MouseEvent, mode: 'move' | 'resize' | 'rotate', id: string) => {
    e.stopPropagation();
    e.preventDefault();
    onSelectSurface(id);
    const s = surfacesRef.current.find(x => x.id === id);
    if (!s) return;
    surfaceDrag.current = { mode, id, sx: e.clientX, sy: e.clientY, init: { x: s.x, y: s.y, w: s.width, h: s.height, r: s.rotation } };
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

    const fixtures = fixturesRef.current;
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
    fixturesRef.current = nextFixtures; 
    onUpdateFixtures(nextFixtures);

  }, [snapEnabled, onUpdateFixtures, onRecordHistory]);

  const handleWindowMouseUp = useCallback(() => {
    dragState.current.isDragging = false;
    dragState.current.mode = null;
    dragState.current.targetId = null;
    dragState.current.hasMoved = false;
    setActiveSnapLines({ x: [], y: [] });
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', handleWindowMouseUp);
  }, [handleWindowMouseMove]);

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
          const f = fixturesRef.current.find(fx => fx.id === fixtureId);
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

  return (
    <div
      ref={viewportRef}
      className="relative w-full h-full bg-surface-0 overflow-hidden select-none cursor-default"
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
            className="absolute shadow-2xl bg-[#404040] border border-line-1"
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
                <div key={`sx-${i}`} className="absolute top-0 bottom-0 w-px bg-sel-surface z-[60] shadow-[0_0_4px_rgba(39,182,196,0.8)]" style={{ left: `${x * 100}%` }}></div>
            ))}
            {activeSnapLines.y.map((y, i) => (
                <div key={`sy-${i}`} className="absolute left-0 right-0 h-px bg-sel-surface z-[60] shadow-[0_0_4px_rgba(39,182,196,0.8)]" style={{ top: `${y * 100}%` }}></div>
            ))}

            {webglError && (
            <div className="absolute inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center text-danger font-mono text-xs text-center p-4">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>WebGL Initialization Failed</p>
                <p className="opacity-50 mt-1">Check browser hardware acceleration settings</p>
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
            {surfaces.map((s) => {
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
                            className="absolute -top-5 left-0 text-[9px] font-mono text-sel-surface bg-black/70 px-1 whitespace-nowrap pointer-events-none"
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
            {fixtures.map((fixture) => {
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
                                className="absolute -top-6 left-0 text-[10px] font-mono text-sel-fixture bg-black/80 px-1 border border-sel-fixture/25 whitespace-nowrap z-50 pointer-events-none"
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
        
        <div
            className="absolute top-2 right-2 flex items-center gap-1 z-[100]"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <button
                onClick={resetView}
                className="p-1.5 rounded-[var(--r-sm)] border bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 transition-colors"
                title="Reset View"
                aria-label="Reset view"
            >
                <ZoomIn size={14} />
            </button>
            <div className="w-px h-5 bg-line-2 mx-1"></div>
            <button
                onClick={() => setShowGrid(!showGrid)}
                className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${showGrid ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
                title="Toggle Grid"
                aria-label="Toggle grid"
                aria-pressed={showGrid}
            >
                <Grid3X3 size={14} />
            </button>
            {showGrid && (
                <input
                    type="number"
                    min={1}
                    max={64}
                    value={gridDivisions}
                    onChange={(e) => setGridDivisions(Math.max(1, Math.min(64, Math.round(parseFloat(e.target.value) || 1))))}
                    title="Grid divisions"
                    aria-label="Grid divisions"
                    className="w-11 px-1.5 py-1 text-center num text-[11px] rounded-[var(--r-sm)] border border-line-1 bg-surface-2/80 backdrop-blur-sm text-fg-1 focus:border-accent focus:outline-none"
                />
            )}
            <button
                onClick={() => setSnapEnabled(!snapEnabled)}
                className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${snapEnabled ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
                title="Toggle Snapping"
                aria-label="Toggle snapping"
                aria-pressed={snapEnabled}
            >
                <Magnet size={14} />
            </button>
            {extraControls && <><div className="w-px h-5 bg-line-2 mx-1"></div>{extraControls}</>}
        </div>
    </div>
  );
};