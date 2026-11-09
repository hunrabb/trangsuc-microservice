import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { Prisma } = require('../dist/generated/prisma/client.js');
const { backfillOrder } = require('../dist/orders/historical-backfill.js');
const { recordPaidOrder, validatePaidOrder } = require('../dist/orders/order-report.handler.js');
const D = (value) => new Prisma.Decimal(value);
function input() {
  const orderId = randomUUID();
  return {
    orderId,
    envelope: {
      eventId: randomUUID(),
      eventType: 'order.paid',
      occurredAt: '2026-11-01T17:30:00Z',
      correlationId: 'backfill-test',
      payload: {
        orderId,
        code: 'TEST',
        channel: 'POS',
        branchId: randomUUID(),
        total: '100000.00',
        tagCodes: ['TEST-1'],
        paidAt: '2026-11-01T17:30:00Z',
        items: [
          {
            tagCode: 'TEST-1',
            variantId: null,
            metalId: null,
            productName: 'Nhẫn',
            metalWeight: '1.2500',
            price: '100000.00',
            costPrice: null,
          },
        ],
      },
    },
  };
}
// Mock xác minh quyết định và số lần ghi. Race PostgreSQL nằm ở tests/reporting/backfill.test.mjs.
function database() {
  let stored = null;
  const markers = new Set();
  let writes = 0;
  return {
    get writes() {
      return writes;
    },
    get stored() {
      return stored;
    },
    get markers() {
      return markers;
    },
    orderRevenue: {
      findUnique: async () => stored,
      findUniqueOrThrow: async () => structuredCloneRow(stored),
      createMany: async ({ data }) => {
        writes++;
        if (stored) return { count: 0 };
        stored = { ...data[0], lines: [] };
        return { count: 1 };
      },
    },
    orderLineSales: {
      createMany: async ({ data }) => {
        writes++;
        stored.lines = data.map((line) => ({
          ...line,
          revenue: D(line.revenue),
          metalWeight: D(line.metalWeight),
          cogs: line.cogs === null ? null : D(line.cogs),
        }));
        return { count: data.length };
      },
    },
    processedEvent: {
      createMany: async ({ data }) => {
        writes++;
        markers.add(data[0].eventId);
        return { count: 1 };
      },
    },
  };
}
function structuredCloneRow(row) {
  return { ...row, lines: [...row.lines] };
}
test('dry-run chỉ đọc, đánh giá NEEDED/EXCLUDED; apply rồi chạy lại không nhân doanh thu', async () => {
  const tx = database();
  const row = input();
  assert.equal((await backfillOrder(tx, row)).status, 'NEEDED');
  assert.equal(tx.writes, 0);
  assert.equal(
    (await backfillOrder(tx, { orderId: row.orderId, reason: 'NOT_PAID' })).status,
    'EXCLUDED',
  );
  assert.equal((await backfillOrder(tx, row, true)).status, 'CREATED');
  assert.equal((await backfillOrder(tx, row, true)).status, 'EXISTS');
  const otherEvent = { ...row.envelope, eventId: randomUUID() };
  assert.equal(await recordPaidOrder(row.envelope.payload, { tx, envelope: otherEvent }), 'EXISTS');
  assert.equal(tx.stored.revenue.toFixed(2), '100000.00');
  assert.equal(tx.stored.localDate, '2026-11-02');
  assert.equal(tx.stored.cogs, null);
  assert.equal(tx.stored.lines.length, 1);
});
test('khác dòng/giá vốn/chi nhánh/ngày/kênh hoặc tombstone => CONFLICT, không ghi đè', async () => {
  const tx = database();
  const row = input();
  await backfillOrder(tx, row, true);
  const before = tx.writes;
  for (const mutate of [
    (p) => {
      p.branchId = randomUUID();
    },
    (p) => {
      p.paidAt = '2026-11-04T00:00:00Z';
    },
    (p) => {
      p.items[0].price = '99999.00';
      p.total = '99999.00';
    },
    (p) => {
      p.items[0].costPrice = '1.00';
    },
    (p) => {
      p.items[0].productName = 'Khác';
    },
    (p) => {
      p.items[0].variantId = randomUUID();
    },
    (p) => {
      p.items[0].metalWeight = '2.0000';
    },
  ]) {
    const changed = structuredClone(row);
    mutate(changed.envelope.payload);
    assert.equal((await backfillOrder(tx, changed, true)).status, 'CONFLICT');
  }
  tx.stored.status = 'CANCELLED';
  assert.equal((await backfillOrder(tx, row, true)).status, 'CONFLICT');
  assert.equal(tx.writes, before);
});
test('snapshot thiếu vốn không hạ cấp snapshot vốn đúng đã nhận live', async () => {
  const tx = database();
  const row = input();
  const rich = structuredClone(row);
  rich.envelope.payload.items[0].costPrice = '80000.00';
  await recordPaidOrder(rich.envelope.payload, { tx, envelope: rich.envelope });
  assert.equal((await backfillOrder(tx, row, true)).status, 'CONFLICT');
  assert.equal(tx.stored.cogs.toFixed(2), '80000.00');
});
test('từ chối số âm, sai precision, trùng/thiếu tem, sai tổng và envelope sai loại', async () => {
  for (const mutate of [
    (p) => {
      p.items[0].price = '-1';
    },
    (p) => {
      p.items[0].costPrice = '-1';
    },
    (p) => {
      p.items[0].metalWeight = '1.00001';
    },
    (p) => {
      p.total = '1.00';
    },
    (p) => {
      p.items.push(p.items[0]);
    },
    (p) => {
      p.tagCodes = ['OTHER'];
    },
  ]) {
    const row = input();
    mutate(row.envelope.payload);
    assert.throws(() => validatePaidOrder(row.envelope.payload));
  }
  const row = input();
  row.envelope.eventType = 'order.created';
  await assert.rejects(() => backfillOrder(database(), row));
  const wrongId = input();
  wrongId.orderId = randomUUID();
  await assert.rejects(() => backfillOrder(database(), wrongId));
});

test('tổng giá vốn vượt Decimal(15,2) được từ chối trước khi ghi DB', () => {
  const row = input();
  const first = row.envelope.payload.items[0];
  first.price = '50000.00';
  first.costPrice = '9999999999999.99';
  row.envelope.payload.items.push({ ...first, tagCode: 'TEST-2' });
  row.envelope.payload.tagCodes.push('TEST-2');
  assert.throws(() => validatePaidOrder(row.envelope.payload), /giá vốn vượt/);
});
