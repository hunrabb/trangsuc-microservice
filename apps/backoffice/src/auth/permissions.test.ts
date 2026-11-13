import assert from 'node:assert/strict';
import test from 'node:test';
import { canBranchStockAccess, canManageReceipts } from './permissions.ts';
test('nhập hàng chỉ ADMIN; STAFF/MANAGER vẫn xem tồn kho ở chi nhánh được giao', () => {
  assert.equal(canManageReceipts([{ branchId: null, role: 'ADMIN' }]), true);
  for (const role of ['STAFF', 'MANAGER'] as const) {
    const branches = [{ branchId: '11111111-1111-4111-8111-111111111111', role }];
    assert.equal(canManageReceipts(branches), false);
    assert.equal(canBranchStockAccess(branches), true);
  }
  assert.equal(canManageReceipts([]), false);
});
