import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const root = new URL('../../', import.meta.url);
const salesRequire = createRequire(new URL('apps/sales/package.json', root));
const inventoryRequire = createRequire(new URL('apps/inventory/package.json', root));
salesRequire('reflect-metadata');
assert.equal(process.env.PHASE73_TEST_EXECUTE, 'I_ACKNOWLEDGE_ISOLATED_PHASE73_TEST');
function client(service, require) {
  const url = new URL(process.env[`PHASE73_TEST_${service.toUpperCase()}_URL`]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55434');
  assert.equal(url.pathname, '/phase73_test');
  assert.equal(url.username, `${service}_user`);
  assert.equal(url.searchParams.get('schema'), service);
  assert.ok(url.password);
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString(), max: 6 }, { schema: service }),
  });
}
const sales = client('sales', salesRequire),
  inventory = client('inventory', inventoryRequire);
const { BuybacksService } = salesRequire('./dist/buybacks/buybacks.service.js');
const { BuybackAppraisalService } = salesRequire('./dist/buybacks/buyback-appraisal.service.js');
const { BuybackPriceClient } = salesRequire('./dist/buybacks/buyback-price.client.js');
const { BuybackSettlementService } = salesRequire('./dist/buybacks/buyback-settlement.service.js');
const { BuybackSettlementRecoveryWorker } = salesRequire(
  './dist/buybacks/buyback-settlement-recovery.worker.js',
);
const { ExchangeClient } = salesRequire('./dist/buybacks/exchange-client.js');
const { MetalsService } = inventoryRequire('./dist/catalog/metals.service.js');
const { ExchangeHoldsService } = inventoryRequire('./dist/stock/exchange-holds.service.js');
const { ItemSalesService } = inventoryRequire('./dist/stock/item-sales.service.js');
const { InternalBuybackPriceController } = inventoryRequire(
  './dist/catalog/internal-buyback-price.controller.js',
);
const { InternalExchangeController } = inventoryRequire(
  './dist/stock/internal-exchange.controller.js',
);
const { Module } = inventoryRequire('@nestjs/common');
const { NestFactory } = inventoryRequire('@nestjs/core');
const { GlobalExceptionFilter } = salesRequire('@jewelry/common');
let app;
try {
  for (const [db, role] of [
    [sales, 'sales_user'],
    [inventory, 'inventory_user'],
  ]) {
    const [actual] = await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;
    assert.equal(actual.db, 'phase73_test');
    assert.equal(actual.role, role);
  }
  const holds = new ExchangeHoldsService(inventory);
  class InventoryHttpModule {}
  Module({
    controllers: [InternalBuybackPriceController, InternalExchangeController],
    providers: [
      { provide: MetalsService, useValue: new MetalsService(inventory) },
      { provide: ExchangeHoldsService, useValue: holds },
    ],
  })(InventoryHttpModule);
  app = await NestFactory.create(InventoryHttpModule, { logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.listen(0, '127.0.0.1');
  const url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const config = { get: () => url };
  const pricing = new BuybackAppraisalService(sales, new BuybackPriceClient(config));
  const intakes = new BuybacksService(sales);
  const exchangeClient = new ExchangeClient(config);
  const svc = new BuybackSettlementService(sales, exchangeClient);
  const posStock = new ItemSalesService(inventory);
  async function fixture({
    approved = true,
    online = false,
    accepted = '6.0000',
    saleWeight = '6.0000',
    sell = '3000000.00',
  } = {}) {
    const branchId = randomUUID();
    const staff = { id: randomUUID(), branches: [{ role: 'STAFF', branchId }] };
    const recorder = { id: randomUUID(), branches: staff.branches };
    const manager = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId }] };
    const checker = { id: randomUUID(), branches: manager.branches };
    const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
    const metal = await inventory.metal.create({
      data: { code: `PH73-${randomUUID()}`, name: 'Synthetic 18K', kind: 'GOLD' },
    });
    await inventory.metalPrice.create({
      data: {
        metalId: metal.id,
        buyPrice: '2000000.00',
        sellPrice: sell,
        effectiveFrom: new Date(Date.now() - 2000),
        createdBy: admin.id,
      },
    });
    const category = await inventory.category.create({ data: { name: `PH73-${randomUUID()}` } });
    const product = await inventory.product.create({
      data: { categoryId: category.id, name: 'Synthetic ring', publishedOnline: online },
    });
    const variant = await inventory.productVariant.create({
      data: {
        productId: product.id,
        metalId: metal.id,
        sku: `PH73-${randomUUID()}`,
        name: 'Synthetic size',
      },
    });
    const warehouse = await inventory.warehouse.create({
      data: { branchId, name: 'PH73 test warehouse', acceptsOnlineOrders: online },
    });
    const item = await inventory.jewelryItem.create({
      data: {
        tagCode: `PH73-${randomUUID()}`,
        variantId: variant.id,
        warehouseId: warehouse.id,
        weight: saleWeight,
        laborFee: '0',
        costPrice: '8000000',
      },
    });
    const draft = await intakes.create(staff, branchId, randomUUID(), {
      customer: { name: 'Synthetic customer', phone: '0901234567' },
      items: [
        {
          source: 'EXTERNAL',
          assetKind: 'GOLD',
          description: 'Old ring',
          condition: 'Worn',
          declaredWeight: accepted,
          initialMeasuredWeight: accepted,
        },
      ],
    });
    await intakes.submit(staff, branchId, draft.id, 1);
    if (approved) {
      const policy = await pricing.createPolicy(admin, branchId, randomUUID(), {
        metalId: metal.id,
        metalKind: 'GOLD',
        purityPerMille: '750',
        label: 'Synthetic alloy',
        deductionVndPerItem: '0',
        reason: 'PH73 test policy',
      });
      await pricing.appraise(staff, branchId, draft.id, draft.items[0].id, randomUUID(), {
        version: 2,
        measuredWeight: accepted,
        acceptedWeight: accepted,
        metalId: metal.id,
        metalKind: 'GOLD',
        purityPerMille: '750',
        condition: 'Assayed',
        notes: 'PH73',
      });
      const quote = await pricing.quote(staff, branchId, draft.id, randomUUID(), {
        version: 3,
        items: [{ itemId: draft.items[0].id, policyId: policy.id, policyVersion: 1 }],
      });
      await pricing.decide(
        manager,
        branchId,
        draft.id,
        quote.id,
        randomUUID(),
        { version: 4 },
        true,
      );
    }
    const version = (await sales.buybackIntake.findUniqueOrThrow({ where: { id: draft.id } }))
      .version;
    return {
      branchId,
      staff,
      recorder,
      manager,
      checker,
      admin,
      metal,
      variant,
      warehouse,
      item,
      intakeId: draft.id,
      version,
      direct: (key = randomUUID()) =>
        svc.createDirect(staff, branchId, draft.id, key, { version, method: 'CASH' }),
      exchange: (key = randomUUID()) =>
        svc.createExchange(staff, branchId, draft.id, key, {
          version,
          method: 'CASH',
          tagCode: item.tagCode,
        }),
    };
  }
  const db = (id) => sales.buybackSettlement.findUniqueOrThrow({ where: { id } });
  async function record(f, s, reference = `RCPT-${randomUUID()}`) {
    return svc.record(f.recorder, f.branchId, f.intakeId, s.id, randomUUID(), {
      version: s.version,
      reference,
      evidence: 'Human receipt and customer handover recorded',
    });
  }
  async function confirm(f, s, key = randomUUID()) {
    return svc.confirm(f.checker, f.branchId, f.intakeId, s.id, key, {
      version: s.version,
      verificationReference: `VERIFY-${randomUUID()}`,
      note: 'Cash counted and old jewelry received at counter',
    });
  }
  await test('DB-01 approved quote creates direct intent, not payout; unapproved is rejected', async () => {
    const f = await fixture();
    const s = await f.direct();
    assert.equal(s.status, 'AWAITING_PAYMENT');
    assert.equal(s.approvedAmount, '12000000.00');
    assert.equal(s.amountDue, s.approvedAmount);
    assert.equal(s.paymentConfirmedAt, null);
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
    const pending = await fixture({ approved: false });
    await assert.rejects(pending.direct(), (e) => e.code === 'INVALID_STATE');
    assert.equal(await sales.buybackSettlement.count({ where: { intakeId: pending.intakeId } }), 0);
  });
  await test('DB-02 same key replays identity; competing keys create one live settlement', async () => {
    const f = await fixture();
    const key = randomUUID();
    const a = await f.direct(key),
      b = await f.direct(key);
    assert.equal(a.id, b.id);
    await assert.rejects(
      svc.createDirect(f.staff, f.branchId, f.intakeId, key, {
        version: f.version,
        method: 'BANK_TRANSFER',
      }),
      (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    const another = await fixture();
    const race = await Promise.allSettled([another.direct(), another.direct()]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await sales.buybackSettlement.count({ where: { intakeId: another.intakeId } }), 1);
  });
  await test('DB-03 payment reference is unique, record does not settle, manager is separate', async () => {
    const a = await fixture(),
      b = await fixture();
    const sharedReference = `PH73-SHARED-${randomUUID()}`;
    const one = await record(a, await a.direct(), sharedReference);
    assert.equal(one.status, 'PAYMENT_RECORDED');
    assert.equal(one.paymentConfirmedAt, null);
    await assert.rejects(
      record(b, await b.direct(), sharedReference),
      (e) => e.code === 'PAYMENT_REFERENCE_CONFLICT',
    );
    await assert.rejects(
      svc.confirm(a.staff, a.branchId, a.intakeId, one.id, randomUUID(), {
        version: one.version,
        verificationReference: 'same-staff',
        note: 'Cash counted and old jewelry handed over',
      }),
      (e) => e.code === 'FORBIDDEN' || e.code === 'BUYBACK_SEPARATE_APPROVER_REQUIRED',
    );
    const settled = await confirm(a, one);
    assert.equal(settled.status, 'SETTLED');
    assert.equal(settled.direction, 'STORE_PAYS');
    assert.equal(await sales.order.count({ where: { id: settled.id } }), 0);
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.settled' },
      }),
      1,
    );
  });
  await test('DB-04 audit failure rolls back payment reference and version with transaction', async () => {
    const f = await fixture();
    const s = await f.direct();
    const faulty = new BuybackSettlementService(
      {
        $transaction: (work, options) =>
          sales.$transaction(
            (tx) =>
              work(
                new Proxy(tx, {
                  get(target, prop) {
                    if (prop === 'buybackSettlementAudit')
                      return {
                        create: async () => {
                          throw new Error('PH73 injected audit failure');
                        },
                      };
                    return Reflect.get(target, prop);
                  },
                }),
              ),
            options,
          ),
      },
      exchangeClient,
    );
    await assert.rejects(
      faulty.record(f.recorder, f.branchId, f.intakeId, s.id, randomUUID(), {
        version: s.version,
        reference: `R-${randomUUID()}`,
        evidence: 'Human receipt and handover recorded',
      }),
      /PH73 injected audit failure/,
    );
    assert.equal((await db(s.id)).status, 'AWAITING_PAYMENT');
    assert.equal((await db(s.id)).version, s.version);
    assert.equal(await sales.buybackSettlementRequest.count({ where: { settlementId: s.id } }), 0);
  });
  await test('DB-05 exchange freezes price, computes positive difference, reserves Inventory', async () => {
    const f = await fixture();
    const s = await f.exchange();
    assert.equal(s.status, 'AWAITING_PAYMENT');
    assert.equal(s.saleAmount, '18000000.00');
    assert.equal(s.approvedAmount, '12000000.00');
    assert.equal(s.difference, '6000000.00');
    assert.equal(s.amountDue, '6000000.00');
    assert.equal(s.direction, 'CUSTOMER_PAYS');
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'RESERVED',
    );
    await inventory.metalPrice.create({
      data: {
        metalId: f.metal.id,
        buyPrice: '1000000',
        sellPrice: '9000000',
        effectiveFrom: new Date(),
        createdBy: f.admin.id,
      },
    });
    assert.equal((await db(s.id)).saleAmount.toFixed(2), '18000000.00');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
  });
  await test('DB-06 reverse difference requires store payout; zero difference requires handover receipt', async () => {
    const negative = await fixture({ saleWeight: '2.0000' });
    const n = await negative.exchange();
    assert.equal(n.difference, '-6000000.00');
    assert.equal(n.direction, 'STORE_PAYS');
    assert.equal(n.amountDue, '6000000.00');
    const zero = await fixture({ saleWeight: '4.0000' });
    const z = await zero.exchange();
    assert.equal(z.difference, '0.00');
    assert.equal(z.direction, 'NONE');
    assert.equal(z.amountDue, '0.00');
    assert.equal((await record(zero, z)).status, 'PAYMENT_RECORDED');
  });
  await test('DB-07 payment confirmation consumes exactly one item, creates one order and trade-in snapshot', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    const settled = await confirm(f, s);
    assert.equal(settled.status, 'SETTLED');
    const item = await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } });
    assert.equal(item.status, 'SOLD');
    assert.equal(item.orderId, settled.id);
    const order = await sales.order.findUniqueOrThrow({
      where: { id: settled.id },
      include: { items: true, tradeInItems: true },
    });
    assert.equal(order.status, 'COMPLETED');
    assert.equal(order.total.toFixed(2), '18000000.00');
    assert.equal(order.items.length, 1);
    assert.equal(order.tradeInItems.length, 1);
    assert.equal(order.tradeInItems[0].amount.toFixed(2), '12000000.00');
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'order.paid' },
      }),
      1,
    );
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'Exchange', refId: settled.id, type: 'SALE' },
      }),
      1,
    );
    assert.equal(
      await sales.buybackSettlementAudit.count({
        where: { settlementId: settled.id, action: 'SETTLED' },
      }),
      1,
    );
  });
  await test('DB-08 retry after committed confirmation does not duplicate payment, order, movement or event', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    const key = randomUUID(),
      body = {
        version: s.version,
        verificationReference: 'VERIFY-PH73-RETRY',
        note: 'Cash counted and old jewelry received at counter',
      };
    const a = await svc.confirm(f.checker, f.branchId, f.intakeId, s.id, key, body);
    const b = await svc.confirm(f.checker, f.branchId, f.intakeId, s.id, key, body);
    assert.equal(a.id, b.id);
    assert.equal(b.status, 'SETTLED');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 1);
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'Exchange', refId: s.id, type: 'SALE' },
      }),
      1,
    );
    assert.equal(
      await sales.outboxEvent.count({ where: { aggregateId: s.id, eventType: 'order.paid' } }),
      1,
    );
  });
  await test('DIST-01 two exchanges compete for one ring; one holds it', async () => {
    const a = await fixture(),
      b = await fixture();
    const results = await Promise.all([
      a.exchange(),
      svc.createExchange(b.staff, b.branchId, b.intakeId, randomUUID(), {
        version: b.version,
        method: 'CASH',
        tagCode: a.item.tagCode,
      }),
    ]);
    assert.equal(results[0].status, 'AWAITING_PAYMENT');
    assert.equal(results[1].status, 'CANCELLED');
    assert.equal(
      await inventory.exchangeHold.count({ where: { itemId: a.item.id, status: 'ACTIVE' } }),
      1,
    );
  });
  await test('DIST-02 POS cannot deduct an exchange-reserved ring and vice versa', async () => {
    const f = await fixture();
    const s = await f.exchange();
    await assert.rejects(
      posStock.deductItemsForOrder({
        orderId: randomUUID(),
        branchId: f.branchId,
        tagCodes: [f.item.tagCode],
      }),
      (e) => e.code === 'ITEM_NOT_AVAILABLE',
    );
    const other = await fixture();
    const sold = await posStock.deductItemsForOrder({
      orderId: randomUUID(),
      branchId: other.branchId,
      tagCodes: [other.item.tagCode],
    });
    assert.equal(sold.items.length, 1);
    const attempted = await other.exchange();
    assert.equal(attempted.status, 'CANCELLED');
    assert.equal(
      (await inventory.exchangeHold.findUniqueOrThrow({ where: { exchangeId: s.id } })).status,
      'ACTIVE',
    );
  });
  await test('DIST-03 Online reservation and exchange compete for one physical item', async () => {
    const f = await fixture({ online: true });
    const onlineId = randomUUID();
    const { reserveOnlineOrder } = inventoryRequire('./dist/online/reservations.js');
    const request = {
      channel: 'WEBSITE',
      orderId: onlineId,
      requestHash: createHash('sha256').update(onlineId).digest('hex'),
      items: [{ variantId: f.variant.id, quantity: 1 }],
      deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
    };
    const results = await Promise.allSettled([
      f.exchange(),
      inventory.$transaction((tx) => reserveOnlineOrder(tx, request)),
    ]);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    const exchange = results[0].value;
    const reservation = await inventory.stockReservation.findUniqueOrThrow({
      where: { orderId: onlineId },
    });
    assert.equal(
      Number(exchange.status === 'AWAITING_PAYMENT') + Number(reservation.status === 'ACTIVE'),
      1,
    );
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'RESERVED',
    );
  });
  await test('DIST-04 timeout after reserve is recovered by same exchangeId', async () => {
    const f = await fixture();
    let first = true;
    const flaky = new ExchangeClient(config);
    const original = flaky.reserve.bind(flaky);
    flaky.reserve = async (...args) => {
      const result = await original(...args);
      if (first) {
        first = false;
        throw new Error('PH73 lost HTTP response');
      }
      return result;
    };
    const service = new BuybackSettlementService(sales, flaky);
    const pending = await service.createExchange(f.staff, f.branchId, f.intakeId, randomUUID(), {
      version: f.version,
      method: 'CASH',
      tagCode: f.item.tagCode,
    });
    assert.equal(pending.status, 'RESERVING');
    assert.equal(await inventory.exchangeHold.count({ where: { exchangeId: pending.id } }), 1);
    await service.recover(pending.id);
    assert.equal((await db(pending.id)).status, 'AWAITING_PAYMENT');
    assert.equal(await inventory.exchangeHold.count({ where: { itemId: f.item.id } }), 1);
  });
  await test('DIST-05 Inventory unavailable after payment confirmation enters reconciliation then recovers once', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    const broken = new ExchangeClient(config);
    broken.state = async () => {
      throw new Error('PH73 simulated Inventory outage');
    };
    const service = new BuybackSettlementService(sales, broken);
    const pending = await service.confirm(f.checker, f.branchId, f.intakeId, s.id, randomUUID(), {
      version: s.version,
      verificationReference: 'VERIFY-OUTAGE',
      note: 'Cash counted and old jewelry received at counter',
    });
    assert.equal(pending.status, 'RECONCILIATION_REQUIRED');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'RESERVED',
    );
    await svc.recover(s.id);
    assert.equal((await db(s.id)).status, 'SETTLED');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 1);
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'Exchange', refId: s.id, type: 'SALE' },
      }),
      1,
    );
  });
  await test('DIST-06 expired reservation with recorded payment cannot be sold or marked settled', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    await inventory.exchangeHold.update({
      where: { exchangeId: s.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await holds.expire(s.id);
    const result = await confirm(f, s);
    assert.equal(result.status, 'RECONCILIATION_REQUIRED');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'IN_STOCK',
    );
  });
  await test('DIST-07 Sales commit failure after Inventory sale enters reconciliation; retry creates one order', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    let inject = true;
    const faultyPrisma = new Proxy(sales, {
      get(target, prop) {
        if (prop !== '$transaction') return Reflect.get(target, prop);
        return (work, options) =>
          target.$transaction(
            (tx) =>
              work(
                new Proxy(tx, {
                  get(inner, field) {
                    if (field === 'order')
                      return new Proxy(inner.order, {
                        get(model, method) {
                          if (method === 'create' && inject)
                            return async () => {
                              inject = false;
                              throw new Error('PH73 injected Sales order commit failure');
                            };
                          return Reflect.get(model, method);
                        },
                      });
                    return Reflect.get(inner, field);
                  },
                }),
              ),
            options,
          );
      },
    });
    const faulty = new BuybackSettlementService(faultyPrisma, exchangeClient);
    const pending = await faulty.confirm(f.checker, f.branchId, f.intakeId, s.id, randomUUID(), {
      version: s.version,
      verificationReference: `VERIFY-${randomUUID()}`,
      note: 'Cash counted and old jewelry received at counter',
    });
    assert.equal(pending.status, 'RECONCILIATION_REQUIRED');
    assert.equal(pending.failureCode, 'SALES_COMMIT_UNCERTAIN');
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'SOLD',
    );
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
    assert.equal(
      await sales.outboxEvent.count({ where: { aggregateId: s.id, eventType: 'order.paid' } }),
      0,
    );
    await svc.recover(s.id);
    await svc.recover(s.id);
    assert.equal((await db(s.id)).status, 'SETTLED');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 1);
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'Exchange', refId: s.id, type: 'SALE' },
      }),
      1,
    );
    assert.equal(
      await sales.outboxEvent.count({ where: { aggregateId: s.id, eventType: 'order.paid' } }),
      1,
    );
  });
  await test('DB-10 database rejects missing payment evidence and preserves approved quote', async () => {
    const f = await fixture();
    const s = await f.direct();
    await assert.rejects(
      sales.$executeRaw`UPDATE "sales"."BuybackSettlement" SET status='PAYMENT_RECORDED', version=version+1 WHERE id=${s.id}::uuid`,
      (error) => error.code === 'P2010' || error.code === '23514',
    );
    assert.equal((await db(s.id)).status, 'AWAITING_PAYMENT');
    const row = await db(s.id);
    await assert.rejects(
      sales.$executeRaw`UPDATE "sales"."BuybackQuote" SET total=total+1 WHERE id=${row.quoteId}::uuid`,
    );
    assert.equal(
      (await sales.buybackQuote.findUniqueOrThrow({ where: { id: row.quoteId } })).total.toFixed(2),
      s.approvedAmount,
    );
  });
  await test('DIST-08 expired hold racing payment confirmation never creates a sale', async () => {
    const f = await fixture();
    const s = await record(f, await f.exchange());
    await inventory.exchangeHold.update({
      where: { exchangeId: s.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const result = await Promise.allSettled([confirm(f, s), holds.expire(s.id)]);
    assert.equal(result[0].status, 'fulfilled');
    assert.equal(result[1].status, 'fulfilled');
    assert.equal(result[0].value.status, 'RECONCILIATION_REQUIRED');
    assert.equal(
      (await inventory.exchangeHold.findUniqueOrThrow({ where: { exchangeId: s.id } })).status,
      'EXPIRED',
    );
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
    assert.equal(
      await sales.outboxEvent.count({ where: { aggregateId: s.id, eventType: 'order.paid' } }),
      0,
    );
  });
  await test('DIST-09 fresh recovery worker resumes an interrupted reservation once', async () => {
    const f = await fixture();
    let drop = true;
    const flaky = new ExchangeClient(config);
    const original = flaky.reserve.bind(flaky);
    flaky.reserve = async (...args) => {
      const hold = await original(...args);
      if (drop) {
        drop = false;
        throw new Error('PH73 lost reserve response before restart');
      }
      return hold;
    };
    const pending = await new BuybackSettlementService(sales, flaky).createExchange(
      f.staff,
      f.branchId,
      f.intakeId,
      randomUUID(),
      { version: f.version, method: 'CASH', tagCode: f.item.tagCode },
    );
    assert.equal(pending.status, 'RESERVING');
    await sales.buybackSettlement.update({
      where: { id: pending.id },
      data: { version: { increment: 1 }, updatedAt: new Date(Date.now() - 31_000) },
    });
    const restartedWorker = new BuybackSettlementRecoveryWorker(sales, svc);
    await restartedWorker.scan();
    assert.equal((await db(pending.id)).status, 'AWAITING_PAYMENT');
    assert.equal(await inventory.exchangeHold.count({ where: { exchangeId: pending.id } }), 1);
  });
  await test('DB-09 cancellation releases hold, terminal edits and duplicate reference cannot create revenue', async () => {
    const f = await fixture();
    const s = await f.exchange();
    const cancelled = await svc.cancel(f.staff, f.branchId, f.intakeId, s.id, randomUUID(), {
      version: s.version,
      reason: 'Customer withdrew before payment',
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(
      (await inventory.jewelryItem.findUniqueOrThrow({ where: { id: f.item.id } })).status,
      'IN_STOCK',
    );
    await assert.rejects(record(f, cancelled), (e) => e.code === 'INVALID_STATE');
    assert.equal(await sales.order.count({ where: { id: s.id } }), 0);
  });
} finally {
  if (app) await app.close();
  await sales.$disconnect();
  await inventory.$disconnect();
}
