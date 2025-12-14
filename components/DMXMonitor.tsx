import React, { useMemo, useRef, useEffect } from 'react';
import { Fixture, RGBW } from '../types';
import { Activity, Zap } from 'lucide-react';

interface DMXMonitorProps {
  fixtures: Fixture[];
}

// Canvas component to render fixture strip efficiently
const FixtureStrip: React.FC<{ fixture: Fixture }> = ({ fixture }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    
    useEffect(() => {
        const cvs = canvasRef.current;
        if (!cvs) return;
        const ctx = cvs.getContext('2d');
        if (!ctx) return;

        // Resize
        // We render at 1x height but N width equal to LED count
        if (cvs.width !== fixture.ledCount) cvs.width = fixture.ledCount;
        if (cvs.height !== 1) cvs.height = 1;

        const imgData = ctx.createImageData(fixture.ledCount, 1);
        const data = imgData.data;
        const colors = fixture.colorData;
        
        if (colors && colors.length > 0) {
            for (let i = 0; i < fixture.ledCount; i++) {
                const c = colors[i] || { r:0, g:0, b:0, w:0 };
                const ptr = i * 4;
                // Add White channel to RGB for preview brightness
                // Standard RGBW to Screen RGB approximation
                const w = c.w || 0;
                data[ptr] = Math.min(255, c.r + w);
                data[ptr + 1] = Math.min(255, c.g + w);
                data[ptr + 2] = Math.min(255, c.b + w);
                data[ptr + 3] = 255; // Alpha
            }
        } else {
             data.fill(0);
             // Alpha 255
             for(let i=3; i<data.length; i+=4) data[i] = 255;
        }

        ctx.putImageData(imgData, 0, 0);

    }, [fixture.colorData, fixture.ledCount]);

    return (
        <canvas 
            ref={canvasRef}
            className="w-full h-8 bg-[#0a0a0a] rounded border border-[#333] image-pixelated"
            style={{ imageRendering: 'pixelated' }}
        />
    );
};

export const DMXMonitor: React.FC<DMXMonitorProps> = ({ fixtures }) => {
  
  // Calculate total stats
  const stats = useMemo(() => {
    const channels = fixtures.reduce((acc, f) => acc + (f.ledCount * 4), 0);
    
    // Calculate actual touched universes accounting for spanning
    const touchedUniverses = new Set<number>();
    
    fixtures.forEach(f => {
        const startAbs = f.universe * 512 + (f.startAddress - 1);
        const totalCh = f.ledCount * 4;
        const endAbs = startAbs + totalCh - 1;
        
        const startU = Math.floor(startAbs / 512);
        const endU = Math.floor(endAbs / 512);
        
        for (let u = startU; u <= endU; u++) {
            touchedUniverses.add(u);
        }
    });

    return { channels, universes: touchedUniverses.size };
  }, [fixtures]);

  return (
    <div className="flex-1 bg-[#050505] overflow-y-auto p-6 text-gray-300">
        {/* Header Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="bg-[#121212] border border-[#222] p-4 rounded-lg flex items-center justify-between">
                <div>
                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Total Fixtures</div>
                    <div className="text-2xl text-white font-mono mt-1">{fixtures.length}</div>
                </div>
                <Zap className="text-accent" size={24} />
            </div>
            <div className="bg-[#121212] border border-[#222] p-4 rounded-lg flex items-center justify-between">
                <div>
                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Active Channels</div>
                    <div className="text-2xl text-white font-mono mt-1">{stats.channels}</div>
                </div>
                <Activity className="text-green-500" size={24} />
            </div>
            <div className="bg-[#121212] border border-[#222] p-4 rounded-lg flex items-center justify-between">
                <div>
                    <div className="text-xs text-gray-500 uppercase font-bold tracking-wider">Universes Used</div>
                    <div className="text-2xl text-white font-mono mt-1">{stats.universes}</div>
                </div>
                <div className="text-2xl font-bold text-gray-700">U</div>
            </div>
        </div>

        {/* Fixture Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {fixtures.map(fixture => {
                // Calculate universe span for display
                const startAbs = fixture.universe * 512 + (fixture.startAddress - 1);
                const endAbs = startAbs + (fixture.ledCount * 4) - 1;
                const startU = Math.floor(startAbs / 512);
                const endU = Math.floor(endAbs / 512);
                const uDisplay = startU === endU ? `${startU}` : `${startU}-${endU}`;

                return (
                    <div key={fixture.id} className="bg-[#121212] border border-[#222] rounded-lg overflow-hidden flex flex-col">
                        {/* Card Header */}
                        <div className="bg-[#161616] px-4 py-3 border-b border-[#222] flex justify-between items-center">
                            <span className="font-bold text-sm text-white">{fixture.name}</span>
                            <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
                                <span className="bg-[#0a0a0a] px-1.5 py-0.5 rounded border border-[#333]" title="Universe Range">U:{uDisplay}</span>
                                <span className="bg-[#0a0a0a] px-1.5 py-0.5 rounded border border-[#333]">ADDR:{fixture.startAddress}</span>
                                <span className="bg-[#0a0a0a] px-1.5 py-0.5 rounded border border-[#333]">{fixture.ledCount} LEDS</span>
                            </div>
                        </div>

                        {/* Content */}
                        <div className="p-4 space-y-4">
                            {/* Canvas Strip */}
                            <FixtureStrip fixture={fixture} />

                            {/* Data Grid Preview (First 32 pixels max to save rendering) */}
                            <div className="grid grid-cols-8 gap-1 text-[9px] font-mono text-gray-500">
                                {fixture.colorData && fixture.colorData.slice(0, 32).map((c, i) => (
                                    <div key={i} className="bg-[#0a0a0a] p-1 rounded border border-[#222] flex flex-col items-center">
                                        <span className="text-gray-600 mb-0.5">#{i+1}</span>
                                        <div className="flex gap-0.5 w-full h-1 mt-1">
                                            <div className="flex-1 bg-red-500/50" style={{height: `${(c.r/255)*100}%`}}></div>
                                            <div className="flex-1 bg-green-500/50" style={{height: `${(c.g/255)*100}%`}}></div>
                                            <div className="flex-1 bg-blue-500/50" style={{height: `${(c.b/255)*100}%`}}></div>
                                            <div className="flex-1 bg-white/50" style={{height: `${(c.w/255)*100}%`}}></div>
                                        </div>
                                    </div>
                                ))}
                                {fixture.ledCount > 32 && (
                                    <div className="col-span-8 text-center pt-1 italic opacity-50">
                                        + {fixture.ledCount - 32} more pixels...
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
  );
};