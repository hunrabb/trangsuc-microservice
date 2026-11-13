import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const root = new URL('../../', import.meta.url);
const salesRequire = createRequire(new URL('apps/sales/package.json', root));
const inventoryRequire = createRequire(new URL('apps/inventory/package.json', root));
const reportRequire = createRequire(new URL('apps/report/package.json', root));
salesRequire('reflect-metadata');
assert.equal(process.env.PHASE74_TEST_EXECUTE, 'I_ACKNOWLEDGE_ISOLATED_PHASE74_TEST');
function client(service, require) {
  const url = new URL(process.env[`PHASE74_TEST_${service.toUpperCase()}_URL`]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55435');
  assert.equal(url.pathname, '/phase74_test');
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
  inventory = client('inventory', inventoryRequire),
  report = client('report', reportRequire);
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
const { receiveSettledBuyback } = inventoryRequire('./dist/receipts/buyback-receipts.handler.js');
const { recordBuybackSettled, recordBuybackStocked } = reportRequire(
  './dist/buybacks/buyback-events.js',
);
const { BuybackReportsService } = reportRequire('./dist/buybacks/buyback-reports.service.js');
const { reportFilter } = reportRequire('./dist/orders/reports.service.js');
const { Module } = inventoryRequire('@nestjs/common');
const { NestFactory } = inventoryRequire('@nestjs/core');
const { GlobalExceptionFilter } = salesRequire('@jewelry/common');
let app;
try {
  for (const [db, role] of [
    [sales, 'sales_user'],
    [inventory, 'inventory_user'],
    [report, 'report_user'],
  ]) {
    const [actual] = await db.$queryRaw`SELECT current_database() AS db, current_user AS role`;
    assert.equal(actual.db, 'phase74_test');
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
  const svc = new BuybackSettlementService(sales, new ExchangeClient(config));
  const pos = new ItemSalesService(inventory);
  const reports = new BuybackReportsService(report);
  async function fixture({ count = 1, saleWeight = '6.0000' } = {}) {
    const branchId = randomUUID();
    const staff = { id: randomUUID(), branches: [{ role: 'STAFF', branchId }] };
    const recorder = { id: randomUUID(), branches: staff.branches };
    const manager = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId }] };
    const checker = { id: randomUUID(), branches: manager.branches };
    const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
    const metal = await inventory.metal.create({
      data: { code: `PH74-${randomUUID()}`, name: 'Test alloy', kind: 'GOLD' },
    });
    await inventory.metalPrice.create({
      data: {
        metalId: metal.id,
        buyPrice: '2000000',
        sellPrice: '3000000',
        effectiveFrom: new Date(Date.now() - 2000),
        createdBy: admin.id,
      },
    });
    const category = await inventory.category.create({ data: { name: `PH74-${randomUUID()}` } });
    const product = await inventory.product.create({
      data: { categoryId: category.id, name: 'Test ring', publishedOnline: true },
    });
    const variant = await inventory.productVariant.create({
      data: {
        productId: product.id,
        metalId: metal.id,
        sku: `PH74-${randomUUID()}`,
        name: 'Test size',
      },
    });
    const warehouse = await inventory.warehouse.create({
      data: { branchId, name: 'PH74 warehouse', acceptsOnlineOrders: true },
    });
    const saleItem = await inventory.jewelryItem.create({
      data: {
        tagCode: `PH74-${randomUUID()}`,
        variantId: variant.id,
        warehouseId: warehouse.id,
        weight: saleWeight,
        laborFee: '0',
        costPrice: '8000000',
      },
    });
    const weights = Array.from({ length: count }, (_, i) => `${i + 1}.0000`);
    const draft = await intakes.create(staff, branchId, randomUUID(), {
      customer: { name: 'Synthetic customer', phone: '0901234567' },
      items: weights.map((w, i) => ({
        source: 'EXTERNAL',
        assetKind: 'GOLD',
        description: `Old ring ${i}`,
        condition: 'Worn',
        declaredWeight: w,
        initialMeasuredWeight: w,
      })),
    });
    await intakes.submit(staff, branchId, draft.id, 1);
    const policy = await pricing.createPolicy(admin, branchId, randomUUID(), {
      metalId: metal.id,
      metalKind: 'GOLD',
      purityPerMille: '750',
      label: 'Test alloy',
      deductionVndPerItem: '0',
      reason: 'PH74 test policy',
    });
    let version = 2;
    for (let i = 0; i < draft.items.length; i++) {
      await pricing.appraise(staff, branchId, draft.id, draft.items[i].id, randomUUID(), {
        version,
        measuredWeight: weights[i],
        acceptedWeight: weights[i],
        metalId: metal.id,
        metalKind: 'GOLD',
        purityPerMille: '750',
        condition: 'Assayed',
        notes: 'PH74',
      });
      version++;
    }
    const quote = await pricing.quote(staff, branchId, draft.id, randomUUID(), {
      version,
      items: draft.items.map((item) => ({
        itemId: item.id,
        policyId: policy.id,
        policyVersion: 1,
      })),
    });
    version++;
    await pricing.decide(manager, branchId, draft.id, quote.id, randomUUID(), { version }, true);
    version++;
    return {
      branchId,
      staff,
      recorder,
      manager,
      checker,
      admin,
      metal,
      warehouse,
      saleItem,
      intakeId: draft.id,
      quoteId: quote.id,
      version,
      direct: () =>
        svc.createDirect(staff, branchId, draft.id, randomUUID(), { version, method: 'CASH' }),
      exchange: () =>
        svc.createExchange(staff, branchId, draft.id, randomUUID(), {
          version,
          method: 'CASH',
          tagCode: saleItem.tagCode,
        }),
    };
  }
  async function settle(f, exchange = false) {
    const created = exchange ? await f.exchange() : await f.direct();
    const recorded = await svc.record(
      f.recorder,
      f.branchId,
      f.intakeId,
      created.id,
      randomUUID(),
      {
        version: created.version,
        reference: `RCPT-${randomUUID()}`,
        evidence: 'Human receipt and handover recorded',
      },
    );
    return svc.confirm(f.checker, f.branchId, f.intakeId, created.id, randomUUID(), {
      version: recorded.version,
      verificationReference: `CHECK-${randomUUID()}`,
      note: 'Cash counted and old jewelry received at counter',
    });
  }
  async function event(id) {
    return sales.outboxEvent.findFirstOrThrow({
      where: { aggregateId: id, eventType: 'buyback.settled' },
    });
  }
  const envelope = () => ({
    eventId: randomUUID(),
    eventType: 'buyback.settled',
    occurredAt: new Date().toISOString(),
    correlationId: 'PH74',
    payload: null,
  });
  async function receive(id) {
    const row = await event(id);
    await inventory.$transaction((tx) =>
      receiveSettledBuyback(row.payload, { tx, envelope: envelope() }),
    );
    return inventory.goodsReceipt.findUniqueOrThrow({ where: { sourceSettlementId: id } });
  }
  await test('DB-01 approved but unpaid never emits stock event; settled direct creates one pending-melt item', async () => {
    const f = await fixture();
    const pending = await f.direct();
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: pending.id, eventType: 'buyback.settled' },
      }),
      0,
    );
    assert.equal(
      await inventory.jewelryItem.count({ where: { sourceSettlementId: pending.id } }),
      0,
    );
    const recorded = await svc.record(
      f.recorder,
      f.branchId,
      f.intakeId,
      pending.id,
      randomUUID(),
      {
        version: pending.version,
        reference: `RCPT-${randomUUID()}`,
        evidence: 'Human receipt and handover recorded',
      },
    );
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: pending.id, eventType: 'buyback.settled' },
      }),
      0,
    );
    const settled = await svc.confirm(f.checker, f.branchId, f.intakeId, pending.id, randomUUID(), {
      version: recorded.version,
      verificationReference: `CHECK-${randomUUID()}`,
      note: 'Cash counted and old jewelry received at counter',
    });
    assert.equal(settled.status, 'SETTLED');
    const receipt = await receive(settled.id);
    const item = await inventory.jewelryItem.findFirstOrThrow({
      where: { sourceSettlementId: settled.id },
    });
    assert.equal(receipt.source, 'BUYBACK');
    assert.equal(receipt.status, 'APPROVED');
    assert.equal(item.status, 'PENDING_MELT');
    assert.equal(item.origin, 'BOUGHT_BACK');
    assert.equal(item.costPrice.toFixed(2), settled.approvedAmount);
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'BuybackSettlement', refId: settled.id, type: 'BUYBACK' },
      }),
      1,
    );
    assert.equal(await sales.order.count({ where: { id: settled.id } }), 0);
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.settled' },
      }),
      1,
    );
    assert.equal(
      await inventory.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.stocked' },
      }),
      1,
    );
  });
  await test('DB-02 multi-item quote amount reconciles exactly with costs, tags and receipt lines', async () => {
    const f = await fixture({ count: 3 });
    const settled = await settle(f);
    await receive(settled.id);
    const items = await inventory.jewelryItem.findMany({
      where: { sourceSettlementId: settled.id },
      include: { variant: { include: { product: true } } },
    });
    const lines = await inventory.goodsReceiptLine.findMany({ where: { receiptId: settled.id } });
    assert.equal(items.length, 3);
    assert.equal(lines.length, 3);
    assert.equal(new Set(items.map((i) => i.tagCode)).size, 3);
    assert.equal(
      items
        .reduce(
          (sum, i) => sum.add(i.costPrice),
          new (inventoryRequire('./dist/generated/prisma/client.js').Prisma.Decimal)(0),
        )
        .toFixed(2),
      settled.approvedAmount,
    );
    assert.ok(
      items.every(
        (i) =>
          i.status === 'PENDING_MELT' &&
          !i.variant.isActive &&
          !i.variant.product.isActive &&
          !i.variant.product.publishedOnline,
      ),
    );
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'BuybackSettlement', refId: settled.id, type: 'BUYBACK' },
      }),
      3,
    );
  });
  await test('DB-03 duplicate and concurrent different deliveries create one receipt, item, movement and audit', async () => {
    const f = await fixture();
    const settled = await settle(f);
    const row = await event(settled.id);
    await Promise.all([
      inventory.$transaction((tx) =>
        receiveSettledBuyback(row.payload, { tx, envelope: envelope() }),
      ),
      inventory.$transaction((tx) =>
        receiveSettledBuyback(row.payload, { tx, envelope: envelope() }),
      ),
    ]);
    await receive(settled.id);
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      1,
    );
    assert.equal(
      await inventory.jewelryItem.count({ where: { sourceSettlementId: settled.id } }),
      1,
    );
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'BuybackSettlement', refId: settled.id, type: 'BUYBACK' },
      }),
      1,
    );
    assert.equal(
      await inventory.auditLog.count({
        where: { entityId: settled.id, action: 'buyback.received' },
      }),
      1,
    );
    assert.equal(
      await inventory.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.stocked' },
      }),
      1,
    );
  });
  await test('DB-04 movement failure rolls back receipt, item, audit and outbox; retry succeeds', async () => {
    const f = await fixture();
    const settled = await settle(f);
    const row = await event(settled.id);
    await assert.rejects(
      inventory.$transaction((tx) =>
        receiveSettledBuyback(row.payload, {
          tx: new Proxy(tx, {
            get(target, p) {
              if (p === 'stockMovement')
                return {
                  createMany: async () => {
                    throw Error('PH74 injected movement failure');
                  },
                };
              return Reflect.get(target, p);
            },
          }),
          envelope: envelope(),
        }),
      ),
      /PH74 injected movement failure/,
    );
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      0,
    );
    assert.equal(
      await inventory.jewelryItem.count({ where: { sourceSettlementId: settled.id } }),
      0,
    );
    assert.equal(
      await inventory.stockMovement.count({
        where: { refType: 'BuybackSettlement', refId: settled.id },
      }),
      0,
    );
    await receive(settled.id);
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      1,
    );
  });
  await test('DB-05 inactive warehouse leaves settled payment intact, then retry receives goods', async () => {
    const f = await fixture();
    const settled = await settle(f);
    await inventory.warehouse.update({ where: { id: f.warehouse.id }, data: { isActive: false } });
    await assert.rejects(receive(settled.id), /Kho nhận thu mua/);
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      0,
    );
    assert.equal(
      (await sales.buybackSettlement.findUniqueOrThrow({ where: { id: settled.id } })).status,
      'SETTLED',
    );
    await inventory.warehouse.update({ where: { id: f.warehouse.id }, data: { isActive: true } });
    await receive(settled.id);
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      1,
    );
  });
  await test('DB-06 metal price changes after settlement cannot alter received cost', async () => {
    const f = await fixture();
    const settled = await settle(f);
    await inventory.metalPrice.create({
      data: {
        metalId: f.metal.id,
        buyPrice: '9000000',
        sellPrice: '9500000',
        effectiveFrom: new Date(),
        createdBy: f.admin.id,
      },
    });
    await receive(settled.id);
    const item = await inventory.jewelryItem.findFirstOrThrow({
      where: { sourceSettlementId: settled.id },
    });
    assert.equal(item.costPrice.toFixed(2), settled.approvedAmount);
  });
  await test('DB-07 pending-melt tag is unavailable to POS and exchange', async () => {
    const f = await fixture();
    const settled = await settle(f);
    await receive(settled.id);
    const item = await inventory.jewelryItem.findFirstOrThrow({
      where: { sourceSettlementId: settled.id },
    });
    const quoted = await pos.quoteItems({ tagCodes: [item.tagCode], branchId: f.branchId });
    assert.equal(quoted.items[0].available, false);
    await assert.rejects(
      pos.deductItemsForOrder({
        orderId: randomUUID(),
        branchId: f.branchId,
        tagCodes: [item.tagCode],
      }),
      (e) => e.code === 'ITEM_NOT_AVAILABLE',
    );
    await assert.rejects(
      holds.reserve({ exchangeId: randomUUID(), branchId: f.branchId, tagCode: item.tagCode }),
      (e) => e.code === 'ITEM_NOT_AVAILABLE',
    );
  });
  await test('DB-08 a conflicting replay snapshot is rejected without changing stock', async () => {
    const f = await fixture();
    const settled = await settle(f);
    await receive(settled.id);
    const row = await event(settled.id);
    const changed = { ...row.payload, settledAt: new Date(Date.now() + 1000).toISOString() };
    await assert.rejects(
      inventory.$transaction((tx) => receiveSettledBuyback(changed, { tx, envelope: envelope() })),
      /snapshot khác/,
    );
    assert.equal(
      await inventory.jewelryItem.count({ where: { sourceSettlementId: settled.id } }),
      1,
    );
  });
  await test('DB-09 Report handles stock-before-settlement and duplicate events without sales revenue', async () => {
    const f = await fixture();
    const settled = await settle(f);
    await receive(settled.id);
    const first = await sales.outboxEvent.findFirstOrThrow({
      where: { aggregateId: settled.id, eventType: 'buyback.settled' },
    });
    const second = await inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: settled.id, eventType: 'buyback.stocked' },
    });
    await report.$transaction((tx) =>
      recordBuybackStocked(second.payload, { tx, envelope: envelope() }),
    );
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const before = await reports.summary({ from: date, to: date, branchId: f.branchId });
    assert.equal(before.reconciliation[0].state, 'SETTLEMENT_EVENT_MISSING');
    await report.$transaction((tx) =>
      recordBuybackSettled(first.payload, { tx, envelope: envelope() }),
    );
    await report.$transaction((tx) =>
      recordBuybackSettled(first.payload, { tx, envelope: envelope() }),
    );
    const after = await reports.summary({ from: date, to: date, branchId: f.branchId });
    assert.equal(after.reconciliation.length, 0);
    assert.equal(after.rows[0].purchaseValue, settled.approvedAmount);
    assert.equal(after.rows[0].receivedAssetValue, settled.approvedAmount);
    assert.equal(after.rows[0].directPayout, settled.approvedAmount);
    assert.equal(await report.orderRevenue.count({ where: { orderId: settled.id } }), 0);
    assert.equal(await report.buybackStockFact.count({ where: { settlementId: settled.id } }), 1);
  });
  await test('DB-10 Report shows settled-but-unstocked reconciliation and exact exchange difference', async () => {
    const f = await fixture({ saleWeight: '6.0000' });
    const settled = await settle(f, true);
    const row = await event(settled.id);
    await report.$transaction((tx) =>
      recordBuybackSettled(row.payload, { tx, envelope: envelope() }),
    );
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const before = await reports.summary({ from: date, to: date, branchId: f.branchId });
    assert.equal(before.reconciliation[0].state, 'PENDING_STOCK');
    assert.equal(before.rows[0].exchangeCount, 1);
    assert.equal(before.rows[0].exchangeCustomerPays, settled.amountDue);
    await receive(settled.id);
    const stocked = await inventory.outboxEvent.findFirstOrThrow({
      where: { aggregateId: settled.id, eventType: 'buyback.stocked' },
    });
    await report.$transaction((tx) =>
      recordBuybackStocked(stocked.payload, { tx, envelope: envelope() }),
    );
    assert.equal(
      (await reports.summary({ from: date, to: date, branchId: f.branchId })).reconciliation.length,
      0,
    );
    assert.equal(await report.orderRevenue.count({ where: { orderId: settled.id } }), 0);
  });
  await test('DB-11 settled direct remains pending stock until Rabbit consumer receives it', async () => {
    const f = await fixture();
    const settled = await settle(f);
    assert.equal(
      await inventory.goodsReceipt.count({ where: { sourceSettlementId: settled.id } }),
      0,
    );
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.settled', status: 'PENDING' },
      }),
      1,
    );
  });
  await test('DB-12 report branch filter rejects cross-branch manager access', async () => {
    const own = randomUUID(),
      other = randomUUID(),
      date = '2026-11-09';
    const manager = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId: own }] };
    const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
    assert.equal(reportFilter(manager, date, date, own).branchId, own);
    assert.throws(
      () => reportFilter(manager, date, date, other),
      (e) => e.code === 'FORBIDDEN',
    );
    assert.throws(
      () => reportFilter(manager, date, date),
      (e) => e.code === 'FORBIDDEN',
    );
    assert.equal(reportFilter(admin, date, date).branchId, undefined);
  });
  await test('DB-13 recovery recreates a missing stock event for SETTLED exactly once', async () => {
    const f = await fixture();
    const settled = await settle(f);
    const prior = await event(settled.id);
    await sales.outboxEvent.delete({ where: { id: prior.id } });
    const worker = new BuybackSettlementRecoveryWorker(sales, svc);
    await worker.scan();
    await worker.scan();
    assert.equal(
      (await sales.buybackSettlement.findUniqueOrThrow({ where: { id: settled.id } })).status,
      'SETTLED',
    );
    assert.equal(
      await sales.outboxEvent.count({
        where: { aggregateId: settled.id, eventType: 'buyback.settled' },
      }),
      1,
    );
    assert.equal((await event(settled.id)).status, 'PENDING');
  });
} finally {
  if (app) await app.close();
  await sales.$disconnect();
  await inventory.$disconnect();
  await report.$disconnect();
}
