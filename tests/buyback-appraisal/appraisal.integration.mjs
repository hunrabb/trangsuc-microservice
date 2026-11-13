// PostgreSQL + lightweight Inventory HTTP only. No app workers, RabbitMQ, payment or stock changes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const root = new URL('../../', import.meta.url);
const salesRequire = createRequire(new URL('apps/sales/package.json', root));
const inventoryRequire = createRequire(new URL('apps/inventory/package.json', root));
salesRequire('reflect-metadata');
assert.equal(process.env.PHASE72_TEST_EXECUTE, 'I_ACKNOWLEDGE_ISOLATED_PHASE72_TEST');
function client(service, require) {
  const url = new URL(process.env[`PHASE72_TEST_${service.toUpperCase()}_URL`]);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/phase72_test');
  assert.equal(url.username, `${service}_user`);
  assert.equal(url.searchParams.get('schema'), service);
  assert.ok(url.password);
  const { PrismaPg } = require('@prisma/adapter-pg');
  const { PrismaClient } = require('./dist/generated/prisma/client.js');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString(), max: 4 }, { schema: service }),
  });
}
const sales = client('sales', salesRequire),
  inventory = client('inventory', inventoryRequire);
const { BuybacksService } = salesRequire('./dist/buybacks/buybacks.service.js');
const { BuybackAppraisalService } = salesRequire('./dist/buybacks/buyback-appraisal.service.js');
const { BuybackPriceClient } = salesRequire('./dist/buybacks/buyback-price.client.js');
const { MetalsService } = inventoryRequire('./dist/catalog/metals.service.js');
const { InternalBuybackPriceController } = inventoryRequire(
  './dist/catalog/internal-buyback-price.controller.js',
);
const { Module } = inventoryRequire('@nestjs/common');
const { NestFactory } = inventoryRequire('@nestjs/core');
const contracts = salesRequire('@jewelry/contracts');
let httpApp;
try {
  for (const [db, role] of [
    [sales, 'sales_user'],
    [inventory, 'inventory_user'],
  ]) {
    const [actual] = await db.$queryRaw`SELECT current_database() AS db,current_user AS role`;
    assert.equal(actual.db, 'phase72_test');
    assert.equal(actual.role, role);
  }
  class PriceHttpModule {}
  Module({
    controllers: [InternalBuybackPriceController],
    providers: [{ provide: MetalsService, useValue: new MetalsService(inventory) }],
  })(PriceHttpModule);
  httpApp = await NestFactory.create(PriceHttpModule, { logger: false });
  httpApp.useGlobalFilters(new (salesRequire('@jewelry/common').GlobalExceptionFilter)());
  await httpApp.listen(0, '127.0.0.1');
  const prices = new BuybackPriceClient({
    get: () =>
      httpApp.getHttpServer().address().port
        ? `http://127.0.0.1:${httpApp.getHttpServer().address().port}`
        : '',
  });
  const svc = new BuybackAppraisalService(sales, prices),
    intakes = new BuybacksService(sales);
  const header = (id) => sales.buybackIntake.findUniqueOrThrow({ where: { id } });
  async function fixture(n = 2) {
    const branchId = randomUUID();
    const staff = { id: randomUUID(), branches: [{ role: 'STAFF', branchId }] };
    const colleague = { id: randomUUID(), branches: staff.branches };
    const manager = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId }] };
    const secondManager = { id: randomUUID(), branches: manager.branches };
    const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
    const metal = await inventory.metal.create({
      data: { code: `PH72-${randomUUID()}`, name: 'Synthetic 18K test', kind: 'GOLD' },
    });
    const rate = await inventory.metalPrice.create({
      data: {
        metalId: metal.id,
        buyPrice: '2000000.25',
        sellPrice: '3000000.75',
        effectiveFrom: new Date(Date.now() - 1000),
        createdBy: admin.id,
      },
    });
    const draft = await intakes.create(
      staff,
      branchId,
      randomUUID(),
      contracts.createBuybackSchema.parse({
        customer: { name: 'PH72 synthetic customer', phone: '0901234567' },
        items: Array.from({ length: n }, () => ({
          source: 'EXTERNAL',
          assetKind: 'GOLD',
          description: 'Synthetic item',
          condition: 'Initial condition',
          declaredWeight: '1.4000',
          initialMeasuredWeight: '1.3500',
        })),
      }),
    );
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.version, 1);
    assert.equal(draft.items.length, n);
    assert.equal(await sales.buybackAppraisal.count({ where: { intakeId: draft.id } }), 0);
    assert.equal(await sales.buybackQuote.count({ where: { intakeId: draft.id } }), 0);
    const h = await intakes.submit(staff, branchId, draft.id, 1);
    const policy = await svc.createPolicy(admin, branchId, randomUUID(), {
      metalId: metal.id,
      metalKind: 'GOLD',
      purityPerMille: '750',
      label: 'PH72 18K test policy',
      deductionVndPerItem: '1500.31',
      reason: 'Synthetic policy for isolated integration',
    });
    const body = (version, acceptedWeight = '1.2500') => ({
      version,
      measuredWeight: '1.3000',
      acceptedWeight,
      metalId: metal.id,
      metalKind: 'GOLD',
      purityPerMille: '750.0000',
      condition: 'Assayed synthetic alloy',
      notes: 'PH72 test appraisal',
    });
    const f = {
      id: h.id,
      items: h.items,
      branchId,
      staff,
      colleague,
      manager,
      secondManager,
      admin,
      metal,
      rate,
      policy,
      body,
    };
    f.appraise = async (index = 0, actor = staff, key = randomUUID()) =>
      svc.appraise(
        actor,
        branchId,
        h.id,
        h.items[index].id,
        key,
        body((await header(h.id)).version, index === 0 ? '1.2500' : '1.0000'),
      );
    f.complete = async () => {
      for (let i = 0; i < n; i++) await f.appraise(i);
    };
    f.quote = async () =>
      svc.quote(staff, branchId, h.id, randomUUID(), {
        version: (await header(h.id)).version,
        items: h.items.map((item) => ({
          itemId: item.id,
          policyId: policy.id,
          policyVersion: policy.version,
        })),
      });
    f.approve = async (q, actor = manager, key = randomUUID(), version) =>
      svc.decide(
        actor,
        branchId,
        h.id,
        q.id,
        key,
        { version: version ?? (await header(h.id)).version },
        true,
      );
    return f;
  }
  await test('MIG-01: Task 7.1 DRAFT/PENDING/CANCELLED rows, items and audits survive migration', async () => {
    const rows = await sales.buybackIntake.findMany({
      where: { code: { startsWith: 'PH72-COMPAT-' } },
      orderBy: { code: 'asc' },
      include: { items: true, audit: true },
    });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.status),
      ['DRAFT', 'PENDING_APPRAISAL', 'CANCELLED'],
    );
    for (const r of rows) {
      assert.equal(r.activeQuoteId, null);
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].initialMeasuredWeight.toFixed(4), '1.2000');
      assert.equal(r.audit.length, r.version);
    }
    assert.equal(
      await sales.buybackAppraisal.count({ where: { intakeId: { in: rows.map((r) => r.id) } } }),
      0,
    );
  });
  await test('DB-01: multiple items have distinct appraisal revisions and original measurements stay unchanged', async () => {
    const f = await fixture();
    await f.complete();
    const h = await header(f.id);
    assert.equal(h.status, 'APPRAISED');
    assert.equal(h.version, 4);
    const view = await svc.appraisals(f.manager, f.branchId, f.id);
    assert.equal(view.items.length, 2);
    assert.ok(
      view.items.every((a) => a.appraisedBy === f.staff.id && a.purityPerMille === '750.0000'),
    );
    const old = await sales.buybackIntakeItem.findMany({ where: { intakeId: f.id } });
    assert.ok(old.every((i) => i.initialMeasuredWeight.toFixed(4) === '1.3500'));
  });
  await test('DB-02: concurrent appraisers with the same header version have exactly one winner', async () => {
    const f = await fixture(1);
    const before = await header(f.id);
    const body = f.body(before.version);
    const r = await Promise.allSettled([
      svc.appraise(f.staff, f.branchId, f.id, f.items[0].id, randomUUID(), body),
      svc.appraise(f.colleague, f.branchId, f.id, f.items[0].id, randomUUID(), body),
    ]);
    assert.equal(r.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(r.find((r) => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
    assert.equal(await sales.buybackAppraisal.count({ where: { intakeId: f.id } }), 1);
    assert.equal((await header(f.id)).version, before.version + 1);
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPRAISED' } }),
      1,
    );
  });
  await test('DB-03: stale version cannot append another appraisal, request key or audit', async () => {
    const f = await fixture(1);
    const before = await header(f.id);
    await f.appraise();
    const key = randomUUID();
    await assert.rejects(
      svc.appraise(f.colleague, f.branchId, f.id, f.items[0].id, key, f.body(before.version)),
      (e) => e.code === 'VERSION_CONFLICT',
    );
    assert.equal(await sales.buybackAppraisal.count({ where: { intakeId: f.id } }), 1);
    assert.equal(
      await sales.buybackRequest.count({ where: { intakeId: f.id, idempotencyKey: key } }),
      0,
    );
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPRAISED' } }),
      1,
    );
  });
  await test('DB-04: quote uses exact Decimal buy rate, configured deduction, immutable line snapshots and total', async () => {
    const f = await fixture();
    await f.complete();
    const q = await f.quote();
    contracts.buybackQuoteSchema.parse(q);
    assert.equal(q.total, '4497000.00');
    assert.equal(q.lines.find((l) => l.itemId === f.items[0].id).amount, '2499000.00');
    assert.equal(q.lines.find((l) => l.itemId === f.items[1].id).amount, '1998000.00');
    assert.ok(
      q.lines.every(
        (l) =>
          l.unitPrice === '2000000.25' &&
          l.priceId === f.rate.id &&
          l.unit === 'VND_PER_CHI_ALLOY' &&
          l.policyVersion === 1,
      ),
    );
    const lines = await sales.buybackQuoteLine.findMany({ where: { quoteId: q.id } });
    assert.equal(
      lines
        .reduce(
          (sum, l) => sum.add(l.amount),
          new (salesRequire('./dist/generated/prisma/client.js').Prisma.Decimal)(0),
        )
        .toFixed(2),
      q.total,
    );
    await assert.rejects(
      sales.buybackQuoteLine.update({ where: { id: lines[0].id }, data: { amount: '1' } }),
    );
    assert.equal(
      (await sales.buybackQuote.findUniqueOrThrow({ where: { id: q.id } })).status,
      'QUOTED',
    );
  });
  await test('DB-05: policy/market changes between quote and approval preserve the approved snapshot', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    await svc.updatePolicy(f.admin, f.branchId, f.policy.id, {
      version: 1,
      label: 'New policy',
      deductionVndPerItem: '99999',
      isActive: true,
      reason: 'Synthetic policy revision after quote',
    });
    await inventory.metalPrice.create({
      data: {
        metalId: f.metal.id,
        buyPrice: '4000000',
        sellPrice: '5000000',
        effectiveFrom: new Date(Date.now() - 1),
        createdBy: f.admin.id,
      },
    });
    const approved = await f.approve(q);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.total, q.total);
    assert.deepEqual(approved.lines, q.lines);
    await assert.rejects(
      sales.buybackQuote.update({ where: { id: q.id }, data: { total: '999' } }),
    );
    assert.deepEqual((await svc.quotes(f.manager, f.branchId, f.id)).quotes[0].lines, q.lines);
  });
  await test('DB-06: changing appraisal supersedes the old quote; stale snapshot cannot be approved', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    await f.appraise(0, f.colleague);
    const h = await header(f.id);
    assert.equal(h.activeQuoteId, null);
    assert.equal(h.status, 'APPRAISED');
    assert.equal(
      (await sales.buybackQuote.findUniqueOrThrow({ where: { id: q.id } })).status,
      'SUPERSEDED',
    );
    await assert.rejects(f.approve(q), (e) => e.code === 'INVALID_STATE');
    assert.equal(
      await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'APPROVED' } }),
      0,
    );
    const newer = await f.quote();
    assert.notEqual(newer.lines[0].appraisalId, q.lines[0].appraisalId);
    assert.equal(
      await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'QUOTED' } }),
      1,
    );
  });
  await test('DB-07: concurrent managers approve once; one approval audit and effective approved quote', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    const before = await header(f.id);
    const r = await Promise.allSettled([
      f.approve(q, f.manager, randomUUID(), before.version),
      f.approve(q, f.secondManager, randomUUID(), before.version),
    ]);
    assert.equal(r.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(r.find((r) => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
    assert.equal((await header(f.id)).version, before.version + 1);
    assert.equal(
      await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'APPROVED' } }),
      1,
    );
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPROVED' } }),
      1,
    );
  });
  await test('DB-08: appraisal edit racing approval cannot approve data that was invalidated', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    const before = await header(f.id);
    const r = await Promise.allSettled([
      f.approve(q, f.manager, randomUUID(), before.version),
      svc.appraise(
        f.colleague,
        f.branchId,
        f.id,
        f.items[0].id,
        randomUUID(),
        f.body(before.version, '1.1000'),
      ),
    ]);
    assert.equal(r.filter((r) => r.status === 'fulfilled').length, 1);
    const h = await header(f.id),
      old = await sales.buybackQuote.findUniqueOrThrow({ where: { id: q.id } });
    if (h.status === 'APPROVED') {
      assert.equal(old.status, 'APPROVED');
      assert.equal(await sales.buybackAppraisal.count({ where: { intakeId: f.id } }), 1);
    } else {
      assert.equal(h.status, 'APPRAISED');
      assert.equal(old.status, 'SUPERSEDED');
      assert.equal(
        await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'APPROVED' } }),
        0,
      );
    }
  });
  await test('DB-09: STAFF, wrong branch and self-approval including ADMIN are denied without side effects', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    const before = await header(f.id);
    const foreign = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId: randomUUID() }] };
    for (const actor of [f.staff, foreign])
      await assert.rejects(f.approve(q, actor), (e) => e.code === 'FORBIDDEN');
    for (const actor of [
      { id: f.staff.id, branches: [{ role: 'MANAGER', branchId: f.branchId }] },
      { id: f.staff.id, branches: [{ role: 'ADMIN', branchId: null }] },
    ])
      await assert.rejects(
        f.approve(q, actor),
        (e) => e.code === 'BUYBACK_SEPARATE_APPROVER_REQUIRED',
      );
    assert.equal((await header(f.id)).version, before.version);
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPROVED' } }),
      0,
    );
  });
  await test('DB-10: audit failure rolls back quote decision, header version and idempotency request together', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    const before = await header(f.id),
      key = randomUUID();
    const faulty = new BuybackAppraisalService(
      {
        $transaction: (work, options) =>
          sales.$transaction(
            (tx) =>
              work(
                new Proxy(tx, {
                  get(target, prop) {
                    if (prop === 'buybackIntakeAudit')
                      return {
                        create: async () => {
                          throw new Error('PH72 injected audit failure');
                        },
                      };
                    return Reflect.get(target, prop);
                  },
                }),
              ),
            options,
          ),
      },
      prices,
    );
    await assert.rejects(
      faulty.decide(f.manager, f.branchId, f.id, q.id, key, { version: before.version }, true),
      /PH72 injected audit failure/,
    );
    const after = await header(f.id);
    assert.equal(after.version, before.version);
    assert.equal(after.status, 'APPRAISED');
    const row = await sales.buybackQuote.findUniqueOrThrow({ where: { id: q.id } });
    assert.equal(row.status, 'QUOTED');
    assert.equal(row.decidedBy, null);
    assert.equal(
      await sales.buybackRequest.count({ where: { intakeId: f.id, idempotencyKey: key } }),
      0,
    );
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPROVED' } }),
      0,
    );
  });
  await test('DB-11: retry approval after lost response returns original decision without duplicate audit', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote(),
      key = randomUUID(),
      before = await header(f.id);
    const first = await f.approve(q, f.manager, key, before.version);
    const retry = await f.approve(q, f.manager, key, before.version);
    assert.deepEqual(retry, first);
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'APPROVED' } }),
      1,
    );
    assert.equal(
      await sales.buybackRequest.count({
        where: { intakeId: f.id, actorId: f.manager.id, idempotencyKey: key },
      }),
      1,
    );
    await assert.rejects(
      f.approve(q, f.manager, key, before.version + 1),
      (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
    );
    assert.equal((await header(f.id)).version, before.version + 1);
  });
  await test('DB-12: APPROVED only records pricing approval; payment, orders, outbox and stock remain unchanged', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    const counts = async () =>
      Promise.all([
        sales.onlinePayment.count(),
        sales.order.count(),
        sales.outboxEvent.count(),
        inventory.jewelryItem.count(),
        inventory.goodsReceipt.count(),
        inventory.stockMovement.count(),
        inventory.outboxEvent.count(),
      ]);
    const before = await counts();
    await f.approve(q);
    assert.equal((await header(f.id)).status, 'APPROVED');
    assert.deepEqual(await counts(), before);
    await assert.rejects(f.appraise(0, f.colleague), (e) => e.code === 'INVALID_STATE');
    await assert.rejects(
      intakes.update(
        f.manager,
        f.branchId,
        f.id,
        contracts.updateBuybackSchema.parse({
          ...contracts.createBuybackSchema.parse({
            customer: { name: 'Test', phone: '0901234567' },
            items: [
              { source: 'EXTERNAL', assetKind: 'GOLD', description: 'Test', condition: 'Test' },
            ],
          }),
          version: (await header(f.id)).version,
        }),
      ),
      (e) => e.code === 'INVALID_STATE',
    );
  });
  await test('DB-13: incomplete/DRAFT/CANCELLED workflows cannot quote or approve; rejection records a reason', async () => {
    const f = await fixture(2);
    await f.appraise();
    await assert.rejects(f.quote(), (e) => e.code === 'BUYBACK_APPRAISAL_INCOMPLETE');
    assert.equal(await sales.buybackQuote.count({ where: { intakeId: f.id } }), 0);
    await f.appraise(1);
    const q = await f.quote();
    const h = await header(f.id);
    const rejected = await svc.decide(
      f.manager,
      f.branchId,
      f.id,
      q.id,
      randomUUID(),
      { version: h.version, reason: 'Test rejection after verified review' },
      false,
    );
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'Test rejection after verified review');
    assert.equal((await header(f.id)).status, 'REJECTED');
    await assert.rejects(f.appraise(), (e) => e.code === 'INVALID_STATE');
    await assert.rejects(f.approve(q), (e) => e.code === 'INVALID_STATE');
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'REJECTED' } }),
      1,
    );
    for (const code of ['PH72-COMPAT-1', 'PH72-COMPAT-3']) {
      const row = await sales.buybackIntake.findUniqueOrThrow({
        where: { code },
        include: { items: true },
      });
      const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
      await assert.rejects(
        svc.appraise(
          admin,
          row.branchId,
          row.id,
          row.items[0].id,
          randomUUID(),
          f.body(row.version),
        ),
        (e) => e.code === 'INVALID_STATE',
      );
      assert.equal(await sales.buybackAppraisal.count({ where: { intakeId: row.id } }), 0);
    }
  });
  await test('DB-14: missing Inventory buy price fails without a partial quote or invalidating existing appraisal', async () => {
    const f = await fixture(1);
    await f.complete();
    const before = await header(f.id);
    // Own synthetic source only; no sell-price fallback when the buy rate is absent.
    await inventory.metalPrice.delete({ where: { id: f.rate.id } });
    await assert.rejects(f.quote(), (e) => e.code === 'METAL_PRICE_NOT_SET');
    assert.equal(await sales.buybackQuote.count({ where: { intakeId: f.id } }), 0);
    assert.equal(
      await sales.buybackIntakeAudit.count({ where: { intakeId: f.id, action: 'QUOTED' } }),
      0,
    );
    assert.equal((await header(f.id)).version, before.version);
  });
  await test('DB-15: concurrent ADMIN policy revisions use CAS and retain one audit per version', async () => {
    const f = await fixture(1);
    const update = (deductionVndPerItem) =>
      svc.updatePolicy(f.admin, f.branchId, f.policy.id, {
        version: 1,
        label: 'Concurrent revision',
        deductionVndPerItem,
        isActive: true,
        reason: 'Test concurrent policy update',
      });
    const results = await Promise.allSettled([update('1000'), update('2000')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
    assert.equal(
      (await sales.buybackPricePolicy.findUniqueOrThrow({ where: { id: f.policy.id } })).version,
      2,
    );
    assert.equal(await sales.buybackPolicyAudit.count({ where: { policyId: f.policy.id } }), 2);
  });
  await test('DB-16: PostgreSQL enforces approval uniqueness, immutable headers, FKs and deferred quote totals', async () => {
    const f = await fixture(1);
    await f.complete();
    const q = await f.quote();
    await f.approve(q);
    await assert.rejects(
      sales.$executeRaw`INSERT INTO "sales"."BuybackQuote" (id,"intakeId","sourceVersion",status,currency,total,rounding,"requireSeparateApprover","quotedBy","quotedAt","decidedBy","decidedAt") SELECT ${randomUUID()}::uuid,"intakeId","sourceVersion",status,currency,total,rounding,"requireSeparateApprover","quotedBy","quotedAt","decidedBy","decidedAt" FROM "sales"."BuybackQuote" WHERE id=${q.id}::uuid`,
      (e) => JSON.stringify(e).includes('BuybackQuote_one_approved'),
    );
    await assert.rejects(
      sales.buybackIntake.update({ where: { id: f.id }, data: { version: { increment: 1 } } }),
    );
    await assert.rejects(
      sales.buybackRequest.create({
        data: {
          intakeId: randomUUID(),
          actorId: f.staff.id,
          idempotencyKey: randomUUID(),
          requestHash: 'a'.repeat(64),
          result: {},
        },
      }),
    );
    const other = await fixture(1);
    await other.complete();
    await assert.rejects(
      sales.$transaction((tx) =>
        tx.buybackQuote.create({
          data: {
            intakeId: other.id,
            sourceVersion: 3,
            total: '999',
            rounding: 'HALF_UP_1000_VND_PER_LINE',
            quotedBy: other.staff.id,
          },
        }),
      ),
    );
    assert.equal(await sales.buybackQuote.count({ where: { intakeId: other.id } }), 0);
    assert.equal(
      await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'APPROVED' } }),
      1,
    );
  });
  await test('DB-17: valid uppercase item/policy/quote UUIDs identify the same records', async () => {
    const f = await fixture(1);
    await f.complete();
    const source = await prices.current(f.metal.id.toUpperCase());
    assert.equal(source.metalId.toLowerCase(), f.metal.id);
    const q = await svc.quote(f.staff, f.branchId, f.id, randomUUID(), {
      version: (await header(f.id)).version,
      items: [
        {
          itemId: f.items[0].id.toUpperCase(),
          policyId: f.policy.id.toUpperCase(),
          policyVersion: 1,
        },
      ],
    });
    const approved = await svc.decide(
      f.manager,
      f.branchId,
      f.id,
      q.id.toUpperCase(),
      randomUUID(),
      { version: (await header(f.id)).version },
      true,
    );
    assert.equal(approved.id, q.id);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(
      await sales.buybackQuote.count({ where: { intakeId: f.id, status: 'APPROVED' } }),
      1,
    );
  });
} finally {
  if (httpApp) await httpApp.close();
  await inventory.$disconnect();
  await sales.$disconnect();
}
