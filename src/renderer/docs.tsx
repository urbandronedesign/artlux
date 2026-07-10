import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { DocsBrowser } from './components/DocsBrowser';

// Detached Docs & Tutorials window entry. Reuses DocsBrowser in 'window' mode (fills the window, no
// dock chrome). "Open example" is forwarded to the main editor window (main/docsWindow.ts) so the
// project loads there — read the tutorial here, follow along in the app on another screen. Reads an
// optional ?id= to open straight to a page. No StrictMode (keep the single markdown mount simple).
const initialId = new URLSearchParams(location.search).get('id') || undefined;
const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <DocsBrowser
      mode="window"
      initialId={initialId}
      onClose={() => window.artlux.windowCommand('close')}
      onOpenExample={(p) => window.artlux.docsOpenExample(p)}
    />,
  );
}
