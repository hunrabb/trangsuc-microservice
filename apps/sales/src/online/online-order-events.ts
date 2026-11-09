import { PermanentError } from '@jewelry/common';
import {
  canonicalCart,
  onlineCartSchema,
  stockReservedSchema,
  stockReserveFailedSchema,
  stockReservationExpiredSchema,
  ROUTING_KEYS,
  type StockReserved,
} from '@jewelry/contracts';
import { Prisma, type OnlineOrder } from '../generated/prisma/client';
import { cancelOnline, emitOnlineCancelled } from './online-orders.service';

type Context = { tx: Prisma.TransactionClient };
export function validateReservedCart(requested: unknown, event: StockReserved): void {
  const quantities = new Map<string, number>();
  for (const line of event.items)
    quantities.set(line.variantId, (quantities.get(line.variantId) ?? 0) + 1);
  const actual = [...quantities].map(([variantId, quantity]) => ({ variantId, quantity }));
  if (
    JSON.stringify(canonicalCart(onlineCartSchema.parse(requested))) !==
    JSON.stringify(canonicalCart(actual))
  )
    throw new PermanentError('Reservation không khớp giỏ hàng');
  const total = event.items.reduce((sum, item) => sum.add(item.price), new Prisma.Decimal(0));
  if (!total.equals(event.total)) throw new PermanentError('Tổng reservation không khớp dòng hàng');
}
async function lockOrder(tx: Prisma.TransactionClient, id: string): Promise<OnlineOrder | null> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "sales"."OnlineOrder" WHERE id = ${id}::uuid FOR UPDATE`;
  return rows.length ? tx.onlineOrder.findUnique({ where: { id } }) : null;
}
export async function onStockReserved(payload: unknown, { tx }: Context) {
  const result = stockReservedSchema.safeParse(payload);
  if (!result.success) throw new PermanentError('stock.reserved không hợp lệ');
  const event = result.data;
  const row = await lockOrder(tx, event.orderId);
  if (!row || row.status === 'CANCELLED') {
    await emitOnlineCancelled(tx, event.orderId);
    return;
  }
  if (row.status !== 'PENDING') return;
  validateReservedCart(row.requestedItems, event);
  const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (new Date(event.expiresAt) <= clock!.now || row.deadlineAt <= clock!.now) {
    await cancelOnline(tx, row, 'RESERVATION_EXPIRED');
    return;
  }
  await tx.onlineOrder.update({
    where: { id: row.id },
    data: {
      status: 'AWAITING_PAYMENT',
      reservationId: event.reservationId,
      warehouseId: event.warehouseId,
      branchId: event.branchId,
      total: event.total,
      expiresAt: new Date(event.expiresAt),
      recoveryAfter: new Date(event.expiresAt),
      needsReview: false,
      items: { create: event.items },
    },
  });
}
export async function onStockReserveFailed(payload: unknown, { tx }: Context) {
  const result = stockReserveFailedSchema.safeParse(payload);
  if (!result.success) throw new PermanentError('stock.reserve_failed không hợp lệ');
  const row = await lockOrder(tx, result.data.orderId);
  // Một failure cũ không đảo ngược AWAITING_PAYMENT đã có reservation thành công.
  if (row?.status === 'PENDING') await cancelOnline(tx, row, result.data.code);
}
export async function onStockReservationExpired(payload: unknown, { tx }: Context) {
  const result = stockReservationExpiredSchema.safeParse(payload);
  if (!result.success) throw new PermanentError('stock.reservation_expired không hợp lệ');
  const event = result.data;
  const row = await lockOrder(tx, event.orderId);
  if (row && (row.reservationId === null || row.reservationId === event.reservationId))
    await cancelOnline(tx, row, 'RESERVATION_EXPIRED');
}
export const ONLINE_SALES_HANDLERS = {
  [ROUTING_KEYS.STOCK_RESERVED]: onStockReserved,
  [ROUTING_KEYS.STOCK_RESERVE_FAILED]: onStockReserveFailed,
  [ROUTING_KEYS.STOCK_RESERVATION_EXPIRED]: onStockReservationExpired,
};
