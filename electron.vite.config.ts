import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          headless: resolve(__dirname, 'src/renderer/headless.html'),
          projector: resolve(__dirname, 'src/renderer/projector.html'),
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer') },
    },
    server: { port: 3000 },
  },
});
