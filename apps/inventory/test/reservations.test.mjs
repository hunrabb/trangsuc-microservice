import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import { reserveOnlineOrder, releaseOnlineOrder } from '../dist/online/reservations.js';
import { ReservationExpiryWorker } from '../dist/online/reservation-expiry.worker.js';
import { InventoryCloseWorker } from '../dist/stock/inventory-close.worker.js';
const variantId = randomUUID(),
  itemId = randomUUID(),
  warehouseId = randomUUID(),
  branchId = randomUUID();
function request() {
  return {
    channel: 'WEBSITE',
    orderId: randomUUID(),
    requestHash: 'a'.repeat(64),
    items: [{ variantId, quantity: 1 }],
    deadlineAt: new Date(Date.now() + 1800000).toISOString(),
  };
}
function fixture(options = {}) {
  let header;
  const state = {
    status: options.status ?? 'IN_STOCK',
    writes: 0,
    price: new Decimal(2000000),
    events: [],
    now: new Date(),
    published: options.published ?? true,
  };
  const tx = {
    $executeRaw: async (strings, ...values) => {
      const sql = strings.join('?');
      if (sql.includes('INSERT INTO'))
        header ??= {
          id: values[0],
          orderId: values[1],
          status: sql.includes("'FAILED'") ? 'FAILED' : 'RELEASED',
          requestHash: sql.includes("'FAILED'") ? values[2] : null,
          total: new Decimal(0),
          failureCode: null,
          warehouseId: null,
          branchId: null,
          expiresAt: null,
          items: [],
        };
      return 1;
    },
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join('?') : strings.sql;
      if (sql.includes('clock_timestamp')) return [{ now: state.now }];
      if (sql.includes('FROM "inventory"."StockReservation"')) {
        assert.match(sql, /FOR UPDATE/);
        return [{ id: header.id }];
      }
      if (sql.includes('WITH needed')) {
        assert.match(sql, /bool_and\(available >= quantity\)/);
        assert.match(sql, /ORDER BY sum\(available\) DESC/);
        return [{ warehouseId, branchId }];
      }
      if (sql.includes('FROM "inventory"."Warehouse"')) {
        assert.match(sql, /"acceptsOnlineOrders" FOR UPDATE/);
        return [{ id: warehouseId }];
      }
      if (sql.includes('FROM "inventory"."ProductVariant"')) {
        assert.match(sql, /p\."publishedOnline"/);
        return state.published ? [{ metalId: variantId, sku: 'R1', productName: 'Ring' }] : [];
      }
      if (sql.includes('FROM "inventory"."MetalPrice"'))
        return options.noPrice ? [] : [{ sellPrice: state.price }];
      if (sql.includes('WITH locked')) {
        assert.match(sql, /status = 'IN_STOCK'/);
        assert.match(sql, /FOR UPDATE SKIP LOCKED/);
        assert.equal(values[2], 1 + (options.buffer ?? 0));
        return state.status === 'IN_STOCK' ? [{ id: itemId, available: 1n }] : [];
      }
      if (sql.includes('SELECT id,status')) {
        assert.match(sql, /ORDER BY id FOR UPDATE/);
        return [{ id: itemId, status: state.status }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    stockReservation: {
      findUniqueOrThrow: async () => ({ ...header, items: [...header.items] }),
      update: async ({ data }) => {
        const { items, ...rest } = data;
        Object.assign(header, rest);
        if (items)
          header.items = items.create.map((i) => ({
            ...i,
            price: new Decimal(i.price),
            isActive: true,
          }));
        return { ...header };
      },
    },
    stockReservationItem: {
      updateMany: async ({ where, data }) => {
        assert.equal(where.isActive, true);
        header.items = header.items.map((i) => ({ ...i, ...data }));
        return { count: header.items.length };
      },
    },
    onlineStockBuffer: { findUnique: async () => ({ quantity: options.buffer ?? 0 }) },
    jewelryItem: {
      findMany: async () => [
        { id: itemId, weight: new Decimal('1.25'), laborFee: new Decimal('100000') },
      ],
      updateMany: async ({ where, data }) => {
        state.writes++;
        assert.ok(['IN_STOCK', 'RESERVED'].includes(where.status));
        if (options.conditionalConflict || where.status !== state.status) return { count: 0 };
        state.status = data.status;
        return { count: 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }) => {
        state.events.push(data);
      },
    },
  };
  return { tx, state, header: () => header };
}
test('reserve chooses eligible warehouse, locks exact pieces and prices only in Inventory', async () => {
  const f = fixture(),
    req = request();
  await reserveOnlineOrder(f.tx, req);
  assert.equal(f.state.status, 'RESERVED');
  assert.equal(f.header().status, 'ACTIVE');
  assert.equal(f.state.events[0].eventType, 'stock.reserved');
  assert.equal(f.state.events[0].payload.total, '2600000.00');
  assert.ok(f.header().expiresAt <= new Date(req.deadlineAt));
});
test('duplicate/new event ID or retry after lost acknowledgement replays locked snapshot once', async () => {
  const f = fixture(),
    req = request();
  await reserveOnlineOrder(f.tx, req);
  f.state.price = new Decimal(9999999);
  await reserveOnlineOrder(f.tx, req);
  assert.equal(f.state.writes, 1);
  assert.equal(f.state.events.length, 2);
  assert.deepEqual(f.state.events[1].payload, f.state.events[0].payload);
  await assert.rejects(
    reserveOnlineOrder(f.tx, { ...req, requestHash: 'b'.repeat(64) }),
    /tái sử dụng/,
  );
});
test('POS owns/locks item or online buffer exhausts availability: reservation does not mutate stock', async () => {
  for (const options of [
    { status: 'SOLD' },
    { status: 'RESERVED' },
    { buffer: 1 },
    { published: false },
    { noPrice: true },
  ]) {
    const f = fixture(options);
    await reserveOnlineOrder(f.tx, request());
    assert.equal(f.state.writes, 0);
    assert.equal(f.header().status, 'FAILED');
    assert.equal(f.state.events[0].eventType, 'stock.reserve_failed');
  }
});
test('conditional write conflict aborts instead of emitting a successful reservation', async () => {
  const f = fixture({ conditionalConflict: true });
  await assert.rejects(reserveOnlineOrder(f.tx, request()), /Conditional reservation update/);
  assert.equal(f.state.events.length, 0);
});
test('cancel before create leaves durable tombstone and blocks delayed reserve', async () => {
  const f = fixture(),
    req = request();
  await releaseOnlineOrder(f.tx, req.orderId, 'RELEASED');
  await reserveOnlineOrder(f.tx, req);
  assert.equal(f.header().status, 'RELEASED');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.events[0].payload.code, 'RESERVATION_RELEASED');
});
test('expired request cannot reserve or continue to sell', async () => {
  const f = fixture(),
    req = request();
  await reserveOnlineOrder(f.tx, {
    ...req,
    deadlineAt: new Date(f.state.now.getTime() - 1).toISOString(),
  });
  assert.equal(f.header().status, 'EXPIRED');
  assert.equal(f.state.writes, 0);
  assert.equal(f.state.events[0].payload.code, 'RESERVATION_EXPIRED');
});
test('expiry keeps live hold, releases due hold once, and cannot resurrect expired order', async () => {
  const f = fixture(),
    req = request();
  await reserveOnlineOrder(f.tx, req);
  await releaseOnlineOrder(f.tx, req.orderId, 'EXPIRED');
  assert.equal(f.state.writes, 1);
  f.state.now = new Date(Date.now() + 1800001);
  await releaseOnlineOrder(f.tx, req.orderId, 'EXPIRED');
  await releaseOnlineOrder(f.tx, req.orderId, 'RELEASED');
  assert.equal(f.state.status, 'IN_STOCK');
  assert.equal(f.header().status, 'EXPIRED');
  assert.equal(f.state.writes, 2);
  assert.equal(f.header().items[0].isActive, false);
  await reserveOnlineOrder(f.tx, req);
  assert.equal(f.state.writes, 2);
  assert.equal(f.state.events.at(-1).payload.code, 'RESERVATION_EXPIRED');
});
test('release never frees SOLD or uncertain payment/consumed stock', async () => {
  const f = fixture(),
    req = request();
  await reserveOnlineOrder(f.tx, req);
  f.state.status = 'SOLD';
  await releaseOnlineOrder(f.tx, req.orderId, 'RELEASED');
  assert.equal(f.header().status, 'PAYMENT_REVIEW');
  assert.equal(f.state.status, 'SOLD');
  assert.equal(f.state.writes, 1);
  await releaseOnlineOrder(f.tx, req.orderId, 'EXPIRED');
  assert.equal(f.state.writes, 1);
});
test('expiry worker locks bounded due rows and retries after transient failure on next scan', async () => {
  let calls = 0;
  const worker = new ReservationExpiryWorker({
    $transaction: async (cb) => {
      calls++;
      if (calls === 1) throw new Error('connection lost');
      return cb({
        $queryRaw: async (strings) => {
          const sql = strings.join('?');
          assert.match(sql, /status = 'ACTIVE'/);
          assert.match(sql, /FOR UPDATE SKIP LOCKED/);
          return [];
        },
      });
    },
  });
  await worker.scan();
  await worker.scan();
  assert.equal(calls, 2);
});
test('daily physical inventory snapshot includes RESERVED without creating false sales/returns', async () => {
  const worker = new InventoryCloseWorker({});
  await worker.snapshotRows(
    {
      $queryRaw: async (sql) => {
        assert.match(sql.sql, /"status" IN \('IN_STOCK', 'RESERVED'\)/);
        return [];
      },
    },
    warehouseId,
    null,
    new Date(),
  );
});
