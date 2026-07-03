import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

// `ANALYZE=1 pnpm --filter client build` emits dist/stats.html — a treemap of
// what's in the bundle. Off by default so ordinary builds stay clean.
const analyze = process.env.ANALYZE === '1';

export default defineConfig({
  plugins: [
    react(),
    analyze &&
      visualizer({
        filename: 'dist/stats.html',
        gzipSize: true,
        brotliSize: true,
        open: false,
      }),
  ],
  server: {
    proxy: {
      // Same-origin socket in dev; in prod the server serves the built client.
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: {
    // The whole bundle is ~280 KB today (react-dom is two-thirds of it). The
    // default 500 KB limit sits above the entire app, so nothing ever warns.
    // Tightened to just above today's size: a dependency that adds real weight
    // trips a build-time warning instead of shipping silently. Raise this
    // deliberately when a chunk legitimately grows — never to silence it.
    chunkSizeWarningLimit: 300,
  },
});
