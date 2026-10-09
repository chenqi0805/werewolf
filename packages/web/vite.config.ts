import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies the Socket.IO transport to the room server so the
// client can speak same-origin (`io()` with no URL) in every environment.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
});
