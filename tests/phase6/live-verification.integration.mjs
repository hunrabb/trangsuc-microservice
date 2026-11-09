// Live acceptance only: requires the successful http-flow fixture. No boot/migration/cleanup.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  requireAcknowledgement,
  databaseUrl,
  gatewayUrl,
  rabbitUrl,
  FIXTURE,
} from './test-environment.mjs';
requireAcknowledgement();
const common = createRequire(new URL('../../libs/common/package.json', import.meta.url));
const contracts = common('@jewelry/contracts');
const db = (service) => {
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
};
const inventory = db('inventory'),
  sales = db('sales');
const base = gatewayUrl(process.env.PHASE6_TEST_GATEWAY_URL);
const connection = await common('amqplib').connect(rabbitUrl(process.env.PHASE6_TEST_RABBITMQ_URL));
const channel = await connection.createConfirmChannel();
let returned = false;
channel.on('return', () => {
  returned = true;
});
async function publish(envelope) {
  contracts.eventEnvelopeSchema.parse(envelope);
  contracts.EVENT_PAYLOAD_SCHEMAS[envelope.eventType].parse(envelope.payload);
  await new Promise((resolve, reject) =>
    channel.publish(
      'domain.events',
      envelope.eventType,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        mandatory: true,
        messageId: envelope.eventId,
        contentType: 'application/json',
      },
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  assert.equal(returned, false);
}
const envelope = (row) => ({
  eventId: row.id,
  eventType: row.eventType,
  occurredAt: row.createdAt.toISOString(),
  correlationId: row.correlationId,
  payload: row.payload,
});
async function poll(work, done, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await work();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Live assertion timed out');
}
const http = (path, options = {}) =>
  fetch(base + path, { ...options, signal: AbortSignal.timeout(10000) });
try {
  await test('LIVE-DB: paid HTTP flow has exactly one receipt, audit, paid hold and physical owner', async () => {
    const order = await sales.onlineOrder.findUniqueOrThrow({
      where: { id: process.env.PHASE6_TEST_ORDER_ID },
    });
    assert.equal(order.status, 'REFUND_PENDING');
    assert.equal(await sales.onlinePayment.count({ where: { orderId: order.id } }), 1);
    assert.equal(
      await sales.onlinePaymentAudit.count({
        where: { orderId: order.id, action: 'MANUAL_RECEIPT_VERIFIED' },
      }),
      1,
    );
    assert.equal(
      await sales.onlinePaymentAudit.count({
        where: { orderId: order.id, action: 'REFUND_REQUESTED' },
      }),
      1,
    );
    assert.equal(
      await sales.outboxEvent.count({ where: { aggregateId: order.id, eventType: 'order.paid' } }),
      1,
    );
    const hold = await inventory.stockReservation.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    assert.equal(hold.status, 'PAID_HELD');
    assert.equal(hold.paymentId, order.activePaymentId);
    assert.equal(
      await inventory.stockReservationItem.count({
        where: { jewelryItemId: FIXTURE.item, isActive: true },
      }),
      1,
    );
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: FIXTURE.item } })).status,
      'RESERVED',
    );
  });
  await test('LIVE-MQ: duplicate order.paid delivery leaves payment version and refund state unchanged', async () => {
    const orderId = process.env.PHASE6_TEST_ORDER_ID;
    const row = await sales.outboxEvent.findFirstOrThrow({
      where: { aggregateId: orderId, eventType: 'order.paid' },
    });
    const before = await inventory.stockReservation.findUniqueOrThrow({ where: { orderId } });
    assert.equal(
      await inventory.processedEvent.count({ where: { eventId: row.id, consumer: 'inventory' } }),
      1,
    );
    await publish(envelope(row));
    await publish(envelope(row));
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(
      await inventory.processedEvent.count({ where: { eventId: row.id, consumer: 'inventory' } }),
      1,
    );
    const after = await inventory.stockReservation.findUniqueOrThrow({ where: { orderId } });
    assert.equal(after.paymentVersion, before.paymentVersion);
    assert.equal(after.status, 'PAID_HELD');
    assert.equal(
      (await sales.onlineOrder.findUniqueOrThrow({ where: { id: orderId } })).status,
      'REFUND_PENDING',
    );
  });
  await test('LIVE-MQ: stale catalog event is processed without overwriting newer snapshot', async () => {
    const current = await sales.catalogProduct.findUniqueOrThrow({
      where: { id: FIXTURE.product },
    });
    const row = await inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: FIXTURE.product, eventType: 'product.snapshot' },
      orderBy: { createdAt: 'asc' },
    });
    const event = {
      ...envelope(row),
      eventId: randomUUID(),
      payload: { ...row.payload, version: row.payload.version, name: 'PH6 stale must not win' },
    };
    await publish(event);
    await poll(
      () => sales.processedEvent.count({ where: { eventId: event.eventId, consumer: 'sales' } }),
      (n) => n === 1,
    );
    const after = await sales.catalogProduct.findUniqueOrThrow({ where: { id: FIXTURE.product } });
    assert.ok(after.version >= current.version);
    assert.equal(after.name, current.name);
  });
  await test('LIVE-HTTP: catalog filters, private no-store, cross-guest denial and out-of-stock checkout', async () => {
    const r = await http(
      `/api/shop/products?search=PH6ACCEPT&metalKind=GOLD&minPrice=999999999&page=1&pageSize=1`,
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 0);
    const access = JSON.parse(readFileSync(process.env.PHASE6_TEST_ACCESS_FILE, 'utf8'));
    const tracking = await http(`/api/shop/orders/${access.orderId}`, {
      headers: { Authorization: `Checkout ${access.token}` },
    });
    assert.equal(tracking.status, 200);
    assert.equal(tracking.headers.get('cache-control'), 'no-store');
    const stranger = await http(`/api/shop/orders/${access.orderId}`, {
      headers: { Authorization: `Checkout ${randomBytes(32).toString('hex')}` },
    });
    assert.equal(stranger.status, 404);
    const token = `Checkout ${randomBytes(32).toString('hex')}`;
    const res = await http('/api/shop/orders', {
      method: 'POST',
      headers: {
        Authorization: token,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ variantId: FIXTURE.variant, quantity: 1 }],
        recipientName: 'PH6 stock test',
        recipientPhone: '0901234567',
        shippingAddress: 'PH6 isolated address',
      }),
    });
    assert.equal(res.status, 202);
    const order = await res.json();
    assert.equal(await sales.onlineOrder.count({ where: { id: order.id } }), 1);
    const failed = await poll(
      () => sales.onlineOrder.findUniqueOrThrow({ where: { id: order.id } }),
      (o) => o.status !== 'PENDING',
    );
    assert.equal(failed.status, 'CANCELLED');
    assert.equal(
      (await inventory.stockReservation.findUniqueOrThrow({ where: { orderId: order.id } })).status,
      'FAILED',
    );
    assert.equal(
      await inventory.stockReservationItem.count({ where: { reservation: { orderId: order.id } } }),
      0,
    );
    assert.equal(await sales.onlinePayment.count({ where: { orderId: order.id } }), 0);
  });
  await test('LIVE-LOG: correlation crosses Gateway/Sales; capability, JWT and cookie are redacted', async () => {
    const access = JSON.parse(readFileSync(process.env.PHASE6_TEST_ACCESS_FILE, 'utf8'));
    const correlation = randomUUID();
    const r = await http(`/api/shop/orders/${access.orderId}`, {
      headers: {
        Authorization: `Checkout ${access.token}`,
        Cookie: 'phase6_test_cookie=PH6_SECRET_COOKIE',
        'x-correlation-id': correlation,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-correlation-id'), correlation);
    await new Promise((r) => setTimeout(r, 300));
    for (const service of ['gateway', 'sales']) {
      const log = readFileSync(`${process.env.PHASE6_TEST_LOG_DIR}/${service}.log`, 'utf8');
      assert.ok(log.includes(correlation));
      assert.ok(!log.includes(access.token));
      assert.ok(!log.includes('PH6_SECRET_COOKIE'));
      for (const line of log.trim().split('\n')) {
        const entry = JSON.parse(line);
        assert.ok(!entry.req?.headers?.authorization);
        assert.ok(!entry.req?.headers?.cookie);
      }
    }
  });
} finally {
  await channel.close();
  await connection.close();
  await inventory.$disconnect();
  await sales.$disconnect();
}
