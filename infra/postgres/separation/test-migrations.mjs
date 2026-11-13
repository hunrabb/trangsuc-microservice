// Chạy Prisma migrations từ code hiện tại CHỈ trên DB test có cổng loopback 15433–15436.
// Trước khi chạy: test-restore.sh PASS, compose.test.yml đã up --wait.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { assertTestTarget } from './assert-test-target.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));
const services = [
  ['auth', 15433],
  ['inventory', 15434],
  ['sales', 15435],
  ['report', 15436],
];

for (const [service, port] of services) {
  assertTestTarget(service, port);
  const password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
  if (!password) throw new Error(`Thiếu ${service.toUpperCase()}_DB_PASSWORD`);
  const url = new URL(`postgresql://${service}_user@127.0.0.1:${port}/${service}_db`);
  url.password = password;
  url.searchParams.set('schema', service);
  console.log(`Migration ${service} → DB test localhost:${port}/${service}_db`);
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(root, 'apps', service),
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      DATABASE_URL: url.href,
      SHADOW_DATABASE_URL: '',
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Migration ${service} thất bại (${result.status})`);
}
