import { z } from 'zod';

export const ONLINE_RESERVATION_TTL_MS = 30 * 60_000;
export const ONLINE_PENDING_REVIEW_MS = 10 * 60_000;
export const ONLINE_RECOVERY_RETRY_MS = 5 * 60_000;

/** Giỏ client: không có cart DB và không giữ hàng khi thêm vào giỏ. */
export const onlineCartSchema = z
  .array(
    z.strictObject({
      variantId: z.uuid(),
      quantity: z.number().int().min(1).max(10),
    }),
  )
  .min(1)
  .max(20)
  .refine(
    (items) => new Set(items.map((i) => i.variantId.toLowerCase())).size === items.length,
    'Biến thể bị trùng',
  )
  .refine((items) => items.reduce((sum, item) => sum + item.quantity, 0) <= 50, 'Tối đa 50 chiếc');
export type OnlineCart = z.infer<typeof onlineCartSchema>;
export const createOnlineOrderSchema = z.strictObject({
  items: onlineCartSchema,
  recipientName: z.string().trim().min(1).max(150),
  recipientPhone: z
    .string()
    .trim()
    .regex(/^\+?\d{9,15}$/),
  shippingAddress: z.string().trim().min(10).max(1000),
  email: z.email().max(254).optional(),
});
export type CreateOnlineOrder = z.infer<typeof createOnlineOrderSchema>;
/** Client sinh 32 byte crypto random trước POST đầu tiên, lưu để retry/poll/cancel. Không dùng URL. */
export const checkoutAuthorizationSchema = z.string().regex(/^Checkout [a-f0-9]{64}$/);
export const onlineMoneySchema = z.string().regex(/^\d{1,18}\.\d{2}$/);
export const onlineOrderCreatedSchema = z.strictObject({
  channel: z.literal('WEBSITE'),
  orderId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  items: onlineCartSchema,
  deadlineAt: z.iso.datetime(),
});
export type OnlineOrderCreated = z.infer<typeof onlineOrderCreatedSchema>;
export const onlineOrderCancelledSchema = z.strictObject({
  channel: z.literal('WEBSITE'),
  orderId: z.uuid(),
});
export const reservedLineSchema = z.strictObject({
  jewelryItemId: z.uuid(),
  variantId: z.uuid(),
  sku: z.string().max(200),
  productName: z.string().max(500),
  price: onlineMoneySchema,
});
export const stockReservedSchema = z
  .strictObject({
    channel: z.literal('WEBSITE'),
    orderId: z.uuid(),
    reservationId: z.uuid(),
    warehouseId: z.uuid(),
    branchId: z.uuid(),
    expiresAt: z.iso.datetime(),
    total: onlineMoneySchema,
    items: z.array(reservedLineSchema).min(1).max(50),
  })
  .refine(
    (p) => new Set(p.items.map((i) => i.jewelryItemId)).size === p.items.length,
    'Chiếc bị trùng',
  );
export type StockReserved = z.infer<typeof stockReservedSchema>;
export const reservationFailureCodeSchema = z.enum([
  'ITEM_NOT_AVAILABLE',
  'RESERVATION_EXPIRED',
  'RESERVATION_RELEASED',
  'PRICE_NOT_AVAILABLE',
]);
export const stockReserveFailedSchema = z.strictObject({
  channel: z.literal('WEBSITE'),
  orderId: z.uuid(),
  code: reservationFailureCodeSchema,
});
export const stockReservationExpiredSchema = z.strictObject({
  channel: z.literal('WEBSITE'),
  orderId: z.uuid(),
  reservationId: z.uuid(),
});
export const onlineOrderViewSchema = z.strictObject({
  id: z.uuid(),
  code: z.string(),
  status: z.enum([
    'PENDING',
    'AWAITING_PAYMENT',
    'CANCELLED',
    'PAYMENT_PROCESSING',
    'CONFIRMED',
    'PAYMENT_REVIEW',
    'REFUND_PENDING',
  ]),
  total: onlineMoneySchema.nullable(),
  expiresAt: z.iso.datetime().nullable(),
  needsReview: z.boolean(),
  failureCode: z.string().nullable(),
  items: z.array(reservedLineSchema.omit({ jewelryItemId: true })).max(50),
});

export function canonicalCart(items: OnlineCart): OnlineCart {
  return onlineCartSchema
    .parse(items)
    .map((i) => ({ variantId: i.variantId.toLowerCase(), quantity: i.quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
}
