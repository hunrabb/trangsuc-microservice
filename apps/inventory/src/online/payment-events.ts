import { outbox, PermanentError } from '@jewelry/common';
import {
  onlineOrderPaidSchema,
  PAID_RESERVATION_TTL_MS,
  ROUTING_KEYS,
  type OnlineOrderPaid,
  type PaymentInventoryResult,
} from '@jewelry/contracts';
import type { Prisma } from '../generated/prisma/client';
import { lockReservation } from './reservations';

type Tx = Prisma.TransactionClient;
async function result(
  tx: Tx,
  event: OnlineOrderPaid,
  version: number,
  reason: PaymentInventoryResult['reason'],
  holdUntil: Date | null,
): Promise<void> {
  await outbox.add(tx, {
    eventType: ROUTING_KEYS.STOCK_PAYMENT_RESULT,
    aggregateType: 'StockReservation',
    aggregateId: event.orderId,
    payload: {
      channel: 'WEBSITE',
      orderId: event.orderId,
      paymentId: event.paymentId,
      reservationId: event.reservationId,
      amount: event.amount,
      currency: event.currency,
      version,
      outcome: reason === null ? 'CONFIRMED' : 'REJECTED',
      reason,
      holdUntil: holdUntil?.toISOString() ?? null,
    },
  });
}
/** Cùng khoá với expiry/release: chỉ một phía được quyết định trên reservation chưa trả tiền. */
export async function confirmPaidReservation(payload: unknown, { tx }: { tx: Tx }): Promise<void> {
  const checked = onlineOrderPaidSchema.safeParse(payload);
  if (!checked.success) throw new PermanentError('order.paid WEBSITE không hợp lệ');
  const event = checked.data;
  const row = await lockReservation(tx, event.orderId);
  if (row.paymentId && row.paymentId !== event.paymentId) {
    await result(tx, event, 1, 'INVENTORY_CONFLICT', null);
    return;
  }
  if (row.paymentId === event.paymentId && row.paymentOutcome) {
    await result(
      tx,
      event,
      row.paymentVersion,
      row.paymentOutcome === 'CONFIRMED'
        ? null
        : (row.paymentFailureCode as PaymentInventoryResult['reason']),
      row.paymentOutcome === 'CONFIRMED' ? row.expiresAt : null,
    );
    return;
  }
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const holdUntil = new Date(new Date(event.receivedAt).getTime() + PAID_RESERVATION_TTL_MS);
  let reason: PaymentInventoryResult['reason'] = null;
  if (row.id !== event.reservationId || !row.total.equals(event.amount)) reason = 'AMOUNT_MISMATCH';
  else if (row.status === 'EXPIRED' || (row.expiresAt !== null && row.expiresAt <= clock!.now))
    reason = 'RESERVATION_EXPIRED';
  else if (row.status === 'RELEASED' || row.status === 'FAILED') reason = 'RESERVATION_RELEASED';
  else if (row.status !== 'ACTIVE' || row.expiresAt === null) reason = 'INVENTORY_CONFLICT';
  else if (holdUntil <= clock!.now) reason = 'PAID_HOLD_EXPIRED';
  if (reason === null) {
    const ids = row.items
      .filter((item) => item.isActive)
      .map((item) => item.jewelryItemId)
      .sort();
    const physical = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id,status FROM "inventory"."JewelryItem" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    if (
      !ids.length ||
      physical.length !== ids.length ||
      physical.some((item) => item.status !== 'RESERVED')
    )
      reason = 'INVENTORY_CONFLICT';
  }
  // Tiền đã nhận nhưng hàng không bảo đảm: giữ dấu đối soát, không tự nhả hay tìm chiếc khác.
  const updated = await tx.stockReservation.update({
    where: { id: row.id },
    data: {
      paymentId: event.paymentId,
      paymentReceivedAt: new Date(event.receivedAt),
      paymentVersion: { increment: 1 },
      paymentOutcome: reason === null ? 'CONFIRMED' : 'REJECTED',
      paymentFailureCode: reason,
      status: reason === null ? 'PAID_HELD' : 'PAYMENT_REVIEW',
      ...(reason === null ? { expiresAt: holdUntil } : {}),
    },
  });
  await result(tx, event, updated.paymentVersion, reason, reason === null ? holdUntil : null);
}

/** Hết 3 ngày không nhả hàng đã nhận tiền; đưa vào đối soát và phát kết quả version mới. */
export async function reviewExpiredPaidHold(tx: Tx, orderId: string): Promise<void> {
  const row = await lockReservation(tx, orderId);
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (row.status !== 'PAID_HELD' || !row.expiresAt || row.expiresAt > clock!.now) return;
  if (!row.paymentId || !row.paymentReceivedAt)
    throw new PermanentError('Paid hold thiếu payment identity');
  const updated = await tx.stockReservation.update({
    where: { id: row.id },
    data: {
      status: 'PAYMENT_REVIEW',
      paymentOutcome: 'REJECTED',
      paymentFailureCode: 'PAID_HOLD_EXPIRED',
      paymentVersion: { increment: 1 },
    },
  });
  await result(
    tx,
    {
      channel: 'WEBSITE',
      orderId,
      paymentId: row.paymentId,
      reservationId: row.id,
      receivedAt: row.paymentReceivedAt.toISOString(),
      amount: row.total.toFixed(2),
      currency: 'VND',
    },
    updated.paymentVersion,
    'PAID_HOLD_EXPIRED',
    null,
  );
}
