import { PAYMENT_RECOVERY_INTERVAL_MS, PAYMENT_RECOVERY_MAX_ATTEMPTS } from '@jewelry/contracts';
import type { OnlineOrder, Prisma } from '../generated/prisma/client';
import { emitOnlinePaid, paymentAudit } from './online-payments.service';

export async function recoverOnlinePayment(
  tx: Prisma.TransactionClient,
  order: OnlineOrder,
  now: Date,
): Promise<void> {
  const payment = order.activePaymentId
    ? await tx.onlinePayment.findFirst({ where: { id: order.activePaymentId, orderId: order.id } })
    : null;
  if (!payment || !['RECEIVED', 'RECONCILIATION_REQUIRED'].includes(payment.status)) {
    await tx.onlineOrder.update({
      where: { id: order.id },
      data: {
        status: 'PAYMENT_REVIEW',
        needsReview: true,
        failureCode: 'PAYMENT_RECONCILIATION_REQUIRED',
      },
    });
    return;
  }
  if (order.paymentAttempts >= PAYMENT_RECOVERY_MAX_ATTEMPTS) {
    await tx.onlinePayment.update({
      where: { id: payment.id },
      data: { status: 'RECONCILIATION_REQUIRED' },
    });
    await tx.onlineOrder.update({
      where: { id: order.id },
      data: {
        status: 'PAYMENT_REVIEW',
        needsReview: true,
        failureCode: 'PAYMENT_RECONCILIATION_REQUIRED',
      },
    });
    await paymentAudit(tx, order, payment.id, 'PAYMENT_RECOVERY_EXHAUSTED', 'PAYMENT_REVIEW');
    return;
  }
  await tx.onlineOrder.update({
    where: { id: order.id },
    data: {
      paymentAttempts: { increment: 1 },
      recoveryAfter: new Date(now.getTime() + PAYMENT_RECOVERY_INTERVAL_MS),
    },
  });
  await emitOnlinePaid(tx, order, payment);
}
