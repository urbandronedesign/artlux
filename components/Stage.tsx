import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Fixture, SourceType, RGBW } from '../types';
import { Maximize, RotateCw, Move, AlertCircle, Magnet, Grid3X3, ZoomIn } from 'lucide-react';
import { GPUMapper } from '../services/GPUMapper';

interface StageProps {
  sourceType: SourceType;
  sourceUrl: string | null;
  fixtures: Fixture[];
  onUpdateFixtures: (fixtures: Fixture[]) => void;
  selectedFixtureId: string | null;
  onSelectFixture: (id: string) => void;
  isEngineRunning: boolean;
  isVideoPlaying: boolean;
  globalBrightness: number;
  onRecordHistory: () => void;
}

export const Stage: React.FC<StageProps> = ({
  sourceType,
  sourceUrl,
  fixtures,
  onUpdateFixtures,
  selectedFixtureId,
  onSelectFixture,
  isEngineRunning,
  isVideoPlaying,
  globalBrightness,
  onRecordHistory
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  
  // Direct DOM Refs for high-performance updates
  const fixtureRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  
  // Keep a ref to fixtures to access latest state in event listeners without re-binding
  const fixturesRef = useRef(fixtures);
  useEffect(() => { fixturesRef.current = fixtures; }, [fixtures]);

  const mapper = useRef<GPUMapper | null>(null);
  const [webglError, setWebglError] = useState(false);
  
  // Viewport State
  const [viewState, setViewState] = useState({ x: 0, y: 0, scale: 0.8 });
  // We use a ref for viewState in events to avoid staleness
  const viewStateRef = useRef(viewState);
  useEffect(() => { viewStateRef.current = viewState; }, [viewState]);

  // Snapping State
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [activeSnapLines, setActiveSnapLines] = useState<{ x: number[], y: number[] }>({ x: [], y: [] });

  // --- INTERACTION STATE REFS (The solution to fluidity and state persistence) ---
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

  // Initialize GPU Mapper
  useEffect(() => {
    if (!mapper.current) {
        try {
            mapper.current = new GPUMapper(512, 512);
        } catch (e) {
            console.error("Failed to initialize GPU Mapper:", e);
            setWebglError(true);
        }
    }
  }, []);

  const fixtureLayoutSignature = useMemo(() => {
     return JSON.stringify(fixtures.map(f => ({
         id: f.id, x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation, c: f.ledCount
     })));
  }, [fixtures]);

  useEffect(() => {
    if (mapper.current) {
        mapper.current.updateMapping(fixtures);
    }
  }, [fixtureLayoutSignature]);

  useEffect(() => {
    if (mapper.current) {
        mapper.current.setBrightness(globalBrightness);
    }
  }, [globalBrightness]);

  // RESOURCE MANAGEMENT EFFECT
  useEffect(() => {
      const videoEl = videoRef.current;
      if (!videoEl) return;

      const setupMedia = async () => {
          if (videoEl.srcObject) {
              const stream = videoEl.srcObject as MediaStream;
              stream.getTracks().forEach(track => track.stop());
              videoEl.srcObject = null;
          }
          
          if (sourceType === SourceType.CAMERA) {
              try {
                  videoEl.removeAttribute('src');
                  videoEl.load(); 
                  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                  if (videoRef.current === videoEl && sourceType === SourceType.CAMERA) {
                       videoEl.srcObject = stream;
                       await videoEl.play();
                  } else {
                      stream.getTracks().forEach(t => t.stop());
                  }
              } catch (err) {
                  console.error("Error accessing camera:", err);
              }
          } else if (sourceType === SourceType.VIDEO) {
               videoEl.load();
               if (isVideoPlaying) {
                   try {
                       await videoEl.play();
                   } catch(e) {
                       console.warn("Video play failed:", e);
                   }
               }
          }
      };

      setupMedia();

      return () => {
          if (videoEl.srcObject) {
              const stream = videoEl.srcObject as MediaStream;
              stream.getTracks().forEach(track => track.stop());
              videoEl.srcObject = null;
          }
          videoEl.pause();
      };
  }, [sourceType, sourceUrl]); 

  // PLAYBACK CONTROL EFFECT
  useEffect(() => {
    const videoEl = videoRef.current;
    if (videoEl && (sourceType === SourceType.VIDEO || sourceType === SourceType.CAMERA)) {
        if (isVideoPlaying) {
            videoEl.play().catch(() => {});
        } else {
            videoEl.pause();
        }
    }
  }, [isVideoPlaying, sourceType]);

  const tick = useCallback(() => {
    if (!containerRef.current || !mapper.current) {
      requestRef.current = requestAnimationFrame(tick);
      return;
    }

    let sourceElement: HTMLVideoElement | HTMLImageElement | null = null;
    if (sourceType === SourceType.VIDEO || sourceType === SourceType.CAMERA) {
      sourceElement = videoRef.current;
    } else if (sourceType === SourceType.IMAGE) {
      sourceElement = imgRef.current;
    }

    if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            const cw = canvasRef.current.width;
            const ch = canvasRef.current.height;
            // Simple clear only if needed, optimize?
            // ctx.clearRect(0,0,cw,ch); // Optional if drawing full rect
            
            if (sourceElement) {
                let ready = true;
                if (sourceElement instanceof HTMLVideoElement && sourceElement.readyState < 2) ready = false;
                if (sourceElement instanceof HTMLImageElement && !sourceElement.complete) ready = false;

                if (ready) {
                     let sw = 0, sh = 0;
                     if (sourceElement instanceof HTMLVideoElement) {
                         sw = sourceElement.videoWidth;
                         sh = sourceElement.videoHeight;
                     } else {
                         sw = sourceElement.naturalWidth || sourceElement.width;
                         sh = sourceElement.naturalHeight || sourceElement.height;
                     }

                     if (sw > 0 && sh > 0) {
                         const ca = cw / ch;
                         const sa = sw / sh;
                         let dw, dh, dx, dy;

                         if (sa > ca) {
                             dw = cw; dh = cw / sa; dx = 0; dy = (ch - dh) / 2;
                         } else {
                             dh = ch; dw = ch * sa; dy = 0; dx = (cw - dw) / 2;
                         }
                         ctx.drawImage(sourceElement, dx, dy, dw, dh);
                     }
                }
            }
        }
    }

    if (canvasRef.current && isEngineRunning && mapper.current) {
        mapper.current.updateSource(canvasRef.current);
        const rawBytes = mapper.current.read();

        if (rawBytes) {
            let offset = 0;
            // Map raw bytes back to fixtures
            // We use fixturesRef to get the structure without depending on React prop updates
            // But we must call onUpdateFixtures to propagate changes up
            const updatedFixtures = fixturesRef.current.map(f => {
                const colors: RGBW[] = [];
                for (let i = 0; i < f.ledCount; i++) {
                    const idx = offset * 4;
                    if (idx < rawBytes.length) {
                        colors.push({
                            r: rawBytes[idx],
                            g: rawBytes[idx + 1],
                            b: rawBytes[idx + 2],
                            w: rawBytes[idx + 3]
                        });
                    } else {
                        colors.push({r:0, g:0, b:0, w:0});
                    }
                    offset++;
                }
                if (f.reverse) colors.reverse();
                return { ...f, colorData: colors };
            });
            onUpdateFixtures(updatedFixtures);
        }
    }
    
    requestRef.current = requestAnimationFrame(tick);
  }, [sourceType, isEngineRunning, onUpdateFixtures]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(tick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [tick]);

  // --- MOUSE EVENT HANDLERS ---

  // Global Mouse Move Handler
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
    
    // Check if we need to record history on FIRST move
    if (!state.hasMoved) {
        state.hasMoved = true;
        onRecordHistory(); // Snapshot before any changes apply
    }

    // Find the fixture index in the LATEST ref array
    const fixtures = fixturesRef.current;
    const fixtureIndex = fixtures.findIndex(f => f.id === state.targetId);
    if (fixtureIndex === -1) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const init = state.initialFixture;
    
    // Raw deltas in 0..1 space
    const deltaX = (e.clientX - state.startX) / containerRect.width;
    const deltaY = (e.clientY - state.startY) / containerRect.height;
    
    // Create a mutable copy of the target fixture
    const target = { ...fixtures[fixtureIndex] };

    // Snapping Logic Helpers
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
    }

    if (state.mode === 'move') {
        let newX = init.x + deltaX;
        let newY = init.y + deltaY;

        if (snapEnabled) {
             // X Snapping
             const sLeft = applySnap(newX, guidesX);
             const sRight = applySnap(newX + init.w, guidesX);
             const sCenter = applySnap(newX + init.w/2, guidesX);

             // Find best X snap
             let diff = SNAP_THRES;
             if (sLeft.snapped !== null) { newX = sLeft.val; currentSnapsX.push(sLeft.snapped); diff = 0; } // Priority
             else if (sRight.snapped !== null) { 
                 // Only snap if we haven't snapped left or if this is closer (implicit in applySnap threshold logic but simplified here)
                 newX = sRight.val - init.w; currentSnapsX.push(sRight.snapped); 
             }
             else if (sCenter.snapped !== null) { newX = sCenter.val - init.w/2; currentSnapsX.push(sCenter.snapped); }

             // Y Snapping
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
        // Calculate angle relative to center of fixture
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
        // Projection logic for rotated resizing
        // We calculate delta in the local rotated space
        const angleRad = (init.r * Math.PI) / 180;
        const cos = Math.cos(-angleRad);
        const sin = Math.sin(-angleRad);
        
        const localDx = deltaX * cos - deltaY * sin;
        const localDy = deltaX * sin + deltaY * cos;
        
        let newW = init.w;
        let newH = init.h;
        
        // Calculate new dims
        if (state.mode === 'resize-x' || state.mode === 'resize-xy') {
            newW = Math.max(0.01, init.w + localDx);
        }
        if (state.mode === 'resize-y' || state.mode === 'resize-xy') {
            newH = Math.max(0.01, init.h + localDy);
        }

        // Snapping (Simplified, only snaps right/bottom edges if changing)
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

        // ANCHOR COMPENSATION
        // When rotating around center, changing W/H shifts the visual edges unless X/Y is adjusted.
        // We define an anchor point (e.g., Left-Center for Right-Resize) and ensure it stays fixed in World Space.
        
        let anchorU = 0, anchorV = 0;
        if (state.mode === 'resize-x') { anchorU = 0; anchorV = 0.5; } // Keep Left fixed
        else if (state.mode === 'resize-y') { anchorU = 0.5; anchorV = 0; } // Keep Top fixed
        else { anchorU = 0; anchorV = 0; } // Keep Top-Left fixed (Standard)

        // Helper to get World Pos of a Local UV point (0..1)
        const getAnchorWorld = (fx: number, fy: number, fw: number, fh: number, fr: number) => {
             const cx = fx + fw/2;
             const cy = fy + fh/2;
             const rad = fr * (Math.PI / 180);
             const c = Math.cos(rad);
             const s = Math.sin(rad);
             
             // Offset from center (Rotated)
             const ox = (anchorU - 0.5) * fw;
             const oy = (anchorV - 0.5) * fh;
             
             const rx = ox * c - oy * s;
             const ry = ox * s + oy * c;
             
             return { x: cx + rx, y: cy + ry };
        };

        const oldAnchor = getAnchorWorld(init.x, init.y, init.w, init.h, init.r);
        const newAnchorUncorrected = getAnchorWorld(init.x, init.y, newW, newH, init.r);
        
        // Apply difference to target pos
        target.width = newW;
        target.height = newH;
        target.x = init.x + (oldAnchor.x - newAnchorUncorrected.x);
        target.y = init.y + (oldAnchor.y - newAnchorUncorrected.y);
    }

    // Direct DOM Update
    const el = fixtureRefs.current.get(state.targetId);
    if (el) {
        el.style.left = `${target.x * 100}%`;
        el.style.top = `${target.y * 100}%`;
        el.style.width = `${target.width * 100}%`;
        el.style.height = `${target.height * 100}%`;
        el.style.transform = `rotate(${target.rotation}deg)`;
    }

    // React State Update (throttled by react render cycle, but DOM is instant)
    setActiveSnapLines({ x: currentSnapsX, y: currentSnapsY });
    
    // Construct new fixtures array efficiently
    const nextFixtures = [...fixtures];
    nextFixtures[fixtureIndex] = target;
    
    // Update the ref immediately so next mouse event sees it
    fixturesRef.current = nextFixtures; 
    
    // Trigger React Update
    onUpdateFixtures(nextFixtures);

  }, [snapEnabled, onUpdateFixtures, onRecordHistory]);

  const handleWindowMouseUp = useCallback(() => {
    dragState.current.isDragging = false;
    dragState.current.mode = null;
    dragState.current.targetId = null;
    dragState.current.hasMoved = false;
    setActiveSnapLines({ x: [], y: [] });
    
    // Remove listeners
    window.removeEventListener('mousemove', handleWindowMouseMove);
    window.removeEventListener('mouseup', handleWindowMouseUp);
  }, [handleWindowMouseMove]);

  const startDrag = (e: React.MouseEvent, mode: 'move' | 'pan' | 'rotate' | 'resize-x' | 'resize-y' | 'resize-xy', fixtureId?: string) => {
      e.stopPropagation();
      e.preventDefault();

      // Setup Drag State
      dragState.current.isDragging = true;
      dragState.current.mode = mode;
      dragState.current.startX = e.clientX;
      dragState.current.startY = e.clientY;
      dragState.current.initialView = { ...viewStateRef.current };
      dragState.current.hasMoved = false; // Reset move tracking

      if (fixtureId) {
          onSelectFixture(fixtureId);
          dragState.current.targetId = fixtureId;
          const f = fixturesRef.current.find(fx => fx.id === fixtureId);
          if (f) {
              dragState.current.initialFixture = { 
                  x: f.x, y: f.y, w: f.width, h: f.height, r: f.rotation || 0 
              };
          }
      }

      // Add Global Listeners
      window.addEventListener('mousemove', handleWindowMouseMove);
      window.addEventListener('mouseup', handleWindowMouseUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const scaleFactor = 0.001;
    const newScale = Math.min(Math.max(viewState.scale - e.deltaY * scaleFactor, 0.1), 5);
    setViewState(prev => ({ ...prev, scale: newScale }));
  };

  const resetView = () => {
      setViewState({ x: 0, y: 0, scale: 0.8 });
  };

  // Helper for dynamic cursors based on rotation
  const getResizeCursor = (rotation: number, offset: number) => {
    const a = (rotation + offset) % 180; 
    const angle = a < 0 ? a + 180 : a;
    
    if (angle < 22.5 || angle >= 157.5) return 'ns-resize'; // Verticalish
    if (angle >= 22.5 && angle < 67.5) return 'nesw-resize'; // / diagonal
    if (angle >= 67.5 && angle < 112.5) return 'ew-resize'; // Horizontalish
    if (angle >= 112.5 && angle < 157.5) return 'nwse-resize'; // \ diagonal
    return 'move';
  };

  return (
    <div 
      ref={viewportRef}
      className="relative w-full h-full bg-[#111] overflow-hidden select-none cursor-default"
      onWheel={handleWheel}
      onMouseDown={(e) => {
         // Middle click or Space+Click
         if (e.button === 1 || (e.button === 0 && e.shiftKey === false)) {
             startDrag(e, 'pan');
         } else {
             // Deselect if clicking bg
             onSelectFixture('');
         }
      }}
    >
        {/* Infinite Background Grid Pattern */}
        {showGrid && (
             <div 
                className="absolute inset-0 pointer-events-none"
                style={{ 
                    backgroundImage: 'linear-gradient(#222 1px, transparent 1px), linear-gradient(90deg, #222 1px, transparent 1px)',
                    backgroundSize: `${32 * viewState.scale}px ${32 * viewState.scale}px`,
                    backgroundPosition: `${viewState.x}px ${viewState.y}px`,
                    opacity: 0.3
                }}
            />
        )}

      {/* Transformed Container */}
      <div 
        style={{
            transform: `translate(${viewState.x}px, ${viewState.y}px) scale(${viewState.scale})`,
            transformOrigin: '0 0',
            width: '100%',
            height: '100%',
        }}
      >
          {/* Centered Content Wrapper (512x512) centered in the view */}
          <div 
            ref={containerRef}
            className="absolute shadow-2xl bg-black border border-[#222]"
            style={{ 
                width: '512px', 
                height: '512px',
                left: '50%',
                top: '50%',
                marginLeft: '-256px',
                marginTop: '-256px'
            }} 
          >
            {/* Snap Lines (Visual Feedback) */}
            {activeSnapLines.x.map((x, i) => (
                <div key={`sx-${i}`} className="absolute top-0 bottom-0 w-px bg-cyan-500 z-[60] shadow-[0_0_4px_rgba(6,182,212,0.8)]" style={{ left: `${x * 100}%` }}></div>
            ))}
            {activeSnapLines.y.map((y, i) => (
                <div key={`sy-${i}`} className="absolute left-0 right-0 h-px bg-cyan-500 z-[60] shadow-[0_0_4px_rgba(6,182,212,0.8)]" style={{ top: `${y * 100}%` }}></div>
            ))}

            {webglError && (
            <div className="absolute inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center text-red-500 font-mono text-xs text-center p-4">
                <AlertCircle className="w-8 h-8 mb-2" />
                <p>WebGL Initialization Failed</p>
                <p className="opacity-50 mt-1">Check browser hardware acceleration settings</p>
            </div>
            )}

            <video 
                ref={videoRef} 
                src={sourceType === SourceType.VIDEO ? sourceUrl || undefined : undefined} 
                loop muted playsInline 
                crossOrigin="anonymous"
                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
            />
            <img 
                ref={imgRef} 
                src={sourceType === SourceType.IMAGE ? sourceUrl || undefined : undefined} 
                crossOrigin="anonymous" alt="source"
                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
            />

            <canvas 
                ref={canvasRef} 
                width={512} height={512} 
                className="absolute top-0 left-0 w-full h-full object-contain pointer-events-none opacity-50"
            />

            <div className="absolute top-0 left-0 w-full h-full z-10 overflow-hidden">
            {fixtures.map((fixture) => (
                <div
                key={fixture.id}
                ref={(el) => {
                    if (el) fixtureRefs.current.set(fixture.id, el);
                    else fixtureRefs.current.delete(fixture.id);
                }}
                onMouseDown={(e) => startDrag(e, 'move', fixture.id)}
                className={`absolute group cursor-move flex items-center justify-center ${
                    selectedFixtureId === fixture.id ? 'z-50' : 'z-20 hover:opacity-80 transition-opacity'
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
                    {/* Main Outline */}
                    <div className={`w-full h-full border ${selectedFixtureId === fixture.id ? 'border-accent shadow-[0_0_10px_rgba(6,182,212,0.3)]' : 'border-white/30'}`}></div>
                    
                    {/* Center Handle */}
                    {selectedFixtureId === fixture.id && (
                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent/50"></div>
                    )}

                    {/* Handles */}
                    {selectedFixtureId === fixture.id && (
                        <>
                            {/* Rotate Handle */}
                            <div 
                                className="absolute -top-6 left-1/2 -translate-x-1/2 w-px h-6 bg-accent origin-bottom cursor-alias flex flex-col items-center justify-start z-50 pointer-events-auto"
                                onMouseDown={(e) => startDrag(e, 'rotate', fixture.id)}
                            >
                                <div className="w-2.5 h-2.5 bg-black border border-accent rounded-full -mt-1 hover:bg-accent transition-colors"></div>
                            </div>
                            
                            {/* Resize XY (Corner) */}
                            <div 
                                className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-black border border-accent hover:bg-accent transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 135) }}
                                onMouseDown={(e) => startDrag(e, 'resize-xy', fixture.id)}
                            ></div>

                            {/* Resize X (Right) */}
                            <div 
                                className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-1.5 h-4 bg-black border border-accent hover:bg-accent transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 90) }}
                                onMouseDown={(e) => startDrag(e, 'resize-x', fixture.id)}
                            ></div>

                            {/* Resize Y (Bottom) */}
                            <div 
                                className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-1.5 bg-black border border-accent hover:bg-accent transition-colors z-50 pointer-events-auto"
                                style={{ cursor: getResizeCursor(fixture.rotation || 0, 180) }}
                                onMouseDown={(e) => startDrag(e, 'resize-y', fixture.id)}
                            ></div>
                            
                            {/* Info Label */}
                            <div 
                                className="absolute -top-6 left-0 text-[10px] font-mono text-accent bg-black/80 px-1 border border-accent/20 whitespace-nowrap z-50 pointer-events-none"
                                style={{ transform: `rotate(-${fixture.rotation || 0}deg)` }}
                            >
                                {fixture.name} <span className="text-gray-500">|</span> U:{fixture.universe}.{fixture.startAddress}
                            </div>
                        </>
                    )}
                </div>
            ))}
            </div>
        </div>
      </div>
        
        {/* Floating Toolbar */}
        <div className="absolute top-2 right-2 flex gap-1 z-[100]">
            <button 
                onClick={resetView}
                className="p-1.5 rounded border bg-black/50 border-white/10 text-gray-400 hover:bg-black/80"
                title="Reset View"
            >
                <ZoomIn size={14} />
            </button>
            <div className="w-px h-6 bg-white/10 mx-1"></div>
            <button 
                onClick={() => setShowGrid(!showGrid)}
                className={`p-1.5 rounded border ${showGrid ? 'bg-accent/20 border-accent text-accent' : 'bg-black/50 border-white/10 text-gray-400 hover:bg-black/80'}`}
                title="Toggle Grid"
            >
                <Grid3X3 size={14} />
            </button>
            <button 
                onClick={() => setSnapEnabled(!snapEnabled)}
                className={`p-1.5 rounded border ${snapEnabled ? 'bg-accent/20 border-accent text-accent' : 'bg-black/50 border-white/10 text-gray-400 hover:bg-black/80'}`}
                title="Toggle Snapping"
            >
                <Magnet size={14} />
            </button>
        </div>
    </div>
  );
};