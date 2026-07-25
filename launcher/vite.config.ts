import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite serves the launcher's web UI; Tauri wraps it. Port fixed at 5173 because
// src-tauri/tauri.conf.json's devUrl names it literally — a "port already in use, using 5174"
// fallback would leave the Tauri window pointed at nothing, so fail instead of drifting.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
});
