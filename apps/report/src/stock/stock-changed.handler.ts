import { PermanentError } from '@jewelry/common';
import { type EventEnvelope, stockChangedPayloadSchema } from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';

/** Ghi sự kiện kho nguyên bản cùng ProcessedEvent để Phase 5 có thể dựng báo cáo từ backlog. */
export async function acknowledgeStockChanged(
  payload: unknown,
  context: { tx: Prisma.TransactionClient; envelope: EventEnvelope },
): Promise<void> {
  const parsed = stockChangedPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PermanentError('Sự kiện stock.changed không hợp lệ');
  }
  await context.tx.deferredStockEvent.create({
    data: {
      eventId: context.envelope.eventId,
      orderId: parsed.data.orderId,
      branchId: parsed.data.branchId,
      reason: parsed.data.reason,
      tagCodes: parsed.data.tagCodes,
      occurredAt: new Date(context.envelope.occurredAt),
    },
  });
}
