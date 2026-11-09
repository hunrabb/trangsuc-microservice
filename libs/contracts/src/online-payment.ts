import { z } from 'zod';
import { onlineMoneySchema } from './online-checkout';

export const PAID_RESERVATION_TTL_MS = 3 * 24 * 60 * 60_000;
export const PAYMENT_RECOVERY_MAX_ATTEMPTS = 5;
export const PAYMENT_RECOVERY_INTERVAL_MS = 60_000;
export const confirmOnlinePaymentSchema = z.strictObject({
  bankTxnRef: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:/-]+$/),
  amount: onlineMoneySchema.refine((value) => !/^0+\.00$/.test(value), 'Số tiền phải lớn hơn 0'),
  currency: z.literal('VND'),
  evidenceRef: z.string().trim().min(5).max(500),
});
export type ConfirmOnlinePayment = z.infer<typeof confirmOnlinePaymentSchema>;
export const requestOnlineRefundSchema = z.strictObject({
  reason: z.string().trim().min(5).max(500),
});
/** Chỉ phát sau khi nhân viên xác minh receipt và transaction Sales đã ghi tiền nhận thực. */
export const onlineOrderPaidSchema = z.strictObject({
  channel: z.literal('WEBSITE'),
  orderId: z.uuid(),
  paymentId: z.uuid(),
  reservationId: z.uuid(),
  amount: onlineMoneySchema,
  currency: z.literal('VND'),
  receivedAt: z.iso.datetime(),
});
export type OnlineOrderPaid = z.infer<typeof onlineOrderPaidSchema>;
export const paymentInventoryResultSchema = z
  .strictObject({
    channel: z.literal('WEBSITE'),
    orderId: z.uuid(),
    paymentId: z.uuid(),
    reservationId: z.uuid(),
    amount: onlineMoneySchema,
    currency: z.literal('VND'),
    version: z.number().int().positive(),
    outcome: z.enum(['CONFIRMED', 'REJECTED']),
    reason: z
      .enum([
        'RESERVATION_EXPIRED',
        'RESERVATION_RELEASED',
        'INVENTORY_CONFLICT',
        'AMOUNT_MISMATCH',
        'PAID_HOLD_EXPIRED',
      ])
      .nullable(),
    holdUntil: z.iso.datetime().nullable(),
  })
  .refine(
    (value) =>
      value.outcome === 'CONFIRMED'
        ? value.reason === null && value.holdUntil !== null
        : value.reason !== null,
    'Kết quả Inventory không nhất quán',
  );
export type PaymentInventoryResult = z.infer<typeof paymentInventoryResultSchema>;
export const onlinePaymentViewSchema = z.strictObject({
  id: z.uuid(),
  orderId: z.uuid(),
  amount: onlineMoneySchema,
  currency: z.literal('VND'),
  status: z.enum(['RECEIVED', 'INVENTORY_CONFIRMED', 'RECONCILIATION_REQUIRED', 'REFUND_PENDING']),
  receivedAt: z.iso.datetime(),
});

export const onlinePaymentAdminViewSchema = onlinePaymentViewSchema.extend({
  bankTxnRef: z.string().max(200),
  evidenceRef: z.string().max(500),
});
