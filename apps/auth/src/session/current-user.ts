import type { CurrentUserAssignment } from '@jewelry/contracts';

/** Dòng vai trò đọc từ DB kèm chi nhánh (`null` với ADMIN toàn hệ thống). */
interface AssignmentRow {
  branchId: string | null;
  role: CurrentUserAssignment['role'];
  branch: { name: string } | null;
}

/** Đổi dòng DB thành vai trò trả cho `/me`: thêm tên chi nhánh, bỏ phần còn lại của chi nhánh. */
export const toCurrentUserBranches = (rows: readonly AssignmentRow[]): CurrentUserAssignment[] =>
  rows.map(({ branchId, role, branch }) => ({ branchId, role, branchName: branch?.name ?? null }));
