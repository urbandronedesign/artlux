import React from 'react';

// LEDs are self-lit (MeshBasicMaterial); these base lights make the grid/floor and the
// venue model readable. `env` raises the ambient fill for a brighter, evenly-lit look
// (a cheap stand-in for an HDR environment, with no network/asset dependency).
export const Lighting: React.FC<{ env?: boolean }> = ({ env }) => (
  <>
    <ambientLight intensity={env ? 0.8 : 0.35} />
    <hemisphereLight intensity={env ? 0.7 : 0.3} groundColor="#101010" />
  </>
);
