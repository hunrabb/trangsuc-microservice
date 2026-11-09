import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Decimal } from '@prisma/client/runtime/client';
import {
  OnlinePaymentsService,
  assertOnlinePaymentRole,
  emitOnlinePaid,
} from '../dist/payments/online-payments.service.js';
import { onPaymentInventoryResult } from '../dist/payments/payment-inventory-events.js';
import { recoverOnlinePayment } from '../dist/payments/payment-recovery.js';
import { OnlineRecoveryWorker } from '../dist/online/online-recovery.worker.js';
import { OnlineOrdersService } from '../dist/online/online-orders.service.js';
import { confirmOnlinePaymentSchema, EVENT_PAYLOAD_SCHEMAS } from '@jewelry/contracts';
const branchId = randomUUID(),
  actor = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId }] };
const receipt = () => ({
  amount: '1000.00',
  currency: 'VND',
  bankTxnRef: `BANK/ACCOUNT/${randomUUID()}`,
  evidenceRef: 'statement/verified-line-1',
});
function fixture(overrides = {}) {
  const order = {
    id: randomUUID(),
    branchId,
    reservationId: randomUUID(),
    total: new Decimal(1000),
    status: 'AWAITING_PAYMENT',
    activePaymentId: null,
    paymentAttempts: 0,
    expiresAt: new Date(Date.now() + 1800000),
    deadlineAt: new Date(Date.now() + 1800000),
    needsReview: false,
    ...overrides,
  };
  const payments = new Map(),
    keys = new Map(),
    events = [],
    audit = [];
  const copy = (row) => (row ? { ...row } : null);
  const findPayment = (where) =>
    [...payments.values()].find((p) =>
      Object.entries(where).every(([key, value]) => p[key] === value),
    );
  const keyOf = (obj) => `${obj.actorId}:${obj.idempotencyKey}`;
  const tx = {
    $queryRaw: async (strings) =>
      strings.join('?').includes('clock_timestamp') ? [{ now: new Date() }] : [{ id: order.id }],
    onlineOrder: {
      findUnique: async () => copy(order),
      findUniqueOrThrow: async () => copy(order),
      update: async ({ data }) => {
        const { paymentAttempts, ...rest } = data;
        Object.assign(order, rest);
        if (paymentAttempts) order.paymentAttempts += paymentAttempts.increment;
        return copy(order);
      },
    },
    onlinePayment: {
      findUnique: async ({ where }) => copy(findPayment(where)),
      findUniqueOrThrow: async ({ where }) => {
        const row = findPayment(where);
        assert.ok(row);
        return copy(row);
      },
      findFirst: async ({ where }) => copy(findPayment(where)),
      findMany: async ({ take }) => {
        assert.equal(take, 50);
        return [...payments.values()].map(copy);
      },
      create: async ({ data }) => {
        const row = { inventoryVersion: 0, ...data, amount: new Decimal(data.amount) };
        payments.set(row.id, row);
        return copy(row);
      },
      update: async ({ where, data }) => {
        const row = payments.get(where.id);
        Object.assign(row, data);
        return copy(row);
      },
    },
    onlinePaymentRequest: {
      findUnique: async ({ where }) => {
        const row = keys.get(keyOf(where.actorId_idempotencyKey));
        return row ? { ...row, payment: copy(payments.get(row.paymentId)) } : null;
      },
      findUniqueOrThrow: async (args) => {
        const row = await tx.onlinePaymentRequest.findUnique(args);
        assert.ok(row);
        return row;
      },
      create: async ({ data }) => {
        keys.set(keyOf(data), data);
        return data;
      },
      upsert: async ({ where, create }) => {
        const key = keyOf(where.actorId_idempotencyKey);
        if (!keys.has(key)) keys.set(key, create);
        return keys.get(key);
      },
    },
    onlinePaymentAudit: {
      create: async ({ data }) => {
        audit.push(data);
      },
    },
    outboxEvent: {
      create: async ({ data }) => {
        events.push(data);
      },
    },
  };
  const prisma = { ...tx, $transaction: async (cb) => cb(tx) };
  return {
    order,
    payments,
    keys,
    events,
    audit,
    tx,
    prisma,
    service: new OnlinePaymentsService(prisma),
  };
}
const confirm = (f, body = receipt(), key = 'key') =>
  f.service.confirm(actor, branchId, f.order.id, key, body);
