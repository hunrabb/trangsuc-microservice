import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { Prisma } = require('../dist/generated/prisma/client.js');
const { historicalOrder, backfillEventId } = require('../dist/backfill/historical-orders.js');
const D = (value) => new Prisma.Decimal(value);
function fixture() {
  return {
    id: randomUUID(),
    code: 'BACKFILL-TEST',
    status: 'COMPLETED',
    branchId: randomUUID(),
    total: D('100000.00'),
    requestedTagCodes: ['TEST-1'],
    history: [
      {
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'COMPLETED',
        createdAt: new Date('2026-11-01T17:30:00Z'),
      },
    ],
    items: [
      {
        tagCode: 'TEST-1',
        variantId: null,
        metalId: null,
        productName: 'Nhẫn lịch sử',
        metalWeight: D('1.2500'),
        price: D('100000.00'),
        costPrice: D('0'),
      },
    ],
  };
}
test('đơn lịch sử giữ giá bán và vốn null, ID ổn định, paidAt lấy lịch sử hoặc event gốc', () => {
  const order = fixture();
  const row = historicalOrder(order);
  assert.equal(row.envelope.payload.items[0].costPrice, null);
  assert.equal(row.envelope.payload.items[0].price, '100000.00');
  assert.equal(row.envelope.eventId, backfillEventId(order.id));
  assert.equal(row.envelope.payload.paidAt, '2026-11-01T17:30:00.000Z');
  assert.equal(
    historicalOrder(order, '2026-11-01T17:30:00.001Z').envelope.payload.paidAt,
    '2026-11-01T17:30:00.001Z',
  );
  order.items[0].variantId = randomUUID();
  order.items[0].costPrice = D('80000');
  assert.equal(historicalOrder(order).envelope.payload.items[0].costPrice, '80000.00');
});
test('không phát đơn chưa trả tiền, thiếu lịch sử/dòng, trùng tem hoặc sai tổng', () => {
  for (const status of ['CREATING', 'PENDING_PAYMENT', 'CANCELLING', 'CANCELLED']) {
    assert.equal(historicalOrder({ ...fixture(), status }).reason, 'NOT_PAID');
  }
  assert.equal(
    historicalOrder({ ...fixture(), history: [] }).reason,
    'MISSING_OR_AMBIGUOUS_PAYMENT_HISTORY',
  );
  assert.equal(historicalOrder({ ...fixture(), items: [] }).reason, 'MISSING_LINES');
  const order = fixture();
  assert.equal(
    historicalOrder({ ...order, items: [...order.items, ...order.items] }).reason,
    'MISSING_OR_DUPLICATE_LINES',
  );
  assert.equal(historicalOrder({ ...order, total: D('1') }).reason, 'TOTAL_MISMATCH');
  assert.equal(
    historicalOrder({ ...order, requestedTagCodes: ['MISSING'] }).reason,
    'MISSING_OR_DUPLICATE_LINES',
  );
});
