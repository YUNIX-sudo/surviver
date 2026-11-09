import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop';
  return {
    // desktop (Electron, file://) needs relative asset URLs
    base: desktop ? './' : '/',
    build: {
      outDir: desktop ? resolve(__dirname, '../desktop/app') : 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html'),
          play: resolve(__dirname, 'play.html'),
          admin: resolve(__dirname, 'admin.html'),
        },
      },
    },
    server: {
      port: 5173,
      host: true,
      proxy: {
        '/ws': { target: 'ws://localhost:8080', ws: true },
        '/api': { target: 'http://localhost:8080' },
      },
    },
  };
});
