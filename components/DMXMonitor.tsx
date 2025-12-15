import React, { useMemo, useRef, useEffect } from 'react';
import { Fixture } from '../types';
import { Activity, Zap } from 'lucide-react';
import { dmxSignal } from '../services/dmxSignal';

interface DMXMonitorProps {
  fixtures: Fixture[];
}

// Optimized Strip Component that listens to the bus
const FixtureStrip: React.FC<{ fixture: Fixture, offset: number }> = ({ fixture, offset }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const offsetRef = useRef(offset);
    
    useEffect(() => {
        offsetRef.current = offset;
    }, [offset]);

    useEffect(() => {
        const cvs = canvasRef.current;
        if (!cvs) return;
        const ctx = cvs.getContext('2d');
        if (!ctx) return;

        // One-time sizing (assuming fixture LED count doesn't change rapidly)
        cvs.width = fixture.ledCount;
        cvs.height = 1;

        // Pre-allocate buffer for this strip
        const imgData = ctx.createImageData(fixture.ledCount, 1);
        const data = imgData.data;

        // Signal Listener
        const unsubscribe = dmxSignal.subscribe((packet) => {
            const allPixels = packet.pixels;
            const startIdx = offsetRef.current * 4;
            const endIdx = startIdx + (fixture.ledCount * 4);
            
            if (endIdx > allPixels.length) return;

            // Copy from main buffer to local image data
            let ptr = 0;
            for(let i = startIdx; i < endIdx; i+=4) {
                 // R
                 data[ptr] = allPixels[i];
                 // G
                 data[ptr+1] = allPixels[i+1];
                 // B
                 data[ptr+2] = allPixels[i+2];
                 // A (Full Alpha)
                 data[ptr+3] = 255;
                 ptr += 4;
            }

            ctx.putImageData(imgData, 0, 0);
        });

        return () => {
            unsubscribe();
        };

    }, [fixture.ledCount]); // Re-bind if LED count changes to resize canvas

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
    const touchedUniverses = new Set<number>();
    
    fixtures.forEach(f => {
        const startAbs = f.universe * 512 + (f.startAddress - 1);
        const totalCh = f.ledCount * 4;
        const endAbs = startAbs + totalCh - 1;
        const startU = Math.floor(startAbs / 512);
        const endU = Math.floor(endAbs / 512);
        for (let u = startU; u <= endU; u++) touchedUniverses.add(u);
    });

    return { channels, universes: touchedUniverses.size };
  }, [fixtures]);

  // Pre-calculate linear offsets for each fixture
  const fixtureOffsets = useMemo(() => {
      const offsets: Record<string, number> = {};
      let current = 0;
      fixtures.forEach(f => {
          offsets[f.id] = current;
          current += f.ledCount;
      });
      return offsets;
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
                const startAbs = fixture.universe * 512 + (fixture.startAddress - 1);
                const endAbs = startAbs + (fixture.ledCount * 4) - 1;
                const startU = Math.floor(startAbs / 512);
                const endU = Math.floor(endAbs / 512);
                const uDisplay = startU === endU ? `${startU}` : `${startU}-${endU}`;

                return (
                    <div key={fixture.id} className="bg-[#121212] border border-[#222] rounded-lg overflow-hidden flex flex-col">
                        <div className="bg-[#161616] px-4 py-3 border-b border-[#222] flex justify-between items-center">
                            <span className="font-bold text-sm text-white">{fixture.name}</span>
                            <div className="flex items-center gap-2 text-xs font-mono text-gray-500">
                                <span className="bg-[#0a0a0a] px-1.5 py-0.5 rounded border border-[#333]">U:{uDisplay}</span>
                                <span className="bg-[#0a0a0a] px-1.5 py-0.5 rounded border border-[#333]">{fixture.ledCount} LEDS</span>
                            </div>
                        </div>

                        <div className="p-4 space-y-4">
                            <FixtureStrip fixture={fixture} offset={fixtureOffsets[fixture.id]} />
                            
                            <div className="text-[10px] text-gray-600 font-mono text-center">
                                Live Preview Active
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    </div>
  );
};