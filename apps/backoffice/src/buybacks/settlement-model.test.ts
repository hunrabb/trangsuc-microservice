import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CurrentUser, ItemWithPrice, SettlementView } from '@jewelry/contracts';
import {
  canConfirmSettlement,
  DIRECTION,
  exchangeItemAvailable,
  SettlementCommandGate,
  SETTLEMENT_STATUS,
} from './settlement-model.ts';

const branchId = '11111111-1111-4111-8111-111111111111';
const makerId = '22222222-2222-4222-8222-222222222222';
const recorderId = '33333333-3333-4333-8333-333333333333';
const checkerId = '44444444-4444-4444-8444-444444444444';
const actor = (id: string, role: 'STAFF' | 'MANAGER' | 'ADMIN', branch = branchId) =>
  ({ id, branches: [{ role, branchId: role === 'ADMIN' ? null : branch }] }) as CurrentUser;
const settlement = (status: SettlementView['status'] = 'PAYMENT_RECORDED') =>
  ({ status, branchId, createdBy: makerId, paymentRecordedBy: recorderId }) as SettlementView;

it('maker-checker settlement: chỉ quản lý khác người lập và ghi chứng từ được xác nhận', () => {
  const row = settlement();
  assert.ok(canConfirmSettlement(actor(checkerId, 'STAFF'), row));
  assert.ok(
    canConfirmSettlement(actor(checkerId, 'MANAGER', '55555555-5555-4555-8555-555555555555'), row),
  );
  assert.ok(canConfirmSettlement(actor(makerId, 'ADMIN'), row));
  assert.ok(canConfirmSettlement(actor(recorderId, 'MANAGER'), row));
  assert.equal(canConfirmSettlement(actor(checkerId, 'MANAGER'), row), null);
  assert.equal(canConfirmSettlement(actor(checkerId, 'ADMIN'), row), null);
  assert.ok(canConfirmSettlement(actor(checkerId, 'MANAGER'), settlement('AWAITING_PAYMENT')));
});

it('ba hướng chênh lệch và PAYMENT_RECORDED khác SETTLED', () => {
  assert.equal(DIRECTION.CUSTOMER_PAYS, 'Khách trả thêm');
  assert.equal(DIRECTION.STORE_PAYS, 'Cửa hàng chi trả');
  assert.equal(DIRECTION.NONE, 'Không thu/chi chênh lệch');
  assert.notEqual(SETTLEMENT_STATUS.PAYMENT_RECORDED.label, SETTLEMENT_STATUS.SETTLED.label);
  assert.equal(SETTLEMENT_STATUS.RECONCILIATION_REQUIRED.color, 'red');
});

it('exchange chỉ chọn món còn bán tại đúng chi nhánh', () => {
  const item = { branchId, status: 'IN_STOCK' } as ItemWithPrice;
  assert.equal(exchangeItemAvailable(item, branchId), true);
  assert.equal(exchangeItemAvailable({ ...item, status: 'RESERVED' }, branchId), false);
  assert.equal(exchangeItemAvailable({ ...item, branchId: checkerId }, branchId), false);
  assert.equal(exchangeItemAvailable(undefined, branchId), false);
});

it('click đôi chỉ gửi một lệnh; timeout giữ key để thử lại cùng command', async () => {
  const gate = new SettlementCommandGate();
  let resolve!: (value: string) => void;
  const first = new Promise<string>((done) => {
    resolve = done;
  });
  const keys: string[] = [];
  const send = (key: string) => {
    keys.push(key);
    return first;
  };
  const a = gate.run('record:v1', send);
  const b = gate.run('record:v1', send);
  assert.equal(a, b);
  assert.equal(keys.length, 1);
  resolve('ok');
  assert.equal(await a, 'ok');
  await assert.rejects(
    gate.run('record:v2', async (key) => {
      keys.push(key);
      throw new Error('timeout');
    }),
  );
  await gate.run('record:v2', async (key) => {
    keys.push(key);
    return 'recovered';
  });
  assert.equal(keys[1], keys[2]);
  await gate.run('record:v3', async (key) => {
    keys.push(key);
    return 'new';
  });
  assert.notEqual(keys[2], keys[3]);
});
