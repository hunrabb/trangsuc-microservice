import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { databaseUrl, root } from './support.mjs';

const mode = process.argv[2];
if (!['backfill', 'snapshot', 'recovery'].includes(mode))
  throw new Error('Chọn backfill | snapshot | recovery');
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} thất bại (${code})`)),
    );
  });
}
await run('docker', [
  'compose',
  '-f',
  'tests/reporting/compose.yml',
  'up',
  '-d',
  '--wait',
  '--wait-timeout',
  '60',
]);
for (const service of mode === 'snapshot' ? ['inventory', 'report'] : ['sales', 'report']) {
  await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: resolve(root, `apps/${service}`),
    env: { ...process.env, DATABASE_URL: databaseUrl(service) },
  });
}
// Bài recovery chờ thực >=600s chỉ chạy khi gọi trực tiếp mode này.
await run(process.execPath, [`tests/reporting/${mode}.test.mjs`]);
