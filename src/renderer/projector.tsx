import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { ProjectorApp } from './projector/ProjectorApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalNet } from './services/faultReporter';
import { installLogTap } from './services/log';

// Dedicated projector-output window entry. One per Surface routed to a physical display:
// renders the surface's content independently at native resolution and corner-pin warps it
// onto a black background. Bridged to the main window over a MessagePort (see main/projector.ts).
// No StrictMode (single rAF + WebGL context).
//
// This window has its own root, so it does NOT unmount when the main window's tree dies — and it
// used to be the only path to a genuinely black projector: a throwing projector-panel plugin took
// ProjectorApp down and the <canvas> with it. The boundary fixes that; `silent` because a DOM
// recovery card over a projection surface is worse than black, and the report still reaches main
// (audited as an 'aux' fault, so it never relaunches the show — that decision belongs to the main
// window's own detectors, and two windows racing to relaunch is a bug).
installGlobalNet('projector');

// Adopt this window's existing console narration into the machine log (services/log.ts).
installLogTap();

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <ErrorBoundary scope="projector-root" faultWindow="projector" silent>
      <ProjectorApp />
    </ErrorBoundary>,
  );
}
