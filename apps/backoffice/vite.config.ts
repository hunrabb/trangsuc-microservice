import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: gọi /api/* trên cùng origin rồi chuyển về gateway chạy trên máy (apps/gateway, cổng 3000).
// Docker: nginx trong container làm đúng việc này (xem nginx.conf).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
