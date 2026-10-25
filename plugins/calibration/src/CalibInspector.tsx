// The calibration wizard as ArtLux Calibrator's STEP INSPECTOR (suite plan Phase 3, step 5; design
// S2/S3): the same workbench component, rendered in its inspector arrangement — the wizard's column fills
// this panel and its camera / raster view floats over the 3D venue (wizardLayout.tsx).

import React from 'react';
import { CalibViewport } from './CalibViewport';
import { WizardModeContext } from './wizardLayout';

export const CalibInspector: React.FC = () => (
  <WizardModeContext.Provider value="inspector">
    <div className="h-full min-h-[480px] flex flex-col"><CalibViewport /></div>
  </WizardModeContext.Provider>
);
