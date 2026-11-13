import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { Prisma } from '../dist/generated/prisma/client.js';
import { BuybacksService } from '../dist/buybacks/buybacks.service.js';
import { BuybacksController } from '../dist/buybacks/buybacks.controller.js';
import { RolesGuard, ZodValidationPipe } from '@jewelry/common';
import { Reflector } from '@nestjs/core';
import {
  buybackDetailSchema,
  buybackPageSchema,
  buybackQuerySchema,
  createBuybackSchema,
  updateBuybackSchema,
  submitBuybackSchema,
  cancelBuybackSchema,
  idempotencyKeySchema,
  salesOpenApiSchemas,
} from '@jewelry/contracts';

const branch = randomUUID(),
  otherBranch = randomUUID();
const staff = { id: randomUUID(), branches: [{ role: 'STAFF', branchId: branch }] };
const another = { id: randomUUID(), branches: staff.branches };
const manager = { id: randomUUID(), branches: [{ role: 'MANAGER', branchId: branch }] };
const admin = { id: randomUUID(), branches: [{ role: 'ADMIN', branchId: null }] };
const payload = () => ({
  customer: { name: 'Khách thử', phone: '+84 912 345 678' },
  items: [
    {
      source: 'EXTERNAL',
      assetKind: 'GOLD',
      description: 'Nhẫn cũ',
      condition: 'Trầy nhẹ',
      declaredWeight: '1.2000',
      initialMeasuredWeight: '1.1500',
      declaredPurity: 'Khách khai 18K',
    },
  ],
});
const input = () => createBuybackSchema.parse(payload());
const clone = (value) =>
  value === null || typeof value !== 'object' || value instanceof Prisma.Decimal
    ? value
    : value instanceof Date
      ? new Date(value)
      : Array.isArray(value)
        ? value.map(clone)
        : Object.fromEntries(Object.entries(value).map(([key, val]) => [key, clone(val)]));
const unique = (index) => ({
  code: 'P2002',
  meta: { driverAdapterError: { cause: { constraint: { index } } } },
});

