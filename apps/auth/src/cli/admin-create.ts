import { parseArgs } from 'node:util';
import { postgresUrlField } from '@jewelry/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { type CreateAdminDb, CreateAdminError, createAdmin } from '../admin/create-admin';
import { DB_SCHEMA } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

// Tạo ADMIN đầu tiên. Mật khẩu chỉ nhận từ ADMIN_PASSWORD hoặc stdin, không bao giờ qua tham số dòng lệnh
// vì tham số lộ trong lịch sử shell và danh sách tiến trình. Xem README.

async function readPassword(): Promise<string> {
  if (process.env.ADMIN_PASSWORD) {
    return process.env.ADMIN_PASSWORD;
  }
  if (process.stdin.isTTY) {
    throw new CreateAdminError('Thiếu mật khẩu: đặt ADMIN_PASSWORD hoặc truyền qua stdin');
  }
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
  }
  return input.replace(/\r?\n$/, '');
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Trong container không có file .env: biến lấy từ môi trường.
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: { email: { type: 'string' }, 'full-name': { type: 'string' } },
  });
  if (!values.email || !values['full-name']) {
    throw new CreateAdminError('Cần --email <email> --full-name <họ tên>');
  }
  loadEnvFile();
  const password = await readPassword();
  const connectionString = postgresUrlField(DB_SCHEMA).parse(process.env.DATABASE_URL);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema: DB_SCHEMA }),
  });
  try {
    const id = await createAdmin(prisma as unknown as CreateAdminDb, {
      email: values.email,
      fullName: values['full-name'],
      password,
    });
    console.log(`Đã tạo ADMIN ${values.email.trim().toLowerCase()} (${id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`LỖI: ${message}`);
  process.exitCode = 1;
});
