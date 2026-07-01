import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// In-tree workspace packages are statically imported by the host and BUNDLED into each target
// (no externalizeDepsPlugin in this config — see src/main/transport/oscManager.ts). The `@artlux/sdk`
// subpaths are aliased to source so there is no separate build step. Order matters: the more
// specific subpath aliases must precede the bare one.
const sdkAliases = [
  { find: '@artlux/sdk/main', replacement: resolve(__dirname, 'packages/sdk/src/main.ts') },
  { find: '@artlux/sdk/renderer', replacement: resolve(__dirname, 'packages/sdk/src/renderer.ts') },
  { find: '@artlux/sdk', replacement: resolve(__dirname, 'packages/sdk/src/index.ts') },
  // First-party plugins are bundled in-process. Deep subpath imports (…/trackingStore) resolve under
  // the package's src/ so each window only bundles the modules it uses.
  { find: '@artlux/plugin-lidar-tracking', replacement: resolve(__dirname, 'plugins/lidar-tracking/src') },
  // NDI spans both processes → explicit main/renderer subpath entries (like @artlux/sdk).
  { find: '@artlux/plugin-ndi/main', replacement: resolve(__dirname, 'plugins/ndi/src/main.ts') },
  { find: '@artlux/plugin-ndi/renderer', replacement: resolve(__dirname, 'plugins/ndi/src/renderer.ts') },
];

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
    resolve: {
      alias: [...sdkAliases],
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
      alias: [
        { find: '@', replacement: resolve(__dirname, 'src/renderer') },
        ...sdkAliases,
      ],
    },
    server: { port: 3000 },
  },
});
