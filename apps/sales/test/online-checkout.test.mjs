import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import {
  OnlineOrdersService,
  checkoutAccessHash,
  checkoutRequestHash,
} from '../dist/online/online-orders.service.js';
import {
  onStockReserved,
  onStockReserveFailed,
  onStockReservationExpired,
  validateReservedCart,
} from '../dist/online/online-order-events.js';
import { OnlineRecoveryWorker } from '../dist/online/online-recovery.worker.js';
import {
  createOnlineOrderSchema,
  onlineCartSchema,
  canonicalCart,
  EVENT_PAYLOAD_SCHEMAS,
  posOrderEventPayloadSchema,
} from '@jewelry/contracts';
const variantId = randomUUID();
const authorization = `Checkout ${randomBytes(32).toString('hex')}`;
const body = () => ({
  items: [{ variantId, quantity: 1 }],
  recipientName: 'Khách',
  recipientPhone: '+84901234567',
  shippingAddress: '123 Đường A, TP HCM',
});
function fixture() {
  const rows = new Map(),
    events = [];
  const unique = () => ({
    code: 'P2002',
    meta: {
      driverAdapterError: {
        cause: { constraint: { index: 'OnlineOrder_accessHash_idempotencyKey_key' } },
      },
    },
  });
  const find = (where) =>
    [...rows.values()].find((row) =>
      Object.entries(where).every(([key, value]) =>
        key === 'accessHash_idempotencyKey'
          ? row.accessHash === value.accessHash && row.idempotencyKey === value.idempotencyKey
          : row[key] === value,
      ),
    );
  const tx = {
    $queryRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('clock_timestamp')) return [{ now: new Date() }];
      if (sql.includes('FOR UPDATE')) {
        const row = rows.get(values[0]);
        return row && (values[1] === undefined || values[1] === row.accessHash)
          ? [{ id: row.id }]
          : [];
      }
      throw new Error(sql);
    },
    onlineOrder: {
      create: async ({ data }) => {
        if (
          [...rows.values()].some(
            (r) => r.accessHash === data.accessHash && r.idempotencyKey === data.idempotencyKey,
          )
        )
          throw unique();
        const row = {
          status: 'PENDING',
          items: [],
          total: null,
          expiresAt: null,
          reservationId: null,
          failureCode: null,
          needsReview: false,
          ...data,
        };
        rows.set(row.id, row);
        return row;
      },
      findUniqueOrThrow: async ({ where }) => {
        const row = find(where);
        if (!row) throw new Error('missing');
        return row;
      },
      findUnique: async ({ where }) => find(where) ?? null,
      findFirst: async ({ where }) => find(where) ?? null,
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.id);
        if (!row || !where.status.in.includes(row.status)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      update: async ({ where, data }) => {
        const row = rows.get(where.id),
          { items, ...rest } = data;
        Object.assign(row, rest);
        if (rest.total !== undefined) row.total = new Decimal(rest.total);
        if (items)
          row.items = items.create.map((item) => ({
            ...item,
            id: randomUUID(),
            price: new Decimal(item.price),
          }));
        return row;
      },
    },
    outboxEvent: {
      create: async ({ data }) => {
        events.push(data);
      },
    },
  };
  return {
    tx,
    rows,
    events,
    service: new OnlineOrdersService({ ...tx, $transaction: async (cb) => cb(tx) }),
  };
}
function reserved(orderId) {
  return {
    channel: 'WEBSITE',
    orderId,
    reservationId: randomUUID(),
    warehouseId: randomUUID(),
    branchId: randomUUID(),
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    total: '1000.00',
    items: [
      { jewelryItemId: randomUUID(), variantId, sku: 'R1', productName: 'Nhẫn', price: '1000.00' },
    ],
  };
}
test('client cart validates IDs, quantities, unique variants, recipient and refuses frontend prices', () => {
  assert.equal(createOnlineOrderSchema.safeParse(body()).success, true);
  const items = [{ variantId, quantity: 1 }];
  for (const invalid of [
    [],
    [{ variantId: 'x', quantity: 1 }],
    [{ variantId, quantity: 0 }],
    [{ variantId, quantity: 1.5 }],
    [{ variantId, quantity: 11 }],
    [...items, ...items],
    Array.from({ length: 6 }, () => ({ variantId: randomUUID(), quantity: 10 })),
  ])
    assert.equal(onlineCartSchema.safeParse(invalid).success, false);
  for (const extra of [
    { total: '1' },
    { discount: 100 },
    { status: 'COMPLETED' },
    { items: [{ variantId, quantity: 1, price: '1' }] },
    { recipientPhone: 'bad' },
    { shippingAddress: '' },
  ])
    assert.equal(createOnlineOrderSchema.safeParse({ ...body(), ...extra }).success, false);
  const second = randomUUID();
  assert.deepEqual(
    canonicalCart([{ variantId: second, quantity: 2 }, ...items]),
    canonicalCart([...items, { variantId: second, quantity: 2 }]),
  );
  assert.equal(
    checkoutRequestHash(body()),
    checkoutRequestHash({ ...body(), recipientName: ' Khách ' }),
  );
});
test('creation durably records PENDING and outbox before any reservation; never emits order.paid', async () => {
  const f = fixture(),
    view = await f.service.create(authorization, 'key1', body());
  assert.equal(view.status, 'PENDING');
  assert.equal(view.total, null);
  assert.deepEqual(view.items, []);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].eventType, 'order.created');
  assert.equal(f.events[0].payload.channel, 'WEBSITE');
  const raw = JSON.stringify(f.events[0].payload);
  for (const privateField of [
    'recipientName',
    'recipientPhone',
    'shippingAddress',
    'authorization',
    'accessHash',
  ])
    assert.equal(raw.includes(privateField), false);
});
test('same key replay and lost response return same ID; changed body returns 422', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key1', body());
  assert.equal((await f.service.create(authorization, 'key1', body())).id, first.id);
  assert.equal((await f.service.byKey(authorization, 'key1')).id, first.id);
  assert.equal(f.events.length, 1);
  assert.equal(f.rows.size, 1);
  await assert.rejects(
    f.service.create(authorization, 'key1', { ...body(), recipientName: 'Người khác' }),
    (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});
test('private capability: other tokens cannot read or cancel, no recipient/internal data in response', async () => {
  const f = fixture(),
    view = await f.service.create(authorization, 'key1', body());
  const stranger = `Checkout ${randomBytes(32).toString('hex')}`;
  await assert.rejects(f.service.get(stranger, view.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(f.service.cancel(stranger, view.id), (e) => e.code === 'NOT_FOUND');
  assert.equal(f.rows.get(view.id).status, 'PENDING');
  assert.notEqual(checkoutAccessHash(authorization), authorization);
  for (const field of [
    'recipientName',
    'shippingAddress',
    'recipientPhone',
    'accessHash',
    'idempotencyKey',
    'requestHash',
  ])
    assert.equal(field in view, false);
  assert.throws(() => checkoutAccessHash('Bearer wrong'));
});
test('valid stock.reserved alone moves to AWAITING_PAYMENT using Inventory amount; duplicate does not duplicate lines', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key', body()),
    event = reserved(first.id);
  await onStockReserved(event, f);
  await onStockReserved(event, f);
  const view = await f.service.get(authorization, first.id);
  assert.equal(view.status, 'AWAITING_PAYMENT');
  assert.equal(view.total, '1000.00');
  assert.equal(view.items.length, 1);
  assert.equal(
    f.events.some((e) => e.eventType === 'order.paid'),
    false,
  );
  const before = f.events.length;
  await onStockReserveFailed(
    { channel: 'WEBSITE', orderId: first.id, code: 'ITEM_NOT_AVAILABLE' },
    f,
  );
  assert.equal(f.rows.get(first.id).status, 'AWAITING_PAYMENT');
  assert.equal(f.events.length, before);
});
test('reservation with wrong cart or amount fails before sales state changes', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key', body()),
    event = reserved(first.id);
  assert.throws(
    () => validateReservedCart(body().items, { ...event, total: '1.00' }),
    /Tổng reservation/,
  );
  await assert.rejects(
    onStockReserved({ ...event, items: [{ ...event.items[0], variantId: randomUUID() }] }, f),
    /khớp giỏ hàng/,
  );
  assert.equal(f.rows.get(first.id).status, 'PENDING');
});
test('expired reservation, expiry event before success, or cancel before reserve cannot resurrect an order', async () => {
  for (const mode of ['past', 'expiry-first', 'cancel-first']) {
    const f = fixture(),
      first = await f.service.create(authorization, 'key', body()),
      event = reserved(first.id);
    if (mode === 'past') event.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mode === 'expiry-first')
      await onStockReservationExpired(
        { channel: 'WEBSITE', orderId: first.id, reservationId: event.reservationId },
        f,
      );
    if (mode === 'cancel-first') await f.service.cancel(authorization, first.id);
    await onStockReserved(event, f);
    assert.equal(f.rows.get(first.id).status, 'CANCELLED');
    assert.equal(f.rows.get(first.id).items.length, 0);
    assert.ok(f.events.some((e) => e.eventType === 'order.cancelled'));
  }
});
test('cancel and reserve failure are idempotent; never enter POS completed/payment states', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key', body());
  await onStockReserveFailed(
    { channel: 'WEBSITE', orderId: first.id, code: 'ITEM_NOT_AVAILABLE' },
    f,
  );
  await f.service.cancel(authorization, first.id);
  await f.service.cancel(authorization, first.id);
  assert.equal(f.events.filter((e) => e.eventType === 'order.cancelled').length, 1);
  assert.equal(f.rows.get(first.id).status, 'CANCELLED');
});
test('pending recovery marks review at 10 minutes and re-emits same business ID without new order', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key', body());
  let due = true;
  const actualQuery = f.tx.$queryRaw;
  f.tx.$queryRaw = async (strings, ...values) => {
    const sql = strings.join('?');
    if (sql.includes('SKIP LOCKED')) {
      assert.match(sql, /LIMIT 1 FOR UPDATE SKIP LOCKED/);
      if (due) {
        due = false;
        return [{ id: first.id }];
      }
      return [];
    }
    return actualQuery(strings, ...values);
  };
  const worker = new OnlineRecoveryWorker({ $transaction: async (cb) => cb(f.tx) });
  await worker.scan();
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get(first.id).needsReview, true);
  assert.equal(f.events.filter((e) => e.eventType === 'order.created').length, 2);
  assert.ok(f.events.every((e) => e.payload.orderId === first.id));
});
test('recovery cancels PENDING after 30 minutes and survives a DB interruption for next scan', async () => {
  const f = fixture(),
    first = await f.service.create(authorization, 'key', body());
  f.rows.get(first.id).deadlineAt = new Date(Date.now() - 1);
  let due = true,
    interrupted = true;
  const actualQuery = f.tx.$queryRaw;
  f.tx.$queryRaw = async (strings, ...values) =>
    strings.join('?').includes('SKIP LOCKED')
      ? due
        ? ((due = false), [{ id: first.id }])
        : []
      : actualQuery(strings, ...values);
  const worker = new OnlineRecoveryWorker({
    $transaction: async (cb) => {
      if (interrupted) {
        interrupted = false;
        throw new Error('offline');
      }
      return cb(f.tx);
    },
  });
  await worker.scan();
  await worker.scan();
  assert.equal(f.rows.get(first.id).status, 'CANCELLED');
  assert.equal(f.events.at(-1).eventType, 'order.cancelled');
});
test('Phase 5 POS contracts are still accepted unchanged alongside WEBSITE created/cancelled', () => {
  const pos = {
    channel: 'POS',
    orderId: randomUUID(),
    branchId: randomUUID(),
    code: 'POS1',
    total: '1000.00',
    tagCodes: ['T1'],
  };
  assert.equal(posOrderEventPayloadSchema.safeParse(pos).success, true);
  assert.equal(EVENT_PAYLOAD_SCHEMAS['order.created'].safeParse(pos).success, true);
  assert.equal(EVENT_PAYLOAD_SCHEMAS['order.cancelled'].safeParse(pos).success, true);
  assert.equal(
    EVENT_PAYLOAD_SCHEMAS['order.cancelled'].safeParse({
      channel: 'WEBSITE',
      orderId: randomUUID(),
    }).success,
    true,
  );
});
