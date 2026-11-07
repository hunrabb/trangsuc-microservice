import type { BranchRole, User } from '@jewelry/contracts';

/**
 * Quy tắc hiện/ẩn nút theo vai trò. Đây CHỈ là tiện cho người dùng: server mới là nơi quyết định, và vẫn
 * trả `403` nếu giao diện hiện nhầm. Phải khớp với `apps/auth/src/admin/policy.ts`.
 */

interface Actor {
  id: string;
  branches: readonly BranchRole[];
}

export const isAdmin = (branches: readonly BranchRole[]): boolean =>
  branches.some(({ role, branchId }) => role === 'ADMIN' && branchId === null);

/** Chi nhánh mà người này là MANAGER. */
export const managedBranchIds = (branches: readonly BranchRole[]): string[] =>
  branches.flatMap(({ role, branchId }) =>
    role === 'MANAGER' && branchId !== null ? [branchId] : [],
  );

export const canManageBranches = (branches: readonly BranchRole[]): boolean => isAdmin(branches);

export const canManageUsers = (branches: readonly BranchRole[]): boolean =>
  isAdmin(branches) || managedBranchIds(branches).length > 0;

export const canAssignRoles = (branches: readonly BranchRole[]): boolean => isAdmin(branches);

export const canChangeOwnPassword = (branches: readonly BranchRole[]): boolean => isAdmin(branches);

const hasAdminRole = (target: Pick<User, 'branches'>): boolean =>
  target.branches.some(({ role }) => role === 'ADMIN');

/**
 * MANAGER chỉ đụng tới người chỉ có vai trò STAFF và mọi chi nhánh của người đó đều do mình quản lý.
 * ADMIN: mọi người.
 */
export function canManageUser(actor: Actor, target: Pick<User, 'branches'>): boolean {
  if (isAdmin(actor.branches)) {
    return true;
  }
  const managed = new Set(managedBranchIds(actor.branches));
  return (
    target.branches.length > 0 &&
    target.branches.every(
      ({ role, branchId }) => role === 'STAFF' && branchId !== null && managed.has(branchId),
    )
  );
}

/** Không ai tự khoá chính mình. */
export const canLockUser = (actor: Actor, target: Pick<User, 'id' | 'branches'>): boolean =>
  target.id !== actor.id && canManageUser(actor, target);

/** Chỉ ADMIN, chỉ cho ADMIN khác. Tự đổi mật khẩu dùng trang "Đổi mật khẩu". */
export const canResetPassword = (actor: Actor, target: Pick<User, 'id' | 'branches'>): boolean =>
  isAdmin(actor.branches) && target.id !== actor.id && hasAdminRole(target);

/** Có quyền `roles` ở chi nhánh `branchId` (ADMIN có quyền ở mọi chi nhánh). */
export const hasRoleAtBranch = (
  branches: readonly BranchRole[],
  branchId: string | null,
  roles: readonly BranchRole['role'][],
): boolean =>
  isAdmin(branches) ||
  (branchId !== null &&
    branches.some((entry) => entry.branchId === branchId && roles.includes(entry.role)));

/** Trang kho theo chi nhánh (nhập hàng, tồn kho, kiểm kê): ADMIN, hoặc người có vai trò ở một chi nhánh. */
export const canBranchStockAccess = (branches: readonly BranchRole[]): boolean =>
  isAdmin(branches) || branches.some((entry) => entry.branchId !== null);

/** Trang giá kim loại và sản phẩm: chỉ ADMIN ghi. */
export const canManageCatalog = (branches: readonly BranchRole[]): boolean => isAdmin(branches);

export const ROLE_LABELS: Record<BranchRole['role'], string> = {
  ADMIN: 'Quản trị viên',
  MANAGER: 'Quản lý',
  STAFF: 'Nhân viên',
};
