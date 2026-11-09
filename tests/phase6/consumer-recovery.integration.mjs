// Prepare only after stopping the recorded Sales acceptance PID. Recover after restart.
// Scoped projection-loss injection; preserves source Inventory and all order/payment data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { requireAcknowledgement, databaseUrl, gatewayUrl, FIXTURE } from './test-environment.mjs';
requireAcknowledgement();
function db(service) {
  const req = createRequire(new URL(`../../apps/${service}/package.json`, import.meta.url));
  const { PrismaPg } = req('@prisma/adapter-pg');
  const { PrismaClient } = req('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg(
      {
        connectionString: databaseUrl(
          process.env[`PHASE6_TEST_${service.toUpperCase()}_URL`],
          service,
        ),
        max: 2,
      },
      { schema: service },
    ),
  });
}
const inventory = db('inventory'),
  sales = db('sales');
const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
const file = process.env.PHASE6_TEST_RECOVERY_FILE;
assert.ok(file?.startsWith('/tmp/jewelry-phase6.'));
async function poll(work, done) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const v = await work();
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Consumer recovery timeout');
}
try {
  if (process.env.PHASE6_TEST_RECOVERY_MODE === 'prepare') {
    await assert.rejects(
      fetch('http://127.0.0.1:3093/health/live', { signal: AbortSignal.timeout(2000) }),
    );
    assert.equal(await sales.catalogProduct.count({ where: { id: FIXTURE.product } }), 1);
    await sales.catalogProduct.delete({ where: { id: FIXTURE.product } });
    assert.equal(await sales.catalogProduct.count({ where: { id: FIXTURE.product } }), 0);
    const req = createRequire(new URL('../../apps/inventory/package.json', import.meta.url));
    await new (req('./dist/catalog/catalog-publisher.js').CatalogPublisher)(inventory).publish(
      FIXTURE.product,
    );
    const row = await inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: FIXTURE.product, eventType: 'product.snapshot' },
      orderBy: { createdAt: 'desc' },
    });
    await poll(
      () => inventory.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }),
      (r) => r.status === 'PUBLISHED',
    );
    assert.equal(
      await sales.processedEvent.count({ where: { eventId: row.id, consumer: 'sales' } }),
      0,
    );
    writeFileSync(file, JSON.stringify({ eventId: row.id, version: row.payload.version }), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        result: 'PASS',
        stage: 'consumer offline, projection absent, confirmed event retained',
        eventId: row.id,
      }),
    );
  } else if (process.env.PHASE6_TEST_RECOVERY_MODE === 'recover') {
    const { eventId, version } = JSON.parse(readFileSync(file, 'utf8'));
    await poll(
      () => sales.processedEvent.count({ where: { eventId, consumer: 'sales' } }),
      (n) => n === 1,
    );
    const row = await sales.catalogProduct.findUniqueOrThrow({ where: { id: FIXTURE.product } });
    assert.ok(row.version >= version);
    assert.equal(await sales.catalogVariant.count({ where: { productId: FIXTURE.product } }), 1);
    const res = await fetch(`${base}/api/shop/products/${FIXTURE.product}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, 'PH6ACCEPT Ring');
    console.log(
      JSON.stringify({
        result: 'PASS',
        stage: 'consumer restart drains backlog and rebuilds missing catalog projection',
        eventId,
        version: row.version,
      }),
    );
  } else throw new Error('Choose prepare or recover');
} finally {
  await inventory.$disconnect();
  await sales.$disconnect();
}
