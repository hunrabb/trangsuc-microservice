import { BusinessError } from '@jewelry/common';
import type { Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Khoá dòng `User` của mọi ADMIN đang hoạt động và của user bị thao tác, sắp theo id để không deadlock.
 * Phải gọi TRƯỚC mọi thay đổi trong transaction.
 *
 * Vì sao cần: hai ADMIN cùng hạ vai trò của nhau. Không khoá thì mỗi bên đếm trên dữ liệu chưa thấy thay đổi
 * của bên kia, đều thấy còn 1 ADMIN, cả hai commit và hệ thống còn 0 ADMIN. Có khoá thì bên sau phải chờ bên
 * trước commit, rồi `assertAdminRemains` (câu lệnh mới, snapshot mới) mới thấy đúng số còn lại.
 */
export async function lockAdminsAndUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT u.id FROM "auth"."User" u
    WHERE u.id = ${userId}::uuid
      OR (
        u.status = 'ACTIVE'
        AND EXISTS (
          SELECT 1 FROM "auth"."UserBranch" b WHERE b."userId" = u.id AND b.role = 'ADMIN'
        )
      )
    ORDER BY u.id
    FOR UPDATE OF u`;
}

/**
 * Gọi SAU thay đổi, cùng transaction. ADMIN đang hoạt động = `ACTIVE`, có vai trò ADMIN và còn cách đăng nhập
 * (mật khẩu hoặc Google): ADMIN không có cách nào vào hệ thống thì không cứu được ai. Bằng 0 → ném lỗi để rollback.
 */
export async function assertAdminRemains(tx: Tx): Promise<void> {
  const remaining = await tx.user.count({
    where: {
      status: 'ACTIVE',
      branches: { some: { role: 'ADMIN' } },
      OR: [{ passwordHash: { not: null } }, { identities: { some: {} } }],
    },
  });
  if (remaining === 0) {
    throw new BusinessError(
      'LAST_ADMIN',
      'Hệ thống phải còn ít nhất một ADMIN đang hoạt động',
      409,
    );
  }
}