/** Unit fake: chỉ cho phép truy cập 4 model intake/customer, KHÔNG mô phỏng khoá PostgreSQL. */
function setup() {
  const db = {
    rows: [],
    items: [],
    audits: [],
    customers: [],
    calls: [],
    hideKeyOnce: false,
    failAudit: false,
    failCas: false,
  };
  const match = (row, where) =>
    Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      if (key === 'receivedAt')
        return (
          (!value.gte || row.receivedAt >= value.gte) && (!value.lte || row.receivedAt <= value.lte)
        );
      return row[key] === value;
    });
  const line = (item, intakeId) => ({
    ...clone(item),
    intakeId,
    id: randomUUID(),
    declaredWeight: item.declaredWeight === null ? null : new Prisma.Decimal(item.declaredWeight),
    initialMeasuredWeight:
      item.initialMeasuredWeight === null ? null : new Prisma.Decimal(item.initialMeasuredWeight),
  });
  const audit = (data) => {
    if (db.failAudit) throw new Error('audit unavailable');
    db.audits.push({
      id: randomUUID(),
      fromStatus: null,
      fromVersion: null,
      createdAt: new Date(),
      ...clone(data),
    });
  };
  const decorate = (row, include) =>
    row
      ? {
          ...clone(row),
          ...(include?.items
            ? {
                items: clone(
                  db.items
                    .filter((i) => i.intakeId === row.id)
                    .sort((a, b) => a.position - b.position),
                ),
                audit: clone(
                  db.audits
                    .filter((a) => a.intakeId === row.id)
                    .sort((a, b) => b.toVersion - a.toVersion)
                    .slice(0, 50),
                ),
              }
            : {}),
          ...(include?._count
            ? { _count: { items: db.items.filter((i) => i.intakeId === row.id).length } }
            : {}),
        }
      : null;
  const tx = {
    $executeRaw: async (...args) => {
      db.calls.push(['timeout', args]);
      return 0;
    },
    $queryRaw: async (...args) => {
      db.calls.push(['lock', args]);
      return [];
    },
    customer: {
      findUnique: async ({ where }) => clone(db.customers.find((c) => c.id === where.id) ?? null),
    },
    buybackIntake: {
      findUnique: async ({ where }) => {
        if (db.hideKeyOnce) {
          db.hideKeyOnce = false;
          return null;
        }
        return decorate(
          db.rows.find((row) => match(row, where.branchId_createdBy_idempotencyKey)),
          undefined,
        );
      },
      findFirst: async ({ where, include }) =>
        decorate(
          db.rows.find((row) => match(row, where)),
          include,
        ),
      count: async ({ where }) => db.rows.filter((row) => match(row, where)).length,
      findMany: async ({ where, skip, take, include, orderBy }) => {
        db.calls.push(['list', { where, skip, take, orderBy }]);
        return db.rows
          .filter((row) => match(row, where))
          .sort((a, b) => b.receivedAt - a.receivedAt || b.id.localeCompare(a.id))
          .slice(skip, skip + take)
          .map((row) => decorate(row, include));
      },
      create: async ({ data }) => {
        if (
          db.rows.some(
            (row) =>
              row.branchId === data.branchId &&
              row.createdBy === data.createdBy &&
              row.idempotencyKey === data.idempotencyKey,
          )
        )
          throw unique('BuybackIntake_branchId_createdBy_idempotencyKey_key');
        const { items, audit: initial, ...header } = data;
        db.rows.push({
          status: 'DRAFT',
          version: 1,
          submittedAt: null,
          cancelledAt: null,
          cancellationReason: null,
          receivedAt: new Date(),
          updatedAt: new Date(),
          ...clone(header),
        });
        db.items.push(...items.create.map((i) => line(i, data.id)));
        audit({ ...initial.create, intakeId: data.id });
        return clone(header);
      },
      updateMany: async ({ where, data }) => {
        const row = db.rows.find((r) => match(r, where));
        if (!row || db.failCas) return { count: 0 };
        const { version, ...rest } = data;
        Object.assign(row, clone(rest), {
          version: row.version + version.increment,
          updatedAt: new Date(),
        });
        return { count: 1 };
      },
    },
    buybackIntakeItem: {
      deleteMany: async ({ where }) => {
        db.items = db.items.filter((i) => i.intakeId !== where.intakeId);
        return { count: 1 };
      },
      createMany: async ({ data }) => {
        db.items.push(...data.map((i) => line(i, i.intakeId)));
        return { count: data.length };
      },
    },
    buybackIntakeAudit: {
      create: async ({ data }) => {
        audit(data);
        return data;
      },
    },
  };
  const prisma = new Proxy(
    {
      $transaction: async (work, options) => {
        const backup = clone({ rows: db.rows, items: db.items, audits: db.audits });
        db.calls.push(['transaction', options]);
        try {
          return await work(tx);
        } catch (error) {
          Object.assign(db, backup);
          throw error;
        }
      },
    },
    {
      get(target, property) {
        assert.ok(property in target, `Unexpected model/access: ${String(property)}`);
        return target[property];
      },
    },
  );
  return { db, service: new BuybacksService(prisma) };
}
const rejects = (promise, code, status) =>
  assert.rejects(promise, (error) => error.code === code && error.httpStatus === status);

test('create valid multi-item intake with precise weights and actor audit, no payment/stock/event access', async () => {
  const { service, db } = setup();
  const body = input();
  body.items.push({ ...body.items[0], source: 'STORE_TAG', referenceTagCode: 'OLD-001' });
  const result = await service.create(staff, branch, 'create-1', body);
  assert.equal(buybackDetailSchema.safeParse(result).success, true);
  assert.equal(result.status, 'DRAFT');
  assert.equal(result.version, 1);
  assert.match(result.code, /^BB-/);
  assert.equal(result.customerPhone, '0912345678');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].declaredWeight, '1.2000');
  assert.equal(result.items[0].initialMeasuredWeight, '1.1500');
  assert.equal(result.customerId, null);
  assert.equal(db.customers.length, 0);
  assert.deepEqual(
    result.latestAudit.map((a) => [a.action, a.actorId, a.branchId, a.fromVersion, a.toVersion]),
    [['CREATED', staff.id, branch, null, 1]],
  );
  assert.equal('idempotencyKey' in result, false);
  assert.equal('requestHash' in result, false);
  assert.equal(JSON.stringify(result.latestAudit).includes('0912345678'), false);
  assert.ok(db.calls.some(([kind]) => kind === 'timeout'));
});

