import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PosOrder } from '@jewelry/contracts';
import { vietQrUrl } from './vietqr.ts';

const order: PosOrder = {
  id: 'id',
  code: 'POS123',
  branchId: 'branch',
  customerId: null,
  status: 'PENDING_PAYMENT',
  total: '4471000.00',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  items: [],
};
const bank = { bin: '970415', account: '123456789', name: 'CUA HANG VANG' };

describe('VietQR POS', () => {
  it('chỉ dùng số tiền và mã đơn đã chốt; thiếu cấu hình không hiện QR', () => {
    assert.equal(vietQrUrl(order, null), null);
    const url = new URL(vietQrUrl(order, bank)!);
    assert.equal(url.searchParams.get('amount'), '4471000');
    assert.equal(url.searchParams.get('addInfo'), 'POS123');
    assert.equal(url.searchParams.get('accountName'), bank.name);
    assert.equal(vietQrUrl({ ...order, status: 'COMPLETED' }, bank), null);
    assert.equal(vietQrUrl({ ...order, total: '4471000.50' }, bank), null);
    assert.equal(vietQrUrl({ ...order, code: 'POS-OLD' }, bank), null);
  });
});
