import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { HeadlessRunner } from './HeadlessRunner';

// Minimal headless entry: mounts only the Stage compute + output loop (no UI/3D/
// monitor). Driven by a project file passed via ?project= on the URL. No
// StrictMode — the rAF loop + dmxSignal subscription must mount exactly once.
const params = new URLSearchParams(window.location.search);
const projectPath = params.get('project');

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<HeadlessRunner projectPath={projectPath} />);
}
