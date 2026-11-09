import { onlineOrderPaidSchema } from '@jewelry/contracts';
import type { EventEnvelope } from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';
import { recordPaidOrder } from './order-report.handler';

/** Receipt online chưa phải doanh thu hoàn tất/giao hàng; không ghi vào báo cáo POS. */
export async function dispatchPaidOrder(
  payload: unknown,
  context: { tx: Prisma.TransactionClient; envelope: EventEnvelope },
) {
  if (onlineOrderPaidSchema.safeParse(payload).success) return;
  return recordPaidOrder(payload, context);
}
