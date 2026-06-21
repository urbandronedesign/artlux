import React from 'react';

// LEDs are self-lit (MeshBasicMaterial); this just makes the grid/floor readable.
export const Lighting: React.FC = () => (
  <>
    <ambientLight intensity={0.4} />
    <hemisphereLight intensity={0.3} />
  </>
);
