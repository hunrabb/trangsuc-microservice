import type { Prisma } from '../generated/prisma/client';

/**
 * Vai trò còn hiệu lực: ADMIN (toàn hệ thống), hoặc vai trò ở chi nhánh chưa ngừng hoạt động.
 * Dùng cho mọi nơi phát token và mọi nơi xác định quyền của người đang thao tác.
 */
export const ACTIVE_ASSIGNMENTS = {
  where: { OR: [{ branchId: null }, { branch: { isActive: true } }] },
  select: { branchId: true, role: true },
} satisfies Prisma.UserBranchFindManyArgs;
