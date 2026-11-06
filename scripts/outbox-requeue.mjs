#!/usr/bin/env node
// Gửi lại dòng outbox FAILED ở máy dev:
//   pnpm outbox:requeue -- --service report [--event-type x] [--id <uuid>] [--dry-run]
// Chỉ chuyển tiếp vào lệnh trong dist của service, để luôn dùng đúng user DB của service đó.
// Trên server: docker compose exec report node dist/cli/outbox-requeue.js --service report ...
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVICES = ['auth', 'inventory', 'sales', 'report'];
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const service = args[args.indexOf('--service') + 1];

if (!args.includes('--service') || !SERVICES.includes(service)) {
  console.error(`LỖI: phải có --service <${SERVICES.join('|')}>`);
  process.exit(1);
}

const cwd = resolve(import.meta.dirname, '../apps', service);
const entry = resolve(cwd, 'dist/cli/outbox-requeue.js');
if (!existsSync(entry)) {
  console.error(`LỖI: chưa có ${entry}, chạy pnpm build trước`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [entry, ...args], { cwd, stdio: 'inherit' });
process.exit(result.status ?? 1);
