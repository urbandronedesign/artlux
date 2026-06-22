import React from 'react';
import { Grid } from '@react-three/drei';

export const GroundGrid: React.FC = () => (
  <Grid
    position={[0, 0, 0]}
    args={[30, 30]}
    cellSize={0.25}
    cellThickness={0.6}
    cellColor="#b0b0b0"
    sectionSize={1}
    sectionThickness={1}
    sectionColor="#d8d8d8"
    fadeDistance={22}
    fadeStrength={1}
    infiniteGrid
  />
);
