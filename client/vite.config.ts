import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';

// `ANALYZE=1 pnpm --filter client build` emits dist/stats.html — a treemap of
// what's in the bundle. Off by default so ordinary builds stay clean.
export default defineConfig(({ mode }) => {
  const analyze = process.env.ANALYZE === '1';
  const workerRuntime = mode !== 'legacy';

  return {
    plugins: [
      ...(workerRuntime ? cloudflare({ configPath: './wrangler.jsonc' }) : []),
      react(),
      analyze &&
        visualizer({
          filename: 'dist/stats.html',
          gzipSize: true,
          brotliSize: true,
          open: false,
        }),
    ],
    resolve: {
      alias: {
        '@runtime-transport': fileURLToPath(
          new URL(
            workerRuntime ? './src/lib/transport.worker.ts' : './src/lib/transport.legacy.ts',
            import.meta.url,
          ),
        ),
      },
    },
    server: workerRuntime
      ? {}
      : {
          proxy: {
            // The complete Node product remains an isolated migration path.
            '/socket.io': { target: 'http://localhost:3001', ws: true },
          },
        },
    build: {
      // The whole bundle is ~280 KB today (react-dom is two-thirds of it). The
      // default 500 KB limit sits above the entire app, so nothing ever warns.
      chunkSizeWarningLimit: 300,
    },
  };
});
