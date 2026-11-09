import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const inventoryRequire = createRequire(resolve(root, 'apps/inventory/package.json'));
const reportRequire = createRequire(resolve(root, 'apps/report/package.json'));
const { PrismaPg } = inventoryRequire('@prisma/adapter-pg');
const { PrismaClient: InventoryClient } = inventoryRequire('./dist/generated/prisma/client.js');
const { PrismaClient: ReportClient } = reportRequire('./dist/generated/prisma/client.js');
const { InventoryCloseWorker } = inventoryRequire('./dist/stock/inventory-close.worker.js');
const { recordInventorySnapshot } = reportRequire('./dist/stock/inventory-snapshot.handler.js');
const { StockReportsService } = reportRequire('./dist/stock/stock-reports.service.js');

process.loadEnvFile(resolve(root, '.env'));

function client(service, Client) {
  const password = process.env[`${service.toUpperCase()}_DB_PASSWORD`];
  const database = process.env.POSTGRES_DB;
  const connectionString = `postgresql://${service}_user:${password}@127.0.0.1:5432/${database}?schema=${service}`;
  return new Client({ adapter: new PrismaPg({ connectionString, max: 4 }, { schema: service }) });
}

it('PostgreSQL chốt một lần, chuyển qua outbox, Report nhận trùng không cộng lại', async () => {
  const inventory = client('inventory', InventoryClient);
  const report = client('report', ReportClient);
  const branchId = randomUUID();
  const warehouseId = randomUUID();
  const metalId = randomUUID();
  const categoryId = randomUUID();
  const productId = randomUUID();
  const variantId = randomUUID();
  const itemIds = [randomUUID(), randomUUID()];
  const token = randomUUID().slice(0, 8);
  const closeDates = ['2099-01-01', '2099-01-02'];
  let closeIds = [];
  try {
    await inventory.warehouse.create({
      data: { id: warehouseId, branchId, name: `TEST-${token}` },
    });
    await inventory.metal.create({
      data: { id: metalId, code: `TEST-${token}`, name: 'Test 18K', kind: 'GOLD' },
    });
    await inventory.category.create({ data: { id: categoryId, name: `TEST-${token}` } });
    await inventory.product.create({ data: { id: productId, categoryId, name: 'Test ring' } });
    await inventory.productVariant.create({
      data: { id: variantId, productId, metalId, sku: `TEST-${token}`, name: 'Test 18K' },
    });
    const createItem = async (itemId, tagCode) =>
      inventory.$transaction(async (tx) => {
        await tx.jewelryItem.create({
          data: {
            id: itemId,
            warehouseId,
            variantId,
            tagCode,
            weight: '1.2500',
            laborFee: '0',
            costPrice: '900000.00',
          },
        });
        await tx.stockMovement.create({
          data: {
            jewelryItemId: itemId,
            warehouseId,
            type: 'RECEIPT',
            toStatus: 'IN_STOCK',
            refType: 'Test',
            refId: randomUUID(),
          },
        });
      });
    await createItem(itemIds[0], `TEST-${token}-1`);
    const worker = new InventoryCloseWorker(inventory);
    assert.equal(await worker.closeWarehouse(closeDates[0], warehouseId, branchId), true);
    assert.equal(await worker.closeWarehouse(closeDates[0], warehouseId, branchId), false);
    await createItem(itemIds[1], `TEST-${token}-2`);
    const contenders = await Promise.all([
      worker.closeWarehouse(closeDates[1], warehouseId, branchId),
      worker.closeWarehouse(closeDates[1], warehouseId, branchId),
    ]);
    assert.deepEqual(contenders.sort(), [false, true]);
    const closes = await inventory.inventoryDailyClose.findMany({
      where: { warehouseId },
      orderBy: { localDate: 'asc' },
    });
    assert.equal(closes.length, 2);
    closeIds = closes.map((close) => close.id);
    const outbox = await inventory.outboxEvent.findMany({
      where: { aggregateId: { in: closeIds } },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(outbox.length, 2);
    for (const event of outbox) {
      const context = {
        envelope: {
          eventId: event.id,
          eventType: event.eventType,
          occurredAt: new Date().toISOString(),
          correlationId: event.correlationId,
          payload: event.payload,
        },
      };
      await report.$transaction((tx) => recordInventorySnapshot(event.payload, { ...context, tx }));
      await report.$transaction((tx) => recordInventorySnapshot(event.payload, { ...context, tx }));
    }
    assert.equal(await report.inventorySnapshotBatch.count({ where: { warehouseId } }), 2);
    assert.equal(await report.inventorySnapshot.count({ where: { warehouseId } }), 2);
    const result = await new StockReportsService(report).movements({
      from: closeDates[1],
      to: closeDates[1],
      branchId,
    });
    assert.equal(result.warehouses[0]?.complete, true);
    assert.equal(result.warehouses[0]?.rows[0]?.received.pieces, 1);
    assert.equal(result.warehouses[0]?.rows[0]?.closing.pieces, 2);
  } finally {
    // Chỉ dọn dữ liệu có id của fixture này; các bản chốt/kho khác không bị đụng tới.
    await report.inventorySnapshot.deleteMany({ where: { warehouseId } });
    await report.inventorySnapshotBatch.deleteMany({ where: { warehouseId } });
    await inventory.outboxEvent.deleteMany({ where: { aggregateId: { in: closeIds } } });
    await inventory.inventoryDailyClose.deleteMany({ where: { warehouseId } });
    await inventory.stockMovement.deleteMany({ where: { jewelryItemId: { in: itemIds } } });
    await inventory.jewelryItem.deleteMany({ where: { id: { in: itemIds } } });
    await inventory.productVariant.deleteMany({ where: { id: variantId } });
    await inventory.product.deleteMany({ where: { id: productId } });
    await inventory.category.deleteMany({ where: { id: categoryId } });
    await inventory.metal.deleteMany({ where: { id: metalId } });
    await inventory.warehouse.deleteMany({ where: { id: warehouseId } });
    await inventory.$disconnect();
    await report.$disconnect();
  }
});
