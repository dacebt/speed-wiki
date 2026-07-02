import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests target the pure event-sourced core in server/src/game. No jsdom, no
// setup files — the core is plain functions over plain data. The alias resolves
// the workspace's shared catalog to its source, since the repo root (where
// vitest runs) does not itself depend on the package.
export default defineConfig({
  resolve: {
    alias: {
      '@wikispeedrun/shared': fileURLToPath(new URL('./shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['server/src/**/*.test.ts'],
  },
});
