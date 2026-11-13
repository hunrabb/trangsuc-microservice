import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../dist/generated/prisma/client.js';
import {
  createSettlementSchema,
  createExchangeSchema,
  recordSettlementPaymentSchema,
  confirmSettlementPaymentSchema,
  cancelSettlementSchema,
} from '@jewelry/contracts';
import { BuybackSettlementService } from '../dist/buybacks/buyback-settlement.service.js';

test('7.3 DTO rejects client-controlled amount, status and actor', () => {
  assert.ok(createSettlementSchema.safeParse({ version: 1, method: 'CASH' }).success);
  assert.ok(
    createExchangeSchema.safeParse({ version: 1, method: 'BANK_TRANSFER', tagCode: 'RING-1' })
      .success,
  );
  for (const body of [
    { version: 1, method: 'CASH', approvedAmount: '1.00' },
    { version: 1, method: 'CASH', status: 'SETTLED' },
    { version: 1, method: 'CASH', actorId: randomUUID() },
    { version: 1, method: 'CASH', tagCode: '' },
  ]) {
    const schema = 'tagCode' in body ? createExchangeSchema : createSettlementSchema;
    assert.equal(schema.safeParse(body).success, false);
  }
});

test('7.3 human payment evidence and separate confirmation have mandatory fields', () => {
  assert.equal(
    recordSettlementPaymentSchema.safeParse({ version: 1, reference: 'RCPT-123', evidence: '  ' })
      .success,
    false,
  );
  assert.equal(
    confirmSettlementPaymentSchema.safeParse({
      version: 1,
      verificationReference: 'VERIFY-123',
      note: ' ',
    }).success,
    false,
  );
  assert.equal(
    confirmSettlementPaymentSchema.safeParse({
      version: 1,
      verificationReference: 'VERIFY-123',
      note: 'Cash counted and handover verified',
      paid: true,
    }).success,
    false,
  );
  assert.ok(
    cancelSettlementSchema.safeParse({ version: 1, reason: 'Customer withdrew before payment' })
      .success,
  );
  assert.equal(cancelSettlementSchema.safeParse({ version: 1, reason: ' ' }).success, false);
});

test('7.3 exchange difference keeps positive, negative and zero exact in Decimal', () => {
  for (const [sale, buy, expected] of [
    ['18000000.00', '12000000.00', ['CUSTOMER_PAYS', '6000000.00']],
    ['6000000.00', '12000000.00', ['STORE_PAYS', '6000000.00']],
    ['12000000.00', '12000000.00', ['NONE', '0.00']],
  ]) {
    const difference = new Prisma.Decimal(sale).sub(buy);
    const direction = difference.gt(0) ? 'CUSTOMER_PAYS' : difference.lt(0) ? 'STORE_PAYS' : 'NONE';
    assert.deepEqual([direction, difference.abs().toFixed(2)], expected);
  }
});

test('7.3 confirmation rejects STAFF and out-of-branch MANAGER before database access', async () => {
  const branchId = randomUUID(),
    intakeId = randomUUID(),
    settlementId = randomUUID();
  const service = new BuybackSettlementService(
    {
      $transaction: () => {
        throw new Error('DB must not be reached');
      },
    },
    {},
  );
  const body = {
    version: 1,
    verificationReference: 'VERIFY-123',
    note: 'Cash counted and handover verified',
  };
  for (const user of [
    { id: randomUUID(), branches: [{ role: 'STAFF', branchId }] },
    { id: randomUUID(), branches: [{ role: 'MANAGER', branchId: randomUUID() }] },
  ]) {
    await assert.rejects(
      service.confirm(user, branchId, intakeId, settlementId, randomUUID(), body),
      (error) => error.code === 'FORBIDDEN',
    );
  }
});