function result(f, paymentId, overrides = {}) {
  return {
    channel: 'WEBSITE',
    orderId: f.order.id,
    reservationId: f.order.reservationId,
    paymentId,
    amount: '1000.00',
    currency: 'VND',
    version: 1,
    outcome: 'CONFIRMED',
    reason: null,
    holdUntil: new Date(Date.now() + 259200000).toISOString(),
    ...overrides,
  };
}

test('only ADMIN/global or MANAGER actual branch can verify money; customer/STAFF cannot', async () => {
  const f = fixture();
  assert.doesNotThrow(() => assertOnlinePaymentRole(actor, branchId));
  assert.doesNotThrow(() =>
    assertOnlinePaymentRole({ id: actor.id, branches: [{ role: 'ADMIN', branchId: null }] }, null),
  );
  for (const branches of [
    [],
    [{ role: 'STAFF', branchId }],
    [{ role: 'MANAGER', branchId: randomUUID() }],
  ]) {
    await assert.rejects(
      f.service.confirm({ id: actor.id, branches }, branchId, f.order.id, 'x', receipt()),
      (e) => e.code === 'FORBIDDEN',
    );
  }
  assert.equal(f.payments.size, 0);
  assert.equal(f.events.length, 0);
});
test('valid manual bank evidence records money, audit and order.paid; order awaits Inventory, never completes', async () => {
  const f = fixture(),
    view = await confirm(f);
  assert.equal(view.status, 'RECEIVED');
  assert.equal(f.order.status, 'PAYMENT_PROCESSING');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].eventType, 'order.paid');
  assert.equal(f.events[0].payload.paymentId, view.id);
  assert.equal(f.audit[0].actorId, actor.id);
  assert.equal('bankTxnRef' in view, false);
  assert.equal('evidenceRef' in view, false);
  assert.equal(JSON.stringify(f.events[0].payload).includes('statement/'), false);
});
test('wrong amount, currency and extra frontend state cannot confirm or emit paid', async () => {
  const f = fixture();
  await assert.rejects(
    confirm(f, { ...receipt(), amount: '999.00' }),
    (e) => e.code === 'PAYMENT_AMOUNT_MISMATCH',
  );
  for (const body of [
    { ...receipt(), currency: 'USD' },
    { ...receipt(), amount: '0.00' },
    { ...receipt(), status: 'PAID' },
  ])
    assert.equal(confirmOnlinePaymentSchema.safeParse(body).success, false);
  assert.equal(f.payments.size, 0);
  assert.equal(f.events.length, 0);
});
test('retry same key or duplicate bank transaction has one receipt/outbox; alias keys remain bound', async () => {
  const f = fixture(),
    body = receipt(),
    a = await confirm(f, body);
  assert.equal((await confirm(f, body)).id, a.id);
  assert.equal((await confirm(f, body, 'alias')).id, a.id);
  await assert.rejects(
    confirm(f, { ...body, bankTxnRef: 'DIFFERENT' }, 'alias'),
    (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  await assert.rejects(
    confirm(f, { ...body, evidenceRef: 'changed-evidence' }),
    (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(f.payments.size, 1);
  assert.equal(f.events.length, 1);
});
test('one bank transaction cannot be reassigned to a different order', async () => {
  const f = fixture(),
    body = receipt();
  await confirm(f, body);
  f.order.id = randomUUID();
  await assert.rejects(
    confirm(f, body, 'different-order'),
    (e) => e.code === 'PAYMENT_REFERENCE_CONFLICT',
  );
  assert.equal(f.payments.size, 1);
});
test('late/cancelled/expired payment is saved for refund; never revives order or emits paid', async () => {
  for (const overrides of [{ status: 'CANCELLED' }, { expiresAt: new Date(Date.now() - 1) }]) {
    const f = fixture(overrides),
      payment = await confirm(f);
    assert.equal(payment.status, 'REFUND_PENDING');
    assert.equal(f.order.status, 'REFUND_PENDING');
    assert.equal(f.events.length, 0);
    assert.ok(f.payments.get(payment.id).receivedAt instanceof Date);
  }
});
test('second real transfer gets refund pending without changing the original paid order', async () => {
  const f = fixture(),
    first = await confirm(f);
  await onPaymentInventoryResult(result(f, first.id), f);
  const second = await confirm(f, receipt(), 'second-transfer');
  assert.equal(second.status, 'REFUND_PENDING');
  assert.equal(f.order.activePaymentId, first.id);
  assert.equal(f.order.status, 'CONFIRMED');
  assert.equal(f.events.length, 1);
  assert.equal(f.payments.size, 2);
});
test('Inventory confirmation is required to confirm order; callback replay does not change final state', async () => {
  const f = fixture(),
    payment = await confirm(f),
    event = result(f, payment.id);
  await onPaymentInventoryResult(event, f);
  const audits = f.audit.length;
  await onPaymentInventoryResult(event, f);
  assert.equal(f.order.status, 'CONFIRMED');
  assert.equal(f.payments.get(payment.id).status, 'INVENTORY_CONFIRMED');
  assert.equal(f.audit.length, audits);
  assert.notEqual(f.order.status, 'COMPLETED');
});
test('Inventory expiry/rejection after real receipt becomes reconciliation; no automatic release/refund success', async () => {
  const f = fixture(),
    payment = await confirm(f);
  await onPaymentInventoryResult(
    result(f, payment.id, { outcome: 'REJECTED', reason: 'RESERVATION_EXPIRED', holdUntil: null }),
    f,
  );
  assert.equal(f.order.status, 'PAYMENT_REVIEW');
  assert.equal(f.payments.get(payment.id).status, 'RECONCILIATION_REQUIRED');
  assert.equal(
    f.events.some((e) => e.eventType === 'order.cancelled'),
    false,
  );
});
test('version gate prevents old confirmed callback overriding a newer paid-hold review', async () => {
  const f = fixture(),
    payment = await confirm(f);
  await onPaymentInventoryResult(
    result(f, payment.id, {
      version: 2,
      outcome: 'REJECTED',
      reason: 'PAID_HOLD_EXPIRED',
      holdUntil: null,
    }),
    f,
  );
  await onPaymentInventoryResult(result(f, payment.id), f);
  assert.equal(f.order.status, 'PAYMENT_REVIEW');
  assert.equal(f.payments.get(payment.id).inventoryVersion, 2);
});
test('refund is only requested, is idempotent, and a late Inventory callback cannot mark it confirmed/refunded', async () => {
  const f = fixture(),
    payment = await confirm(f);
  const refund = await f.service.requestRefund(
    actor,
    branchId,
    f.order.id,
    payment.id,
    'verified refund request',
  );
  const audits = f.audit.length;
  await f.service.requestRefund(actor, branchId, f.order.id, payment.id, 'same request');
  await onPaymentInventoryResult(result(f, payment.id), f);
  assert.equal(refund.status, 'REFUND_PENDING');
  assert.equal(f.order.status, 'REFUND_PENDING');
  assert.equal(f.payments.get(payment.id).status, 'REFUND_PENDING');
  assert.equal(f.audit.length, audits + 1);
  assert.equal(f.events.length, 1);
  assert.equal(JSON.stringify(refund).includes('REFUNDED'), false);
});
test('timeout keeps received money; bounded recovery replays same payment then parks for reconciliation', async () => {
  const f = fixture(),
    payment = await confirm(f);
  f.order.expiresAt = new Date(Date.now() - 1);
  for (let n = 0; n < 6; n++) await recoverOnlinePayment(f.tx, { ...f.order }, new Date());
  assert.equal(f.order.paymentAttempts, 5);
  assert.equal(f.order.status, 'PAYMENT_REVIEW');
  assert.equal(f.payments.get(payment.id).status, 'RECONCILIATION_REQUIRED');
  assert.equal(f.events.length, 6);
  assert.ok(f.events.every((e) => e.payload.paymentId === payment.id));
  assert.equal(
    f.events.some((e) => e.eventType === 'order.cancelled'),
    false,
  );
});
test('worker handles payment processing before unpaid expiration, including restart after DB outage', async () => {
  const f = fixture(),
    payment = await confirm(f);
  f.order.deadlineAt = new Date(0);
  let due = true,
    failed = true;
  const original = f.tx.$queryRaw;
  f.tx.$queryRaw = async (strings, ...values) => {
    if (strings.join('?').includes('SKIP LOCKED')) {
      assert.match(strings.join('?'), /PAYMENT_PROCESSING/);
      if (due) {
        due = false;
        return [{ id: f.order.id }];
      }
      return [];
    }
    return original(strings, ...values);
  };
  const worker = new OnlineRecoveryWorker({
    $transaction: async (cb) => {
      if (failed) {
        failed = false;
        throw new Error('simulated DB outage');
      }
      return cb(f.tx);
    },
  });
  await worker.scan();
  await worker.scan();
  assert.equal(f.order.status, 'PAYMENT_PROCESSING');
  assert.equal(f.events.at(-1).payload.paymentId, payment.id);
});
test('no order.paid can be emitted without recorded matching received money', async () => {
  const f = fixture();
  await assert.rejects(
    emitOnlinePaid(f.tx, f.order, {
      id: randomUUID(),
      status: 'REFUND_PENDING',
      amount: new Decimal(1000),
    }),
    /snapshot hợp lệ/,
  );
  assert.equal(f.events.length, 0);
});
test('customer cancellation cannot cancel or release money already received', async () => {
  const f = fixture();
  await confirm(f);
  await assert.rejects(
    new OnlineOrdersService(f.prisma).cancel(`Checkout ${'a'.repeat(64)}`, f.order.id),
    (e) => e.code === 'INVALID_STATE',
  );
  assert.equal(f.events.length, 1);
});
test('payment handler rejects wrong amount/currency/order identity from callback before state changes', async () => {
  const f = fixture(),
    payment = await confirm(f);
  await assert.rejects(
    onPaymentInventoryResult(result(f, payment.id, { amount: '999.00' }), f),
    /không khớp/,
  );
  assert.equal(f.order.status, 'PAYMENT_PROCESSING');
  const pos = {
    channel: 'POS',
    orderId: randomUUID(),
    branchId,
    code: 'POS',
    total: '1000.00',
    tagCodes: ['T'],
    paidAt: new Date().toISOString(),
    items: [
      {
        tagCode: 'T',
        variantId: null,
        metalId: null,
        productName: 'R',
        metalWeight: '1.0000',
        price: '1000.00',
        costPrice: null,
      },
    ],
  };
  assert.equal(EVENT_PAYLOAD_SCHEMAS['order.paid'].safeParse(pos).success, true);
});

test('payment HTTP controller has no Public marker and restricts confirmation/refund request to staff roles', async () => {
  const { OnlinePaymentsController } =
    await import('../dist/payments/online-payments.controller.js');
  assert.equal(Reflect.getMetadata('jewelry:isPublic', OnlinePaymentsController), undefined);
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', OnlinePaymentsController), [
    'ADMIN',
    'MANAGER',
  ]);
  assert.equal('confirmRefund' in OnlinePaymentsController.prototype, false);
});
