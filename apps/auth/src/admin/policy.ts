import { BusinessError } from '@jewelry/common';
import type { BranchRole } from '@jewelry/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import { ACTIVE_ASSIGNMENTS } from '../session/active-assignments';

/** Người đang thao tác, đọc từ DB. `branches` chỉ gồm vai trò còn hiệu lực. */
export interface Actor {
  id: string;
  branches: BranchRole[];
}

/** User bị thao tác. `branches` gồm mọi vai trò, kể cả ở chi nhánh đã ngừng hoạt động. */
export interface TargetUser {
  id: string;
  branches: BranchRole[];
}

/** Thao tác trên một user. Đọc xong user mới có `target`; thiếu `target` thì chỉ ADMIN qua được. */
export type UserActionKind =
  | 'user.view'
  | 'user.update'
  | 'user.lock'
  | 'user.unlock'
  | 'user.unlink-google'
  | 'user.reset-password'
  | 'user.assign';

export type AdminAction =
  | { kind: 'branch.manage' }
  | { kind: 'user.list'; branchId?: string }
  | { kind: 'user.create'; assignments: readonly BranchRole[] }
  | { kind: UserActionKind; target?: TargetUser };

const isSystemAdmin = ({ branches }: Actor): boolean =>
  branches.some(({ role, branchId }) => role === 'ADMIN' && branchId === null);

const managedBranchIds = ({ branches }: Actor): Set<string | null> =>
  new Set(branches.filter(({ role }) => role === 'MANAGER').map(({ branchId }) => branchId));

/**
 * MANAGER chỉ đụng tới người **chỉ có vai trò STAFF** và **mọi** chi nhánh của người đó đều do mình quản lý.
 * Nhờ vậy STAFF làm ở cả chi nhánh khác không bị một mình MANAGER này khoá, và MANAGER không đụng được MANAGER
 * hay ADMIN khác. `length > 0`: `every` trên mảng rỗng là đúng, user không vai trò không thuộc về ai.
 */
const isStaffOfManagedBranches = (actor: Actor, target: TargetUser): boolean => {
  const managed = managedBranchIds(actor);
  return (
    target.branches.length > 0 &&
    target.branches.every(({ role, branchId }) => role === 'STAFF' && managed.has(branchId))
  );
};

/**
 * Chính sách quyền của API quản trị, mọi quyết định nằm ở đây. Không dùng `@Roles` vì `RolesGuard` đòi
 * `branchId` trong request, còn `/users/{userId}` chỉ biết chi nhánh sau khi đọc user.
 * - Không ai được tự khoá chính mình, kể cả ADMIN.
 * - ADMIN: mọi thao tác còn lại.
 * - MANAGER: xem danh sách đúng chi nhánh mình quản lý (`branchId` bắt buộc); tạo user chỉ vai trò STAFF ở
 *   chi nhánh mình; xem, sửa, khoá, mở khoá, gỡ Google theo `isStaffOfManagedBranches`.
 * - Còn lại không được: gán vai trò, đặt lại mật khẩu, quản lý chi nhánh chỉ ADMIN.
 */
export function isAllowed(actor: Actor, action: AdminAction): boolean {
  if (action.kind === 'user.lock' && action.target?.id === actor.id) {
    return false;
  }
  if (isSystemAdmin(actor)) {
    return true;
  }
  switch (action.kind) {
    case 'user.list':
      return action.branchId !== undefined && managedBranchIds(actor).has(action.branchId);
    case 'user.create': {
      const managed = managedBranchIds(actor);
      return action.assignments.every(
        ({ role, branchId }) => role === 'STAFF' && managed.has(branchId),
      );
    }
    case 'user.view':
    case 'user.update':
    case 'user.lock':
    case 'user.unlock':
    case 'user.unlink-google':
      return action.target !== undefined && isStaffOfManagedBranches(actor, action.target);
    case 'branch.manage':
    case 'user.reset-password':
    case 'user.assign':
      return false;
  }
}

const forbidden = () =>
  new BusinessError('FORBIDDEN', 'Không có quyền thực hiện thao tác này', 403);

export function assertAllowed(actor: Actor, action: AdminAction): void {
  if (!isAllowed(actor, action)) {
    throw forbidden();
  }
}

/**
 * Đọc người thao tác từ DB thay vì từ token. Token còn sống tối đa 15 phút sau khi bị khoá hoặc hạ vai trò;
 * nếu tin token, ADMIN vừa bị khoá có thể tự mở khoá, ADMIN vừa bị hạ có thể tự nâng lại.
 */
export async function loadActor(db: Pick<PrismaService, 'user'>, id: string): Promise<Actor> {
  const user = await db.user.findUnique({
    where: { id },
    select: { status: true, branches: ACTIVE_ASSIGNMENTS },
  });
  if (user === null || user.status !== 'ACTIVE') {
    throw forbidden();
  }
  return { id, branches: user.branches };
}
