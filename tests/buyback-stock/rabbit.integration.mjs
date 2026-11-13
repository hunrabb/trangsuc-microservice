import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const root = new URL('../../', import.meta.url);
const req = Object.fromEntries(
  ['sales', 'inventory', 'report'].map((service) => [
    service,
    createRequire(new URL(`apps/${service}/package.json`, root)),
  ]),
);
assert.equal(process.env.PHASE74_TEST_EXECUTE, 'I_ACKNOWLEDGE_ISOLATED_PHASE74_TEST');
const rabbitUrl = new URL(process.env.PHASE74_TEST_RABBIT_URL);
assert.equal(rabbitUrl.hostname, '127.0.0.1');
assert.equal(rabbitUrl.port, '5674');
assert.equal(rabbitUrl.username, 'phase74_admin');
assert.ok(rabbitUrl.password);

function client(service) {
  const url = new URL(process.env[`PHASE74_TEST_${service.toUpperCase()}_URL`]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55435');
  assert.equal(url.pathname, '/phase74_test');
  assert.equal(url.username, `${service}_user`);
  assert.equal(url.searchParams.get('schema'), service);
  assert.ok(url.password);
  const { PrismaPg } = req[service]('@prisma/adapter-pg');
  const { PrismaClient } = req[service]('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString(), max: 15 }, { schema: service }),
  });
}

