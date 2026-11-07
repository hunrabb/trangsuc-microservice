import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { currentUserSchema } from '@jewelry/contracts';
import { toCurrentUserBranches } from './current-user.ts';

describe('/me: tên chi nhánh', () => {
  it('vai trò ở chi nhánh có branchName; ADMIN toàn hệ thống có branchName = null; khớp schema', () => {
    const branchId = randomUUID();
    const branches = toCurrentUserBranches([
      { branchId: null, role: 'ADMIN', branch: null },
      { branchId, role: 'MANAGER', branch: { name: 'Chi nhánh Hà Nội' } },
    ]);

    assert.deepEqual(branches, [
      { branchId: null, role: 'ADMIN', branchName: null },
      { branchId, role: 'MANAGER', branchName: 'Chi nhánh Hà Nội' },
    ]);
    const parsed = currentUserSchema.safeParse({
      id: randomUUID(),
      email: 'a@example.com',
      fullName: 'A',
      googleLinked: false,
      branches,
    });
    assert.equal(parsed.success, true);
  });
});
