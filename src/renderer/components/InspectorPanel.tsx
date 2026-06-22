import React, { useState } from 'react';
import { Fixture, Surface, SurfaceContent, SourceType, AppSettings, PixelSource, LedShape, ColorOrder, RGBWMode, Layout3DType, VideoLayer } from '../types';
import { Monitor, Image as ImageIcon, Video, Map, Sparkles, Grid3x3, Network, Box, Cast, RefreshCw, Layers, Slash, Film } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { Slider } from './ui';
import { EFFECT_NAMES } from '../gpu/effects';
import { PALETTE_NAMES } from '../gpu/palettes';
import { effectivePosObj, effectiveRotObj, effectiveLayout } from '../services/led3dDefaults';
import { listSpoutSenders } from '../services/spoutReceiver';

interface InspectorPanelProps {
    surfaces: Surface[];
    selectedSurface: Surface | null;
    onUpdateSurface: (id: string, updates: Partial<Surface>) => void;
    selectedFixture: Fixture | null;
    onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
    settings: AppSettings;
    layers: VideoLayer[];
}

const PanelSection: React.FC<{ title: string; children: React.ReactNode; icon?: React.ReactNode }> = ({ title, children, icon }) => (
    <CollapsibleSection title={title} icon={icon} bodyClassName="p-3 bg-surface-1 space-y-3">
        {children}
    </CollapsibleSection>
);

