import { type AuthUser, BusinessError } from '@jewelry/common';
import type { Role } from '@jewelry/contracts';

/**
 * Quyền theo chi nhánh của inventory, đọc từ token (inventory không có dữ liệu người dùng). Token sống tối đa
 * 15 phút nên người vừa bị hạ vai trò còn thao tác được trong khoảng đó, đúng như thiết kế ở docs/thiet-ke.md.
 * ADMIN (branchId = null) có mọi quyền ở mọi chi nhánh.
 */
export const isSystemAdmin = (user: AuthUser): boolean =>
  user.branches.some(({ role, branchId }) => role === 'ADMIN' && branchId === null);

export const hasRoleAtBranch = (
  user: AuthUser,
  branchId: string,
  roles: readonly Role[],
): boolean =>
  isSystemAdmin(user) ||
  user.branches.some((entry) => entry.branchId === branchId && roles.includes(entry.role));

export function assertRoleAtBranch(user: AuthUser, branchId: string, roles: readonly Role[]): void {
  if (!hasRoleAtBranch(user, branchId, roles)) {
    throw new BusinessError('FORBIDDEN', 'Không có quyền thực hiện thao tác này', 403);
  }
}

/**
 * Danh sách theo chi nhánh: người không phải ADMIN bắt buộc nêu `branchId` của chi nhánh mình, không thì
 * `403`; không bao giờ trả dữ liệu chi nhánh khác.
 */
export function assertListScope(
  user: AuthUser,
  branchId: string | undefined,
  roles: readonly Role[],
): void {
  if (branchId === undefined) {
    if (!isSystemAdmin(user)) {
      throw new BusinessError('FORBIDDEN', 'Cần chỉ rõ chi nhánh', 403);
    }
    return;
  }
  assertRoleAtBranch(user, branchId, roles);
}
