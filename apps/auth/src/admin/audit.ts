import { getCorrelationId } from '@jewelry/common';
import type { Prisma } from '../generated/prisma/client';

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: 'Branch' | 'User';
  entityId: string;
  /** Không được chứa mật khẩu hay hash; `null` khi vừa tạo. */
  before: object | null;
  after: object;
}

/** Ghi `AuditLog` cùng transaction với thay đổi: rollback thì không có nhật ký. */
export async function writeAudit(
  tx: Prisma.TransactionClient,
  { actorId, action, entityType, entityId, before, after }: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      data: { before, after } as Prisma.InputJsonObject,
      correlationId: getCorrelationId() ?? '',
    },
  });
}
