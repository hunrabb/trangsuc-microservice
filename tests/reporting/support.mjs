import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const root = resolve(import.meta.dirname, '../..');
export const appRequire = (service) => createRequire(resolve(root, `apps/${service}/package.json`));
export const reportRequire = appRequire('report');
reportRequire('reflect-metadata');
export const common = reportRequire('@jewelry/common');
export const rabbitUrl = 'amqp://phase54_test:phase54_test_only@127.0.0.1:55672';
export const databaseUrl = (service) =>
  `postgresql://${service}_user:phase54_test_only@127.0.0.1:55432/jewelry_phase54_test?schema=${service}`;
export function client(service) {
  const require = appRequire(service);
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl(service), max: 20 }, { schema: service }),
  });
}
export async function waitFor(check, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error('Hết thời gian đợi điều kiện integration');
}
export async function broker() {
  const { connect } = reportRequire('amqplib');
  const connection = await connect(rabbitUrl);
  const channel = await connection.createChannel();
  const definitions = JSON.parse(
    await readFile(resolve(root, 'infra/rabbitmq/definitions.json'), 'utf8'),
  );
  for (const item of definitions.exchanges)
    await channel.assertExchange(item.name, item.type, {
      durable: item.durable,
      arguments: item.arguments,
    });
  for (const item of definitions.queues)
    await channel.assertQueue(item.name, { durable: item.durable, arguments: item.arguments });
  for (const item of definitions.bindings)
    await channel.bindQueue(item.destination, item.source, item.routing_key, item.arguments);
  assert.equal(
    (await channel.checkQueue('report.events')).consumerCount,
    0,
    'Không chạy hai bài Rabbit cùng lúc',
  );
  const rabbit = new common.RabbitConnection(rabbitUrl);
  await rabbit.start();
  await waitFor(() => rabbit.isConnected);
  return {
    rabbit,
    channel,
    close: async () => {
      await rabbit.stop();
      await connection.close();
    },
  };
}
export function consumer(db, rabbit, handlers) {
  return new common.EventConsumer({
    db,
    rabbit,
    consumer: 'report',
    queue: 'report.events',
    handlers,
  });
}
export async function publish(rabbit, envelope) {
  await rabbit.publish({
    exchange: 'domain.events',
    routingKey: envelope.eventType,
    content: Buffer.from(JSON.stringify(envelope)),
    messageId: envelope.eventId,
    headers: {
      'x-correlation-id': envelope.correlationId,
      'x-original-routing-key': envelope.eventType,
    },
  });
}
export function fixtureOrder(id, branchId) {
  return {
    id,
    code: `PH54-${id}`,
    branchId,
    status: 'COMPLETED',
    idempotencyKey: id,
    requestHash: id,
    requestedTagCodes: [`PH54-${id}`],
    total: '100000.00',
    createdBy: branchId,
    items: {
      create: [
        {
          jewelryItemId: id,
          tagCode: `PH54-${id}`,
          productName: 'Test ring',
          metalWeight: '1.2500',
          laborFee: '0',
          metalPriceAtSale: '80000',
          price: '100000',
          costPrice: '80000',
          variantId: branchId,
          metalId: branchId,
        },
      ],
    },
    history: {
      create: [{ fromStatus: 'PENDING_PAYMENT', toStatus: 'COMPLETED', changedBy: branchId }],
    },
  };
}
export async function cleanupOrders(sales, report, ids, eventIds) {
  await report.processedEvent.deleteMany({ where: { eventId: { in: eventIds } } });
  await report.orderLineSales.deleteMany({ where: { orderId: { in: ids } } });
  await report.orderRevenue.deleteMany({ where: { orderId: { in: ids } } });
  await sales.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await sales.orderStatusHistory.deleteMany({ where: { orderId: { in: ids } } });
  await sales.orderItem.deleteMany({ where: { orderId: { in: ids } } });
  await sales.order.deleteMany({ where: { id: { in: ids } } });
}
