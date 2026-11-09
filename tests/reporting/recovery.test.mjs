import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import {
  appRequire,
  reportRequire,
  client,
  common,
  fixtureOrder,
  cleanupOrders,
  broker,
  consumer,
  publish,
  rabbitUrl,
  waitFor,
} from './support.mjs';
const { emitOrderEvent } = appRequire('sales')('./dist/core/order-transactions.js');
const { recordPaidOrder } = reportRequire('./dist/orders/order-report.handler.js');
const { ReportsService } = reportRequire('./dist/orders/reports.service.js');

test(
  'Report offline thực 600 giây: outbox giữ đủ event, restart đuổi kịp và không nhân doanh thu',
  { timeout: 690_000 },
  async () => {
    const sales = client('sales');
    const report = client('report');
    const transport = await broker();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const branchId = randomUUID();
    const eventIds = [];
    let reportRabbit = new common.RabbitConnection(rabbitUrl);
    let active;
    const worker = new common.OutboxWorker({
      db: sales,
      rabbit: transport.rabbit,
      dbSchema: 'sales',
    });
    async function startReport() {
      active = consumer(report, reportRabbit, { 'order.paid': recordPaidOrder });
      await active.start();
      await reportRabbit.start();
      await waitFor(() => reportRabbit.isConnected);
      await waitFor(
        async () => (await transport.channel.checkQueue('report.events')).consumerCount === 1,
      );
    }
    async function produce(id) {
      await sales.$transaction(async (tx) => {
        const source = await tx.order.create({
          data: fixtureOrder(id, branchId),
          include: { items: true },
        });
        await emitOrderEvent(tx, source, 'order.paid');
      });
      await worker.tick();
      const event = await sales.outboxEvent.findFirstOrThrow({
        where: { aggregateId: id, eventType: 'order.paid' },
      });
      assert.equal(event.status, 'PUBLISHED');
      eventIds.push(event.id);
      return {
        eventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
        correlationId: event.correlationId,
        occurredAt: event.createdAt.toISOString(),
      };
    }
    try {
      assert.equal(
        (await transport.channel.checkQueue('report.events')).messageCount,
        0,
        'Queue test cần trống trước recovery',
      );
      await startReport();
      await produce(ids[0]);
      await waitFor(
        async () => (await report.orderRevenue.count({ where: { orderId: ids[0] } })) === 1,
      );
      await active.stop();
      await reportRabbit.stop();
      assert.equal((await transport.channel.checkQueue('report.events')).consumerCount, 0);
      const stoppedAt = new Date().toISOString();
      const offlineStart = performance.now();
      console.log(JSON.stringify({ recovery: 'OFFLINE_START', stoppedAt, requiredMs: 600_000 }));
      let next = 1;
      let lastEnvelope;
      while (performance.now() - offlineStart < 600_000) {
        const elapsed = performance.now() - offlineStart;
        if (next < ids.length && elapsed >= (next - 1) * 270_000) {
          lastEnvelope = await produce(ids[next++]);
          // Cùng eventId gửi ba lần: chỉ một ProcessedEvent. Event thứ ba tạo ở phút thứ 9.
          await publish(transport.rabbit, lastEnvelope);
          await publish(transport.rabbit, lastEnvelope);
        }
        console.log(
          JSON.stringify({
            recovery: 'OFFLINE_WAIT',
            elapsedMs: Math.floor(performance.now() - offlineStart),
          }),
        );
        await sleep(Math.max(1, Math.min(30_000, 600_000 - (performance.now() - offlineStart))));
      }
      assert.equal(next, ids.length);
      assert.equal(
        await report.orderRevenue.count({ where: { orderId: { in: ids.slice(1) } } }),
        0,
      );
      assert.equal((await transport.channel.checkQueue('report.events')).messageCount, 9);
      const offlineMs = performance.now() - offlineStart;
      assert.ok(offlineMs >= 600_000);
      reportRabbit = new common.RabbitConnection(rabbitUrl);
      await startReport();
      await waitFor(
        async () =>
          (await report.orderRevenue.count({ where: { orderId: { in: ids } } })) === ids.length,
        30_000,
      );
      const duplicateId = randomUUID();
      eventIds.push(duplicateId);
      await publish(transport.rabbit, { ...lastEnvelope, eventId: duplicateId });
      await waitFor(
        async () =>
          (await report.processedEvent.count({
            where: { eventId: duplicateId, consumer: 'report' },
          })) === 1,
      );
      await waitFor(
        async () => (await transport.channel.checkQueue('report.events')).messageCount === 0,
      );
      const source = await sales.order.aggregate({
        where: { id: { in: ids } },
        _sum: { total: true },
      });
      const result = await report.orderRevenue.aggregate({
        where: { orderId: { in: ids } },
        _sum: { revenue: true, cogs: true },
      });
      assert.equal(result._sum.revenue.toFixed(2), source._sum.total.toFixed(2));
      assert.equal(result._sum.cogs.toFixed(2), '320000.00');
      assert.equal(
        await report.orderLineSales.count({ where: { orderId: { in: ids } } }),
        ids.length,
      );
      assert.equal(
        await report.processedEvent.count({
          where: { eventId: { in: eventIds }, consumer: 'report' },
        }),
        eventIds.length,
      );
      const daily = await new ReportsService(report).daily({
        from: '2000-01-01',
        to: '2100-01-01',
        branchId,
      });
      assert.equal(
        daily.rows.reduce((sum, row) => sum + row.orderCount, 0),
        ids.length,
      );
      console.log(
        JSON.stringify({
          recovery: 'VERIFIED',
          stoppedAt,
          offlineMs,
          recoveredAt: new Date().toISOString(),
          uniqueOrders: ids.length,
          revenue: result._sum.revenue.toFixed(2),
        }),
      );
    } finally {
      await active?.stop();
      await reportRabbit.stop();
      await worker.stop();
      await transport.close();
      await cleanupOrders(sales, report, ids, eventIds);
      await Promise.all([sales.$disconnect(), report.$disconnect()]);
    }
  },
);