const db = Object.fromEntries(
  ['sales', 'inventory', 'report'].map((service) => [service, client(service)]),
);
const common = req.report('@jewelry/common');
const contracts = req.report('@jewelry/contracts');
const { receiveSettledBuyback } = req.inventory('./dist/receipts/buyback-receipts.handler.js');
const { ONLINE_INVENTORY_HANDLERS } = req.inventory('./dist/online/order-events.js');
const { recordBuybackSettled, recordBuybackStocked } = req.report(
  './dist/buybacks/buyback-events.js',
);
const { dispatchPaidOrder } = req.report('./dist/orders/paid-order-dispatch.js');
const { acknowledgeStockChanged } = req.report('./dist/stock/stock-changed.handler.js');
const { handleSystemTest } = req.report('./dist/system/system-test.handler.js');
const rabbit = new common.RabbitConnection(rabbitUrl.toString());
let inventoryConsumer, reportConsumer;
const waitFor = async (fn, label, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
async function publish(row) {
  await rabbit.publish({
    exchange: contracts.EVENTS_EXCHANGE,
    routingKey: row.eventType,
    content: Buffer.from(
      JSON.stringify({
        eventId: row.id,
        eventType: row.eventType,
        occurredAt: row.createdAt.toISOString(),
        correlationId: row.correlationId,
        payload: row.payload,
      }),
    ),
    messageId: row.id,
  });
}

try {
  for (const service of ['sales', 'inventory', 'report']) {
    const [actual] = await db[service]
      .$queryRaw`SELECT current_database() AS db, current_user AS role`;
    assert.equal(actual.db, 'phase74_test');
    assert.equal(actual.role, `${service}_user`);
  }
  const pending = await db.sales.buybackSettlement.findMany({
    where: { status: 'SETTLED', kind: 'DIRECT' },
    orderBy: { createdAt: 'desc' },
  });
  let target;
  for (const settlement of pending) {
    if (
      (await db.inventory.goodsReceipt.count({ where: { sourceSettlementId: settlement.id } })) ===
      0
    ) {
      target = settlement;
      break;
    }
  }
  assert.ok(target, 'Run stock.integration.mjs first to create pending Rabbit fixture');
  const settledEvent = await db.sales.outboxEvent.findFirstOrThrow({
    where: { aggregateId: target.id, eventType: 'buyback.settled' },
  });

  await rabbit.start();
  await waitFor(() => rabbit.isConnected, 'isolated Rabbit connection');
  inventoryConsumer = new common.EventConsumer({
    rabbit,
    db: db.inventory,
    queue: contracts.QUEUES.INVENTORY,
    consumer: 'phase74-inventory-acceptance',
    handlers: {
      ...ONLINE_INVENTORY_HANDLERS,
      [contracts.ROUTING_KEYS.BUYBACK_SETTLED]: receiveSettledBuyback,
    },
  });
  reportConsumer = new common.EventConsumer({
    rabbit,
    db: db.report,
    queue: contracts.QUEUES.REPORT,
    consumer: 'phase74-report-acceptance',
    handlers: {
      [contracts.ROUTING_KEYS.BUYBACK_SETTLED]: recordBuybackSettled,
      [contracts.ROUTING_KEYS.BUYBACK_STOCKED]: recordBuybackStocked,
      [contracts.ROUTING_KEYS.ORDER_PAID]: dispatchPaidOrder,
      [contracts.ROUTING_KEYS.STOCK_CHANGED]: acknowledgeStockChanged,
      [contracts.ROUTING_KEYS.SYSTEM_TEST]: handleSystemTest,
    },
  });
  await inventoryConsumer.start();
  await reportConsumer.start();

  await test('RMQ-01 Sales outbox reaches Inventory and Report, then Inventory outbox reaches Report', async () => {
    const salesWorker = new common.OutboxWorker({
      db: db.sales,
      rabbit,
      dbSchema: 'sales',
      batchSize: 100,
    });
    const inventoryWorker = new common.OutboxWorker({
      db: db.inventory,
      rabbit,
      dbSchema: 'inventory',
      batchSize: 100,
    });
    await salesWorker.tick();
    await waitFor(
      async () =>
        (await db.inventory.goodsReceipt.count({ where: { sourceSettlementId: target.id } })) ===
          1 &&
        (await db.report.buybackSettlementFact.count({ where: { settlementId: target.id } })) === 1,
      'receipt and settlement fact',
    );
    const stocked = await db.inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: target.id, eventType: 'buyback.stocked' },
    });
    await inventoryWorker.tick();
    await waitFor(
      async () =>
        (await db.report.buybackStockFact.count({ where: { settlementId: target.id } })) === 1,
      'stock fact',
    );
    assert.equal(
      (await db.sales.outboxEvent.findUniqueOrThrow({ where: { id: settledEvent.id } })).status,
      'PUBLISHED',
    );
    assert.equal(
      (await db.inventory.outboxEvent.findUniqueOrThrow({ where: { id: stocked.id } })).status,
      'PUBLISHED',
    );
    assert.equal(
      await db.inventory.processedEvent.count({
        where: { eventId: settledEvent.id, consumer: 'phase74-inventory-acceptance' },
      }),
      1,
    );
    assert.equal(
      await db.report.processedEvent.count({
        where: { eventId: stocked.id, consumer: 'phase74-report-acceptance' },
      }),
      1,
    );
    assert.equal(await db.report.orderRevenue.count({ where: { orderId: target.id } }), 0);
    assert.equal(
      await db.inventory.stockMovement.count({
        where: { refType: 'BuybackSettlement', refId: target.id, type: 'BUYBACK' },
      }),
      1,
    );
  });

  await test('RMQ-02 duplicate broker delivery is acknowledged without duplicate stock, facts or revenue', async () => {
    await publish(settledEvent);
    await publish(settledEvent);
    await waitFor(
      async () =>
        (await db.inventory.processedEvent.count({
          where: { eventId: settledEvent.id, consumer: 'phase74-inventory-acceptance' },
        })) === 1,
      'duplicate settlement ack',
    );
    assert.equal(
      await db.inventory.goodsReceipt.count({ where: { sourceSettlementId: target.id } }),
      1,
    );
    assert.equal(
      await db.inventory.jewelryItem.count({ where: { sourceSettlementId: target.id } }),
      1,
    );
    assert.equal(
      await db.inventory.outboxEvent.count({
        where: { aggregateId: target.id, eventType: 'buyback.stocked' },
      }),
      1,
    );
    assert.equal(
      await db.report.buybackSettlementFact.count({ where: { settlementId: target.id } }),
      1,
    );
    assert.equal(await db.report.buybackStockFact.count({ where: { settlementId: target.id } }), 1);
  });

  await test('RMQ-03 stopped broker leaves outbox pending; restart publishes once', async () => {
    const id = randomUUID();
    const eventId = await common.outbox.add(db.report, {
      eventType: contracts.ROUTING_KEYS.SYSTEM_TEST,
      aggregateType: 'Phase74Recovery',
      aggregateId: id,
      payload: { message: 'phase74 disconnect/reconnect' },
    });
    const worker = new common.OutboxWorker({
      db: db.report,
      rabbit,
      dbSchema: 'report',
      batchSize: 1,
    });
    await reportConsumer.stop();
    await inventoryConsumer.stop();
    const brokerContainer = 'jewelry-phase74-acceptance-rabbitmq-1';
    const broker = JSON.parse(
      execFileSync('docker', ['inspect', brokerContainer], { encoding: 'utf8' }),
    )[0];
    assert.equal(broker.Config.Labels['com.docker.compose.project'], 'jewelry-phase74-acceptance');
    let stopped = false;
    try {
      execFileSync('docker', ['stop', '-t', '5', brokerContainer]);
      stopped = true;
      await waitFor(() => !rabbit.isConnected, 'Rabbit connection loss', 20000);
      await worker.tick();
      const pendingEvent = await db.report.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      assert.equal(pendingEvent.status, 'PENDING');
      assert.equal(pendingEvent.attempts, 0);
    } finally {
      if (stopped) execFileSync('docker', ['start', brokerContainer]);
      await rabbit.stop();
    }
    const recovered = new common.RabbitConnection(rabbitUrl.toString());
    let recoveredConsumer;
    try {
      await recovered.start();
      await waitFor(() => recovered.isConnected, 'recovered Rabbit connection');
      recoveredConsumer = new common.EventConsumer({
        rabbit: recovered,
        db: db.report,
        queue: contracts.QUEUES.REPORT,
        consumer: 'phase74-report-acceptance',
        handlers: {
          [contracts.ROUTING_KEYS.SYSTEM_TEST]: handleSystemTest,
          [contracts.ROUTING_KEYS.BUYBACK_SETTLED]: recordBuybackSettled,
          [contracts.ROUTING_KEYS.BUYBACK_STOCKED]: recordBuybackStocked,
          [contracts.ROUTING_KEYS.ORDER_PAID]: dispatchPaidOrder,
          [contracts.ROUTING_KEYS.STOCK_CHANGED]: acknowledgeStockChanged,
        },
      });
      await recoveredConsumer.start();
      await new common.OutboxWorker({
        db: db.report,
        rabbit: recovered,
        dbSchema: 'report',
        batchSize: 1,
      }).tick();
      await waitFor(
        async () =>
          (await db.report.processedEvent.count({
            where: { eventId, consumer: 'phase74-report-acceptance' },
          })) === 1,
        'recovered outbox delivery',
      );
      assert.equal(
        (await db.report.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).status,
        'PUBLISHED',
      );
    } finally {
      if (recoveredConsumer) await recoveredConsumer.stop();
      await recovered.stop();
    }
  });
} finally {
  if (inventoryConsumer) await inventoryConsumer.stop();
  if (reportConsumer) await reportConsumer.stop();
  await rabbit.stop();
  for (const client of Object.values(db)) await client.$disconnect();
}
