import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { SplashScreen } from './components/splash/SplashScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalNet } from './services/faultReporter';

// Startup-splash window entry (opened by main/splashWindow.ts before the editor window is visible).
// Deliberately thin: no StrictMode (a double-mounted effect would send SPLASH_READY twice and subscribe
// the report feed twice), no providers, no store — this window owns no app state and reads only the boot
// report over IPC. It is closed by main, not by itself.
// A throw here would leave the splash on screen forever with no boot report — the operator's only
// symptom being "it never opened". Contained + reported like every other root; `silent` so a failed
// splash simply shows nothing while main closes it on its own schedule (main owns this window's
// lifetime, so there is nothing for a recovery card to offer). Reported as an 'aux' fault: it never
// relaunches a show.
installGlobalNet('splash');

const rootElement = document.getElementById('root');
if (rootElement) ReactDOM.createRoot(rootElement).render(
  <ErrorBoundary scope="splash-root" faultWindow="splash" silent>
    <SplashScreen />
  </ErrorBoundary>,
);
