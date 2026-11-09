import { outbox, runWithLockRetry } from '@jewelry/common';
import { ROUTING_KEYS } from '@jewelry/contracts';
import type { OrderStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { invalidOrderState, type OrderRecord, type Transaction } from './order-record';

type OrderEvent =
  | typeof ROUTING_KEYS.ORDER_CREATED
  | typeof ROUTING_KEYS.ORDER_PAID
  | typeof ROUTING_KEYS.ORDER_CANCELLED;

/** Transaction ngắn chỉ ghi DB; retry cả transaction khi deadlock, không chứa cuộc gọi inventory. */
export function orderTransaction<T>(
  prisma: PrismaService,
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return runWithLockRetry(() =>
    prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      return work(transaction);
    }),
  );
}

/** UPDATE trạng thái là trọng tài; lịch sử chỉ ghi khi thắng, cùng transaction với thay đổi. */
export async function changeOrderStatus(
  transaction: Transaction,
  order: OrderRecord,
  status: OrderStatus,
  actorId: string,
  data: Prisma.OrderUpdateManyMutationInput = {},
  owner?: string,
): Promise<OrderRecord> {
  const result = await transaction.order.updateMany({
    where: {
      id: order.id,
      status: order.status,
      ...(owner === undefined ? {} : { operationOwner: owner }),
    },
    data: { ...data, status, version: { increment: 1 } },
  });
  if (result.count === 0) throw invalidOrderState();
  await transaction.orderStatusHistory.create({
    data: { orderId: order.id, fromStatus: order.status, toStatus: status, changedBy: actorId },
  });
  return transaction.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
}

/** Chỉ ghi outbox cùng transaction; channel POS giúp consumer phân biệt đơn đã trừ kho qua HTTP. */
export async function emitOrderEvent(
  transaction: Transaction,
  order: OrderRecord,
  eventType: OrderEvent,
): Promise<void> {
  await outbox.add(transaction, {
    eventType,
    aggregateType: 'Order',
    aggregateId: order.id,
    payload: {
      orderId: order.id,
      branchId: order.branchId,
      channel: 'POS',
      code: order.code,
      total: order.total.toFixed(2),
      tagCodes: order.requestedTagCodes,
      ...(eventType === ROUTING_KEYS.ORDER_PAID
        ? {
            paidAt: order.updatedAt.toISOString(),
            // Đơn cũ chưa có snapshot vốn: báo thiếu dữ liệu, không ghi vốn bằng 0 giả.
            items: order.items.map((item) => ({
              tagCode: item.tagCode,
              variantId: item.variantId,
              metalId: item.metalId,
              productName: item.productName,
              metalWeight: item.metalWeight.toFixed(4),
              price: item.price.toFixed(2),
              costPrice: item.variantId === null ? null : item.costPrice.toFixed(2),
            })),
          }
        : {}),
    },
  });
}
