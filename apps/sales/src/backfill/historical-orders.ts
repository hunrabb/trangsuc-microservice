import { createHash } from 'node:crypto';
import { orderPaidPayloadSchema, type EventEnvelope } from '@jewelry/contracts';
import { Prisma } from '../generated/prisma/client';

type HistoricalOrder = Prisma.OrderGetPayload<{ include: { items: true; history: true } }>;

/** UUID ổn định, tách namespace với eventId live; không dùng giá sản phẩm hiện tại. */
export function backfillEventId(orderId: string): string {
  const hex = createHash('sha256').update(`pos-report-backfill-v1:${orderId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function historicalOrder(order: HistoricalOrder, originalPaidAt?: string) {
  const excluded = (reason: string) => ({ orderId: order.id, reason });
  if (order.status !== 'COMPLETED') return excluded('NOT_PAID');
  const completed = order.history.filter(
    (entry) => entry.toStatus === 'COMPLETED' && entry.fromStatus === 'PENDING_PAYMENT',
  );
  if (completed.length !== 1) return excluded('MISSING_OR_AMBIGUOUS_PAYMENT_HISTORY');
  if (order.items.length === 0) return excluded('MISSING_LINES');
  const tags = order.items.map((item) => item.tagCode).sort();
  if (
    new Set(tags).size !== tags.length ||
    JSON.stringify(tags) !== JSON.stringify([...order.requestedTagCodes].sort())
  ) {
    return excluded('MISSING_OR_DUPLICATE_LINES');
  }
  const total = order.items.reduce((sum, item) => sum.plus(item.price), new Prisma.Decimal(0));
  if (!total.equals(order.total)) return excluded('TOTAL_MISMATCH');
  const payload = orderPaidPayloadSchema.safeParse({
    orderId: order.id,
    branchId: order.branchId,
    channel: 'POS',
    code: order.code,
    total: order.total.toFixed(2),
    tagCodes: tags,
    paidAt: originalPaidAt ?? completed[0]!.createdAt.toISOString(),
    items: order.items.map((item) => ({
      tagCode: item.tagCode,
      variantId: item.variantId,
      metalId: item.metalId,
      productName: item.productName,
      metalWeight: item.metalWeight.toFixed(4),
      price: item.price.toFixed(2),
      // Migration cũ mặc định vốn=0: variantId=null đánh dấu chưa từng có snapshot vốn.
      costPrice: item.variantId === null ? null : item.costPrice.toFixed(2),
    })),
  });
  if (!payload.success) return excluded('INVALID_SNAPSHOT');
  const envelope: EventEnvelope = {
    eventId: backfillEventId(order.id),
    eventType: 'order.paid',
    occurredAt: payload.data.paidAt,
    correlationId: `backfill:${order.id}`,
    payload: payload.data,
  };
  return { orderId: order.id, envelope };
}
