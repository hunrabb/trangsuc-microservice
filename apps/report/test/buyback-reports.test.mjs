import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../dist/generated/prisma/client.js';
import { BuybackReportsService } from '../dist/buybacks/buyback-reports.service.js';

test('stock arriving on a later date still reconciles against the original settlement snapshot', async () => {
  const settlementId = randomUUID(),
    branchId = randomUUID(),
    quoteLineId = randomUUID();
  const intakeItemId = randomUUID(),
    metalId = randomUUID(),
    warehouseId = randomUUID();
  const line = {
    quoteLineId,
    intakeItemId,
    metalId,
    metalKind: 'GOLD',
    acceptedWeight: '1.0000',
    purityPerMille: '750.0000',
    amount: '1000.00',
  };
  const settlement = {
    settlementId,
    branchId,
    localDate: '2026-11-08',
    kind: 'DIRECT',
    expectedItems: 1,
    approvedAmount: new Prisma.Decimal('1000.00'),
    amountDue: new Prisma.Decimal('1000.00'),
    direction: 'STORE_PAYS',
    snapshot: {
      version: 1,
      settlementId,
      intakeId: randomUUID(),
      quoteId: randomUUID(),
      branchId,
      kind: 'DIRECT',
      approvedAmount: '1000.00',
      saleAmount: null,
      direction: 'STORE_PAYS',
      amountDue: '1000.00',
      settledAt: '2026-11-08T12:00:00.000Z',
      confirmedBy: randomUUID(),
      createdBy: randomUUID(),
      lines: [line],
    },
  };
  const stock = {
    settlementId,
    branchId,
    warehouseId,
    receiptId: settlementId,
    localDate: '2026-11-09',
    itemCount: 1,
    costValue: new Prisma.Decimal('1000.00'),
    snapshot: {
      version: 1,
      settlementId,
      branchId,
      warehouseId,
      receiptId: settlementId,
      receivedAt: '2026-11-09T12:00:00.000Z',
      approvedAmount: '1000.00',
      items: [
        {
          ...line,
          acceptedWeight: '2.0000',
          jewelryItemId: quoteLineId,
          tagCode: `BB-${quoteLineId}`,
        },
      ],
    },
  };
  const db = {
    buybackSettlementFact: { findMany: async ({ where }) => (where.localDate ? [] : [settlement]) },
    buybackStockFact: {
      findMany: async ({ where }) => (where.localDate ? [stock] : []),
      aggregate: async () => ({
        _sum: { costValue: new Prisma.Decimal('1000.00') },
        _count: { _all: 1 },
      }),
    },
  };
  const report = await new BuybackReportsService(db).summary({
    from: '2026-11-09',
    to: '2026-11-09',
    branchId,
  });
  assert.deepEqual(report.reconciliation, [{ settlementId, branchId, state: 'MISMATCH' }]);
  assert.equal(report.rows[0].receivedAssetValue, '1000.00');
  assert.equal(report.rows[0].purchaseValue, '0.00');
});