const NumberInput: React.FC<{ label: string; value: number; onChange: (v: number) => void; step?: number }> = ({ label, value, onChange, step = 1 }) => (
    <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-fg-2 cursor-e-resize w-16 truncate">{label}</label>
        <input 
            type="number"
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none font-mono"
        />
    </div>
);

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
    surfaces,
    selectedSurface,
    onUpdateSurface,
    selectedFixture,
    onUpdateFixture,
    settings,
    layers,
}) => {
    const [segSel, setSegSel] = useState(0);
    const [spoutSenders, setSpoutSenders] = useState<string[]>([]);
    const refreshSpout = async () => setSpoutSenders(await listSpoutSenders());

    // Update the selected surface's content (merge).
    const setContent = (patch: Partial<SurfaceContent>) => {
        if (!selectedSurface) return;
        onUpdateSurface(selectedSurface.id, { content: { ...selectedSurface.content, ...patch } });
    };
    const setContentType = (type: SurfaceContent['type']) => {
        if (!selectedSurface) return;
        onUpdateSurface(selectedSurface.id, { content: { type } });
        if (type === SourceType.SPOUT) refreshSpout();
    };
    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: SourceType) => {
        const file = e.target.files?.[0];
        if (file) setContent({ type, url: URL.createObjectURL(file) });
    };

    const surfBtnCls = (active: boolean) =>
        `flex flex-col items-center justify-center p-2 rounded border transition-all ${active ? 'bg-sel-surface/10 border-sel-surface text-sel-surface' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`;

    // Load a WLED-style ledmap.json ({"map":[...]} or a bare array) -> physical->geometry order.
    const handleLedmapUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !selectedFixture) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target?.result as string);
                const map: number[] = Array.isArray(parsed) ? parsed : parsed.map;
                if (Array.isArray(map)) onUpdateFixture(selectedFixture.id, { ledMap: map });
                else alert('Unrecognized ledmap format (expected an array or {"map":[...]})');
            } catch {
                alert('Failed to parse ledmap JSON');
            }
        };
        reader.readAsText(file);
    };

    return (
        <div className="flex flex-col h-full bg-surface-1 overflow-y-auto">
            {/* Surface inspector (content + transform) */}
            {selectedSurface && (() => {
                const c = selectedSurface.content;
                const setXf = (patch: Partial<Surface>) => onUpdateSurface(selectedSurface.id, patch);
                return (
                <>
                <PanelSection title="Content" icon={<Layers size={12}/>}>
                    <div className="grid grid-cols-3 gap-1">
                        <button onClick={() => setContentType(SourceType.NONE)} className={surfBtnCls(c.type === SourceType.NONE)}>
                            <Slash size={16} className="mb-1"/><span className="text-[9px]">None</span>
                        </button>
                        <button onClick={() => setContentType(SourceType.CAMERA)} className={surfBtnCls(c.type === SourceType.CAMERA)}>
                            <Video size={16} className="mb-1"/><span className="text-[9px]">Camera</span>
                        </button>
                        <label className={`relative cursor-pointer ${surfBtnCls(c.type === SourceType.VIDEO)}`}>
                            <input type="file" accept="video/*" className="hidden" onChange={(e) => handleFileUpload(e, SourceType.VIDEO)} />
                            <Monitor size={16} className="mb-1"/><span className="text-[9px]">Video</span>
                        </label>
                        <label className={`relative cursor-pointer ${surfBtnCls(c.type === SourceType.IMAGE)}`}>
                            <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileUpload(e, SourceType.IMAGE)} />
                            <ImageIcon size={16} className="mb-1"/><span className="text-[9px]">Image</span>
                        </label>
                        <button onClick={() => setContentType(SourceType.DMX_IN)} className={surfBtnCls(c.type === SourceType.DMX_IN)} title="Art-Net / sACN in">
                            <Network size={16} className="mb-1"/><span className="text-[9px]">DMX In</span>
                        </button>
                        <button onClick={() => setContentType(SourceType.SPOUT)} className={surfBtnCls(c.type === SourceType.SPOUT)}>
                            <Cast size={16} className="mb-1"/><span className="text-[9px]">Spout</span>
                        </button>
                        <button onClick={() => setContentType('EFFECT')} className={surfBtnCls(c.type === 'EFFECT')}>
                            <Sparkles size={16} className="mb-1"/><span className="text-[9px]">Effect</span>
                        </button>
                        <button onClick={() => setContentType(SourceType.LAYER)} className={surfBtnCls(c.type === SourceType.LAYER)} title="A timeline video layer">
                            <Film size={16} className="mb-1"/><span className="text-[9px]">Layer</span>
                        </button>
                    </div>

                    {c.type === SourceType.LAYER && (
                        <div className="flex items-center gap-1 pt-1">
                            <label className="text-fg-2 w-12 text-[10px]">Track</label>
                            <select value={c.layerId ?? ''} onChange={(e) => setContent({ layerId: e.target.value })}
                                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
                                <option value="">— select a track —</option>
                                {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                            </select>
                        </div>
                    )}

                    {c.type === SourceType.SPOUT && (
                        <div className="flex items-center gap-1 pt-1">
                            <select
                                value={c.spoutName ?? ''}
                                onChange={(e) => setContent({ spoutName: e.target.value })}
                                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none"
                            >
                                <option value="">Active sender</option>
                                {spoutSenders.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                            <button onClick={refreshSpout} title="Refresh Spout senders" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
                        </div>
                    )}

                    {c.type === 'EFFECT' && (
                        <div className="space-y-3 pt-1">
                            <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-fg-2 w-16 truncate">Effect</label>
                                <select value={c.effectId ?? 0} onChange={(e) => setContent({ effectId: parseInt(e.target.value) })}
                                    className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                                    {EFFECT_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                </select>
                            </div>
                            <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-fg-2 w-16 truncate">Palette</label>
                                <select value={c.paletteId ?? 0} onChange={(e) => setContent({ paletteId: parseInt(e.target.value) })}
                                    className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                                    {PALETTE_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                </select>
                            </div>
                            <Slider label="Speed" value={c.speed ?? 0.5} min={0} max={1} step={0.01}
                                format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setContent({ speed: v })} />
                            <Slider label="Intensity" value={c.intensity ?? 0.5} min={0} max={1} step={0.01}
                                format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setContent({ intensity: v })} />
                        </div>
                    )}
                </PanelSection>

                <PanelSection title="Transform" icon={<Box size={12}/>}>
                    <NumberInput label="X" value={+selectedSurface.x.toFixed(3)} step={0.01} onChange={(v) => setXf({ x: v })} />
                    <NumberInput label="Y" value={+selectedSurface.y.toFixed(3)} step={0.01} onChange={(v) => setXf({ y: v })} />
                    <NumberInput label="Width" value={+selectedSurface.width.toFixed(3)} step={0.01} onChange={(v) => setXf({ width: Math.max(0.01, v) })} />
                    <NumberInput label="Height" value={+selectedSurface.height.toFixed(3)} step={0.01} onChange={(v) => setXf({ height: Math.max(0.01, v) })} />
                    <NumberInput label="Rotation" value={selectedSurface.rotation} step={1} onChange={(v) => setXf({ rotation: v })} />
                </PanelSection>
                </>
                );
            })()}

            {!selectedSurface && selectedFixture ? (
                <>
                <PanelSection title="Mapping" icon={<Map size={12}/>}>
                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-fg-2 w-16 truncate">Surface</label>
                        <select
                            value={selectedFixture.surfaceId ?? ''}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { surfaceId: e.target.value || undefined })}
                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                        >
                            <option value="">— none (off) —</option>
                            {surfaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                    </div>
                    <NumberInput label="LED Count" value={selectedFixture.ledCount} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { ledCount: Math.max(1, v) })} />
                    <NumberInput label="Universe" value={selectedFixture.universe} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { universe: Math.max(0, v) })} />
                    <NumberInput label="Start Addr" value={selectedFixture.startAddress} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { startAddress: Math.max(1, v) })} />
                    
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-line-1">
                        <span className="text-xs text-fg-2">Reverse Direction</span>
                        <input
                            type="checkbox"
                            checked={selectedFixture.reverse}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { reverse: e.target.checked })}
                            className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0"
                        />
                    </div>
                </PanelSection>

                {(() => {
                    const segs = selectedFixture.segments;
                    const hasSegs = !!(segs && segs.length);
                    const idx = Math.min(segSel, (segs?.length ?? 1) - 1);
                    const vals = hasSegs
                        ? segs![idx]
                        : {
                            source: selectedFixture.source ?? PixelSource.MEDIA,
                            effectId: selectedFixture.effectId ?? 0,
                            paletteId: selectedFixture.paletteId ?? 0,
                            speed: selectedFixture.speed ?? 0.5,
                            intensity: selectedFixture.intensity ?? 0.5,
                        };
                    const setVals = (patch: Partial<typeof vals>) => {
                        if (hasSegs) {
                            onUpdateFixture(selectedFixture.id, { segments: segs!.map((s, i) => i === idx ? { ...s, ...patch } : s) });
                        } else {
                            onUpdateFixture(selectedFixture.id, patch);
                        }
                    };
                    const enableSegments = () => {
                        const half = Math.max(1, Math.floor(selectedFixture.ledCount / 2));
                        const base = { source: vals.source, effectId: vals.effectId, paletteId: vals.paletteId, speed: vals.speed, intensity: vals.intensity };
                        onUpdateFixture(selectedFixture.id, { segments: [
                            { ...base, start: 0, stop: half },
                            { ...base, start: half, stop: selectedFixture.ledCount },
                        ] });
                        setSegSel(0);
                    };
                    const addSegment = () => {
                        const list = [...segs!];
                        const last = list[list.length - 1];
                        const mid = Math.floor((last.start + last.stop) / 2);
                        if (mid <= last.start || mid >= last.stop) return;
                        list[list.length - 1] = { ...last, stop: mid };
                        list.push({ ...last, start: mid, stop: last.stop });
                        onUpdateFixture(selectedFixture.id, { segments: list });
                    };
                    const removeSegment = (i: number) => {
                        if (!segs || segs.length <= 1) { onUpdateFixture(selectedFixture.id, { segments: undefined }); return; }
                        onUpdateFixture(selectedFixture.id, { segments: segs.filter((_, k) => k !== i) });
                        setSegSel(0);
                    };

                    return (
                        <PanelSection title="Effect" icon={<Sparkles size={12}/>}>
                            {/* Segments toolbar */}
                            <div className="flex items-center justify-between">
                                <span className="text-[10px] text-fg-3 uppercase tracking-wider">
                                    {hasSegs ? `${segs!.length} segments` : 'Whole fixture'}
                                </span>
                                {hasSegs ? (
                                    <div className="flex gap-1">
                                        <button onClick={addSegment} className="text-[10px] px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">+ Split</button>
                                        <button onClick={() => onUpdateFixture(selectedFixture.id, { segments: undefined })} className="text-[10px] px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">Merge</button>
                                    </div>
                                ) : (
                                    <button onClick={enableSegments} className="text-[10px] px-1.5 py-0.5 rounded border border-line-2 text-fg-2 hover:bg-surface-3">Split</button>
                                )}
                            </div>

                            {hasSegs && (
                                <div className="space-y-1">
                                    {segs!.map((s, i) => (
                                        <div key={i} className={`flex items-center justify-between text-[10px] px-1.5 py-1 rounded border ${i === idx ? 'border-accent bg-accent/10' : 'border-line-1 bg-surface-2'}`}>
                                            <button className="flex-1 text-left text-fg-1" onClick={() => setSegSel(i)}>Seg {i + 1} · LEDs {s.start}–{s.stop}</button>
                                            <button aria-label={`Remove segment ${i + 1}`} className="text-fg-3 hover:text-danger px-1" onClick={() => removeSegment(i)}>✕</button>
                                        </div>
                                    ))}
                                    <div className="flex gap-2 pt-1">
                                        <NumberInput label="Start" value={vals && 'start' in vals ? (vals as any).start : 0} step={1} onChange={(v) => setVals({ start: Math.max(0, Math.round(v)) } as any)} />
                                        <NumberInput label="Stop" value={vals && 'stop' in vals ? (vals as any).stop : 0} step={1} onChange={(v) => setVals({ stop: Math.round(v) } as any)} />
                                    </div>
                                </div>
                            )}

                            {/* Content source: media vs effect (targets fixture or selected segment) */}
                            <div className="grid grid-cols-2 gap-1 pt-1">
                                {([PixelSource.MEDIA, PixelSource.EFFECT] as const).map((src) => {
                                    const active = (vals.source ?? PixelSource.MEDIA) === src;
                                    return (
                                        <button key={src} onClick={() => setVals({ source: src })}
                                            className={`text-[10px] py-1.5 rounded border transition-all ${active ? 'bg-accent/10 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`}>
                                            {src === PixelSource.MEDIA ? 'Media' : 'Effect'}
                                        </button>
                                    );
                                })}
                            </div>

                            {(vals.source ?? PixelSource.MEDIA) === PixelSource.EFFECT && (
                                <div className="space-y-3 pt-1">
                                    <div className="flex items-center justify-between text-xs gap-2">
                                        <label className="text-fg-2 w-16 truncate">Effect</label>
                                        <select value={vals.effectId ?? 0} onChange={(e) => setVals({ effectId: parseInt(e.target.value) })}
                                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                                            {EFFECT_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                        </select>
                                    </div>
                                    <div className="flex items-center justify-between text-xs gap-2">
                                        <label className="text-fg-2 w-16 truncate">Palette</label>
                                        <select value={vals.paletteId ?? 0} onChange={(e) => setVals({ paletteId: parseInt(e.target.value) })}
                                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                                            {PALETTE_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                        </select>
                                    </div>
                                    <Slider label="Speed" value={vals.speed ?? 0.5} min={0} max={1} step={0.01}
                                        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setVals({ speed: v })} />
                                    <Slider label="Intensity" value={vals.intensity ?? 0.5} min={0} max={1} step={0.01}
                                        format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => setVals({ intensity: v })} />
                                </div>
                            )}
                        </PanelSection>
                    );
                })()}

                <PanelSection title="2D / Output" icon={<Grid3x3 size={12}/>}>
                    {/* Shape: line vs matrix */}
                    <div className="grid grid-cols-2 gap-1">
                        {([LedShape.LINE, LedShape.MATRIX] as const).map((sh) => {
                            const active = (selectedFixture.shape ?? LedShape.LINE) === sh;
                            return (
                                <button
                                    key={sh}
                                    onClick={() => onUpdateFixture(selectedFixture.id, { shape: sh })}
                                    className={`text-[10px] py-1.5 rounded border transition-all ${active ? 'bg-accent/10 border-accent text-accent' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`}
                                >
                                    {sh === LedShape.LINE ? 'Line' : 'Matrix'}
                                </button>
                            );
                        })}
                    </div>

                    {(selectedFixture.shape ?? LedShape.LINE) === LedShape.MATRIX && (
                        <div className="space-y-2 pt-1">
                            <NumberInput label="Cols" value={selectedFixture.matrixWidth ?? 8} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { matrixWidth: Math.max(1, v) })} />
                            <NumberInput label="Rows" value={selectedFixture.matrixHeight ?? 8} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { matrixHeight: Math.max(1, v) })} />
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-fg-2">Serpentine</span>
                                <input type="checkbox" checked={selectedFixture.serpentine ?? false}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { serpentine: e.target.checked })}
                                    className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between text-xs gap-2 pt-1">
                        <label className="text-fg-2 w-16 truncate">Color Order</label>
                        <select
                            value={selectedFixture.colorOrder ?? ColorOrder.RGB}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { colorOrder: e.target.value as ColorOrder })}
                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                        >
                            {Object.values(ColorOrder).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                    </div>

                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-fg-2 w-16 truncate">Channels</label>
                        <select
                            value={selectedFixture.channelsPerPixel ?? 4}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { channelsPerPixel: parseInt(e.target.value) as 3 | 4 })}
                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                        >
                            <option value={3}>RGB (3)</option>
                            <option value={4}>RGBW (4)</option>
                        </select>
                    </div>

                    {(selectedFixture.channelsPerPixel ?? 4) === 4 && (
                        <div className="flex items-center justify-between text-xs gap-2">
                            <label className="text-fg-2 w-16 truncate">White</label>
                            <select
                                value={selectedFixture.rgbwMode ?? RGBWMode.SUBTRACT}
                                onChange={(e) => onUpdateFixture(selectedFixture.id, { rgbwMode: e.target.value as RGBWMode })}
                                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                            >
                                <option value={RGBWMode.SUBTRACT}>Subtract min</option>
                                <option value={RGBWMode.NONE}>None</option>
                            </select>
                        </div>
                    )}

                    <label className="flex items-center justify-center gap-2 text-[10px] text-fg-2 bg-surface-3 hover:bg-surface-3 border border-line-2 rounded py-1.5 cursor-pointer mt-1">
                        <input type="file" accept=".json,application/json" className="hidden" onChange={handleLedmapUpload} />
                        {selectedFixture.ledMap ? `Ledmap: ${selectedFixture.ledMap.length} pts` : 'Load ledmap.json'}
                    </label>
                </PanelSection>

                <PanelSection title="Routing" icon={<Network size={12}/>}>
                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-fg-2 w-16 truncate">Protocol</label>
                        <select
                            value={selectedFixture.output?.protocol ?? ''}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, protocol: (e.target.value || undefined) as ('artnet' | 'sacn' | undefined) } })}
                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                        >
                            <option value="">Default ({settings.protocol})</option>
                            <option value="artnet">Art-Net</option>
                            <option value="sacn">sACN (E1.31)</option>
                        </select>
                    </div>
                    {(selectedFixture.output?.protocol ?? settings.protocol) === 'sacn' && (
                        <NumberInput label="Priority" value={selectedFixture.output?.priority ?? 100} step={1}
                            onChange={(v) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, priority: Math.max(0, Math.min(200, Math.round(v))) } })} />
                    )}
                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-fg-2 w-16 truncate">Target IP</label>
                        <input
                            type="text"
                            value={selectedFixture.output?.ip ?? ''}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, ip: e.target.value || undefined } })}
                            placeholder={settings.artNetIp + ' (default)'}
                            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none font-mono"
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-fg-2">Broadcast (override)</span>
                        <input type="checkbox" checked={selectedFixture.output?.broadcast ?? false}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, broadcast: e.target.checked } })}
                            className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-fg-2" title="Skip universes whose data is unchanged">Sparse output</span>
                        <input type="checkbox" checked={selectedFixture.output?.sparse ?? false}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, sparse: e.target.checked } })}
                            className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                    </div>
                    <div className="text-[9px] text-fg-3 font-mono">
                        Blank IP → global target. Each fixture can address its own controller.
                    </div>
                </PanelSection>

                {(() => {
                    const p = effectivePosObj(selectedFixture);
                    const rotDeg = effectiveRotObj(selectedFixture);
                    const L = effectiveLayout(selectedFixture);
                    const setPos = (k: 'x' | 'y' | 'z', v: number) =>
                        onUpdateFixture(selectedFixture.id, { position3D: { x: p.x, y: p.y, z: p.z, [k]: v } });
                    const setRot = (k: 'pitch' | 'yaw' | 'roll', v: number) =>
                        onUpdateFixture(selectedFixture.id, { rotation3D: { ...rotDeg, [k]: v } });
                    const setLayout = (patch: Partial<typeof L>) =>
                        onUpdateFixture(selectedFixture.id, { layout3D: { ...L, ...patch } });
                    return (
                        <PanelSection title="3D Layout" icon={<Box size={12}/>}>
                            <div className="text-[9px] text-fg-3 uppercase tracking-wider">Position (m)</div>
                            <NumberInput label="X" value={+p.x.toFixed(3)} step={0.05} onChange={(v) => setPos('x', v)} />
                            <NumberInput label="Y" value={+p.y.toFixed(3)} step={0.05} onChange={(v) => setPos('y', v)} />
                            <NumberInput label="Z" value={+p.z.toFixed(3)} step={0.05} onChange={(v) => setPos('z', v)} />
                            <div className="text-[9px] text-fg-3 uppercase tracking-wider pt-1">Rotation (°)</div>
                            <NumberInput label="Pitch" value={+rotDeg.pitch.toFixed(1)} step={1} onChange={(v) => setRot('pitch', v)} />
                            <NumberInput label="Yaw" value={+rotDeg.yaw.toFixed(1)} step={1} onChange={(v) => setRot('yaw', v)} />
                            <NumberInput label="Roll" value={+rotDeg.roll.toFixed(1)} step={1} onChange={(v) => setRot('roll', v)} />

                            <div className="flex items-center justify-between text-xs gap-2 pt-1">
                                <label className="text-fg-2 w-16 truncate">Layout</label>
                                <select
                                    value={L.type}
                                    onChange={(e) => setLayout({ type: e.target.value as Layout3DType })}
                                    className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none"
                                >
                                    <option value="line">Line</option>
                                    <option value="matrix">Matrix</option>
                                    <option value="arc">Arc</option>
                                </select>
                            </div>
                            {L.type !== 'arc' && (
                                <NumberInput label="Spacing" value={+L.ledSpacing.toFixed(4)} step={0.001} onChange={(v) => setLayout({ ledSpacing: Math.max(0.001, v) })} />
                            )}
                            {L.type === 'matrix' && (
                                <>
                                    <NumberInput label="Cols" value={L.matrixCols} step={1} onChange={(v) => setLayout({ matrixCols: Math.max(1, Math.round(v)) })} />
                                    <NumberInput label="Rows" value={L.matrixRows} step={1} onChange={(v) => setLayout({ matrixRows: Math.max(1, Math.round(v)) })} />
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-fg-2">Serpentine</span>
                                        <input type="checkbox" checked={L.serpentine}
                                            onChange={(e) => setLayout({ serpentine: e.target.checked })}
                                            className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0" />
                                    </div>
                                </>
                            )}
                            {L.type === 'arc' && (
                                <>
                                    <NumberInput label="Radius" value={+L.arcRadius.toFixed(3)} step={0.05} onChange={(v) => setLayout({ arcRadius: Math.max(0.01, v) })} />
                                    <NumberInput label="Angle" value={L.arcAngle} step={5} onChange={(v) => setLayout({ arcAngle: v })} />
                                </>
                            )}
                        </PanelSection>
                    );
                })()}
                </>
            ) : (!selectedSurface ? (
                <div className="p-4 text-center text-fg-3 text-xs italic mt-10">
                    Select a surface or fixture to edit properties
                </div>
            ) : null)}

            {/* Output config now lives in the Preferences modal */}
        </div>
    );
}