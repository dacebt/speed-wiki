import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin socket in dev; in prod the server serves the built client.
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
