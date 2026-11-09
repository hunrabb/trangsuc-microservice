// Môi trường PostgreSQL test có sẵn; không tạo DB/chạy migrations/Docker hoặc dùng dev fallback.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
const inventoryRequire = createRequire(
  new URL('../../apps/inventory/package.json', import.meta.url),
);
const salesRequire = createRequire(new URL('../../apps/sales/package.json', import.meta.url));
const { PrismaPg } = salesRequire('@prisma/adapter-pg');
const { PrismaClient: InventoryClient } = inventoryRequire('./dist/generated/prisma/client.js');
const { PrismaClient: SalesClient } = salesRequire('./dist/generated/prisma/client.js');
const { OnlinePaymentsService } = salesRequire('./dist/payments/online-payments.service.js');
const { onPaymentInventoryResult } = salesRequire('./dist/payments/payment-inventory-events.js');
const { confirmPaidReservation } = inventoryRequire('./dist/online/payment-events.js');
const { releaseOnlineOrder } = inventoryRequire('./dist/online/reservations.js');
function url(name, schema) {
  if (!process.env[name]) throw new Error(`NOT VERIFIED: cần ${name}; không dùng DB dev`);
  const parsed = new URL(process.env[name]);
  if (
    !/(^|_)test(_|$)/i.test(parsed.pathname.slice(1)) ||
    parsed.searchParams.get('schema') !== schema
  )
    throw new Error('Chỉ cho phép database test/schema service tương ứng');
  return process.env[name];
}
let inventory, sales;
try {
  inventory = new InventoryClient({
    adapter: new PrismaPg(
      { connectionString: url('PAYMENT_TEST_INVENTORY_URL', 'inventory'), max: 4 },
      { schema: 'inventory' },
    ),
  });
  sales = new SalesClient({
    adapter: new PrismaPg(
      { connectionString: url('PAYMENT_TEST_SALES_URL', 'sales'), max: 4 },
      { schema: 'sales' },
    ),
  });
  await sales.onlinePayment.count();
  await inventory.stockReservation.findFirst({ select: { paymentVersion: true } });
} catch (error) {
  console.error(error.message);
  await inventory?.$disconnect();
  await sales?.$disconnect();
  process.exit(2);
}
async function fixture() {
  const orderId = randomUUID(),
    branchId = randomUUID(),
    reservationId = randomUUID(),
    label = randomUUID();
  const category = await inventory.category.create({ data: { name: `payment-test-${label}` } });
  const metal = await inventory.metal.create({ data: { code: label, name: 'test', kind: 'GOLD' } });
  const product = await inventory.product.create({
    data: { categoryId: category.id, name: 'test', publishedOnline: true },
  });
  const variant = await inventory.productVariant.create({
    data: { productId: product.id, metalId: metal.id, sku: label, name: 'test' },
  });
  const warehouse = await inventory.warehouse.create({
    data: { branchId, name: 'test', acceptsOnlineOrders: true },
  });
  const item = await inventory.jewelryItem.create({
    data: {
      variantId: variant.id,
      warehouseId: warehouse.id,
      tagCode: label,
      weight: '1',
      laborFee: '0',
      costPrice: '1000',
      status: 'RESERVED',
    },
  });
  const expiresAt = new Date(Date.now() + 1800000);
  await inventory.stockReservation.create({
    data: {
      id: reservationId,
      orderId,
      status: 'ACTIVE',
      total: '1000',
      expiresAt,
      warehouseId: warehouse.id,
      branchId,
      items: {
        create: {
          jewelryItemId: item.id,
          variantId: variant.id,
          productName: 'test',
          sku: label,
          price: '1000',
        },
      },
    },
  });
  await sales.onlineOrder.create({
    data: {
      id: orderId,
      code: `TEST${label}`,
      status: 'AWAITING_PAYMENT',
      total: '1000',
      reservationId,
      branchId,
      warehouseId: warehouse.id,
      accessHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      idempotencyKey: label,
      requestedItems: [{ variantId: variant.id, quantity: 1 }],
      recipientName: 'Test',
      recipientPhone: '+84901234567',
      shippingAddress: 'Test address',
      expiresAt,
      deadlineAt: expiresAt,
      recoveryAfter: expiresAt,
    },
  });
  const actor = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId }] };
  const service = new OnlinePaymentsService(sales);
  const body = {
    bankTxnRef: `TEST/ACCOUNT/${label}`,
    evidenceRef: `TEST/statement/${label}`,
    amount: '1000.00',
    currency: 'VND',
  };
  const confirm = () => service.confirm(actor, branchId, orderId, `confirm-${label}`, body);
  const paidEvent = async () =>
    (
      await sales.outboxEvent.findFirstOrThrow({
        where: { aggregateId: orderId, eventType: 'order.paid' },
      })
    ).payload;
  async function cleanup() {
    const payments = await sales.onlinePayment.findMany({
      where: { orderId },
      select: { id: true },
    });
    await sales.onlinePaymentAudit.deleteMany({ where: { orderId } });
    await sales.onlinePaymentRequest.deleteMany({
      where: { paymentId: { in: payments.map((p) => p.id) } },
    });
    await sales.onlinePayment.deleteMany({ where: { orderId } });
    await sales.outboxEvent.deleteMany({ where: { aggregateId: orderId } });
    await sales.onlineOrder.delete({ where: { id: orderId } });
    await inventory.outboxEvent.deleteMany({ where: { aggregateId: orderId } });
    await inventory.stockReservationItem.deleteMany({ where: { reservationId } });
    await inventory.stockReservation.delete({ where: { id: reservationId } });
    await inventory.jewelryItem.delete({ where: { id: item.id } });
    await inventory.warehouse.delete({ where: { id: warehouse.id } });
    await inventory.productVariant.delete({ where: { id: variant.id } });
    await inventory.product.delete({ where: { id: product.id } });
    await inventory.metal.delete({ where: { id: metal.id } });
    await inventory.category.delete({ where: { id: category.id } });
  }
  assert.equal(
    (await inventory.stockReservation.findUniqueOrThrow({ where: { id: reservationId } })).status,
    'ACTIVE',
  );
  assert.equal(
    (await sales.onlineOrder.findUniqueOrThrow({ where: { id: orderId } })).status,
    'AWAITING_PAYMENT',
  );
  assert.equal(await sales.onlinePayment.count({ where: { orderId } }), 0);
  assert.equal(await sales.onlinePaymentAudit.count({ where: { orderId } }), 0);
  assert.equal(await sales.outboxEvent.count({ where: { aggregateId: orderId } }), 0);
  return {
    orderId,
    branchId,
    reservationId,
    item,
    actor,
    service,
    body,
    confirm,
    paidEvent,
    cleanup,
  };
}
try {
  await test('PostgreSQL: duplicate receipt, Inventory acknowledgement and refund/callback contention are idempotent', async () => {
    const f = await fixture();
    try {
      const [a, b] = await Promise.all([f.confirm(), f.confirm()]);
      assert.equal(a.id, b.id);
      assert.equal(await sales.onlinePayment.count({ where: { orderId: f.orderId } }), 1);
      assert.equal(
        await sales.outboxEvent.count({
          where: { aggregateId: f.orderId, eventType: 'order.paid' },
        }),
        1,
      );
      const event = await f.paidEvent();
      await inventory.$transaction((tx) => confirmPaidReservation(event, { tx }));
      await inventory.$transaction((tx) => confirmPaidReservation(event, { tx }));
      const ack = (
        await inventory.outboxEvent.findFirstOrThrow({
          where: { aggregateId: f.orderId, eventType: 'stock.payment_result' },
        })
      ).payload;
      await Promise.all([
        sales.$transaction((tx) => onPaymentInventoryResult(ack, { tx })),
        f.service.requestRefund(
          f.actor,
          f.branchId,
          f.orderId,
          a.id,
          'Test verified refund request',
        ),
      ]);
      const order = await sales.onlineOrder.findUniqueOrThrow({ where: { id: f.orderId } });
      assert.equal(order.status, 'REFUND_PENDING');
      assert.equal(
        (await sales.onlinePayment.findUniqueOrThrow({ where: { id: a.id } })).status,
        'REFUND_PENDING',
      );
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'RESERVED',
      );
      assert.equal(
        (await inventory.stockReservation.findUniqueOrThrow({ where: { id: f.reservationId } }))
          .status,
        'PAID_HELD',
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('PostgreSQL: expired reservation versus paid event never sells a replacement or drops received money', async () => {
    const f = await fixture();
    try {
      const payment = await f.confirm(),
        event = await f.paidEvent();
      await inventory.stockReservation.update({
        where: { id: f.reservationId },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await Promise.all([
        inventory.$transaction((tx) => releaseOnlineOrder(tx, f.orderId, 'EXPIRED')),
        inventory.$transaction((tx) => confirmPaidReservation(event, { tx })),
      ]);
      const ack = (
        await inventory.outboxEvent.findFirstOrThrow({
          where: { aggregateId: f.orderId, eventType: 'stock.payment_result' },
        })
      ).payload;
      assert.equal(ack.outcome, 'REJECTED');
      await sales.$transaction((tx) => onPaymentInventoryResult(ack, { tx }));
      assert.equal(
        (await sales.onlineOrder.findUniqueOrThrow({ where: { id: f.orderId } })).status,
        'PAYMENT_REVIEW',
      );
      assert.equal(
        (await sales.onlinePayment.findUniqueOrThrow({ where: { id: payment.id } })).status,
        'RECONCILIATION_REQUIRED',
      );
      assert.notEqual(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'SOLD',
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('6.5B DB-08: same bank reference cannot pay two different orders', async () => {
    const f = await fixture();
    const secondId = randomUUID();
    try {
      const original = await sales.onlineOrder.findUniqueOrThrow({ where: { id: f.orderId } });
      await sales.onlineOrder.create({
        data: {
          ...original,
          id: secondId,
          code: `TEST${secondId}`,
          accessHash: secondId,
          idempotencyKey: secondId,
        },
      });
      assert.equal(
        await sales.onlinePayment.count({ where: { orderId: { in: [f.orderId, secondId] } } }),
        0,
      );
      const result = await Promise.allSettled([
        f.confirm(),
        f.service.confirm(f.actor, f.branchId, secondId, secondId, f.body),
      ]);
      assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(
        result.find((r) => r.status === 'rejected').reason.code,
        'PAYMENT_REFERENCE_CONFLICT',
      );
      assert.equal(
        await sales.onlinePayment.count({ where: { bankTxnRef: f.body.bankTxnRef } }),
        1,
      );
      const loser = result[0].status === 'rejected' ? f.orderId : secondId;
      assert.equal(await sales.onlinePaymentAudit.count({ where: { orderId: loser } }), 0);
      assert.equal(
        await sales.onlinePaymentRequest.count({
          where: {
            idempotencyKey:
              loser === secondId ? secondId : `confirm-${f.body.bankTxnRef.split('/').at(-1)}`,
          },
        }),
        0,
      );
      assert.equal(await sales.outboxEvent.count({ where: { aggregateId: loser } }), 0);
      assert.equal(
        (await sales.onlineOrder.findUniqueOrThrow({ where: { id: loser } })).status,
        'AWAITING_PAYMENT',
      );
    } finally {
      const ids = (
        await sales.onlinePayment.findMany({ where: { orderId: secondId }, select: { id: true } })
      ).map((p) => p.id);
      await sales.onlinePaymentAudit.deleteMany({ where: { orderId: secondId } });
      await sales.onlinePaymentRequest.deleteMany({ where: { paymentId: { in: ids } } });
      await sales.onlinePayment.deleteMany({ where: { orderId: secondId } });
      await sales.outboxEvent.deleteMany({ where: { aggregateId: secondId } });
      await sales.onlineOrder.deleteMany({ where: { id: secondId } });
      await f.cleanup();
    }
  });
  await test('6.5B DB-10: unpaid expiry cannot release a verified paid hold', async () => {
    const f = await fixture();
    try {
      assert.equal(
        (await inventory.stockReservation.findUniqueOrThrow({ where: { id: f.reservationId } }))
          .status,
        'ACTIVE',
      );
      await f.confirm();
      const event = await f.paidEvent();
      await inventory.$transaction((tx) => confirmPaidReservation(event, { tx }));
      await inventory.stockReservation.update({
        where: { id: f.reservationId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await inventory.$transaction((tx) => releaseOnlineOrder(tx, f.orderId, 'EXPIRED'));
      const row = await inventory.stockReservation.findUniqueOrThrow({
        where: { id: f.reservationId },
      });
      assert.equal(row.status, 'PAID_HELD');
      assert.equal(row.paymentId, event.paymentId);
      assert.equal(
        (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
        'RESERVED',
      );
      assert.equal(
        await inventory.stockReservationItem.count({
          where: { reservationId: f.reservationId, isActive: true },
        }),
        1,
      );
    } finally {
      await f.cleanup();
    }
  });
  await test('6.5B DB-09: receipt outbox failure rolls back payment, key alias, audit and order', async () => {
    const f = await fixture();
    try {
      const injected = new OnlinePaymentsService({
        $transaction: (work) =>
          sales.$transaction((tx) =>
            work(
              new Proxy(tx, {
                get(target, prop) {
                  if (prop === 'outboxEvent')
                    return {
                      create: async () => {
                        throw new Error('PH6 receipt outbox failure');
                      },
                    };
                  return Reflect.get(target, prop);
                },
              }),
            ),
          ),
      });
      await assert.rejects(
        injected.confirm(f.actor, f.branchId, f.orderId, 'rollback-receipt', f.body),
        /PH6 receipt outbox failure/,
      );
      const order = await sales.onlineOrder.findUniqueOrThrow({ where: { id: f.orderId } });
      assert.equal(order.status, 'AWAITING_PAYMENT');
      assert.equal(order.activePaymentId, null);
      assert.equal(await sales.onlinePayment.count({ where: { orderId: f.orderId } }), 0);
      assert.equal(await sales.onlinePaymentRequest.count({ where: { actorId: f.actor.id } }), 0);
      assert.equal(await sales.onlinePaymentAudit.count({ where: { orderId: f.orderId } }), 0);
      assert.equal(await sales.outboxEvent.count({ where: { aggregateId: f.orderId } }), 0);
      await f.confirm();
      assert.equal(await sales.onlinePayment.count({ where: { orderId: f.orderId } }), 1);
    } finally {
      await f.cleanup();
    }
  });
} finally {
  await inventory.$disconnect();
  await sales.$disconnect();
}
