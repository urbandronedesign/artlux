import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { SplashScreen } from './components/splash/SplashScreen';

// Startup-splash window entry (opened by main/splashWindow.ts before the editor window is visible).
// Deliberately thin: no StrictMode (a double-mounted effect would send SPLASH_READY twice and subscribe
// the report feed twice), no providers, no store — this window owns no app state and reads only the boot
// report over IPC. It is closed by main, not by itself.
const rootElement = document.getElementById('root');
if (rootElement) ReactDOM.createRoot(rootElement).render(<SplashScreen />);