test('contracts reject mass assignment, appraised values, malformed/oversized intake and keys', () => {
  const base = payload();
  for (const bad of [
    { ...base, branchId: otherBranch },
    { ...base, createdBy: another.id },
    { ...base, status: 'COMPLETED' },
    { ...base, price: '10' },
    { ...base, receivedAt: new Date().toISOString() },
    { ...base, version: 1 },
    { ...base, customer: { ...base.customer, customerId: randomUUID() } },
    { ...base, customer: { name: ' ', phone: '1' } },
    { ...base, items: [] },
    { ...base, items: Array.from({ length: 21 }, () => base.items[0]) },
    ...[
      { declaredWeight: '-1' },
      { initialMeasuredWeight: '0' },
      { declaredWeight: '1.00001' },
      { declaredWeight: '100000000' },
      { declaredWeight: 1.1 },
      { verifiedPurity: '99.9' },
      { verifiedWeight: '1' },
      { quantity: 2 },
      { price: '100' },
      { source: 'STORE_TAG' },
      { referenceTagCode: 'UNKNOWN' },
      { condition: ' ' },
    ].map((patch) => ({ ...base, items: [{ ...base.items[0], ...patch }] })),
  ])
    assert.equal(createBuybackSchema.safeParse(bad).success, false, JSON.stringify(bad));
  const tag = { ...base.items[0], source: 'STORE_TAG', referenceTagCode: 'T1' };
  assert.equal(createBuybackSchema.safeParse({ ...base, items: [tag, tag] }).success, false);
  for (const key of [undefined, '', ' ', 'k'.repeat(201), ['a', 'b']])
    assert.equal(idempotencyKeySchema.safeParse(key).success, false);
  assert.equal(updateBuybackSchema.safeParse({ ...base, version: 0 }).success, false);
  assert.equal(submitBuybackSchema.safeParse({ version: 1, status: 'APPROVED' }).success, false);
  assert.equal(cancelBuybackSchema.safeParse({ version: 1, reason: 'no' }).success, false);
});

test('semantic invalid phone is rejected before transaction; existing customer gets contact snapshot only', async () => {
  const { service, db } = setup();
  await rejects(
    service.create(staff, branch, 'invalid', {
      ...input(),
      customer: { name: 'Khách', phone: 'abcdefghij' },
    }),
    'VALIDATION_FAILED',
    400,
  );
  assert.equal(db.calls.length, 0);
  const id = randomUUID();
  db.customers.push({ id, name: 'Khách cũ', phone: '0912345678' });
  const result = await service.create(staff, branch, 'existing', {
    ...input(),
    customer: { customerId: id },
  });
  assert.equal(result.customerId, id);
  assert.equal(result.customerName, 'Khách cũ');
  assert.equal(db.customers.length, 1);
  await rejects(
    service.create(staff, branch, 'missing', {
      ...input(),
      customer: { customerId: randomUUID() },
    }),
    'NOT_FOUND',
    404,
  );
  assert.equal(db.rows.length, 1);
});

test('all actions deny unauthorized branch before database access', async () => {
  const { service, db } = setup();
  const id = randomUUID();
  for (const action of [
    () => service.create(staff, otherBranch, 'key', input()),
    () => service.detail(staff, otherBranch, id),
    () => service.byKey(staff, otherBranch, 'key'),
    () => service.list(staff, otherBranch, buybackQuerySchema.parse({})),
    () => service.update(staff, otherBranch, id, { ...input(), version: 1 }),
    () => service.submit(staff, otherBranch, id, 1),
    () => service.cancel(staff, otherBranch, id, 1, 'Yêu cầu huỷ'),
  ])
    await rejects(action(), 'FORBIDDEN', 403);
  assert.equal(db.calls.length, 0);
});

test('actual row branch is scoped even for an authorized route, ADMIN can access other branch', async () => {
  const { service } = setup();
  const result = await service.create(admin, otherBranch, 'key', input());
  for (const action of [
    () => service.detail(staff, branch, result.id),
    () => service.update(staff, branch, result.id, { ...input(), version: 1 }),
    () => service.submit(staff, branch, result.id, 1),
    () => service.cancel(staff, branch, result.id, 1, 'Yêu cầu huỷ'),
  ])
    await rejects(action(), 'NOT_FOUND', 404);
  assert.equal((await service.detail(admin, otherBranch, result.id)).id, result.id);
});

