import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { SceneApp } from './scene/SceneApp';

// Dedicated 3D Scene window entry. Receives live fixtures/surfaces + the per-LED pixel
// stream from the main window over a MessagePort (set up in main), renders the venue +
// fixtures in real-world meters, and sends edits back. No StrictMode (single rAF loop).
const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<SceneApp />);
}
