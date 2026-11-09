import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Dev: gọi /api/* trên cùng origin rồi chuyển về gateway chạy trên máy (apps/gateway, cổng 3000).
// Docker: nginx trong container làm đúng việc này (xem nginx.conf).
export default defineConfig({
  plugins: [react()],
  // Public workspace entry as ESM lets Vite remove unused backoffice/report contracts.
  // Imports stay at the package boundary; Node services continue using built CommonJS.
  resolve: {
    alias: {
      '@jewelry/contracts': fileURLToPath(
        new URL('../../libs/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