test('STAFF can view but cannot edit/submit/cancel another staff intake; MANAGER can edit', async () => {
  const { service } = setup();
  const row = await service.create(staff, branch, 'key', input());
  assert.equal((await service.detail(another, branch, row.id)).id, row.id);
  for (const action of [
    () => service.update(another, branch, row.id, { ...input(), version: 1 }),
    () => service.submit(another, branch, row.id, 1),
    () => service.cancel(another, branch, row.id, 1, 'Yêu cầu huỷ'),
  ])
    await rejects(action(), 'FORBIDDEN', 403);
  const changed = await service.update(manager, branch, row.id, {
    ...input(),
    version: 1,
    notes: 'Sửa mô tả',
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.createdBy, staff.id);
  assert.equal(changed.latestAudit[0].actorId, manager.id);
});

test('DRAFT replace increments version and changes all lines atomically; old version cannot overwrite', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  const changed = await service.update(staff, branch, row.id, {
    ...input(),
    version: 1,
    items: [{ ...input().items[0], description: 'Đã sửa' }],
  });
  assert.equal(changed.version, 2);
  assert.equal(changed.items[0].description, 'Đã sửa');
  assert.notEqual(changed.items[0].id, row.items[0].id);
  assert.equal(db.items.length, 1);
  await rejects(
    service.update(staff, branch, row.id, { ...input(), version: 1 }),
    'VERSION_CONFLICT',
    409,
  );
  await rejects(service.submit(staff, branch, row.id, 1), 'VERSION_CONFLICT', 409);
  await rejects(service.cancel(staff, branch, row.id, 1, 'Yêu cầu huỷ'), 'VERSION_CONFLICT', 409);
  assert.equal(db.audits.length, 2);
  assert.ok(
    db.calls.some(([kind, args]) => kind === 'lock' && args[0].join('').includes('FOR UPDATE')),
  );
});

test('submission locks editing for all roles; only managers/admin cancel pending appraisal', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  const submitted = await service.submit(staff, branch, row.id, 1);
  assert.equal(submitted.status, 'PENDING_APPRAISAL');
  assert.equal(submitted.version, 2);
  assert.ok(submitted.submittedAt);
  assert.equal(submitted.items[0].id, row.items[0].id);
  for (const user of [staff, manager, admin]) {
    await rejects(
      service.update(user, branch, row.id, { ...input(), version: 2 }),
      'INVALID_STATE',
      409,
    );
    await rejects(service.submit(user, branch, row.id, 2), 'INVALID_STATE', 409);
  }
  await rejects(service.cancel(staff, branch, row.id, 2, 'Yêu cầu huỷ'), 'INVALID_STATE', 409);
  const cancelled = await service.cancel(manager, branch, row.id, 2, 'Khách không tiếp tục');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.version, 3);
  assert.equal(cancelled.cancellationReason, 'Khách không tiếp tục');
  assert.equal(cancelled.submittedAt, submitted.submittedAt);
  for (const action of [
    () => service.cancel(admin, branch, row.id, 3, 'Yêu cầu huỷ'),
    () => service.submit(admin, branch, row.id, 3),
    () => service.update(admin, branch, row.id, { ...input(), version: 3 }),
  ])
    await rejects(action(), 'INVALID_STATE', 409);
  assert.deepEqual(
    db.audits.map((a) => [a.action, a.fromStatus, a.toStatus, a.fromVersion, a.toVersion]),
    [
      ['CREATED', null, 'DRAFT', null, 1],
      ['SUBMITTED', 'DRAFT', 'PENDING_APPRAISAL', 1, 2],
      ['CANCELLED', 'PENDING_APPRAISAL', 'CANCELLED', 2, 3],
    ],
  );
});

test('STAFF may cancel own DRAFT and ADMIN may submit branch intake', async () => {
  const { service } = setup();
  const draft = await service.create(staff, branch, 'cancel', input());
  const cancelled = await service.cancel(staff, branch, draft.id, 1, 'Khách yêu cầu huỷ');
  assert.equal(cancelled.submittedAt, null);
  assert.equal(cancelled.status, 'CANCELLED');
  const next = await service.create(staff, branch, 'submit', input());
  assert.equal((await service.submit(admin, branch, next.id, 1)).status, 'PENDING_APPRAISAL');
});

test('CAS zero count cannot change items or append audit', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  db.failCas = true;
  await rejects(
    service.update(staff, branch, row.id, { ...input(), version: 1 }),
    'VERSION_CONFLICT',
    409,
  );
  assert.equal(db.rows[0].version, 1);
  assert.equal(db.items[0].id, row.items[0].id);
  assert.equal(db.audits.length, 1);
});

