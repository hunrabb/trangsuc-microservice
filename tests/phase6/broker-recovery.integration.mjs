// Run offline once with the acceptance broker stopped, then recover after restarting it.
// Preserves its order/outbox and private token for investigation. No Docker control here.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { requireAcknowledgement, databaseUrl, gatewayUrl, FIXTURE } from './test-environment.mjs';
requireAcknowledgement();
const req = createRequire(new URL('../../apps/sales/package.json', import.meta.url));
const { PrismaPg } = req('@prisma/adapter-pg');
const { PrismaClient } = req('./dist/generated/prisma/client.js');
const sales = new PrismaClient({
  adapter: new PrismaPg(
    { connectionString: databaseUrl(process.env.PHASE6_TEST_SALES_URL, 'sales'), max: 1 },
    { schema: 'sales' },
  ),
});
const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
const file = process.env.PHASE6_TEST_RECOVERY_FILE;
assert.ok(file?.startsWith('/tmp/jewelry-phase6.'));
try {
  if (process.env.PHASE6_TEST_RECOVERY_MODE === 'offline') {
    const health = await fetch('http://127.0.0.1:3093/health/ready');
    assert.equal(health.status, 503);
    const token = randomBytes(32).toString('hex'),
      key = randomUUID();
    const res = await fetch(base + '/api/shop/orders', {
      method: 'POST',
      headers: {
        Authorization: `Checkout ${token}`,
        'Idempotency-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ variantId: FIXTURE.variant, quantity: 1 }],
        recipientName: 'PH6 broker offline',
        recipientPhone: '0901234567',
        shippingAddress: 'PH6 isolated test address',
      }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(res.status, 202);
    const order = await res.json();
    writeFileSync(file, JSON.stringify({ token, key, orderId: order.id }), {
      flag: 'wx',
      mode: 0o600,
    });
    assert.equal(
      (await sales.onlineOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      'PENDING',
    );
    const events = await sales.outboxEvent.findMany({
      where: { aggregateId: order.id, eventType: 'order.created' },
    });
    assert.equal(events.length, 1);
    assert.notEqual(events[0].status, 'PUBLISHED');
    console.log(
      JSON.stringify({
        result: 'PASS',
        stage: 'offline durable order/outbox',
        orderId: order.id,
        outboxStatus: events[0].status,
      }),
    );
  } else if (process.env.PHASE6_TEST_RECOVERY_MODE === 'recover') {
    const { orderId } = JSON.parse(readFileSync(file, 'utf8'));
    let order;
    const end = Date.now() + 90000;
    do {
      order = await sales.onlineOrder.findUniqueOrThrow({ where: { id: orderId } });
      if (order.status !== 'PENDING') break;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < end);
    assert.equal(order.status, 'CANCELLED');
    assert.equal(await sales.onlinePayment.count({ where: { orderId } }), 0);
    const events = await sales.outboxEvent.findMany({
      where: { aggregateId: orderId, eventType: 'order.created' },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'PUBLISHED');
    console.log(
      JSON.stringify({
        result: 'PASS',
        stage: 'broker restart and outbox recovery; item remains held by paid order',
        orderId,
      }),
    );
  } else throw new Error('Choose offline or recover');
} finally {
  await sales.$disconnect();
}
