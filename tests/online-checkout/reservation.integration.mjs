// Chỉ chạy trên PostgreSQL test đã có và đã migrate. Không tạo DB, không chạy Docker/migration.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root = fileURLToPath(new URL('../../', import.meta.url));
const inventoryRequire = createRequire(`${root}apps/inventory/package.json`);
const salesRequire = createRequire(`${root}apps/sales/package.json`);
const { PrismaPg } = inventoryRequire('@prisma/adapter-pg');
const { PrismaClient: InventoryClient } = inventoryRequire('./dist/generated/prisma/client.js');
const { PrismaClient: SalesClient } = salesRequire('./dist/generated/prisma/client.js');
const { reserveOnlineOrder, releaseOnlineOrder } = inventoryRequire(
  './dist/online/reservations.js',
);
const { ItemSalesService } = inventoryRequire('./dist/stock/item-sales.service.js');
const { OnlineOrdersService } = salesRequire('./dist/online/online-orders.service.js');
const { onStockReserved } = salesRequire('./dist/online/online-order-events.js');

function testUrl(name, schema) {
  const input = process.env[name];
  if (!input) throw new Error(`NOT VERIFIED: cần ${name}, không dùng DB dev mặc định`);
  const url = new URL(input);
  if (!/(^|_)test(_|$)/i.test(url.pathname.slice(1)) || url.searchParams.get('schema') !== schema)
    throw new Error(`Chỉ chấp nhận database test và schema ${schema}`);
  return input;
}
let inventory, sales;
try {
  inventory = new InventoryClient({
    adapter: new PrismaPg(
      { connectionString: testUrl('ONLINE_TEST_INVENTORY_URL', 'inventory'), max: 4 },
      { schema: 'inventory' },
    ),
  });
  sales = new SalesClient({
    adapter: new PrismaPg(
      { connectionString: testUrl('ONLINE_TEST_SALES_URL', 'sales'), max: 4 },
      { schema: 'sales' },
    ),
  });
  await inventory.stockReservation.count();
  await sales.onlineOrder.count();
} catch (error) {
  console.error(error.message);
  await inventory?.$disconnect();
  await sales?.$disconnect();
  process.exit(2);
}
async function fixture() {
  const suffix = randomUUID(),
    branchId = randomUUID();
  const category = await inventory.category.create({ data: { name: `online-test-${suffix}` } });
  const metal = await inventory.metal.create({
    data: { code: suffix, name: 'Test gold', kind: 'GOLD' },
  });
  await inventory.metalPrice.create({
    data: {
      metalId: metal.id,
      buyPrice: '1000000',
      sellPrice: '2000000',
      effectiveFrom: new Date(Date.now() - 1000),
      createdBy: randomUUID(),
    },
  });
  const product = await inventory.product.create({
    data: { categoryId: category.id, name: 'Test ring', publishedOnline: true },
  });
  const variant = await inventory.productVariant.create({
    data: { productId: product.id, metalId: metal.id, sku: suffix, name: '18K' },
  });
  const warehouse = await inventory.warehouse.create({
    data: { branchId, name: suffix, acceptsOnlineOrders: true },
  });
  const item = await inventory.jewelryItem.create({
    data: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      tagCode: suffix,
      weight: '1.25',
      laborFee: '100000',
      costPrice: '1000000',
    },
  });
  const ids = [];
  const request = () => {
    const orderId = randomUUID();
    ids.push(orderId);
    return {
      channel: 'WEBSITE',
      orderId,
      requestHash: 'a'.repeat(64),
      deadlineAt: new Date(Date.now() + 1800000).toISOString(),
      items: [{ variantId: variant.id, quantity: 1 }],
    };
  };
  const reserve = (req) =>
    inventory.$transaction((tx) => reserveOnlineOrder(tx, req), { timeout: 20000 });
  async function cleanup() {
    await sales.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await sales.onlineOrderItem.deleteMany({ where: { orderId: { in: ids } } });
    await sales.onlineOrder.deleteMany({ where: { id: { in: ids } } });
    await inventory.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    const reservations = await inventory.stockReservation.findMany({
      where: { orderId: { in: ids } },
      select: { id: true },
    });
    await inventory.stockReservationItem.deleteMany({
      where: { reservationId: { in: reservations.map((r) => r.id) } },
    });
    await inventory.stockReservation.deleteMany({ where: { orderId: { in: ids } } });
    await inventory.stockMovement.deleteMany({ where: { jewelryItemId: item.id } });
    await inventory.stockOrderOperation.deleteMany({ where: { orderId: { in: ids } } });
    await inventory.jewelryItem.delete({ where: { id: item.id } });
    await inventory.warehouse.delete({ where: { id: warehouse.id } });
    await inventory.productVariant.delete({ where: { id: variant.id } });
    await inventory.product.delete({ where: { id: product.id } });
    await inventory.metalPrice.deleteMany({ where: { metalId: metal.id } });
    await inventory.metal.delete({ where: { id: metal.id } });
    await inventory.category.delete({ where: { id: category.id } });
  }
  assert.equal(
    (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    'IN_STOCK',
  );
  assert.equal(
    await inventory.stockReservationItem.count({ where: { jewelryItemId: item.id } }),
    0,
  );
  return { ids, branchId, item, variant, request, reserve, cleanup };
}
try {
  await test('PostgreSQL: two online orders compete for one physical item, unique active hold and idempotent retry', async () => {
    const f = await fixture();
    try {
      const a = f.request(),
        b = f.request();
      await Promise.all([f.reserve(a), f.reserve(b)]);
      const rows = await inventory.stockReservation.findMany({ where: { orderId: { in: f.ids } } });
      assert.equal(rows.filter((r) => r.status === 'ACTIVE').length, 1);
      assert.equal(rows.filter((r) => r.status === 'FAILED').length, 1);
      const winner = rows.find((r) => r.status === 'ACTIVE');
      await f.reserve(winner.orderId === a.orderId ? a : b);
      assert.equal(
        await inventory.stockReservationItem.count({
          where: { jewelryItemId: f.item.id, isActive: true },
        }),
        1,
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('PostgreSQL: POS deduction versus online reservation cannot both win', async () => {
    const f = await fixture();
    try {
      const req = f.request(),
        posId = randomUUID();
      f.ids.push(posId);
      const results = await Promise.allSettled([
        f.reserve(req),
        new ItemSalesService(inventory).deductItemsForOrder({
          orderId: posId,
          branchId: f.branchId,
          tagCodes: [f.item.tagCode],
        }),
      ]);
      assert.equal(results[0].status, 'fulfilled');
      const item = await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } });
      const active = await inventory.stockReservation.count({
        where: { orderId: req.orderId, status: 'ACTIVE' },
      });
      assert.ok(
        (item.status === 'RESERVED' && active === 1 && results[1].status === 'rejected') ||
          (item.status === 'SOLD' && active === 0 && results[1].status === 'fulfilled'),
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('PostgreSQL: release before create, expiration retries and SOLD safeguard', async () => {
    const f = await fixture();
    try {
      const early = f.request();
      await inventory.$transaction((tx) => releaseOnlineOrder(tx, early.orderId, 'RELEASED'));
      await f.reserve(early);
      assert.equal(
        (await inventory.stockReservation.findUniqueOrThrow({ where: { orderId: early.orderId } }))
          .status,
        'RELEASED',
      );
      const req = f.request();
      await f.reserve(req);
      await inventory.stockReservation.update({
        where: { orderId: req.orderId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await Promise.all([
        inventory.$transaction((tx) => releaseOnlineOrder(tx, req.orderId, 'EXPIRED')),
        inventory.$transaction((tx) => releaseOnlineOrder(tx, req.orderId, 'RELEASED')),
      ]);
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'IN_STOCK',
      );
      await f.reserve(req);
      assert.notEqual(
        (await inventory.stockReservation.findUniqueOrThrow({ where: { orderId: req.orderId } }))
          .status,
        'ACTIVE',
      );
      const sold = f.request();
      await f.reserve(sold);
      await inventory.jewelryItem.update({
        where: { id: f.item.id },
        data: {
          status: 'SOLD',
          orderId: sold.orderId,
          soldAt: new Date(),
          metalPriceAtSale: '2000000',
          priceAtSale: '2600000',
        },
      });
      await inventory.$transaction((tx) => releaseOnlineOrder(tx, sold.orderId, 'RELEASED'));
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'SOLD',
      );
      assert.equal(
        (await inventory.stockReservation.findUniqueOrThrow({ where: { orderId: sold.orderId } }))
          .status,
        'PAYMENT_REVIEW',
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('PostgreSQL: concurrent checkout same key, outbox handoff, Inventory price and no paid event', async () => {
    const f = await fixture();
    try {
      const service = new OnlineOrdersService(sales),
        token = `Checkout ${randomBytes(32).toString('hex')}`;
      const body = {
        items: [{ variantId: f.variant.id, quantity: 1 }],
        recipientName: 'Test guest',
        recipientPhone: '+84901234567',
        shippingAddress: '123 Test address',
      };
      const create = () =>
        service.create(token, 'checkout-test', body).then((view) => {
          f.ids.push(view.id);
          return view;
        });
      const [a, b] = await Promise.all([create(), create()]);
      f.ids.push(a.id);
      assert.equal(a.id, b.id);
      const created = await sales.outboxEvent.findFirstOrThrow({
        where: { aggregateId: a.id, eventType: 'order.created' },
      });
      await f.reserve(created.payload);
      const event = await inventory.outboxEvent.findFirstOrThrow({
        where: { aggregateId: a.id, eventType: 'stock.reserved' },
      });
      await sales.$transaction((tx) => onStockReserved(event.payload, { tx }));
      const view = await service.get(token, a.id);
      assert.equal(view.status, 'AWAITING_PAYMENT');
      assert.equal(view.total, '2600000.00');
      assert.equal(
        await sales.outboxEvent.count({ where: { aggregateId: a.id, eventType: 'order.paid' } }),
        0,
      );
      await assert.rejects(
        service.get(`Checkout ${randomBytes(32).toString('hex')}`, a.id),
        (e) => e.code === 'NOT_FOUND',
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('6.5B DB-09: reservation failure rolls back item, hold and outbox together', async () => {
    const f = await fixture();
    try {
      const req = f.request();
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'IN_STOCK',
      );
      assert.equal(await inventory.stockReservation.count({ where: { orderId: req.orderId } }), 0);
      assert.equal(await inventory.outboxEvent.count({ where: { aggregateId: req.orderId } }), 0);
      await assert.rejects(
        inventory.$transaction(async (tx) => {
          await reserveOnlineOrder(tx, req);
          assert.equal(
            await tx.stockReservation.count({ where: { orderId: req.orderId, status: 'ACTIVE' } }),
            1,
          );
          assert.equal(await tx.outboxEvent.count({ where: { aggregateId: req.orderId } }), 1);
          throw new Error('PH6 injected transaction failure');
        }),
        /PH6 injected transaction failure/,
      );
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'IN_STOCK',
      );
      assert.equal(await inventory.stockReservation.count({ where: { orderId: req.orderId } }), 0);
      assert.equal(
        await inventory.stockReservationItem.count({ where: { jewelryItemId: f.item.id } }),
        0,
      );
      assert.equal(await inventory.outboxEvent.count({ where: { aggregateId: req.orderId } }), 0);
      await f.reserve(req);
      assert.equal(
        await inventory.stockReservation.count({
          where: { orderId: req.orderId, status: 'ACTIVE' },
        }),
        1,
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('6.5B DB-04/05: lost checkout result retry and different keys cannot double reserve', async () => {
    const f = await fixture();
    try {
      const service = new OnlineOrdersService(sales);
      const token = `Checkout ${randomBytes(32).toString('hex')}`;
      const body = {
        items: [{ variantId: f.variant.id, quantity: 1 }],
        recipientName: 'Test',
        recipientPhone: '0901234567',
        shippingAddress: 'Test isolated address',
      };
      assert.equal(
        await sales.onlineOrder.count({ where: { requestedItems: { equals: body.items } } }),
        0,
      );
      const first = await service.create(token, 'lost-result', body);
      f.ids.push(first.id); // Simulate response loss after DB commit; client retries identical identity.
      const retried = await service.create(token, 'lost-result', body);
      assert.equal(retried.id, first.id);
      assert.equal(
        await sales.outboxEvent.count({
          where: { aggregateId: first.id, eventType: 'order.created' },
        }),
        1,
      );
      const second = await service.create(token, 'different-key', body);
      f.ids.push(second.id);
      const events = await sales.outboxEvent.findMany({
        where: { aggregateId: { in: f.ids }, eventType: 'order.created' },
      });
      await Promise.all(events.map((e) => f.reserve(e.payload)));
      assert.equal(
        await inventory.stockReservation.count({
          where: { orderId: { in: f.ids }, status: 'ACTIVE' },
        }),
        1,
      );
      assert.equal(
        await inventory.stockReservation.count({
          where: { orderId: { in: f.ids }, status: 'FAILED' },
        }),
        1,
      );
      assert.equal(
        await inventory.stockReservationItem.count({
          where: { jewelryItemId: f.item.id, isActive: true },
        }),
        1,
      );
    } finally {
      await f.cleanup();
    }
  });
} finally {
  await inventory.$disconnect();
  await sales.$disconnect();
}
