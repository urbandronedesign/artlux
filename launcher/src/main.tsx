import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// No StrictMode: its double-invoked effects would fire the install scan and the progress listener
// twice, and the launcher's effects talk to the OS. The app's own splash entry omits it for the same
// reason (src/renderer/splash.tsx).
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
void React;
