import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ItemWithPrice, PosOrder } from '@jewelry/contracts';
import {
  addCartItem,
  newPosState,
  readPosState,
  reconcilePosState,
  removeCartItem,
  savePosState,
  selectCustomer,
} from './pos-state.ts';

const data = new Map<string, string>();
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => {
    data.set(key, value);
  },
};

const item = {
  tagCode: 'TEM-1',
  productName: 'Nhẫn',
  variantName: '18K',
  weight: '1.0000',
  price: '3500000.00',
} as ItemWithPrice;

describe('giỏ POS và key bền vững', () => {
  before(() =>
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage }),
  );
  after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  it('chặn tem trùng; thay giỏ hoặc khách đổi key nhưng reload và retry giữ nguyên', () => {
    const start = newPosState('owner', 'branch');
    const withItem = addCartItem(start, item);
    assert.equal(withItem.items.length, 1);
    assert.notEqual(withItem.key, start.key);
    assert.equal(addCartItem(withItem, item), withItem);
    const withCustomer = selectCustomer(withItem, {
      id: 'customer',
      name: 'Khách',
      phone: '0912345678',
    });
    assert.notEqual(withCustomer.key, withItem.key);
    const submitted = { ...withCustomer, phase: 'submitting' as const };
    assert.equal(savePosState(submitted), true);
    assert.deepEqual(readPosState('owner', 'branch'), submitted);
    assert.equal(addCartItem(submitted, item), submitted);
    assert.equal(readPosState('other', 'branch').items.length, 0);
    assert.notEqual(removeCartItem(withItem, item.tagCode).key, withItem.key);
  });

  it('reload lúc huỷ dở không mở thu tiền; chỉ trạng thái cuối mới mở giỏ mới', () => {
    const start = newPosState('owner', 'branch');
    const order: PosOrder = {
      id: 'order',
      code: 'POS123',
      branchId: 'branch',
      customerId: null,
      status: 'PENDING_PAYMENT',
      total: '3500000.00',
      version: 2,
      createdAt: '2026-11-08T00:00:00.000Z',
      items: [],
    };
    const cancelling = {
      ...start,
      orderId: order.id,
      phase: 'settling' as const,
      pendingAction: 'cancel' as const,
    };
    assert.equal(reconcilePosState(cancelling, order), cancelling);
    const resumed = reconcilePosState(cancelling, { ...order, status: 'CANCELLING' });
    assert.equal(resumed.phase, 'settling');
    assert.equal(resumed.pendingAction, 'cancel');
    const completed = reconcilePosState(resumed, { ...order, status: 'CANCELLED' });
    assert.equal(completed.phase, 'closed');
    assert.equal(completed.pendingAction, null);
  });
});
