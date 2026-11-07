import { getCorrelationId } from '@jewelry/common';
import type { Prisma } from '../generated/prisma/client';

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  /** Không chứa dữ liệu nhạy cảm. */
  data: object;
}

/** Ghi `AuditLog` cùng transaction với thay đổi: rollback thì không có nhật ký. */
export async function writeAudit(
  tx: Prisma.TransactionClient,
  { actorId, action, entityType, entityId, data }: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      data: data as Prisma.InputJsonObject,
      correlationId: getCorrelationId() ?? '',
    },
  });
}
