// HOW A CALIBRATION WIZARD IS LAID OUT — two arrangements of the same three parts (suite plan Phase 3,
// step 5; the approved design's S2/S3).
//
// Every wizard is a COLUMN (header, step bar, the step's controls) beside a VIEW (the live camera, or
// for Manual the projector raster). Two arrangements:
//   workbench  the combined app's Calibration viewport: column and view side by side, the 3D venue in
//              the split view's other pane — unchanged.
//   inspector  ArtLux Calibrator: the venue IS the workspace. The column fills the step inspector on the
//              right, the 3D takes the centre, and the view floats over it as a picture-in-picture the
//              operator can move, resize, or enlarge — "second views float" (design principle 4).
// The wizards themselves do not know which: they render <WizardRoot>/<WizardColumn>/<WizardView> and
// the mode comes from context. The PiP is portalled to <body> and mounted there from the start — a
// node created in its place, not one moved out of the tree, so nothing it draws is ever reparented.

import React, { createContext, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';

export type WizardMode = 'workbench' | 'inspector';
export const WizardModeContext = createContext<WizardMode>('workbench');
export const useWizardMode = (): WizardMode => useContext(WizardModeContext);

export const WizardRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const mode = useWizardMode();
  return <div className={`w-full h-full flex bg-surface-0 min-h-0 ${mode === 'inspector' ? 'flex-col' : ''}`}>{children}</div>;
};

export const WizardColumn: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const mode = useWizardMode();
  return (
    <div className={mode === 'inspector'
      ? 'w-full flex-1 flex flex-col bg-surface-1 min-h-0'
      : 'w-[340px] shrink-0 flex flex-col bg-surface-1 border-r border-line-1 min-h-0'}>
      {children}
    </div>
  );
};

/**
 * The wizard's big view. `relative` is load-bearing in both modes: CameraViewport's root is
 * `absolute inset-0`, so it needs a positioned box of real size to fill.
 */
export const WizardView: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const mode = useWizardMode();
  const [big, setBig] = useState(false);
  if (mode !== 'inspector') return <div className="relative flex-1 min-w-0 min-h-0 bg-black">{children}</div>;
  // Anchored to the 3D area's bottom-RIGHT, clear of the step inspector (its 360 px column) and of the
  // rig column on the left, which it would otherwise cover; enlarged it takes most of the centre.
  const box = big
    ? 'left-[360px] right-[376px] top-[96px] bottom-[40px]'
    : 'right-[376px] bottom-[40px] w-[440px] h-[276px]';
  return createPortal(
    <div className={`fixed ${box} z-calib-camera rounded-lg overflow-hidden border border-line-2 bg-surface-0 shadow-e3 flex flex-col`}
      role="region" aria-label={title}>
      <div className="h-7 px-2 flex items-center justify-between border-b border-line-1 bg-surface-1 shrink-0">
        <span className="text-micro font-semibold uppercase tracking-wider text-fg-1 truncate">{title}</span>
        <button type="button" onClick={() => setBig((b) => !b)} aria-label={big ? 'Shrink the view' : 'Enlarge the view'}
          title={big ? 'Shrink back to a corner' : 'Enlarge over the venue'} className="p-1 rounded-sm text-fg-2">
          {big ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
      </div>
      <div className="relative flex-1 min-h-0 bg-black">{children}</div>
    </div>,
    document.body,
  );
};
