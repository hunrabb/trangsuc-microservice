import { PermanentError } from '@jewelry/common';
import { eventEnvelopeSchema } from '@jewelry/contracts';
import { z } from 'zod';
import { type Prisma } from '../generated/prisma/client';
import { paidOrderMatches, recordPaidOrder, validatePaidOrder } from './order-report.handler';

const inputSchema = z.union([
  z.object({ orderId: z.uuid(), envelope: eventEnvelopeSchema }).strict(),
  z.object({ orderId: z.uuid(), reason: z.string().min(1).max(100) }).strict(),
]);

/** Mỗi đơn một transaction; dùng cùng logic và unique constraint với consumer live. */
export async function backfillOrder(tx: Prisma.TransactionClient, raw: unknown, apply = false) {
  const input = inputSchema.parse(raw);
  if ('reason' in input)
    return { orderId: input.orderId, status: 'EXCLUDED', reason: input.reason };
  const { envelope } = input;
  if (envelope.eventType !== 'order.paid') throw new PermanentError('Backfill chỉ nhận order.paid');
  const order = validatePaidOrder(envelope.payload);
  if (order.orderId !== input.orderId) throw new PermanentError('orderId không khớp phong bì');
  const existing = await tx.orderRevenue.findUnique({
    where: { orderId: order.orderId },
    include: { lines: true },
  });
  if (existing && !paidOrderMatches(existing, order)) {
    return { orderId: order.orderId, status: 'CONFLICT', reason: 'EXISTING_SNAPSHOT_DIFFERS' };
  }
  const missingCost = order.items.some((item) => item.costPrice === null);
  if (!apply)
    return { orderId: order.orderId, status: existing ? 'EXISTS' : 'NEEDED', missingCost };
  // Namespace riêng để không khiến consumer live bỏ qua eventId chưa từng nhận từ RabbitMQ.
  await tx.processedEvent.createMany({
    data: [{ eventId: envelope.eventId, consumer: 'report.backfill.v1' }],
    skipDuplicates: true,
  });
  const status = await recordPaidOrder(order, { tx, envelope });
  if (status === 'CANCELLED') throw new PermanentError('Backfill gặp tombstone huỷ đồng thời');
  return { orderId: order.orderId, status, missingCost };
}
