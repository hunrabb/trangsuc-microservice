import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const { reportFilter } = require('../dist/orders/reports.service.js');
const { Prisma } = require('../dist/generated/prisma/client.js');
const { StockReportsService } = require('../dist/stock/stock-reports.service.js');

const branchId = '11111111-1111-4111-8111-111111111111';
const otherBranchId = '22222222-2222-4222-8222-222222222222';
const warehouseId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const metalId = '55555555-5555-4555-8555-555555555555';

function row(localDate, onHand, received, sold) {
  return {
    localDate,
    warehouseId,
    variantId,
    batchId: warehouseId,
    sku: 'RING-18K',
    metalId,
    metalCode: '18K',
    metalKind: 'GOLD',
    onHand,
    weight: new Prisma.Decimal(onHand).times('1.2500'),
    value: new Prisma.Decimal(onHand).times('900000.00'),
    received,
    receivedWeight: new Prisma.Decimal(received).times('1.2500'),
    receivedValue: new Prisma.Decimal(received).times('900000.00'),
    released: 0,
    releasedWeight: new Prisma.Decimal(0),
    releasedValue: new Prisma.Decimal(0),
    sold,
    soldWeight: new Prisma.Decimal(sold).times('1.2500'),
    soldValue: new Prisma.Decimal(sold).times('900000.00'),
  };
}

function fixture(withClosing = true) {
  const firstAt = new Date('2026-11-07T17:05:00Z');
  const secondAt = new Date('2026-11-08T17:05:00Z');
  const batches = [
    {
      id: '1',
      branchId,
      warehouseId,
      localDate: '2026-11-07',
      capturedAt: firstAt,
      previousCapturedAt: null,
      rows: [row('2026-11-07', 2, 0, 0)],
    },
    ...(withClosing
      ? [
          {
            id: '2',
            branchId,
            warehouseId,
            localDate: '2026-11-08',
            capturedAt: secondAt,
            previousCapturedAt: firstAt,
            rows: [row('2026-11-08', 3, 2, 1)],
          },
        ]
      : []),
  ];
  const database = { inventorySnapshotBatch: { findMany: async () => batches } };
  return new StockReportsService(database);
}

it('đối soát tồn đầu + nhập - bán = tồn cuối bằng số chiếc, chỉ và giá vốn', async () => {
  const result = await fixture().movements({ from: '2026-11-08', to: '2026-11-08', branchId });
  assert.equal(result.warehouses[0]?.complete, true);
  const line = result.warehouses[0]?.rows[0];
  assert.equal(line?.opening.pieces, 2);
  assert.equal(line?.received.chi, '2.5000');
  assert.equal(line?.sold.costValue, '900000.00');
  assert.equal(line?.closing.pieces, 3);
});

it('thiếu bản chốt thì không trả số liệu nhập–xuất–tồn giả', async () => {
  const result = await fixture(false).movements({ from: '2026-11-08', to: '2026-11-08', branchId });
  assert.equal(result.warehouses[0]?.complete, false);
  assert.equal(result.warehouses[0]?.reason, 'MISSING_SNAPSHOT');
  assert.deepEqual(result.warehouses[0]?.rows, []);
});

it('chi nhánh chưa có mốc được báo thiếu, không trả warehouseId giả', async () => {
  const database = { inventorySnapshotBatch: { findMany: async () => [] } };
  const result = await new StockReportsService(database).movements({
    from: '2026-11-08', to: '2026-11-08', branchId,
  });
  assert.equal(result.warehouses[0]?.complete, false);
  assert.equal(result.warehouses[0]?.warehouseId, null);
  assert.deepEqual(result.warehouses[0]?.missingDates, ['2026-11-07', '2026-11-08']);
});

it('MANAGER không xem được chi nhánh khác, ngày sai bị từ chối', () => {
  const user = { branches: [{ role: 'MANAGER', branchId }] };
  assert.throws(() => reportFilter(user, '2026-11-08', '2026-11-08', otherBranchId));
  assert.throws(() => reportFilter(user, '2026-02-30', '2026-02-30', branchId));
  assert.equal(reportFilter(user, '2026-11-08', '2026-11-08', branchId).branchId, branchId);
});
