import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  authSessionSchema,
  branchCreatedPayloadSchema,
  branchUpdatedPayloadSchema,
  createUserRequestSchema,
  ERROR_CODES,
  EVENT_PAYLOAD_SCHEMAS,
  isAcceptablePassword,
  replaceAssignmentsRequestSchema,
  ROUTING_KEYS,
} from '@jewelry/contracts';

const branchId = randomUUID();
const admin = [{ branchId: null, role: 'ADMIN' }];
const staff = [{ branchId, role: 'STAFF' }];
const base = { email: 'a@example.com', fullName: 'A' };

describe('mã lỗi và sự kiện mới', () => {
  it('có đủ mã lỗi của đăng nhập', () => {
    for (const code of [
      'INVALID_CREDENTIALS',
      'ACCOUNT_NOT_PROVISIONED',
      'SESSION_EXPIRED',
      'PASSWORD_TOO_WEAK',
    ]) {
      assert.ok((ERROR_CODES as readonly string[]).includes(code), code);
    }
  });

  it('branch.created, branch.updated có schema payload', () => {
    assert.equal(EVENT_PAYLOAD_SCHEMAS[ROUTING_KEYS.BRANCH_CREATED], branchCreatedPayloadSchema);
    assert.equal(EVENT_PAYLOAD_SCHEMAS[ROUTING_KEYS.BRANCH_UPDATED], branchUpdatedPayloadSchema);
    const created = { branchId, code: 'CN1', name: 'Chi nhánh 1' };
    assert.equal(branchCreatedPayloadSchema.safeParse(created).success, true);
    assert.equal(branchCreatedPayloadSchema.safeParse({ branchId }).success, false);
    assert.equal(branchUpdatedPayloadSchema.safeParse(created).success, false);
    const updated = { ...created, isActive: false };
    assert.equal(branchUpdatedPayloadSchema.safeParse(updated).success, true);
  });
});

describe('isAcceptablePassword', () => {
  it('tối thiểu 12 ký tự', () => {
    assert.equal(isAcceptablePassword('a'.repeat(11)), false);
    assert.equal(isAcceptablePassword('a'.repeat(12)), true);
  });

  it('tối đa 72 byte UTF-8, vì bcrypt bỏ phần sau', () => {
    assert.equal(isAcceptablePassword('a'.repeat(72)), true);
    assert.equal(isAcceptablePassword('a'.repeat(73)), false);
    assert.equal(isAcceptablePassword('ệ'.repeat(30)), false);
  });
});

describe('createUserRequestSchema', () => {
  const parse = (body: object) => createUserRequestSchema.safeParse({ ...base, ...body }).success;

  it('password bắt buộc khi và chỉ khi có vai trò ADMIN', () => {
    assert.equal(parse({ assignments: admin, password: 'mat-khau-du-dai' }), true);
    assert.equal(parse({ assignments: admin }), false);
    assert.equal(parse({ assignments: staff }), true);
    assert.equal(parse({ assignments: staff, password: 'mat-khau-du-dai' }), false);
  });

  it('phải có ít nhất một vai trò; ADMIN không gắn chi nhánh', () => {
    assert.equal(parse({ assignments: [] }), false);
    assert.equal(parse({ assignments: [{ branchId, role: 'ADMIN' }], password: 'x' }), false);
    assert.equal(parse({ assignments: [{ branchId: null, role: 'STAFF' }] }), false);
  });

  it('từ chối trường lạ: client không tự đặt được status, version', () => {
    assert.equal(parse({ assignments: staff, status: 'ACTIVE' }), false);
  });
});

describe('replaceAssignmentsRequestSchema', () => {
  it('password chỉ dùng khi có vai trò ADMIN', () => {
    const parse = (body: object) => replaceAssignmentsRequestSchema.safeParse(body).success;
    assert.equal(parse({ assignments: admin, password: 'mat-khau-du-dai' }), true);
    assert.equal(parse({ assignments: admin }), true);
    assert.equal(parse({ assignments: staff }), true);
    assert.equal(parse({ assignments: staff, password: 'mat-khau-du-dai' }), false);
  });
});

describe('authSessionSchema', () => {
  it('khớp response đăng nhập', () => {
    const user = { id: randomUUID(), email: 'a@example.com', fullName: 'A', branches: admin };
    const session = { accessToken: 'x', expiresIn: 900, user };
    assert.equal(authSessionSchema.safeParse(session).success, true);
  });
});
