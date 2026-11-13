// Read-only smoke của Prisma Client hiện tại trên bốn DB test đã restore + migrate.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertTestTarget } from './assert-test-target.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.loadEnvFile(resolve(root, '.env'));

for (const [service, port, model, migrationCount] of [
  ['auth', 15433, 'user', 3],
  ['inventory', 15434, 'jewelryItem', 13],
  ['sales', 15435, 'order', 14],
  ['report', 15436, 'orderRevenue', 7],
]) {
  assertTestTarget(service, port);
  const password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
  assert.ok(password, `Thiếu password của ${service}`);
  const url = new URL(`postgresql://${service}_user@127.0.0.1:${port}/${service}_db`);
  url.password = password;
  url.searchParams.set('schema', service);
  const require = createRequire(resolve(root, `apps/${service}/package.json`));
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require(`./dist/generated/prisma/client.js`);
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.href, max: 2 }, { schema: service }),
  });
  try {
    const [{ db, app_user: appUser }] = await client.$queryRawUnsafe(
      'SELECT current_database() AS db, current_user AS app_user',
    );
    assert.equal(db, `${service}_db`);
    assert.equal(appUser, `${service}_user`);
    const migrations = await client.$queryRawUnsafe(
      `SELECT count(*)::integer AS n FROM "${service}"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    assert.equal(migrations[0].n, migrationCount);
    const count = await client[model].count();
    assert.ok(Number.isInteger(count));
    const otherSchema = service === 'auth' ? 'sales' : 'auth';
    await assert.rejects(
      client.$queryRawUnsafe(`SELECT 1 FROM "${otherSchema}"."OutboxEvent" LIMIT 1`),
    );
    console.log(
      `${service}: PASS Prisma Client, ${migrationCount} migrations, DB/role đúng, không đọc schema service khác`,
    );
  } finally {
    await client.$disconnect();
  }
}
