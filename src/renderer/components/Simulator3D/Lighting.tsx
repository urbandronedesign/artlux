import React from 'react';

// LEDs are self-lit (MeshBasicMaterial); these base lights make the grid/floor and the
// venue model readable. `env` raises the ambient fill for a brighter, evenly-lit look
// (a cheap stand-in for an HDR environment, with no network/asset dependency).
// `dim` = the Rendered display mode (RenderedMode.tsx): the fixtures light the room there, so the fill
// drops to a trace — enough to read the shapes of a dark venue, not enough to wash out a pool of light.
export const Lighting: React.FC<{ env?: boolean; dim?: boolean }> = ({ env, dim }) => (
  <>
    <ambientLight intensity={dim ? 0.04 : env ? 0.8 : 0.35} />
    <hemisphereLight intensity={dim ? 0.06 : env ? 0.7 : 0.3} groundColor="#101010" />
  </>
);