test('audit failure rolls back header, replaced items, and creation', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  db.failAudit = true;
  await assert.rejects(
    service.update(staff, branch, row.id, { ...input(), version: 1, notes: 'Changed' }),
    /audit unavailable/,
  );
  assert.deepEqual(await service.detail(staff, branch, row.id), row);
  await assert.rejects(service.submit(staff, branch, row.id, 1), /audit unavailable/);
  await assert.rejects(
    service.cancel(staff, branch, row.id, 1, 'Yêu cầu huỷ'),
    /audit unavailable/,
  );
  await assert.rejects(service.create(staff, branch, 'new', input()), /audit unavailable/);
  assert.equal(db.rows.length, 1);
  assert.equal(db.audits.length, 1);
  assert.equal(db.items.length, 1);
});

test('creation retries normalize phone/weights, return same current intake, never append a duplicate audit', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  const retry = createBuybackSchema.parse({
    ...payload(),
    customer: { name: 'Khách thử', phone: '0912345678' },
    items: [{ ...payload().items[0], declaredWeight: '1.2' }],
  });
  assert.deepEqual(await service.create(staff, branch, 'key', retry), row);
  await service.update(staff, branch, row.id, { ...input(), version: 1, notes: 'Nội dung mới' });
  await service.submit(staff, branch, row.id, 2);
  const replay = await service.create(staff, branch, 'key', retry);
  assert.equal(replay.id, row.id);
  assert.equal(replay.version, 3);
  assert.equal(replay.notes, 'Nội dung mới');
  assert.equal(db.rows.length, 1);
  assert.equal(db.audits.length, 3);
  await rejects(
    service.create(staff, branch, 'key', { ...input(), notes: 'Khác request gốc' }),
    'IDEMPOTENCY_KEY_REUSED',
    422,
  );
});

test('unique creation race recovers matching key, rejects mismatched body, does not swallow other constraints', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  db.hideKeyOnce = true;
  assert.equal((await service.create(staff, branch, 'key', input())).id, row.id);
  db.hideKeyOnce = true;
  await rejects(
    service.create(staff, branch, 'key', { ...input(), notes: 'Khác' }),
    'IDEMPOTENCY_KEY_REUSED',
    422,
  );
  assert.equal(db.rows.length, 1);
  assert.equal(db.audits.length, 1);
  const failure = unique('BuybackIntake_code_key');
  const broken = new BuybacksService({
    $transaction: async () => {
      throw failure;
    },
  });
  await assert.rejects(broken.create(staff, branch, 'key', input()), (error) => error === failure);
});

test('idempotency recovery is scoped to actor AND branch; same key for another actor creates independent intake', async () => {
  const { service } = setup();
  const row = await service.create(staff, branch, 'key', input());
  assert.equal((await service.byKey(staff, branch, 'key')).id, row.id);
  await rejects(service.byKey(another, branch, 'key'), 'NOT_FOUND', 404);
  await rejects(service.byKey(admin, otherBranch, 'key'), 'NOT_FOUND', 404);
  const different = await service.create(another, branch, 'key', input());
  assert.notEqual(different.id, row.id);
});

test('query bounds and unknown filters rejected; inclusive date/status/branch filter with stable paginated order', async () => {
  for (const status of ['APPRAISED', 'APPROVED', 'REJECTED'])
    assert.equal(buybackQuerySchema.safeParse({ status }).success, true);
  for (const query of [
    { page: '0' },
    { page: '1.5' },
    { page: '10001' },
    { pageSize: '51' },
    { pageSize: ['1', '2'] },
    { pageSize: ['1'] },
    { page: true },
    { status: 'PAYOUT' },
    { branchId: otherBranch },
    { from: 'yesterday' },
    { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  ])
    assert.equal(buybackQuerySchema.safeParse(query).success, false, JSON.stringify(query));
  const { service, db } = setup();
  for (let n = 0; n < 4; n++) await service.create(staff, branch, `key-${n}`, input());
  await service.create(admin, otherBranch, 'other', input());
  await service.submit(staff, branch, db.rows[0].id, 1);
  for (let n = 0; n < 4; n++) db.rows[n].receivedAt = new Date(`2026-11-0${n + 1}T12:00:00Z`);
  const query = buybackQuerySchema.parse({
    page: '2',
    pageSize: '1',
    status: 'DRAFT',
    from: '2026-11-02T12:00:00Z',
    to: '2026-11-04T12:00:00Z',
  });
  const result = await service.list(staff, branch, query);
  assert.equal(buybackPageSchema.safeParse(result).success, true);
  assert.equal(result.total, 3);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, db.rows[2].id);
  assert.equal(result.page, 2);
  assert.equal('customerPhone' in result.items[0], false);
  assert.equal('requestHash' in result.items[0], false);
  const call = db.calls.find(([kind]) => kind === 'list')[1];
  assert.deepEqual(call.orderBy, [{ receivedAt: 'desc' }, { id: 'desc' }]);
  assert.ok(
    db.calls.some(
      ([kind, options]) => kind === 'transaction' && options.isolationLevel === 'RepeatableRead',
    ),
  );
});

