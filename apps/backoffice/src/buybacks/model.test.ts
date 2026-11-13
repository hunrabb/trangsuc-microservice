import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { BuybackDetail, BuybackQuote, CurrentUser } from '@jewelry/contracts';
import type { BuybackPolicy } from './api.ts';
import {
  canApprove,
  emptyIntake,
  intakeActions,
  intakeBody,
  intakeErrors,
  quoteBody,
  samePurity,
  validAppraisal,
} from './model.ts';

const branchId = '11111111-1111-4111-8111-111111111111';
const makerId = '22222222-2222-4222-8222-222222222222';
const checkerId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const policyId = '55555555-5555-4555-8555-555555555555';
const user = (id: string, role: 'STAFF' | 'MANAGER' | 'ADMIN', branch = branchId) =>
  ({ id, branches: [{ role, branchId: role === 'ADMIN' ? null : branch }] }) as CurrentUser;
const detail = (status: BuybackDetail['status'], createdBy = makerId) =>
  ({ id: itemId, branchId, status, createdBy }) as BuybackDetail;

it('tiếp nhận nhiều món: DTO giữ chuỗi chỉ, null cho ô tùy chọn và từ chối trùng tem', () => {
  const fields = emptyIntake();
  fields.customerName = 'Khách A';
  fields.customerPhone = '0912345678';
  fields.items[0] = {
    ...fields.items[0]!,
    description: 'Nhẫn',
    condition: 'Cũ',
    declaredWeight: '1.2500',
  };
  fields.items.push({
    ...fields.items[0]!,
    description: 'Dây chuyền',
    source: 'STORE_TAG',
    referenceTagCode: 'TAG-01',
  });
  assert.deepEqual(intakeErrors(fields), {});
  assert.equal(intakeBody(fields).items[0]?.declaredWeight, '1.2500');
  assert.equal(intakeBody(fields).items[0]?.initialMeasuredWeight, null);
  fields.items.push({ ...fields.items[1]! });
  assert.ok(intakeErrors(fields).items);
  fields.items.pop();
  fields.items[1]!.referenceTagCode = '';
  assert.ok(Object.keys(intakeErrors(fields)).length > 0);
  fields.items[1]!.referenceTagCode = 'TAG-02';
  fields.items[1]!.declaredWeight = '0';
  assert.ok(intakeErrors(fields)['items.1.declaredWeight']);
  fields.items[1]!.declaredWeight = '1';
  fields.customerPhone = '1234567890';
  assert.equal(intakeErrors(fields)['customer.phone'], 'Số điện thoại không hợp lệ');
  fields.customerPhone = '+84 912 345 678';
  assert.deepEqual(intakeErrors(fields), {});
});

it('trạng thái và quyền chi nhánh: STAFF chỉ sửa phiếu mình, MANAGER có thể huỷ chờ kiểm định', () => {
  assert.equal(intakeActions(user(makerId, 'STAFF'), detail('DRAFT')).edit, true);
  assert.equal(intakeActions(user(checkerId, 'STAFF'), detail('DRAFT')).edit, false);
  assert.equal(intakeActions(user(makerId, 'STAFF'), detail('PENDING_APPRAISAL')).cancel, false);
  assert.equal(intakeActions(user(checkerId, 'MANAGER'), detail('PENDING_APPRAISAL')).cancel, true);
  assert.equal(
    intakeActions(
      user(checkerId, 'MANAGER', '66666666-6666-4666-8666-666666666666'),
      detail('APPRAISED'),
    ).decide,
    false,
  );
  assert.equal(intakeActions(user(checkerId, 'ADMIN'), detail('APPROVED')).quote, false);
});

it('kiểm định dùng version hiện tại; không chấp nhận trọng lượng chấp nhận vượt số đo', () => {
  const body = {
    version: 2,
    measuredWeight: '1.0000',
    acceptedWeight: '1.0001',
    metalId: policyId,
    metalKind: 'GOLD' as const,
    purityPerMille: '750',
    condition: 'Cũ',
    notes: null,
  };
  assert.ok(Object.keys(validAppraisal(body)).length > 0);
  assert.deepEqual(validAppraisal({ ...body, acceptedWeight: '0.9000' }), {});
  assert.ok(
    validAppraisal({ ...body, acceptedWeight: '0.9000', purityPerMille: '1000.0001' })
      .purityPerMille,
  );
});

it('báo giá chọn đúng policy/version theo hàm lượng chính xác, không tự tính tiền', () => {
  const policy = { id: policyId, version: 4, purityPerMille: '750.0000' } as BuybackPolicy;
  assert.equal(samePurity('750', policy.purityPerMille), true);
  assert.equal(samePurity('749.9999', policy.purityPerMille), false);
  assert.deepEqual(quoteBody(5, [itemId], { [itemId]: policyId }, [policy]), {
    version: 5,
    items: [{ itemId, policyId, policyVersion: 4 }],
  });
  assert.throws(() => quoteBody(5, [itemId], {}, [policy]));
});

it('maker-checker: ADMIN cũng không tự duyệt nếu đã tiếp nhận, kiểm định hoặc lập giá', () => {
  const quote = { quotedBy: checkerId, lines: [{ appraisedBy: makerId }] } as BuybackQuote;
  assert.ok(canApprove(user(makerId, 'ADMIN'), detail('APPRAISED'), quote));
  assert.ok(canApprove(user(checkerId, 'ADMIN'), detail('APPRAISED'), quote));
  assert.equal(
    canApprove(user('77777777-7777-4777-8777-777777777777', 'MANAGER'), detail('APPRAISED'), quote),
    null,
  );
  assert.ok(
    canApprove(user('77777777-7777-4777-8777-777777777777', 'STAFF'), detail('APPRAISED'), quote),
  );
});
