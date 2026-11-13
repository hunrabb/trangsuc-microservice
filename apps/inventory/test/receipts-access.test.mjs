import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ReceiptsService } from '../dist/receipts/receipts.service.js';
import { ReceiptsController } from '../dist/receipts/receipts.controller.js';
const branchId = randomUUID(),
  receiptId = randomUUID();
const callsFor = (service, user) => [
  () => service.create(user, { branchId }),
  () => service.list(user, { branchId, page: 1, pageSize: 20 }),
  () => service.get(user, receiptId),
  () =>
    service.addLine(user, receiptId, {
      variantId: randomUUID(),
      tagCode: 'DENIED',
      weight: '1',
      costPrice: '1000',
    }),
  () => service.removeLine(user, receiptId, randomUUID()),
  () => service.approve(user, receiptId, { version: 1 }),
];
test('STAFF and MANAGER cannot read or mutate any receipt, even in their own branch', async () => {
  const database = new Proxy(
    {},
    {
      get() {
        assert.fail('Denied request must not access database');
      },
    },
  );
  const service = new ReceiptsService(database);
  for (const role of ['STAFF', 'MANAGER']) {
    const user = { id: randomUUID(), branches: [{ branchId, role }] };
    for (const call of callsFor(service, user))
      await assert.rejects(
        call(),
        (error) => error.code === 'FORBIDDEN' && error.httpStatus === 403,
      );
  }
  assert.deepEqual(Reflect.getMetadata('jewelry:roles', ReceiptsController), ['ADMIN']);
});
test('ADMIN selects the receiving branch and creates a draft in that branch warehouse', async () => {
  const admin = { id: randomUUID(), branches: [{ branchId: null, role: 'ADMIN' }] };
  for (const destination of [branchId, randomUUID()]) {
    const warehouseId = randomUUID();
    const service = new ReceiptsService({
      warehouse: {
        findUnique: async ({ where }) => {
          assert.equal(where.branchId, destination);
          return { id: warehouseId, isActive: true };
        },
      },
      goodsReceipt: {
        create: async ({ data }) => {
          assert.equal(data.warehouseId, warehouseId);
          assert.equal(data.createdBy, admin.id);
          return {
            ...data,
            id: receiptId,
            warehouse: { branchId: destination },
            status: 'DRAFT',
            approvedBy: null,
            approvedAt: null,
            version: 1,
            lines: [],
          };
        },
      },
    });
    const receipt = await service.create(admin, { branchId: destination });
    assert.equal(receipt.branchId, destination);
    assert.equal(receipt.status, 'DRAFT');
  }
});