test('detail audit is bounded to 50 versions while stored history remains append-only', async () => {
  const { service, db } = setup();
  const row = await service.create(staff, branch, 'key', input());
  for (let version = 1; version <= 51; version++)
    await service.update(staff, branch, row.id, { ...input(), version });
  const result = await service.detail(staff, branch, row.id);
  assert.equal(db.audits.length, 52);
  assert.equal(result.latestAudit.length, 50);
  assert.equal(result.latestAudit[0].toVersion, 52);
  assert.equal(result.latestAudit.at(-1).toVersion, 3);
});

test('controller is authenticated, branch-role guarded, no-store and matches generated strict contracts', () => {
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', BuybacksController), [
    'ADMIN',
    'MANAGER',
    'STAFF',
  ]);
  assert.equal(Reflect.getMetadata('jewelry:isPublic', BuybacksController), undefined);
  assert.equal(Reflect.getMetadata('jewelry:audience', BuybacksController), undefined); // default backoffice
  for (const name of ['create', 'list', 'byKey', 'detail', 'update', 'submit', 'cancel']) {
    const handler = BuybacksController.prototype[name];
    assert.equal(Reflect.getMetadata('jewelry:isPublic', handler), undefined);
    assert.deepEqual(Reflect.getMetadata('__headers__', handler), [
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  }
  const guard = new RolesGuard(new Reflector());
  const context = (user) => ({
    getHandler: () => BuybacksController.prototype.create,
    getClass: () => BuybacksController,
    switchToHttp: () => ({ getRequest: () => ({ user, params: { branchId: branch } }) }),
  });
  assert.equal(guard.canActivate(context(staff)), true);
  assert.throws(
    () =>
      guard.canActivate(
        context({ id: staff.id, branches: [{ role: 'STAFF', branchId: otherBranch }] }),
      ),
    { code: 'FORBIDDEN' },
  );
  assert.throws(
    () =>
      new ZodValidationPipe(createBuybackSchema).transform({ ...payload(), status: 'COMPLETED' }),
    { code: 'VALIDATION_FAILED' },
  );
  const schemas = salesOpenApiSchemas();
  assert.equal(schemas.CreateBuyback.additionalProperties, false);
  assert.equal(schemas.UpdateBuyback.properties.version.type, 'integer');
  assert.deepEqual(schemas.BuybackStatus.enum, [
    'DRAFT',
    'PENDING_APPRAISAL',
    'CANCELLED',
    'APPRAISED',
    'APPROVED',
    'REJECTED',
  ]);
  const doc = readFileSync(
    new URL('../../../docs/api/sales.openapi.yaml', import.meta.url),
    'utf8',
  );
  for (const path of ['', '/by-key', '/{id}', '/{id}/submit', '/{id}/cancel'])
    assert.ok(doc.includes(`/api/admin/sales/branches/{branchId}/buybacks${path}:`));
});

test('controller validates idempotency header before create or recovery service calls', () => {
  const controller = new BuybacksController({
    create: () => assert.fail('invalid header reached service'),
    byKey: () => assert.fail('invalid header reached service'),
  });
  for (const key of [undefined, '', ' ', ['a', 'b'], 'k'.repeat(201)]) {
    assert.throws(() => controller.create(staff, branch, key, input()), {
      code: 'VALIDATION_FAILED',
    });
    assert.throws(() => controller.byKey(staff, branch, key), { code: 'VALIDATION_FAILED' });
  }
});
