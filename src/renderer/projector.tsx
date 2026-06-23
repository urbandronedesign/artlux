import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { ProjectorApp } from './projector/ProjectorApp';

// Dedicated projector-output window entry. One per Surface routed to a physical display:
// renders the surface's content independently at native resolution and corner-pin warps it
// onto a black background. Bridged to the main window over a MessagePort (see main/projector.ts).
// No StrictMode (single rAF + WebGL context).
const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<ProjectorApp />);
}
