import React from 'react';
import { Grid } from '@react-three/drei';

export const GroundGrid: React.FC = () => (
  <Grid
    position={[0, -1.2, 0]}
    args={[30, 30]}
    cellSize={0.25}
    cellThickness={0.6}
    cellColor="#1f1f1f"
    sectionSize={1}
    sectionThickness={1}
    sectionColor="#06b6d4"
    fadeDistance={22}
    fadeStrength={1}
    infiniteGrid
  />
);
