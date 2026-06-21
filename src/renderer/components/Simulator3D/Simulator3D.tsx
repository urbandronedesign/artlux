import React, { useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { Move3d, Rotate3d } from 'lucide-react';
import { Fixture, Vec3, Euler3 } from '../../types';
import { InstancedLeds } from './InstancedLeds';
import { FixtureGizmo } from './FixtureGizmo';
import { GroundGrid } from './GroundGrid';
import { Lighting } from './Lighting';

interface Props {
  fixtures: Fixture[];
  selectedFixtureId: string | null;
  onSelectFixture: (id: string) => void;
  onCommitFixture3D: (id: string, updates: { position3D: Vec3; rotation3D: Euler3 }) => void;
  onRecordHistory: () => void;
}

const Simulator3D: React.FC<Props> = ({
  fixtures, selectedFixtureId, onSelectFixture, onCommitFixture3D, onRecordHistory,
}) => {
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const selected = fixtures.find(f => f.id === selectedFixtureId) || null;

  return (
    <div className="relative w-full h-full bg-surface-0">
      <div className="absolute top-2 left-2 z-10 flex gap-1">
        <button
          onClick={() => setMode('translate')}
          className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${mode === 'translate' ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
          title="Move (W)"
        >
          <Move3d size={14} />
        </button>
        <button
          onClick={() => setMode('rotate')}
          className={`p-1.5 rounded-[var(--r-sm)] border transition-colors ${mode === 'rotate' ? 'bg-accent/15 border-accent text-accent' : 'bg-surface-2/80 backdrop-blur-sm border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1'}`}
          title="Rotate (E)"
        >
          <Rotate3d size={14} />
        </button>
      </div>

      <Canvas
        camera={{ position: [0, 1.2, 3], fov: 50 }}
        onPointerMissed={() => onSelectFixture('')}
      >
        <color attach="background" args={['#0a0a0a']} />
        <Lighting />
        <GroundGrid />
        <InstancedLeds fixtures={fixtures} onSelectFixture={onSelectFixture} />
        <FixtureGizmo
          fixture={selected}
          mode={mode}
          onRecordHistory={onRecordHistory}
          onCommit={onCommitFixture3D}
        />
        <OrbitControls makeDefault />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport labelColor="white" axisHeadScale={1} />
        </GizmoHelper>
        <EffectComposer>
          <Bloom luminanceThreshold={0.1} intensity={0.6} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </div>
  );
};

export default Simulator3D;
