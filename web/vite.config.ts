/// <reference types="node" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // VITE_API_TARGET (shell env or .env*) overrides where /api and /files are proxied in dev/preview.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const backend = process.env.VITE_API_TARGET || env.VITE_API_TARGET || 'http://localhost:8787';
  const proxy = {
    '/api': { target: backend, changeOrigin: false },
    '/files': { target: backend, changeOrigin: false },
  };
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, proxy },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
  };
});
