import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Fixture, SourceType, RGBW } from '../types';
import { Maximize, RotateCw, Move } from 'lucide-react';
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
  globalBrightness
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  
  const mapper = useRef<GPUMapper | null>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [initialFixtureState, setInitialFixtureState] = useState<{ x: number, y: number, w: number, h: number, r: number }>({ x: 0, y: 0, w: 0, h: 0, r: 0 });
  const [activeHandle, setActiveHandle] = useState<string | null>(null);

  // Initialize GPU Mapper with Square dimensions
  useEffect(() => {
    if (!mapper.current) {
        mapper.current = new GPUMapper(512, 512);
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
  // Handles switching between Camera, Video, and Image modes
  useEffect(() => {
      const videoEl = videoRef.current;
      if (!videoEl) return;

      const setupMedia = async () => {
          // 1. Reset state (Stop existing streams)
          if (videoEl.srcObject) {
              const stream = videoEl.srcObject as MediaStream;
              stream.getTracks().forEach(track => track.stop());
              videoEl.srcObject = null;
          }
          
          // 2. Initialize new source
          if (sourceType === SourceType.CAMERA) {
              try {
                  // Ensure src attribute doesn't interfere
                  videoEl.removeAttribute('src');
                  // Need to load to clear any previous file buffer so srcObject takes precedence
                  videoEl.load(); 
                  
                  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                  // Check if we are still on the same request (race condition check)
                  if (videoRef.current === videoEl && sourceType === SourceType.CAMERA) {
                       videoEl.srcObject = stream;
                       await videoEl.play();
                  } else {
                      // Cleanup if we switched away while waiting
                      stream.getTracks().forEach(t => t.stop());
                  }
              } catch (err) {
                  console.error("Error accessing camera:", err);
              }
          } else if (sourceType === SourceType.VIDEO) {
               // For video files, React updates the `src` prop.
               // We force a reload to ensure the new source is picked up.
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

      // Cleanup function when switching AWAY from this configuration
      return () => {
          if (videoEl.srcObject) {
              const stream = videoEl.srcObject as MediaStream;
              stream.getTracks().forEach(track => track.stop());
              videoEl.srcObject = null;
          }
          videoEl.pause();
      };
  }, [sourceType, sourceUrl]); // Only run when source definition changes

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

    // Draw Source to Visual Canvas with "Fit/Contain" logic
    if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        if (ctx) {
            const cw = canvasRef.current.width;
            const ch = canvasRef.current.height;
            
            // Clear
            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, cw, ch);

            if (sourceElement) {
                let ready = true;
                if (sourceElement instanceof HTMLVideoElement && sourceElement.readyState < 2) {
                    ready = false;
                }
                // For images, ensure complete
                 if (sourceElement instanceof HTMLImageElement && !sourceElement.complete) {
                    ready = false;
                }

                if (ready) {
                     // Calculate Source Dimensions
                     let sw = 0, sh = 0;
                     if (sourceElement instanceof HTMLVideoElement) {
                         sw = sourceElement.videoWidth;
                         sh = sourceElement.videoHeight;
                     } else {
                         sw = sourceElement.naturalWidth || sourceElement.width;
                         sh = sourceElement.naturalHeight || sourceElement.height;
                     }

                     // Calculate Fit
                     if (sw > 0 && sh > 0) {
                         const ca = cw / ch;
                         const sa = sw / sh;
                         let dw, dh, dx, dy;

                         if (sa > ca) {
                             // Source wider
                             dw = cw;
                             dh = cw / sa;
                             dx = 0;
                             dy = (ch - dh) / 2;
                         } else {
                             // Source taller
                             dh = ch;
                             dw = ch * sa;
                             dy = 0;
                             dx = (cw - dw) / 2;
                         }
                         
                         ctx.drawImage(sourceElement, dx, dy, dw, dh);
                     }
                }
            }
        }
    }

    // Use the CANVAs as the source for GPU mapping
    // This ensures that black bars and fitting are respected in the mapping
    if (canvasRef.current && isEngineRunning) {
        mapper.current.updateSource(canvasRef.current);
        const rawBytes = mapper.current.read();

        if (rawBytes) {
            let offset = 0;
            const updatedFixtures = fixtures.map(f => {
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
  }, [sourceType, isEngineRunning, onUpdateFixtures, fixtures]);

  useEffect(() => {
    requestRef.current = requestAnimationFrame(tick);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [tick]);

  const handleMouseDown = (e: React.MouseEvent, fixtureId: string, handle: string | null = null) => {
    e.stopPropagation();
    onSelectFixture(fixtureId);
    const fixture = fixtures.find(f => f.id === fixtureId);
    if (!fixture) return;

    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
    setInitialFixtureState({ 
        x: fixture.x, 
        y: fixture.y, 
        w: fixture.width, 
        h: fixture.height,
        r: fixture.rotation || 0
    });
    setActiveHandle(handle);
  };

  const handleStageMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !selectedFixtureId || !containerRef.current) return;

    const fixtureIndex = fixtures.findIndex(f => f.id === selectedFixtureId);
    if (fixtureIndex === -1) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const newFixtures = [...fixtures];
    const target = { ...newFixtures[fixtureIndex] };

    if (activeHandle === 'rotate') {
        const cx = containerRect.left + (initialFixtureState.x + initialFixtureState.w / 2) * containerRect.width;
        const cy = containerRect.top + (initialFixtureState.y + initialFixtureState.h / 2) * containerRect.height;
        const deltaX = e.clientX - cx;
        const deltaY = e.clientY - cy;
        const angleRad = Math.atan2(deltaY, deltaX);
        const angleDeg = angleRad * (180 / Math.PI);
        target.rotation = angleDeg + 90; 
    } 
    else if (activeHandle === 'resize-se') {
        const deltaX = (e.clientX - dragStart.x) / containerRect.width;
        const deltaY = (e.clientY - dragStart.y) / containerRect.height;
        target.width = Math.max(0.01, initialFixtureState.w + deltaX);
        target.height = Math.max(0.01, initialFixtureState.h + deltaY);
    } 
    else if (activeHandle === null) {
        const deltaX = (e.clientX - dragStart.x) / containerRect.width;
        const deltaY = (e.clientY - dragStart.y) / containerRect.height;
        target.x = initialFixtureState.x + deltaX;
        target.y = initialFixtureState.y + deltaY;
    }

    newFixtures[fixtureIndex] = target;
    onUpdateFixtures(newFixtures); 
  };

  const handleStageMouseUp = () => {
    setIsDragging(false);
    setActiveHandle(null);
  };

  return (
    <div 
      className="relative w-full h-full bg-[#050505] overflow-hidden flex items-center justify-center select-none"
      onMouseMove={handleStageMouseMove}
      onMouseUp={handleStageMouseUp}
      onMouseLeave={handleStageMouseUp}
    >
        {/* Background Grid Pattern */}
        <div 
            className="absolute inset-0 opacity-10 pointer-events-none"
            style={{ 
                backgroundImage: 'linear-gradient(#333 1px, transparent 1px), linear-gradient(90deg, #333 1px, transparent 1px)',
                backgroundSize: '20px 20px'
            }}
        ></div>

      <div 
        ref={containerRef}
        className="relative shadow-2xl bg-black border border-[#222]"
        style={{ width: '512px', height: '512px' }} 
      >
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

        {/* This canvas is now both the visual display AND the source for the GPU mapper */}
        <canvas 
            ref={canvasRef} 
            width={512} height={512} 
            className="absolute top-0 left-0 w-full h-full object-contain pointer-events-none opacity-50"
        />

        <div className="absolute top-0 left-0 w-full h-full z-10 overflow-hidden">
          {fixtures.map((fixture) => (
            <div
              key={fixture.id}
              onMouseDown={(e) => handleMouseDown(e, fixture.id)}
              className={`absolute group cursor-move flex items-center justify-center transition-all ${
                selectedFixtureId === fixture.id ? 'z-50' : 'z-20 hover:opacity-80'
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
                
                {/* Center Handle for moving */}
                {selectedFixtureId === fixture.id && (
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-accent/50"></div>
                )}

                {/* Handles */}
                {selectedFixtureId === fixture.id && (
                    <>
                        {/* Rotate Handle */}
                        <div 
                            className="absolute -top-6 left-1/2 -translate-x-1/2 w-px h-6 bg-accent origin-bottom cursor-alias flex flex-col items-center justify-start"
                            onMouseDown={(e) => handleMouseDown(e, fixture.id, 'rotate')}
                        >
                             <div className="w-2.5 h-2.5 bg-black border border-accent rounded-full -mt-1 hover:bg-accent transition-colors"></div>
                        </div>
                        {/* Resize Handle */}
                        <div 
                            className="absolute -bottom-1 -right-1 w-3 h-3 bg-black border border-accent cursor-se-resize flex items-center justify-center hover:bg-accent transition-colors"
                            onMouseDown={(e) => handleMouseDown(e, fixture.id, 'resize-se')}
                        >
                        </div>
                        
                        {/* Info Label */}
                        <div 
                             className="absolute -top-5 left-0 text-[9px] font-mono text-accent bg-black/80 px-1 border border-accent/20"
                             style={{ transform: `rotate(-${fixture.rotation || 0}deg)` }}
                        >
                            {fixture.name}
                        </div>
                    </>
                )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};