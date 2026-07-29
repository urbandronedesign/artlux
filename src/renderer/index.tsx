import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FeedbackProvider } from './components/ui';
import { installGlobalNet } from './services/faultReporter';

// Before createRoot: catches what a React boundary structurally cannot — throws in effects' async
// callbacks, in rAF/timeout ticks, and rejected promises. (Not a module-scope throw during import:
// ESM evaluates every import before any body statement, so nothing in this bundle can install a
// listener ahead of that. THAT case is covered from the other side — main's watchdog starts its
// first-heartbeat clock at 'did-finish-load' and relaunches a renderer that never paints.)
installGlobalNet('main');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <ErrorBoundary variant="fatal" scope="root">
      <FeedbackProvider>
        <App />
      </FeedbackProvider>
    </ErrorBoundary>
  </React.StrictMode>
);