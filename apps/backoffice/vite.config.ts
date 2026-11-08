import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// Dev: gọi /api/* trên cùng origin rồi chuyển về gateway chạy trên máy (apps/gateway, cổng 3000).
// Docker: nginx trong container làm đúng việc này (xem nginx.conf).
export default defineConfig(({ mode }) => {
  // Client ID của Google: `pnpm dev` đọc GOOGLE_CLIENT_ID từ .env ở gốc repo; build Docker truyền
  // VITE_GOOGLE_CLIENT_ID qua build arg (biến môi trường). Giá trị này công khai nhưng không in ra log.
  const rootEnv = loadEnv(mode, repoRoot, '');
  const googleClientId = rootEnv.VITE_GOOGLE_CLIENT_ID || rootEnv.GOOGLE_CLIENT_ID || '';
  const bankBin = rootEnv.VITE_POS_BANK_BIN || rootEnv.POS_BANK_BIN || '';
  const bankAccount = rootEnv.VITE_POS_BANK_ACCOUNT || rootEnv.POS_BANK_ACCOUNT || '';
  const bankName = rootEnv.VITE_POS_BANK_NAME || rootEnv.POS_BANK_NAME || '';

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(googleClientId),
      'import.meta.env.VITE_POS_BANK_BIN': JSON.stringify(bankBin),
      'import.meta.env.VITE_POS_BANK_ACCOUNT': JSON.stringify(bankAccount),
      'import.meta.env.VITE_POS_BANK_NAME': JSON.stringify(bankName),
    },
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': 'http://localhost:3000',
      },
    },
  };
});
