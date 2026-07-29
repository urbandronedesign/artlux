import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { DocsBrowser } from './components/DocsBrowser';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalNet } from './services/faultReporter';

// Detached Docs & Tutorials window entry. Reuses DocsBrowser in 'window' mode (fills the window, no
// dock chrome). "Open example" is forwarded to the main editor window (main/docsWindow.ts) so the
// project loads there — read the tutorial here, follow along in the app on another screen. Reads an
// optional ?id= to open straight to a page. No StrictMode (keep the single markdown mount simple).
installGlobalNet('docs');

const initialId = new URLSearchParams(location.search).get('id') || undefined;
const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    // Contained + reported like every other root. A docs fault is audited as 'aux' and never
    // relaunches a show — reading the manual must not be able to restart the venue.
    <ErrorBoundary scope="docs-root" faultWindow="docs" label="Documentation">
      <DocsBrowser
        mode="window"
        initialId={initialId}
        onClose={() => window.artlux.windowCommand('close')}
        onOpenExample={(p) => window.artlux.docsOpenExample(p)}
      />
    </ErrorBoundary>,
  );
}
