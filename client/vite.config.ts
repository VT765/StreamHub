import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Everything goes through the Vite origin so cookies, media byte-ranges and canvas frame capture are same-origin.
// API_URL lets a second dev stack point at another API port (default: the usual :4000).
const api = process.env.API_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true, xfwd: true },
      '/socket.io': { target: api, ws: true, changeOrigin: true },
    },
  },
});
