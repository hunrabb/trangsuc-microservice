import { defineConfig } from 'prisma/config';

// Prisma 7 không tự đọc .env. Máy dev đọc apps/auth/.env; trong Docker không có
// file này (đã loại bởi .dockerignore) nên biến lấy thẳng từ môi trường container.
try {
  process.loadEnvFile('.env');
} catch {
  // không có file .env — dùng biến môi trường sẵn có
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` không cần DB nên để chuỗi rỗng khi chưa có biến (build Docker).
    // Lệnh migrate được bảo vệ ở nơi gọi (xem *-migrate trong docker-compose.yml).
    url: process.env.DATABASE_URL ?? '',
    // Chỉ `prisma migrate dev` dùng. `migrate deploy` không cần, nên biến này là tuỳ chọn.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
