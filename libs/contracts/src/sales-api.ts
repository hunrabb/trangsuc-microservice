import { z } from 'zod';
import { deductStockRequestSchema } from './inventory-internal-api';

/** POS chỉ nhận mã tem và chi nhánh; server luôn tự chốt giá từ inventory. */
export const createPosOrderRequestSchema = deductStockRequestSchema
  .omit({ orderId: true })
  .extend({ customerId: z.uuid().optional() });
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
export const customerPhoneSchema = z.string().trim().min(9).max(32);
export const createPosCustomerRequestSchema = z.strictObject({
  branchId: z.uuid(),
  phone: customerPhoneSchema,
  name: z.string().trim().min(1).max(150),
});
export const posCustomerSchema = z.object({
  id: z.uuid(),
  phone: z.string(),
  name: z.string(),
});
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
  customerId: z.uuid().nullable(),
  status: posOrderStatusSchema,
  total: z.string(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  items: z.array(posOrderItemSchema),
});

export const posCustomerOrdersSchema = z.object({ items: z.array(posOrderSchema) });

export type CreatePosOrderRequest = z.infer<typeof createPosOrderRequestSchema>;
export type PosOrder = z.infer<typeof posOrderSchema>;
export type CreatePosCustomerRequest = z.infer<typeof createPosCustomerRequestSchema>;
export type PosCustomer = z.infer<typeof posCustomerSchema>;
export type PosCustomerOrders = z.infer<typeof posCustomerOrdersSchema>;
