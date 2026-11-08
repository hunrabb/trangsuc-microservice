import { z } from 'zod';
import { deductStockRequestSchema } from './inventory-internal-api';

/** POS chỉ nhận mã tem và chi nhánh; server luôn tự chốt giá từ inventory. */
export const createPosOrderRequestSchema = deductStockRequestSchema.omit({ orderId: true });
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
export const posOrderStatusSchema = z.enum([
  'CREATING',
  'PENDING_PAYMENT',
  'COMPLETED',
  'CANCELLING',
  'CANCELLED',
]);

export const posOrderItemSchema = z.object({
  id: z.uuid(),
  tagCode: z.string(),
  productName: z.string(),
  metalWeight: z.string(),
  laborFee: z.string(),
  stoneFee: z.string(),
  metalPriceAtSale: z.string(),
  price: z.string(),
});

export const posOrderSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  branchId: z.uuid(),
  status: posOrderStatusSchema,
  total: z.string(),
  version: z.number().int().positive(),
  items: z.array(posOrderItemSchema),
});

export type CreatePosOrderRequest = z.infer<typeof createPosOrderRequestSchema>;
export type PosOrder = z.infer<typeof posOrderSchema>;
