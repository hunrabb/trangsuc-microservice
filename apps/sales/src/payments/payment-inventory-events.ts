import { PermanentError } from '@jewelry/common';
import { paymentInventoryResultSchema } from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';
import { paymentAudit } from './online-payments.service';

export async function onPaymentInventoryResult(
  payload: unknown,
  { tx }: { tx: Prisma.TransactionClient },
): Promise<void> {
  const checked = paymentInventoryResultSchema.safeParse(payload);
  if (!checked.success) throw new PermanentError('stock.payment_result không hợp lệ');
  const event = checked.data;
  await tx.$queryRaw`SELECT id FROM "sales"."OnlineOrder" WHERE id = ${event.orderId}::uuid FOR UPDATE`;
  const order = await tx.onlineOrder.findUnique({ where: { id: event.orderId } });
  const payment = await tx.onlinePayment.findFirst({
    where: { id: event.paymentId, orderId: event.orderId },
  });
  if (
    !order ||
    !payment ||
    order.activePaymentId !== payment.id ||
    event.version <= payment.inventoryVersion
  )
    return;
  if (
    event.reservationId !== order.reservationId ||
    !payment.amount.equals(event.amount) ||
    payment.currency !== event.currency
  )
    throw new PermanentError('Inventory payment result không khớp giao dịch đã xác minh');
  if (order.status === 'REFUND_PENDING' || payment.status === 'REFUND_PENDING') {
    await tx.onlinePayment.update({
      where: { id: payment.id },
      data: { inventoryVersion: event.version },
    });
    await paymentAudit(
      tx,
      order,
      payment.id,
      'INVENTORY_RESULT_AFTER_REFUND_REQUEST',
      order.status,
    );
    return;
  }
  if (!['PAYMENT_PROCESSING', 'PAYMENT_REVIEW', 'CONFIRMED'].includes(order.status)) return;
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const confirmed =
    event.outcome === 'CONFIRMED' &&
    event.holdUntil !== null &&
    new Date(event.holdUntil) > clock!.now;
  const next = confirmed ? 'CONFIRMED' : 'PAYMENT_REVIEW';
  await tx.onlinePayment.update({
    where: { id: payment.id },
    data: {
      inventoryVersion: event.version,
      status: confirmed ? 'INVENTORY_CONFIRMED' : 'RECONCILIATION_REQUIRED',
    },
  });
  await tx.onlineOrder.update({
    where: { id: order.id },
    data: {
      status: next,
      needsReview: !confirmed,
      failureCode: confirmed ? null : 'PAYMENT_RECONCILIATION_REQUIRED',
      ...(confirmed ? { expiresAt: new Date(event.holdUntil!) } : {}),
    },
  });
  await paymentAudit(
    tx,
    order,
    payment.id,
    confirmed ? 'INVENTORY_PAYMENT_CONFIRMED' : 'INVENTORY_PAYMENT_REVIEW',
    next,
    null,
    confirmed ? null : (event.reason ?? 'PAID_HOLD_EXPIRED'),
  );
}
