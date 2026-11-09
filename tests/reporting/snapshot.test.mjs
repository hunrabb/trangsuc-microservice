import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  appRequire,
  reportRequire,
  client,
  common,
  broker,
  consumer,
  publish,
  waitFor,
} from './support.mjs';
const { InventoryCloseWorker } = appRequire('inventory')('./dist/stock/inventory-close.worker.js');
const { recordInventorySnapshot } = reportRequire('./dist/stock/inventory-snapshot.handler.js');
const { StockReportsService } = reportRequire('./dist/stock/stock-reports.service.js');

test(
  'Inventory close → outbox → RabbitMQ → Report; duplicate, missing và inconsistent snapshot',
  { timeout: 60_000 },
  async () => {
    const inventory = client('inventory');
    const report = client('report');
    const transport = await broker();
    const branchId = randomUUID();
    const warehouseId = randomUUID();
    const variantId = randomUUID();
    const metalId = randomUUID();
    const categoryId = randomUUID();
    const productId = randomUUID();
    const itemId = randomUUID();
    const eventIds = [];
    let closeIds = [];
    let active;
    const worker = new common.OutboxWorker({
      db: inventory,
      rabbit: transport.rabbit,
      dbSchema: 'inventory',
    });
    try {
      assert.equal(
        (await transport.channel.checkQueue('report.events')).messageCount,
        0,
        'Queue test cần trống trước snapshot',
      );
      await inventory.warehouse.create({
        data: { id: warehouseId, branchId, name: `PH54-${warehouseId}` },
      });
      await inventory.metal.create({
        data: { id: metalId, code: `PH54-${metalId}`, name: 'Test metal', kind: 'GOLD' },
      });
      await inventory.category.create({ data: { id: categoryId, name: `PH54-${categoryId}` } });
      await inventory.product.create({ data: { id: productId, categoryId, name: 'Test ring' } });
      await inventory.productVariant.create({
        data: { id: variantId, productId, metalId, sku: `PH54-${variantId}`, name: 'Test ring' },
      });
      await inventory.$transaction(async (tx) => {
        await tx.jewelryItem.create({
          data: {
            id: itemId,
            warehouseId,
            variantId,
            tagCode: `PH54-${itemId}`,
            weight: '1.2500',
            laborFee: '0',
            costPrice: '80000.00',
          },
        });
        await tx.stockMovement.create({
          data: {
            jewelryItemId: itemId,
            warehouseId,
            type: 'RECEIPT',
            toStatus: 'IN_STOCK',
            refType: 'Test',
            refId: itemId,
          },
        });
      });
      const closeWorker = new InventoryCloseWorker(inventory);
      await closeWorker.closeWarehouse('2099-01-01', warehouseId, branchId);
      await closeWorker.closeWarehouse('2099-01-02', warehouseId, branchId);
      closeIds = (await inventory.inventoryDailyClose.findMany({ where: { warehouseId } })).map(
        (row) => row.id,
      );
      active = consumer(report, transport.rabbit, {
        'inventory.snapshot.closed': recordInventorySnapshot,
      });
      await active.start();
      await worker.tick();
      await waitFor(
        async () => (await report.inventorySnapshotBatch.count({ where: { warehouseId } })) === 2,
      );
      const events = await inventory.outboxEvent.findMany({
        where: { aggregateId: { in: closeIds } },
        orderBy: { createdAt: 'asc' },
      });
      assert.equal(events.length, 2);
      assert.ok(events.every((row) => row.status === 'PUBLISHED'));
      eventIds.push(...events.map((row) => row.id));
      const envelope = {
        eventId: events[1].id,
        eventType: events[1].eventType,
        payload: events[1].payload,
        correlationId: events[1].correlationId,
        occurredAt: events[1].createdAt.toISOString(),
      };
      await publish(transport.rabbit, envelope);
      const duplicateId = randomUUID();
      eventIds.push(duplicateId);
      await publish(transport.rabbit, { ...envelope, eventId: duplicateId });
      await waitFor(
        async () =>
          (await report.processedEvent.count({
            where: { eventId: duplicateId, consumer: 'report' },
          })) === 1,
      );
      assert.equal(await report.inventorySnapshotBatch.count({ where: { warehouseId } }), 2);
      assert.equal(await report.inventorySnapshot.count({ where: { warehouseId } }), 2);
      const service = new StockReportsService(report);
      const result = await service.movements({ from: '2099-01-02', to: '2099-01-02', branchId });
      assert.equal(result.warehouses[0].complete, true);
      assert.equal(result.warehouses[0].rows[0].closing.chi, '1.2500');
      assert.equal(
        (await service.movements({ from: '2099-01-03', to: '2099-01-03', branchId })).warehouses[0]
          .reason,
        'MISSING_SNAPSHOT',
      );
      // Giữ đúng identity ngày/kho nhưng sửa nội dung: handler từ chối, consumer đẩy DLQ.
      const conflictId = randomUUID();
      eventIds.push(conflictId);
      const dlqBefore = (await transport.channel.checkQueue('report.events.dlq')).messageCount;
      const altered = structuredClone(envelope);
      altered.eventId = conflictId;
      altered.payload.rows[0].weight = '99.0000';
      await publish(transport.rabbit, altered);
      await waitFor(
        async () =>
          (await transport.channel.checkQueue('report.events.dlq')).messageCount === dlqBefore + 1,
      );
      assert.equal(await report.processedEvent.count({ where: { eventId: conflictId } }), 0);
      assert.equal(
        (
          await report.inventorySnapshot.findFirstOrThrow({ where: { warehouseId } })
        ).weight.toFixed(4),
        '1.2500',
      );
    } finally {
      await active?.stop();
      await worker.stop();
      await transport.close();
      await report.processedEvent.deleteMany({ where: { eventId: { in: eventIds } } });
      await report.inventorySnapshot.deleteMany({ where: { warehouseId } });
      await report.inventorySnapshotBatch.deleteMany({ where: { warehouseId } });
      await inventory.outboxEvent.deleteMany({ where: { aggregateId: { in: closeIds } } });
      await inventory.inventoryDailyClose.deleteMany({ where: { warehouseId } });
      await inventory.stockMovement.deleteMany({ where: { jewelryItemId: itemId } });
      await inventory.jewelryItem.deleteMany({ where: { id: itemId } });
      await inventory.productVariant.deleteMany({ where: { id: variantId } });
      await inventory.product.deleteMany({ where: { id: productId } });
      await inventory.category.deleteMany({ where: { id: categoryId } });
      await inventory.metal.deleteMany({ where: { id: metalId } });
      await inventory.warehouse.deleteMany({ where: { id: warehouseId } });
      await Promise.all([inventory.$disconnect(), report.$disconnect()]);
    }
  },
);
