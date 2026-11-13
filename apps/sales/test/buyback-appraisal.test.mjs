import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  appraisalInputSchema,
  buybackPuritySchema,
  buybackQuoteInputSchema,
  buybackDecisionSchema,
  rejectBuybackQuoteSchema,
  createBuybackPolicySchema,
  updateBuybackPolicySchema,
} from '@jewelry/contracts';
import { Prisma } from '../dist/generated/prisma/client.js';
import { priceBuybackLine } from '../dist/buybacks/buyback-pricing.js';
import { BuybackAppraisalService } from '../dist/buybacks/buyback-appraisal.service.js';
import { BuybackAppraisalController } from '../dist/buybacks/buyback-appraisal.controller.js';
import { InternalBuybackPriceController } from '../../inventory/dist/catalog/internal-buyback-price.controller.js';
import { MetalsService } from '../../inventory/dist/catalog/metals.service.js';
const id = randomUUID(),
  branch = randomUUID();
const input = {
  version: 2,
  measuredWeight: '1.2500',
  acceptedWeight: '1.2000',
  metalId: id,
  metalKind: 'GOLD',
  purityPerMille: '750.0000',
  condition: 'Đã kiểm định',
};
const d = (s) => new Prisma.Decimal(s);

test('7.2 appraisal validates precise weight/purity and rejects client actor/state/price', () => {
  assert.equal(appraisalInputSchema.parse(input).notes, null);
  for (const field of ['measuredWeight', 'acceptedWeight', 'purityPerMille'])
    for (const value of [1, 'NaN', 'Infinity', '1e2', '-1', '0', '1.00001'])
      assert.equal(
        appraisalInputSchema.safeParse({ ...input, [field]: value }).success,
        false,
        `${field} invalid numeric`,
      );
  for (const extra of [
    { actorId: id },
    { branchId: branch },
    { status: 'APPROVED' },
    { unitPrice: '1' },
    { appraisedAt: new Date().toISOString() },
  ])
    assert.equal(appraisalInputSchema.safeParse({ ...input, ...extra }).success, false);
  assert.equal(
    appraisalInputSchema.safeParse({ ...input, acceptedWeight: '1.2501' }).success,
    false,
  );
});
test('7.2 fineness is explicit per mille, never a floating point or inferred karat', () => {
  for (const v of ['750', '999.9', '1000.0000', '0.0001'])
    assert.equal(buybackPuritySchema.safeParse(v).success, true);
  for (const v of ['1000.0001', '18K', '75%', '-1'])
    assert.equal(buybackPuritySchema.safeParse(v).success, false);
});
test('7.2 policy needs explicit deduction and source mapping; no client market price', () => {
  const p = {
    metalId: id,
    metalKind: 'GOLD',
    purityPerMille: '750',
    label: 'Test 18K',
    deductionVndPerItem: '0',
    reason: 'Policy được cấu hình',
  };
  assert.ok(createBuybackPolicySchema.safeParse(p).success);
  for (const bad of [
    { ...p, deductionVndPerItem: undefined },
    { ...p, buyPrice: '123' },
    { ...p, deductionVndPerItem: '-1' },
    { ...p, requireSeparateApprover: false },
  ])
    assert.equal(createBuybackPolicySchema.safeParse(bad).success, false);
  assert.equal(
    updateBuybackPolicySchema.safeParse({ ...p, version: 1, isActive: true }).success,
    false,
  ); // Identity mapping cannot be changed in-place.
});
test('7.2 quote/decision DTOs reject duplicate lines, price injection and reasonless rejection', () => {
  const item = { itemId: id, policyId: randomUUID(), policyVersion: 1 };
  assert.equal(buybackQuoteInputSchema.safeParse({ version: 3, items: [item] }).success, true);
  assert.equal(
    buybackQuoteInputSchema.safeParse({ version: 3, items: [item, item] }).success,
    false,
  );
  assert.equal(
    buybackQuoteInputSchema.safeParse({ version: 3, items: [{ ...item, amount: '1' }] }).success,
    false,
  );
  assert.equal(buybackDecisionSchema.safeParse({ version: 1, actorId: id }).success, false);
  assert.equal(rejectBuybackQuoteSchema.safeParse({ version: 1, reason: ' ' }).success, false);
});
test('7.2 buyback math uses alloy buy price exactly once and explicit fixed VND deduction', () => {
  assert.equal(priceBuybackLine(d('1.25'), d('2000000'), d('1500')).toFixed(2), '2499000.00');
  assert.equal(priceBuybackLine(d('1.25'), d('2000000'), d('0')).toFixed(2), '2500000.00');
});
test('7.2 rounding is HALF_UP per line, including exact tie and sub-threshold values', () => {
  assert.equal(priceBuybackLine(d('1'), d('1499.99'), d('0')).toFixed(2), '1000.00');
  assert.equal(priceBuybackLine(d('1'), d('1500'), d('0')).toFixed(2), '2000.00');
  const two = priceBuybackLine(d('1'), d('500'), d('0')).mul(2);
  assert.equal(two.toFixed(2), '2000.00'); // Total is the sum of rounded lines.
});
test('7.2 Decimal math preserves digits near large half-thousand boundaries', () => {
  const weight = d('12345678.9999'),
    price = d('12345678.99'),
    deduction = d('123.45');
  // Independently calculated with Python decimal at precision 48.
  assert.equal(priceBuybackLine(weight, price, deduction).toFixed(2), '152415789846000.00');
});
test('7.2 negative net/invalid inputs/storage overflow fail without a fabricated payout', () => {
  for (const args of [
    ['1', '1000', '1001'],
    ['0', '1000', '0'],
    ['1', '0', '0'],
    ['1', '1000', '-1'],
    ['NaN', '1000', '0'],
    ['1', 'Infinity', '0'],
    ['99999999', '9999999999999', '0'],
  ])
    assert.throws(
      () => priceBuybackLine(...args.map(d)),
      (e) => e.code === 'BUYBACK_PRICE_INVALID',
    );
});
test('7.2 forbidden role/branch is rejected before accessing DB or price provider', async () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected DB access');
      },
    },
  );
  const svc = new BuybackAppraisalService(db, db);
  const staff = { id, branches: [{ role: 'STAFF', branchId: branch }] };
  const other = { id, branches: [{ role: 'MANAGER', branchId: randomUUID() }] };
  const p = {
    metalId: id,
    metalKind: 'GOLD',
    purityPerMille: '750',
    label: 'Test',
    deductionVndPerItem: '0',
    reason: 'Test policy',
  };
  await assert.rejects(svc.createPolicy(staff, branch, 'key', p), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(
    svc.decide(staff, branch, id, id, 'key', { version: 1 }, true),
    (e) => e.code === 'FORBIDDEN',
  );
  await assert.rejects(
    svc.decide(other, branch, id, id, 'key', { version: 1 }, true),
    (e) => e.code === 'FORBIDDEN',
  );
});
test('7.2 controller decision/config roles and private cache headers are present', () => {
  assert.deepEqual(
    Reflect.getMetadata('jewelry:roles', BuybackAppraisalController.prototype.approve),
    ['ADMIN', 'MANAGER'],
  );
  assert.deepEqual(
    Reflect.getMetadata('jewelry:roles', BuybackAppraisalController.prototype.createPolicy),
    ['ADMIN'],
  );
  for (const name of [
    'policies',
    'createPolicy',
    'updatePolicy',
    'get',
    'appraise',
    'quote',
    'quotes',
    'approve',
    'reject',
  ]) {
    const headers = Reflect.getMetadata('__headers__', BuybackAppraisalController.prototype[name]);
    assert.ok(headers.some((h) => h.name === 'Cache-Control' && h.value === 'no-store'));
  }
  assert.equal(
    Reflect.getMetadata('path', InternalBuybackPriceController),
    'internal/buyback-prices',
  );
});
test('7.2 Inventory source returns buy price with source identity, never sell price', async () => {
  const price = {
    id: randomUUID(),
    metalId: id,
    buyPrice: d('1234567.89'),
    sellPrice: d('2345678.90'),
    effectiveFrom: new Date(Date.now() - 1000),
  };
  const tx = {
    metal: { findUnique: async () => ({ id, code: 'TEST-18K', kind: 'GOLD', isActive: true }) },
    $queryRaw: async (strings) =>
      strings.join('').includes('MetalPrice') ? [price] : [{ now: new Date() }],
  };
  const service = new MetalsService({ $transaction: async (f) => f(tx) });
  const result = await service.buybackPrice(id);
  assert.equal(result.buyPricePerChi, '1234567.89');
  assert.equal(result.priceId, price.id);
  assert.equal(result.unit, 'VND_PER_CHI_ALLOY');
  assert.ok(!('sellPrice' in result));
});
test('7.2 Inventory missing rate fails; no default market quote is supplied', async () => {
  const tx = {
    metal: { findUnique: async () => ({ id, kind: 'GOLD', isActive: true }) },
    $queryRaw: async () => [],
  };
  await assert.rejects(
    new MetalsService({ $transaction: async (f) => f(tx) }).buybackPrice(id),
    (e) => e.code === 'METAL_PRICE_NOT_SET',
  );
});
