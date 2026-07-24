import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

// `ANALYZE=1 pnpm --filter client build` emits dist/stats.html — a treemap of
// what's in the bundle. Off by default so ordinary builds stay clean.
export default defineConfig(() => {
  const analyze = process.env.ANALYZE === '1';

  return {
    plugins: [
      cloudflare({ configPath: './wrangler.jsonc' }),
      react(),
      analyze &&
        visualizer({
          filename: 'dist/stats.html',
          gzipSize: true,
          brotliSize: true,
          open: false,
        }),
    ],
    build: {
      // A single runtime owns dist; remove artifacts from older builds so
      // deployment and marker scans inspect only the current candidate.
      emptyOutDir: true,
      // The whole bundle is ~280 KB today (react-dom is two-thirds of it). The
      // default 500 KB limit sits above the entire app, so nothing ever warns.
      chunkSizeWarningLimit: 300,
    },
  };
});
