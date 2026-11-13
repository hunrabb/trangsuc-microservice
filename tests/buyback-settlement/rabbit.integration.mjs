import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = new URL('../../', import.meta.url);
const reportRequire = createRequire(new URL('apps/report/package.json', root));
const salesRequire = createRequire(new URL('apps/sales/package.json', root));
const inventoryRequire = createRequire(new URL('apps/inventory/package.json', root));
assert.equal(process.env.PHASE73_TEST_EXECUTE, 'I_ACKNOWLEDGE_ISOLATED_PHASE73_TEST');
const rabbitUrl = new URL(process.env.PHASE73_TEST_RABBIT_URL);
assert.equal(rabbitUrl.hostname, '127.0.0.1');
assert.equal(rabbitUrl.port, '5673');
assert.equal(rabbitUrl.username, 'phase73_app');
assert.ok(rabbitUrl.password);
function client(service, require) {
  const url = new URL(process.env[`PHASE73_TEST_${service.toUpperCase()}_URL`]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55434');
  assert.equal(url.pathname, '/phase73_test');
  assert.equal(url.username, `${service}_user`);
  assert.equal(url.searchParams.get('schema'), service);
  assert.ok(url.password);
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }, { schema: service }),
  });
}
const report = client('report', reportRequire),
  sales = client('sales', salesRequire),
  inventory = client('inventory', inventoryRequire);
const common = reportRequire('@jewelry/common'),
  contracts = reportRequire('@jewelry/contracts');
const { dispatchPaidOrder } = reportRequire('./dist/orders/paid-order-dispatch.js');
const { acknowledgeStockChanged } = reportRequire('./dist/stock/stock-changed.handler.js');
const { handleSystemTest } = reportRequire('./dist/system/system-test.handler.js');
const rabbit = new common.RabbitConnection(rabbitUrl.toString());
let consumer;
const waitFor = async (fn, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
async function publish(row) {
  const envelope = {
    eventId: row.id,
    eventType: row.eventType,
    occurredAt: row.createdAt.toISOString(),
    correlationId: row.correlationId,
    payload: row.payload,
  };
  await rabbit.publish({
    exchange: contracts.EVENTS_EXCHANGE,
    routingKey: row.eventType,
    content: Buffer.from(JSON.stringify(envelope)),
    messageId: row.id,
  });
}
try {
  for (const [db, role] of [
    [report, 'report_user'],
    [sales, 'sales_user'],
    [inventory, 'inventory_user'],
  ]) {
    const [actual] = await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;
    assert.equal(actual.db, 'phase73_test');
    assert.equal(actual.role, role);
  }
  await rabbit.start();
  await waitFor(() => rabbit.isConnected, 'isolated Rabbit connection');
  consumer = new common.EventConsumer({
    rabbit,
    db: report,
    queue: contracts.QUEUES.REPORT,
    consumer: 'phase73-report-acceptance',
    handlers: {
      [contracts.ROUTING_KEYS.ORDER_PAID]: dispatchPaidOrder,
      [contracts.ROUTING_KEYS.STOCK_CHANGED]: acknowledgeStockChanged,
      [contracts.ROUTING_KEYS.SYSTEM_TEST]: handleSystemTest,
    },
  });
  await consumer.start();
  await test('RMQ-01 publisher confirms and Report consumer commits ProcessedEvent', async () => {
    const id = randomUUID();
    const eventId = await common.outbox.add(report, {
      eventType: contracts.ROUTING_KEYS.SYSTEM_TEST,
      aggregateType: 'Phase73Test',
      aggregateId: id,
      payload: { message: 'phase73 isolated publisher confirm' },
    });
    const worker = new common.OutboxWorker({
      db: report,
      rabbit,
      dbSchema: 'report',
      batchSize: 1,
    });
    await worker.tick();
    await waitFor(
      async () =>
        (await report.processedEvent.count({
          where: { eventId, consumer: 'phase73-report-acceptance' },
        })) === 1,
      'system.test consumer',
    );
    const stored = await report.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(stored.status, 'PUBLISHED');
    assert.ok(stored.publishedAt);
  });
  await test('RMQ-02 duplicate order.paid delivery records one sale revenue, not buyback payout', async () => {
    const settled = await sales.buybackSettlement.findFirstOrThrow({
      where: { kind: 'EXCHANGE', status: 'SETTLED' },
      orderBy: { createdAt: 'desc' },
    });
    const event = await sales.outboxEvent.findFirstOrThrow({
      where: { aggregateId: settled.id, eventType: 'order.paid' },
    });
    await publish(event);
    await publish(event);
    await waitFor(
      async () =>
        (await report.processedEvent.count({
          where: { eventId: event.id, consumer: 'phase73-report-acceptance' },
        })) === 1,
      'duplicate order.paid',
    );
    await waitFor(
      async () => (await report.orderRevenue.count({ where: { orderId: settled.id } })) === 1,
      'sale revenue',
    );
    const revenue = await report.orderRevenue.findUniqueOrThrow({ where: { orderId: settled.id } });
    assert.equal(revenue.revenue.toFixed(2), settled.saleAmount.toFixed(2));
    assert.equal(await report.orderLineSales.count({ where: { orderId: settled.id } }), 1);
    const direct = await sales.buybackSettlement.findFirstOrThrow({
      where: { kind: 'DIRECT', status: 'SETTLED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(await report.orderRevenue.count({ where: { orderId: direct.id } }), 0);
  });
  await test('RMQ-03 duplicate stock.changed delivery records one deferred stock event', async () => {
    const settled = await sales.buybackSettlement.findFirstOrThrow({
      where: { kind: 'EXCHANGE', status: 'SETTLED' },
      orderBy: { createdAt: 'desc' },
    });
    const event = await inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: settled.id, eventType: 'stock.changed' },
    });
    await publish(event);
    await publish(event);
    await waitFor(
      async () =>
        (await report.processedEvent.count({
          where: { eventId: event.id, consumer: 'phase73-report-acceptance' },
        })) === 1,
      'duplicate stock.changed',
    );
    assert.equal(await report.deferredStockEvent.count({ where: { eventId: event.id } }), 1);
  });
} finally {
  if (consumer) await consumer.stop();
  await rabbit.stop();
  await report.$disconnect();
  await sales.$disconnect();
  await inventory.$disconnect();
}
