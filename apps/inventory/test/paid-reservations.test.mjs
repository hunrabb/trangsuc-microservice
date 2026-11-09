import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import { confirmPaidReservation, reviewExpiredPaidHold } from '../dist/online/payment-events.js';
import { releaseOnlineOrder, reserveOnlineOrder } from '../dist/online/reservations.js';
const itemId = randomUUID();
function fixture(overrides = {}) {
  const row = {
    id: randomUUID(),
    orderId: randomUUID(),
    total: new Decimal(1000),
    warehouseId: randomUUID(),
    branchId: randomUUID(),
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 1800000),
    paymentId: null,
    paymentReceivedAt: null,
    paymentOutcome: null,
    paymentFailureCode: null,
    paymentVersion: 0,
    requestHash: 'a'.repeat(64),
    items: [{ jewelryItemId: itemId, isActive: true }],
    ...overrides,
  };
  const state = { now: new Date(), status: 'RESERVED', writes: 0, events: [] };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async (strings) => {
      const sql = strings.join('?');
      if (sql.includes('clock_timestamp')) return [{ now: state.now }];
      if (sql.includes('FROM "inventory"."StockReservation"')) {
        assert.match(sql, /FOR UPDATE/);
        return [{ id: row.id }];
      }
      if (sql.includes('JewelryItem')) {
        assert.match(sql, /ORDER BY id FOR UPDATE/);
        return [{ id: itemId, status: state.status }];
      }
      throw new Error(sql);
    },
    stockReservation: {
      findUniqueOrThrow: async () => ({ ...row }),
      update: async ({ data }) => {
        state.writes++;
        const { paymentVersion, ...rest } = data;
        Object.assign(row, rest);
        if (paymentVersion) row.paymentVersion += paymentVersion.increment;
        return { ...row };
      },
    },
    outboxEvent: {
      create: async ({ data }) => {
        state.events.push(data);
      },
    },
  };
  const event = {
    channel: 'WEBSITE',
    orderId: row.orderId,
    reservationId: row.id,
    paymentId: randomUUID(),
    amount: '1000.00',
    currency: 'VND',
    receivedAt: state.now.toISOString(),
  };
  return { row, state, tx, event };
}
test('verified payment protects RESERVED hold for three days and emits Inventory confirmation; does not sell items', async () => {
  const f = fixture();
  await confirmPaidReservation(f.event, f);
  assert.equal(f.row.status, 'PAID_HELD');
  assert.equal(f.state.status, 'RESERVED');
  assert.equal(f.row.expiresAt.getTime(), new Date(f.event.receivedAt).getTime() + 259200000);
  assert.equal(f.state.events[0].payload.outcome, 'CONFIRMED');
  assert.equal(f.state.events[0].payload.version, 1);
});
test('duplicate paid events after lost acknowledgement return same result without extending again', async () => {
  const f = fixture();
  await confirmPaidReservation(f.event, f);
  const deadline = f.row.expiresAt.getTime();
  f.state.now = new Date(Date.now() + 86400000);
  await confirmPaidReservation(f.event, f);
  assert.equal(f.row.expiresAt.getTime(), deadline);
  assert.equal(f.state.writes, 1);
  assert.deepEqual(f.state.events[0].payload, f.state.events[1].payload);
});
test('expiry/cancel wins first: late payment gets review and cannot reserve another item or mark sold', async () => {
  for (const status of ['EXPIRED', 'RELEASED']) {
    const f = fixture({ status });
    f.state.status = 'IN_STOCK';
    await confirmPaidReservation(f.event, f);
    assert.equal(f.row.status, 'PAYMENT_REVIEW');
    assert.equal(f.state.status, 'IN_STOCK');
    assert.equal(f.state.events[0].payload.outcome, 'REJECTED');
  }
});
test('payment wins first: unpaid expiry/release and delayed order.created cannot free or allocate items again', async () => {
  const f = fixture();
  await confirmPaidReservation(f.event, f);
  f.state.now = new Date(Date.now() + 1800001);
  await releaseOnlineOrder(f.tx, f.row.orderId, 'EXPIRED');
  await releaseOnlineOrder(f.tx, f.row.orderId, 'RELEASED');
  await reserveOnlineOrder(f.tx, {
    channel: 'WEBSITE',
    orderId: f.row.orderId,
    requestHash: f.row.requestHash,
    items: [{ variantId: randomUUID(), quantity: 1 }],
    deadlineAt: new Date(Date.now() + 1800000).toISOString(),
  });
  assert.equal(f.row.status, 'PAID_HELD');
  assert.equal(f.state.status, 'RESERVED');
  assert.equal(f.state.writes, 1);
});
test('physically SOLD/missing/conflicting item never gets confirmed or freed by payment processing', async () => {
  const f = fixture();
  f.state.status = 'SOLD';
  await confirmPaidReservation(f.event, f);
  assert.equal(f.row.status, 'PAYMENT_REVIEW');
  assert.equal(f.state.status, 'SOLD');
  assert.equal(f.state.events[0].payload.reason, 'INVENTORY_CONFLICT');
});
test('wrong amount or malformed currency cannot be confirmed', async () => {
  const f = fixture();
  await confirmPaidReservation({ ...f.event, amount: '999.00' }, f);
  assert.equal(f.row.status, 'PAYMENT_REVIEW');
  assert.equal(f.state.events[0].payload.reason, 'AMOUNT_MISMATCH');
  const other = fixture();
  await assert.rejects(
    confirmPaidReservation({ ...other.event, currency: 'USD' }, other),
    /không hợp lệ/,
  );
  assert.equal(other.state.writes, 0);
});
test('paid hold past three days becomes review with newer result version, keeping physical items', async () => {
  const f = fixture();
  await confirmPaidReservation(f.event, f);
  f.state.now = new Date(f.row.expiresAt.getTime() + 1);
  await reviewExpiredPaidHold(f.tx, f.row.orderId);
  assert.equal(f.row.status, 'PAYMENT_REVIEW');
  assert.equal(f.state.status, 'RESERVED');
  assert.equal(f.state.events.at(-1).payload.version, 2);
  assert.equal(f.state.events.at(-1).payload.reason, 'PAID_HOLD_EXPIRED');
  await confirmPaidReservation(f.event, f);
  assert.equal(f.state.events.at(-1).payload.version, 2);
  assert.equal(f.state.events.at(-1).payload.outcome, 'REJECTED');
});
test('a different payment ID cannot overwrite paid reservation identity', async () => {
  const f = fixture();
  await confirmPaidReservation(f.event, f);
  await confirmPaidReservation({ ...f.event, paymentId: randomUUID() }, f);
  assert.equal(f.row.paymentId, f.event.paymentId);
  assert.equal(f.row.status, 'PAID_HELD');
  assert.equal(f.state.events.at(-1).payload.outcome, 'REJECTED');
  assert.equal(f.state.writes, 1);
});
